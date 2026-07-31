/**
 * Pathological input -- the "never hang the build" contract.
 *
 * SPEC.md §0 makes this a CI tool, which means a malformed document must not be able to
 * wedge a pipeline. Every case here is a shape that naively-written Markdown scanners go
 * quadratic or exponential on: bracket nesting, unclosed emphasis runs, unterminated
 * fences, very wide tables and very long lines.
 *
 * Each case must parse *and* render inside `BUDGET_MS` on a cold cache. The numbers are
 * deliberately loose -- this is a liveness test, not a benchmark.
 */

import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import { createSlugRegistry } from '../src/markdown/slug.js';
import { loadSrc, testConfig, timed } from './helpers/harness.js';

/** Wall-clock budget per case. A correct implementation finishes in milliseconds. */
const BUDGET_MS = 5000;

/** @type {(source: string, opts: object) => object} */
let parseMarkdown;
/** @type {(ast: object, opts: object) => object} */
let renderHtml;
/** @type {object} */
let config;

before(async () => {
  ({ parseMarkdown } = await loadSrc('markdown/parser.js'));
  ({ renderHtml } = await loadSrc('markdown/renderer.js'));
  config = testConfig();
  // Warm the modules so the first timed case does not pay for lazy compilation.
  parseMarkdown('# warm\n', { file: 'warm.md', config });
});

/**
 * Parse and render `source`, returning how long both took together.
 * @param {string} source
 * @returns {{ ms: number, html: string }}
 */
function run(source) {
  const { ms, value } = timed(() => {
    const parsed = parseMarkdown(source, { file: 'pathological.md', config });
    return renderHtml(parsed.ast, {
      file: 'pathological.md',
      config,
      slugRegistry: createSlugRegistry(),
    });
  });
  return { ms, html: value.html };
}

/**
 * @typedef {Object} StressCase
 * @property {string} name
 * @property {() => string} build
 */

/** @type {StressCase[]} */
const CASES = [
  {
    name: '5000 balanced nested brackets',
    build: () => `${'['.repeat(5000)}x${']'.repeat(5000)}\n`,
  },
  {
    name: '5000 unclosed opening brackets',
    build: () => `${'['.repeat(5000)}x\n`,
  },
  {
    name: '5000 unmatched closing brackets',
    build: () => `x${']'.repeat(5000)}\n`,
  },
  {
    name: '2000 nested link openings',
    build: () => `${'[a]('.repeat(2000)}x\n`,
  },
  {
    name: '2000 nested image openings',
    build: () => `${'!['.repeat(2000)}x\n`,
  },
  {
    name: '2000 unclosed emphasis markers',
    build: () => `${'*'.repeat(2000)}\n`,
  },
  {
    name: '1000 unclosed strong markers',
    build: () => `${'**'.repeat(1000)}text\n`,
  },
  {
    name: 'alternating emphasis openers (the classic quadratic case)',
    build: () => `${'*a'.repeat(3000)}\n`,
  },
  {
    name: 'alternating underscore emphasis openers',
    build: () => `${'_a'.repeat(3000)}\n`,
  },
  {
    name: '5000 backticks in a row',
    build: () => `${'`'.repeat(5000)}\n`,
  },
  {
    name: 'alternating backtick runs',
    build: () => `${'`a'.repeat(3000)}\n`,
  },
  {
    name: '1 MB single line',
    build: () => `${'lorem ipsum '.repeat(87000)}\n`,
  },
  {
    // Deliberately kept at 120 KB rather than 1 MB: a scanner that is quadratic in the
    // number of unclosed link openings takes ~12s here and would take hours on 1 MB, so
    // this size is enough to surface the problem without wedging the suite.
    name: '120 KB single line of unclosed link openings',
    build: () => `${'[*a*]('.repeat(20000)}\n`,
  },
  {
    name: '200 levels of nested list',
    build: () => {
      const lines = [];
      for (let i = 0; i < 200; i += 1) lines.push(`${' '.repeat(i * 2)}- item ${i}`);
      return `${lines.join('\n')}\n`;
    },
  },
  {
    name: '500 levels of nested blockquote',
    build: () => `${'> '.repeat(500)}deep\n`,
  },
  {
    name: 'unterminated fence at EOF with 10000 lines',
    build: () => `\`\`\`js\n${'const x = 1;\n'.repeat(10000)}`,
  },
  {
    name: 'unterminated tilde fence at EOF',
    build: () => `~~~\n${'body\n'.repeat(5000)}`,
  },
  {
    name: 'table with 500 columns',
    build: () => {
      const header = `|${Array.from({ length: 500 }, (_, i) => ` c${i} `).join('|')}|`;
      const delim = `|${Array.from({ length: 500 }, () => '---').join('|')}|`;
      const row = `|${Array.from({ length: 500 }, (_, i) => ` v${i} `).join('|')}|`;
      return `${header}\n${delim}\n${row}\n${row}\n${row}\n`;
    },
  },
  {
    name: 'table with 5000 rows',
    build: () => `| a | b |\n|---|---|\n${'| 1 | 2 |\n'.repeat(5000)}`,
  },
  {
    name: '3000 unclosed raw HTML tags',
    build: () => `${'<div>'.repeat(3000)}\n`,
  },
  {
    name: '3000 unknown angle-bracket placeholders',
    build: () => `${'<your-volume> '.repeat(3000)}\n`,
  },
  {
    name: '2000 undefined link references',
    build: () => `${'[a][b] '.repeat(2000)}\n`,
  },
  {
    name: '2000 footnote references without definitions',
    build: () => `${'[^x] '.repeat(2000)}\n`,
  },
  {
    name: 'unterminated frontmatter followed by 10000 lines',
    build: () => `---\ntitle: X\n${'key: value\n'.repeat(10000)}`,
  },
  {
    name: '5000 setext-ambiguous lines',
    build: () => `${'text\n---\n'.repeat(2500)}`,
  },
  {
    name: 'deeply nested emphasis inside brackets',
    build: () => `${'[**'.repeat(2000)}x\n`,
  },
];

for (const stress of CASES) {
  test(`terminates quickly: ${stress.name}`, () => {
    const source = stress.build();
    const { ms, html } = run(source);
    assert.equal(typeof html, 'string', 'the renderer returned no html');
    assert.ok(
      ms < BUDGET_MS,
      `${stress.name} took ${ms.toFixed(0)}ms (budget ${BUDGET_MS}ms) for ${source.length} bytes`,
    );
  });
}

test('a pathological document still produces diagnostics rather than crashing', () => {
  const source = `${'['.repeat(500)}x\n\n\`\`\`js\nunterminated\n`;
  const parsed = parseMarkdown(source, { file: 'pathological.md', config });
  assert.ok(Array.isArray(parsed.diagnostics));
  assert.ok(
    parsed.diagnostics.some((d) => d.code === 'MD020'),
    'the unterminated fence was not reported',
  );
});

test('an empty document and a whitespace-only document are handled', () => {
  for (const source of ['', '\n', '   \n\n\t\n', '\r\n\r\n']) {
    const parsed = parseMarkdown(source, { file: 'empty.md', config });
    assert.equal(parsed.ast.type, 'document');
    assert.ok(Array.isArray(parsed.ast.children));
    const out = renderHtml(parsed.ast, {
      file: 'empty.md',
      config,
      slugRegistry: createSlugRegistry(),
    });
    assert.equal(typeof out.html, 'string');
  }
});

test('stray control characters do not derail the scanner', () => {
  const source = '\u0000\u0001\u0002 text \u0007 more\n';
  const { ms, html } = run(source);
  assert.equal(typeof html, 'string');
  assert.ok(ms < BUDGET_MS);
});
