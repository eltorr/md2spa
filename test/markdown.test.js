/**
 * The Markdown dialect -- SPEC.md §4 (AST), §4b (raw HTML policy) and §8b (class contract).
 *
 * One focused case per supported construct, plus the CommonMark edge cases that separate a
 * real parser from a pile of regexes: emphasis adjacency, intraword `_`, code spans holding
 * backticks, tight vs loose lists, and entity passthrough.
 *
 * Assertions are deliberately made against the *emitted strings* in SPEC §8b wherever the
 * spec pins them, because the stylesheet is written against exactly those class names.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { render, parse, testConfig } from './helpers/harness.js';

/**
 * Depth-first walk over a block/inline AST, including table cells.
 * @param {object} node
 * @param {(node: object) => void} visit
 */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
  for (const cell of node.header || []) walk(cell, visit);
  for (const row of node.rows || []) for (const cell of row) walk(cell, visit);
}

/**
 * Every node of a given type, in document order.
 * @param {object} ast
 * @param {string} type
 * @returns {object[]}
 */
function nodes(ast, type) {
  const out = [];
  walk(ast, (n) => { if (n.type === type) out.push(n); });
  return out;
}

/**
 * The first node of a given type.
 * @param {object} ast
 * @param {string} type
 * @returns {object|undefined}
 */
function first(ast, type) {
  return nodes(ast, type)[0];
}

/**
 * Count non-overlapping matches.
 * @param {string} haystack
 * @param {RegExp} pattern must carry the `g` flag
 * @returns {number}
 */
function count(haystack, pattern) {
  return [...haystack.matchAll(pattern)].length;
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

test('ATX headings: all six depths, closing hashes optional', async () => {
  const { ast } = await render(
    '# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\n## Closed ##\n',
  );
  const headings = nodes(ast, 'heading');
  assert.deepEqual(headings.map((h) => h.depth), [1, 2, 3, 4, 5, 6, 2]);
  assert.deepEqual(headings.map((h) => h.text), ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Closed']);
});

test('headings emit the exact permalink markup from SPEC §8b', async () => {
  const { html } = await render('## SoC Blocks\n');
  assert.ok(
    html.includes(
      '<h2 id="soc-blocks">SoC Blocks<a class="anchor" href="#soc-blocks" aria-hidden="true" tabindex="-1">#</a></h2>',
    ),
    `heading markup did not match SPEC §8b:\n${html}`,
  );
});

test('setext headings map to depth 1 and 2', async () => {
  const { ast } = await render('Title\n=====\n\nSubtitle\n--------\n');
  const headings = nodes(ast, 'heading');
  assert.deepEqual(headings.map((h) => [h.depth, h.text]), [[1, 'Title'], [2, 'Subtitle']]);
});

test('node positions are 1-based and point at the first character of the construct', async () => {
  const { ast } = await render('# Top\n\nSome text.\n\n## Later\n');
  const later = nodes(ast, 'heading')[1];
  assert.equal(later.line, 5);
  assert.equal(later.column, 1);
});

test('a heading carries a slugged id and appears in headings/toc', async () => {
  const { headings, toc } = await render('# Page\n\n## Install\n\n### Requirements\n');
  assert.deepEqual(headings, [
    { id: 'page', text: 'Page', depth: 1 },
    { id: 'install', text: 'Install', depth: 2 },
    { id: 'requirements', text: 'Requirements', depth: 3 },
  ]);
  // Default config is toc.minDepth 2 / maxDepth 3, so h1 is excluded and h3 nests under h2.
  assert.equal(toc.length, 1);
  assert.equal(toc[0].id, 'install');
  assert.equal(toc[0].depth, 2);
  assert.deepEqual(toc[0].children.map((c) => c.id), ['requirements']);
});

// ---------------------------------------------------------------------------
// Paragraphs and breaks
// ---------------------------------------------------------------------------

test('hard breaks: two trailing spaces and a trailing backslash; soft breaks stay soft', async () => {
  const { ast, html } = await render('alpha  \nbravo\\\ncharlie\ndelta\n');
  assert.equal(nodes(ast, 'break').length, 2);
  assert.equal(count(html, /<br\s*\/?>/g), 2);
  // The soft break between charlie and delta must not become a <br>.
  assert.match(html, /charlie\s*\n?\s*delta/);
});

test('thematic breaks: ---, *** and ___', async () => {
  const { ast, html } = await render('para\n\n---\n\n***\n\n___\n');
  assert.equal(nodes(ast, 'thematicBreak').length, 3);
  assert.equal(count(html, /<hr\s*\/?>/g), 3);
});

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

test('fenced code: backtick fence with lang and meta, rendered per SPEC §8b', async () => {
  const { ast, html } = await render('```js title="server.js"\nconst x = 1;\n```\n');
  const code = first(ast, 'code');
  assert.equal(code.lang, 'js');
  assert.equal(code.fenced, true);
  assert.equal(code.meta, 'title="server.js"');
  assert.match(code.value, /^const x = 1;\n?$/);

  assert.match(html, /<figure class="code" data-lang="js">/);
  assert.match(html, /<figcaption class="code__title">server\.js<\/figcaption>/);
  assert.match(html, /<pre class="code__pre"><code class="language-js">/);
});

test('fenced code: tilde fence', async () => {
  const { ast } = await render('~~~python\nprint("hi")\n~~~\n');
  const code = first(ast, 'code');
  assert.equal(code.lang, 'python');
  assert.equal(code.fenced, true);
  assert.match(code.value, /print\("hi"\)/);
});

test('fenced code: a longer fence may contain a shorter one verbatim', async () => {
  const { ast } = await render('````md\n```js\nnested\n```\n````\n');
  const code = first(ast, 'code');
  assert.equal(code.lang, 'md');
  assert.match(code.value, /```js\nnested\n```/);
});

test('fenced code: contents are never interpreted as Markdown and are escaped', async () => {
  const { ast, html } = await render('```\n# not a heading\n<script>x</script>\n```\n');
  assert.equal(nodes(ast, 'heading').length, 0);
  assert.ok(!/<script/i.test(html), 'script tag leaked out of a code fence');
  // The highlighter may wrap tokens in <span class="tok …">, so only the angle brackets
  // are asserted -- they must be entities, never live markup.
  assert.match(html, /&lt;/);
  assert.match(html, /&gt;/);
  assert.match(html, /# not a heading/);
});

test('indented code blocks (4 spaces) are unfenced code with no language', async () => {
  const { ast } = await render('para\n\n    indented();\n');
  const code = first(ast, 'code');
  assert.equal(code.fenced, false);
  assert.equal(code.lang, null);
  assert.match(code.value, /indented\(\);/);
});

test('inline code uses the code-inline class', async () => {
  const { ast, html } = await render('Call `npm run build` now.\n');
  assert.equal(first(ast, 'inlineCode').value, 'npm run build');
  assert.match(html, /<code class="code-inline">npm run build<\/code>/);
});

test('code spans: n-backtick delimiters can hold backticks', async () => {
  const a = await render('``code with ` backtick``\n');
  assert.equal(first(a.ast, 'inlineCode').value, 'code with ` backtick');

  // CommonMark: one leading and one trailing space are stripped when both are present.
  const b = await render('`` ` ``\n');
  assert.equal(first(b.ast, 'inlineCode').value, '`');

  const c = await render('` a `\n');
  assert.equal(first(c.ast, 'inlineCode').value, 'a');

  const d = await render('`  a  `\n');
  assert.equal(first(d.ast, 'inlineCode').value, ' a ');
});

// ---------------------------------------------------------------------------
// Blockquotes and admonitions
// ---------------------------------------------------------------------------

test('blockquotes nest and render with the quote class', async () => {
  const { ast, html } = await render('> outer\n>\n> > inner\n');
  const quotes = nodes(ast, 'blockquote');
  assert.equal(quotes.length, 2);
  assert.match(html, /<blockquote class="quote">/);
  assert.equal(count(html, /<blockquote class="quote">/g), 2);
});

/**
 * SPEC §4 says an admonition `kind` is "lowercased", while SPEC §8 lists the kinds the
 * stylesheet targets (`note/tip/info/warning/danger/…`) -- which does not include
 * `caution` or `important`. Mapping the GitHub alert onto the styled kind is therefore
 * legitimate, so both spellings are accepted; what is *not* negotiable is that the class
 * on the element agrees with the `kind` on the node.
 */
const ALERT_KINDS = {
  NOTE: ['note'],
  TIP: ['tip'],
  IMPORTANT: ['important', 'info'],
  WARNING: ['warning'],
  CAUTION: ['caution', 'danger'],
};

test('GitHub alerts become admonitions -- all five kinds', async () => {
  for (const [alert, accepted] of Object.entries(ALERT_KINDS)) {
    const { ast, html } = await render(`> [!${alert}]\n> Body text.\n`);
    const adm = first(ast, 'admonition');
    assert.ok(adm, `> [!${alert}] did not produce an admonition`);
    assert.ok(
      accepted.includes(adm.kind),
      `> [!${alert}] produced kind ${JSON.stringify(adm.kind)}, expected one of ${accepted.join('/')}`,
    );
    assert.equal(adm.collapsible, false);
    assert.match(html, new RegExp(`admonition admonition--${adm.kind}\\b`));
    assert.match(html, /role="note"/);
    assert.match(html, /class="admonition__title"/);
    assert.match(html, /Body text\./);
  }
});

test('MkDocs admonition: !!! kind "Title"', async () => {
  const { ast, html } = await render('!!! note "Custom Title"\n    Body paragraph.\n');
  const adm = first(ast, 'admonition');
  assert.equal(adm.kind, 'note');
  assert.equal(adm.title, 'Custom Title');
  assert.equal(adm.collapsible, false);
  assert.match(html, /<div class="admonition admonition--note" role="note">/);
  assert.match(html, /<p class="admonition__title">Custom Title<\/p>/);
  assert.match(html, /Body paragraph\./);
});

test('MkDocs collapsible admonition: ??? is closed, ???+ is open', async () => {
  const closed = await render('??? warning "Details"\n    Hidden body.\n');
  const adm = first(closed.ast, 'admonition');
  assert.equal(adm.kind, 'warning');
  assert.equal(adm.collapsible, true);
  assert.equal(adm.open, false);
  assert.match(
    closed.html,
    /<details class="admonition admonition--warning is-collapsible">/,
  );
  assert.match(closed.html, /<summary class="admonition__title">Details<\/summary>/);

  const open = await render('???+ tip "Shown"\n    Visible body.\n');
  const openAdm = first(open.ast, 'admonition');
  assert.equal(openAdm.collapsible, true);
  assert.equal(openAdm.open, true);
  assert.match(open.html, /<details class="admonition admonition--tip is-collapsible" open>/);
});

test('an admonition without an explicit title has title null', async () => {
  const { ast } = await render('!!! danger\n    Careful.\n');
  const adm = first(ast, 'admonition');
  assert.equal(adm.kind, 'danger');
  assert.equal(adm.title, null);
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

test('unordered lists accept -, * and + markers', async () => {
  for (const marker of ['-', '*', '+']) {
    const { ast } = await render(`${marker} one\n${marker} two\n`);
    const list = first(ast, 'list');
    assert.equal(list.ordered, false, `marker ${marker}`);
    assert.equal(list.children.length, 2, `marker ${marker}`);
  }
});

test('ordered lists accept 1. and 1) and record their start', async () => {
  const dot = await render('1. one\n2. two\n');
  assert.equal(first(dot.ast, 'list').ordered, true);
  assert.equal(first(dot.ast, 'list').start, 1);

  const paren = await render('1) one\n2) two\n');
  assert.equal(first(paren.ast, 'list').ordered, true);

  const offset = await render('3. three\n4. four\n');
  assert.equal(first(offset.ast, 'list').start, 3);
  assert.match(offset.html, /<ol[^>]*start="3"/);
});

test('lists nest by indentation, and a nested list may use a different marker', async () => {
  const { ast } = await render('- outer\n  * inner\n    + deepest\n- second\n');
  const outer = first(ast, 'list');
  assert.equal(outer.children.length, 2);
  const inner = first(outer.children[0], 'list');
  assert.ok(inner, 'nested list not found');
  const deepest = first(inner.children[0], 'list');
  assert.ok(deepest, 'doubly nested list not found');
});

test('tight lists have no <p>, loose lists do', async () => {
  const tight = await render('- alpha\n- bravo\n');
  assert.equal(first(tight.ast, 'list').tight, true);
  assert.ok(!/<li[^>]*>\s*<p>/.test(tight.html), `tight list wrapped items in <p>:\n${tight.html}`);

  const loose = await render('- alpha\n\n- bravo\n');
  assert.equal(first(loose.ast, 'list').tight, false);
  assert.match(loose.html, /<li[^>]*>\s*<p>/);
});

test('task lists carry checked state and the SPEC §8b classes', async () => {
  const { ast, html } = await render('- [ ] todo\n- [x] done\n');
  const items = nodes(ast, 'listItem');
  assert.deepEqual(items.map((i) => i.checked), [false, true]);
  assert.match(html, /<ul class="task-list">/);
  assert.match(html, /<li class="task-list__item">/);
  assert.match(html, /<input type="checkbox" checked disabled>/);
  assert.match(html, /<input type="checkbox" disabled>/);
});

test('a plain list item has checked null', async () => {
  const { ast } = await render('- plain\n');
  assert.equal(first(ast, 'listItem').checked, null);
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

test('GFM table: all three alignments plus the default column', async () => {
  const source = [
    '| Left | Center | Right | Plain |',
    '|:-----|:------:|------:|-------|',
    '| a    | b      | c     | d     |',
    '| e    | f      | g     | h     |',
    '',
  ].join('\n');
  const { ast, html } = await render(source);
  const table = first(ast, 'table');
  assert.deepEqual(table.align, ['left', 'center', 'right', null]);
  assert.equal(table.header.length, 4);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].length, 4);

  assert.match(html, /<div class="table-wrap"><table class="table">/);
  assert.match(html, /<th class="is-left"[ >]/);
  assert.match(html, /<th class="is-center"[ >]/);
  assert.match(html, /<th class="is-right"[ >]/);
  // The unaligned column must not be given an alignment class.
  assert.match(html, /<th(?: [^>]*)?>Plain<\/th>/);
  assert.ok(!/<th class="is-[a-z]+"[^>]*>Plain</.test(html));
});

test('table cells hold inline nodes and a position', async () => {
  const { ast } = await render('| A |\n|---|\n| **bold** |\n');
  const table = first(ast, 'table');
  const cell = table.rows[0][0];
  assert.ok(Array.isArray(cell.children));
  assert.equal(cell.children[0].type, 'strong');
  assert.equal(cell.line, 3);
});

// ---------------------------------------------------------------------------
// Inline emphasis
// ---------------------------------------------------------------------------

test('strong, emphasis, delete and their alternate markers', async () => {
  const { ast, html } = await render('**a** __b__ *c* _d_ ~~e~~\n');
  assert.equal(nodes(ast, 'strong').length, 2);
  assert.equal(nodes(ast, 'emphasis').length, 2);
  assert.equal(nodes(ast, 'delete').length, 1);
  assert.match(html, /<strong>a<\/strong>/);
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<em>c<\/em>/);
  assert.match(html, /<em>d<\/em>/);
  assert.match(html, /<del>e<\/del>/);
});

test('emphasis adjacency: * works intraword, _ does not', async () => {
  const star = await render('a*b*c\n');
  assert.equal(nodes(star.ast, 'emphasis').length, 1);
  assert.match(star.html, /a<em>b<\/em>c/);

  // CommonMark: intraword `_` is literal -- `snake_case_name` must survive untouched.
  const underscore = await render('a_b_c\n');
  assert.equal(nodes(underscore.ast, 'emphasis').length, 0);
  assert.match(underscore.html, /a_b_c/);

  const snake = await render('use snake_case_name here\n');
  assert.equal(nodes(snake.ast, 'emphasis').length, 0);
  assert.match(snake.html, /snake_case_name/);
});

test('emphasis adjacency: strong immediately followed by text', async () => {
  const { ast, html } = await render('**a**b\n');
  assert.equal(nodes(ast, 'strong').length, 1);
  assert.match(html, /<strong>a<\/strong>b/);

  const intraword = await render('foo__bar__baz\n');
  assert.equal(nodes(intraword.ast, 'strong').length, 0);
});

test('nested emphasis inside strong', async () => {
  const { ast, html } = await render('**bold with *italic* inside**\n');
  const strong = first(ast, 'strong');
  assert.ok(strong);
  assert.equal(nodes(strong, 'emphasis').length, 1);
  assert.match(html, /<strong>bold with <em>italic<\/em> inside<\/strong>/);
});

test('a lone or unmatched emphasis marker stays literal text', async () => {
  const { ast, html } = await render('5 * 3 * 2 = 30\n');
  assert.equal(nodes(ast, 'emphasis').length, 0);
  assert.match(html, /5 \* 3 \* 2 = 30/);
});

// ---------------------------------------------------------------------------
// Links, images, autolinks
// ---------------------------------------------------------------------------

test('inline link with a title', async () => {
  const { ast, html } = await render('[docs](https://example.com/ "The Title")\n');
  const link = first(ast, 'link');
  assert.equal(link.url, 'https://example.com/');
  assert.equal(link.title, 'The Title');
  assert.equal(link.reference, null);
  assert.match(html, /title="The Title"/);
});

test('external links get the SPEC §8b external treatment', async () => {
  const { html } = await render('[docs](https://example.com/)\n');
  assert.match(html, /class="link link--external"/);
  assert.match(html, /rel="noopener[^"]*external"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /<span class="link__icon" aria-hidden="true"><\/span>/);
});

test('all three reference-link forms resolve against one definition', async () => {
  const source = [
    'Full [text][ref].',
    '',
    'Collapsed [ref][].',
    '',
    'Shortcut [ref].',
    '',
    '[ref]: https://example.com/ "Ref Title"',
    '',
  ].join('\n');
  const { ast } = await render(source);
  const links = nodes(ast, 'link');
  assert.equal(links.length, 3, 'expected full, collapsed and shortcut reference links');
  for (const link of links) {
    assert.equal(link.url, 'https://example.com/');
    assert.equal(link.title, 'Ref Title');
    assert.equal(link.reference, 'ref');
  }
});

test('a link reference definition is an AST node and is not rendered', async () => {
  const { ast, html } = await render('Use [ref].\n\n[ref]: https://example.com/ "T"\n');
  const def = first(ast, 'definition');
  assert.equal(def.identifier, 'ref');
  assert.equal(def.url, 'https://example.com/');
  assert.equal(def.title, 'T');
  assert.ok(!html.includes('[ref]:'), 'definition leaked into the output');
});

test('reference labels are matched case-insensitively', async () => {
  const { ast } = await render('[text][REF]\n\n[ref]: https://example.com/\n');
  assert.equal(first(ast, 'link').url, 'https://example.com/');
});

test('autolinks and bare-URL linkification', async () => {
  const auto = await render('See <https://example.com/path> for details.\n');
  const autoLink = first(auto.ast, 'link');
  assert.equal(autoLink.url, 'https://example.com/path');
  // The URL is its own link text (the external icon span may follow it inside the <a>).
  assert.match(auto.html, />https:\/\/example\.com\/path</);

  const bare = await render('See https://example.com/path for details.\n');
  assert.equal(first(bare.ast, 'link').url, 'https://example.com/path');
  // SPEC §5 MD047: still linkified, but reported.
  assert.ok(bare.codes.includes('MD047'));
});

test('email autolinks become mailto: links', async () => {
  const { ast } = await render('<someone@example.com>\n');
  assert.equal(first(ast, 'link').url, 'mailto:someone@example.com');
});

test('images render with the SPEC §8b attributes', async () => {
  const { ast, html } = await render('![A diagram](https://example.com/x.png "Caption")\n');
  const image = first(ast, 'image');
  assert.equal(image.url, 'https://example.com/x.png');
  assert.equal(image.alt, 'A diagram');
  assert.equal(image.title, 'Caption');
  assert.match(
    html,
    /<img class="md-img" src="https:\/\/example\.com\/x\.png" alt="A diagram"[^>]*loading="lazy"[^>]*decoding="async"[^>]*>/,
  );
});

test('renderHtml reports the links and images it saw, with positions', async () => {
  const { links, images } = await render(
    '# T\n\n[a](https://example.com/)\n\n![alt](https://example.com/i.png)\n',
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://example.com/');
  assert.equal(links[0].line, 3);
  assert.equal(images.length, 1);
  assert.equal(images[0].alt, 'alt');
  assert.equal(images[0].line, 5);
});

// ---------------------------------------------------------------------------
// Footnotes
// ---------------------------------------------------------------------------

test('footnotes: reference, definition and the rendered section', async () => {
  const { ast, html } = await render('Statement[^1].\n\n[^1]: The supporting note.\n');
  const ref = first(ast, 'footnoteReference');
  assert.equal(ref.identifier, '1');
  const def = first(ast, 'footnoteDefinition');
  assert.equal(def.identifier, '1');

  assert.match(html, /<sup class="footnote-ref"><a id="fnref-1" href="#fn-1">1<\/a><\/sup>/);
  assert.match(html, /<section class="footnotes">/);
  assert.match(html, /<h2 class="footnotes__title">Footnotes<\/h2>/);
  assert.match(html, /<li id="fn-1">/);
  assert.match(html, /<a class="footnote-back" href="#fnref-1"[ >]/);
  assert.match(html, /&#8617;/);
});

test('named footnote identifiers work too', async () => {
  const { ast, html } = await render('Text[^note].\n\n[^note]: Body.\n');
  assert.equal(first(ast, 'footnoteReference').identifier, 'note');
  assert.match(html, /href="#fn-note"/);
});

// ---------------------------------------------------------------------------
// Raw HTML and entities
// ---------------------------------------------------------------------------

test('allowlisted inline HTML passes through', async () => {
  const { html } = await render('Press <kbd>Ctrl</kbd>+<kbd>K</kbd>.\n');
  assert.match(html, /<kbd>Ctrl<\/kbd>/);
  assert.match(html, /<kbd>K<\/kbd>/);
});

test('allowlisted block HTML passes through -- details/summary survive', async () => {
  const { html } = await render('<details>\n<summary>More</summary>\n\nHidden body.\n\n</details>\n');
  assert.match(html, /<details>/);
  assert.match(html, /<summary>More<\/summary>/);
  assert.match(html, /<\/details>/);
});

test('badge spans survive because the reference corpus is full of support matrices', async () => {
  const { html } = await render('Status: <span class="badge badge--ok">supported</span>\n');
  assert.match(html, /<span class="badge badge--ok">supported<\/span>/);
});

test('entity references pass through, stray ampersands are escaped', async () => {
  const { html } = await render('&copy; 2024 &amp; friends &#8212; AT&T\n');
  assert.match(html, /&copy;/);
  assert.match(html, /&amp; friends/);
  assert.match(html, /&#8212;/);
  assert.match(html, /AT&amp;T/);
});

test('angle-bracket placeholders are escaped as literal text, with no diagnostic', async () => {
  const { html, codes } = await render('Run `dd of=/dev/<your-volume>` then check <num> blocks.\n');
  assert.match(html, /&lt;num&gt;/);
  assert.ok(!codes.includes('MD052'), `placeholder text produced MD052: ${codes.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Frontmatter and plain-text extraction
// ---------------------------------------------------------------------------

test('frontmatter is parsed off the top and preserves arbitrary user keys', async () => {
  const source = [
    '---',
    'title: Installing',
    'order: 3',
    'draft: false',
    'tags: [linux, boot]',
    'iso_layout: ansi',
    '---',
    '',
    '# Installing',
    '',
  ].join('\n');
  const { frontmatter, ast } = await parse(source, { config: testConfig() });
  assert.equal(frontmatter.title, 'Installing');
  assert.equal(frontmatter.order, 3);
  assert.equal(frontmatter.draft, false);
  assert.deepEqual(frontmatter.tags, ['linux', 'boot']);
  assert.equal(frontmatter.iso_layout, 'ansi');
  // The frontmatter block itself must not appear in the document body.
  assert.equal(nodes(ast, 'heading')[0].text, 'Installing');
});

test('the plain-text projection drops markup for the search index', async () => {
  const { text } = await render(
    '# Title\n\nSome **bold** and `code` and [a link](https://example.com/).\n',
  );
  assert.match(text, /Title/);
  assert.match(text, /Some bold and code and a link/);
  assert.ok(!text.includes('**'), 'markup leaked into the search text');
  assert.ok(!text.includes('<'), 'HTML leaked into the search text');
});
