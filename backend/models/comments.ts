import { and, asc, eq } from 'drizzle-orm'
import { comments as commentsTable, users as usersTable } from '../db/schema.ts'

/** A comment as the thread presents it. */
export interface Comment {
  id: string
  /** Markdown source. Rendered by the client, which is where the markdown pipeline lives. */
  content: string
  createdAt: Date
  updatedAt: Date
  author: {
    /** Null for a guest, who has no account to point at. */
    id: string | null
    name: string
    isGuest: boolean
    /** Whether `/_user/<id>/avatar` has a picture to serve. False for a guest, who has no account. */
    hasAvatar: boolean
  }
}

/** Everything a permission decision about one comment needs, without loading the comment twice. */
export interface CommentRef {
  id: string
  pageId: string
  authorId: string | null
}

/**
 * One joined row as a comment.
 *
 * The guest's email address is on the row and is deliberately not here. It is collected so that an
 * administrator has some way to answer or trace whoever left the comment, and a thread is read by
 * whoever may read the page — which on a public wiki is everybody. Harvesting it would be a matter of
 * loading the page.
 */
function toComment(row: any): Comment {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author: {
      id: row.authorId ?? null,
      name: row.authorName ?? row.guestName ?? '',
      isGuest: !row.authorId,
      // -> Asked here rather than left to the browser to find out: a thread of twenty comments would
      //    otherwise be twenty requests for an avatar that is not there, each answered 404
      hasAvatar: Boolean(row.authorHasAvatar)
    }
  }
}

/**
 * The account behind a comment just written or just changed, as the thread presents its author.
 *
 * A second query rather than a join, because both callers already have the row they need and only the
 * author's own fields are missing from it — and neither is on a path that runs more than once per
 * action.
 */
async function authorOf(authorId: string | null) {
  if (!authorId) {
    return { authorName: null, authorHasAvatar: false }
  }
  const rows = await WIKI.db
    .select({ name: usersTable.name, hasAvatar: usersTable.hasAvatar })
    .from(usersTable)
    .where(eq(usersTable.id, authorId))
    .limit(1)
  return { authorName: rows[0]?.name ?? '', authorHasAvatar: rows[0]?.hasAvatar ?? false }
}

/**
 * Comments model
 *
 * A flat thread under a page. Comments hold markdown source and no HTML: the renderer is the client's,
 * the same one that draws the page above them, so nothing stored here has to be sanitized and nothing
 * read back out of here is markup.
 *
 * Who may do what is not decided here — it is a page permission, so it is decided per page against the
 * group rules, and `api/comments.ts` is where that happens. What belongs here is the other half of it:
 * a comment is its author's, and `authorId` is the only thing that says so.
 */
class Comments {
  /**
   * A page's comments, oldest first.
   *
   * Oldest first because a thread is read as a conversation — the reply under what it replies to — and
   * because a reader arriving at the bottom of a page is already at the start of it.
   */
  async getForPage(siteId: string, pageId: string): Promise<Comment[]> {
    const rows = await WIKI.db
      .select({
        id: commentsTable.id,
        content: commentsTable.content,
        createdAt: commentsTable.createdAt,
        updatedAt: commentsTable.updatedAt,
        guestName: commentsTable.guestName,
        authorId: commentsTable.authorId,
        authorName: usersTable.name,
        authorHasAvatar: usersTable.hasAvatar
      })
      .from(commentsTable)
      // -> Left, not inner: a guest's comment has no account to join to, and neither has one whose
      //    author has since closed theirs
      .leftJoin(usersTable, eq(usersTable.id, commentsTable.authorId))
      .where(and(eq(commentsTable.siteId, siteId), eq(commentsTable.pageId, pageId)))
      .orderBy(asc(commentsTable.createdAt))
    return rows.map(toComment)
  }

  /**
   * Just enough of a comment to decide whether this requester may touch it.
   *
   * The page it hangs under comes back with it because the permission is the page's: a comment is not
   * something a group is granted rights over on its own.
   */
  async getRef(siteId: string, id: string): Promise<CommentRef | null> {
    const rows = await WIKI.db
      .select({
        id: commentsTable.id,
        pageId: commentsTable.pageId,
        authorId: commentsTable.authorId
      })
      .from(commentsTable)
      .where(and(eq(commentsTable.siteId, siteId), eq(commentsTable.id, id)))
      .limit(1)
    return rows[0] ?? null
  }

  /**
   * Store a comment.
   *
   * The guest name is kept only when there is no account behind it — a logged in author's name is the
   * account's, and a second copy of it would be a second answer to the same question the moment they
   * rename themselves.
   */
  async create({
    siteId,
    pageId,
    content,
    authorId,
    guestName,
    guestEmail
  }: {
    siteId: string
    pageId: string
    content: string
    authorId: string | null
    guestName?: string
    guestEmail?: string
  }): Promise<Comment> {
    const rows = await WIKI.db
      .insert(commentsTable)
      .values({
        siteId,
        pageId,
        content,
        authorId,
        guestName: authorId ? null : (guestName ?? ''),
        guestEmail: authorId ? null : (guestEmail ?? '')
      })
      .returning()
    const stored = rows[0]

    WIKI.logger.debug(
      `Stored comment ${stored.id} on page ${pageId} from ${authorId ?? 'a guest'}.`
    )
    return toComment({ ...stored, ...(await authorOf(authorId)) })
  }

  /**
   * Rewrite a comment's content.
   *
   * `updatedAt` moves with it, which is what the thread shows an "edited" mark from — an edit is not
   * something to be made invisible, since what a reader replied to may no longer be there.
   *
   * @returns The comment as it now stands, or null if there is no such comment
   */
  async update(siteId: string, id: string, content: string): Promise<Comment | null> {
    const rows = await WIKI.db
      .update(commentsTable)
      .set({ content, updatedAt: new Date() })
      .where(and(eq(commentsTable.siteId, siteId), eq(commentsTable.id, id)))
      .returning()
    const stored = rows[0]
    if (!stored) {
      return null
    }
    return toComment({ ...stored, ...(await authorOf(stored.authorId)) })
  }

  /**
   * Delete a comment.
   *
   * Gone rather than marked deleted: the thread is flat, so nothing hangs off a comment that would be
   * orphaned by its removal, and a tombstone nobody reads is a row that still has to be filtered out
   * of every query that touches this table.
   *
   * @returns Whether a comment was deleted
   */
  async delete(siteId: string, id: string): Promise<boolean> {
    const result = await WIKI.db
      .delete(commentsTable)
      .where(and(eq(commentsTable.siteId, siteId), eq(commentsTable.id, id)))
    return (result.rowCount ?? 0) > 0
  }
}

export const comments = new Comments()
