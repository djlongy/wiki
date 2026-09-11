import { audit } from '../helpers/audit.ts'
import { CustomError } from '../helpers/common.ts'
import { actorFrom, mayBypassPassword, mayOnPage, unlockedFor } from './pages.ts'
import type { CommentRef } from '../models/comments.ts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/** The longest a single comment may be. Generous for prose, and short of an accidental file paste. */
const MAX_CONTENT_LENGTH = 10000

const pageParams = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    pageId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId', 'pageId']
}

const commentParams = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    commentId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId', 'commentId']
}

const commentResponse = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    content: {
      type: 'string',
      description:
        'Markdown source. Render it client-side with HTML off; it has never been through a sanitizer.'
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    author: {
      type: 'object',
      properties: {
        id: { type: 'string', nullable: true },
        name: { type: 'string' },
        isGuest: { type: 'boolean' },
        hasAvatar: { type: 'boolean' }
      }
    }
  }
}

/**
 * The page a thread hangs under, as this requester is allowed to see it.
 *
 * Loaded the way every other page-scoped route loads it — an anonymous reader reaches published pages
 * only, and a password still has to have been satisfied — so a comment can never become a way to learn
 * that a page exists, or what it is called, when the page itself is out of reach. A page somebody may
 * not read is answered as though it were not there.
 */
async function loadCommentablePage(req: FastifyRequest, siteId: string, pageId: string) {
  const actor = actorFrom(req)
  const page = await WIKI.models.pages.getPage({
    siteId,
    id: pageId,
    publicOnly: !actor,
    unlocked: (id: string) => unlockedFor(req, id),
    withPassword: mayBypassPassword(req)
  })
  if (!page || !mayOnPage(req, 'read:pages', page)) {
    return null
  }
  return page
}

/**
 * The comment named in the path, together with the page it is under — or a refusal already sent.
 *
 * Both halves have to be loaded before anything can be decided, because a comment carries no
 * permissions of its own: what may be done to it is what the PAGE's rules say, plus whose it is. The
 * page is loaded through the gate above, so a comment under an unreadable page is not there either.
 */
async function loadOwnedComment(
  req: FastifyRequest,
  reply: FastifyReply,
  { siteId, commentId }: { siteId: string; commentId: string }
): Promise<{ comment: CommentRef; page: { id: string; path: string; locale: string } } | null> {
  const comment = await WIKI.models.comments.getRef(siteId, commentId)
  if (!comment) {
    reply.notFound('This comment does not exist.')
    return null
  }
  const page = await loadCommentablePage(req, siteId, comment.pageId)
  if (!page) {
    reply.notFound('This comment does not exist.')
    return null
  }
  if (!mayOnPage(req, 'read:comments', page)) {
    reply.notFound('This comment does not exist.')
    return null
  }
  return { comment, page }
}

/**
 * Whether this requester may change or remove a comment that already exists.
 *
 * Two ways in, and they answer different questions. `manage:comments` on the page is moderation — the
 * right to act on anything in the thread, whoever wrote it. Otherwise a comment is its author's, and
 * only theirs: the session's own user id has to be the one on the row.
 *
 * A guest is never the author of anything under this test. `authorId` is null on every comment a guest
 * leaves, and there is nothing else about them to match on — so an anonymous requester matching an
 * anonymous comment would hand every guest's comment to every other guest. Null on both sides is not
 * the same person, and the `actor` check is what says so.
 */
function mayModify(
  req: FastifyRequest,
  comment: CommentRef,
  page: { path: string; locale?: string; tags?: string[] }
): boolean {
  if (mayOnPage(req, 'manage:comments', page)) {
    return true
  }
  const actor = actorFrom(req)
  return Boolean(actor && comment.authorId && comment.authorId === actor.id)
}

/**
 * Comments API Routes
 *
 * A flat thread under a page. Everything stored is markdown SOURCE — the render happens in the browser
 * that shows it, with HTML off, exactly as the page above it is rendered. Nothing here produces or
 * accepts HTML, which is the whole of what keeps a comment from being a way to put markup on somebody
 * else's page.
 *
 * No route-level `permissions`: every one of these is decided per page, by `read:comments`,
 * `write:comments` and `manage:comments` on that page's rules, and the route hook reads the group-wide
 * list instead. See `api/pages.ts`.
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST A PAGE'S COMMENTS
   */
  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/comments',
    {
      schema: {
        summary: "List a page's comments",
        description:
          "The thread under a page, oldest first. `content` is markdown source: this API never stores or returns rendered HTML, so a client displaying it renders it itself with HTML disabled.\n\nNeeds `read:comments` on the page. A guest reaches it under whatever the guests group's rules allow, which is how a public wiki shows its comments to the public.",
        tags: ['Comments'],
        params: pageParams,
        response: {
          200: {
            description: 'The comments on this page',
            type: 'array',
            items: commentResponse
          }
        }
      }
    },
    async (req, reply) => {
      const page = await loadCommentablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'read:comments', page)) {
        return reply.forbidden('You are not allowed to read comments on this page.')
      }
      return WIKI.models.comments.getForPage(req.params.siteId, page.id)
    }
  )

  /**
   * POST A COMMENT
   */
  app.post<{
    Params: { siteId: string; pageId: string }
    Body: { content: string; guestName?: string; guestEmail?: string }
  }>(
    '/sites/:siteId/pages/:pageId/comments',
    {
      schema: {
        summary: 'Post a comment on a page',
        description:
          "Adds a comment to the page's thread. `content` is markdown source and is stored as sent — no HTML is produced here.\n\nNeeds `write:comments` on the page. An anonymous author has no account to attribute it to and has to give a name and an email address instead; the email is stored but is never handed back to a reader.",
        tags: ['Comments'],
        params: pageParams,
        body: {
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string', maxLength: MAX_CONTENT_LENGTH },
            guestName: { type: 'string', maxLength: 255 },
            guestEmail: { type: 'string', maxLength: 255 }
          }
        },
        response: {
          200: {
            description: 'Comment posted successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              comment: commentResponse
            }
          }
        }
      }
    },
    async (req, reply) => {
      const page = await loadCommentablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      /*
        Reading comes first and is checked separately, so that a rule granting `write:comments` without
        `read:comments` cannot be written into a way of posting into a thread nobody may see.
      */
      if (!mayOnPage(req, 'read:comments', page)) {
        return reply.forbidden('You are not allowed to read comments on this page.')
      }
      if (!mayOnPage(req, 'write:comments', page)) {
        return reply.forbidden('You are not allowed to comment on this page.')
      }
      /*
        The page's own switch, which the editor offers under its properties. A veto on POSTING and not
        on reading, which is the shape `allowContributions` has in `api/approvals.ts` and for the same
        reason: closing a page to comments must not strand the thread already under it.
      */
      if (!page.allowComments) {
        return reply.forbidden('This page is not accepting comments.')
      }

      const content = req.body.content.trim()
      if (content.length < 1) {
        throw new CustomError('commentContentMissing', 'A comment cannot be empty.')
      }

      const actor = actorFrom(req)
      const guestName = (req.body.guestName ?? '').trim()
      const guestEmail = (req.body.guestEmail ?? '').trim()
      if (!actor) {
        // -> Nothing else records who this came from, and a thread of unattributed text is not a
        //    conversation anybody can follow
        if (guestName.length < 1) {
          throw new CustomError('commentGuestNameMissing', 'A name is required.')
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
          throw new CustomError('commentGuestEmailInvalid', 'A valid email address is required.')
        }
      }

      const comment = await WIKI.models.comments.create({
        siteId: req.params.siteId,
        pageId: page.id,
        content,
        authorId: actor?.id ?? null,
        guestName,
        guestEmail
      })

      await WIKI.models.hooks.emit('comment:new', {
        id: comment.id,
        pageId: page.id,
        path: page.path,
        locale: page.locale,
        siteId: req.params.siteId,
        authorId: comment.author.id,
        metadata: { authorName: comment.author.name, isGuest: comment.author.isGuest },
        content: comment.content
      })

      /*
        Recorded for a guest too, who has no account for `userId` to point at: the name and the email
        they gave are on `meta` rather than on `meta.actor`, since those two belong to an account and
        there is none.
      */
      await audit(req, 'page', 'postComment', {
        commentId: comment.id,
        pageId: page.id,
        siteId: req.params.siteId,
        locale: page.locale,
        path: page.path,
        ...(actor ? {} : { guestName, guestEmail })
      })

      return { ok: true, comment }
    }
  )

  /**
   * EDIT A COMMENT
   */
  app.patch<{
    Params: { siteId: string; commentId: string }
    Body: { content: string }
  }>(
    '/sites/:siteId/comments/:commentId',
    {
      schema: {
        summary: 'Edit a comment',
        description:
          "Rewrites a comment's markdown source. The author may edit their own; `manage:comments` on the page edits anybody's. A guest cannot edit anything, having no account for the comment to belong to.",
        tags: ['Comments'],
        params: commentParams,
        body: {
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string', maxLength: MAX_CONTENT_LENGTH }
          }
        },
        response: {
          200: {
            description: 'Comment updated successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              comment: commentResponse
            }
          }
        }
      }
    },
    async (req, reply) => {
      const loaded = await loadOwnedComment(req, reply, req.params)
      if (!loaded) {
        return reply
      }
      if (!mayModify(req, loaded.comment, loaded.page)) {
        return reply.forbidden('You are not allowed to edit this comment.')
      }

      const content = req.body.content.trim()
      if (content.length < 1) {
        throw new CustomError('commentContentMissing', 'A comment cannot be empty.')
      }

      const comment = await WIKI.models.comments.update(
        req.params.siteId,
        req.params.commentId,
        content
      )
      if (!comment) {
        return reply.notFound('This comment does not exist.')
      }

      await WIKI.models.hooks.emit('comment:edit', {
        id: comment.id,
        pageId: loaded.page.id,
        path: loaded.page.path,
        locale: loaded.page.locale,
        siteId: req.params.siteId,
        authorId: comment.author.id,
        metadata: { authorName: comment.author.name, isGuest: comment.author.isGuest },
        content: comment.content
      })

      await audit(req, 'page', 'editComment', {
        commentId: comment.id,
        pageId: loaded.page.id,
        siteId: req.params.siteId,
        locale: loaded.page.locale,
        path: loaded.page.path
      })

      return { ok: true, comment }
    }
  )

  /**
   * DELETE A COMMENT
   */
  app.delete<{ Params: { siteId: string; commentId: string } }>(
    '/sites/:siteId/comments/:commentId',
    {
      schema: {
        summary: 'Delete a comment',
        description:
          "Removes a comment for good. The author may delete their own; `manage:comments` on the page deletes anybody's. A guest cannot delete anything, having no account for the comment to belong to.",
        tags: ['Comments'],
        params: commentParams,
        response: {
          200: {
            description: 'Comment deleted successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const loaded = await loadOwnedComment(req, reply, req.params)
      if (!loaded) {
        return reply
      }
      if (!mayModify(req, loaded.comment, loaded.page)) {
        return reply.forbidden('You are not allowed to delete this comment.')
      }

      await WIKI.models.comments.delete(req.params.siteId, req.params.commentId)

      await WIKI.models.hooks.emit('comment:delete', {
        id: req.params.commentId,
        pageId: loaded.page.id,
        path: loaded.page.path,
        locale: loaded.page.locale,
        siteId: req.params.siteId,
        authorId: loaded.comment.authorId
      })

      await audit(req, 'page', 'deleteComment', {
        commentId: req.params.commentId,
        pageId: loaded.page.id,
        siteId: req.params.siteId,
        locale: loaded.page.locale,
        path: loaded.page.path
      })

      return { ok: true }
    }
  )
}

export default routes
