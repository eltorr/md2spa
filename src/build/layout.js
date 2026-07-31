/**
 * The page shell -- every byte of HTML that surrounds the rendered Markdown.
 *
 * The whole of SPEC.md section 3 ("deploy anywhere") lives or dies here: **no URL is ever
 * written by hand in this file**. Every href, src, canonical and payload path goes through
 * the single resolver returned by `createUrlResolver()`, which is the only code that knows
 * whether the site is emitting document-relative (`base: "auto"`), root-relative (`base: "/"`)
 * or prefixed (`base: "/project/"`) URLs. Add a new URL to the shell without routing it
 * through `url()` and the site silently breaks on GitLab Pages -- so don't.
 *
 * The markup is fixed by SPEC.md section 8b; the stylesheet targets those class names and
 * nothing else.
 *
 * @module build/layout
 */

import {
  depthOfRoute,
  isExternalUrl,
  normalizeRoute,
  relativeUrl,
  routeSegments,
  routeToDocDir,
  routeToPayloadPath,
  splitUrl,
} from '../util/path.js';
import { attrs, escapeAttr, escapeHtml } from '../util/html.js';
import { shortHash } from '../util/hash.js';
import { routeToSitePath } from '../content/route.js';
import { BOOTSTRAP_SOURCE } from '../theme/bootstrap.js';
import { INLINE_SCRIPT_ATTR } from './verify.js';

/** Separator between page title and site title. */
const TITLE_SEPARATOR = ' — ';

/**
 * A tiny document-coloured favicon, inlined so a site with no configured icon does not
 * emit a 404 for `/favicon.ico` on every page view.
 * @param {string} accent
 * @returns {string} data: URL
 */
function defaultFavicon(accent) {
  const fill = /^#[0-9a-fA-F]{3,8}$/.test(String(accent)) ? String(accent) : '#5b5bd6';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + `<rect width="32" height="32" rx="7" fill="${fill}"/>`
    + '<path d="M8 23V9h4l4 6 4-6h4v14h-4v-7l-4 6-4-6v7z" fill="#fff"/></svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Build the one URL helper the whole shell uses.
 *
 * Input is always an **absolute site path** (`/guide/install/`, `/assets/app.1a2b3c4d.js`).
 * Fragments, queries, external URLs and already-relative paths pass through untouched.
 *
 * A trailing slash marks a *route*; that is what lets `cleanUrls: false` rewrite
 * `/guide/install/` to `guide/install.html` while leaving section indexes
 * (`/guide/` -> `guide/index.html`) alone so their children still resolve.
 *
 * @param {{ base?: string, depth?: number, docDir?: string|null, cleanUrls?: boolean,
 *           indexRoutes?: Set<string>|null, siteUrl?: string }} [options]
 * @returns {((target: string) => string) & {
 *            sitePath: (target: string) => string,
 *            absolute: (target: string) => string,
 *            depth: number }}
 */
export function createUrlResolver(options = {}) {
  const {
    base = 'auto',
    depth = 0,
    docDir = null,
    cleanUrls = true,
    indexRoutes = null,
    siteUrl = '',
  } = options;

  // Knowing where the document sits -- not merely how deep it is -- lets relativeUrl drop
  // the shared prefix, so a link to an ancestor climbs to it instead of via the site root.
  const origin_ = docDir === null ? depth : docDir;

  // `null` means "document-relative"; otherwise it is the prefix to glue in front.
  const prefix = base === 'auto' ? null : (base === '/' ? '' : String(base).replace(/\/+$/, ''));
  const origin = String(siteUrl || '').replace(/\/+$/, '');

  /**
   * Absolute site path after the cleanUrls transformation, or `null` when the target is
   * not a site path at all (external, fragment-only, already relative).
   * @param {string} raw
   * @returns {{ path: string, query: string, hash: string }|null}
   */
  const parse = (raw) => {
    const target = raw === null || raw === undefined ? '' : String(raw);
    if (target === '') return null;
    if (target.startsWith('#') || target.startsWith('?')) return null;
    if (isExternalUrl(target)) return null;
    const { path, query, hash } = splitUrl(target);
    if (!path.startsWith('/')) return null;

    // A trailing slash marks a route, which is the only thing `cleanUrls` rewrites.
    const site = path.endsWith('/')
      ? routeToSitePath(path, { cleanUrls, isIndex: indexRoutes ? indexRoutes.has(path) : false })
      : path;
    return { path: site, query, hash };
  };

  /**
   * @param {string} target
   * @returns {string}
   */
  const url = (target) => {
    const parsed = parse(target);
    if (!parsed) return target === null || target === undefined ? '' : String(target);
    const head = prefix === null ? relativeUrl(origin_, parsed.path) : `${prefix}${parsed.path}`;
    return `${head}${parsed.query}${parsed.hash}`;
  };

  url.sitePath = (target) => {
    const parsed = parse(target);
    if (!parsed) return target === null || target === undefined ? '' : String(target);
    return `${parsed.path}${parsed.query}${parsed.hash}`;
  };

  url.absolute = (target) => {
    const parsed = parse(target);
    if (!parsed) return target === null || target === undefined ? '' : String(target);
    if (!origin) return url(target);
    return `${origin}${parsed.path}${parsed.query}${parsed.hash}`;
  };

  url.depth = depth;
  return url;
}

/**
 * Every ancestor route of `route`, root first, excluding the route itself.
 * @param {string} route
 * @returns {string[]}
 */
function ancestorRoutes(route) {
  const segments = routeSegments(route);
  const out = ['/'];
  let acc = '';
  for (let i = 0; i < segments.length - 1; i += 1) {
    acc += `/${segments[i]}`;
    out.push(`${acc}/`);
  }
  return out;
}

/**
 * Render the sidebar navigation.
 *
 * Groups are native `<details>/<summary>` so the tree expands and collapses with
 * JavaScript disabled; `app.js` adds arrow-key movement on top.
 *
 * Deliberately *not* `role="tree"`. That pattern demands `treeitem` children, forbids
 * interactive descendants (which rules out the `<a>` inside each `<summary>`), and brings
 * a roving tabindex that pulls every link but one out of the tab order. A nav landmark
 * wrapping nested lists is what assistive technology handles best here, and it keeps all
 * links reachable by Tab. `data-depth` and the `--nav-depth` custom property both carry the nesting
 * level -- the attribute so the stylesheet works under a strict `style-src` CSP, the
 * property so a stylesheet can use plain arithmetic.
 *
 * @param {Array<object>} tree NavNode[]
 * @param {string} activeRoute
 * @param {object} config
 * @param {(target: string) => string} url
 * @returns {string}
 */
export function renderNavTree(tree, activeRoute, config, url) {
  const nodes = Array.isArray(tree) ? tree : [];
  if (nodes.length === 0) return '';

  const active = normalizeRoute(activeRoute || '/');
  const ancestors = new Set(ancestorRoutes(active));
  const collapseDepth = Number(config?.nav?.collapseDepth ?? 1);

  /**
   * @param {object} node
   * @param {number} depth
   * @returns {string}
   */
  const renderNode = (node, depth) => {
    const title = escapeHtml(node?.title ?? '');
    const route = node?.route ? normalizeRoute(node.route) : null;
    const children = Array.isArray(node?.children) ? node.children : [];
    const isActive = route !== null && route === active;
    const isAncestor = route !== null && !isActive && ancestors.has(route);
    const nesting = ` data-depth="${depth}" style="--nav-depth:${depth}"`;
    // Drafts only reach the tree when the dev server asks for them; the stylesheet badges
    // them off `data-draft` so a work-in-progress page is never mistaken for a shipped one.
    const draft = node?.draft ? ' data-draft="true"' : '';

    const linkClass = ['nav-link',
      isActive ? 'nav-link--active' : null,
      isAncestor ? 'nav-link--ancestor' : null].filter(Boolean).join(' ');

    if (children.length === 0) {
      if (route === null) return '';
      return `<li><a class="${linkClass}" href="${escapeAttr(url(route))}"${nesting}${draft}`
        + `${isActive ? ' aria-current="page"' : ''}>${title}</a></li>`;
    }

    // A group is open when it is on the active path, when the config says shallow groups
    // start open, or when `_meta.json` pins it open.
    const containsActive = isActive || isAncestor
      || children.some(function contains(child) {
        const childRoute = child?.route ? normalizeRoute(child.route) : null;
        if (childRoute && (childRoute === active || ancestors.has(childRoute))) return true;
        return Array.isArray(child?.children) && child.children.some(contains);
      });
    // `nav.js` has already folded `nav.collapseDepth` into `node.collapsed`, and a folder's
    // `_meta.json` may override it -- so an explicit boolean always wins over the default.
    const open = containsActive
      || (typeof node?.collapsed === 'boolean' ? !node.collapsed : depth < collapseDepth);

    const label = route === null
      ? title
      : `<a class="${linkClass}" href="${escapeAttr(url(route))}"${draft}`
        + `${isActive ? ' aria-current="page"' : ''}>${title}</a>`;

    const inner = children.map((child) => renderNode(child, depth + 1)).join('');

    return `<li><details class="nav-group"${open ? ' open' : ''}${nesting}>`
      + `<summary class="nav-group__toggle" aria-expanded="${open ? 'true' : 'false'}">`
      + '<span class="nav-group__chevron" aria-hidden="true"></span>'
      + `${label}</summary>`
      + `<ul class="nav-group__list">${inner}</ul>`
      + '</details></li>';
  };

  const items = nodes.map((node) => renderNode(node, 0)).join('');
  if (!items) return '';
  return '<nav class="nav-tree" aria-label="Documentation">'
    + `<ul class="nav-group__list">${items}</ul></nav>`;
}

/**
 * Render the right-hand "on this page" table of contents.
 * @param {Array<object>} toc nested TocItem[]
 * @param {object} config
 * @returns {string} empty string when there is nothing worth showing
 */
export function renderToc(toc, config) {
  const items = Array.isArray(toc) ? toc : [];
  const minDepth = Number(config?.toc?.minDepth ?? 2);
  const maxDepth = Number(config?.toc?.maxDepth ?? 3);

  /**
   * @param {Array<object>} list
   * @returns {string}
   */
  const renderList = (list) => {
    const rendered = list
      .filter((item) => item && item.depth >= minDepth && item.depth <= maxDepth)
      .map((item) => {
        const children = Array.isArray(item.children) ? renderList(item.children) : '';
        return `<li><a class="toc__link" href="#${escapeAttr(item.id)}" `
          + `data-depth="${item.depth}" style="--toc-depth:${item.depth}">`
          + `${escapeHtml(item.text ?? '')}</a>${children}</li>`;
      })
      .join('');
    return rendered ? `<ol class="toc__list">${rendered}</ol>` : '';
  };

  // A depth-1 wrapper (the page H1) is common; flatten it away before filtering.
  const flattened = items.length === 1 && items[0]?.depth === 1 && Array.isArray(items[0].children)
    ? items[0].children
    : items;

  const list = renderList(flattened);
  if (!list) return '';
  return '<aside class="toc" aria-label="On this page">'
    + '<p class="toc__title">On this page</p>'
    + `${list}</aside>`;
}

/**
 * Render the breadcrumb trail. `crumbs` holds the page's *ancestors* only (SPEC 7), so the
 * current page is appended here as a non-link `aria-current` item. Returns `''` when there
 * are no ancestors -- on the home page a lone crumb is noise.
 *
 * @param {Array<{title: string, route: string|null}>} crumbs
 * @param {(target: string) => string} url
 * @param {string} [currentTitle] title of the page being rendered
 * @returns {string}
 */
export function renderBreadcrumbs(crumbs, url, currentTitle) {
  const list = Array.isArray(crumbs) ? crumbs.filter(Boolean) : [];
  if (!list.length) return '';

  const items = list.map((crumb) => {
    const title = escapeHtml(crumb.title ?? '');
    if (!crumb.route) return `<li class="breadcrumbs__item">${title}</li>`;
    return `<li class="breadcrumbs__item">`
      + `<a class="breadcrumbs__link" href="${escapeAttr(url(crumb.route))}">${title}</a></li>`;
  });

  const current = String(currentTitle ?? '').trim();
  if (current) {
    items.push('<li class="breadcrumbs__item" aria-current="page">'
      + `${escapeHtml(current)}</li>`);
  }

  return '<nav class="breadcrumbs" aria-label="Breadcrumb">'
    + `<ol class="breadcrumbs__list">${items.join('')}</ol></nav>`;
}

/**
 * Render the previous/next page links.
 * @param {{title: string, route: string}|null} prev
 * @param {{title: string, route: string}|null} next
 * @param {(target: string) => string} url
 * @returns {string}
 */
export function renderPageNav(prev, next, url) {
  if (!prev && !next) return '';
  const link = (page, kind, label) => {
    if (!page || !page.route) return '';
    return `<a class="page-nav__${kind}" href="${escapeAttr(url(page.route))}" rel="${kind}">`
      + `<span class="page-nav__label">${label}</span>`
      + `<span class="page-nav__title">${escapeHtml(page.title ?? '')}</span></a>`;
  };
  return '<nav class="page-nav" aria-label="Previous and next page">'
    + `${link(prev, 'prev', 'Previous')}${link(next, 'next', 'Next')}</nav>`;
}

/**
 * Render the site footer.
 * @param {object} config
 * @param {(target: string) => string} url
 * @returns {string}
 */
export function renderFooter(config, url) {
  const text = config?.footer?.text ? `<p class="site-footer__text">${escapeHtml(config.footer.text)}</p>` : '';
  const links = Array.isArray(config?.footer?.links) ? config.footer.links : [];
  const linkHtml = links.length
    ? `<ul class="site-footer__links">${links.map((l) => {
      const href = isExternalUrl(l.url) ? l.url : url(l.url);
      const external = isExternalUrl(l.url)
        ? ' rel="noopener noreferrer external" target="_blank"' : '';
      return `<li><a href="${escapeAttr(href)}"${external}>${escapeHtml(l.label)}</a></li>`;
    }).join('')}</ul>`
    : '';
  const date = config?.buildDate
    ? `<p class="site-footer__date">Updated ${escapeHtml(String(config.buildDate))}</p>`
    : '';
  if (!text && !linkHtml && !date) return '';
  return '<footer class="site-footer">'
    + `<div class="site-footer__inner">${text}${linkHtml}${date}</div></footer>`;
}

/**
 * The search overlay + modal. Inert markup; `app.js` wires it up and it is simply
 * never shown when JavaScript is unavailable.
 * @param {object} config
 * @returns {string}
 */
export function renderSearchModal(config) {
  if (config?.search === false) return '';
  return '<div class="overlay" hidden></div>'
    + '<div class="search-modal" hidden role="dialog" aria-modal="true" aria-label="Search">'
    + '<div class="search-modal__panel">'
    + '<input class="search-input" type="search" autocomplete="off" spellcheck="false" '
    + 'placeholder="Search the docs" aria-label="Search the docs" aria-controls="md-search-results">'
    + '<div class="search-results" id="md-search-results" role="listbox" aria-label="Search results"></div>'
    + '</div></div>';
}

/**
 * @param {object} config
 * @param {(target: string) => string} url
 * @returns {string}
 */
function renderTopbar(config, url) {
  const logoSrc = config?.theme?.logo
    ? escapeAttr(url(`/${String(config.theme.logo).replace(/^\/+/, '')}`))
    : '';
  // alt="" -- the adjacent site title already names the link, so the logo is decorative.
  const logo = logoSrc
    ? `<img class="brand__logo" src="${logoSrc}" alt="" width="28" height="28" decoding="async">`
    : '';
  const repo = config?.repo?.url
    ? `<a class="repo-link" href="${escapeAttr(config.repo.url)}" rel="noopener noreferrer external" target="_blank">`
      + `<span class="repo-link__label">${escapeHtml(config.repo.label || 'Source')}</span></a>`
    : '';
  const search = config?.search === false ? ''
    : '<button class="search-trigger" type="button" aria-label="Search the docs" '
      + 'aria-keyshortcuts="Control+K /"><span class="search-trigger__label">Search</span>'
      + '<kbd class="search-trigger__key">/</kbd></button>';

  return '<header class="topbar"><div class="topbar__inner">'
    + `<a class="brand" href="${escapeAttr(url('/'))}">${logo}`
    + `<span class="brand__title">${escapeHtml(config?.title ?? 'Documentation')}</span></a>`
    + '<div class="topbar__actions">'
    + search
    + '<button class="theme-toggle" type="button" aria-label="Switch colour theme" aria-live="polite"></button>'
    + repo
    + '<button class="nav-toggle" type="button" aria-label="Toggle navigation" '
    + 'aria-expanded="false" aria-controls="md-sidebar"></button>'
    + '</div></div></header>';
}

/**
 * @param {import('./layout.js').ShellContext} ctx
 * @param {(target: string) => string} url
 * @returns {string}
 */
function renderHead(ctx, url) {
  const config = ctx.config || {};
  const siteTitle = config.title || 'Documentation';
  const pageTitle = ctx.isHome || !ctx.title || ctx.title === siteTitle
    ? siteTitle
    : `${ctx.title}${TITLE_SEPARATOR}${siteTitle}`;
  const description = ctx.description || config.description || '';

  const out = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(pageTitle)}</title>`,
  ];

  if (description) out.push(`<meta name="description" content="${escapeAttr(description)}">`);
  out.push('<meta name="generator" content="md2spa">');
  if (ctx.noindex) out.push('<meta name="robots" content="noindex,follow">');

  if (config.siteUrl) {
    const canonical = url.absolute(ctx.route || '/');
    out.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`);
    out.push(`<meta property="og:type" content="${ctx.isHome ? 'website' : 'article'}">`);
    out.push(`<meta property="og:title" content="${escapeAttr(ctx.title || siteTitle)}">`);
    if (description) out.push(`<meta property="og:description" content="${escapeAttr(description)}">`);
    out.push(`<meta property="og:url" content="${escapeAttr(canonical)}">`);
    out.push(`<meta property="og:site_name" content="${escapeAttr(siteTitle)}">`);
    if (config.lang) out.push(`<meta property="og:locale" content="${escapeAttr(config.lang)}">`);

    const image = config.theme?.logo
      ? url.absolute(`/${String(config.theme.logo).replace(/^\/+/, '')}`)
      : '';
    if (image) out.push(`<meta property="og:image" content="${escapeAttr(image)}">`);
    out.push(`<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`);
    out.push(`<meta name="twitter:title" content="${escapeAttr(ctx.title || siteTitle)}">`);
    if (description) out.push(`<meta name="twitter:description" content="${escapeAttr(description)}">`);
    if (image) out.push(`<meta name="twitter:image" content="${escapeAttr(image)}">`);
  }

  const favicon = config.theme?.favicon
    ? url(`/${String(config.theme.favicon).replace(/^\/+/, '')}`)
    : defaultFavicon(config.theme?.accent);
  const faviconType = /\.svg$/i.test(favicon) ? 'image/svg+xml'
    : favicon.startsWith('data:image/svg+xml') ? 'image/svg+xml'
      : /\.png$/i.test(favicon) ? 'image/png' : null;
  out.push(`<link rel="icon"${faviconType ? ` type="${faviconType}"` : ''} href="${escapeAttr(favicon)}">`);

  // Inline, render-blocking on purpose: it applies the stored theme before first paint.
  out.push(`<script ${INLINE_SCRIPT_ATTR}>${BOOTSTRAP_SOURCE}</script>`);

  if (ctx.assets?.css) {
    out.push(`<link rel="stylesheet" href="${escapeAttr(url(ctx.assets.css))}">`);
  }
  if (ctx.headExtra) out.push(ctx.headExtra);

  return out.join('');
}

/**
 * @typedef {Object} ShellContext
 * @property {object} config             normalised config
 * @property {string} route              '/guide/install/'
 * @property {string} title              page title (without the site suffix)
 * @property {string} [description]
 * @property {string} html               `<article>` inner HTML from renderHtml()
 * @property {Array<object>} [toc]
 * @property {Array<object>} [navTree]
 * @property {Array<object>} [crumbs]
 * @property {{title: string, route: string}|null} [prev]
 * @property {{title: string, route: string}|null} [next]
 * @property {string|null} [editUrl]
 * @property {{css: string, js: string}} [assets] absolute site paths
 * @property {number} [depth]            document depth; derived from the route when absent
 * @property {boolean} [isIndex]
 * @property {Set<string>|null} [indexRoutes]
 * @property {boolean} [isHome]
 * @property {boolean} [noindex]
 * @property {string} [hash]
 * @property {string} [headExtra]        raw HTML appended to <head> (dev server only)
 * @property {string} [bodyExtra]        raw HTML appended to <body> (dev server only)
 * @property {((target: string) => string)} [url] pre-built resolver; created when absent
 */

/**
 * Render one complete HTML document.
 * @param {ShellContext} ctx
 * @returns {string}
 */
export function renderPageShell(ctx) {
  const config = ctx.config || {};
  const route = normalizeRoute(ctx.route || '/');
  const cleanUrls = config.cleanUrls !== false;
  const isIndex = ctx.isIndex ?? (ctx.indexRoutes ? ctx.indexRoutes.has(route) : route === '/');
  const depth = ctx.depth ?? depthOfRoute(route, { cleanUrls, isIndex });
  const url = ctx.url || createUrlResolver({
    base: config.base ?? 'auto',
    depth,
    docDir: routeToDocDir(route, { cleanUrls, isIndex }),
    cleanUrls,
    indexRoutes: ctx.indexRoutes ?? null,
    siteUrl: config.siteUrl ?? '',
  });

  const isHome = ctx.isHome ?? (route === '/');
  const navTree = renderNavTree(ctx.navTree, route, config, url);
  const filter = config.nav?.filter === false || !navTree ? ''
    : '<input class="sidebar__filter" type="search" autocomplete="off" spellcheck="false" '
      + 'placeholder="Filter pages" aria-label="Filter navigation" aria-controls="md-nav-tree">';

  const sidebar = navTree
    ? '<aside class="sidebar" id="md-sidebar">'
      + `<div class="sidebar__inner" id="md-nav-tree">${filter}${navTree}</div></aside>`
    : '';

  const edit = ctx.editUrl
    ? `<a class="edit-link" href="${escapeAttr(ctx.editUrl)}" `
      + 'rel="noopener noreferrer external" target="_blank">Edit this page</a>'
    : '';
  const pageNav = renderPageNav(ctx.prev, ctx.next, url);
  const pageMeta = edit || pageNav ? `<div class="page-meta">${edit}${pageNav}</div>` : '';

  const bodyAttrs = attrs({
    'data-route': route,
    'data-payload': config.spa === false ? null : url(`/${routeToPayloadPath(route)}`),
    'data-spa': config.spa === false ? null : '1',
    'data-search': config.search === false ? null : url('/search-index.json'),
    'data-site-root': url('/'),
  });

  const script = ctx.assets?.js
    ? `<script type="module" src="${escapeAttr(url(ctx.assets.js))}"></script>`
    : '';

  return '<!doctype html>\n'
    + `<html${attrs({
      lang: config.lang || 'en',
      'data-depth': String(depth),
      'data-base': config.base === 'auto' || !config.base ? 'auto' : config.base,
      'data-theme-default': config.theme?.defaultMode || 'auto',
      // Payloads carry only the page title, so the router has to rebuild `Page — Site`.
      // Stating the suffix here beats inferring it from the served <title>: the home page
      // renders as bare `Site`, so inference yields an empty suffix and every page the
      // router then navigates to would lose the site name from its tab.
      'data-title-suffix': config.title ? ` — ${config.title}` : '',
    })}>\n`
    + `<head>${renderHead(ctx, url)}</head>\n`
    + `<body${bodyAttrs}>`
    + '<a class="skip-link" href="#md-content">Skip to content</a>'
    + renderTopbar(config, url)
    + '<div class="progress-bar" hidden></div>'
    + '<div class="layout">'
    + sidebar
    + '<main class="content" id="md-content" tabindex="-1">'
    + renderBreadcrumbs(ctx.crumbs, url, ctx.navTitle || ctx.title)
    + `<article class="md">${ctx.html || ''}</article>`
    + pageMeta
    + '</main>'
    + renderToc(ctx.toc, config)
    + '</div>'
    + renderFooter(config, url)
    + renderSearchModal(config)
    + '<div class="sr-only" aria-live="polite" id="md-announcer"></div>'
    + script
    + (ctx.bodyExtra || '')
    + '</body>\n</html>\n';
}

/**
 * Build the SPA payload for a route (SPEC.md section 7).
 * Routes stay absolute here -- `app.js` resolves them against the runtime site base.
 *
 * @param {ShellContext} ctx
 * @returns {{ route: string, title: string, description: string, html: string,
 *             toc: Array<object>, crumbs: Array<object>,
 *             prev: object|null, next: object|null, editUrl: string|null, hash: string }}
 */
export function renderSpaPayload(ctx) {
  const route = normalizeRoute(ctx.route || '/');
  const html = `<article class="md">${ctx.html || ''}</article>`;
  const crumb = (c) => ({ title: c?.title ?? '', route: c?.route ? normalizeRoute(c.route) : null });
  const link = (p) => (p && p.route ? { title: p.title ?? '', route: normalizeRoute(p.route) } : null);

  return {
    route,
    title: ctx.title || ctx.config?.title || '',
    description: ctx.description || '',
    html,
    toc: Array.isArray(ctx.toc) ? ctx.toc : [],
    crumbs: Array.isArray(ctx.crumbs) ? ctx.crumbs.map(crumb) : [],
    prev: link(ctx.prev),
    next: link(ctx.next),
    editUrl: ctx.editUrl || null,
    hash: ctx.hash || shortHash(html),
  };
}
