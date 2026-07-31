---
title: The drop-in workflow
description: Add a Markdown file to a folder and it becomes a page in the sidebar. What the build infers, and what you can override.
order: 1
---

# The drop-in workflow

Write a file. Build. It is in the sidebar. There is nothing to register, and no navigation
file that can drift out of step with the tree.

## A worked example

Start with the smallest site that exists — one file, no config:

```
my-docs/
└── content/
    └── index.md
```

```bash
npx md2spa build
```

Now drop a file into a folder that does not exist yet:

```bash
mkdir -p content/hardware/apple-silicon
echo '# M1 Support' > content/hardware/apple-silicon/m1.md
npx md2spa build
```

The sidebar becomes:

```
My Project
Hardware
  Apple Silicon
    M1 Support
```

Nothing else was touched. Four things were inferred:

| Inferred | From | Result |
|:---|:---|:---|
| Route | The path under `content/` | `/hardware/apple-silicon/m1/` |
| Title | The first `# H1` in the file | "M1 Support" |
| Folder titles | The folder names, humanised | "Hardware", "Apple Silicon" |
| Nav position | Depth in the tree | Nested two levels |

Note "Apple Silicon" — hyphens become spaces and each word is capitalised, with an acronym
list so `api-reference.md` is "API Reference" rather than "Api Reference".

Neither `hardware/` nor `apple-silicon/` has an `index.md`, so the build generated a
landing page for each and reported `NAV002` — an informational note, not an error. See
[Index pages](index-pages.md) for when to write those yourself.

## What you can override

Every inference has an escape hatch, and you only reach for one when the default is wrong.

| To change | Add | Example |
|:---|:---|:---|
| The title | Frontmatter `title` | `title: M1 and M1 Pro` |
| The position | Frontmatter `order` | `order: 1` |
| A folder's title | `_meta.json` in that folder | `{ "title": "Apple Silicon (M-series)" }` |
| Sibling order | `_meta.json` `order` array | `{ "order": ["m1.md", "m2.md"] }` |
| Hide from the sidebar | Frontmatter `nav: false` | Page still builds, no sidebar entry |
| Exclude entirely | Frontmatter `draft: true`, or a `_` prefix | Skipped by `build`, kept by `dev` |

A numeric filename prefix is a lighter alternative to `order`: `01-intro.md` sorts first,
and both the number and the hyphen are stripped from the route and the title. The page is
served at `/intro/` and titled "Intro".

## Moving and renaming

Moving a file changes its route, which breaks anything linking to it. That is a build
error, not a silent 404:

```
content/writing/tables.md:41:34  error  MD044  internal link target does not exist: ../guide/install.md
   |
41 | See the [installation guide](../guide/install.md) for prerequisites.
   |                                  ^^^^^^^^^^^^^^^^^^^^^
   = hint: No page maps to `/guide/install/`. Did you mean `../getting-started/installation.md`?
```

So restructuring is a loop: move files, run `md2spa check`, fix what it lists. The sidebar
needs no attention at all — it is derived, so it cannot be stale.

## The editing loop

```bash
npx md2spa dev
```

Watches `content/`, `static/` and the config, rebuilds on save, and reloads the browser.
Draft pages are included so you can see work in progress; they carry a badge in the
sidebar so there is no confusing them with published pages.

!!! warning "`build` and `dev` disagree on drafts, on purpose"
    `dev` includes `draft: true` pages, `build` omits them. If a page is missing from a
    deployed site but visible locally, check its frontmatter first.

## What this costs you

The trade is real and worth stating: **you give up arbitrary navigation order across
folders.** A hand-written nav file can put "Troubleshooting" between "Install" and
"Configure" no matter where those files live. Here, sidebar structure follows directory
structure, and ordering is controlled within a folder rather than across the whole site.

In exchange, the sidebar is never wrong. A file that exists is listed; a file that is
listed exists. There is no third state where someone adds a page and forgets to register
it, which is the failure mode a navigation file produces every time.

Next: [Index pages](index-pages.md).
