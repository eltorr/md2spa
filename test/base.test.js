/**
 * Base-path resolution -- SPEC.md §3, "deploy anywhere".
 *
 * Three modes (`auto`, `/`, `/prefix/`) x three depths (0, 1, 3). Every URL the layout
 * emits goes through a single `url()` helper, so if any one of these nine combinations is
 * wrong the site breaks on GitLab/GitHub Pages, in a subfolder, or over `file://`.
 *
 * Assertions are on exact strings, with the 8-hex content hash normalised to `<hash>`.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { buildTempSite, cleanupTemps } from './helpers/harness.js';

after(cleanupTemps);

/**
 * A tree with a page at depth 0, 1 and 3, each linking across the tree so the page-URL
 * side of `url()` is exercised as well as the asset side.
 */
const TREE = {
  'content/index.md': [
    '---', 'title: Home', '---', '',
    '# Home', '',
    'Go to [ToGuide](guide/index.md) or [ToDeep](a/b/c/index.md).', '',
  ].join('\n'),
  'content/guide/index.md': [
    '---', 'title: Guide', '---', '',
    '# Guide', '',
    'Go to [ToHome](../index.md) or [ToDeep](../a/b/c/index.md).', '',
  ].join('\n'),
  'content/a/index.md': '---\ntitle: A\n---\n\n# A\n\nText.\n',
  'content/a/b/index.md': '---\ntitle: B\n---\n\n# B\n\nText.\n',
  'content/a/b/c/index.md': [
    '---', 'title: C', '---', '',
    '# C', '',
    'Go to [ToHome](../../../index.md) or [ToGuide](../../../guide/index.md).', '',
  ].join('\n'),
};

/** Content-hash placeholder so exact-string assertions stay stable across runs. */
const HASH = /\.[0-9a-f]{8}\./;

/**
 * @param {string} url
 * @returns {string}
 */
function normalizeHash(url) {
  return url.replace(HASH, '.<hash>.');
}

/**
 * The `href` of the document's stylesheet `<link>`.
 * @param {string} html
 * @returns {string}
 */
function stylesheetHref(html) {
  for (const m of html.matchAll(/<link\b([^>]*)>/g)) {
    if (!/rel="stylesheet"/.test(m[1])) continue;
    const href = /\shref="([^"]*)"/.exec(m[1]);
    if (href) return href[1];
  }
  assert.fail(`no stylesheet <link> in the document:\n${html.slice(0, 600)}`);
  return '';
}

/**
 * The `src` of the SPA runtime `<script>`.
 * @param {string} html
 * @returns {string|null}
 */
function scriptSrc(html) {
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
    const src = /\ssrc="([^"]*)"/.exec(m[1]);
    if (src) return src[1];
  }
  return null;
}

/**
 * The `href` of the body link whose text is `label`.
 * @param {string} html
 * @param {string} label
 * @returns {string}
 */
function linkHref(html, label) {
  const m = new RegExp(`<a\\b([^>]*)>${label}(?:<[^>]*>)*</a>`).exec(html);
  assert.ok(m, `no anchor with text ${label}`);
  const href = /\shref="([^"]*)"/.exec(m[1]);
  assert.ok(href, `anchor ${label} has no href`);
  return href[1];
}

/**
 * The attribute string of the `<html>` element.
 * @param {string} html
 * @returns {string}
 */
function htmlAttrs(html) {
  const m = /<html\b([^>]*)>/.exec(html);
  assert.ok(m, 'no <html> element');
  return m[1];
}

/** @type {Record<string, Awaited<ReturnType<typeof buildTempSite>>>} */
const sites = {};

before(async () => {
  sites.auto = await buildTempSite(TREE, { base: 'auto' });
  sites.root = await buildTempSite(TREE, { base: '/' });
  sites.prefix = await buildTempSite(TREE, { base: '/prefix/' });
});

// ---------------------------------------------------------------------------
// base: "auto" -- document-relative
// ---------------------------------------------------------------------------

test('auto @ depth 0: assets and page links are relative to the document', () => {
  const html = sites.auto.read('index.html');
  assert.equal(normalizeHash(stylesheetHref(html)), 'assets/style.<hash>.css');
  assert.equal(linkHref(html, 'ToGuide'), 'guide/');
  assert.equal(linkHref(html, 'ToDeep'), 'a/b/c/');
  assert.match(htmlAttrs(html), /\sdata-depth="0"/);
});

test('auto @ depth 1: one ../ hop', () => {
  const html = sites.auto.read('guide/index.html');
  assert.equal(normalizeHash(stylesheetHref(html)), '../assets/style.<hash>.css');
  assert.equal(linkHref(html, 'ToHome'), '../');
  assert.equal(linkHref(html, 'ToDeep'), '../a/b/c/');
  assert.match(htmlAttrs(html), /\sdata-depth="1"/);
});

test('auto @ depth 3: three ../ hops', () => {
  const html = sites.auto.read('a/b/c/index.html');
  assert.equal(normalizeHash(stylesheetHref(html)), '../../../assets/style.<hash>.css');
  assert.equal(linkHref(html, 'ToHome'), '../../../');
  assert.equal(linkHref(html, 'ToGuide'), '../../../guide/');
  assert.match(htmlAttrs(html), /\sdata-depth="3"/);
});

test('auto: no URL the layout emits is root-relative', () => {
  for (const page of ['index.html', 'guide/index.html', 'a/b/c/index.html']) {
    const html = sites.auto.read(page);
    const urls = [
      stylesheetHref(html),
      ...[...html.matchAll(/<script\b[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]),
    ];
    for (const url of urls) {
      assert.ok(
        !url.startsWith('/'),
        `base:"auto" emitted the root-relative URL ${url} in ${page}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// base: "/" -- root-relative, no prefix
// ---------------------------------------------------------------------------

test('base "/" @ depth 0, 1 and 3: identical root-relative URLs everywhere', () => {
  const pages = {
    'index.html': 0,
    'guide/index.html': 1,
    'a/b/c/index.html': 3,
  };
  for (const [page, depth] of Object.entries(pages)) {
    const html = sites.root.read(page);
    assert.equal(
      normalizeHash(stylesheetHref(html)),
      '/assets/style.<hash>.css',
      `stylesheet href in ${page}`,
    );
    assert.match(htmlAttrs(html), new RegExp(`\\sdata-depth="${depth}"`));
    assert.match(htmlAttrs(html), /\sdata-base="\/"/);
  }

  assert.equal(linkHref(sites.root.read('index.html'), 'ToGuide'), '/guide/');
  assert.equal(linkHref(sites.root.read('index.html'), 'ToDeep'), '/a/b/c/');
  assert.equal(linkHref(sites.root.read('guide/index.html'), 'ToHome'), '/');
  assert.equal(linkHref(sites.root.read('a/b/c/index.html'), 'ToGuide'), '/guide/');
  assert.equal(linkHref(sites.root.read('a/b/c/index.html'), 'ToHome'), '/');
});

// ---------------------------------------------------------------------------
// base: "/prefix/" -- root-relative with a prefix
// ---------------------------------------------------------------------------

test('base "/prefix/" @ depth 0, 1 and 3: every URL carries the prefix exactly once', () => {
  const pages = {
    'index.html': 0,
    'guide/index.html': 1,
    'a/b/c/index.html': 3,
  };
  for (const [page, depth] of Object.entries(pages)) {
    const html = sites.prefix.read(page);
    assert.equal(
      normalizeHash(stylesheetHref(html)),
      '/prefix/assets/style.<hash>.css',
      `stylesheet href in ${page}`,
    );
    assert.match(htmlAttrs(html), new RegExp(`\\sdata-depth="${depth}"`));
    assert.match(htmlAttrs(html), /\sdata-base="\/prefix\/"/);
  }

  assert.equal(linkHref(sites.prefix.read('index.html'), 'ToGuide'), '/prefix/guide/');
  assert.equal(linkHref(sites.prefix.read('index.html'), 'ToDeep'), '/prefix/a/b/c/');
  assert.equal(linkHref(sites.prefix.read('guide/index.html'), 'ToHome'), '/prefix/');
  assert.equal(linkHref(sites.prefix.read('a/b/c/index.html'), 'ToGuide'), '/prefix/guide/');
});

test('base "/prefix/" never doubles a slash', () => {
  for (const page of ['index.html', 'guide/index.html', 'a/b/c/index.html']) {
    const html = sites.prefix.read(page);
    for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      assert.ok(!/(?<!:)\/\//.test(m[1]), `doubled slash in ${m[1]} (${page})`);
    }
  }
});

// ---------------------------------------------------------------------------
// The SPA runtime and 404 bootstrap have to agree with the mode
// ---------------------------------------------------------------------------

test('the SPA runtime script is resolved through the same helper', () => {
  const auto = scriptSrc(sites.auto.read('a/b/c/index.html'));
  if (auto !== null) assert.match(auto, /^\.\.\/\.\.\/\.\.\//);

  const root = scriptSrc(sites.root.read('a/b/c/index.html'));
  if (root !== null) assert.match(root, /^\/assets\//);

  const prefix = scriptSrc(sites.prefix.read('a/b/c/index.html'));
  if (prefix !== null) assert.match(prefix, /^\/prefix\/assets\//);
});

test('404.html embeds the route list it needs to find the site base from any depth', () => {
  assert.ok(sites.auto.exists('404.html'), 'no 404.html was emitted');
  const html = sites.auto.read('404.html');
  // SPEC §3: the bootstrap matches the longest known-route suffix of location.pathname
  // against a build-time-embedded route list.
  assert.match(html, /\/guide\//);
  assert.match(html, /\/a\/b\/c\//);
});

test('the SPA payload route matches the page it was generated from, in every mode', () => {
  for (const [mode, site] of Object.entries(sites)) {
    const payload = JSON.parse(site.read('_spa/a/b/c/index.json'));
    assert.equal(payload.route, '/a/b/c/', `payload route in base mode ${mode}`);
  }
});

// ---------------------------------------------------------------------------------------
// Relative URLs must be minimal: a link to an ancestor climbs to it directly rather than
// walking all the way to the site root and descending again. `../../` beats `../../../writing/`.
// ---------------------------------------------------------------------------------------

test('relativeUrl drops the prefix a target shares with the current document', async () => {
  const { relativeUrl, routeToDocDir } = await import('../src/util/path.js');

  const cases = [
    ['/writing/advanced/footnotes/', '/writing/advanced/', '../'],
    ['/writing/advanced/footnotes/', '/writing/', '../../'],
    ['/writing/advanced/footnotes/', '/', '../../../'],
    ['/writing/advanced/footnotes/', '/writing/tables/', '../../tables/'],
    ['/writing/advanced/footnotes/', '/assets/style.css', '../../../assets/style.css'],
    ['/writing/advanced/footnotes/', '/writing/#top', '../../#top'],
    ['/writing/', '/writing/tables/', 'tables/'],
    ['/writing/tables/', '/writing/tables/', './'],
    ['/', '/assets/a.css', 'assets/a.css'],
    ['/', '/', './'],
  ];

  for (const [from, target, expected] of cases) {
    assert.equal(relativeUrl(from, target), expected, `${from} -> ${target}`);
  }

  // The depth form has no idea where the document sits, so it cannot share a prefix.
  assert.equal(relativeUrl(3, '/assets/a.css'), '../../../assets/a.css');
  assert.equal(relativeUrl(0, '/'), './');

  // Under cleanUrls:false a leaf page is written one directory shallower than its route.
  assert.equal(routeToDocDir('/guide/install/'), '/guide/install/');
  assert.equal(routeToDocDir('/guide/install/', { cleanUrls: false }), '/guide/');
  assert.equal(routeToDocDir('/guide/', { cleanUrls: false, isIndex: true }), '/guide/');
});

test('breadcrumbs on a deep page point at their ancestors directly', async () => {
  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n',
    'content/writing/index.md': '---\ntitle: Writing\n---\n\n# Writing\n',
    'content/writing/advanced/index.md': '---\ntitle: Advanced\n---\n\n# Advanced\n',
    'content/writing/advanced/footnotes.md': '---\ntitle: Footnotes\n---\n\n# Footnotes\n',
  });

  const html = site.read('writing/advanced/footnotes/index.html');
  const crumbs = [...html.matchAll(/<li class="breadcrumbs__item"[^>]*>(?:<a[^>]*href="([^"]+)")?/g)]
    .map((m) => m[1])
    .filter(Boolean);

  assert.deepEqual(crumbs, ['../../../', '../../', '../'],
    'breadcrumbs climbed to the site root instead of straight to each ancestor');
});
