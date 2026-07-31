/**
 * Heading slugs -- SPEC.md §4b "Heading slugs".
 *
 * The contract is *GitHub compatibility*: anchors authored against GitHub or
 * Python-Markdown must keep resolving after a site is generated. The subtle part is that
 * punctuation is **deleted** rather than replaced with a separator, which is why
 * `M1 Pro/Max/Ultra devices` collapses to `m1-promaxultra-devices`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { slugify, createSlugRegistry } from '../src/markdown/slug.js';
import { render } from './helpers/harness.js';

test('slugify: the two cases SPEC.md verifies by name', () => {
  assert.equal(slugify('M1 Pro/Max/Ultra devices'), 'm1-promaxultra-devices');
  assert.equal(
    slugify('USB gadget mode (using a standard USB cable)'),
    'usb-gadget-mode-using-a-standard-usb-cable',
  );
});

test('slugify: punctuation vanishes without leaving a separator', () => {
  const cases = [
    ['Hello, World!', 'hello-world'],
    ["What's new?", 'whats-new'],
    ['C++ & Rust', 'c-rust'],
    ['1.2.3 Release', '123-release'],
    ['Section: Overview', 'section-overview'],
    ['a/b/c', 'abc'],
    ['read/write vs read only', 'readwrite-vs-read-only'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(slugify(input), expected, `slugify(${JSON.stringify(input)})`);
  }
});

test('slugify: whitespace runs collapse to a single dash and edges are trimmed', () => {
  assert.equal(slugify('  spaced   out  '), 'spaced-out');
  assert.equal(slugify('tabs\tand\nnewlines'), 'tabs-and-newlines');
  assert.equal(slugify('-- leading and trailing --'), 'leading-and-trailing');
  assert.equal(slugify('---'), '');
  assert.equal(slugify(''), '');
});

test('slugify: underscores and dashes survive, everything else is dropped', () => {
  assert.equal(slugify('under_score-dash'), 'under_score-dash');
  assert.equal(slugify('snake_case_name'), 'snake_case_name');
});

test('slugify: accents are folded to their base letters', () => {
  assert.equal(slugify('Café Münster'), 'cafe-munster');
  assert.equal(slugify('Naïve Résumé'), 'naive-resume');
  assert.equal(slugify('Über die Brücke'), 'uber-die-brucke');
});

test('slug registry: duplicates get -1, -2, … suffixes', () => {
  const registry = createSlugRegistry();
  assert.deepEqual(registry.next('Intro'), { id: 'intro', duplicate: false });
  assert.deepEqual(registry.next('Intro'), { id: 'intro-1', duplicate: true });
  assert.deepEqual(registry.next('Intro'), { id: 'intro-2', duplicate: true });
  assert.deepEqual(registry.next('Other'), { id: 'other', duplicate: false });
});

test('slug registry: a suffix already claimed by an explicit heading is skipped', () => {
  const registry = createSlugRegistry();
  assert.equal(registry.next('Intro').id, 'intro');
  assert.equal(registry.next('Intro 1').id, 'intro-1');
  // `intro-1` is taken, so the second "Intro" must not steal it.
  assert.equal(registry.next('Intro').id, 'intro-2');
});

test('slug registry: an empty heading text falls back to `section`', () => {
  const registry = createSlugRegistry();
  assert.equal(registry.next('').id, 'section');
  assert.equal(registry.next('!!!').id, 'section-1');
});

test('slug registry: has() and ids() report what has been handed out', () => {
  const registry = createSlugRegistry();
  registry.next('Alpha');
  registry.next('Beta');
  assert.equal(registry.has('alpha'), true);
  assert.equal(registry.has('gamma'), false);
  assert.deepEqual(registry.ids().sort(), ['alpha', 'beta']);
  registry.reset();
  assert.deepEqual(registry.ids(), []);
});

test('inline markup is stripped before slugging: I<sup>2</sup>C -> i2c', async () => {
  const { headings, html } = await render('# I<sup>2</sup>C\n');
  assert.equal(headings[0].id, 'i2c');
  assert.match(html, /<h1 id="i2c"/);
});

test('emphasis, code and links inside a heading do not leak into the slug', async () => {
  const { headings } = await render(
    '# Using **bold**, `code` and [a link](https://example.com/)\n',
  );
  assert.equal(headings[0].id, 'using-bold-code-and-a-link');
});

test('duplicate headings in one document are deduped in the emitted ids', async () => {
  const { headings } = await render('# Title\n\n## Notes\n\n## Notes\n\n## Notes\n');
  assert.deepEqual(headings.map((h) => h.id), ['title', 'notes', 'notes-1', 'notes-2']);
});
