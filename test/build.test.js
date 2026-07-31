/**
 * End-to-end build -- SPEC.md §6 (`buildSite`), §7 (SPA contract) and §11.
 *
 * Builds the bundled `content/` into a temp directory and checks the whole product surface:
 * the files that must exist, `verifyHtml` cleanliness of every emitted document, the SPA
 * payload shape, the search index, and -- the ground rule from SPEC §0 -- that a second
 * build produces byte-identical output.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { routeToPayloadPath } from '../src/util/path.js';
import {
  REPO_ROOT, buildTempSite, cleanupTemps, listFiles, loadSrc, silentLogger, tempDir, writeTree,
} from './helpers/harness.js';

after(cleanupTemps);

/** @type {{ outDir: string, result: object, config: object }} */
let built;

/**
 * @param {string} rel
 * @returns {string}
 */
function read(rel) {
  return fs.readFileSync(path.join(built.outDir, ...rel.split('/')), 'utf8');
}

/**
 * @param {string} rel
 * @returns {boolean}
 */
function exists(rel) {
  return fs.existsSync(path.join(built.outDir, ...rel.split('/')));
}

/**
 * Build the repository's own `content/` into a fresh temp directory.
 * @returns {Promise<{ outDir: string, result: object, config: object }>}
 */
async function buildBundled() {
  const outDir = tempDir('md2spa-dist-');
  const { config } = await loadConfig(REPO_ROOT);
  const { buildSite } = await loadSrc('build/build.js');
  const result = await buildSite({
    cwd: REPO_ROOT,
    config: { ...config, outDir },
    logger: silentLogger(),
  });
  return { outDir, result, config };
}

before(async () => {
  const contentDir = path.join(REPO_ROOT, 'content');
  assert.ok(
    fs.existsSync(contentDir),
    'the bundled example site (content/) is missing -- SPEC §1 requires it',
  );
  built = await buildBundled();
});

// ---------------------------------------------------------------------------
// What lands on disk
// ---------------------------------------------------------------------------

test('buildSite returns { files, diagnostics, stats }', () => {
  assert.ok(Array.isArray(built.result.files), 'files must be an array');
  assert.ok(built.result.files.length > 0, 'the build emitted nothing');
  assert.ok(Array.isArray(built.result.diagnostics));
  assert.equal(typeof built.result.stats, 'object');
  assert.ok(built.result.stats !== null);
});

test('the build produces no error-severity diagnostics', () => {
  const errors = built.result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(
    errors.map((d) => `${d.file}:${d.line}:${d.column} ${d.code} ${d.message}`),
    [],
  );
});

test('the expected top-level files exist', () => {
  assert.ok(exists('index.html'), 'no index.html');
  assert.ok(exists('404.html'), 'no 404.html');
  assert.ok(exists('search-index.json'), 'no search-index.json');
  assert.ok(exists('_spa/index.json'), 'no SPA payload for /');

  const assets = listFiles(path.join(built.outDir, 'assets'));
  assert.ok(assets.some((f) => /\.css$/.test(f)), `no CSS asset: ${assets.join(', ')}`);
  assert.ok(assets.some((f) => /\.js$/.test(f)), `no JS asset: ${assets.join(', ')}`);
});

test('asset filenames are content-hashed', () => {
  const assets = listFiles(path.join(built.outDir, 'assets'));
  const hashed = assets.filter((f) => /\.[0-9a-f]{8}\.(css|js)$/.test(f));
  assert.ok(hashed.length >= 2, `expected hashed assets, got ${assets.join(', ')}`);
});

test('sitemap.xml and robots.txt are emitted when siteUrl is configured', () => {
  if (!built.config.siteUrl) {
    // SPEC §2: siteUrl exists "only for canonical/sitemap/og" -- with no siteUrl there is
    // nothing absolute to put in a sitemap, so its absence is correct.
    assert.ok(!exists('sitemap.xml') || read('sitemap.xml').length > 0);
    return;
  }
  assert.ok(exists('sitemap.xml'), 'no sitemap.xml despite a configured siteUrl');
  assert.ok(exists('robots.txt'), 'no robots.txt despite a configured siteUrl');
  assert.match(read('sitemap.xml'), /<urlset/);
  assert.match(read('sitemap.xml'), new RegExp(built.config.siteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ---------------------------------------------------------------------------
// Every emitted document is well-formed
// ---------------------------------------------------------------------------

test('every emitted HTML document passes verifyHtml', async () => {
  const { verifyHtml } = await loadSrc('build/verify.js');
  const pages = listFiles(built.outDir).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length > 0, 'no HTML was emitted');

  const failures = [];
  for (const page of pages) {
    const diagnostics = verifyHtml(read(page), page);
    for (const d of diagnostics) failures.push(`${page}:${d.line} ${d.code} ${d.message}`);
  }
  assert.deepEqual(failures, []);
});

test('verifyHtml actually rejects broken HTML', async () => {
  const { verifyHtml } = await loadSrc('build/verify.js');
  const broken = '<!doctype html><html lang="en"><head><title>x</title></head>'
    + '<body><div id="a"></div><div id="a"><p>unclosed</body></html>';
  const diagnostics = verifyHtml(broken, 'broken.html');
  assert.ok(diagnostics.length > 0, 'verifyHtml accepted duplicate ids and an unclosed tag');
  assert.ok(diagnostics.every((d) => d.code === 'HTM001'), 'verifyHtml must report HTM001');
});

test('every page carries the required document furniture', () => {
  for (const page of listFiles(built.outDir).filter((f) => f.endsWith('.html'))) {
    const html = read(page);
    assert.match(html, /^<!doctype html>/i, `${page} has no doctype`);
    assert.match(html, /<html\b[^>]*\slang="/, `${page} has no lang`);
    assert.match(html, /<meta charset="utf-8">/i, `${page} has no charset`);
    assert.match(html, /<meta name="viewport"/i, `${page} has no viewport`);
    assert.match(html, /<title>[\s\S]*?<\/title>/, `${page} has no title`);
    assert.match(html, /class="skip-link"/, `${page} has no skip link`);
  }
});

test('the pre-rendered page is complete with JavaScript disabled', () => {
  const html = read('index.html');
  assert.match(html, /<article class="md"/, 'no pre-rendered <article class="md">');
  assert.match(html, /class="nav-tree"/, 'no pre-rendered sidebar');
});

// ---------------------------------------------------------------------------
// SPA payloads -- SPEC §7
// ---------------------------------------------------------------------------

test('every emitted page has a matching SPA payload', () => {
  const pages = listFiles(built.outDir)
    .filter((f) => f.endsWith('.html') && f !== '404.html');
  assert.ok(pages.length > 0);

  const payloads = new Set(
    listFiles(path.join(built.outDir, '_spa')).filter((f) => f.endsWith('.json')),
  );
  for (const page of pages) {
    const route = `/${page.replace(/index\.html$/, '').replace(/\.html$/, '/')}`;
    const name = routeToPayloadPath(route).replace(/^_spa\//, '');
    assert.ok(payloads.has(name), `no SPA payload ${name} for ${page}`);
  }
});

test('SPA payloads parse and match the SPEC §7 shape', () => {
  const names = listFiles(path.join(built.outDir, '_spa')).filter((f) => f.endsWith('.json'));
  assert.ok(names.length > 0, 'no SPA payloads were emitted');

  for (const name of names) {
    const payload = JSON.parse(read(`_spa/${name}`));
    const where = `_spa/${name}`;

    assert.equal(typeof payload.route, 'string', `${where}: route`);
    assert.ok(
      payload.route.startsWith('/') && payload.route.endsWith('/'),
      `${where}: route must be a normalised route, got ${payload.route}`,
    );
    assert.equal(typeof payload.title, 'string', `${where}: title`);
    assert.equal(typeof payload.description, 'string', `${where}: description`);
    assert.equal(typeof payload.html, 'string', `${where}: html`);
    assert.match(payload.html, /^<article class="md"/, `${where}: html must be the article`);

    assert.ok(Array.isArray(payload.toc), `${where}: toc`);
    for (const item of payload.toc) {
      assert.equal(typeof item.id, 'string');
      assert.equal(typeof item.text, 'string');
      assert.equal(typeof item.depth, 'number');
      assert.ok(Array.isArray(item.children));
    }

    assert.ok(Array.isArray(payload.crumbs), `${where}: crumbs`);
    for (const crumb of payload.crumbs) {
      assert.equal(typeof crumb.title, 'string');
      assert.equal(typeof crumb.route, 'string');
    }

    for (const key of ['prev', 'next']) {
      const value = payload[key];
      assert.ok(value === null || typeof value === 'object', `${where}: ${key}`);
      if (value) {
        assert.equal(typeof value.title, 'string', `${where}: ${key}.title`);
        assert.equal(typeof value.route, 'string', `${where}: ${key}.route`);
      }
    }

    assert.ok(
      payload.editUrl === null || typeof payload.editUrl === 'string',
      `${where}: editUrl`,
    );
    assert.equal(typeof payload.hash, 'string', `${where}: hash`);
    assert.match(payload.hash, /^[0-9a-f]{8}$/, `${where}: hash must be an 8-char content hash`);
  }
});

test('the payload for / is named index.json and describes the home route', () => {
  const payload = JSON.parse(read('_spa/index.json'));
  assert.equal(payload.route, '/');
  assert.equal(payload.prev, null);
  // SPEC §7 shows crumbs as the *ancestors* of a route. The root has no ancestors, but
  // SPEC.md does not say whether the home page keeps a self-crumb, so both are allowed.
  assert.ok(payload.crumbs.length <= 1, 'the home page cannot have ancestors');
  for (const crumb of payload.crumbs) assert.equal(crumb.route, '/');
});

test('a payload html body matches the pre-rendered article on the page', () => {
  const payload = JSON.parse(read('_spa/index.json'));
  const page = read('index.html');
  assert.ok(
    page.includes(payload.html),
    'the SPA payload html is not byte-identical to the pre-rendered article',
  );
});

// ---------------------------------------------------------------------------
// Search index
// ---------------------------------------------------------------------------

/**
 * SPEC §7 names `search-index.json` and the things the runtime scores (title > headings >
 * body) but pins neither the envelope nor the field names -- short keys are a legitimate
 * payload-size choice. This normalises both spellings so the *shape* is what is asserted.
 *
 * @param {unknown} raw parsed search-index.json
 * @returns {Array<{ route: unknown, title: unknown, body: unknown, headings: unknown }>}
 */
function searchRecords(raw) {
  const docs = Array.isArray(raw)
    ? raw
    : (raw.docs || raw.entries || raw.pages || raw.items || raw.d);
  assert.ok(Array.isArray(docs), `search index has no record array: ${Object.keys(raw)}`);
  return docs.map((doc) => ({
    route: doc.route ?? doc.r ?? doc.url,
    title: doc.title ?? doc.t,
    body: doc.text ?? doc.body ?? doc.content ?? doc.b,
    headings: doc.headings ?? doc.h,
  }));
}

test('the search index parses and has one record per page', () => {
  const records = searchRecords(JSON.parse(read('search-index.json')));
  assert.ok(records.length > 0, 'search index is empty');

  for (const doc of records) {
    assert.equal(typeof doc.route, 'string', 'each record needs a route');
    assert.ok(
      doc.route.startsWith('/') && doc.route.endsWith('/'),
      `search record route is not normalised: ${doc.route}`,
    );
    assert.equal(typeof doc.title, 'string', 'each record needs a title');
    assert.equal(typeof doc.body, 'string', `record for ${doc.route} has no body text`);
    if (doc.headings !== undefined) {
      assert.ok(Array.isArray(doc.headings), `record for ${doc.route} has non-array headings`);
    }
  }

  const routes = new Set(records.map((d) => d.route));
  assert.ok(routes.has('/'), 'the home page is missing from the search index');
});

test('the search index carries no HTML markup', () => {
  const raw = read('search-index.json');
  assert.ok(!/<article|<h[1-6]\b|<script/.test(raw), 'HTML leaked into the search index');
});

// ---------------------------------------------------------------------------
// Determinism -- SPEC §0
// ---------------------------------------------------------------------------

test('a second build produces byte-identical output', async () => {
  const second = await buildBundled();

  const a = listFiles(built.outDir);
  const b = listFiles(second.outDir);
  assert.deepEqual(b, a, 'the two builds emitted different file lists');

  const differing = [];
  for (const rel of a) {
    const left = fs.readFileSync(path.join(built.outDir, ...rel.split('/')));
    const right = fs.readFileSync(path.join(second.outDir, ...rel.split('/')));
    if (!left.equals(right)) differing.push(rel);
  }
  assert.deepEqual(differing, [], 'these files are not reproducible');
});

test('no absolute build path leaks into the output', () => {
  for (const rel of listFiles(built.outDir)) {
    if (!/\.(html|json|xml|txt|css|js)$/.test(rel)) continue;
    const text = read(rel);
    assert.ok(!text.includes(built.outDir), `${rel} embeds the output directory path`);
    assert.ok(!text.includes(REPO_ROOT), `${rel} embeds the repository path`);
  }
});

// ---------------------------------------------------------------------------
// Config diagnostics -- CFG001 / CFG002 / CFG003 (SPEC §5)
// ---------------------------------------------------------------------------

test('CFG002: an unknown config key is a warning', async () => {
  const cwd = tempDir('md2spa-cfg-');
  writeTree(cwd, {
    'md2spa.config.json': JSON.stringify({ title: 'X', notARealKey: true }),
    'content/index.md': '# Home\n',
  });
  const { diagnostics } = await loadConfig(cwd);
  const hits = diagnostics.filter((d) => d.code === 'CFG002');
  assert.ok(hits.length > 0, 'CFG002 was not reported');
  assert.equal(hits[0].severity, 'warning');
});

test('CFG001: a type mismatch is an error', async () => {
  const cwd = tempDir('md2spa-cfg-');
  writeTree(cwd, {
    'md2spa.config.json': JSON.stringify({ title: 'X', cleanUrls: 'yes' }),
    'content/index.md': '# Home\n',
  });
  const { diagnostics } = await loadConfig(cwd);
  const hits = diagnostics.filter((d) => d.code === 'CFG001');
  assert.ok(hits.length > 0, 'CFG001 was not reported');
  assert.equal(hits[0].severity, 'error');
});

test('CFG003: a missing contentDir is an error', async () => {
  const cwd = tempDir('md2spa-cfg-');
  writeTree(cwd, { 'md2spa.config.json': JSON.stringify({ title: 'X' }) });
  const { diagnostics } = await loadConfig(cwd);
  const hits = diagnostics.filter((d) => d.code === 'CFG003');
  assert.ok(hits.length > 0, 'CFG003 was not reported');
  assert.equal(hits[0].severity, 'error');
});

test('a valid config produces no diagnostics', async () => {
  const cwd = tempDir('md2spa-cfg-');
  writeTree(cwd, {
    'md2spa.config.json': JSON.stringify({ title: 'X', base: 'auto', toc: { minDepth: 2 } }),
    'content/index.md': '# Home\n',
  });
  const { diagnostics } = await loadConfig(cwd);
  assert.deepEqual(diagnostics.map((d) => `${d.code} ${d.message}`), []);
});

// ---------------------------------------------------------------------------------------
// SPA payload paths must be injective. A flattened stem used to collapse `/a/b/` onto
// `/a__b/` and to sanitise every non-ASCII route down to the empty string, so one page's
// content was served under another page's URL -- silently, with a clean build.
// ---------------------------------------------------------------------------------------

test('routes that a flattened payload stem would collide are kept distinct', async () => {
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n',
    'content/a__b.md': '---\ntitle: Underscored\n---\n\n# Underscored\n\nSENTINEL-UNDERSCORED\n',
    'content/a/b.md': '---\ntitle: Nested\n---\n\n# Nested\n\nSENTINEL-NESTED\n',
    'content/a.b.md': '---\ntitle: Dotted\n---\n\n# Dotted\n\nSENTINEL-DOTTED\n',
    'content/a-b.md': '---\ntitle: Hyphenated\n---\n\n# Hyphenated\n\nSENTINEL-HYPHENATED\n',
  });

  const expected = {
    '_spa/a__b/index.json': 'SENTINEL-UNDERSCORED',
    '_spa/a/b/index.json': 'SENTINEL-NESTED',
    '_spa/a.b/index.json': 'SENTINEL-DOTTED',
    '_spa/a-b/index.json': 'SENTINEL-HYPHENATED',
  };

  for (const [file, sentinel] of Object.entries(expected)) {
    assert.ok(site.exists(file), `missing payload ${file}`);
    const payload = JSON.parse(site.read(file));
    assert.ok(
      payload.html.includes(sentinel),
      `${file} carries the wrong page's content (expected ${sentinel})`,
    );
  }
});

test('non-ASCII routes get their own payload rather than sharing one empty stem', async () => {
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n',
    'content/日本.md': '---\ntitle: Japanese\n---\n\n# Japanese\n\nSENTINEL-JA\n',
    'content/한국.md': '---\ntitle: Korean\n---\n\n# Korean\n\nSENTINEL-KO\n',
  });

  assert.ok(!site.exists('_spa/.json'), 'non-ASCII routes collapsed onto a single payload');

  const ja = JSON.parse(site.read('_spa/日本/index.json'));
  const ko = JSON.parse(site.read('_spa/한국/index.json'));
  assert.ok(ja.html.includes('SENTINEL-JA'), 'Japanese payload has the wrong content');
  assert.ok(ko.html.includes('SENTINEL-KO'), 'Korean payload has the wrong content');
  assert.equal(ja.route, '/日本/');
  assert.equal(ko.route, '/한국/');
});

test('the payload path the client derives matches the file the build wrote', async () => {
  const { internals } = await import('../src/theme/app.js');
  const { routeToPayloadPath } = await import('../src/util/path.js');
  for (const route of ['/', '/a/', '/a/b/', '/a/b/c/', '/a__b/', '/日本/']) {
    assert.equal(
      internals.payloadPathFor(route),
      routeToPayloadPath(route),
      `client and build disagree on the payload path for ${route}`,
    );
  }
});

// ---------------------------------------------------------------------------------------
// The generator and the browser runtime have to agree on the search-index field names.
// `build/search.js` emits the compact `{ v, docs: [{ r, t, d, h, b }] }` shape; when
// `prepareIndex` only understood `{ pages: [...] }` it read zero documents and search
// silently returned nothing on every build, with no error anywhere.
// ---------------------------------------------------------------------------------------

test('the browser runtime can read the search index the build emits', async () => {
  const { internals } = await import('../src/theme/app.js');
  const raw = JSON.parse(read('search-index.json'));

  const prepared = internals.prepareIndex(raw);
  assert.ok(Array.isArray(prepared), 'prepareIndex did not return an array');
  assert.equal(
    prepared.length,
    raw.docs.length,
    'prepareIndex dropped documents -- the runtime and the generator disagree on field names',
  );

  for (const entry of prepared) {
    assert.equal(typeof entry.title, 'string');
    assert.ok(entry.title.length > 0, `entry for ${entry.route} has no title`);
    assert.ok(entry.route.startsWith('/') && entry.route.endsWith('/'));
  }
});

test('searching for a term in the bundled docs returns the right page first', async () => {
  const { internals } = await import('../src/theme/app.js');
  const prepared = internals.prepareIndex(JSON.parse(read('search-index.json')));

  for (const [query, expected] of [['admonition', 'Admonitions'], ['gitlab pages', 'GitLab Pages']]) {
    const tokens = internals.tokenize(query);
    const ranked = prepared
      .map((entry) => ({ title: entry.title, score: internals.scoreEntry(entry, tokens) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);

    assert.ok(ranked.length > 0, `"${query}" returned no results`);
    assert.equal(ranked[0].title, expected, `"${query}" ranked the wrong page first`);
  }
});

// ---------------------------------------------------------------------------------------
// Images. Three sourcing styles have to work, and the co-located one is the trap: MD046
// validates the file exists in the *source* tree, so failing to copy it to the output
// produces a clean build and a broken image.
// ---------------------------------------------------------------------------------------

test('images resolve whether they are remote, in static/, or beside the Markdown', async () => {
  const png = '\x89PNG\r\n\x1a\n';
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\n'
      + '![remote](https://example.com/remote.png)\n\n'
      + '![from static](/media/logo.png)\n',
    'content/guide/index.md': '---\ntitle: Guide\n---\n\n# Guide\n\n'
      + '![co-located](assets/diagram.png)\n\n'
      + '![parent-relative](../shared/banner.png)\n',
    'content/guide/assets/diagram.png': png,
    'content/shared/banner.png': png,
    'static/media/logo.png': png,
  });

  // Every asset reaches the output tree, at the path the markup points at.
  for (const file of ['guide/assets/diagram.png', 'shared/banner.png', 'media/logo.png']) {
    assert.ok(site.exists(file), `asset was not copied to the output: ${file}`);
  }

  const home = site.read('index.html');
  assert.match(home, /src="https:\/\/example\.com\/remote\.png"/,
    'a remote image URL was rewritten; it must pass through untouched');
  assert.match(home, /src="media\/logo\.png"/, 'static asset URL is wrong at depth 0');

  // Resolve each <img src> the way a browser would and confirm the file is really there.
  const guide = site.read('guide/index.html');
  const srcs = [...guide.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 2, 'expected two images on the guide page');

  for (const src of srcs) {
    if (/^https?:/.test(src)) continue;
    const resolved = path.normalize(path.join(site.outDir, 'guide', src));
    assert.ok(fs.existsSync(resolved), `<img src="${src}"> does not resolve to a real file`);
  }
});

test('a missing image is reported rather than shipped', async () => {
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\n![gone](assets/missing.png)\n',
  });
  const codes = site.result.diagnostics.map((d) => d.code);
  assert.ok(codes.includes('MD046'), `expected MD046 for a missing asset, got: ${codes.join(', ')}`);
});
