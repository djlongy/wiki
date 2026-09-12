/**
 * How a page's source points at an uploaded file.
 *
 * From the site root, so that the path says where the file is rather than where it is being written
 * about: a page that later moves to another folder keeps pointing at the same picture, which a path
 * relative to the page's own folder would not.
 *
 * The renderer resolves it to the `/_files/` URL this server answers, at render time -- see `fileSrc`
 * below -- so what is stored is a path anybody can read rather than the shape this instance happens
 * to serve files under. That resolution also accepts a path relative to the page, which is what
 * markdown written for a repository uses, so imported content keeps working; this is only about what
 * the wiki's own editors write.
 *
 * Both halves live here rather than in one renderer, because both renderers need them: the markdown
 * pipeline resolves an image as it renders it, and the WYSIWYG editor -- whose source is already HTML
 * -- resolves the same sources over the HTML it produces.
 */
import { isServerPath } from '@/helpers/serverPaths'

/**
 * @param {string} folderPath Folder the asset sits in, slash-separated, empty at the site root.
 * @param {string} fileName The asset's stored file name.
 * @returns {string} A path from the site root, e.g. `/media/photo.png`.
 */
export function assetPath(folderPath, fileName) {
  return folderPath ? `/${folderPath}/${fileName}` : `/${fileName}`
}

/**
 * Which folder a file pasted or dropped into the editor is filed in.
 *
 * The site's `uploads.pastedDestination` decides, and it has three forms — see the setting in the admin
 * area's General section:
 *
 * - **empty**: the page's own folder, so a screenshot sits beside the page that shows it.
 * - **relative** (`assets`): a folder under the page's own, per page.
 * - **absolute** (`/media/uploads`): from the site root, so every page's pasted files land together.
 *
 * The leading slash is the whole of what separates the last two, which is why the setting keeps one.
 * `/` alone is therefore the site root, and is a different answer from empty.
 *
 * Nothing here checks that the folder exists: the upload creates what it needs. `.` and `..` segments
 * are dropped rather than followed — in a wiki tree they name a literal folder, never a parent — which
 * matches what the upload route does with whatever it is sent.
 *
 * @param {string} destination The site's `uploads.pastedDestination`.
 * @param {string} pageFolderPath The folder the page being edited is in, empty at the site root.
 * @returns {string} A folder path from the site root, empty for the root itself.
 */
export function pastedAssetFolder(destination, pageFolderPath) {
  const configured = (destination ?? '').trim()
  const base = configured.startsWith('/') ? '' : (pageFolderPath ?? '')
  return [base, configured]
    .join('/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
}

/** Where uploaded files are served from — `backend/controllers/files.ts`. */
export const FILES_PREFIX = '/_files/'

/**
 * Where an uploaded file actually loads from.
 *
 * The other half of the pair: `assetPath` is what a page's source stores and this is what it resolves
 * to, so anything handing a file straight to a browser -- a link to copy, an `<img>` built outside the
 * renderer -- uses this one. Writing it into a page instead would nail the content to the shape this
 * server happens to serve files under.
 *
 * @param {string} folderPath Folder the asset sits in, slash-separated, empty at the site root.
 * @param {string} fileName The asset's stored file name.
 * @returns {string} A root-relative URL, e.g. `/_files/media/photo.png`.
 */
export function assetUrl(folderPath, fileName) {
  return `${FILES_PREFIX}${folderPath ? `${folderPath}/${fileName}` : fileName}`
}

/**
 * Where an image in a page should actually load from.
 *
 * A page's source addresses a picture the way a file sitting next to it would -- `photo.png`,
 * `img/photo.png`, `/media/photo.png` -- which is what the same markdown means in a repository, and
 * what an author who wrote it elsewhere expects it to mean here. None of those is a URL this server
 * answers: uploaded files live under `/_files/`. So the resolution happens at render time and the
 * source is left holding the path that was written, which is what keeps the file readable on GitHub.
 *
 * Relative is relative to the page's FOLDER, as it would be to a file's directory in a repository, so
 * a picture beside the page is found from a page at any depth. A path that starts at the root means
 * the site root.
 *
 * Only images. A relative LINK is a link to another page and means exactly what it says, so the same
 * treatment would break it -- an image is the one thing that is always a file.
 *
 * Left alone: anything carrying a scheme of its own (`http:`, `data:`, and the `blob:` a pending
 * upload sits behind until the save that uploads it), a protocol-relative URL, a bare fragment, and a
 * path the server already owns -- `/_files/` included, so rendering a render changes nothing.
 *
 * @param {string} src The source as written.
 * @param {string} pagePath Path of the page being rendered, without a leading slash. The site root
 *                          when it is not known, which is where a render with no page behind it --
 *                          a review, a history entry -- resolves from.
 * @returns {string} The source to render with.
 */
export function fileSrc(src, pagePath = '') {
  const value = (src ?? '').trim()
  if (
    !value ||
    value.startsWith('#') ||
    value.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  ) {
    return src
  }
  if (isServerPath(value)) {
    return src
  }
  /*
    Resolved with `URL` so that `..`, `.`, a query and a fragment all behave the way they do
    everywhere else, and so that a space in a file name comes out encoded. The origin is a
    placeholder that never survives -- only the path it works out does.
  */
  const folder = pagePath.split('/').slice(0, -1).join('/')
  try {
    const url = new URL(value, `http://page.invalid/${folder ? `${folder}/` : ''}`)
    return `${FILES_PREFIX}${url.pathname.replace(/^\/+/, '')}${url.search}${url.hash}`
  } catch {
    return src
  }
}

/**
 * An `<img>` written as HTML rather than as markdown, matched on its `src` and nothing else.
 *
 * The whitespace before `src` is what keeps `data-src` -- and any other attribute ending in those
 * three characters -- out of it, since a word boundary alone sits happily after the hyphen.
 */
const HTML_IMAGE_SRC = /(<img\b[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi

/**
 * The same resolution, for the images an author wrote as HTML.
 *
 * Raw HTML reaches the renderer as text -- markdown-it does not parse it -- so this is a pass over
 * that text rather than over a token's attributes. It rewrites the `src` of an `img` tag and touches
 * nothing else, and every value it produces has been through `URL`, so quoting it is safe.
 */
export function rewriteHtmlImages(html, pagePath) {
  return mapHtmlImageSrc(html, (src) => fileSrc(src, pagePath))
}

/** Every `src` of every `<img>` in a string of HTML, through `fn`. */
function mapHtmlImageSrc(html, fn) {
  return html.replace(HTML_IMAGE_SRC, (match, before, quoted, singleQuoted, bare) => {
    const value = quoted ?? singleQuoted ?? bare
    const resolved = fn(value)
    return resolved === value ? match : `${before}"${resolved}"`
  })
}

/**
 * The inverse of `fileSrc`, for an editor whose editing surface IS the render.
 *
 * A WYSIWYG editor has to draw the picture, so the document it holds carries the URL the file is
 * served from rather than the path the page stores. Saving that URL would nail the page to the shape
 * this server happens to serve files under, which is the thing `assetPath` exists to avoid, so the
 * prefix comes back off on the way to the source.
 *
 * Only `/_files/` is touched: an author's own `http://`, `data:` or relative source is left exactly
 * as written, and a path that was never resolved is already in the form this returns.
 *
 * @param {string} src The source as the editor holds it.
 * @returns {string} The source to store.
 */
export function sourceSrc(src) {
  const value = (src ?? '').trim()
  // -> Less one, so the leading slash of the path survives
  return value.startsWith(FILES_PREFIX) ? value.slice(FILES_PREFIX.length - 1) : src
}

/** The same, over a string of HTML. The other half of `rewriteHtmlImages`. */
export function unresolveHtmlImages(html) {
  return mapHtmlImageSrc(html, sourceSrc)
}

/**
 * Where an uploaded file's bytes come from when it is addressed by ID rather than by path.
 *
 * The API's own download route, which `/_api` fronts and the session cookie authenticates -- so it
 * can be handed straight to an `<img>`. Preferred over `assetUrl` wherever the ID is in hand: a path
 * exists once per locale and carries none, so `/_files/` answers with the primary locale's file of
 * that name, which is a different file whenever another locale is being browsed.
 *
 * @param {string} siteId UUID of the site the asset belongs to.
 * @param {string} assetId UUID of the asset.
 * @returns {string} A root-relative URL.
 */
export function assetContentUrl(siteId, assetId) {
  return `/_api/sites/${siteId}/assets/${assetId}/content`
}
