import MarkdownIt from 'markdown-it'
import { full as mdEmoji } from 'markdown-it-emoji'

/**
 * The renderer for a comment, which is markdown somebody outside this wiki may have written.
 *
 * NOT `MarkdownRenderer` from `./markdown`, and the difference is the whole point of this file.
 *
 * A page's markdown is rendered by that one in the author's browser and then POSTed as HTML, which the
 * server sanitizes before it stores it (`backend/models/rendering.ts`). The sanitizer is what makes the
 * page pipeline safe — not `html: false`. Turning raw HTML off stops an author TYPING a tag, and stops
 * nothing else: `markdown-it-mdc` writes arbitrary tags and arbitrary attributes out of markdown that
 * contains no HTML at all. Measured against the page config with `allowHTML: false`:
 *
 *   [x]{onclick="alert(1)"}            ->  <span onclick="alert(1)">x</span>
 *   ::img{src="x" onerror="alert(1)"}  ->  <img src="x" onerror="alert(1)">
 *   ::iframe{src="javascript:..."}     ->  <iframe src="javascript:...">
 *
 * A comment is never sanitized, because a comment is never HTML anywhere: it is stored as source and
 * rendered here, in the browser of whoever reads it. So it is rendered by a pipeline that cannot
 * produce those in the first place, rather than by one that relies on a step that does not happen.
 *
 * That means markdown-it core and `html: false`, whose output is attributes the parser itself wrote —
 * plus emoji shortcodes, which only ever substitute a character. Every plugin the page uses is absent
 * deliberately, and anything added here has to be judged on what it can emit rather than on what it is
 * for. The cost is that a comment cannot carry a `::note` block, a `{.class}`, a diagram or a KaTeX
 * formula. A comment is a paragraph, a list, a link and a code block, and that is the trade.
 *
 * `linkify` and `breaks` match what 2.x's comment renderer did, which is what a comment box reads like:
 * a bare URL becomes a link, and a newline is a newline.
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false
}).use(mdEmoji)

/*
  No images. A comment may LINK to one; it may not embed one.

  This is not about script execution -- an `<img>` markdown-it wrote carries a src and an alt and
  nothing else. It is that the src is fetched by every reader's browser the moment the thread is drawn,
  from a host an anonymous commenter chose. That is a per-reader IP and user-agent delivered to
  whoever left the comment, on a page they do not control and may never visit again, and it is also
  how a thread gets a full-width picture in it that nobody asked for. A page author has `write:pages`
  and is accountable; a guest with `write:comments` is not.

  Off at the parser, so `![alt](src)` renders as the text it was typed as.
*/
md.disable('image')

/*
  Links out of a comment carry `nofollow`, which links out of a PAGE do not.

  A page is written by somebody the wiki gave `write:pages` to; a comment may be written by anybody the
  guests group lets comment, which on an open wiki is the whole internet. `nofollow` is what stops that
  being worth doing to somebody's search ranking. `noopener` goes with the new tab, and the new tab is
  so that reading a comment cannot navigate the page out from under the reader.
*/
const defaultLinkOpen = (tokens, idx, options, env, slf) =>
  slf.renderToken(tokens, idx, options, env, slf)

md.renderer.rules.link_open = (tokens, idx, options, env, slf) => {
  tokens[idx].attrSet('rel', 'nofollow noopener noreferrer')
  tokens[idx].attrSet('target', '_blank')
  return defaultLinkOpen(tokens, idx, options, env, slf)
}

/**
 * One comment's markdown as HTML.
 *
 * @param {string} content The stored markdown source.
 * @returns {string} HTML safe to hand to `v-html`.
 */
export function renderComment(content) {
  return md.render(content ?? '')
}
