/**
 * The acceptance test for "detects if the md syntax is off" -- SPEC.md §5.
 *
 * Every rule code in the catalogue must (a) fire on a crafted bad document at the right
 * line and (b) stay quiet on the corrected version of that same document. The cases are
 * held in one table so that adding a rule to `RULES` without covering it here fails the
 * completeness test at the bottom rather than silently slipping through.
 *
 * Rules that need site-wide context (`MD044`/`MD045`/`MD046`, `NAV*`, `CFG*`, `HTM001`)
 * cannot be triggered by a single document; they are covered by the suites named in
 * `COVERED_ELSEWHERE` and the completeness test knows about that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RULES } from '../src/markdown/diagnostics.js';
import { diagnose, testConfig, withCode } from './helpers/harness.js';

/**
 * @typedef {Object} RuleCase
 * @property {string} code
 * @property {string} bad markdown that must produce `code`
 * @property {number|null} line expected 1-based line, or null when SPEC.md leaves it open
 * @property {string} good the corrected document, which must not produce `code`
 * @property {string} [why] note when the case encodes a judgement call
 */

/** @type {RuleCase[]} */
const CASES = [
  // --- Frontmatter / file level ------------------------------------------------
  {
    code: 'MD001',
    line: 1,
    bad: '---\ntitle: Unterminated\n\n# Heading\n\nBody.\n',
    good: '---\ntitle: Terminated\n---\n\n# Heading\n\nBody.\n',
  },
  {
    code: 'MD002',
    line: 3,
    bad: '---\ntitle: Typed\norder: abc\n---\n\n# Heading\n\nBody.\n',
    good: '---\ntitle: Typed\norder: 3\n---\n\n# Heading\n\nBody.\n',
  },
  {
    code: 'MD003',
    // "file is empty or contains only frontmatter" is a file-level finding; SPEC.md does
    // not say whether it points at line 1 or at the line where content should have begun.
    line: null,
    bad: '---\ntitle: Empty Body\n---\n',
    good: '---\ntitle: Full Body\n---\n\n# Heading\n\nBody.\n',
    why: 'SPEC.md §5 MD003 does not pin the reported location',
  },
  {
    code: 'MD004',
    line: 1,
    bad: '# Heading\r\n\r\nBody text.\r\n',
    good: '# Heading\n\nBody text.\n',
  },
  {
    code: 'MD005',
    line: 1,
    bad: '\ufeff# Heading\n\nBody text.\n',
    good: '# Heading\n\nBody text.\n',
  },

  // --- Headings ----------------------------------------------------------------
  {
    code: 'MD010',
    line: 1,
    bad: '#Heading\n\nBody text.\n',
    good: '# Heading\n\nBody text.\n',
  },
  {
    code: 'MD011',
    line: 3,
    bad: '# One\n\n### Three\n',
    good: '# One\n\n## Two\n\n### Three\n',
  },
  {
    code: 'MD012',
    line: 3,
    bad: '# First\n\n# Second\n',
    good: '# First\n\n## Second\n',
  },
  {
    code: 'MD013',
    line: 1,
    bad: 'Just a paragraph with no heading at all.\n',
    good: '# Heading\n\nJust a paragraph.\n',
  },
  {
    code: 'MD014',
    line: 5,
    bad: '# Title\n\n## Notes\n\n## Notes\n',
    good: '# Title\n\n## Notes\n\n## Other Notes\n',
  },
  {
    code: 'MD015',
    line: 3,
    bad: '# Title\n\n##\n\nBody.\n',
    good: '# Title\n\n## Real Heading\n\nBody.\n',
  },

  // --- Code --------------------------------------------------------------------
  {
    code: 'MD020',
    line: 3,
    bad: '# Title\n\n```js\nconst x = 1;\n',
    good: '# Title\n\n```js\nconst x = 1;\n```\n',
  },
  {
    code: 'MD021',
    line: 3,
    bad: '# Title\n\nUse `npm run build to compile.\n',
    good: '# Title\n\nUse `npm run build` to compile.\n',
  },
  {
    code: 'MD022',
    line: 3,
    bad: '# Title\n\n```notalanguage\nx\n```\n',
    good: '# Title\n\n```js\nconst x = 1;\n```\n',
  },

  // --- Tables ------------------------------------------------------------------
  {
    code: 'MD030',
    line: 3,
    bad: '# Title\n\n| Feature | Status |\n| Alpha | ready |\n',
    good: '# Title\n\n| Feature | Status |\n|---------|--------|\n| Alpha | ready |\n',
  },
  {
    code: 'MD031',
    line: 5,
    bad: '# Title\n\n| A | B |\n|---|---|\n| 1 | 2 | 3 |\n',
    good: '# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |\n',
  },
  {
    code: 'MD032',
    line: 4,
    // Every character is delimiter-ish, so this is a *malformed* delimiter row
    // (MD032) rather than a missing one (MD030).
    bad: '# Title\n\n| A | B |\n|--|-:-|\n| 1 | 2 |\n',
    good: '# Title\n\n| A | B |\n|--|:-:|\n| 1 | 2 |\n',
  },

  // --- Links / images ----------------------------------------------------------
  {
    code: 'MD040',
    line: 3,
    bad: '# Title\n\nSee [the docs](https://example.com/ for details.\n',
    good: '# Title\n\nSee [the docs](https://example.com/) for details.\n',
  },
  {
    code: 'MD041',
    line: 3,
    bad: '# Title\n\nSee [the docs][missing].\n',
    good: '# Title\n\nSee [the docs][present].\n\n[present]: https://example.com/\n',
  },
  {
    code: 'MD042',
    line: 3,
    bad: '# Title\n\nSee [the docs]().\n',
    good: '# Title\n\nSee [the docs](https://example.com/).\n',
  },
  {
    code: 'MD043',
    line: 3,
    bad: '# Title\n\n![](https://example.com/diagram.png)\n',
    good: '# Title\n\n![A diagram](https://example.com/diagram.png)\n',
  },
  {
    code: 'MD047',
    line: 3,
    bad: '# Title\n\nVisit https://example.com/ for details.\n',
    good: '# Title\n\nVisit <https://example.com/> for details.\n',
  },
  {
    code: 'MD048',
    line: 5,
    bad: '# Title\n\nBody text.\n\n[unused]: https://example.com/\n',
    good: '# Title\n\nBody [text][used].\n\n[used]: https://example.com/\n',
  },

  // --- Emphasis / inline / raw HTML --------------------------------------------
  {
    code: 'MD050',
    line: 3,
    bad: '# Title\n\nThis is **bold without a closing marker.\n',
    good: '# Title\n\nThis is **bold with a closing marker**.\n',
  },
  {
    code: 'MD051',
    line: 3,
    // An orphan closing tag pins the line exactly; the unclosed-open-tag variant is
    // asserted separately below without a line expectation.
    bad: '# Title\n\n</div>\n',
    good: '# Title\n\n<div>Body.</div>\n',
  },
  {
    code: 'MD052',
    line: 3,
    bad: '# Title\n\n<iframe src="https://evil.example/"></iframe>\n',
    good: '# Title\n\nPress <kbd>Ctrl</kbd>.\n',
  },

  // --- Lists / structure -------------------------------------------------------
  {
    code: 'MD060',
    line: 4,
    bad: '# Title\n\n- alpha\n* bravo\n',
    good: '# Title\n\n- alpha\n- bravo\n',
  },
  {
    code: 'MD061',
    line: 4,
    bad: '# Title\n\n1. one\n3. three\n',
    good: '# Title\n\n1. one\n2. two\n',
  },
  {
    code: 'MD062',
    line: 4,
    bad: '# Title\n\n- alpha\n   - bravo\n',
    good: '# Title\n\n- alpha\n  - bravo\n',
  },
  {
    code: 'MD063',
    line: 4,
    bad: '# Title\n\n- alpha\n\t- bravo\n',
    good: '# Title\n\n- alpha\n  - bravo\n',
  },
  {
    code: 'MD064',
    // SPEC.md does not say what terminates an MkDocs admonition, so "unclosed" is read
    // as "the marker opened a block that never received an indented body". The line is
    // left unasserted because the implementation may reasonably report either the
    // opening marker or EOF.
    line: null,
    bad: '# Title\n\n!!! note "Orphan"\n',
    good: '# Title\n\n!!! note "Adopted"\n    Body paragraph.\n',
    why: 'SPEC.md §5 MD064 does not pin the reported location',
  },
  {
    code: 'MD065',
    line: 3,
    bad: '# Title\n\nA line with one trailing space \n',
    good: '# Title\n\nA line with no trailing space\n',
  },

  // --- Footnotes ---------------------------------------------------------------
  {
    code: 'MD070',
    line: 3,
    bad: '# Title\n\nStatement[^missing].\n',
    good: '# Title\n\nStatement[^present].\n\n[^present]: The note.\n',
  },
  {
    code: 'MD071',
    line: 5,
    bad: '# Title\n\nBody text.\n\n[^orphan]: Never referenced.\n',
    good: '# Title\n\nBody text[^used].\n\n[^used]: Referenced.\n',
  },
  {
    code: 'MD072',
    line: 7,
    bad: '# Title\n\nStatement[^1].\n\n[^1]: First.\n\n[^1]: Second.\n',
    good: '# Title\n\nStatement[^1].\n\n[^1]: Only.\n',
  },
];

/** Rules that a single Markdown document cannot trigger, and where they are covered. */
const COVERED_ELSEWHERE = new Map([
  ['MD044', 'test/links.test.js'],
  ['MD045', 'test/links.test.js'],
  ['MD046', 'test/links.test.js'],
  ['CFG001', 'src/config.js schema validation (test/build.test.js)'],
  ['CFG002', 'src/config.js schema validation (test/build.test.js)'],
  ['CFG003', 'src/config.js schema validation (test/build.test.js)'],
  ['NAV001', 'test/route.test.js'],
  ['NAV002', 'test/route.test.js'],
  ['HTM001', 'test/build.test.js (verifyHtml)'],
  // The mermaid rules need a diagram to fire, and the `bad`/`good` pair this table is built
  // from cannot express "this line of flowchart is unparseable" without duplicating half of
  // SPEC-MERMAID. They get a test each, by code, in the diagram suite.
  ['MD080', 'test/mermaid.test.js'],
  ['MD081', 'test/mermaid.test.js'],
  ['MD082', 'test/mermaid.test.js'],
  ['MD083', 'test/mermaid.test.js'],
  ['MD084', 'test/mermaid.test.js'],
]);

/** A document that exercises most of the dialect and must be diagnostic-free. */
const CLEAN_DOCUMENT = [
  '---',
  'title: Clean Document',
  'description: Everything in this file is well-formed',
  'order: 1',
  'draft: false',
  'tags: [example, reference]',
  '---',
  '',
  '# Clean Document',
  '',
  'An ordinary paragraph with **strong**, *emphasis* and `inline code`.',
  '',
  '## Lists',
  '',
  '- first item',
  '- second item',
  '',
  '1. one',
  '2. two',
  '',
  '## Code',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '## Table',
  '',
  '| Feature | Status |',
  '|:--------|-------:|',
  '| Alpha | ready |',
  '',
  '## Links',
  '',
  'See [the site](https://example.com/) and <https://example.org/>.',
  '',
  '![A diagram](https://example.com/diagram.png)',
  '',
  'A statement worth qualifying[^1].',
  '',
  '[^1]: The supporting footnote.',
  '',
].join('\n');

for (const rc of CASES) {
  const title = RULES[rc.code] ? RULES[rc.code].title : '(not in RULES)';

  test(`${rc.code} fires on bad input -- ${title}`, async () => {
    const diagnostics = await diagnose(rc.bad, { file: `${rc.code.toLowerCase()}-bad.md` });
    const hits = withCode(diagnostics, rc.code);
    assert.ok(
      hits.length > 0,
      `${rc.code} did not fire. Diagnostics seen: ${
        diagnostics.map((d) => `${d.code}@${d.line}`).join(', ') || '(none)'}`,
    );
    if (rc.line !== null) {
      const lines = hits.map((d) => d.line);
      assert.ok(
        lines.includes(rc.line),
        `${rc.code} expected at line ${rc.line}, reported at ${lines.join(', ')}`,
      );
    }
  });

  test(`${rc.code} stays quiet on the corrected input`, async () => {
    const diagnostics = await diagnose(rc.good, { file: `${rc.code.toLowerCase()}-good.md` });
    assert.deepEqual(
      withCode(diagnostics, rc.code).map((d) => `${d.line}:${d.column} ${d.message}`),
      [],
      `${rc.code} fired on a clean document`,
    );
  });
}

test('MD051 also fires for an opening tag that is never closed', async () => {
  const diagnostics = await diagnose('# Title\n\n<div>\nBody text.\n');
  assert.ok(withCode(diagnostics, 'MD051').length > 0);
});

test('a well-formed document produces no diagnostics at all', async () => {
  const diagnostics = await diagnose(CLEAN_DOCUMENT, { file: 'clean.md' });
  assert.deepEqual(
    diagnostics.map((d) => `${d.code} ${d.line}:${d.column} ${d.message}`),
    [],
  );
});

test('every rule in RULES is covered by this suite or a named sibling', () => {
  const covered = new Set(CASES.map((c) => c.code));
  const missing = Object.keys(RULES).filter(
    (code) => !covered.has(code) && !COVERED_ELSEWHERE.has(code),
  );
  assert.deepEqual(
    missing,
    [],
    `these rule codes have no test: ${missing.join(', ')}`,
  );
});

test('the table has no case for a code that does not exist', () => {
  const unknown = CASES.map((c) => c.code).filter((code) => !RULES[code]);
  assert.deepEqual(unknown, []);
});

test('diagnostics carry the full SPEC §5 shape', async () => {
  const diagnostics = await diagnose('# Title\n\nSee [the docs]().\n');
  const diagnostic = withCode(diagnostics, 'MD042')[0];
  assert.ok(diagnostic, 'MD042 was not produced');

  assert.equal(typeof diagnostic.code, 'string');
  assert.equal(diagnostic.severity, 'error');
  assert.equal(typeof diagnostic.message, 'string');
  assert.ok(!/\.$/.test(diagnostic.message), 'message must not end with a period');
  assert.ok(!/\u001b/.test(diagnostic.message), 'message must not contain colour codes');
  assert.ok(!diagnostic.message.includes('\n'), 'message must be one line');
  assert.ok(diagnostic.hint === null || typeof diagnostic.hint === 'string');
  assert.equal(typeof diagnostic.file, 'string');
  assert.ok(!diagnostic.file.includes('\\'), 'file must use POSIX separators');
  for (const field of ['line', 'column', 'endLine', 'endColumn']) {
    assert.equal(typeof diagnostic[field], 'number', `${field} must be a number`);
    assert.ok(diagnostic[field] >= 1, `${field} must be 1-based`);
  }
  assert.ok(diagnostic.endLine >= diagnostic.line);
});

// ---------------------------------------------------------------------------
// config.rules severity overrides -- SPEC §5
// ---------------------------------------------------------------------------

const BARE_URL_DOC = '# Title\n\nVisit https://example.com/ for details.\n';

test('config.rules can silence a rule with "off"', async () => {
  const noisy = await diagnose(BARE_URL_DOC);
  assert.ok(withCode(noisy, 'MD047').length > 0, 'MD047 baseline missing');

  const quiet = await diagnose(BARE_URL_DOC, {
    config: testConfig({ rules: { MD047: 'off' } }),
  });
  assert.deepEqual(withCode(quiet, 'MD047'), []);
});

test('config.rules can raise a rule to error', async () => {
  const diagnostics = await diagnose(BARE_URL_DOC, {
    config: testConfig({ rules: { MD047: 'error' } }),
  });
  const hits = withCode(diagnostics, 'MD047');
  assert.ok(hits.length > 0);
  for (const d of hits) assert.equal(d.severity, 'error');
});

test('config.rules can lower an error to info', async () => {
  const diagnostics = await diagnose('# Title\n\nSee [the docs]().\n', {
    config: testConfig({ rules: { MD042: 'info' } }),
  });
  const hits = withCode(diagnostics, 'MD042');
  assert.ok(hits.length > 0);
  for (const d of hits) assert.equal(d.severity, 'info');
});

test('an "off" override silences an error-severity rule too', async () => {
  const diagnostics = await diagnose('# Title\n\nSee [the docs]().\n', {
    config: testConfig({ rules: { MD042: 'off' } }),
  });
  assert.deepEqual(withCode(diagnostics, 'MD042'), []);
});

test('default severities match the RULES table', async () => {
  const diagnostics = await diagnose('# Title\n\nVisit https://example.com/ now.\n');
  for (const d of diagnostics) {
    assert.equal(d.severity, RULES[d.code].severity, `${d.code} severity`);
  }
});
