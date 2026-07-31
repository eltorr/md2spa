---
title: Advanced
description: Raw HTML and footnotes, the two constructs that need more explanation than a syntax table.
order: 7
---

# Advanced

Two constructs need more than a row in a syntax table, because both of them have rules you
can trip over.

- [Custom HTML](custom-html.md) — which tags survive, which are escaped, which are escaped
  *and* reported, and the URL policy that goes with them.
- [Footnotes](footnotes.md) — definitions, ordering, back-references and the diagnostics
  that keep a footnote from silently disappearing.

## Why this folder exists

It is also a demonstration. `content/writing/advanced/` is three levels below the content
root, and it appears in the sidebar as a nested, collapsible group with no configuration
at all — no `nav:` array, no `_meta.json`, nothing but the directory.

The breadcrumb above this page reads Home → Writing content → Advanced. The previous and
next links at the bottom walk the whole tree in reading order, crossing folder boundaries
as they go. Both are derived from the same folder walk.

Nesting is unlimited. The sidebar indents each level by a single CSS custom property and
draws a hairline guide rail, so a tree that is six levels deep is still legible. If your
tree is six levels deep, though, the problem is probably the tree.

## Escape hatches, not extensions

md2spa has no plugin system, so raw HTML is the only extension point. That is a
deliberate trade:

- Anything you write with allowlisted HTML renders in every other Markdown tool too.
- Nothing you write can execute code, because the sanitiser removes event handlers and
  unsafe schemes on the way out.
- A future version cannot break your pages by changing a plugin API, because there is no
  plugin API.

The cost is that some things are verbose. A definition list is nine lines of `<dl>` rather
than three lines of a syntax nobody else implements. That is the trade.
