# md2spa test suite

Zero dependencies. Everything runs on `node:test` + `node:assert/strict`.

## Running

```sh
npm test                      # node --test test/   (Node 18-22)
node --test                   # discovers test/ from the repo root (all versions)
node --test 'test/**/*.test.js'
node --test --watch           # re-run on change
node --test test/markdown.test.js       # one suite
node --test --test-name-pattern 'MD030' # one case
```

> **Node 23+**: `node --test test/` treats the positional argument as a file, not a
> directory, and fails with `MODULE_NOT_FOUND: .../test`. Use `node --test` with no
> argument (or the glob form) on Node 23 and later. `npm test` still works on Node 18-22.

Node also treats *every* `.js` file under `test/` as a test file, so
`test/helpers/harness.js` shows up in the output as a suite with zero tests. That is
expected; keep the harness free of side effects so it stays that way.

## What is being tested

These tests are written against **`SPEC.md`, not against the implementation**. SPEC.md is
the contract: if a test fails, the default assumption is that the implementation deviates
from the spec, not that the test is wrong. Only where SPEC.md is genuinely ambiguous is an
assertion softened, and every such place carries a comment saying so.

| Suite | Contract |
|---|---|
| `markdown.test.js` | SPEC §4 / §8b — one case per construct, plus CommonMark edge cases |
| `diagnostics.test.js` | SPEC §5 — every rule fires on bad input and stays quiet on good |
| `slug.test.js` | SPEC §4b — GitHub-compatible heading anchors and dedupe |
| `route.test.js` | SPEC §6 / §7b — file→route, humanised titles, nav order, prev/next, crumbs |
| `links.test.js` | SPEC §4b — the relative-link table, MD044/MD045/MD046 |
| `base.test.js` | SPEC §3 — `auto` / `/` / `/prefix/` at depths 0, 1 and 3 |
| `build.test.js` | SPEC §6 / §7 — end-to-end build, `verifyHtml`, SPA payloads, determinism |
| `security.test.js` | SPEC §4b — nothing executable reaches the output; dev-server traversal |
| `robustness.test.js` | pathological input terminates inside a wall-clock budget |

`diagnostics.test.js` ends with a completeness check: every code in `RULES` must appear
either in its case table or in `COVERED_ELSEWHERE`. Adding a rule without a test fails the
build.

## Extending

Shared plumbing lives in `test/helpers/harness.js`:

- `render(md, opts)` / `parse(md, opts)` — parse and render a snippet.
- `diagnose(md, opts)` — the union of parser, `validateDocument` and renderer diagnostics.
- `buildTempSite(files, configOverrides)` — materialise `{ 'content/index.md': '…' }` in a
  temp directory, run `buildSite`, and hand back `read` / `exists` / `files` helpers.
- `tempDir()` / `cleanupTemps()` — every suite that builds calls `after(cleanupTemps)`.
- `loadSrc('markdown/parser.js')` / `findExport('humanizeName', …)` — lazy module loading,
  so a missing module fails the test that needs it rather than aborting the whole file.

To add a diagnostic rule test, append one row to `CASES` in `diagnostics.test.js`:

```js
{ code: 'MD0xx', line: 3, bad: '# T\n\n…broken…\n', good: '# T\n\n…fixed…\n' }
```

Set `line: null` only when SPEC.md does not pin the reported location, and say why in a
comment next to the case.

To add a link-resolution case, append a row to `ROWS` in `links.test.js` with the authored
destination, the href SPEC §4b shows, and the absolute route it must resolve to.
