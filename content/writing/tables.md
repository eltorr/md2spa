---
title: Tables
description: GitHub table syntax, all three alignments, inline HTML in cells, and how to build a readable support matrix.
order: 4
---

# Tables

Tables are the densest way to answer "does this work on my machine". md2spa implements
the GitHub table extension, plus enough inline HTML inside cells to build a real support
matrix.

## Basic syntax

A header row, a delimiter row, then any number of body rows.

```markdown
| Command | What it does |
|---|---|
| `build` | write the site to `outDir` |
| `dev` | serve with live reload |
```

| Command | What it does |
|---|---|
| `build` | write the site to `outDir` |
| `dev` | serve with live reload |

Leading and trailing pipes are optional and column widths do not have to line up. The
delimiter row is not optional: without it the block is a paragraph, and md2spa reports
`MD030`.

## Alignment

The delimiter row carries the alignment. Colons mark the aligned edges.

| Delimiter | Alignment | Use for |
|:---|:---:|---:|
| `:---` | left | text |
| `:---:` | centre | short status words |
| `---:` | right | numbers |
| `---` | default | anything |

That table demonstrates all three at once: the first column is left aligned, the second is
centred, the third is right aligned. Alignment lands on the cell as `class="is-left"`,
`is-center` or `is-right`.

Right-align numeric columns. Digits that share a decimal position are comparable at a
glance; ragged ones are not.

| Build step | Files | Milliseconds |
|:---|---:|---:|
| parse | 25 | 41 |
| render | 25 | 68 |
| write | 58 | 12 |
| **total** | **58** | **121** |

## What you can put in a cell

Inline constructs work: `code`, **strong**, *emphasis*, ~~strikethrough~~, links, images
and footnote references. Block constructs — lists, fences, headings — do not.

A literal pipe must be escaped with a backslash, otherwise it splits the cell. This is the
one place where an escape is mandatory rather than a matter of taste.

For anything more than a phrase, use inline HTML:

- `<br>` forces a line break inside a cell.
- `<sup>` marks a footnote-style reference that a note below the table explains.
- `<span class="badge badge--ok">` renders a status pill.
- `<abbr title="...">` explains an acronym without spending a column on it.

## A support matrix

This is the pattern the tool was designed around: a wide status table where each row is a
device and each column a subsystem.

| Device | Boot | Display | Wi-Fi<br>Bluetooth | GPU | Notes |
|:---|:---:|:---:|:---:|:---:|:---|
| M1 (2020) | <span class="badge badge--ok">Works</span> | <span class="badge badge--ok">Works</span> | <span class="badge badge--ok">Works</span> | <span class="badge badge--ok">Works</span> | Reference platform |
| M1 Pro / Max | <span class="badge badge--ok">Works</span> | <span class="badge badge--ok">Works</span> | <span class="badge badge--ok">Works</span> | <span class="badge badge--wip">Partial</span><sup>1</sup> | Internal display only |
| M1 Ultra | <span class="badge badge--ok">Works</span> | <span class="badge badge--wip">Partial</span><sup>2</sup> | <span class="badge badge--ok">Works</span> | <span class="badge badge--todo">Planned</span> | Two dies, one bring-up |
| M2 (2022) | <span class="badge badge--ok">Works</span> | <span class="badge badge--ok">Works</span> | <span class="badge badge--wip">Partial</span> | <span class="badge badge--todo">Planned</span> | <abbr title="Universal Serial Bus">USB</abbr> hubs vary |
| M2 Pro / Max | <span class="badge badge--wip">Partial</span> | <span class="badge badge--todo">Planned</span> | <span class="badge badge--todo">Planned</span> | <span class="badge badge--none">Not started</span> | Early bring-up |
| M3 and later | <span class="badge badge--none">Not started</span> | <span class="badge badge--none">Not started</span> | <span class="badge badge--none">Not started</span> | <span class="badge badge--none">Not started</span> | No public work yet |

<sup>1</sup> Acceleration is present; external displays over DisplayPort alt mode are not.<br>
<sup>2</sup> Only the first display controller is brought up at boot.

Three things make that table work:

- The device column is left aligned and every status column is centred, so the eye can
  scan straight down a column.
- Status is a badge *and* a word. Colour alone is not information; a reader with a
  monochrome display or a colour-vision deficiency reads "Partial" either way.
- Footnote markers use `<sup>` with numbered notes under the table, rather than stuffing
  a sentence into a cell.

## Badge variants

| Class | Renders as | Meaning |
|:---|:---:|:---|
| `badge badge--ok` | <span class="badge badge--ok">Works</span> | Done and supported |
| `badge badge--wip` | <span class="badge badge--wip">Partial</span> | Works with caveats |
| `badge badge--todo` | <span class="badge badge--todo">Planned</span> | Accepted, not started |
| `badge badge--none` | <span class="badge badge--none">Not started</span> | No work planned |
| `badge badge--info` | <span class="badge badge--info">Note</span> | Neutral annotation |

Always put a word inside the badge. The class supplies the colour; the text supplies the
meaning.

## Wide tables

A table wider than the content column is wrapped in a horizontally scrollable container
with a sticky header row, so the header stays visible while you scroll sideways. Nothing
is truncated and the page itself never scrolls horizontally.

If a table needs more than about six columns, consider whether it is really two tables, or
whether the rows should become sections. A table nobody can read on a phone is a table
nobody reads.

## Common mistakes

| Mistake | Diagnostic | Fix |
|:---|:---|:---|
| No delimiter row | `MD030` | Add `\|---\|---\|` under the header |
| `\|===\|` or `\|-\|:\|` as delimiter | `MD032` | Use `---`, `:--`, `--:` or `:-:` |
| A row with more or fewer cells than the header | `MD031` | Add or remove pipes |
| An unescaped pipe inside a cell | `MD031` | Write `\|` |

Every one of those is reported with the exact line and column, so a broken table is a
build failure rather than a rendering surprise. See
[Diagnostics](../reference/diagnostics.md) for the full catalogue.

## When not to use a table

- Two columns where the second is a sentence. That is a description list; use `<dl>`, or
  a bullet list with a bold lead-in.
- Anything with a code block in a cell. Use headings and fences.
- Sequential steps. Use an ordered list; a table implies the rows are comparable, and
  steps are not.
