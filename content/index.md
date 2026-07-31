---
title: md2spa
description: A zero-dependency Markdown to static documentation site generator where the folder tree is the navigation.
---

# md2spa

md2spa turns a directory of Markdown files into a static documentation site with a
client-side router, full-text search, and a sidebar generated from the folder tree.
It installs nothing. Node.js 18 or newer is the only requirement.

> [!NOTE]
> This site is md2spa's own manual *and* its end-to-end build fixture. Every construct
> documented here is used somewhere under `content/`, so a parser regression breaks these
> pages before it reaches you.

## What it does

- Reads `content/**/*.md` and writes a complete static site to `dist/`.
- Builds the sidebar from the directory tree. Adding `content/guide/tuning.md` adds a
  sidebar entry. There is no navigation file to keep in sync.
- Rewrites relative Markdown links such as `../reference/cli.md#build` into real routes,
  and reports the ones that point at nothing.
- Emits document-relative URLs by default, so one `dist/` works at `/`, at
  `/user/project/`, and inside a subfolder of a larger site. Add `cleanUrls: false`
  and it opens straight from disk over `file://` too.
- Lints while it builds. 44 rules cover frontmatter, headings, code fences, tables,
  links, footnotes, list structure and raw HTML.
- Degrades cleanly. With JavaScript disabled the output is an ordinary pre-rendered
  multi-page document set.

## Quick start

```bash
npx md2spa init
npx md2spa dev
```

`init` writes an `md2spa.config.json` and a small `content/` skeleton into the current
directory. `dev` serves the site on `http://127.0.0.1:3000` and rebuilds on every save.

When you are ready to publish:

```bash
npx md2spa build --out public
```

Full command reference: [CLI](reference/cli.md). Configuration keys:
[Configuration reference](reference/config-reference.md).

## Why zero dependencies

A documentation generator is infrastructure. It runs in CI, on a laptop that has not been
updated in six months, and on a machine behind a proxy that blocks the npm registry.
Every dependency is a way for that to stop working.

- **The install is the checkout.** `git clone` plus `node src/cli.js build` is a complete
  toolchain. No lockfile, no audit noise, no transitive package pinning a compiler.
- **The output survives a strict Content-Security-Policy.** Nothing in the generated site
  calls `eval` or `new Function`, loads a remote font, or fetches a CDN script.
- **Builds are reproducible.** The same input bytes produce the same output bytes. No
  timestamps, no random ids, no hash salt. A build date appears only when you set
  `buildDate` yourself.
- **The whole thing is readable.** Roughly 6000 lines of plain ES modules. When a rule
  fires on your file, you can open the rule and see why.

## Where to go next

- [Installation](getting-started/installation.md) covers the three ways to run the tool.
- [Project structure](getting-started/project-structure.md) explains how the folder tree
  becomes the sidebar, including ordering and titles.
- [Structuring content](structuring/index.md) covers the judgement calls: where a file
  goes, what an index page is for, and when several sections belong in one page.
- [Markdown syntax](writing/markdown-syntax.md) is the complete supported dialect.
- [Diagnostics](reference/diagnostics.md) lists every rule code the linter can emit.
- [Deploying](deploying/index.md) has copy-paste CI for GitLab Pages and GitHub Pages.

## The shape of a site

```
my-docs/
├── md2spa.config.json
├── content/
│   ├── index.md
│   ├── _meta.json
│   └── guide/
│       ├── index.md
│       └── install.md
└── static/
    └── logo.svg
```

That produces the routes `/`, `/guide/` and `/guide/install/`, a sidebar with one
expandable group, breadcrumbs, previous/next links, and a search index. Nothing else is
required.
