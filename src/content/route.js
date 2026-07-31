/**
 * Content file -> route mapping.
 *
 * The folder tree *is* the site map, so this module is the single place that decides what a
 * file on disk is called on the web. Everything downstream -- navigation, breadcrumbs,
 * prev/next, link rewriting, SPA payload names -- derives from `parseContentPath()`, which
 * is why link resolution in `links.js` can simply re-run this function on a resolved path
 * and get the exact same route the page itself was built at.
 *
 * Conventions implemented here (SPEC 7b):
 *   - `index.md` maps to its directory route.
 *   - `01-intro.md` sorts as 1 and routes/titles as `intro` / "Intro".
 *   - files and folders starting with `_` or `.` are excluded from the build.
 *
 * @module content/route
 */

import {
  toPosix,
  normalizeRoute,
  routeSegments,
  routeToOutputPath,
  depthOfRoute,
} from '../util/path.js';

export { routeToOutputPath, depthOfRoute };

/** Extensions treated as Markdown source. */
export const MARKDOWN_EXTENSIONS = Object.freeze(['.md', '.markdown']);

/**
 * Tokens that are upper-cased rather than title-cased when humanising a filename.
 * Kept deliberately short -- a long list starts mangling ordinary words.
 * @type {ReadonlySet<string>}
 */
export const ACRONYMS = new Set([
  'api', 'cli', 'cpu', 'gpu', 'ui', 'ux', 'id', 'url', 'http', 'https', 'json', 'yaml',
  'html', 'css', 'js', 'ts', 'sdk', 'os', 'io', 'ram', 'usb', 'pci', 'faq',
]);

/** `01-intro` / `02_install`. Bounded to three digits so `2024-review` keeps its year. */
const ORDER_PREFIX = /^(\d{1,3})[-_]\s*(\S.*)$/;

const MARKDOWN_EXT_RE = /\.(md|markdown)$/i;

/**
 * True for a path segment the build must ignore (`_drafts/`, `.git/`, `_meta.json`).
 * @param {string} name single path segment
 * @returns {boolean}
 */
export function isHiddenName(name) {
  return /^[._]/.test(String(name));
}

/**
 * True when any segment of a content-relative path is hidden.
 * @param {string} relPath POSIX path relative to `contentDir`
 * @returns {boolean}
 */
export function isExcludedPath(relPath) {
  return toPosix(String(relPath))
    .split('/')
    .filter(Boolean)
    .some(isHiddenName);
}

/**
 * @param {string} relPath
 * @returns {boolean}
 */
export function isMarkdownFile(relPath) {
  return MARKDOWN_EXT_RE.test(String(relPath));
}

/**
 * Drop a `.md` / `.markdown` extension.
 * @param {string} name
 * @returns {string}
 */
export function stripExtension(name) {
  return String(name).replace(MARKDOWN_EXT_RE, '');
}

/**
 * Split a leading numeric ordering prefix off a file or folder name.
 *
 * @example
 * stripOrderPrefix('01-intro')  // { order: 1, name: 'intro' }
 * stripOrderPrefix('intro')     // { order: null, name: 'intro' }
 *
 * @param {string} name file or folder name, extension already removed
 * @returns {{ order: number|null, name: string }}
 */
export function stripOrderPrefix(name) {
  const raw = String(name);
  const match = ORDER_PREFIX.exec(raw);
  if (!match) return { order: null, name: raw };
  return { order: Number(match[1]), name: match[2] };
}

/**
 * Turn a file or folder name into a URL segment: order prefix and extension removed,
 * whitespace collapsed to `-`, characters that would need percent-encoding dropped.
 * Case is preserved so the route still looks like the file the author created.
 *
 * @param {string} name
 * @returns {string}
 */
export function slugSegment(name) {
  const { name: base } = stripOrderPrefix(stripExtension(name));
  const cleaned = base
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._~-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'page';
}

/**
 * Humanise a file or folder name for display: `getting-started.md` -> "Getting Started",
 * `01-usb-boot` -> "USB Boot", `FAQ` -> "FAQ".
 *
 * ALL-CAPS tokens are preserved verbatim because a corpus that writes `SOC.md` means it.
 *
 * @param {string} name
 * @returns {string}
 */
export function humanizeName(name) {
  const { name: base } = stripOrderPrefix(stripExtension(String(name)));
  const tokens = base.split(/[-_\s.]+/).filter(Boolean);
  if (tokens.length === 0) return base;
  return tokens.map(titleCaseToken).join(' ');
}

/**
 * @param {string} token
 * @returns {string}
 */
function titleCaseToken(token) {
  const lower = token.toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  // Preserve deliberate capitalisation (`SoC`, `README`, `IPv6`).
  if (token.length > 1 && token === token.toUpperCase() && /\p{L}/u.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Route of a content *directory*.
 * @param {string} relDir POSIX directory path relative to `contentDir` (`''` for the root)
 * @returns {string} normalised route
 */
export function dirPathToRoute(relDir) {
  const segments = toPosix(String(relDir || ''))
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .map(slugSegment);
  return segments.length ? `/${segments.join('/')}/` : '/';
}

/**
 * @typedef {Object} ContentPathInfo
 * @property {string} relPath   POSIX path relative to `contentDir`
 * @property {string} route     `/guide/install/`
 * @property {string} dir       route of the containing folder, `/guide/`
 * @property {boolean} isIndex  the file is its folder's `index.md`
 * @property {number} depth     output-file depth, i.e. how many `../` reach the site root
 * @property {number} level     nesting level of the route (`/guide/install/` -> 2)
 * @property {string[]} segments route segments
 * @property {string[]} dirNames raw (un-slugged) folder names, for titles and `_meta` lookups
 * @property {string} rawName   `01-install.md`
 * @property {string} name      `install`
 * @property {number|null} order numeric filename prefix, if any
 * @property {boolean} excluded any path segment starts with `_` or `.`
 */

/**
 * Everything routing knows about one content file.
 *
 * @param {string} relPath POSIX path relative to `contentDir`, e.g. `guide/01-install.md`
 * @param {object} [config] uses `cleanUrls` for the emitted-file depth
 * @returns {ContentPathInfo}
 */
export function parseContentPath(relPath, config = {}) {
  const cleanUrls = config.cleanUrls !== false;
  const posix = toPosix(String(relPath)).replace(/^\.?\/+/, '');
  const parts = posix.split('/').filter((part) => part !== '' && part !== '.');

  const rawName = parts.length ? parts[parts.length - 1] : '';
  const dirNames = parts.slice(0, -1);
  const stem = stripExtension(rawName);
  const { order, name } = stripOrderPrefix(stem);
  const isIndex = name.toLowerCase() === 'index';

  const dirSegments = dirNames.map(slugSegment);
  const segments = isIndex ? dirSegments : [...dirSegments, slugSegment(rawName)];
  const route = segments.length ? `/${segments.join('/')}/` : '/';

  return {
    relPath: posix,
    route,
    dir: dirSegments.length ? `/${dirSegments.join('/')}/` : '/',
    isIndex,
    depth: depthOfRoute(route, { cleanUrls, isIndex }),
    level: segments.length,
    segments,
    dirNames,
    rawName,
    name,
    order,
    excluded: parts.some(isHiddenName),
  };
}

/**
 * Route for a content file. `guide/index.md` -> `/guide/`, `guide/01-install.md` -> `/guide/install/`.
 *
 * @param {string} relPath POSIX path relative to `contentDir`
 * @param {object} [config]
 * @returns {string}
 */
export function filePathToRoute(relPath, config = {}) {
  return parseContentPath(relPath, config).route;
}

/**
 * Absolute *site path* a route is served from -- the thing that goes into an `href`
 * before base-mode handling. Identical to the route under `cleanUrls`, `.html`-suffixed
 * otherwise (section indexes stay directory-shaped so their children still resolve).
 *
 * @param {string} route
 * @param {{ cleanUrls?: boolean, isIndex?: boolean }} [opts]
 * @returns {string}
 */
export function routeToSitePath(route, opts = {}) {
  const { cleanUrls = true, isIndex = false } = opts;
  const normalized = normalizeRoute(route);
  if (cleanUrls) return normalized;

  // With `cleanUrls: false` every link names a real file, including section landing
  // pages. A bare directory href relies on the server resolving it to `index.html`,
  // which is exactly what a `file://` open (and a bare object-storage bucket) will not
  // do -- so this mode is the one that genuinely works with no server at all.
  const segments = routeSegments(normalized);
  if (segments.length === 0) return '/index.html';
  if (isIndex) return `/${segments.join('/')}/index.html`;
  return `/${segments.join('/')}.html`;
}
