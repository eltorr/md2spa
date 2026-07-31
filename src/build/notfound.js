/**
 * `404.html` -- the one document that cannot know where it is.
 *
 * Every other page is written to a known route, so its depth is a build-time constant and
 * `url()` can emit correct relative paths. Not this one: a host serves `404.html` for
 * `/anything/at/all/`, and with `base: "auto"` there is no absolute prefix to fall back on.
 * A stylesheet link of `../../assets/style.css` would be wrong for almost every request.
 *
 * So this page defers its URLs to runtime. `theme/bootstrap.js` owns the recovery script
 * (`SPA_FALLBACK_SOURCE`, re-exported here); the build's job is to hand it the two globals
 * it needs -- the full route list and the configured base -- and to tag every URL it could
 * not resolve at build time:
 *
 *   `data-md2spa-asset="assets/style.abc12345.css"`  on `<link>` / `<img>` / `<script>`
 *   `data-md2spa-route="/guide/"`                    on `<a>`
 *
 * The script finds the longest known-route suffix of `location.pathname`, subtracts it to
 * get the site base, then fills those attributes in (SPEC.md section 3, final paragraph).
 * Static `href`s are still emitted assuming the site root, so a root-served 404 is fully
 * styled and navigable with JavaScript disabled.
 *
 * @module build/notfound
 */

import { escapeAttr, escapeHtml } from '../util/html.js';
import { normalizeRoute, routeSegments } from '../util/path.js';
import { createUrlResolver, renderFooter, renderSearchModal } from './layout.js';
import { SPA_FALLBACK_SOURCE, renderSpaFallback } from '../theme/bootstrap.js';
import { INLINE_SCRIPT_ATTR } from './verify.js';

export { SPA_FALLBACK_SOURCE };

/**
 * Routes embedded in the page. Every real deployment prefix is recognisable from far
 * fewer than this; the cap simply stops a 5000-page site inflating its own 404.
 */
const MAX_EMBEDDED_ROUTES = 500;

/**
 * @typedef {Object} NotFoundContext
 * @property {object} config                        normalised config
 * @property {string[]} routes                      every published route, for base recovery
 * @property {{css: string, js: string}} [assets]   absolute site paths
 * @property {Set<string>|null} [indexRoutes]
 * @property {Array<{title: string, route: string}>} [sections] top-level links to offer
 */

/**
 * Render `404.html`.
 * @param {NotFoundContext} ctx
 * @returns {string}
 */
export function render404(ctx) {
  const config = ctx.config || {};
  const siteTitle = config.title || 'Documentation';
  const cleanUrls = config.cleanUrls !== false;

  // Depth 0: static hrefs assume the site root, and the bootstrap corrects them elsewhere.
  const url = createUrlResolver({
    base: config.base ?? 'auto',
    depth: 0,
    cleanUrls,
    indexRoutes: ctx.indexRoutes ?? null,
    siteUrl: '',
  });

  // Longest first, so the runtime suffix match settles on the most specific route early.
  const routes = [...new Set(
    (Array.isArray(ctx.routes) ? ctx.routes : []).map((r) => normalizeRoute(r)),
  )]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .slice(0, MAX_EMBEDDED_ROUTES);

  const fallback = renderSpaFallback({ routes, base: config.base ?? 'auto' });

  /**
   * Emit an asset reference the runtime can re-point. `href` is the root-relative guess
   * that keeps a JavaScript-less, root-served 404 working.
   * @param {string} sitePath
   * @returns {string}
   */
  const assetAttr = (sitePath) => ` data-md2spa-asset="${escapeAttr(sitePath.replace(/^\/+/, ''))}"`;

  const stylesheet = ctx.assets?.css
    ? `<link rel="stylesheet" href="${escapeAttr(url(ctx.assets.css))}"${assetAttr(url.sitePath(ctx.assets.css))}>`
    : '';
  const appScript = ctx.assets?.js && config.spa !== false
    ? `<script ${INLINE_SCRIPT_ATTR}${assetAttr(url.sitePath(ctx.assets.js))}></script>`
    : '';

  const sections = (Array.isArray(ctx.sections) ? ctx.sections : [])
    .filter((s) => s && s.route)
    .slice(0, 12);
  const sectionList = sections.length
    ? `<ul>${sections.map((s) => {
      const route = normalizeRoute(s.route);
      return `<li><a href="${escapeAttr(url(route))}" data-md2spa-route="${escapeAttr(route)}">`
        + `${escapeHtml(s.title || route)}</a></li>`;
    }).join('')}</ul>`
    : '';

  const search = config.search === false ? ''
    : '<p><button class="search-trigger" type="button" aria-label="Search the docs" '
      + 'aria-keyshortcuts="Control+K /"><span>Search the docs</span><kbd>/</kbd></button></p>';

  return '<!doctype html>\n'
    + `<html lang="${escapeAttr(config.lang || 'en')}" data-depth="0" `
    + `data-base="${escapeAttr(config.base === 'auto' || !config.base ? 'auto' : config.base)}" `
    + `data-theme-default="${escapeAttr(config.theme?.defaultMode || 'auto')}">\n`
    + '<head>'
    + '<meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>Page not found — ${escapeHtml(siteTitle)}</title>`
    + '<meta name="robots" content="noindex,follow">'
    + '<meta name="generator" content="md2spa">'
    // Runs before the stylesheet link so the theme and the base are settled before paint.
    + `<script ${INLINE_SCRIPT_ATTR}>${fallback}</script>`
    + stylesheet
    + appScript
    + '</head>\n'
    + '<body data-route="/404/" data-404="1">'
    + '<a class="skip-link" href="#md-content">Skip to content</a>'
    + '<header class="topbar"><div class="topbar__inner">'
    + `<a class="brand" href="${escapeAttr(url('/'))}" data-md2spa-route="/">`
    + `<span class="brand__title">${escapeHtml(siteTitle)}</span></a>`
    + '<div class="topbar__actions">'
    + (config.search === false ? ''
      : '<button class="search-trigger" type="button" aria-label="Search the docs" '
        + 'aria-keyshortcuts="Control+K /"><span class="search-trigger__label">Search</span>'
        + '<kbd class="search-trigger__key">/</kbd></button>')
    + '<button class="theme-toggle" type="button" aria-label="Switch colour theme" aria-live="polite"></button>'
    + '</div></div></header>'
    + '<div class="layout">'
    + '<main class="content" id="md-content" tabindex="-1">'
    + '<article class="md">'
    + '<h1 id="page-not-found">Page not found</h1>'
    + '<p>The page you asked for does not exist, or it has moved. '
    + `<a href="${escapeAttr(url('/'))}" data-md2spa-route="/">Go to the home page</a>.</p>`
    + search
    + (sectionList ? `<h2 id="sections">Sections</h2>${sectionList}` : '')
    + '</article>'
    + '</main>'
    + '</div>'
    + renderFooter(config, url)
    + renderSearchModal(config)
    + '<div class="sr-only" aria-live="polite" id="md-announcer"></div>'
    + '</body>\n</html>\n';
}

/**
 * Top-level sections to offer as recovery links, derived from the site's routes.
 * @param {Iterable<string>} routes
 * @param {Map<string, string>|null} [titles] route -> title
 * @returns {Array<{title: string, route: string}>}
 */
export function sectionsFromRoutes(routes, titles = null) {
  const out = [];
  for (const raw of routes) {
    const route = normalizeRoute(raw);
    const segments = routeSegments(route);
    if (segments.length !== 1) continue;
    out.push({ route, title: titles?.get(route) || segments[0] });
  }
  return out.sort((a, b) => (a.route < b.route ? -1 : 1));
}
