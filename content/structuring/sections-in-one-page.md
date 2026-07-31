---
title: Sections in one page
description: When several tables belong on one page instead of several pages, and how the table of contents makes a long page navigable.
order: 3
---

# Sections in one page

Not every topic deserves its own page. When a reader's real question is *"how do these
compare?"*, splitting the answer across pages makes them hold one table in their head
while they navigate to the next.

The alternative is one page, several `##` sections, a table in each. The table of contents
on the right turns those headings into jump links, so a long page stays navigable without
becoming several pages.

## When one page wins

| The reader's question | Shape | Why |
|:---|:---|:---|
| "How do these compare?" | One page, section per subject | Comparison needs the rows adjacent |
| "Does my device do X?" | One page, section per device family | Scanning beats navigating |
| "How do I do X?" | One page per task | Tasks are read start to finish, not compared |
| "What does this flag do?" | One page per command | Readers arrive by search, deep-linked |

The test is whether readers move **between** the sections or **through** them. Comparison
tables get jumped around; a tutorial gets read in order. Jumping wants one page with
anchors; reading in order wants separate pages with prev/next.

## The support-matrix pattern

A hardware or platform support page is the clearest case. One `##` per subject, one table
per `##`, identical columns throughout so a reader learns the shape once.

### Universal blocks

Features present on every device in the family.

| Block | Gen 1 | Gen 2 | Notes |
|:---|:---:|:---:|:---|
| Display controller | <span class="badge badge--ok">6.2</span> | <span class="badge badge--ok">6.2</span> | |
| USB 2.0 | <span class="badge badge--ok">5.19</span> | <span class="badge badge--ok">5.19</span> | |
| USB 3.0 | <span class="badge badge--ok">6.1</span> | <span class="badge badge--ok">6.1</span> | |
| GPU | <span class="badge badge--ok">6.4</span> | <span class="badge badge--wip">WIP</span> | [notes](#notes) |
| Video decode | <span class="badge badge--wip">WIP</span> | <span class="badge badge--wip">WIP</span> | |
| Video encode | <span class="badge badge--todo">TBA</span> | <span class="badge badge--todo">TBA</span> | |
| Secure enclave | <span class="badge badge--none">n/a</span> | <span class="badge badge--todo">TBA</span> | |

### Laptops

| Feature | Model A<br>(2021) | Model B<br>(2022) | Model C<br>(2023) |
|:---|:---:|:---:|:---:|
| Internal display | <span class="badge badge--ok">6.2</span> | <span class="badge badge--ok">6.2</span> | <span class="badge badge--ok">6.5</span> |
| Backlight | <span class="badge badge--ok">6.4</span> | <span class="badge badge--ok">6.4</span> | <span class="badge badge--wip">WIP</span> |
| Keyboard | <span class="badge badge--ok">6.2</span> | <span class="badge badge--ok">6.2</span> | <span class="badge badge--ok">6.5</span> |
| Trackpad | <span class="badge badge--ok">6.2</span> | <span class="badge badge--ok">6.2</span> | <span class="badge badge--ok">6.5</span> |
| Speakers | <span class="badge badge--wip">WIP</span> | <span class="badge badge--wip">WIP</span> | <span class="badge badge--none">n/a</span> |
| Battery / charging | <span class="badge badge--ok">6.3</span> | <span class="badge badge--ok">6.3</span> | <span class="badge badge--ok">6.5</span> |

### Desktops

| Feature | Mini | Studio | Notes |
|:---|:---:|:---:|:---|
| HDMI out | <span class="badge badge--ok">6.2</span> | <span class="badge badge--ok">6.2</span> | |
| HDMI audio | <span class="badge badge--wip">WIP</span> | <span class="badge badge--wip">WIP</span> | |
| Ethernet | <span class="badge badge--ok">6.1</span> | <span class="badge badge--ok">6.1</span> | 10GbE untested |
| Front USB | <span class="badge badge--none">n/a</span> | <span class="badge badge--ok">6.4</span> | |

### Notes

Anything that needs a paragraph goes here rather than being crammed into a cell. Because
it has a heading, cells can link to it: `[notes](#notes)` above resolves to this section,
and the linter reports `MD045` if the anchor ever stops existing.

Anchors come from the heading text — lowercased, punctuation removed, spaces hyphenated —
so this one is `#notes`. That is the same rule GitHub uses, which means anchors written
against a README keep working here.

## What makes this work

**Identical columns in every table.** A reader learns the layout once. Changing column
meaning between sections costs more than the space it saves.

**Centre the status column, left-align the labels.** Set alignment in the delimiter row —
`|:---|:---:|` — and short status values line up into a scannable column.

**A fixed vocabulary, not free text.** Five states cover almost everything:

| Badge | Means |
|:---|:---|
| <span class="badge badge--ok">6.2</span> | Works; the number is the version it landed in |
| <span class="badge badge--wip">WIP</span> | Being worked on, not ready to use |
| <span class="badge badge--todo">TBA</span> | Not started, no estimate |
| <span class="badge badge--none">n/a</span> | Not applicable to this device |
| <span class="badge badge--info">Note</span> | Qualified; see the linked note |

Badges are ordinary HTML — `<span class="badge badge--ok">6.2</span>` — styled by the
theme. Colour is never the only signal: the text says the same thing, so the table survives
being printed, read by a screen reader, or seen by someone who cannot distinguish the hues.

**`<br>` in a header cell** splits a long device name onto two lines without widening the
column. Inline HTML is allowed in cells; see [Custom HTML](../writing/advanced/custom-html.md)
for the full allowlist.

## Keeping a long page usable

| Aid | How it works |
|:---|:---|
| Table of contents | Every `##` and `###` becomes a jump link on the right |
| Scrollspy | The current section is highlighted as you scroll |
| Heading anchors | Hover a heading for a `#` permalink to copy |
| Deep links | `sections-in-one-page.md#desktops` from any other page |
| Search | Headings are indexed separately and rank above body text |
| Horizontal scroll | A table wider than the column scrolls inside its own box |

Set the TOC depth in `md2spa.config.json`:

```json
{
  "toc": { "minDepth": 2, "maxDepth": 3 }
}
```

`minDepth: 2` keeps the page's single `#` H1 out of the list. Raise `maxDepth` to 4 if your
`####` headings are worth jumping to; on a page like this one, 3 is right.

## When to split after all

Split when any of these becomes true:

- **The sections stop sharing columns.** Different shapes mean different topics.
- **A section grows past its table.** Several paragraphs of prose under one `##` wants its
  own page with its own TOC.
- **Readers arrive by search at one section.** A deep-linked section that is really a page
  should be one — it gets its own title, description and prev/next.
- **The page passes roughly 1,500 words of prose.** Tables can be much longer; prose cannot.

Splitting is cheap. Move the section into a new file in the same folder, and the sidebar
updates itself — the only follow-up is fixing whatever `md2spa check` reports about links
to the old anchor.

Back to [Structuring content](index.md).
