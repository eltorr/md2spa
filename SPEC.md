# md2spa — Implementation Contract

> **This file is the authoritative interface contract.** Every module below MUST match
> these signatures, field names, and semantics exactly. Do not invent alternative names.
> If something is underspecified, choose the simplest option consistent with the rest.

## 0. Ground rules

- **Zero runtime dependencies.** No npm packages. Node.js `>=18` built-ins only
  (`node:fs`, `node:path`, `node:url`, `node:http`, `node:crypto`, `node:test`).
  This is what makes the tool deployable in any CI (GitLab, GitHub, Woodpecker, Drone).
- **ESM only.** `"type": "module"` in package.json. All imports use explicit `.js` extensions.
- **No `eval`, no `new Function`.** Generated sites must survive strict CSP.
- **Every emitted file is deterministic.** Same input bytes → same output bytes.
  No timestamps, no `Math.random()`, no `Date.now()` in output. (Build metadata may
  include a date only when `config.buildDate` is explicitly supplied.)
- **Pure functions where possible.** Modules take data in, return data out. Only
  `build/*.js`, `cli.js`, and `serve.js` touch the filesystem.
- Code style: 2-space indent, single quotes, semicolons, named exports, JSDoc on every
  exported function. No classes unless there is genuine state.

## 1. Directory layout (final)

```
md2spa/
├── package.json                  bin: { "md2spa": "./src/cli.js" }, type: module
├── README.md
├── SPEC.md                       (this file)
├── LICENSE
├── .gitignore
├── md2spa.config.json           default config for the bundled example site
├── src/
│   ├── cli.js                    #!/usr/bin/env node — arg parsing, command dispatch
│   ├── config.js                 loadConfig / normalizeConfig / DEFAULT_CONFIG
│   ├── util/
│   │   ├── fs.js                 walkDir, readTextFile, writeFileDeep, copyDirDeep, emptyDir
│   │   ├── path.js               toPosix, relativeUrl, joinUrl, depthOf
│   │   ├── html.js               escapeHtml, escapeAttr, sanitizeRawHtml, ALLOWED_TAGS
│   │   └── hash.js               shortHash(string) -> 8-char hex (sha256 slice)
│   ├── markdown/
│   │   ├── diagnostics.js        Diagnostic factory, RULES table, DiagnosticBag
│   │   ├── frontmatter.js        parseFrontmatter (mini-YAML)
│   │   ├── lexer.js              block-level scanner -> block AST (calls inline.js)
│   │   ├── inline.js             inline scanner -> inline AST
│   │   ├── parser.js             parseMarkdown() — public entry, orchestrates the above
│   │   ├── slug.js               slugify + SlugRegistry (dedupe)
│   │   ├── highlight.js          build-time syntax highlighter
│   │   ├── renderer.js           renderHtml(ast) -> { html, toc, headings, text, links, images }
│   │   └── validate.js           structural lint pass over AST -> diagnostics
│   ├── content/
│   │   ├── scan.js               scanContent() — walk contentDir -> PageSource[]
│   │   ├── route.js              filePathToRoute, routeToOutputPath
│   │   ├── nav.js                buildNav() -> NavNode tree, prev/next chain, breadcrumbs
│   │   └── links.js              resolveLinks() — cross-page link + anchor validation
│   ├── build/
│   │   ├── build.js              buildSite() — the orchestrator
│   │   ├── layout.js             renderPageShell() -> full HTML document string
│   │   ├── search.js             buildSearchIndex()
│   │   ├── sitemap.js            buildSitemap, buildRobots
│   │   ├── notfound.js           render404()
│   │   └── verify.js             verifyHtml() — well-formedness check of emitted HTML
│   ├── report.js                 formatDiagnostics() — pretty CLI output w/ carets
│   ├── serve.js                  dev server: static + SPA fallback + live reload + rebuild
│   └── theme/
│       ├── style.css             the entire visual design (single file)
│       ├── app.js                SPA runtime: router, search, TOC scrollspy, theme toggle
│       └── bootstrap.js          inline <head> snippet source (theme/no-FOUC) — exported as string
├── content/                      example/demo site content
│   ├── index.md
│   ├── _meta.json
│   ├── guide/...
│   └── reference/...
├── static/                       copied verbatim into outDir
├── test/                         node:test suites
└── deploy/                       .gitlab-ci.yml, github workflow, netlify.toml, etc.
```

## 2. Config

`md2spa.config.json` (also accepts `.mjs`/`.js` exporting default object).

```jsonc
{
  "title": "My Docs",              // site title, required-ish (defaults "Documentation")
  "description": "",               // default meta description
  "lang": "en",
  "base": "auto",                  // "auto" | "/" | "/subpath/"  — see §3
  "siteUrl": "",                   // absolute origin+path, only for canonical/sitemap/og
  "contentDir": "content",
  "outDir": "dist",
  "staticDir": "static",
  "cleanUrls": true,               // true -> /guide/install/ ; false -> /guide/install.html
  "spa": true,                     // emit SPA runtime + JSON payloads
  "search": true,
  "toc": { "minDepth": 2, "maxDepth": 3 },
  "nav": { "collapseDepth": 1, "sort": "auto" },   // sort: "auto" | "alpha" | "manual"
  "theme": {
    "accent": "#5b5bd6",
    "accentDark": "#8f8fff",
    "defaultMode": "auto",         // "auto" | "light" | "dark"
    "font": "",                    // optional CSS font-family override for body
    "monoFont": "",
    "logo": "",                    // path under staticDir
    "favicon": ""
  },
  "repo": { "url": "", "label": "", "editBase": "" },  // editBase e.g. ".../-/edit/main/content"
  "footer": { "text": "", "links": [{ "label": "", "url": "" }] },
  "highlight": true,
  "strict": false,                 // treat warnings as errors
  "buildDate": null                // ISO string or null; null => omitted from output
}
```

`loadConfig(cwd, overrides)` → `{ config, diagnostics }`. Unknown top-level keys produce a
`CFG002` warning. Type mismatches produce `CFG001` errors. Missing file is fine (defaults used).

## 3. Base-path resolution — "deploy anywhere"

This is the single most important portability feature. Three modes:

- **`base: "auto"` (default).** All asset/link URLs in generated HTML are emitted as
  **document-relative** paths (`../../assets/style.abc12345.css`) computed from the page's
  route depth. `<html>` carries `data-depth="N"`. The SPA runtime computes
  `siteBase = new URL('../'.repeat(depth) || './', location.href).pathname`.
  Result: the site works identically at `/`, at `/user/project/` (GitLab/GitHub Pages),
  inside a subfolder of another site, and -- with `cleanUrls: false`, so that every link
  names a real `.html` file rather than a directory -- opened straight from disk over `file://`.
- **`base: "/prefix/"`.** URLs emitted as root-relative `/prefix/assets/...`.
  `data-base="/prefix/"` on `<html>`; runtime trusts it.
- **`base: "/"`.** Root-relative, no prefix.

`util/path.js` exports:
```js
relativeUrl(fromRoute, toRoute)   // '/guide/install/' -> '/assets/a.css'  =>  '../../assets/a.css'
depthOf(route)                    // '/'=>0, '/guide/'=>1, '/guide/install/'=>2
joinUrl(...parts)                 // normalizes slashes, never doubles them
```
`build/layout.js` MUST route every URL it emits through a single `url(target)` helper
built from the config + current route so that all three modes are handled in one place.

`404.html` is special: it may be served from *any* depth, so it embeds an inline bootstrap
that derives the site base by matching the longest known-route suffix of `location.pathname`
against a build-time-embedded route list, then loads assets from there. If no match, it
falls back to `config.base` (or `/`).

## 4. Markdown AST

All nodes: `{ type, line, column, ...props }`. `line`/`column` are **1-based**, pointing at
the first character of the construct in the original source.

### Block nodes
| type | props |
|---|---|
| `document` | `children: Block[]` |
| `heading` | `depth: 1..6`, `children: Inline[]`, `id: string`, `text: string` |
| `paragraph` | `children: Inline[]` |
| `list` | `ordered: bool`, `start: number`, `tight: bool`, `children: ListItem[]` |
| `listItem` | `children: Block[]`, `checked: null\|boolean` |
| `code` | `lang: string\|null`, `meta: string\|null`, `value: string`, `fenced: bool` |
| `blockquote` | `children: Block[]` |
| `admonition` | `kind: string` (lowercased), `title: string\|null`, `collapsible: bool`, `open: bool`, `children: Block[]` |
| `table` | `align: Array<'left'\|'center'\|'right'\|null>`, `header: TableCell[]`, `rows: TableCell[][]` |
| `thematicBreak` | — |
| `html` | `value: string` (raw block HTML) |
| `footnoteDefinition` | `identifier: string`, `children: Block[]` |
| `definition` | `identifier: string`, `url: string`, `title: string\|null` (link ref defs; not rendered) |

`TableCell = { children: Inline[], line, column }`.

### Inline nodes
| type | props |
|---|---|
| `text` | `value: string` |
| `strong` / `emphasis` / `delete` | `children: Inline[]` |
| `inlineCode` | `value: string` |
| `link` | `url: string`, `title: string\|null`, `children: Inline[]`, `reference: string\|null` |
| `image` | `url: string`, `title: string\|null`, `alt: string` |
| `break` | — (hard line break) |
| `footnoteReference` | `identifier: string` |
| `html` | `value: string` |

### Supported Markdown syntax (the target dialect)
CommonMark core + these extensions. Anything outside this set should parse as literal text
and, where it *looks* like a failed attempt at a supported construct, emit a diagnostic.

- ATX headings `#`..`######` (closing `#`s allowed). Setext headings (`===`, `---`).
- Paragraphs, hard breaks (two trailing spaces or `\`), soft breaks.
- Fenced code ``` ``` ``` and `~~~`, with `lang` + `meta`. Indented code (4 spaces).
- Blockquotes `>` incl. nesting and GitHub alerts `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` /
  `[!WARNING]` / `[!CAUTION]` → `admonition`.
- MkDocs admonitions: `!!! note "Title"` and collapsible `??? note "Title"` / `???+`.
- Lists: `-`, `*`, `+`, `1.`, `1)`; nested by indentation; task lists `- [ ]` / `- [x]`;
  tight vs loose detection.
- GFM tables with alignment row.
- Thematic breaks `---`, `***`, `___`.
- Inline: `**strong**`, `__strong__`, `*em*`, `_em_`, `~~del~~`, `` `code` `` (n-backtick),
  autolinks `<https://…>`, bare-URL linkification, `[text](url "title")`,
  `[text][ref]` + `[ref]: url "title"`, `![alt](src)`, footnotes `[^1]` + `[^1]: def`.
- Raw HTML: allowlisted tags only (see `util/html.js` `ALLOWED_TAGS`); disallowed tags are
  escaped and reported (`MD019`). Never emit `<script>`/`<style>`/`on*=` from Markdown.
- Entity references pass through; `&` otherwise escaped.

## 4b. Link resolution (derived from a real 93-file docs corpus)

Authors write **relative Markdown links**, exactly as they do on GitHub. The build MUST
rewrite them to routes. Observed real-world forms that must all work:

| Authored in `content/sw/tethered-boot.md` | Rendered href (`cleanUrls: true`) |
|---|---|
| `[x](partitioning-cheatsheet.md)` | `../partitioning-cheatsheet/` |
| `[x](../hw/soc/serial-debug.md)` | `../../hw/soc/serial-debug/` |
| `[x](../platform/dev-quickstart.md#setup)` | `../../platform/dev-quickstart/#setup` |
| `[x](index.md)` / `[x](./)` | `../` (the section index) |
| `[x](#soc-blocks)` | `#soc-blocks` (unchanged) |
| `[x](https://…)` | unchanged, gains `rel="noopener external"` + external icon |
| `[x](../assets/boot.png)` | resolved against `staticDir`, emitted via the `url()` helper |
| `mailto:` / `tel:` / `irc:` | unchanged |

Rules: resolve the target against the **source file's directory**, normalise, strip the
`.md`/`.markdown` extension, map `index.md` → the directory route, then re-emit through the
same `url()` helper used for every other URL (so all three `base` modes work). Preserve the
fragment and query. If the resolved page does not exist → `MD044`. If it exists but the
fragment matches no heading id on that page → `MD045`.

### Heading slugs
Must match GitHub / Python-Markdown so existing anchors keep working:
lowercase → strip everything except `[a-z0-9 _-]` (so `/`, `.`, `(`, `)`, `?`, `:` vanish
**without** leaving a separator) → collapse whitespace runs to a single `-` → trim `-`.
Verified: `"M1 Pro/Max/Ultra devices"` → `m1-promaxultra-devices`;
`"USB gadget mode (using a standard USB cable)"` → `usb-gadget-mode-using-a-standard-usb-cable`.
Duplicates get `-1`, `-2`, … (`MD014`). Inline markup is stripped before slugging;
`I<sup>2</sup>C` → `i2c`.

### Frontmatter policy
Arbitrary user keys are allowed and preserved on `page.frontmatter` (real corpora carry
device metadata like `iso_layout`, `fnmode`, `summary`). Only the **known** keys are
type-checked (`MD002`): `title` (string), `description`/`summary` (string), `order` (number),
`nav` (boolean|string), `draft` (boolean), `toc` (boolean), `tags` (string[]), `icon` (string),
`date` (string), `redirect_from` (string[]). Unknown keys never warn.

### Raw-HTML policy (important nuance)
Docs prose is full of angle-bracket placeholders (`<your-volume>`, `<num>`) and XML inside
prose. Therefore:
- Tag name in `ALLOWED_TAGS` → passed through, attributes filtered to a safe allowlist.
- Tag name is a **real HTML element** but not allowed (`script`, `style`, `iframe`, `object`,
  `embed`, `form`, `input`, `link`, `meta`, `base`, `svg` w/ handlers) → escaped **and** `MD052`.
- Tag name is not a known HTML element (`<your-volume>`, `<key>`, `<VDM>`) → escaped silently
  as literal text. **No diagnostic.** Emitting noise here would make the linter useless.
- Any `on*=` attribute, `javascript:`/`data:` (non-image) URL → stripped, always `MD052`.

`ALLOWED_TAGS` must include at minimum: `a abbr b br code dd del details dfn div dl dt em
figcaption figure h1-h6 hr i img ins kbd li mark ol p pre q s samp small span strong sub sup
summary table tbody td tfoot th thead tr u ul var picture source time`.
(`<details>/<summary>` appear 25× in the reference corpus — they must render and be styled.)

## 5. Diagnostics

```js
/** @typedef {'error'|'warning'|'info'} Severity */
/** @typedef {Object} Diagnostic
 *  @property {string} code       e.g. 'MD003'
 *  @property {Severity} severity
 *  @property {string} message    one line, no trailing period, no color codes
 *  @property {string|null} hint  actionable fix suggestion, or null
 *  @property {string} file       path relative to cwd, POSIX separators
 *  @property {number} line       1-based
 *  @property {number} column     1-based
 *  @property {number} endLine
 *  @property {number} endColumn
 */
```

`diagnostics.js` exports `RULES` — a frozen map `code -> { severity, title, docs }` — plus
`createBag(file)` returning `{ add(code, loc, message?, hint?), list(), hasErrors() }`.
Severity may be overridden per-rule via `config.rules = { MD014: 'off' | 'info' | 'warning' | 'error' }`.

### Rule catalogue (implement all)

**Frontmatter / file level**
- `MD001` malformed frontmatter (unterminated `---`, bad key/value) — **error**
- `MD002` frontmatter key has wrong type (e.g. `order: "abc"`) — **error**
- `MD003` file is empty or contains only frontmatter — **warning**
- `MD004` file uses CRLF line endings — **info**
- `MD005` file starts with a UTF-8 BOM — **info**

**Headings**
- `MD010` no space after `#` (`#Heading`) — **error**
- `MD011` heading level skipped (h2 → h4) — **warning**
- `MD012` more than one H1 in a document — **warning**
- `MD013` document has no H1 and no frontmatter `title` — **warning**
- `MD014` duplicate heading slug within a page (auto-suffixed `-1`) — **info**
- `MD015` empty heading (`##` with no text) — **error**

**Code**
- `MD020` unclosed fenced code block (EOF reached) — **error**
- `MD021` unmatched backtick run in inline code — **warning**
- `MD022` fenced code language is not recognised by the highlighter — **info**

**Tables**
- `MD030` table missing the delimiter row — **error**
- `MD031` table row cell count differs from the header — **warning**
- `MD032` table delimiter row is malformed (not `---`/`:--`/`--:`/`:-:`) — **error**

**Links / images**
- `MD040` unclosed link or image bracket/paren — **error**
- `MD041` link reference `[x][y]` has no matching definition — **error**
- `MD042` empty link destination `[text]()` — **error**
- `MD043` image has no alt text — **warning**
- `MD044` internal link points to a page that does not exist — **error**
- `MD045` internal link anchor does not exist on the target page — **warning**
- `MD046` referenced local asset does not exist under `staticDir`/content — **warning**
- `MD047` bare URL not wrapped in `<…>` or `[…](…)` (still linkified) — **info**
- `MD048` link reference definition is never used — **info**

**Emphasis / inline**
- `MD050` unclosed emphasis or strong marker on a line — **warning**
- `MD051` unclosed HTML tag in raw block — **warning**
- `MD052` disallowed raw HTML tag (escaped) — **warning**

**Lists / structure**
- `MD060` inconsistent list marker within one list (`-` then `*`) — **info**
- `MD061` ordered list numbering is not sequential — **info**
- `MD062` list item indentation is ambiguous (3-space / tab) — **warning**
- `MD063` hard tab used for indentation — **info**
- `MD064` unclosed admonition block — **error**
- `MD065` trailing whitespace (not a hard break) — **info**

**Footnotes**
- `MD070` footnote reference has no definition — **error**
- `MD071` footnote definition is never referenced — **info**
- `MD072` duplicate footnote definition — **warning**

**Config / site**
- `CFG001` config value has the wrong type — **error**
- `CFG002` unknown config key — **warning**
- `CFG003` `contentDir` does not exist — **error**
- `NAV001` two content files map to the same route — **error**
- `NAV002` folder has no `index.md` (a section landing page is generated) — **info**
- `HTM001` generated HTML failed the well-formedness check — **error**

## 6. Module signatures

```js
// markdown/parser.js
/** @returns {{ ast: DocumentNode, frontmatter: object, diagnostics: Diagnostic[] }} */
export function parseMarkdown(source, { file = '<input>', config = {} } = {})

// markdown/renderer.js
/** @returns {{
 *   html: string,                 // <article> inner HTML
 *   toc: TocItem[],               // nested: { id, text, depth, children: TocItem[] }
 *   headings: Array<{ id, text, depth }>,
 *   text: string,                 // plain text, for the search index
 *   links: Array<{ url, line, column }>,
 *   images: Array<{ url, alt, line, column }>,
 *   diagnostics: Diagnostic[]
 * }} */
export function renderHtml(ast, { file, config, slugRegistry })

// markdown/validate.js
export function validateDocument(ast, { file, frontmatter, config }) // -> Diagnostic[]

// markdown/highlight.js
export function highlight(code, lang)  // -> { html, recognized: boolean }
export const LANGUAGES  // Set<string> of ids + aliases

// content/scan.js
/** @typedef {Object} PageSource
 *  @property {string} file        'content/guide/install.md'
 *  @property {string} route       '/guide/install/'
 *  @property {string} source      raw markdown
 *  @property {object} frontmatter
 *  @property {number} depth
 *  @property {string} dir         '/guide/'
 *  @property {boolean} isIndex
 */
export function scanContent(config) // -> { pages: PageSource[], meta: Map<dir, object>, diagnostics }

// content/nav.js
/** @typedef {Object} NavNode
 *  @property {string} title
 *  @property {string|null} route   null for a folder without index.md
 *  @property {NavNode[]} children
 *  @property {number} depth
 *  @property {number} order
 */
export function buildNav(pages, meta, config)
  // -> { tree: NavNode[], flat: PageRef[], prevNext: Map<route,{prev,next}>, crumbs: Map<route,Crumb[]> }

// content/links.js
export function resolveLinks({ pages, rendered, anchorsByRoute, staticFiles, contentAssets,
                              extraRoutes, config, cwd })              // -> Diagnostic[]

// build/layout.js
export function renderPageShell(ctx)  // ctx documented in that file; -> full HTML string
export function renderSpaPayload(ctx) // -> JSON-serialisable object (see §7)

// build/build.js
export async function buildSite({ cwd, config, logger }) // -> { files: string[], diagnostics, stats }

// build/verify.js
export function verifyHtml(html, file)  // -> Diagnostic[]  (balanced tags, unique ids, required meta)
```

## 7. SPA contract

For every route, the build emits a payload whose path **mirrors the route**:
`/` → `_spa/index.json`, `/guide/install/` → `_spa/guide/install/index.json`.

```json
{
  "route": "/guide/install/",
  "title": "Installing",
  "description": "…",
  "html": "<article class=\"md\">…</article>",
  "toc": [ { "id": "requirements", "text": "Requirements", "depth": 2, "children": [] } ],
  "crumbs": [ { "title": "Home", "route": "/" }, { "title": "Guide", "route": "/guide/" } ],
  "prev": { "title": "…", "route": "…" } ,
  "next": null,
  "editUrl": "https://…",
  "hash": "abc12345"
}
```

`routeToPayloadPath(route)` is the single source of truth, and `theme/app.js` derives the
same path client-side by plain concatenation — no lookup table is shipped.

The mapping is injective **by construction**, not by escaping. A flattened stem
(`guide__install.json`) has to sanitise characters that are legal in a route, which makes it
lossy: `/a/b/` and `/a__b/` collapse onto one file, and any non-ASCII route sanitises down to
the empty string. Serving one page's content under another page's URL is the worst failure
this tool could have, so the structure carries the uniqueness instead.

`theme/app.js` responsibilities:
1. **Router** — intercept same-origin `<a>` clicks (skip: modifier keys, `target`, `download`,
   `rel=external`, hash-only, non-http). `fetch` the payload, swap `<article>`, update
   `document.title`, TOC, breadcrumbs, sidebar `aria-current`, prev/next. `history.pushState`.
   Handle `popstate`. On any failure → `location.assign(href)` (hard navigation fallback).
   Move focus to `<h1>` and announce via a polite live region. Restore scroll on back/forward.
2. **Progressive enhancement** — the pre-rendered HTML is complete and correct with JS
   disabled. The router only makes navigation faster.
3. **Search** — `/` or `Ctrl/Cmd+K` opens a modal; loads `search-index.json` lazily once;
   scores title > headings > body; arrow keys + Enter; Esc closes; focus trap.
4. **TOC scrollspy** via `IntersectionObserver`, `aria-current="location"`.
5. **Theme toggle** — cycles auto → light → dark, persisted in `localStorage['md2spa-theme']`.
6. **Mobile** — sidebar drawer w/ overlay, `Esc` closes, focus trap, `inert` on background.
7. **Code copy buttons**, injected client-side.
8. `prefers-reduced-motion` respected. No layout shift.

Everything degrades: if `app.js` fails to load, the site is still a fully working
pre-rendered multi-page doc site.

## 7b. Zero-config navigation from the folder tree (headline feature)

The reference site hand-maintains a 40-line `nav = [...]` block in its config. **We do not.**
Dropping `content/guide/advanced/tuning.md` into the tree makes it appear in the sidebar with
zero configuration. That is the product promise — protect it.

**Title resolution**, first match wins:
1. frontmatter `title:`
2. the document's first H1
3. `_meta.json` `titles` entry for that file
4. humanised filename: `getting-started.md` → "Getting Started"
   (split on `-`/`_`, title-case, preserve ALL-CAPS tokens and a small acronym list:
   `api cli cpu gpu ui ux id url http https json yaml html css js ts sdk os io ram usb pci faq`)

**Folder titles**: `_meta.json` `title` → folder's `index.md` title → humanised folder name.

**Ordering**, first match wins: frontmatter `order` (number, ascending) → position in
`_meta.json` `order: ["intro.md", "install.md"]` (unlisted items follow, alphabetical) →
alphabetical, with `index.md` always first and numeric filename prefixes (`01-intro.md`)
sorted numerically **and stripped from route + title**.

**Optional `_meta.json`** per folder — every key optional:
```json
{ "title": "User Guide", "order": ["intro.md", "install.md"], "collapsed": false,
  "icon": "book", "hidden": false, "titles": { "faq.md": "FAQs" } }
```

Other rules: `draft: true` or a leading `_` on a file/folder name excludes it from the build
(dev server still serves drafts, badged). `nav: false` builds the page but hides it from the
sidebar. A folder without `index.md` still becomes a nav group, and the build generates a
section landing page listing its children (`NAV002`, info).

**Sidebar tree UX** (this is what the user judges the tool by):
- Real disclosure widgets — `<details open>`-backed `<button aria-expanded>` per group,
  chevron rotates, height-animated (respecting `prefers-reduced-motion`), **works with JS off**.
- Groups on the active path auto-expand; the active leaf gets `aria-current="page"` and a
  2px accent rail. Ancestors get a subtler marker.
- Expansion state persists in `sessionStorage` across SPA navigations and reloads.
- Nesting is unlimited; indentation is a single CSS custom property `--nav-indent` multiplied
  by depth, with a hairline guide rail so deep trees stay legible.
- Sticky, independently scrollable, scrolls the active item into view on load.
- A filter box at the top of the sidebar live-filters the tree (matches titles, keeps
  matching ancestors visible, highlights the match) — this is what keeps a 100-page tree usable.
- Keyboard: `←`/`→` collapse/expand, `↑`/`↓` move — as a pure *enhancement*. Deliberately
  **not** `role="tree"` with a roving tabindex: that pattern requires `treeitem` children,
  forbids interactive descendants (ruling out the `<a>` inside each `<summary>`), and pulls
  every link but one out of the tab order. A `<nav>` landmark wrapping nested lists is what
  assistive technology handles best here, and it keeps every link reachable by Tab.

## 8. Visual design

Match the *spirit* of Material-for-MkDocs docs sites (clean, dense-but-airy technical docs):

- **Shell**: fixed top bar (site title/logo, search box, repo link, theme toggle, mobile
  menu button) + 3-column body: left nav (~16rem), content (max 46rem), right TOC (~14rem).
  Below 76rem the TOC collapses into the content; below 60rem the sidebar becomes a drawer.
- **Type**: system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …`),
  body 16px/1.7, `ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, …` for code.
  Content max-width in `ch` for comfortable measure.
- **Color**: CSS custom properties only, defined once for light and overridden under
  `[data-theme="dark"]` **and** `@media (prefers-color-scheme: dark)` when `data-theme="auto"`.
  Accent from `config.theme.accent`. Neutral gray ramp, subtle 1px borders, no heavy shadows.
- **Components to style**: headings w/ hover anchor links (`#`), paragraphs, links, lists,
  task lists, tables (sticky header, horizontal scroll wrapper, zebra-free, hairline borders),
  code blocks (rounded, bordered, filename/lang chip, copy button, horizontal scroll),
  inline code, blockquotes, 5 admonition kinds + `note/tip/info/warning/danger/example/quote`,
  keyboard `<kbd>`, footnotes, images (rounded, max-width 100%), status badges
  (`<span class="badge badge--ok">`) since the reference page is full of support matrices.
- **A11y**: visible focus rings everywhere, skip link, ≥4.5:1 contrast in both themes,
  reduced-motion, `aria-current`, landmark roles, no color-only meaning.
- Print stylesheet: hide chrome, show content.
- Single CSS file, no preprocessor, no `@import` of remote fonts (CSP/offline safe).

## 8b. HTML class contract (binding on renderer, layout AND stylesheet)

Exact markup the renderer emits. The stylesheet targets these and nothing else.

```html
<!-- headings: permalink anchor comes after the text -->
<h2 id="soc-blocks">SoC Blocks<a class="anchor" href="#soc-blocks" aria-hidden="true" tabindex="-1">#</a></h2>

<!-- code: figcaption only when the fence has a `title="..."` / bare filename meta -->
<figure class="code" data-lang="js">
  <figcaption class="code__title">server.js</figcaption>
  <pre class="code__pre"><code class="language-js"><span class="tok tok--kw">const</span> …</code></pre>
</figure>

<code class="code-inline">inline</code>

<div class="table-wrap"><table class="table"><thead>…<th class="is-center">…</table></div>

<div class="admonition admonition--warning" role="note">
  <p class="admonition__title">Warning</p><p>…</p></div>
<details class="admonition admonition--note is-collapsible"><summary class="admonition__title">Note</summary>…</details>

<blockquote class="quote">…</blockquote>
<ul class="task-list"><li class="task-list__item"><input type="checkbox" checked disabled> …</li></ul>
<a class="link link--external" href="…" rel="noopener noreferrer external" target="_blank">…<span class="link__icon" aria-hidden="true"></span></a>
<img class="md-img" src="…" alt="…" loading="lazy" decoding="async">
<sup class="footnote-ref"><a id="fnref-1" href="#fn-1">1</a></sup>
<section class="footnotes"><h2 class="footnotes__title">Footnotes</h2><ol><li id="fn-1">… <a class="footnote-back" href="#fnref-1">&#8617;</a></li></ol></section>
<span class="badge badge--ok">…</span>   <!-- badge--ok | --wip | --todo | --none | --info -->
```

Highlight token classes: `tok tok--{kw,str,num,com,fn,type,var,op,punc,attr,builtin,meta,ins,del}`.

Shell markup emitted by `build/layout.js`:

```
html[data-depth][data-base][data-theme-default]  body[data-route]
.skip-link
.topbar > .topbar__inner > .brand(.brand__logo,.brand__title) .topbar__actions
        (.search-trigger .theme-toggle .repo-link .nav-toggle)
.progress-bar
.layout > .sidebar > .sidebar__inner > .sidebar__filter, nav.nav-tree[role=tree]
             .nav-group > .nav-group__toggle[aria-expanded] > .nav-group__chevron
                        > .nav-group__list
             a.nav-link[.nav-link--active][.nav-link--ancestor][aria-current=page]
         > .content > .breadcrumbs > ol.breadcrumbs__list
                    > article.md
                    > .page-meta(.edit-link) > nav.page-nav(.page-nav__prev,.page-nav__next)
         > aside.toc > .toc__title, ol.toc__list > a.toc__link[.toc__link--active]
.site-footer
.overlay  .search-modal > .search-modal__panel > .search-input, .search-results > .search-result
```

## 9. CLI

```
md2spa build [--config <path>] [--out <dir>] [--base <path>] [--strict] [--no-spa] [--quiet]
md2spa dev   [--port 3000] [--host 127.0.0.1] [--open]
md2spa check [<paths…>] [--strict] [--format pretty|json|junit|github]
md2spa new   <route>            # scaffold a new .md with frontmatter
md2spa init                     # scaffold config + content skeleton in cwd
md2spa --version | --help
```

Exit codes: `0` ok, `1` diagnostics errors (or warnings under `--strict`), `2` bad usage,
`3` internal error. `check --format github` emits `::error file=…,line=…::msg` workflow
annotations; `junit` emits JUnit XML for GitLab CI test reports.

`report.js` pretty format:
```
content/guide/install.md:12:3  error  MD030  table missing the delimiter row
   |
12 | | Feature | Status |
   |   ^
   = hint: add a row like `|---|---|` directly beneath the header row
```

## 10. Dev server (`serve.js`)

`node:http` only. Serves `outDir`; directory → `index.html`; unknown path → `404.html`
with status 404. Watches `contentDir`, `staticDir`, `src/theme`, and the config via
`fs.watch` (debounced 80ms) → incremental rebuild → pushes a reload over SSE
(`/__md2spa/events`). The SSE client snippet is injected **only** in dev.
Prints diagnostics to the terminal on every rebuild.

## 11. Tests (`node --test`)

Cover at minimum:
- `test/markdown.test.js` — one case per supported construct; nested lists; tables w/
  alignment; admonitions both syntaxes; footnotes; reference links; hard breaks;
  HTML escaping; CommonMark edge cases (emphasis adjacency, code spans w/ backticks).
- `test/diagnostics.test.js` — **every rule code in §5 fires on a crafted input and does
  not fire on valid input.** This is the acceptance test for "detects if the md syntax is off".
- `test/route.test.js` — file→route mapping, nav ordering, prev/next, breadcrumbs, collisions.
- `test/base.test.js` — all three base modes produce correct URLs at depth 0/1/3.
- `test/build.test.js` — end-to-end build of `content/` into a temp dir; asserts every
  expected file exists, HTML passes `verifyHtml`, SPA payloads parse, search index shape.
- `test/security.test.js` — `<script>`, `javascript:` URLs, `onerror=`, and disallowed tags
  in Markdown never reach the output.

## 12. Deployment artifacts (`deploy/`)

- `.gitlab-ci.yml` — `pages` job; `node:20-alpine`; `npx md2spa build --out public`;
  `artifacts: paths: [public]`; `rules: if $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH`.
  Plus a separate `lint` job running `md2spa check --format junit > report.xml` with
  `artifacts: reports: junit`.
- `.github/workflows/pages.yml` — actions/configure-pages + upload-pages-artifact + deploy.
- `netlify.toml`, `vercel.json`, `_redirects` (SPA fallback where supported), `Dockerfile`
  (nginx serving `dist` with `try_files … /404.html`), `Caddyfile`.
- README section: "Deploying to a subpath" explaining `base: "auto"` vs explicit.

The bundled `.gitlab-ci.yml` must work **unmodified** for a project at
`https://<user>.gitlab.io/<project>/` thanks to `base: "auto"`.
