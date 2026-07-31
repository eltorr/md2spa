/**
 * Navigation derived from the folder tree -- the headline feature (SPEC 7b).
 *
 * Dropping `content/guide/advanced/tuning.md` into the tree makes it appear in the sidebar,
 * correctly titled, correctly ordered, nested at the right depth, with working breadcrumbs
 * and prev/next links, and with zero configuration. Everything in this module exists to
 * protect that promise, so each decision has a documented fallback chain rather than a
 * required config key.
 *
 * @module content/nav
 */

import { createBag } from '../markdown/diagnostics.js';
import { humanizeName, stripOrderPrefix } from './route.js';

/**
 * @typedef {Object} NavNode
 * @property {'page'|'group'} type
 * @property {string} title
 * @property {string} route
 * @property {NavNode[]} children
 * @property {number} depth      nesting level, 0 for a top-level item
 * @property {number} order      final position among its siblings
 * @property {boolean} isIndex   the node is backed by a real `index.md`
 * @property {boolean} generated the node is a synthesised section landing page
 * @property {boolean} collapsed the group starts closed in the sidebar
 * @property {boolean} draft
 * @property {string|null} icon
 * @property {string|null} file  source file, relative to cwd (null when generated)
 */

/**
 * @typedef {Object} PageRef
 * @property {string} title
 * @property {string|null} route null only for a breadcrumb ancestor that has no page
 * @property {number} depth
 */

/**
 * Build the navigation tree, the flattened reading order, prev/next and breadcrumbs.
 *
 * @param {import('./scan.js').PageSource[]} pages
 * @param {Map<string, object>|object} meta per-folder `_meta.json`, keyed by folder route
 * @param {object} [config]
 * @param {{ titleHints?: Map<string, string> }} [options]
 *   `titleHints` maps a route to that document's first H1; `build/` fills it in after
 *   parsing and passes it back, which is why it is optional rather than required here.
 * @returns {{ tree: NavNode[], flat: PageRef[], prevNext: Map<string, {prev: PageRef|null, next: PageRef|null}>,
 *             crumbs: Map<string, PageRef[]>, byRoute: Map<string, NavNode>,
 *             generatedPages: Array<{ route: string, title: string, children: Array<{title: string, route: string, description: string}> }>,
 *             diagnostics: import('../markdown/diagnostics.js').Diagnostic[] }}
 */
export function buildNav(pages, meta, config = {}, options = {}) {
  const metaMap = toMetaMap(meta);
  const titleHints = options.titleHints instanceof Map ? options.titleHints : new Map();
  const navConfig = config.nav || {};
  const sortMode = navConfig.sort === 'alpha' || navConfig.sort === 'manual'
    ? navConfig.sort
    : 'auto';
  const collapseDepth = Number.isFinite(navConfig.collapseDepth) ? navConfig.collapseDepth : 1;

  const list = (Array.isArray(pages) ? pages : []).map(normalizePage);
  const hiddenDirs = new Set(
    [...metaMap.entries()].filter(([, m]) => m && m.hidden === true).map(([route]) => route),
  );

  /** Source-file prefix (`content/`), recovered from any page, so NAV002 can name a folder. */
  let filePrefix = '';
  for (const page of list) {
    if (typeof page.file === 'string' && typeof page.relPath === 'string'
      && page.file.endsWith(page.relPath)) {
      filePrefix = page.file.slice(0, page.file.length - page.relPath.length);
      break;
    }
  }

  const root = createFolder([], []);
  /** @type {Map<string, ReturnType<typeof createFolder>>} */
  const folders = new Map([['/', root]]);

  /**
   * @param {string[]} segments
   * @param {string[]} dirNames
   */
  const ensureFolder = (segments, dirNames) => {
    const route = routeOf(segments);
    const existing = folders.get(route);
    if (existing) return existing;
    const parent = ensureFolder(segments.slice(0, -1), dirNames.slice(0, -1));
    const node = createFolder(segments, dirNames);
    folders.set(route, node);
    parent.entries.push(node);
    return node;
  };

  for (const page of list) {
    if (isHiddenPage(page, hiddenDirs)) continue;
    const segments = page.segments || [];
    const dirNames = page.dirNames || [];
    if (page.isIndex && segments.length > 0) {
      ensureFolder(segments, dirNames).page = page;
    } else {
      ensureFolder(segments.slice(0, -1), dirNames).entries.push({ kind: 'page', page });
    }
  }

  /** Route -> summary line, used by generated section pages. */
  const descriptions = new Map();
  for (const page of list) {
    const summary = page.frontmatter?.description ?? page.frontmatter?.summary;
    if (typeof summary === 'string' && summary.trim()) descriptions.set(page.route, summary.trim());
  }

  const ctx = {
    metaMap, titleHints, sortMode, collapseDepth, config, filePrefix, descriptions,
    generatedPages: [], diagnostics: [],
  };

  const tree = buildChildren(root, 0, ctx);

  /** @type {Map<string, NavNode>} */
  const byRoute = new Map();
  indexNodes(tree, byRoute);

  const flat = flatten(tree);
  const prevNext = buildPrevNext(flat);
  const crumbs = buildCrumbs(list, byRoute, config, ctx);

  // Pages kept out of the sidebar are still built, so they still need a lookup entry and
  // an (empty) prev/next slot -- layout must never see `undefined`.
  for (const page of list) {
    if (!prevNext.has(page.route)) prevNext.set(page.route, { prev: null, next: null });
    if (!byRoute.has(page.route)) {
      byRoute.set(page.route, {
        type: 'page',
        title: resolvePageTitle(page, ctx),
        route: page.route,
        children: [],
        depth: Math.max(0, (page.segments || []).length - 1),
        order: 0,
        isIndex: !!page.isIndex,
        generated: false,
        collapsed: false,
        draft: !!page.draft,
        icon: iconOf(page.frontmatter),
        file: page.file ?? null,
        hidden: true,
      });
    }
  }

  return {
    tree,
    flat,
    prevNext,
    crumbs,
    byRoute,
    generatedPages: ctx.generatedPages,
    diagnostics: ctx.diagnostics,
  };
}

/* ------------------------------------------------------------------ tree assembly */

/**
 * @param {string[]} segments
 * @param {string[]} dirNames
 */
function createFolder(segments, dirNames) {
  return {
    kind: 'folder',
    segments,
    dirNames,
    route: routeOf(segments),
    /** @type {import('./scan.js').PageSource|null} */
    page: null,
    /** @type {Array<object>} */
    entries: [],
  };
}

/**
 * @param {string[]} segments
 * @returns {string}
 */
function routeOf(segments) {
  return segments.length ? `/${segments.join('/')}/` : '/';
}

/**
 * Sort one folder's entries and turn them into NavNodes. Empty groups disappear so a folder
 * containing only drafts or `nav: false` pages never leaves a dead branch in the sidebar.
 *
 * @param {ReturnType<typeof createFolder>} folder
 * @param {number} depth
 * @param {object} ctx
 * @returns {NavNode[]}
 */
function buildChildren(folder, depth, ctx) {
  const folderMeta = ctx.metaMap.get(folder.route) || {};
  const orderIndex = buildOrderIndex(folderMeta.order);

  const decorated = folder.entries.map((entry) => decorate(entry, folderMeta, orderIndex, ctx));
  decorated.sort(compareEntries);

  /** @type {NavNode[]} */
  const out = [];
  for (const item of decorated) {
    const node = item.entry.kind === 'folder'
      ? buildGroup(item, depth, ctx)
      : buildLeaf(item, depth, ctx);
    if (node) {
      node.order = out.length;
      out.push(node);
    }
  }
  return out;
}

/**
 * @param {object} item
 * @param {number} depth
 * @param {object} ctx
 * @returns {NavNode}
 */
function buildLeaf(item, depth, ctx) {
  const page = item.entry.page;
  return {
    type: 'page',
    title: item.title,
    route: page.route,
    children: [],
    depth,
    order: 0,
    isIndex: !!page.isIndex,
    generated: false,
    collapsed: false,
    draft: !!page.draft,
    icon: iconOf(page.frontmatter),
    file: page.file ?? null,
  };
}

/**
 * @param {object} item
 * @param {number} depth
 * @param {object} ctx
 * @returns {NavNode|null}
 */
function buildGroup(item, depth, ctx) {
  const folder = item.entry;
  const children = buildChildren(folder, depth + 1, ctx);
  if (children.length === 0 && !folder.page) return null;

  const folderMeta = ctx.metaMap.get(folder.route) || {};
  const collapsed = typeof folderMeta.collapsed === 'boolean'
    ? folderMeta.collapsed
    : depth >= ctx.collapseDepth;

  if (!folder.page) {
    // No index.md: the group still needs a destination, so the build renders one for us.
    ctx.generatedPages.push({
      route: folder.route,
      title: item.title,
      children: children.map((child) => ({
        title: child.title,
        route: child.route,
        description: descriptionOf(child, ctx),
      })),
    });
    const dirName = folder.dirNames[folder.dirNames.length - 1] || '';
    const folderFile = `${ctx.filePrefix}${folder.dirNames.join('/')}`;
    const bag = createBag(folderFile || folder.route, { rules: ctx.config.rules });
    bag.add('NAV002', { line: 1, column: 1 },
      `folder \`${dirName || '/'}\` has no index.md; a section page was generated for \`${folder.route}\``,
      `Add \`${folderFile ? `${folderFile}/index.md` : 'index.md'}\` to control this section's landing page.`);
    ctx.diagnostics.push(...bag.list());
  }

  return {
    type: 'group',
    title: item.title,
    route: folder.route,
    children,
    depth,
    order: 0,
    isIndex: !!folder.page,
    generated: !folder.page,
    collapsed,
    draft: !!folder.page?.draft,
    icon: iconOf(folder.page?.frontmatter) || (typeof folderMeta.icon === 'string' ? folderMeta.icon : null),
    file: folder.page?.file ?? null,
  };
}

/* ------------------------------------------------------------------ ordering */

/**
 * Precompute everything the comparator needs, so sorting stays a pure key comparison.
 *
 * @param {object} entry
 * @param {object} folderMeta the *containing* folder's `_meta.json`
 * @param {Map<string, number>} orderIndex
 * @param {object} ctx
 */
function decorate(entry, folderMeta, orderIndex, ctx) {
  const isFolder = entry.kind === 'folder';
  const page = entry.page;
  const rawName = isFolder
    ? entry.dirNames[entry.dirNames.length - 1] || ''
    : entry.page.rawName;
  const stripped = stripOrderPrefix(rawName.replace(/\.(md|markdown)$/i, ''));

  const title = isFolder
    ? resolveFolderTitle(entry, folderMeta, ctx)
    : resolvePageTitle(entry.page, ctx, folderMeta);

  const frontmatterOrder = page && typeof page.frontmatter?.order === 'number'
    && Number.isFinite(page.frontmatter.order)
    ? page.frontmatter.order
    : null;

  const metaIndex = lookupAlias(orderIndex, rawName, stripped.name, isFolder);
  const isRootIndex = !isFolder && entry.page.isIndex && (entry.page.segments || []).length === 0;

  let tier;
  let key = 0;
  if (isRootIndex && frontmatterOrder === null) {
    tier = -1;
  } else if (frontmatterOrder !== null && ctx.sortMode !== 'alpha') {
    tier = 0;
    key = frontmatterOrder;
  } else if (metaIndex !== null && ctx.sortMode !== 'alpha') {
    tier = 1;
    key = metaIndex;
  } else if (stripped.order !== null && ctx.sortMode === 'auto') {
    tier = 2;
    key = stripped.order;
  } else {
    tier = 3;
  }

  return {
    entry,
    title,
    tier,
    key,
    alpha: (ctx.sortMode === 'alpha' ? title : stripped.name).toLowerCase(),
    rawName: rawName.toLowerCase(),
    route: isFolder ? entry.route : entry.page.route,
  };
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareEntries(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.key !== b.key) return a.key - b.key;
  if (a.alpha !== b.alpha) return a.alpha < b.alpha ? -1 : 1;
  if (a.rawName !== b.rawName) return a.rawName < b.rawName ? -1 : 1;
  return a.route < b.route ? -1 : a.route > b.route ? 1 : 0;
}

/**
 * `_meta.json` `order: ["intro.md", "guide"]` -> lookup table of name -> position.
 * @param {unknown} order
 * @returns {Map<string, number>}
 */
function buildOrderIndex(order) {
  /** @type {Map<string, number>} */
  const index = new Map();
  if (!Array.isArray(order)) return index;
  order.forEach((raw, i) => {
    if (typeof raw !== 'string') return;
    const key = raw.trim().replace(/^\.?\//, '').replace(/\/+$/, '').toLowerCase();
    if (key && !index.has(key)) index.set(key, i);
  });
  return index;
}

/**
 * Match an entry against an `_meta.json` `order` list, accepting the forms authors
 * actually write: `intro.md`, `intro`, `01-intro.md`, `guide/`.
 *
 * @param {Map<string, number>} orderIndex
 * @param {string} rawName
 * @param {string} strippedName
 * @param {boolean} isFolder
 * @returns {number|null}
 */
function lookupAlias(orderIndex, rawName, strippedName, isFolder) {
  if (orderIndex.size === 0) return null;
  const bare = rawName.replace(/\.(md|markdown)$/i, '');
  const aliases = isFolder
    ? [rawName, strippedName]
    : [rawName, bare, strippedName, `${strippedName}.md`, `${strippedName}.markdown`];
  for (const alias of aliases) {
    const hit = orderIndex.get(String(alias).toLowerCase());
    if (hit !== undefined) return hit;
  }
  return null;
}

/* ------------------------------------------------------------------ titles */

/**
 * Title resolution for a page, first match wins (SPEC 7b):
 * frontmatter `title` -> first H1 -> `_meta.json` `titles` entry -> humanised filename.
 * A `nav: "Short name"` string overrides all of them for sidebar purposes.
 *
 * @param {import('./scan.js').PageSource} page
 * @param {object} ctx
 * @param {object} [folderMeta] the containing folder's meta (defaults to the page's own dir)
 * @returns {string}
 */
function resolvePageTitle(page, ctx, folderMeta) {
  if (page.navTitle) return page.navTitle;
  const fmTitle = page.frontmatter?.title;
  if (typeof fmTitle === 'string' && fmTitle.trim()) return fmTitle.trim();

  const hint = ctx.titleHints.get(page.route);
  if (typeof hint === 'string' && hint.trim()) return hint.trim();

  const meta = folderMeta || ctx.metaMap.get(page.dir) || {};
  const fromMeta = lookupTitle(meta, page.rawName, page.name);
  if (fromMeta) return fromMeta;

  // "Index" is never a useful label: a section index is named after its folder, and the
  // root index falls back to the conventional "Home" (SPEC 7's breadcrumb example).
  if (page.isIndex) {
    const dirName = page.dirNames[page.dirNames.length - 1];
    return dirName ? humanizeName(dirName) : 'Home';
  }
  return humanizeName(page.rawName);
}

/**
 * Folder titles: `_meta.json` `title` -> the folder's `index.md` title -> the parent's
 * `titles` entry for the folder -> humanised folder name.
 *
 * @param {ReturnType<typeof createFolder>} folder
 * @param {object} parentMeta
 * @param {object} ctx
 * @returns {string}
 */
function resolveFolderTitle(folder, parentMeta, ctx) {
  const ownMeta = ctx.metaMap.get(folder.route) || {};
  if (typeof ownMeta.title === 'string' && ownMeta.title.trim()) return ownMeta.title.trim();
  if (folder.page) return resolvePageTitle(folder.page, ctx, ownMeta);

  const dirName = folder.dirNames[folder.dirNames.length - 1] || '';
  const fromParent = lookupTitle(parentMeta, dirName, stripOrderPrefix(dirName).name);
  if (fromParent) return fromParent;
  return humanizeName(dirName) || 'Section';
}

/**
 * @param {object} meta
 * @param {string} rawName
 * @param {string} name
 * @returns {string|null}
 */
function lookupTitle(meta, rawName, name) {
  const titles = meta?.titles;
  if (!titles || typeof titles !== 'object') return null;
  const bare = String(rawName).replace(/\.(md|markdown)$/i, '');
  for (const alias of [rawName, bare, name, `${name}.md`]) {
    const value = titles[alias];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * @param {object|undefined} frontmatter
 * @returns {string|null}
 */
function iconOf(frontmatter) {
  const icon = frontmatter?.icon;
  return typeof icon === 'string' && icon.trim() ? icon.trim() : null;
}

/**
 * @param {NavNode} node
 * @param {object} ctx
 * @returns {string}
 */
function descriptionOf(node, ctx) {
  const hint = ctx.descriptions?.get(node.route);
  return typeof hint === 'string' ? hint : '';
}

/* ------------------------------------------------------------------ derived views */

/**
 * @param {NavNode[]} nodes
 * @param {Map<string, NavNode>} byRoute
 */
function indexNodes(nodes, byRoute) {
  for (const node of nodes) {
    if (node.route && !byRoute.has(node.route)) byRoute.set(node.route, node);
    if (node.children.length) indexNodes(node.children, byRoute);
  }
}

/**
 * Depth-first walk of the visible tree -- the reading order prev/next follows.
 * @param {NavNode[]} nodes
 * @returns {PageRef[]}
 */
function flatten(nodes) {
  /** @type {PageRef[]} */
  const out = [];
  const visit = (list) => {
    for (const node of list) {
      if (node.route) out.push({ title: node.title, route: node.route, depth: node.depth });
      if (node.children.length) visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

/**
 * @param {PageRef[]} flat
 * @returns {Map<string, {prev: PageRef|null, next: PageRef|null}>}
 */
function buildPrevNext(flat) {
  /** @type {Map<string, {prev: PageRef|null, next: PageRef|null}>} */
  const map = new Map();
  for (let i = 0; i < flat.length; i += 1) {
    map.set(flat[i].route, {
      prev: i > 0 ? flat[i - 1] : null,
      next: i < flat.length - 1 ? flat[i + 1] : null,
    });
  }
  return map;
}

/**
 * Breadcrumbs for every page, hidden ones included. The trail lists the page's *ancestors*
 * only -- SPEC 7 shows `/guide/install/` carrying `[Home, Guide]`. Rendering the current
 * page as the final crumb is `layout.js`'s job, since only it knows the page title.
 *
 * @param {import('./scan.js').PageSource[]} pages
 * @param {Map<string, NavNode>} byRoute
 * @param {object} config
 * @param {object} ctx
 * @returns {Map<string, PageRef[]>}
 */
function buildCrumbs(pages, byRoute, config, ctx) {
  const homeTitle = byRoute.get('/')?.title || config.title || 'Home';
  /** @type {Map<string, PageRef[]>} */
  const crumbs = new Map();

  for (const page of pages) {
    const segments = page.segments || [];
    const dirNames = page.dirNames || [];
    /** @type {PageRef[]} */
    const trail = [];

    if (page.route !== '/') trail.push({ title: homeTitle, route: '/', depth: 0 });

    for (let i = 1; i < segments.length; i += 1) {
      const route = `/${segments.slice(0, i).join('/')}/`;
      const node = byRoute.get(route);
      // An ancestor with no node is a folder that produced no page (everything in it is
      // hidden or drafted). Emit it with a null route so layout renders text, not a link.
      trail.push({
        title: node?.title || humanizeName(dirNames[i - 1] || segments[i - 1]),
        route: node ? route : null,
        depth: i - 1,
      });
    }

    crumbs.set(page.route, trail);
  }

  // Generated section pages are real routes too and need their own trail.
  for (const generated of ctx.generatedPages) {
    if (crumbs.has(generated.route)) continue;
    const segments = generated.route.split('/').filter(Boolean);
    /** @type {PageRef[]} */
    const trail = [{ title: homeTitle, route: '/', depth: 0 }];
    for (let i = 1; i < segments.length; i += 1) {
      const route = `/${segments.slice(0, i).join('/')}/`;
      trail.push({
        title: byRoute.get(route)?.title || humanizeName(segments[i - 1]),
        route,
        depth: i - 1,
      });
    }
    crumbs.set(generated.route, trail);
  }

  return crumbs;
}

/* ------------------------------------------------------------------ helpers */

/**
 * `scan.js` hands us a richer PageSource than SPEC 6 documents (`segments`, `dirNames`,
 * `rawName`, ...). Anything constructed by hand -- tests, a programmatic caller, a future
 * alternative scanner -- is only obliged to carry the documented fields, so derive the rest
 * from `route` and `file` rather than crashing on a missing property.
 *
 * @param {import('./scan.js').PageSource} page
 * @returns {import('./scan.js').PageSource}
 */
function normalizePage(page) {
  if (!page || typeof page !== 'object') return page;
  if (Array.isArray(page.segments) && Array.isArray(page.dirNames)
    && typeof page.rawName === 'string') return page;

  const route = typeof page.route === 'string' && page.route ? page.route : '/';
  const routeSegments = route.split('/').filter(Boolean);
  const file = typeof page.file === 'string' ? page.file : '';
  const rawName = file ? file.slice(file.lastIndexOf('/') + 1) : `${routeSegments.at(-1) || 'index'}.md`;
  const isIndex = typeof page.isIndex === 'boolean'
    ? page.isIndex
    : /(^|\/)index\.(md|markdown)$/i.test(file);
  // `segments` is the route path for an index page, and the route path *including* the
  // page slug for a leaf -- which is the same thing, since routes already embed the slug.
  const dirNames = isIndex ? routeSegments.slice() : routeSegments.slice(0, -1);

  return {
    ...page,
    segments: routeSegments,
    dirNames,
    rawName,
    name: stripOrderPrefix(rawName.replace(/\.(md|markdown)$/i, '')).name,
    relPath: typeof page.relPath === 'string' ? page.relPath : rawName,
    isIndex,
    dir: typeof page.dir === 'string' && page.dir
      ? page.dir
      : (dirNames.length ? `/${routeSegments.slice(0, isIndex ? undefined : -1).join('/')}/` : '/'),
    depth: Number.isFinite(page.depth) ? page.depth : routeSegments.length,
    frontmatter: page.frontmatter && typeof page.frontmatter === 'object' ? page.frontmatter : {},
    navTitle: page.navTitle ?? null,
  };
}

/**
 * @param {import('./scan.js').PageSource} page
 * @param {Set<string>} hiddenDirs
 * @returns {boolean}
 */
function isHiddenPage(page, hiddenDirs) {
  if (page.hidden) return true;
  const segments = page.segments || [];
  for (let i = 1; i <= segments.length; i += 1) {
    const route = `/${segments.slice(0, i).join('/')}/`;
    if (route !== page.route && hiddenDirs.has(route)) return true;
  }
  return hiddenDirs.has(page.dir) && page.dir !== '/';
}

/**
 * @param {Map<string, object>|object|undefined} meta
 * @returns {Map<string, object>}
 */
function toMetaMap(meta) {
  if (meta instanceof Map) return meta;
  if (meta && typeof meta === 'object') return new Map(Object.entries(meta));
  return new Map();
}
