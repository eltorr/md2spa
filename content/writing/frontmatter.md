---
title: Frontmatter
description: The YAML metadata block at the top of a page, the keys md2spa type-checks, and the ones it simply preserves.
order: 6
tags: [frontmatter, metadata, yaml]
---

# Frontmatter

Frontmatter is a metadata block fenced by `---` at the very top of a file. It is not
rendered. This page's own frontmatter sets a title, a description and three tags.

```yaml
---
title: Frontmatter
description: The YAML metadata block at the top of a page.
tags: [frontmatter, metadata, yaml]
---
```

The opening `---` must be the first line of the file, with nothing before it — not a blank
line, not a comment. An unterminated block, or a line that is not a `key: value` pair,
produces `MD001` and the file fails to build.

## The supported YAML subset

md2spa parses frontmatter with a small hand-written scanner, not a YAML library. The
subset is:

- `key: value` pairs, one per line.
- Bare, single-quoted and double-quoted strings.
- Numbers, `true` / `false`, and `null`.
- Inline arrays: `tags: [a, b, c]`.
- Block arrays: a `-` item per line, indented under the key.
- `#` comments on their own line.

Anchors, aliases, multi-line block scalars (`|` and `>`), and deeply nested mappings are
outside the subset. If you need them, you are storing application data in a documentation
file, and it belongs somewhere else.

```yaml
---
title: Serial debugging
description: Attaching a console over USB.
order: 3
tags:
  - hardware
  - debugging
draft: false
---
```

## Checked keys

These keys have a defined meaning and a checked type. A mismatch is `MD002`, an error.

| Key | Type | Effect |
|:---|:---|:---|
| `title` | string | Page title. Wins over the H1 for the sidebar, `<title>` and search. |
| `description` | string | Meta description, search snippet and Open Graph description. |
| `summary` | string | Accepted as an alias for `description`. |
| `order` | number | Sort position among siblings, ascending. |
| `nav` | boolean or string | `false` hides the page from the sidebar; a string relabels it. |
| `draft` | boolean | `true` excludes the page from the build. `dev` still serves it. |
| `toc` | boolean | `false` suppresses the right-hand table of contents. |
| `tags` | string[] | Free-form tags, indexed by search. |
| `icon` | string | Icon name passed through to the theme. |
| `date` | string | Publication date, as an ISO string. |
| `redirect_from` | string[] | Routes this page used to live at. |

## Unknown keys are yours

Any key outside that table is preserved on the page object and never warned about. Real
documentation corpora carry structured device data, ownership metadata and review dates in
frontmatter, and a linter that complains about all of it is a linter people turn off.

```yaml
---
title: Mac Studio (M1 Ultra)
description: Support status and known issues.
soc: t6002
iso_layout: false
fnmode: 2
reviewed_by: hardware-team
---
```

Those five extra keys build cleanly. A custom theme can read them; the default theme
ignores them.

## Title and description are the two that matter

Set both on every page.

- `title` drives the `<title>` element, the sidebar label, the breadcrumb, the search
  result heading and the Open Graph title. Without it, the tool falls back to your first
  H1, and then to the humanised filename.
- `description` drives the meta description, the search result snippet and the Open Graph
  description. Without it, search shows the first sentence of the body, which is often
  "This page describes…".

A page with neither a `title` nor an H1 reports `MD013`.

## Draft pages

```yaml
---
title: Rewriting the boot flow
description: Work in progress.
draft: true
---
```

A draft is excluded from the build, the sitemap, the search index and the sidebar.
`md2spa dev` still serves it and badges it in the sidebar, so a draft is previewable
without being publishable. Files and folders whose names start with `_` are excluded the
same way, but permanently.

## Hiding a page from the sidebar

`nav: false` builds the page and gives it a route, but keeps it out of the tree. Use it
for pages that are reached from a link in the body rather than by browsing — a long
appendix, a legacy note, a page linked only from an error message.

```yaml
---
title: Legacy configuration format
description: Kept for readers on version 0.x.
nav: false
---
```

A string value relabels the entry instead of hiding it: `nav: "Legacy config"` gives the
sidebar a short label while the page keeps its full title.

## Ordering with frontmatter

`order` is the highest-priority ordering signal, above `_meta.json` and above alphabetical
sorting. Pages in this section use it: `markdown-syntax.md` is `order: 1`, this page is
`order: 6`.

Number in tens if you expect to insert pages later — 10, 20, 30 — so a new page can slot
in without renumbering its neighbours. The full ordering rules are in
[Project structure](../getting-started/project-structure.md#ordering).
