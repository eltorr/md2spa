/**
 * Relative-link resolution -- SPEC.md §4b.
 *
 * The table below is the one in SPEC §4b, transcribed row for row: this is the behaviour
 * that lets authors write links exactly as they do on GitHub and still get a working site.
 *
 * A note on the assertion strategy. SPEC §4b spells the expected hrefs in their *shortest*
 * document-relative form (`../partitioning-cheatsheet/`), while SPEC §3 defines the `url()`
 * helper as `'../'.repeat(depth) + target`, which produces the equivalent but longer
 * `../../sw/partitioning-cheatsheet/`. Both resolve to the same address in a browser, and
 * SPEC.md does not say which spelling wins. So the strict assertion here is on the
 * *resolved* target, with a secondary assertion that the emitted string is one of the two
 * spellings. Everything else -- fragments, queries, external and non-http schemes -- is
 * asserted exactly.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { relativeUrl } from '../src/util/path.js';
import { buildTempSite, cleanupTemps } from './helpers/harness.js';

after(cleanupTemps);

/** A 1x1 transparent PNG -- only its existence on disk matters. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** The page under test lives at `content/sw/tethered-boot.md` -> `/sw/tethered-boot/`. */
const PAGE_ROUTE = '/sw/tethered-boot/';
const PAGE_DEPTH = 2;

/**
 * @typedef {Object} LinkRow
 * @property {string} label unique link text, used to find the anchor again
 * @property {string} authored the Markdown destination as written by the author
 * @property {string} spec the href SPEC §4b shows for this row
 * @property {string|null} target absolute site path (+fragment) the href must resolve to,
 *                                or null when the href must be emitted verbatim
 */

/** @type {LinkRow[]} */
const ROWS = [
  {
    label: 'L0',
    authored: 'partitioning-cheatsheet.md',
    spec: '../partitioning-cheatsheet/',
    target: '/sw/partitioning-cheatsheet/',
  },
  {
    label: 'L1',
    authored: '../hw/soc/serial-debug.md',
    spec: '../../hw/soc/serial-debug/',
    target: '/hw/soc/serial-debug/',
  },
  {
    label: 'L2',
    authored: '../platform/dev-quickstart.md#setup',
    spec: '../../platform/dev-quickstart/#setup',
    target: '/platform/dev-quickstart/#setup',
  },
  {
    label: 'L3',
    authored: 'index.md',
    spec: '../',
    target: '/sw/',
  },
  {
    label: 'L4',
    authored: './',
    spec: '../',
    target: '/sw/',
  },
  {
    label: 'L5',
    authored: '#soc-blocks',
    spec: '#soc-blocks',
    target: null,
  },
  {
    label: 'L6',
    authored: 'https://example.com/external',
    spec: 'https://example.com/external',
    target: null,
  },
  {
    label: 'L7',
    authored: '../assets/boot.png',
    spec: '../../assets/boot.png',
    target: '/assets/boot.png',
  },
  {
    label: 'L8',
    authored: 'mailto:someone@example.com',
    spec: 'mailto:someone@example.com',
    target: null,
  },
  {
    label: 'L9',
    authored: 'tel:+15551234567',
    spec: 'tel:+15551234567',
    target: null,
  },
  {
    label: 'L10',
    authored: 'irc://irc.example.org/channel',
    spec: 'irc://irc.example.org/channel',
    target: null,
  },
];

const TETHERED_BOOT = [
  '---',
  'title: Tethered Boot',
  '---',
  '',
  '# Tethered Boot',
  '',
  '## SoC Blocks',
  '',
  ...ROWS.map((row) => `- [${row.label}](${row.authored})`),
  '',
].join('\n');

/** A site laid out like the real docs corpus SPEC §4b was derived from. */
const TREE = {
  'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\nWelcome.\n',
  'content/sw/index.md': '---\ntitle: Software\n---\n\n# Software\n\nSection index.\n',
  'content/sw/tethered-boot.md': TETHERED_BOOT,
  'content/sw/partitioning-cheatsheet.md': '# Partitioning Cheatsheet\n\nText.\n',
  'content/hw/soc/serial-debug.md': '# Serial Debug\n\nText.\n',
  'content/platform/dev-quickstart.md': '# Dev Quickstart\n\n## Setup\n\nText.\n',
  'static/assets/boot.png': PNG,
};

/** @type {Awaited<ReturnType<typeof buildTempSite>>} */
let site;
/** @type {string} */
let pageHtml;

before(async () => {
  site = await buildTempSite(TREE);
  pageHtml = site.read('sw/tethered-boot/index.html');
});

/**
 * The href of the anchor whose text is exactly `label`.
 * @param {string} html
 * @param {string} label
 * @returns {string}
 */
function hrefOf(html, label) {
  const pattern = new RegExp(`<a\\b([^>]*)>${label}(?:<[^>]*>)*</a>`);
  const m = pattern.exec(html);
  assert.ok(m, `no anchor with text ${label} in the rendered page`);
  const href = /\shref="([^"]*)"/.exec(m[1]);
  assert.ok(href, `anchor ${label} has no href`);
  return href[1];
}

for (const row of ROWS) {
  test(`SPEC §4b: [x](${row.authored})`, () => {
    const href = hrefOf(pageHtml, row.label);

    if (row.target === null) {
      // Fragment-only, external and non-http destinations are emitted verbatim.
      assert.equal(href, row.spec);
      return;
    }

    // Strict: the href must address the right page from this document.
    const resolved = new URL(href, `https://example.test${PAGE_ROUTE}`);
    assert.equal(
      resolved.pathname + resolved.hash,
      row.target,
      `[x](${row.authored}) emitted ${JSON.stringify(href)}, which resolves to `
      + `${resolved.pathname + resolved.hash} instead of ${row.target}`,
    );

    // Secondary: it must be spelled the way SPEC §4b shows, or the way the SPEC §3
    // url() helper spells it. Anything else means the base handling has drifted.
    const canonical = relativeUrl(PAGE_DEPTH, row.target);
    assert.ok(
      href === row.spec || href === canonical,
      `expected ${JSON.stringify(row.spec)} or ${JSON.stringify(canonical)}, got ${JSON.stringify(href)}`,
    );
  });
}

test('external links keep their destination and gain the external treatment', () => {
  const m = /<a\b([^>]*)>L6(?:<[^>]*>)*<\/a>/.exec(pageHtml);
  assert.ok(m);
  const attrs = m[1];
  assert.match(attrs, /href="https:\/\/example\.com\/external"/);
  assert.match(attrs, /rel="[^"]*noopener[^"]*"/);
  assert.match(attrs, /rel="[^"]*external[^"]*"/);
  assert.match(attrs, /class="[^"]*link--external[^"]*"/);
});

test('internal links are not given the external treatment', () => {
  const m = /<a\b([^>]*)>L0(?:<[^>]*>)*<\/a>/.exec(pageHtml);
  assert.ok(m);
  assert.ok(!/link--external/.test(m[1]), 'an internal link was marked external');
  assert.ok(!/target="_blank"/.test(m[1]));
});

test('a query string survives link rewriting alongside the fragment', async () => {
  const local = await buildTempSite({
    ...TREE,
    'content/sw/tethered-boot.md':
      '# Tethered Boot\n\n[Q](../platform/dev-quickstart.md?x=1#setup)\n',
  });
  const href = hrefOf(local.read('sw/tethered-boot/index.html'), 'Q');
  const resolved = new URL(href, `https://example.test${PAGE_ROUTE}`);
  assert.equal(resolved.pathname, '/platform/dev-quickstart/');
  assert.equal(resolved.search, '?x=1');
  assert.equal(resolved.hash, '#setup');
});

test('relative image sources are rewritten the same way as links', async () => {
  const local = await buildTempSite({
    ...TREE,
    'content/sw/tethered-boot.md': '# Tethered Boot\n\n![Boot diagram](../assets/boot.png)\n',
  });
  const html = local.read('sw/tethered-boot/index.html');
  const src = (/<img[^>]*\ssrc="([^"]*)"/.exec(html) || [])[1];
  assert.ok(src, 'no <img> emitted');
  const resolved = new URL(src, `https://example.test${PAGE_ROUTE}`);
  assert.equal(resolved.pathname, '/assets/boot.png');
});

test('with cleanUrls: false the links point at .html documents that exist', async () => {
  const local = await buildTempSite(TREE, { cleanUrls: false });
  assert.ok(local.exists('sw/tethered-boot.html'), 'cleanUrls:false did not emit a .html page');
  const html = local.read('sw/tethered-boot.html');
  const href = hrefOf(html, 'L1');
  assert.match(href, /\.html($|[?#])/, `expected a .html href, got ${href}`);
  const resolved = new URL(href, 'https://example.test/sw/tethered-boot.html');
  assert.ok(
    local.exists(resolved.pathname.replace(/^\//, '')),
    `link target ${resolved.pathname} was not emitted`,
  );
});

// ---------------------------------------------------------------------------
// MD044 / MD045 / MD046
// ---------------------------------------------------------------------------

/**
 * @param {object} built
 * @param {string} code
 * @returns {object[]}
 */
function codes(built, code) {
  return built.result.diagnostics.filter((d) => d.code === code);
}

test('MD044: a link to a page that does not exist is an error', async () => {
  const local = await buildTempSite({
    ...TREE,
    'content/sw/tethered-boot.md': '# Tethered Boot\n\nSee [gone](does-not-exist.md).\n',
  });
  const hits = codes(local, 'MD044');
  assert.ok(hits.length > 0, 'MD044 was not reported for a dangling internal link');
  assert.equal(hits[0].severity, 'error');
  assert.match(hits[0].file, /tethered-boot\.md$/);
  assert.equal(hits[0].line, 3);
});

test('MD045: a fragment that matches no heading on the target page is a warning', async () => {
  const local = await buildTempSite({
    ...TREE,
    'content/sw/tethered-boot.md':
      '# Tethered Boot\n\nSee [q](../platform/dev-quickstart.md#no-such-anchor).\n',
  });
  const hits = codes(local, 'MD045');
  assert.ok(hits.length > 0, 'MD045 was not reported for a dangling anchor');
  assert.equal(hits[0].severity, 'warning');
  assert.equal(hits[0].line, 3);
  assert.deepEqual(codes(local, 'MD044'), [], 'the page itself exists, so MD044 must not fire');
});

test('MD046: a referenced local asset that is not on disk is a warning', async () => {
  const local = await buildTempSite({
    ...TREE,
    'content/sw/tethered-boot.md': '# Tethered Boot\n\n![Missing](../assets/missing.png)\n',
  });
  const hits = codes(local, 'MD046');
  assert.ok(hits.length > 0, 'MD046 was not reported for a missing asset');
  assert.equal(hits[0].severity, 'warning');
  assert.equal(hits[0].line, 3);
});

test('a page whose links all resolve produces no MD044/MD045/MD046', () => {
  for (const code of ['MD044', 'MD045', 'MD046']) {
    assert.deepEqual(
      codes(site, code).map((d) => `${d.file}:${d.line} ${d.message}`),
      [],
      `${code} fired on a site with only valid links`,
    );
  }
});

test('an anchor that does exist on the target page is accepted', async () => {
  const local = await buildTempSite({
    ...TREE,
    'content/sw/tethered-boot.md':
      '# Tethered Boot\n\nSee [q](../platform/dev-quickstart.md#setup).\n',
  });
  assert.deepEqual(codes(local, 'MD045'), []);
});

test('external and mail links are never checked for existence', async () => {
  const local = await buildTempSite({
    ...TREE,
    'content/sw/tethered-boot.md': [
      '# Tethered Boot',
      '',
      '- [a](https://example.com/definitely/not/here)',
      '- [b](mailto:nobody@example.com)',
      '- [c](tel:+15551234567)',
      '',
    ].join('\n'),
  });
  assert.deepEqual(codes(local, 'MD044'), []);
  assert.deepEqual(codes(local, 'MD046'), []);
});
