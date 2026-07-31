/**
 * The build orchestrator.
 *
 * Pipeline:
 *   scan -> parse -> nav -> render -> validate -> resolve links -> shell -> write -> verify
 *
 * Three invariants shape the code:
 *
 * 1. **One bad page never breaks the site.** Every per-page step is wrapped; a page that
 *    throws becomes an error placeholder carrying its own diagnostic and the build carries
 *    on. A docs build that dies on file 61 of 93 is useless in CI.
 * 2. **Every URL comes from a resolver.** Shell URLs go through
 *    `build/layout.js#createUrlResolver` (depth-aware), authored Markdown links through
 *    `content/links.js#createUrlResolver` (source-directory aware). Nothing concatenates
 *    a path by hand, which is what makes all three `base` modes work.
 * 3. **Link validation runs last.** Anchor checks need every page's heading ids, so
 *    `resolveLinks` cannot run until the final page has been rendered.
 *
 * @module build/build
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normalizeConfig, resolveDirs } from '../config.js';
import { RULES, compareDiagnostics } from '../markdown/diagnostics.js';
import { createSlugRegistry, slugify } from '../markdown/slug.js';
import { parseMarkdown } from '../markdown/parser.js';
import { renderHtml } from '../markdown/renderer.js';
import { validateDocument } from '../markdown/validate.js';
import { scanContent } from '../content/scan.js';
import { buildNav } from '../content/nav.js';
import { createUrlResolver as createLinkUrlResolver, resolveLinks } from '../content/links.js';
import { humanizeName } from '../content/route.js';
import { copyDirDeep, emptyDir, isDirectory, walkDir, writeFileDeep } from '../util/fs.js';
import { hashedName, shortHash } from '../util/hash.js';
import {
  depthOfRoute,
  routeToDocDir,
  normalizeRoute,
  routeSegments,
  routeToOutputPath,
  routeToPayloadPath,
  toPosix,
} from '../util/path.js';
import { escapeAttr, escapeHtml } from '../util/html.js';
import { createUrlResolver, renderPageShell, renderSpaPayload } from './layout.js';
import { buildSearchIndex, serializeSearchIndex } from './search.js';
import { buildRobots, buildSitemap } from './sitemap.js';
import { render404 } from './notfound.js';
import { verifyHtml } from './verify.js';

const THEME_DIR = fileURLToPath(new URL('../theme/', import.meta.url));

/** Replaced with the config-derived custom properties when the stylesheet declares it. */
const THEME_PLACEHOLDER = '/*__MD2SPA_THEME__*/';

/**
 * A failure that is ours, not the author's -- a module threw where it should have returned
 * diagnostics. Reported as HTM001 so it is fatal and impossible to miss.
 *
 * @param {string} file
 * @param {string} message
 * @param {string|null} [hint]
 * @param {string} [code]
 * @returns {import('../markdown/diagnostics.js').Diagnostic}
 */
function internalDiagnostic(file, message, hint = null, code = 'HTM001') {
  return {
    code,
    severity: RULES[code]?.severity ?? 'error',
    message,
    hint,
    file,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 2,
  };
}

/**
 * True when `parent` is `child` or an ancestor directory of it.
 * @param {string} parent absolute path
 * @param {string} child absolute path
 * @returns {boolean}
 */
function containsPath(parent, child) {
  const a = path.resolve(parent);
  const b = path.resolve(child);
  return a === b || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/**
 * Explain why `outDir` must not be emptied, or `null` when it is safe to wipe.
 *
 * The build clears `outDir` before writing, so an `outDir` that swallows the project
 * (`--out .`), the content tree or the static tree would destroy the very files it is
 * about to read.
 *
 * @param {string} cwd
 * @param {{ contentDir: string, outDir: string, staticDir: string }} dirs
 * @returns {string|null}
 */
function describeUnsafeOutDir(cwd, dirs) {
  const { outDir, contentDir, staticDir } = dirs;
  if (containsPath(outDir, cwd)) return 'is the project directory (or contains it)';
  if (containsPath(outDir, contentDir)) return 'contains `contentDir`';
  if (staticDir && isDirectory(staticDir) && containsPath(outDir, staticDir)) {
    return 'contains `staticDir`';
  }
  return null;
}

/**
 * Drop exact duplicates and sort. Several modules legitimately notice the same thing
 * (nav.js and the scanner both see a folder without an `index.md`).
 * @param {import('../markdown/diagnostics.js').Diagnostic[]} diagnostics
 * @returns {import('../markdown/diagnostics.js').Diagnostic[]}
 */
function dedupeDiagnostics(diagnostics) {
  const seen = new Set();
  const out = [];
  for (const d of diagnostics) {
    if (!d || !d.code) continue;
    const key = `${d.code}|${d.file}|${d.line}|${d.column}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out.sort(compareDiagnostics);
}

/**
 * First H1 in a document -- the title hint the nav needs before anything is rendered.
 * @param {object|null} ast
 * @returns {string|null}
 */
function firstH1(ast) {
  for (const node of Array.isArray(ast?.children) ? ast.children : []) {
    if (node?.type === 'heading' && node.depth === 1) {
      const text = typeof node.text === 'string' ? node.text.trim() : '';
      if (text) return text;
    }
  }
  return null;
}

/**
 * Read a theme asset, tolerating a missing file so the build degrades instead of dying.
 * @param {string} name
 * @param {{ warn?: (msg: string) => void }|null} logger
 * @returns {string}
 */
function readThemeAsset(name, logger) {
  try {
    return fs.readFileSync(path.join(THEME_DIR, name), 'utf8');
  } catch {
    logger?.warn?.(`theme asset ${name} is missing; the site is emitted without it`);
    return '';
  }
}

/**
 * `theme.diagram` keys and the custom property each one rebinds, in emission order.
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const DIAGRAM_VARIABLES = Object.freeze([
  ['nodeBg', '--dg-node-bg'],
  ['nodeBorder', '--dg-node-border'],
  ['nodeFg', '--dg-node-fg'],
  ['edge', '--dg-edge'],
  ['accent', '--dg-accent'],
  ['fontSize', '--dg-font-size'],
]);

/**
 * A config-supplied CSS value, reduced to something that cannot escape its declaration.
 *
 * The value lands inside a stylesheet the build signs its name to, so a stray `}` or `</style>`
 * would let a config file write arbitrary rules -- or arbitrary markup, once the sheet is
 * inlined. Everything that could end the declaration, the block or the element is dropped
 * rather than escaped: there is no legitimate colour or length that needs any of it.
 *
 * @param {unknown} raw
 * @returns {string} the sanitised value, or `''` when nothing usable is left
 */
function cssValue(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[;{}<>\\]/g, '')
    .replace(/\/\*|\*\//g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 200)
    .trim();
}

/**
 * Substitute the configurable custom properties into the stylesheet.
 *
 * The generated block replaces `THEME_PLACEHOLDER` when the sheet declares one, and is
 * otherwise appended: at equal specificity the later `:root` wins, and the dark-mode rules
 * live behind `[data-theme]` selectors, so they are untouched either way.
 *
 * @param {string} css
 * @param {object} config
 * @returns {string}
 */
export function applyThemeVariables(css, config) {
  const theme = config?.theme || {};
  const declarations = [];
  if (theme.accent) declarations.push(`  --accent: ${theme.accent};`);
  if (theme.font) declarations.push(`  --font-body: ${theme.font};`);
  if (theme.monoFont) declarations.push(`  --font-mono: ${theme.monoFont};`);

  const blocks = [];
  if (declarations.length) blocks.push(`:root {\n${declarations.join('\n')}\n}`);

  // The stylesheet sets its own `--accent` inside both dark selectors, so a bare `:root`
  // override is shadowed the moment dark mode applies. To make `theme.accentDark` mean
  // anything the override has to be repeated in the *same* two selectors the sheet uses,
  // at equal specificity but later in source order.
  if (theme.accentDark) {
    blocks.push(`:root[data-theme='dark'] {\n  --accent: ${theme.accentDark};\n}`);
    blocks.push(
      '@media (prefers-color-scheme: dark) {\n'
      + `  :root:not([data-theme='light']) {\n    --accent: ${theme.accentDark};\n  }\n}`,
    );
  }

  // `theme.diagram` rebinds the `--dg-*` palette the diagram stylesheet reads. The keys are
  // walked from a fixed list rather than from `Object.entries`, so the emitted CSS depends on
  // the config's *values* and never on its key order -- two builds of the same site have to be
  // byte-identical.
  const diagram = theme.diagram || {};
  const diagramDeclarations = [];
  for (const [key, property] of DIAGRAM_VARIABLES) {
    const value = cssValue(diagram[key]);
    if (value) diagramDeclarations.push(`  ${property}: ${value};`);
  }
  if (diagramDeclarations.length) {
    blocks.push(`.diagram {\n${diagramDeclarations.join('\n')}\n}`);
  }

  if (blocks.length === 0) return css.split(THEME_PLACEHOLDER).join('');

  const block = `${blocks.join('\n')}\n`;
  if (css.includes(THEME_PLACEHOLDER)) return css.split(THEME_PLACEHOLDER).join(block);
  return `${css}\n/* md2spa: config.theme */\n${block}`;
}

/**
 * Build a whole site.
 *
 * @param {{ cwd?: string, config?: object,
 *           logger?: { step?: Function, warn?: Function, error?: Function, dim?: Function }|null,
 *           includeDrafts?: boolean }} [options]
 * @returns {Promise<{ files: string[],
 *                     diagnostics: import('../markdown/diagnostics.js').Diagnostic[],
 *                     sources: Map<string, string>,
 *                     stats: { pages: number, assets: number, ms: number, bytes: number } }>}
 *   `files` are POSIX paths relative to `outDir`; `sources` maps each content file to its
 *   Markdown text so the reporter can print source excerpts.
 */
export async function buildSite(options = {}) {
  const {
    cwd = process.cwd(),
    config: rawConfig = {},
    logger = null,
    includeDrafts = false,
  } = options;

  const startedAt = process.hrtime.bigint();
  const config = normalizeConfig(rawConfig || {});
  const dirs = resolveDirs(cwd, config);

  /** @type {import('../markdown/diagnostics.js').Diagnostic[]} */
  const diagnostics = [];
  /** @type {string[]} */
  const files = [];
  /**
   * Source text per file. Not part of the SPEC 6 return shape, but `report.js` needs it to
   * print the excerpt and caret under each diagnostic, and the CLI and dev server both
   * read it optionally -- so it costs nothing and buys the pretty format.
   * @type {Map<string, string>}
   */
  const sources = new Map();
  let bytes = 0;
  let assets = 0;

  const finish = (pages) => ({
    files: files.slice().sort(),
    diagnostics: dedupeDiagnostics(diagnostics),
    sources,
    stats: {
      pages,
      assets,
      ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
      bytes,
    },
  });

  if (!isDirectory(dirs.contentDir)) {
    const rel = toPosix(path.relative(cwd, dirs.contentDir)) || config.contentDir;
    diagnostics.push(internalDiagnostic(
      rel,
      `content directory \`${config.contentDir}\` does not exist`,
      'Create it, set `contentDir` in md2spa.config.json, or run `md2spa init`.',
      'CFG003',
    ));
    logger?.error?.(`content directory not found: ${dirs.contentDir}`);
    return finish(0);
  }

  /**
   * @param {string} relative POSIX path under outDir
   * @param {string} content
   */
  const write = (relative, content) => {
    writeFileDeep(path.join(dirs.outDir, ...relative.split('/')), content);
    files.push(relative);
    bytes += Buffer.byteLength(content);
  };

  // `emptyDir` is about to delete everything under outDir. Its own guard only refuses
  // top-level paths, so `--out .` (or an outDir that contains the sources) would wipe the
  // project -- content, static assets, .git and all -- before a single page is rendered.
  const unsafeOutDir = describeUnsafeOutDir(cwd, dirs);
  if (unsafeOutDir) {
    diagnostics.push(internalDiagnostic(
      toPosix(path.relative(cwd, dirs.outDir)) || config.outDir,
      `refusing to build: \`outDir\` ${unsafeOutDir}`,
      'Point `outDir` at a dedicated directory such as `dist` or `public`.',
      'CFG001',
    ));
    logger?.error?.(`refusing to empty ${dirs.outDir}: it ${unsafeOutDir}`);
    return finish(0);
  }

  emptyDir(dirs.outDir);

  // --- assets -----------------------------------------------------------------------
  // Hashed filenames are needed by every shell, so assets are emitted before any page.
  const css = applyThemeVariables(readThemeAsset('style.css', logger), config);
  const appJs = readThemeAsset('app.js', logger);
  const assetPaths = { css: '', js: '' };

  if (css) {
    const name = hashedName('style.css', shortHash(css));
    write(`assets/${name}`, css);
    assetPaths.css = `/assets/${name}`;
    assets += 1;
  }
  if (appJs && config.spa !== false) {
    const name = hashedName('app.js', shortHash(appJs));
    write(`assets/${name}`, appJs);
    assetPaths.js = `/assets/${name}`;
    assets += 1;
  }

  // --- scan -------------------------------------------------------------------------
  logger?.step?.('scanning content');
  const scan = scanContent(cwd, { ...config, includeDrafts });
  diagnostics.push(...(scan?.diagnostics || []));

  const pageSources = (scan?.pages || []).filter(
    (page) => includeDrafts || page.frontmatter?.draft !== true,
  );

  // --- parse ------------------------------------------------------------------------
  /** @type {Array<{ page: object, ast: object|null, frontmatter: object }>} */
  const parsed = [];
  /** @type {Map<string, string>} */
  const titleHints = new Map();

  for (const page of pageSources) {
    const file = toPosix(page.file);
    sources.set(file, page.source ?? '');
    try {
      const result = parseMarkdown(page.source ?? '', { file, config });
      diagnostics.push(...(result?.diagnostics || []));
      const frontmatter = { ...(page.frontmatter || {}), ...(result?.frontmatter || {}) };
      const h1 = firstH1(result?.ast);
      if (h1) titleHints.set(normalizeRoute(page.route), h1);
      parsed.push({
        page: { ...page, file, frontmatter, h1, title: frontmatter.title || page.title || null },
        ast: result?.ast ?? null,
        frontmatter,
      });
    } catch (err) {
      diagnostics.push(internalDiagnostic(file, `failed to parse: ${err.message}`,
        'This is a bug in md2spa; the page was emitted as an error placeholder.'));
      parsed.push({
        page: { ...page, file, frontmatter: page.frontmatter || {}, h1: null },
        ast: null,
        frontmatter: page.frontmatter || {},
      });
    }
  }

  // --- navigation -------------------------------------------------------------------
  logger?.step?.('building navigation');
  /** @type {any} */
  let nav = {
    tree: [], flat: [], prevNext: new Map(), crumbs: new Map(),
    byRoute: new Map(), generatedPages: [], diagnostics: [],
  };
  try {
    nav = buildNav(parsed.map((p) => p.page), scan?.meta ?? new Map(), config, { titleHints })
      || nav;
    diagnostics.push(...(nav.diagnostics || []));
  } catch (err) {
    diagnostics.push(internalDiagnostic(config.contentDir,
      `failed to build navigation: ${err.message}`));
  }

  /** @type {Map<string, string>} route -> title, for crumbs and section pages */
  const titleByRoute = new Map();
  if (nav.byRoute instanceof Map) {
    for (const [route, node] of nav.byRoute) titleByRoute.set(normalizeRoute(route), node?.title ?? '');
  }
  for (const ref of Array.isArray(nav.flat) ? nav.flat : []) {
    if (ref?.route && !titleByRoute.has(normalizeRoute(ref.route))) {
      titleByRoute.set(normalizeRoute(ref.route), ref.title ?? '');
    }
  }

  // --- route bookkeeping ------------------------------------------------------------
  const generatedPages = Array.isArray(nav.generatedPages) ? nav.generatedPages : [];
  const pageRoutes = new Set(parsed.map((p) => normalizeRoute(p.page.route)));
  const allRoutes = new Set([
    ...pageRoutes,
    ...generatedPages.map((g) => normalizeRoute(g.route)),
  ]);

  // A route with descendants must stay `<route>/index.html` even under `cleanUrls: false`,
  // or every child link resolves one level too high.
  const indexRoutes = new Set(['/']);
  for (const route of allRoutes) {
    const segments = routeSegments(route);
    for (let i = 1; i < segments.length; i += 1) {
      indexRoutes.add(`/${segments.slice(0, i).join('/')}/`);
    }
  }
  for (const entry of parsed) {
    if (entry.page.isIndex) indexRoutes.add(normalizeRoute(entry.page.route));
  }
  for (const generated of generatedPages) indexRoutes.add(normalizeRoute(generated.route));

  /**
   * The depth-aware shell resolver for one route.
   * @param {string} route
   */
  const urlFor = (route) => createUrlResolver({
    base: config.base,
    depth: depthOfRoute(route, {
      cleanUrls: config.cleanUrls,
      isIndex: indexRoutes.has(route),
    }),
    // Passing the document's directory, not just its depth, lets the resolver drop the
    // prefix a link shares with the current page: a breadcrumb to the parent section
    // becomes `../../` instead of climbing to the root and descending again.
    docDir: routeToDocDir(route, {
      cleanUrls: config.cleanUrls,
      isIndex: indexRoutes.has(route),
    }),
    cleanUrls: config.cleanUrls,
    indexRoutes,
    siteUrl: config.siteUrl,
  });

  const editUrlFor = (page) => {
    const base = config.repo?.editBase;
    if (!base || !page?.relPath) return null;
    return `${String(base).replace(/\/+$/, '')}/${page.relPath}`;
  };

  // Asset existence data for MD046. Both sets are keyed site-root-relative.
  const staticFiles = isDirectory(dirs.staticDir) ? walkDir(dirs.staticDir) : [];
  const contentAssets = Array.isArray(scan?.assets) ? scan.assets : [];

  // --- render -----------------------------------------------------------------------
  logger?.step?.(`rendering ${parsed.length} page${parsed.length === 1 ? '' : 's'}`);
  /** @type {Array<object>} */
  const rendered = [];
  /** @type {Map<string, Set<string>>} */
  const anchorsByRoute = new Map();

  for (const entry of parsed) {
    const { page, ast, frontmatter } = entry;
    const route = normalizeRoute(page.route);
    let result = null;

    if (ast) {
      try {
        result = renderHtml(ast, {
          file: page.file,
          config,
          slugRegistry: createSlugRegistry(),
          resolveUrl: createLinkUrlResolver(page, {
            routes: allRoutes,
            config,
            staticFiles,
            contentAssets,
          }),
        });
        diagnostics.push(...(result?.diagnostics || []));
      } catch (err) {
        diagnostics.push(internalDiagnostic(page.file, `failed to render: ${err.message}`,
          'This is a bug in md2spa; the page was emitted as an error placeholder.'));
        result = null;
      }

      try {
        diagnostics.push(...(validateDocument(ast, {
          file: page.file, frontmatter, source: page.source ?? '', config,
        }) || []));
      } catch (err) {
        diagnostics.push(internalDiagnostic(page.file, `failed to validate: ${err.message}`));
      }
    }

    const html = result
      ? result.html
      : '<div class="admonition admonition--danger" role="note">'
        + '<p class="admonition__title">This page could not be rendered</p>'
        + `<p>Source file: <code class="code-inline">${escapeHtml(page.file)}</code></p></div>`;

    const title = frontmatter.title
      || result?.headings?.find((h) => h.depth === 1)?.text
      || page.h1
      || titleByRoute.get(route)
      || (route === '/' ? config.title : humanizeName(routeSegments(route).slice(-1)[0] || ''));

    anchorsByRoute.set(route, new Set((result?.headings || []).map((h) => h.id)));

    rendered.push({
      file: page.file,
      route,
      title,
      description: frontmatter.description || frontmatter.summary || '',
      html,
      toc: frontmatter.toc === false ? [] : (result?.toc || []),
      headings: result?.headings || [],
      text: result?.text || '',
      links: result?.links || [],
      images: result?.images || [],
      editUrl: editUrlFor(page),
    });
  }

  // --- cross-page links -------------------------------------------------------------
  // Deferred until every page is rendered: anchor validation needs all heading ids.
  try {
    diagnostics.push(...(resolveLinks({
      pages: parsed.map((p) => p.page),
      rendered,
      anchorsByRoute,
      staticFiles,
      contentAssets,
      config,
      cwd,
    }) || []));
  } catch (err) {
    logger?.warn?.(`link validation skipped: ${err.message}`);
  }

  // --- page emission ----------------------------------------------------------------
  logger?.step?.('writing pages');
  /** @type {Array<object>} */
  const searchDocuments = [];
  let pageCount = 0;

  /**
   * Ancestor breadcrumbs for a route the nav module did not supply one for (SPEC 7:
   * the trail lists ancestors, not the page itself).
   * @param {string} route
   * @returns {Array<{title: string, route: string|null}>}
   */
  const defaultCrumbs = (route) => {
    const segments = routeSegments(route);
    if (!segments.length) return [];
    const crumbs = [{ title: titleByRoute.get('/') || config.title || 'Home', route: '/' }];
    let acc = '';
    for (const segment of segments.slice(0, -1)) {
      acc += `/${segment}`;
      const r = `${acc}/`;
      crumbs.push({ title: titleByRoute.get(r) || humanizeName(segment), route: r });
    }
    return crumbs;
  };

  /**
   * Render one document, verify it and write it plus its SPA payload.
   * @param {{ route: string, title: string, description: string, html: string,
   *           toc?: Array<object>, headings?: Array<object>, text?: string,
   *           editUrl?: string|null }} pageCtx
   */
  const emitPage = (pageCtx) => {
    const route = normalizeRoute(pageCtx.route);
    const isIndex = indexRoutes.has(route);
    const prevNext = nav.prevNext instanceof Map ? nav.prevNext.get(route) : null;
    const crumbs = nav.crumbs instanceof Map ? nav.crumbs.get(route) : null;

    const ctx = {
      config,
      route,
      title: pageCtx.title,
      description: pageCtx.description,
      html: pageCtx.html,
      toc: pageCtx.toc || [],
      navTree: nav.tree,
      crumbs: crumbs || defaultCrumbs(route),
      navTitle: (nav.byRoute instanceof Map ? nav.byRoute.get(route)?.title : null) || null,
      prev: prevNext?.prev ?? null,
      next: prevNext?.next ?? null,
      editUrl: pageCtx.editUrl ?? null,
      assets: assetPaths,
      depth: depthOfRoute(route, { cleanUrls: config.cleanUrls, isIndex }),
      isIndex,
      indexRoutes,
      isHome: route === '/',
      url: urlFor(route),
    };

    const outPath = routeToOutputPath(route, { cleanUrls: config.cleanUrls, isIndex });
    let html;
    try {
      html = renderPageShell(ctx);
    } catch (err) {
      diagnostics.push(internalDiagnostic(outPath, `failed to render page shell: ${err.message}`));
      return;
    }

    write(outPath, html);
    diagnostics.push(...verifyHtml(html, outPath, { rules: config.rules }));
    pageCount += 1;

    if (config.spa !== false) {
      write(
        routeToPayloadPath(route),
        JSON.stringify(renderSpaPayload({ ...ctx, hash: shortHash(pageCtx.html) })),
      );
    }

    if (config.search !== false) {
      searchDocuments.push({
        route,
        title: pageCtx.title,
        description: pageCtx.description,
        headings: pageCtx.headings || [],
        text: pageCtx.text || '',
      });
    }
  };

  for (const pageCtx of rendered) emitPage(pageCtx);

  // --- generated section landing pages (SPEC 7b; nav.js already reported NAV002) -----
  for (const generated of generatedPages) {
    const route = normalizeRoute(generated.route);
    const url = urlFor(route);
    const title = generated.title
      || titleByRoute.get(route)
      || humanizeName(routeSegments(route).slice(-1)[0] || '');

    const children = Array.isArray(generated.children) ? generated.children : [];
    const items = children.map((child) => {
      const childRoute = normalizeRoute(child.route);
      const childTitle = child.title || titleByRoute.get(childRoute) || childRoute;
      const summary = child.description
        ? ` <span class="section-list__desc">${escapeHtml(child.description)}</span>`
        : '';
      return `<li><a href="${escapeAttr(url(childRoute))}">${escapeHtml(childTitle)}</a>${summary}</li>`;
    }).join('');

    emitPage({
      route,
      title,
      description: '',
      html: `<h1 id="${escapeAttr(slugify(title) || 'section')}">${escapeHtml(title)}</h1>`
        + (items ? `<ul>${items}</ul>` : '<p>This section has no pages yet.</p>'),
      toc: [],
      headings: [],
      text: title,
      editUrl: null,
    });
  }

  // --- 404 --------------------------------------------------------------------------
  const sections = [...allRoutes]
    .filter((route) => routeSegments(route).length === 1)
    .sort()
    .map((route) => ({
      route,
      title: titleByRoute.get(route) || humanizeName(routeSegments(route)[0]),
    }));

  const notFound = render404({
    config,
    routes: [...allRoutes],
    assets: assetPaths,
    indexRoutes,
    sections,
  });
  write('404.html', notFound);
  diagnostics.push(...verifyHtml(notFound, '404.html', { rules: config.rules }));

  // --- search index -----------------------------------------------------------------
  if (config.search !== false) {
    write('search-index.json', serializeSearchIndex(
      buildSearchIndex(searchDocuments, config, { logger }),
    ));
  }

  // --- sitemap / robots -------------------------------------------------------------
  if (config.siteUrl) {
    const sitemap = buildSitemap([...allRoutes], { ...config, indexRoutes });
    if (sitemap) write('sitemap.xml', sitemap);
    write('robots.txt', buildRobots(config));
  }

  // --- assets sitting next to the Markdown --------------------------------------------
  // Authors co-locate a diagram with the page that uses it and write `![](assets/x.png)`.
  // That is how the file renders on GitHub, and `MD046` already checks the target exists,
  // so failing to copy it would make the linter lie: clean build, broken image.
  // Copied before `staticDir` so an explicit static file still wins any name clash.
  if (contentAssets.length) {
    for (const rel of contentAssets) {
      const from = path.join(dirs.contentDir, ...rel.split('/'));
      const to = path.join(dirs.outDir, ...rel.split('/'));
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        files.push(rel);
        bytes += fs.statSync(to).size;
        assets += 1;
      } catch (err) {
        diagnostics.push(internalDiagnostic(
          `${scan?.contentRel ? `${scan.contentRel}/` : ''}${rel}`,
          `could not copy asset: ${err.message}`,
          'Check the file is readable and that `outDir` is writable.',
        ));
      }
    }
    logger?.dim?.(`copied ${contentAssets.length} content asset${contentAssets.length === 1 ? '' : 's'}`);
  }

  // --- static passthrough -----------------------------------------------------------
  if (isDirectory(dirs.staticDir)) {
    const copied = copyDirDeep(dirs.staticDir, dirs.outDir);
    for (const rel of copied) {
      files.push(rel);
      try {
        bytes += fs.statSync(path.join(dirs.outDir, ...rel.split('/'))).size;
      } catch { /* just written; a stat failure is not worth failing the build over */ }
    }
    assets += copied.length;
    logger?.dim?.(`copied ${copied.length} static file${copied.length === 1 ? '' : 's'}`);
  }

  logger?.step?.(`built ${pageCount} page${pageCount === 1 ? '' : 's'} into ${config.outDir}`);
  return finish(pageCount);
}
