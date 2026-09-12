import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { absPathIn } from './storageFiles.ts'
import type { StoredFile } from './storageFiles.ts'

/**
 * A tar reader and writer, in as much of the format as a content archive uses.
 *
 * Here rather than as a dependency because the archive this produces and reads is the wiki's own:
 * ordinary files with ordinary names, written moments earlier by a storage target and read back into
 * one. There are no links, no devices, no ownership worth carrying and no sparse files, which is most
 * of what a tar library exists for — and the alternative is a package, and its six transitive
 * packages, for a format whose whole structure is a 512-byte header.
 *
 * What is deliberately kept is the compatibility that makes the file worth producing at all: what
 * comes out is a **ustar** archive that `tar -tzf` lists and that every archive manager opens, and
 * what goes in may be an archive some other tool wrote — so the reader is liberal about the two long
 * name conventions (PAX and GNU) it will never itself write, and about entry kinds it skips.
 */

/** Everything in a tar file is a whole number of these. */
const BLOCK = 512

/** The two of these that end an archive. */
const END_BLOCK = Buffer.alloc(BLOCK)

/** What a name has to fit in, and what the `prefix` field holds when it does not. */
const NAME_FIELD = 100
const PREFIX_FIELD = 155

/**
 * A numeric header field: octal, zero-padded, one character of the width left for the terminator.
 *
 * The terminator may be a space or a NUL and readers take either; this writes a space, as GNU tar
 * does for these fields.
 */
function octalField(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')} `
}

/** A NUL-terminated header field as the string it holds. */
function stringField(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

/** A numeric header field as the number it holds, and 0 for one that is blank or unreadable. */
function octalValue(header: Buffer, offset: number, length: number): number {
  const parsed = Number.parseInt(stringField(header, offset, length).trim(), 8)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * One header block.
 *
 * The checksum is the sum of every byte of the block with its own field read as spaces, which is why
 * it is written last and over the top of the spaces that stood in for it.
 */
function headerBlock(
  name: string,
  size: number,
  mtime: number,
  typeFlag: string,
  prefix = ''
): Buffer {
  const header = Buffer.alloc(BLOCK)
  header.write(name, 0, NAME_FIELD, 'utf8')
  header.write(octalField(0o644, 8), 100, 8, 'utf8')
  header.write(octalField(0, 8), 108, 8, 'utf8')
  header.write(octalField(0, 8), 116, 8, 'utf8')
  header.write(octalField(size, 12), 124, 12, 'utf8')
  header.write(octalField(mtime, 12), 136, 12, 'utf8')
  header.write('        ', 148, 8, 'utf8')
  header.write(typeFlag, 156, 1, 'utf8')
  header.write('ustar\0' + '00', 257, 8, 'utf8')
  header.write(prefix, 345, PREFIX_FIELD, 'utf8')

  let checksum = 0
  for (const byte of header) {
    checksum += byte
  }
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return header
}

/** The zero bytes that round a file out to a whole number of blocks. */
function padding(size: number): Buffer {
  const remainder = size % BLOCK
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder)
}

/**
 * Split a path across the two name fields, which is how ustar addresses more than 100 bytes.
 *
 * The split has to fall on a slash, so a path may be short enough overall and still have nowhere to
 * break — a single 120-byte file name is the case — and that is what the PAX header below is for.
 *
 * @returns Null for a path the two fields cannot hold between them
 */
function splitName(relPath: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(relPath) <= NAME_FIELD) {
    return { name: relPath, prefix: '' }
  }
  for (let at = relPath.indexOf('/'); at >= 0; at = relPath.indexOf('/', at + 1)) {
    const prefix = relPath.slice(0, at)
    const name = relPath.slice(at + 1)
    if (Buffer.byteLength(prefix) <= PREFIX_FIELD && Buffer.byteLength(name) <= NAME_FIELD) {
      return { name, prefix }
    }
  }
  return null
}

/**
 * A PAX extended header record: `<length> <key>=<value>\n`, where the length counts itself.
 *
 * Self-referential, hence the loop — writing the length can push the record into another digit — and
 * it settles after at most one extra pass.
 */
function paxRecord(key: string, value: string): string {
  let length = Buffer.byteLength(`${key}=${value}\n`) + 1
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = `${length} ${key}=${value}\n`
    if (Buffer.byteLength(candidate) === length) {
      return candidate
    }
    length = Buffer.byteLength(candidate)
  }
  return `${length} ${key}=${value}\n`
}

/** The `path` a PAX extended header overrides the next entry's name with, if it carries one. */
function paxPath(body: Buffer): string | null {
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
  return match ? match[1] : null
}

/**
 * Write a tar archive, one file at a time.
 *
 * A generator rather than a buffer because the files are assets: an archive of a wiki is as large as
 * the wiki, and the caller is streaming it to a client that is not waiting for it to be assembled
 * first. Each file's bytes are read as they are needed and never all held at once.
 *
 * @param files What to write, as `walkStored` reports it — the caller has already decided what
 *   belongs in the archive and what its path in there is
 */
export async function* packTar(files: StoredFile[]): AsyncGenerator<Buffer> {
  for (const { filePath, segments } of files) {
    const relPath = segments.join('/')
    let stat
    try {
      stat = await fs.stat(filePath)
    } catch (err: any) {
      // -> A file that went between the walk and here. Nothing to archive and nothing wrong.
      if (err.code === 'ENOENT') {
        continue
      }
      throw err
    }
    const mtime = Math.floor(stat.mtimeMs / 1000)

    const split = splitName(relPath)
    if (split) {
      yield headerBlock(split.name, stat.size, mtime, '0', split.prefix)
    } else {
      // -> The name goes in a record of its own ahead of the entry, and the entry's own name field
      //    holds a stand-in that every reader of PAX ignores
      const record = Buffer.from(paxRecord('path', relPath), 'utf8')
      yield headerBlock('PaxHeader', record.length, mtime, 'x')
      yield record
      yield padding(record.length)
      yield headerBlock(path.basename(relPath).slice(0, NAME_FIELD), stat.size, mtime, '0')
    }

    for await (const chunk of createReadStream(filePath)) {
      yield chunk as Buffer
    }
    yield padding(stat.size)
  }
  yield END_BLOCK
  yield END_BLOCK
}

/**
 * Unpack a tar archive into a folder, as ordinary files.
 *
 * **Every entry's path is checked against the root before anything is written** — an archive is
 * whatever was uploaded, and `../` in an entry name is the oldest trick there is. `absPathIn` raises
 * on one, which fails the whole extraction rather than skipping the entry: an archive carrying one is
 * not an archive to take half of.
 *
 * Anything that is not a plain file is skipped, which covers the directory entries most tars write
 * (the folders are made as the files in them are), and symlinks, devices and the rest — none of which
 * a wiki's content is, and all of which are a way to write outside the root.
 *
 * @returns How many files were written
 */
export async function extractTar(archive: Buffer, root: string): Promise<number> {
  let offset = 0
  let written = 0
  /** Set by a PAX or GNU long-name header, and consumed by the entry that follows it. */
  let overrideName: string | null = null

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK)
    offset += BLOCK
    // -> The two zero blocks that end an archive, or the padding some writers leave after them
    if (header.every((byte) => byte === 0)) {
      break
    }

    const size = octalValue(header, 124, 12)
    const typeFlag = stringField(header, 156, 1) || '0'
    const body = archive.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK

    if (typeFlag === 'x' || typeFlag === 'X') {
      overrideName = paxPath(body)
      continue
    }
    if (typeFlag === 'L') {
      overrideName = body.subarray(0, body.indexOf(0) === -1 ? body.length : body.indexOf(0))
        .toString('utf8')
      continue
    }
    // -> A global PAX header applies to the whole archive rather than to the next entry, and nothing
    //    it can say is something this reads
    if (typeFlag === 'g') {
      continue
    }
    if (typeFlag !== '0' && typeFlag !== '7') {
      overrideName = null
      continue
    }

    const prefix = stringField(header, 345, PREFIX_FIELD)
    const stored = stringField(header, 0, NAME_FIELD)
    const relPath = overrideName ?? (prefix ? `${prefix}/${stored}` : stored)
    overrideName = null
    if (!relPath || relPath.endsWith('/')) {
      continue
    }

    const filePath = absPathIn(root, relPath)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, body)
    written++
  }

  return written
}
