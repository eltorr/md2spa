---
title: Index pages
description: An index.md becomes its folder's landing page. How to write one that helps a reader choose, and what happens when you leave it out.
order: 2
---

# Index pages

`content/deploying/index.md` is served at `/deploying/` — the same route as the folder. It
is what a reader sees when they click a section heading in the sidebar, and the only page
in the folder whose job is to be *about the other pages*.

## The route mapping

| File | Route | Role |
|:---|:---|:---|
| `content/index.md` | `/` | The site's home page |
| `content/deploying/index.md` | `/deploying/` | The section's landing page |
| `content/deploying/gitlab-pages.md` | `/deploying/gitlab-pages/` | An ordinary page |

An index page is always ordered first among its siblings, regardless of `order` or
`_meta.json` — it is the parent, not a peer.

## Write the page the sidebar cannot

The sidebar already lists every child. An index page that repeats those links as a bare
bullet list adds a click and no information.

What the sidebar cannot show is **why a reader would choose one child over another**. That
is the whole value of the page, and a table is usually the most efficient shape for it:

```markdown
| Host | Config needed | Custom domain | Notes |
|:---|:---|:---|:---|
| [GitLab Pages](gitlab-pages.md) | None | Yes | Serves under `/<project>/` |
| [GitHub Pages](github-pages.md) | `.nojekyll` | Yes | Jekyll strips `_`-prefixed dirs |
| [Other hosts](other-hosts.md) | Varies | Varies | Nginx, Caddy, Netlify, S3 |
```

Rendered:

| Host | Config needed | Custom domain | Notes |
|:---|:---|:---|:---|
| [GitLab Pages](../deploying/gitlab-pages.md) | None | Yes | Serves under `/<project>/` |
| [GitHub Pages](../deploying/github-pages.md) | `.nojekyll` | Yes | Jekyll strips `_`-prefixed dirs |
| [Other hosts](../deploying/other-hosts.md) | Varies | Varies | Nginx, Caddy, Netlify, S3 |

A reader who already knows they are on GitLab is one click from the right page. A reader
who does not know which host to use has the comparison in front of them. Neither is served
by a list of three links.

!!! tip "Link to children with relative `.md` paths"
    Inside `content/deploying/index.md`, write `[GitLab Pages](gitlab-pages.md)` — the path
    as it exists on disk. The build rewrites it to the real route, and the link works
    unchanged when browsing the repository on GitLab or GitHub. If you later move or rename
    the target, the linter reports `MD044` instead of shipping a dead link.

## A shape that works

Four parts, in this order:

1. **One paragraph on scope.** What this section covers, and what it deliberately does not.
2. **The chooser.** A table with one row per child and a column that discriminates.
3. **Shared context.** Anything every child assumes, so the children do not each repeat it.
4. **A default.** If most readers want one particular child, say so and link it.

The fourth is the one most often skipped and the most useful. "If you are not sure, start
with [the drop-in workflow](drop-in-workflow.md)" saves more time than another paragraph
of description.

## Folders without an index page

An `index.md` is optional. A folder without one still becomes a sidebar group, and the
build generates a landing page listing the children so the section route is never a 404:

```
content/deploying/advanced:1:1  info  NAV002  folder `advanced` has no index.md;
                                              a section page was generated for `/deploying/advanced/`
   = hint: Add `content/deploying/advanced/index.md` to control this section's landing page.
```

`NAV002` is informational — a generated page is a legitimate choice, not a mistake.

| | Generated page | Written `index.md` |
|:---|:---:|:---:|
| Section route resolves | <span class="badge badge--ok">Yes</span> | <span class="badge badge--ok">Yes</span> |
| Lists child pages | <span class="badge badge--ok">Yes</span> | Up to you |
| Explains how to choose | <span class="badge badge--none">No</span> | <span class="badge badge--ok">Yes</span> |
| Needs maintaining | <span class="badge badge--ok">Never</span> | <span class="badge badge--wip">On change</span> |

Use a generated page for a small group whose members are self-evident from their titles.
Write one when the group is large, when the choice between children is not obvious, or
when the section needs shared context.

## Keeping a hub honest

The sidebar is derived, so it cannot go stale. A hand-written chooser table **can** — add a
child page and the table will not mention it.

Two habits keep the cost near zero:

- Add the row in the same commit as the page. It is one line.
- Keep the chooser to one table. When it needs prose between the rows, the section has
  probably grown enough to want subfolders.

Nothing enforces this, and that is deliberate: an index page is editorial. The linter
guarantees your links *resolve*, not that your prose is complete.

Next: [Sections in one page](sections-in-one-page.md).
