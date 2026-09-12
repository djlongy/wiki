import type { FastifyInstance } from 'fastify'
import { actorFrom } from './pages.ts'
import { audit } from '../helpers/audit.ts'

/**
 * Tag API Routes
 *
 * Tags are derived from the pages that carry them rather than stored on their own — see
 * `models/tags.ts` for why.
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST TAGS
   */
  app.get<{ Params: { siteId: string }; Querystring: { limit?: number } }>(
    '/sites/:siteId/tags',
    {
      /*
        No route-level `permissions`: a tag exists because a readable page carries it, so the answer
        is filtered per page below rather than refused outright.
      */
      schema: {
        summary: 'List the tags in use on a site',
        description:
          'Every tag carried by at least one page the caller may read, most used first, counted over those pages only. This is what the tag field offers as suggestions while a page is being edited, and what the search screen filters by.',
        tags: ['Pages'],
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
        querystring: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 5000,
              default: 1000
            }
          }
        },
        response: {
          200: {
            description: 'Tags in use, most used first',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tag: {
                  type: 'string'
                },
                usageCount: {
                  type: 'integer',
                  description: 'How many pages carry the tag.'
                }
              }
            }
          }
        }
      }
    },
    async (req) => {
      return WIKI.models.tags.getTags(req.params.siteId, {
        limit: req.query.limit,
        actor: WIKI.models.groups.actorForRequest(req)
      })
    }
  )

  /**
   * RENAME OR DELETE A TAG
   */
  app.put<{ Params: { siteId: string; tag: string }; Body: { tag: string | null } }>(
    '/sites/:siteId/tags/:tag',
    {
      config: {
        /*
          The one thing on this API that writes. `manage:pages` rather than `write:pages`: a rename
          reaches every page carrying the tag at once, which is an administrative act even where the
          caller could have edited each of those pages by hand. What it may actually rewrite is still
          decided per page, by the same `write:pages` rule the editor obeys -- see `renameTag`.
        */
        permissions: ['manage:pages']
      },
      schema: {
        summary: 'Rename a tag across every page, or remove it from them',
        description:
          'A tag has no row of its own -- it exists because pages carry it -- so renaming one means rewriting the tag list of every page that has it, and deleting one means taking it off them. Send a new name to rename, or `null` to delete.\n\nThe pages themselves are never deleted: this is not `deletePagesByTag`. Each one is saved the way an editor saves it, so the tree entry, the history version and the copy on every storage target all follow.\n\nWhat the caller may rewrite is decided per page against `write:pages`, so a page they may not write is left untouched and reported as `skipped`.',
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            tag: {
              type: 'string',
              description: 'The tag as it is now.'
            }
          },
          required: ['siteId', 'tag']
        },
        body: {
          type: 'object',
          properties: {
            tag: {
              type: ['string', 'null'],
              minLength: 1,
              description: 'What to call it instead, or null to remove it from every page.'
            }
          },
          required: ['tag']
        },
        response: {
          200: {
            description: 'What the change reached',
            type: 'object',
            properties: {
              updated: {
                type: 'integer',
                description: 'Pages whose tag list was rewritten.'
              },
              skipped: {
                type: 'integer',
                description: 'Pages carrying the tag that the caller may not write, left untouched.'
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      // -> A save records an author, so this needs a session rather than an API key, exactly as
      //    editing one page does
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized()
      }

      const to = req.body.tag?.trim() || null
      if (to === req.params.tag) {
        // -> Nothing to do, and saying so beats rewriting every page carrying it to the same value
        return { updated: 0, skipped: 0 }
      }

      const change = await WIKI.models.tags.renameTag(req.params.siteId, req.params.tag, to, {
        ...actor,
        groupIds: WIKI.models.groups.groupIdsForRequest(req)
      })
      if (!change) {
        return reply.notFound('No page carries this tag.')
      }

      await audit(req, 'page', to === null ? 'deleteTag' : 'renameTag', {
        siteId: req.params.siteId,
        tag: req.params.tag,
        ...(to === null ? {} : { renamedTo: to }),
        updated: change.updated,
        skipped: change.skipped
      })

      return change
    }
  )
}

export default routes
