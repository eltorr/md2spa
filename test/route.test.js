/**
 * Routing and zero-config navigation -- SPEC.md §6 (`content/route.js`, `content/nav.js`)
 * and §7b ("Zero-config navigation from the folder tree").
 *
 * The product promise is that dropping a file into the tree makes it appear in the sidebar
 * with no configuration, in a predictable place. These tests pin that: file->route mapping,
 * title humanisation, the three ordering sources, prev/next, breadcrumbs, the exclusion
 * rules, and the NAV001 collision error.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { routeToOutputPath, depthOfRoute, routeSegments } from '../src/util/path.js';
import {
  buildTempSite, cleanupTemps, findExport, loadSrc, testConfig, tempDir, writeTree,
} from './helpers/harness.js';

after(cleanupTemps);

/**
 * Scan a temp content tree and build its navigation, i.e. the documented
 * `scanContent -> buildNav` pipeline from SPEC §6.
 *
 * SPEC §6 writes the scanner as `scanContent(config)`; the implementation takes
 * `(cwd, config)`. Both calling conventions are tried so this suite pins *behaviour*
 * rather than an argument list.
 *
 * @param {Record<string, string>} files tree relative to the site root
 * @param {object} [configOverrides]
 * @returns {Promise<{ pages: object[], meta: Map<string, object>, nav: object,
 *   diagnostics: object[], cwd: string }>}
 */
async function scanAndBuildNav(files, configOverrides = {}) {
  const cwd = tempDir('md2spa-nav-');
  writeTree(cwd, files);
  const { scanContent } = await loadSrc('content/scan.js');
  const { buildNav } = await loadSrc('content/nav.js');
  const config = testConfig({
    contentDir: 'content', outDir: 'dist', staticDir: 'static', ...configOverrides,
  });

  let scanned;
  try {
    scanned = scanContent(cwd, config);
  } catch {
    scanned = null;
  }
  if (!scanned || !Array.isArray(scanned.pages) || scanned.pages.length === 0) {
    scanned = scanContent({ ...config, contentDir: `${cwd}/content` });
  }
  assert.ok(scanned && Array.isArray(scanned.pages), 'scanContent returned no pages array');

  return {
    cwd,
    pages: scanned.pages,
    meta: scanned.meta,
    diagnostics: scanned.diagnostics || [],
    nav: buildNav(scanned.pages, scanned.meta, config),
  };
}

/**
 * A minimal `PageSource` carrying exactly the properties SPEC §6 documents.
 * @param {string} file path under `content/`
 * @param {string} route
 * @param {object} [frontmatter]
 * @returns {object}
 */
function specPage(file, route, frontmatter = {}) {
  const slash = file.lastIndexOf('/');
  const dirPart = slash >= 0 ? file.slice(0, slash) : '';
  return {
    file: `content/${file}`,
    route,
    source: '',
    frontmatter,
    depth: routeSegments(route).length,
    dir: dirPart ? `/${dirPart}/` : '/',
    isIndex: /(^|\/)index\.md$/.test(file),
  };
}

/**
 * Every route in a NavNode tree, depth first.
 * @param {object[]} tree
 * @returns {Array<string|null>}
 */
function treeRoutes(tree) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      out.push(node.route);
      walk(node.children || []);
    }
  };
  walk(tree || []);
  return out;
}

/**
 * `{ href, text }` for every `a.nav-link` inside the rendered sidebar tree.
 * @param {string} html a full page document
 * @returns {Array<{ href: string, text: string }>}
 */
function navEntries(html) {
  const start = html.indexOf('nav-tree');
  if (start < 0) return [];
  const end = html.indexOf('</nav>', start);
  const region = html.slice(start, end < 0 ? html.length : end);
  const out = [];
  for (const m of region.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    if (!/class="[^"]*\bnav-link\b/.test(m[1])) continue;
    const href = (/\shref="([^"]*)"/.exec(m[1]) || [])[1] || '';
    out.push({ href, text: m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// file -> route
// ---------------------------------------------------------------------------

test('filePathToRoute maps content paths to routes', async () => {
  const filePathToRoute = await findExport('filePathToRoute', 'content/route.js');
  const cases = [
    ['index.md', '/'],
    ['guide.md', '/guide/'],
    ['guide/index.md', '/guide/'],
    ['guide/install.md', '/guide/install/'],
    ['guide/advanced/tuning.md', '/guide/advanced/tuning/'],
    ['reference/api.markdown', '/reference/api/'],
  ];
  for (const [file, route] of cases) {
    assert.equal(filePathToRoute(file), route, `filePathToRoute(${JSON.stringify(file)})`);
  }
});

test('numeric filename prefixes are stripped from the route', async () => {
  const filePathToRoute = await findExport('filePathToRoute', 'content/route.js');
  assert.equal(filePathToRoute('01-intro.md'), '/intro/');
  assert.equal(filePathToRoute('guide/02-install.md'), '/guide/install/');
  assert.equal(filePathToRoute('10-advanced/03-tuning.md'), '/advanced/tuning/');
});

test('routeToOutputPath honours cleanUrls and section indexes', () => {
  assert.equal(routeToOutputPath('/'), 'index.html');
  assert.equal(routeToOutputPath('/guide/install/'), 'guide/install/index.html');
  assert.equal(routeToOutputPath('/guide/install/', { cleanUrls: false }), 'guide/install.html');
  assert.equal(routeToOutputPath('/guide/', { cleanUrls: false, isIndex: true }), 'guide/index.html');
});

test('depthOfRoute counts the ../ hops back to the site root', () => {
  assert.equal(depthOfRoute('/'), 0);
  assert.equal(depthOfRoute('/guide/'), 1);
  assert.equal(depthOfRoute('/a/b/c/'), 3);
  assert.equal(depthOfRoute('/guide/install/', { cleanUrls: false }), 1);
});

// ---------------------------------------------------------------------------
// Title humanisation -- SPEC §7b step 4
// ---------------------------------------------------------------------------

test('humanizeName title-cases a filename', async () => {
  const humanizeName = await findExport('humanizeName', 'content/route.js', 'content/nav.js');
  const cases = [
    ['install', 'Install'],
    ['getting-started', 'Getting Started'],
    ['getting_started', 'Getting Started'],
    ['tethered-boot', 'Tethered Boot'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(humanizeName(input), expected, `humanizeName(${JSON.stringify(input)})`);
  }
});

test('humanizeName upper-cases the known acronyms', async () => {
  const humanizeName = await findExport('humanizeName', 'content/route.js', 'content/nav.js');
  const cases = [
    ['api', 'API'],
    ['cli-usage', 'CLI Usage'],
    ['json-schema', 'JSON Schema'],
    ['usb-gadget-mode', 'USB Gadget Mode'],
    ['http-status-codes', 'HTTP Status Codes'],
    ['faq', 'FAQ'],
    ['os-io-ram', 'OS IO RAM'],
    ['ui-ux', 'UI UX'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(humanizeName(input), expected, `humanizeName(${JSON.stringify(input)})`);
  }
});

test('humanizeName preserves ALL-CAPS tokens and strips numeric prefixes', async () => {
  const humanizeName = await findExport('humanizeName', 'content/route.js', 'content/nav.js');
  assert.equal(humanizeName('README'), 'README');
  assert.equal(humanizeName('SPEC-notes'), 'SPEC Notes');
  assert.equal(humanizeName('01-intro'), 'Intro');
  assert.equal(humanizeName('02-usb-pci'), 'USB PCI');
});

// ---------------------------------------------------------------------------
// buildNav -- ordering, prev/next, breadcrumbs
// ---------------------------------------------------------------------------

/**
 * @param {string} title
 * @param {object} [frontmatter]
 * @returns {string}
 */
function md(title, frontmatter = {}) {
  const entries = Object.entries({ title, ...frontmatter });
  return `---\n${entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n# ${title}\n\nBody text.\n`;
}

test('nav falls back to alphabetical order with index.md first', async () => {
  const { nav } = await scanAndBuildNav({
    'content/index.md': md('Home'),
    'content/zebra.md': md('Zebra'),
    'content/alpha.md': md('Alpha'),
    'content/guide/index.md': md('Guide'),
    'content/guide/install.md': md('Install'),
  });
  const routes = nav.flat.map((p) => p.route).filter(Boolean);
  assert.deepEqual(routes, ['/', '/alpha/', '/guide/', '/guide/install/', '/zebra/']);
});

test('frontmatter `order` beats alphabetical order', async () => {
  const { nav } = await scanAndBuildNav({
    'content/index.md': md('Home', { order: 0 }),
    'content/alpha.md': md('Alpha', { order: 30 }),
    'content/bravo.md': md('Bravo', { order: 20 }),
    'content/charlie.md': md('Charlie', { order: 10 }),
  });
  const routes = nav.flat.map((p) => p.route).filter(Boolean);
  assert.deepEqual(routes, ['/', '/charlie/', '/bravo/', '/alpha/']);
});

test('`nav: false` builds the page but keeps it out of the sidebar tree', async () => {
  const { nav, pages } = await scanAndBuildNav({
    'content/index.md': md('Home'),
    'content/shown.md': md('Shown'),
    'content/hidden.md': md('Hidden', { nav: false }),
  });
  assert.ok(
    pages.some((p) => p.route === '/hidden/'),
    'nav:false must still build the page',
  );
  assert.ok(!treeRoutes(nav.tree).includes('/hidden/'), 'nav:false page appeared in the tree');
  assert.ok(treeRoutes(nav.tree).includes('/shown/'));
});

test('prev/next threads the whole tree in reading order', async () => {
  const { nav } = await scanAndBuildNav({
    'content/index.md': md('Home'),
    'content/guide/index.md': md('Guide'),
    'content/guide/config.md': md('Config'),
    'content/guide/install.md': md('Install'),
    'content/reference/index.md': md('Reference'),
  });

  const home = nav.prevNext.get('/');
  assert.equal(home.prev, null);
  assert.equal(home.next.route, '/guide/');

  const install = nav.prevNext.get('/guide/install/');
  assert.equal(install.prev.route, '/guide/config/');
  assert.equal(install.next.route, '/reference/');

  const last = nav.prevNext.get('/reference/');
  assert.equal(last.prev.route, '/guide/install/');
  assert.equal(last.next, null);
});

test('breadcrumbs list the ancestors of a route, not the route itself', async () => {
  const { nav } = await scanAndBuildNav({
    'content/index.md': md('Home'),
    'content/guide/index.md': md('Guide'),
    'content/guide/advanced/index.md': md('Advanced'),
    'content/guide/advanced/tuning.md': md('Tuning'),
  });

  // SPEC §7 shows crumbs for `/guide/install/` as [Home, Guide] -- ancestors only.
  assert.deepEqual(
    nav.crumbs.get('/guide/advanced/tuning/').map((c) => [c.title, c.route]),
    [['Home', '/'], ['Guide', '/guide/'], ['Advanced', '/guide/advanced/']],
  );
  // SPEC.md does not say whether the root keeps a self-crumb, so only "no ancestors" is
  // asserted here.
  const rootCrumbs = nav.crumbs.get('/');
  assert.ok(rootCrumbs.length <= 1);
  for (const crumb of rootCrumbs) assert.equal(crumb.route, '/');
});

test('NavNode carries title, route, children and depth', async () => {
  const { nav } = await scanAndBuildNav({
    'content/index.md': md('Home'),
    'content/guide/index.md': md('Guide'),
    'content/guide/install.md': md('Install'),
  });
  const group = treeNodeFor(nav.tree, '/guide/');
  assert.ok(group, 'no nav node for /guide/');
  assert.equal(group.title, 'Guide');
  assert.equal(typeof group.depth, 'number');
  assert.ok(Array.isArray(group.children));
  assert.deepEqual(group.children.map((c) => c.route), ['/guide/install/']);
});

test('buildNav accepts a PageSource carrying only the properties SPEC §6 documents', async () => {
  const { buildNav } = await loadSrc('content/nav.js');
  const pages = [
    specPage('index.md', '/', { title: 'Home' }),
    specPage('guide/index.md', '/guide/', { title: 'Guide' }),
    specPage('guide/install.md', '/guide/install/', { title: 'Install' }),
  ];
  const nav = buildNav(pages, new Map(), testConfig());
  assert.deepEqual(
    nav.flat.map((p) => p.route).filter(Boolean),
    ['/', '/guide/', '/guide/install/'],
  );
});

/**
 * @param {object[]} tree
 * @param {string} route
 * @returns {object|null}
 */
function treeNodeFor(tree, route) {
  for (const node of tree || []) {
    if (node.route === route) return node;
    const found = treeNodeFor(node.children || [], route);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Whole-site behaviour: _meta.json, exclusions, NAV001/NAV002
// ---------------------------------------------------------------------------

test('_meta.json `order` places listed files first, unlisted ones follow alphabetically', async () => {
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\nWelcome.\n',
    'content/_meta.json': JSON.stringify({ order: ['intro.md', 'install.md'] }),
    'content/intro.md': '# Intro\n\nText.\n',
    'content/install.md': '# Install\n\nText.\n',
    'content/aardvark.md': '# Aardvark\n\nText.\n',
    'content/zulu.md': '# Zulu\n\nText.\n',
  }, { base: '/' });

  const links = navEntries(site.read('index.html')).map((l) => l.href);
  const at = (href) => links.indexOf(href);
  assert.ok(at('/intro/') >= 0, `no sidebar link for /intro/ (saw ${links.join(', ')})`);
  assert.ok(at('/intro/') < at('/install/'), '_meta.json order was not honoured');
  assert.ok(at('/install/') < at('/aardvark/'), 'unlisted files must follow listed ones');
  assert.ok(at('/aardvark/') < at('/zulu/'), 'unlisted files must be alphabetical');
});

// SPEC 7b fixes the title chain as: frontmatter `title` -> first H1 -> `_meta.json`
// `titles` -> humanised filename. `titles` therefore names files that supply no title of
// their own; it does not override an H1. This test asserts that documented order rather
// than the stronger "titles wins over everything" reading it originally encoded.
test('_meta.json supplies folder titles and titles for files with no title of their own', async () => {
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\nWelcome.\n',
    'content/guide/_meta.json': JSON.stringify({
      title: 'User Guide',
      titles: { 'faq.md': 'FAQs', 'notes.md': 'Release Notes' },
    }),
    'content/guide/index.md': '# Guide\n\nText.\n',
    'content/guide/faq.md': 'Text with no heading.\n',
    'content/guide/notes.md': '# Changelog\n\nText.\n',
  }, { base: '/' });

  const html = site.read('index.html');
  assert.match(html, /User Guide/);

  const entries = navEntries(html);
  const faq = entries.find((l) => l.href === '/guide/faq/');
  assert.ok(faq, 'no sidebar link for /guide/faq/');
  assert.equal(faq.text, 'FAQs', '_meta.json `titles` did not supply the title');

  const notes = entries.find((l) => l.href === '/guide/notes/');
  assert.ok(notes, 'no sidebar link for /guide/notes/');
  assert.equal(notes.text, 'Changelog', 'an H1 must outrank _meta.json `titles` (SPEC 7b)');
});

test('_meta.json `hidden` keeps a folder out of the sidebar', async () => {
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\nWelcome.\n',
    'content/internal/_meta.json': JSON.stringify({ hidden: true }),
    'content/internal/index.md': '# Internal\n\nText.\n',
    'content/public/index.md': '# Public\n\nText.\n',
  }, { base: '/' });

  const links = navEntries(site.read('index.html')).map((l) => l.href);
  assert.ok(!links.includes('/internal/'), `hidden folder appeared in the sidebar: ${links.join(', ')}`);
  assert.ok(links.includes('/public/'));
});

test('draft pages and underscore-prefixed paths are excluded from the build', async () => {
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\nWelcome.\n',
    'content/published.md': '# Published\n\nText.\n',
    'content/wip.md': '---\ntitle: WIP\ndraft: true\n---\n\n# WIP\n\nText.\n',
    'content/_scratch.md': '# Scratch\n\nText.\n',
    'content/_private/notes.md': '# Notes\n\nText.\n',
  }, { base: '/' });

  assert.ok(site.exists('published/index.html'));
  assert.ok(!site.exists('wip/index.html'), 'a draft page was emitted');
  assert.ok(!site.exists('scratch/index.html'), 'an underscore-prefixed file was emitted');
  assert.ok(!site.exists('_private/notes/index.html'), 'an underscore-prefixed folder was emitted');

  const links = navEntries(site.read('index.html')).map((l) => l.href);
  assert.ok(!links.includes('/wip/'));
  assert.ok(!links.includes('/scratch/'));
});

test('numeric prefixes are stripped from routes and titles in a real build', async () => {
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\nWelcome.\n',
    'content/01-intro.md': 'Intro body without a heading.\n',
    'content/02-install.md': 'Install body without a heading.\n',
  }, { base: '/' });

  assert.ok(site.exists('intro/index.html'), 'route was not stripped of its numeric prefix');
  assert.ok(site.exists('install/index.html'));
  assert.ok(!site.exists('01-intro/index.html'));

  const links = navEntries(site.read('index.html'));
  const intro = links.find((l) => l.href === '/intro/');
  assert.ok(intro, 'no sidebar link for /intro/');
  assert.equal(intro.text, 'Intro');
  // Numeric prefixes also drive the order.
  const hrefs = links.map((l) => l.href);
  assert.ok(hrefs.indexOf('/intro/') < hrefs.indexOf('/install/'));
});

test('NAV001: two files that map to the same route are an error', async () => {
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\nWelcome.\n',
    'content/guide.md': '# Guide\n\nText.\n',
    'content/guide/index.md': '# Guide Index\n\nText.\n',
  });
  const nav001 = site.result.diagnostics.filter((d) => d.code === 'NAV001');
  assert.ok(nav001.length > 0, 'NAV001 was not reported for a duplicate route');
  assert.equal(nav001[0].severity, 'error');
});

test('NAV002: a folder without index.md still becomes a section with a landing page', async () => {
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\nWelcome.\n',
    'content/orphan/first.md': '# First\n\nText.\n',
    'content/orphan/second.md': '# Second\n\nText.\n',
  }, { base: '/' });

  const nav002 = site.result.diagnostics.filter((d) => d.code === 'NAV002');
  assert.ok(nav002.length > 0, 'NAV002 was not reported for a folder without index.md');
  assert.equal(nav002[0].severity, 'info');

  assert.ok(site.exists('orphan/index.html'), 'no generated section landing page');
  const landing = site.read('orphan/index.html');
  assert.match(landing, /\/orphan\/first\//);
  assert.match(landing, /\/orphan\/second\//);
});

test('a clean tree produces no NAV diagnostics', async () => {
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\nWelcome.\n',
    'content/guide/index.md': '# Guide\n\nText.\n',
    'content/guide/install.md': '# Install\n\nText.\n',
  });
  const nav = site.result.diagnostics.filter((d) => d.code.startsWith('NAV'));
  assert.deepEqual(nav.map((d) => `${d.code} ${d.file}`), []);
});
