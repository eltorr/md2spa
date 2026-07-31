/**
 * Path and URL helpers.
 *
 * Everything the generator emits is an *absolute site path* (e.g. `/guide/install/`,
 * `/assets/style.abc12345.css`). Exactly one function -- `siteUrl()` in build/layout.js --
 * converts those into the form that actually lands in the HTML, using the helpers here.
 * That single choke point is what makes `base: "auto" | "/" | "/prefix/"` work.
 *
 * @module util/path
 */

import { sep } from 'node:path';

/**
 * Convert a native filesystem path to POSIX separators.
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  const s = String(p ?? '');
  // Only the platform separator is rewritten: on POSIX a backslash is a legal filename
  // character, so translating it there would corrupt real paths.
  return sep === '/' ? s : s.split(sep).join('/');
}

/**
 * Normalise a site route: always leading slash, always trailing slash, no doubles.
 * `''` and `'/'` both normalise to `'/'`.
 * @param {string} route
 * @returns {string}
 */
export function normalizeRoute(route) {
  let r = String(route || '/').replace(/\\/g, '/');
  if (!r.startsWith('/')) r = `/${r}`;
  r = r.replace(/\/{2,}/g, '/');
  if (!r.endsWith('/')) r += '/';
  return r;
}

/**
 * Split a route into its non-empty segments.
 * @param {string} route
 * @returns {string[]} e.g. `/guide/install/` -> `['guide', 'install']`
 */
export function routeSegments(route) {
  return normalizeRoute(route).split('/').filter(Boolean);
}

/**
 * Output file path (relative to outDir) for a route.
 *
 * `cleanUrls: true`  -> `/guide/install/` becomes `guide/install/index.html`
 * `cleanUrls: false` -> `/guide/install/` becomes `guide/install.html`,
 *                       but section indexes stay `guide/index.html` so children resolve.
 *
 * @param {string} route
 * @param {{ cleanUrls?: boolean, isIndex?: boolean }} [opts]
 * @returns {string} POSIX path, no leading slash
 */
export function routeToOutputPath(route, opts = {}) {
  const { cleanUrls = true, isIndex = false } = opts;
  const segments = routeSegments(route);
  if (segments.length === 0) return 'index.html';
  if (cleanUrls || isIndex) return `${segments.join('/')}/index.html`;
  return `${segments.join('/')}.html`;
}

/**
 * Directory depth of the emitted document for a route -- i.e. how many `../` are
 * needed to climb back to the site root from that document.
 *
 * @param {string} route
 * @param {{ cleanUrls?: boolean, isIndex?: boolean }} [opts]
 * @returns {number}
 */
export function depthOfRoute(route, opts = {}) {
  const outPath = routeToOutputPath(route, opts);
  return Math.max(0, outPath.split('/').length - 1);
}

/**
 * Route depth: how many path segments a route carries (SPEC 3).
 *
 * This is the *route*-level notion. `depthOfRoute` answers the related but different
 * question of how deep the emitted *file* sits, which also depends on `cleanUrls`.
 *
 * @example
 * depthOf('/')               // 0
 * depthOf('/guide/')         // 1
 * depthOf('/guide/install/') // 2
 *
 * @param {string} route
 * @returns {number}
 */
export function depthOf(route) {
  return routeSegments(route).length;
}

/**
 * Build a document-relative URL to an absolute site path (SPEC 3).
 *
 * The origin may be given either as the route of the document being rendered -- the form
 * SPEC 3 documents -- or as an already-computed directory depth, which is what `layout.js`
 * has on hand (it must account for `cleanUrls: false` emitting `/guide/install.html`, a
 * file one directory shallower than its route suggests).
 *
 * @example
 * relativeUrl('/guide/install/', '/assets/a.css') // '../../assets/a.css'
 * relativeUrl(2, '/assets/style.css')             // '../../assets/style.css'
 * relativeUrl(0, '/assets/style.css')             // 'assets/style.css'
 * relativeUrl(1, '/')                             // '../'
 * relativeUrl(0, '/')                             // './'
 *
 * @param {number|string} from directory depth, or the route of the source document
 * @param {string} absTarget absolute site path, may carry `?query` / `#fragment`
 * @returns {string}
 */
export function relativeUrl(from, absTarget) {
  const { path: targetPath, query, hash } = splitUrl(String(absTarget));

  // Depth form: the caller knows only how deep the document sits, not where it sits, so
  // there is no way to tell whether the target shares any of its ancestors. Every step is
  // climbed to the root and walked back down.
  if (typeof from === 'number') {
    const target = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
    const out = (from > 0 ? '../'.repeat(from) : '') + target;
    return `${out === '' ? './' : out}${query}${hash}`;
  }

  // Directory form: with the document's own location in hand the shared prefix can be
  // dropped, so a breadcrumb from `/writing/advanced/footnotes/` to its section reads
  // `../../` rather than climbing to the root and descending again as `../../../writing/`.
  const fromDirs = routeSegments(from);
  const toParts = (targetPath.startsWith('/') ? targetPath.slice(1) : targetPath).split('/');
  const toFile = toParts.pop();
  const toDirs = toParts.filter((part, i) => part !== '' || i === 0);

  let shared = 0;
  while (shared < fromDirs.length && shared < toDirs.length && fromDirs[shared] === toDirs[shared]) {
    shared += 1;
  }

  const climb = new Array(fromDirs.length - shared).fill('..');
  const descend = toDirs.slice(shared);
  const dirs = climb.concat(descend);
  const out = (dirs.length ? `${dirs.join('/')}/` : '') + toFile;
  return `${out === '' ? './' : out}${query}${hash}`;
}

/**
 * The site directory the emitted document for `route` actually lives in -- which is what
 * its relative URLs resolve against.
 *
 * Under `cleanUrls: false` a leaf page is written as `guide/install.html`, so it sits one
 * directory shallower than its route suggests. Getting this wrong shifts every relative
 * URL on the page by one level.
 *
 * @param {string} route
 * @param {{ cleanUrls?: boolean, isIndex?: boolean }} [opts]
 * @returns {string} absolute site directory, always slash-terminated
 */
export function routeToDocDir(route, opts = {}) {
  const { cleanUrls = true, isIndex = false } = opts;
  const segments = routeSegments(route);
  if (segments.length === 0) return '/';
  if (cleanUrls || isIndex) return `/${segments.join('/')}/`;
  return segments.length === 1 ? '/' : `/${segments.slice(0, -1).join('/')}/`;
}

/**
 * Join URL fragments without ever producing a double slash (protocols excepted).
 * @param {...(string|null|undefined)} parts
 * @returns {string}
 */
export function joinUrl(...parts) {
  const usable = parts.filter((p) => p !== null && p !== undefined && p !== '');
  if (usable.length === 0) return '';
  const joined = usable
    .map((p, i) => {
      let s = String(p);
      if (i > 0) s = s.replace(/^\/+/, '');
      if (i < usable.length - 1) s = s.replace(/\/+$/, '');
      return s;
    })
    .filter((s, i) => s !== '' || i === 0)
    .join('/');
  // Collapse accidental doubles but keep `https://`.
  return joined.replace(/([^:])\/{2,}/g, '$1/');
}

/**
 * Split a URL into its path, query and fragment parts.
 * @param {string} url
 * @returns {{ path: string, query: string, hash: string }}
 */
export function splitUrl(url) {
  const s = String(url);
  const hashAt = s.indexOf('#');
  const hash = hashAt >= 0 ? s.slice(hashAt) : '';
  const withoutHash = hashAt >= 0 ? s.slice(0, hashAt) : s;
  const queryAt = withoutHash.indexOf('?');
  const query = queryAt >= 0 ? withoutHash.slice(queryAt) : '';
  const path = queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash;
  return { path, query, hash };
}

/**
 * True when a URL points somewhere outside this site (has a scheme or is protocol-relative).
 * @param {string} url
 * @returns {boolean}
 */
export function isExternalUrl(url) {
  return /^([a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(String(url).trim());
}

/**
 * Resolve a POSIX-ish relative path against a base directory, collapsing `.`/`..`.
 * Used to turn `../hw/soc/serial-debug.md` (authored in `content/sw/x.md`) into
 * `content/hw/soc/serial-debug.md`. Never escapes above the root.
 *
 * @param {string} baseDir POSIX directory, e.g. `content/sw`
 * @param {string} rel
 * @returns {string} POSIX path with no leading `./`
 */
export function resolveRelative(baseDir, rel) {
  const relStr = String(rel);
  const start = relStr.startsWith('/') ? [] : String(baseDir).split('/').filter(Boolean);
  const out = start.slice();
  for (const part of relStr.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * Route -> SPA payload path, relative to the output root.
 *
 *   `/`                -> `_spa/index.json`
 *   `/guide/install/`  -> `_spa/guide/install/index.json`
 *
 * The payload tree deliberately *mirrors* the route tree rather than flattening it into a
 * single filename. A flattened stem has to sanitise characters that are legal in a route,
 * which makes the mapping lossy: `/a/b/` and `/a__b/` would collapse onto one file, and any
 * non-ASCII route would sanitise down to the empty string. Silently serving one page's
 * content under another page's URL is about the worst failure this tool could have, so the
 * mapping is injective by construction instead of by escaping.
 *
 * It is also cheaper: the browser can derive this path from the route with plain string
 * concatenation, so no route-to-payload lookup table has to be shipped to the client.
 *
 * @param {string} route
 * @returns {string} POSIX path, no leading slash
 */
export function routeToPayloadPath(route) {
  const segments = routeSegments(route);
  return segments.length === 0 ? '_spa/index.json' : `_spa/${segments.join('/')}/index.json`;
}
