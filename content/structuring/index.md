---
title: Structuring content
description: How folders become navigation, what index pages are for, and when to put several sections in one page instead of splitting them up.
---

# Structuring content

There is no navigation file. The folder tree *is* the navigation, so the shape of
`content/` is the shape of the site. That makes structure cheap to change — move a file
and the sidebar moves with it — but it also means the decisions below are the only ones
that matter.

There are three of them, and this section takes one page each:

| Decision | The question | Page |
|:---|:---|:---|
| Where does a file go? | Which folder, how deep, what filename | [The drop-in workflow](drop-in-workflow.md) |
| What does a folder's landing page say? | Write an `index.md`, or let one be generated | [Index pages](index-pages.md) |
| One page or several? | Split by topic, or keep sections together in one page | [Sections in one page](sections-in-one-page.md) |

Ordering, titles and `_meta.json` are covered as reference material in
[Project structure](../getting-started/project-structure.md); this section is about the
judgement calls rather than the mechanics.

## The index page is the topic map

Every folder can hold an `index.md`, which becomes that folder's own route:
`content/deploying/index.md` is served at `/deploying/`. It is the page a reader lands on
when they click the section in the sidebar, and its job is to answer one question:

> I know roughly what I want. Which page do I actually need?

The sidebar already lists the children, so an index page that only repeats those links is
wasted space. A useful one adds the thing the sidebar cannot: **why you would pick one
child over another.** The table at the top of this page is the pattern — one row per
child, and a column that discriminates between them.

That is what "the index structures the topics" means in practice. The folder groups the
files; the index page explains the grouping.

## What good structure looks like

A tree that reads well in the sidebar usually follows three rules.

**Group by what the reader is trying to do, not by what the thing is.** `deploying/` beats
`yaml-files/`. A reader with a goal can find the folder that matches it; a reader looking
at implementation categories has to guess.

**Keep folders shallow until they earn depth.** One folder with seven pages is easier to
scan than three folders with two pages each. Add a level when a group is large enough that
its members compete for attention — `writing/advanced/` exists because six pages of
everyday syntax were burying two pages of rarely-needed detail.

**Let page size decide splits, not tidiness.** Three short related sections belong in one
page with a table of contents down the right. Splitting them costs the reader two
navigations to compare things that were adjacent. [Sections in one
page](sections-in-one-page.md) works through where that line sits.

!!! tip "Restructuring is safe"
    Moving a file changes its URL, so the linter is what keeps you honest: every relative
    `.md` link that pointed at the old location is reported as `MD044` on the next build.
    Fix what it lists and you are done. Run `md2spa check` before you commit.

## The pieces this section assumes

| Concept | One-line version | Where it is specified |
|:---|:---|:---|
| Route | `content/a/b.md` is served at `/a/b/` | [Project structure](../getting-started/project-structure.md#files-to-routes) |
| Title | Frontmatter `title`, else the first `# H1`, else the filename | [Project structure](../getting-started/project-structure.md#titles) |
| Order | Frontmatter `order`, else `_meta.json`, else alphabetical | [Project structure](../getting-started/project-structure.md#ordering) |
| Relative link | `../reference/cli.md#build` is rewritten to a real route | [Links and assets](../writing/links-and-assets.md) |
| Diagnostic | A rule code such as `MD044`, reported with a line and a hint | [Diagnostics](../reference/diagnostics.md) |
