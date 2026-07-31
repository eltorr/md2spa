/**
 * Cross-page link resolution and validation.
 *
 * Authors write relative Markdown links exactly as they do on GitHub
 * (`[x](../hw/soc/serial-debug.md#pins)`), because that is what keeps the source browsable
 * in a repo viewer. The build rewrites them to routes: resolve against the *source file's*
 * directory, normalise, drop the `.md`, map `index.md` to the directory route, keep the
 * query and fragment, then emit through the one helper that understands the three `base`
 * modes. SPEC 4b's table is the contract; every row of it is exercised here.
 *
 * @module content/links
 */

import {
  splitUrl,
  isExternalUrl,
  resolveRelative,
  normalizeRoute,
  routeToOutputPath,
  joinUrl,
} from '../util/path.js';
import { createBag } from '../markdown/diagnostics.js';
import {
  filePathToRoute,
  dirPathToRoute,
  routeToSitePath,
  isMarkdownFile,
} from './route.js';

/**
 * @typedef {Object} LinkTarget
 * @property {'empty'|'external'|'fragment'|'page'|'asset'} kind
 * @property {string} href       the URL to emit, already base-mode aware
 * @property {string|null} route  target route, for `kind: 'page'`
 * @property {string|null} sitePath absolute site path of the target
 * @property {string} query
 * @property {string} hash
 * @property {boolean|null} exists null when existence was not checked
 * @property {string|null} assetPath site-root-relative asset path, for `kind: 'asset'`
 */

/** Route indexes are rebuilt only when the caller passes a different `routes` object. */
const ROUTE_INDEX_CACHE = new WeakMap();

/**
 * @param {LinkTarget['kind']} kind
 * @param {Partial<LinkTarget>} props
 * @returns {LinkTarget}
 */
function makeTarget(kind, props) {
  return {
    kind,
    href: '',
    route: null,
    sitePath: null,
    query: '',
    hash: '',
    exists: null,
    assetPath: null,
    ...props,
  };
}

/**
 * The `resolveUrl(url, node)` callback the renderer calls for every link and image URL.
 * Returns the href to emit; external, `mailto:`, `tel:` and fragment-only URLs come back
 * untouched.
 *
 * @param {import('./scan.js').PageSource} page the page being rendered
 * @param {{ routes?: unknown, config?: object, staticFiles?: unknown, contentAssets?: unknown }} [options]
 * @returns {(url: string, node?: object) => string}
 */
export function createUrlResolver(page, options = {}) {
  const resolve = createLinkResolver(page, options);
  return (url, node) => resolve(url, node).href;
}

/**
 * Lower-level resolver: same logic, but returns the full {@link LinkTarget} so callers can
 * report diagnostics. Used by {@link resolveLinks}.
 *
 * @param {import('./scan.js').PageSource} page
 * @param {{ routes?: unknown, config?: object, staticFiles?: unknown, contentAssets?: unknown }} [options]
 * @returns {(url: string, node?: object) => LinkTarget}
 */
export function createLinkResolver(page, options = {}) {
  const config = options.config || {};
  const index = getRouteIndex(options.routes);
  const assetIndex = createAssetIndex(options.staticFiles, options.contentAssets);
  const cleanUrls = config.cleanUrls !== false;

  const relPath = typeof page?.relPath === 'string' ? page.relPath : '';
  const fromDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  const ownRoute = normalizeRoute(page?.route || '/');
  const ownSitePath = routeToSitePath(ownRoute, { cleanUrls, isIndex: !!page?.isIndex });
  const docDir = documentDirSegments(ownRoute, cleanUrls, !!page?.isIndex);

  /** @type {(abs: string) => string} */
  const emit = (abs) => emitHref(abs, docDir, config);

  return (url, node) => {
    const raw = String(url ?? '').trim();
    if (!raw) return makeTarget('empty', { href: '' });
    if (raw.startsWith('#')) return makeTarget('fragment', { href: raw, hash: raw });
    if (isExternalUrl(raw)) return makeTarget('external', { href: raw });

    const { path: rawPath, query, hash } = splitUrl(raw);
    if (rawPath === '') return makeTarget('fragment', { href: raw, query, hash });

    const resolved = resolveRelative(fromDir, rawPath);
    const segments = rawPath.split('/').filter(Boolean);
    const last = segments.length ? segments[segments.length - 1] : '';
    const dirLike = rawPath.endsWith('/') || last === '' || last === '.' || last === '..';
    const isImage = node?.type === 'image';

    let route = null;
    if (dirLike) {
      route = dirPathToRoute(resolved);
    } else if (isMarkdownFile(last)) {
      route = filePathToRoute(resolved, config);
    } else if (!isImage) {
      const candidate = filePathToRoute(resolved, config);
      const extensionless = !/\.[A-Za-z0-9]{1,10}$/.test(last);
      if (index.has(candidate) || extensionless) route = candidate;
    }

    if (route !== null) {
      const exists = index.has(route);
      const sitePath = routeToSitePath(route, { cleanUrls, isIndex: index.isIndex(route) });
      const href = sitePath === ownSitePath
        ? (query + hash) || './'
        : emit(sitePath + query + hash);
      return makeTarget('page', { href, route, sitePath, query, hash, exists });
    }

    const assetPath = resolved;
    const sitePath = `/${assetPath}`;
    return makeTarget('asset', {
      href: emit(sitePath + query + hash),
      sitePath,
      assetPath,
      query,
      hash,
      exists: assetIndex.enabled ? assetIndex.has(assetPath) : null,
    });
  };
}

/**
 * Validate every link and image in the site.
 *
 * @param {{ pages?: import('./scan.js').PageSource[], rendered?: unknown,
 *           anchorsByRoute?: unknown, staticFiles?: unknown, contentAssets?: unknown,
 *           extraRoutes?: unknown, config?: object, cwd?: string }} input
 *   `rendered` is a Map (or array) of the `renderHtml()` results keyed by route; only
 *   `links`, `images`, `headings` and `html` are read from each entry.
 *   `extraRoutes` covers routes that exist without a source file -- pass
 *   `nav.generatedPages` so links into a generated section page are not reported missing.
 * @returns {import('../markdown/diagnostics.js').Diagnostic[]}
 */
export function resolveLinks(input = {}) {
  const {
    pages = [], rendered, anchorsByRoute, staticFiles, contentAssets, extraRoutes,
    config = {}, cwd = '',
  } = input;
  const cwdPrefix = cwd ? `${String(cwd).replace(/\/+$/, '')}/` : '';

  const renderedMap = toKeyedMap(rendered);
  const anchors = collectAnchors(renderedMap, anchorsByRoute, pages);
  const routes = new Map(pages.map((page) => [normalizeRoute(page.route), page]));
  for (const [route, value] of toKeyedMap(extraRoutes)) {
    if (typeof route === 'string' && route.startsWith('/') && !routes.has(route)) {
      routes.set(route, value && typeof value === 'object' ? value : null);
    }
  }
  /** @type {import('../markdown/diagnostics.js').Diagnostic[]} */
  const diagnostics = [];

  for (const page of pages) {
    const entry = renderedMap.get(normalizeRoute(page.route)) || renderedMap.get(page.file) || null;
    if (!entry) continue;

    // Diagnostics identify files relative to cwd; scanContent already does that, but a
    // caller assembling pages by hand may hand us absolute paths.
    const file = cwdPrefix && page.file?.startsWith(cwdPrefix)
      ? page.file.slice(cwdPrefix.length)
      : page.file;
    const bag = createBag(file, { rules: config.rules });
    const resolve = createLinkResolver(page, { routes, config, staticFiles, contentAssets });
    const ownAnchors = anchors.get(normalizeRoute(page.route));

    for (const link of asArray(entry.links)) {
      const target = resolve(link.url, { type: 'link' });

      if (target.kind === 'fragment' && target.hash) {
        checkAnchor(bag, link, target.hash, ownAnchors, page.route, true);
        continue;
      }
      if (target.kind !== 'page' && target.kind !== 'asset') continue;

      if (target.kind === 'page') {
        if (!target.exists) {
          bag.add('MD044', link,
            `link target \`${link.url}\` does not exist (resolved to \`${target.route}\`)`,
            'Links are resolved relative to this file. Check the path, or create the page.');
          continue;
        }
        if (target.hash) {
          checkAnchor(bag, link, target.hash, anchors.get(target.route), target.route, false);
        }
        continue;
      }

      if (target.exists === false) {
        bag.add('MD046', link,
          `linked file \`${link.url}\` was not found (looked for \`${target.assetPath}\`)`,
          `Put it under \`${config.staticDir || 'static'}/\` or next to the page in your content tree.`);
      }
    }

    for (const image of asArray(entry.images)) {
      const target = resolve(image.url, { type: 'image' });
      if (target.kind !== 'asset' || target.exists !== false) continue;
      bag.add('MD046', image,
        `image \`${image.url}\` was not found (looked for \`${target.assetPath}\`)`,
        `Put it under \`${config.staticDir || 'static'}/\` or next to the page in your content tree.`);
    }

    diagnostics.push(...bag.list());
  }

  return diagnostics;
}

/* ------------------------------------------------------------------ href emission */

/**
 * Directory the emitted document lives in, as segments -- the anchor point for
 * document-relative URLs.
 *
 * @param {string} route
 * @param {boolean} cleanUrls
 * @param {boolean} isIndex
 * @returns {string[]}
 */
function documentDirSegments(route, cleanUrls, isIndex) {
  const out = routeToOutputPath(route, { cleanUrls, isIndex });
  const parts = out.split('/');
  parts.pop();
  return parts.filter(Boolean);
}

/**
 * Turn an absolute site path into the href that actually goes into the HTML.
 *
 * `base: "auto"` emits a true document-relative path (`../partitioning-cheatsheet/`), which
 * is what makes the output work at `/`, at `/user/project/` and over `file://` alike.
 * An explicit base emits root-relative URLs under that prefix.
 *
 * @param {string} absTarget absolute site path, may carry `?query` / `#fragment`
 * @param {string[]} docDir document directory segments
 * @param {object} config
 * @returns {string}
 */
function emitHref(absTarget, docDir, config) {
  const base = config.base ?? 'auto';
  if (base && base !== 'auto') {
    const { path: p, query, hash } = splitUrl(absTarget);
    const joined = joinUrl(base, p);
    const withSlash = p.endsWith('/') && !joined.endsWith('/') ? `${joined}/` : joined;
    return withSlash + query + hash;
  }

  const { path: p, query, hash } = splitUrl(absTarget);
  const toSegments = p.split('/').filter(Boolean);
  let common = 0;
  while (
    common < docDir.length
    && common < toSegments.length
    && docDir[common] === toSegments[common]
  ) {
    common += 1;
  }
  const up = docDir.length - common;
  const down = toSegments.slice(common);
  let out = '../'.repeat(up) + down.join('/');
  if (p.endsWith('/') && down.length > 0) out += '/';
  if (out === '') out = './';
  return out + query + hash;
}

/* ------------------------------------------------------------------ indexes */

/**
 * @param {unknown} routes Map<route, page> | Set<route> | Array<route|PageSource>
 * @returns {{ has(route: string): boolean, isIndex(route: string): boolean }}
 */
function getRouteIndex(routes) {
  if (routes && typeof routes === 'object') {
    const cached = ROUTE_INDEX_CACHE.get(/** @type {object} */ (routes));
    if (cached) return cached;
    const built = createRouteIndex(routes);
    ROUTE_INDEX_CACHE.set(/** @type {object} */ (routes), built);
    return built;
  }
  return createRouteIndex(routes);
}

/**
 * @param {unknown} routes
 * @returns {{ has(route: string): boolean, isIndex(route: string): boolean }}
 */
function createRouteIndex(routes) {
  /** @type {Map<string, object|null>} */
  const map = new Map();
  const add = (route, value) => {
    if (typeof route !== 'string' || !route) return;
    map.set(normalizeRoute(route), value && typeof value === 'object' ? value : null);
  };

  if (routes instanceof Map) {
    for (const [route, value] of routes) add(route, value);
  } else if (routes && typeof routes[Symbol.iterator] === 'function' && typeof routes !== 'string') {
    for (const item of /** @type {Iterable<any>} */ (routes)) {
      if (typeof item === 'string') add(item, null);
      else if (item && typeof item.route === 'string') add(item.route, item);
    }
  }

  // Any route with descendants behaves like a directory index, which is what decides
  // whether `cleanUrls: false` emits `/guide/` or `/guide.html`.
  const parents = new Set(['/']);
  for (const route of map.keys()) {
    const segments = route.split('/').filter(Boolean);
    for (let i = 1; i < segments.length; i += 1) {
      parents.add(`/${segments.slice(0, i).join('/')}/`);
    }
  }

  return {
    has(route) {
      return map.has(normalizeRoute(route));
    },
    isIndex(route) {
      const key = normalizeRoute(route);
      const page = map.get(key);
      if (page && typeof page.isIndex === 'boolean') return page.isIndex;
      return parents.has(key);
    },
  };
}

/**
 * Set of files that exist in the emitted site, used for MD046. Checking is disabled
 * entirely when the caller supplies nothing, so a build that cannot enumerate its assets
 * stays quiet instead of flagging every image.
 *
 * @param {unknown} staticFiles
 * @param {unknown} contentAssets
 * @returns {{ enabled: boolean, has(p: string): boolean }}
 */
function createAssetIndex(staticFiles, contentAssets) {
  const enabled = staticFiles !== undefined && staticFiles !== null;
  /** @type {Set<string>} */
  const set = new Set();
  for (const source of [staticFiles, contentAssets]) {
    if (!source || typeof source[Symbol.iterator] !== 'function' || typeof source === 'string') continue;
    for (const item of /** @type {Iterable<any>} */ (source)) {
      const value = Array.isArray(item) ? item[0] : item;
      if (typeof value !== 'string') continue;
      set.add(value.replace(/^\.?\/+/, ''));
    }
  }
  return {
    enabled,
    has(p) {
      const key = String(p).replace(/^\.?\/+/, '');
      if (set.has(key)) return true;
      // Percent-encoded spaces are common in image paths copied from a file manager.
      try {
        return set.has(decodeURIComponent(key));
      } catch {
        return false;
      }
    },
  };
}

/* ------------------------------------------------------------------ anchors */

const ID_ATTR = /\bid=(?:"([^"]*)"|'([^']*)')/g;

/**
 * Anchor ids available on each page: heading slugs plus any explicit `id=` in the emitted
 * HTML, so hand-written `<h2 id="pins">` and footnote ids resolve too.
 *
 * @param {Map<string, any>} renderedMap
 * @param {unknown} anchorsByRoute
 * @param {import('./scan.js').PageSource[]} pages
 * @returns {Map<string, Set<string>>}
 */
function collectAnchors(renderedMap, anchorsByRoute, pages) {
  /** @type {Map<string, Set<string>>} */
  const anchors = new Map();
  const ensure = (route) => {
    const key = normalizeRoute(route);
    let set = anchors.get(key);
    if (!set) {
      set = new Set();
      anchors.set(key, set);
    }
    return set;
  };

  const supplied = toKeyedMap(anchorsByRoute);
  for (const [route, value] of supplied) {
    const set = ensure(route);
    for (const id of asArray(value)) {
      if (typeof id === 'string') set.add(id);
      else if (id && typeof id.id === 'string') set.add(id.id);
    }
  }

  for (const page of pages) {
    const entry = renderedMap.get(normalizeRoute(page.route)) || renderedMap.get(page.file);
    if (!entry) continue;
    const set = ensure(page.route);
    for (const heading of asArray(entry.headings)) {
      if (heading && typeof heading.id === 'string' && heading.id) set.add(heading.id);
    }
    if (typeof entry.html === 'string' && entry.html.length < 4_000_000) {
      ID_ATTR.lastIndex = 0;
      let match;
      while ((match = ID_ATTR.exec(entry.html)) !== null) {
        const id = match[1] ?? match[2] ?? '';
        if (id) set.add(id);
        if (ID_ATTR.lastIndex <= match.index) ID_ATTR.lastIndex = match.index + 1;
      }
    }
  }

  return anchors;
}

/**
 * @param {ReturnType<typeof createBag>} bag
 * @param {{ url: string, line?: number, column?: number }} link
 * @param {string} hash leading `#` included
 * @param {Set<string>|undefined} set
 * @param {string} route
 * @param {boolean} samePage
 */
function checkAnchor(bag, link, hash, set, route, samePage) {
  if (!set || set.size === 0) return;
  const id = hash.slice(1);
  if (!id) return;
  if (set.has(id)) return;
  let decoded = id;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    decoded = id;
  }
  if (set.has(decoded)) return;

  const where = samePage ? 'this page' : `\`${route}\``;
  const lower = [...set].find((candidate) => candidate.toLowerCase() === decoded.toLowerCase());
  bag.add('MD045', link,
    `anchor \`#${id}\` does not exist on ${where}`,
    lower
      ? `Anchors are case-sensitive -- did you mean \`#${lower}\`?`
      : 'Heading ids are slugified: lowercase, punctuation removed, spaces become dashes.');
}

/* ------------------------------------------------------------------ helpers */

/**
 * @param {unknown} value
 * @returns {any[]}
 */
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  return [];
}

/**
 * Accept a Map, a plain object or an array of `{ route }` records.
 * @param {unknown} value
 * @returns {Map<string, any>}
 */
function toKeyedMap(value) {
  if (value instanceof Map) {
    const out = new Map();
    for (const [key, entry] of value) {
      out.set(typeof key === 'string' && key.startsWith('/') ? normalizeRoute(key) : key, entry);
    }
    return out;
  }
  if (Array.isArray(value) || value instanceof Set) {
    const out = new Map();
    for (const entry of asArray(value)) {
      if (typeof entry === 'string') {
        if (entry.startsWith('/')) out.set(normalizeRoute(entry), null);
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.route === 'string') out.set(normalizeRoute(entry.route), entry);
      if (typeof entry.file === 'string') out.set(entry.file, entry);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out = new Map();
    for (const [key, entry] of Object.entries(value)) {
      out.set(key.startsWith('/') ? normalizeRoute(key) : key, entry);
    }
    return out;
  }
  return new Map();
}
