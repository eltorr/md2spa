---
title: Project structure
description: How the content folder becomes routes, sidebar entries, titles and ordering, with zero navigation configuration.
order: 2
---

# Project structure

The folder tree is the navigation. This page describes exactly how a file on disk becomes
a route, a sidebar entry and a title, and how to override each step when the defaults are
wrong.

## The three directories

```
my-docs/
├── md2spa.config.json
├── content/          <- Markdown sources. This is the site.
├── static/           <- copied verbatim to the site root.
└── dist/             <- generated output. Never edit, never commit.
```

Only `content/` is required. `static/` may be absent. `dist/` is created by the build and
should be in `.gitignore`.

## Files to routes

A Markdown file becomes a route by dropping its extension. `index.md` becomes the route
of its directory.

| Source file | Route | Output (`cleanUrls: true`) |
|---|---|---|
| `content/index.md` | `/` | `dist/index.html` |
| `content/guide/index.md` | `/guide/` | `dist/guide/index.html` |
| `content/guide/install.md` | `/guide/install/` | `dist/guide/install/index.html` |
| `content/guide/deep/tuning.md` | `/guide/deep/tuning/` | `dist/guide/deep/tuning/index.html` |

Set `cleanUrls: false` if your host cannot serve directory indexes. Leaf pages then land
at `guide/install.html`, while section indexes stay at `guide/index.html` so their
children still resolve.

Nesting is unlimited. This very page sits at depth two; `../../writing/advanced/footnotes.md`
sits at depth three, and the sidebar renders both without any configuration.

## Names that are excluded

Three things keep a file out of the build:

- A filename or folder name beginning with `_`. That is how `_meta.json` and
  `_drafts/` stay out of the site.
- Frontmatter `draft: true`.
- Anything outside `contentDir`.

Drafts are still served by `md2spa dev`, badged in the sidebar, so you can preview work
in progress without publishing it.

To build a page but hide it from the sidebar — a changelog archive, a redirect stub — use
frontmatter `nav: false` instead. The route exists, search finds it, the sidebar does not
show it.

## Titles

Title resolution stops at the first match:

1. Frontmatter `title:`.
2. The document's first H1.
3. A `titles` entry for that file in the folder's `_meta.json`.
4. The humanised filename.

Humanising splits on `-` and `_`, title-cases each word, and preserves ALL-CAPS tokens
plus a small acronym list: `api cli cpu gpu ui ux id url http https json yaml html css js
ts sdk os io ram usb pci faq`. So `getting-started.md` becomes "Getting Started" and
`cli-api.md` becomes "CLI API".

Folder titles resolve slightly differently: `_meta.json` `title` first, then the folder's
`index.md` title, then the humanised folder name.

> [!TIP]
> Always set a frontmatter `title`. It is the one place that controls the `<title>`
> element, the sidebar label, the breadcrumb, the search result and the Open Graph tag at
> the same time.

## Ordering

Ordering also stops at the first match:

1. Frontmatter `order:` — a number, ascending.
2. Position in the folder's `_meta.json` `order` array. Unlisted items follow, alphabetically.
3. Alphabetical, with `index.md` always first.

Numeric filename prefixes are a fourth option that needs no configuration at all.
`01-intro.md` sorts before `02-install.md`, and the prefix is stripped from both the route
and the title — the route is `/intro/`, not `/01-intro/`.

Do not mix the mechanisms inside one folder. If half the files carry `order:` and the
other half rely on `_meta.json`, the result is technically defined but nobody will be able
to predict it.

## `_meta.json`

Every key is optional. A folder with no `_meta.json` is ordered alphabetically and titled
from its `index.md`.

```json
{
  "title": "User guide",
  "order": ["index.md", "install.md", "configure.md"],
  "collapsed": false,
  "icon": "book",
  "hidden": false,
  "titles": { "faq.md": "FAQs" }
}
```

| Key | Type | Effect |
|---|---|---|
| `title` | string | Sidebar label for the folder. Overrides the index page title. |
| `order` | string[] | Explicit sibling order. Names are file or folder names, not routes. |
| `collapsed` | boolean | Start the sidebar group collapsed. Groups on the active path always expand. |
| `icon` | string | Icon name passed through to the theme. |
| `hidden` | boolean | Build the folder but keep it out of the sidebar. |
| `titles` | object | Per-file label fallback, used when a file has no frontmatter title and no H1. |

This site uses two of them. `content/_meta.json` fixes the top-level section order, and
`content/reference/_meta.json` renames the folder and orders its pages.

## Folders without an index page

A folder does not need an `index.md`. If it has none, md2spa still creates the nav group
and generates a section landing page listing the folder's children. It records `NAV002`
at info severity so you know the page was generated rather than authored.

`content/deploying/advanced/` in this site deliberately has no index page, which is why
[Advanced deployment](../deploying/advanced/base-paths.md) sits under a generated section.

## Static assets

Everything in `static/` is copied to the site root without processing. `static/logo.svg`
is served at `/logo.svg`. Reference assets from Markdown with ordinary relative paths;
see [Links and assets](../writing/links-and-assets.md).

Because the copy is verbatim, `static/` is the right place for `CNAME`, `.nojekyll`,
`robots.txt` overrides and anything else a host expects to find at a fixed path.

## Choosing a structure

This page covers the mechanics — what maps to what. The decisions those mechanics leave
open are covered in [Structuring content](../structuring/index.md): where a new file
belongs, whether a folder needs a written [index page](../structuring/index-pages.md), and
when several topics are better off as
[sections in one page](../structuring/sections-in-one-page.md) than as separate pages.
