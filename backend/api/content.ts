import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createGzip, gunzipSync } from 'node:zlib'
import { v4 as uuid } from 'uuid'
import { audit } from '../helpers/audit.ts'
import { extractTar, packTar } from '../helpers/tar.ts'
import { importTree, walkStored } from '../helpers/storageFiles.ts'
import diskStorage from '../modules/storage/disk/storage.ts'
import { CONTENT_TYPES } from '../models/storage.ts'
import type { StorageTarget } from '../models/storage.ts'
import type { FastifyInstance } from 'fastify'

/**
 * The two halves of a content backup: a site's pages and assets out as one file, and back in again.
 *
 * Neither half is a format of its own. A storage target laid out as a folder of files is already
 * exactly this — front matter and a body per page, assets where the file manager shows them — and
 * what these two routes add is the archive around it, so that having a copy of a site does not mean
 * configuring a target first. The tree, the front matter, what makes a file a page and what an import
 * does with one are `helpers/storageFiles.ts`'s, shared with every target that writes a folder.
 *
 * That also fixes what these can and cannot do. The archive holds **content**: pages as they stand
 * now and the files attached to them. It does not hold page history, users, groups, rules, comments
 * or a site's configuration, none of which live in that tree — so this is a way to move content
 * between sites and to keep a copy of it outside the database, and not a backup of an instance. A
 * `pg_dump` is that.
 *
 * **Importing a Wiki.js 2.x backup is not this.** A 2.x export is a different tree with a different
 * schema behind it, and mapping one onto the other is a piece of work this deliberately does not
 * guess at.
 */

/** Where the temporary tree either half works in goes, alongside the other things kept off the database. */
function tempRoot(): string {
  return path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'tmp')
}

/**
 * A storage target that exists for the length of one request, pointed at a temporary folder.
 *
 * The disk module is written against a configured target rather than against a path, and this is a
 * path — so the path is handed to it as the one piece of configuration it reads. Nothing is stored,
 * nothing is registered and no site has this among its targets: it is the module's own export and
 * import code, run over a folder that is about to be archived or has just been unpacked.
 *
 * Every content type is active, because an archive is the whole of the site's content by definition.
 * A target an administrator configured is the place to say that images belong here and videos do not.
 */
function archiveTarget(siteId: string, root: string): StorageTarget {
  return {
    id: uuid(),
    siteId,
    module: 'disk',
    isEnabled: true,
    title: 'Content archive',
    description: '',
    icon: '',
    banner: '',
    contentTypes: { activeTypes: [...CONTENT_TYPES] },
    assetDelivery: {
      isDirectAccessSupported: false,
      isDeliverySupported: false,
      mode: 'streaming',
      baseUrl: '',
      linkExpiration: '5m',
      servedTypes: []
    },
    props: {},
    config: { path: root },
    actions: [],
    state: { status: 'healthy', message: '', updatedAt: null }
  }
}

/** The body limit an uploaded archive is held to, which is the one every upload is held to. */
const uploadLimit = WIKI.config.security?.uploadMaxFileSize ?? 10485760

/**
 * How far an uploaded archive is allowed to expand.
 *
 * A few kilobytes of gzip can name gigabytes of output, so the decompressed size is capped rather
 * than discovered. Twenty times the upload limit is far above what a tree of pages and assets
 * compresses to and far below what a deliberate one aims for.
 */
const MAX_UNCOMPRESSED = uploadLimit * 20

/**
 * Content API Routes
 */
async function routes(app: FastifyInstance) {
  // -> An uploaded archive is the file itself rather than a multipart form, as an asset upload is.
  //    The catch-all claims only content types nothing else parses, so the JSON routes are unaffected.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: uploadLimit },
    (req, body, done) => {
      done(null, body)
    }
  )

  /**
   * EXPORT SITE CONTENT
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/content/export',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: "Download a site's content as a gzipped tarball",
        description:
          "Every page and every asset of the site, as the folder a local storage target would write: a page is YAML front matter and its source under the extension its editor writes, an asset is the file itself, and both sit where the file manager shows them. That makes the archive readable by anything that reads a tree of markdown — and importable by any Wiki.js 3 site, including this one.\n\nContent only. Page history, users, groups, rules and the site's own configuration are not in that tree and are not in here; a database dump is what holds those.\n\nThe archive is laid out the way THIS site lays its storage out (the site and locale prefixes under Storage). A site laid out differently reads the paths differently, so an archive moved between two of them takes nothing in.",
        tags: ['Content'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId']
        },
        response: {
          200: {
            description: 'The content archive',
            content: {
              'application/gzip': {
                schema: { type: 'string', format: 'binary' }
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      if (!WIKI.sites[req.params.siteId]) {
        return reply.badRequest('This site does not exist.')
      }

      const root = path.join(tempRoot(), `content-export-${uuid()}`)
      await fs.mkdir(root, { recursive: true })
      // -> Registered before anything is written, so the folder goes whether the response finishes,
      //    fails or the client hangs up in the middle of the download
      reply.raw.on('close', () => {
        fs.rm(root, { recursive: true, force: true }).catch((err) => {
          WIKI.logger.warn(`Could not remove the export folder ${root}: ${err.message}`)
        })
      })

      const message = await diskStorage.exportAll(archiveTarget(req.params.siteId, root))
      const files = (await walkStored(root)) ?? []

      /*
        Recorded before the stream rather than after it, as the audit log export is and for the same
        reason: a download has no moment of success the server sees. What is worth recording is that
        a copy of the site's content was asked for and authorized.
      */
      await audit(req, 'admin', 'exportContent', {
        siteId: req.params.siteId,
        files: files.length
      })
      WIKI.logger.info(`Archiving ${files.length} file(s) of site content. ${message}`)

      const stamp = Temporal.Now.instant().toString({ smallestUnit: 'second' }).replaceAll(':', '-')
      reply.header('Content-Type', 'application/gzip')
      reply.header('Content-Disposition', `attachment; filename="content-${stamp}.tar.gz"`)
      reply.preventCache()

      const archive = Readable.from(packTar(files))
      const gzip = createGzip()
      // -> A file that cannot be read partway through leaves a truncated archive, so the failure is
      //    carried into the compressor, which tears the response down rather than ending it cleanly
      archive.on('error', (err) => gzip.destroy(err))
      return reply.send(archive.pipe(gzip))
    }
  )

  /**
   * IMPORT SITE CONTENT
   */
  app.post<{ Params: { siteId: string }; Body: Buffer }>(
    '/sites/:siteId/content/import',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Import a content archive into a site',
        description: `The body is the archive itself, not a multipart form — a \`.tar.gz\` as the export produces, or a plain \`.tar\`. At most ${Math.round(uploadLimit / 1024 / 1024)} MB, which is the instance's upload limit and is raised under Security.\n\n**Nothing already in the wiki is replaced.** A page or an asset at a path the site already has is left exactly as it is and counted as skipped, which makes running the same archive twice do nothing the second time. Filling in what a site is missing is the whole of what this does; making a site say what an archive says is a restore, and a restore is a database one.\n\nPages arrive through the same path a storage import does, so each gets a version in its history recording that it was imported, attributed to the administrator who ran this.\n\nA Wiki.js 2.x backup is NOT a content archive and is not read here.`,
        tags: ['Content'],
        consumes: ['*/*'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId']
        },
        response: {
          200: {
            description: 'Content imported successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              pages: { type: 'integer', description: 'Pages created.' },
              assets: { type: 'integer', description: 'Assets created.' },
              skipped: {
                type: 'integer',
                description: 'Left alone because the site already had something at that path.'
              },
              failed: { type: 'integer', description: 'Unusable — see the server log.' }
            }
          }
        }
      }
    },
    async (req, reply) => {
      if (!WIKI.sites[req.params.siteId]) {
        return reply.badRequest('This site does not exist.')
      }
      // -> An import creates content, and content records who authored it. An API key is not a who,
      //    as with the storage actions this shares its code with.
      const actorId = req.session?.authenticated ? req.session.user?.id : null
      if (!actorId) {
        return reply.unauthorized('Importing content requires a logged in user.')
      }
      const body = req.body
      if (!Buffer.isBuffer(body) || body.length < 1) {
        return reply.badRequest('The request body must be the archive file.')
      }

      let tarball: Buffer
      try {
        // -> Gzipped is what the export writes and what anybody sends, but the archive inside it is
        //    the format that matters, so a plain tar is taken as readily
        tarball =
          body[0] === 0x1f && body[1] === 0x8b
            ? gunzipSync(body, { maxOutputLength: MAX_UNCOMPRESSED })
            : body
      } catch {
        return reply.badRequest(
          `This is not a readable gzip archive, or it expands past the ${Math.round(MAX_UNCOMPRESSED / 1024 / 1024)} MB limit.`
        )
      }

      const root = path.join(tempRoot(), `content-import-${uuid()}`)
      await fs.mkdir(root, { recursive: true })
      try {
        let extracted: number
        try {
          extracted = await extractTar(tarball, root)
        } catch (err: any) {
          // -> Either it is not a tar at all, or an entry named a path outside the folder, which
          //    `extractTar` refuses outright. Neither is something to take half of.
          WIKI.logger.warn(`Could not unpack the uploaded content archive: ${err.message}`)
          return reply.badRequest('This file could not be unpacked as a tar archive.')
        }
        if (extracted < 1) {
          return reply.badRequest('There are no files in this archive.')
        }

        const summary = await importTree({
          target: archiveTarget(req.params.siteId, root),
          root,
          actorId,
          // -> The safe direction, and the only one offered: an archive is not authoritative over a
          //    site that has content of its own, and there is no history here to merge from
          overwrite: false
        })

        await audit(req, 'admin', 'importContent', {
          siteId: req.params.siteId,
          files: extracted,
          pages: summary?.pages ?? 0,
          assets: summary?.assets ?? 0,
          skipped: summary?.skipped ?? 0,
          failed: summary?.failed ?? 0
        })

        const parts = []
        if (summary && (summary.pages > 0 || summary.assets > 0)) {
          parts.push(`Imported ${summary.pages} page(s) and ${summary.assets} asset(s).`)
        } else {
          parts.push('There was nothing new to import.')
        }
        if (summary && summary.skipped > 0) {
          parts.push(`${summary.skipped} were already in the wiki and were left alone.`)
        }
        if (summary && summary.failed > 0) {
          parts.push(`${summary.failed} could not be imported - see the server log.`)
        }

        return {
          ok: true,
          message: parts.join(' '),
          pages: summary?.pages ?? 0,
          assets: summary?.assets ?? 0,
          skipped: summary?.skipped ?? 0,
          failed: summary?.failed ?? 0
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch((err) => {
          WIKI.logger.warn(`Could not remove the import folder ${root}: ${err.message}`)
        })
      }
    }
  )
}

export default routes
