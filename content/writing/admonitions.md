---
title: Admonitions
description: Callout blocks in both the GitHub alert syntax and the MkDocs syntax, including collapsible ones.
order: 2
---

# Admonitions

An admonition is a callout: a bordered, coloured block that pulls one paragraph out of the
flow. md2spa accepts two syntaxes and produces the same node from both, so you can paste
content from a GitHub README or an MkDocs site without rewriting it.

Use them sparingly. A page where every third paragraph is a warning has no warnings.

## The GitHub alert syntax

A blockquote whose first line is `> [!KIND]` becomes an admonition. This is the syntax
GitHub and GitLab render natively, so the source looks right in the repository web UI too.

```markdown
> [!NOTE]
> Useful information that a reader should notice even when skimming.
```

Five kinds are recognised:

> [!NOTE]
> Useful information that a reader should notice even when skimming.

> [!TIP]
> An optional shortcut. The reader can ignore it and still succeed.

> [!IMPORTANT]
> Information the reader needs in order to succeed. Not optional.

> [!WARNING]
> A risk of an unpleasant outcome: lost time, a confusing failure, a wrong default.

> [!CAUTION]
> A risk of data loss or a security problem. Reserve this one.

The alert marker must be on its own line, and every following line stays inside the
blockquote. A block that is not closed is reported as `MD064`.

## The MkDocs syntax

`!!! kind` opens an admonition; the body is indented by four spaces and ends at the first
dedent.

```markdown
!!! warning
    The body is indented four spaces.

    Blank lines are fine as long as the indentation continues.
```

!!! warning
    The body is indented four spaces.

    Blank lines are fine as long as the indentation continues.

### Custom titles

A quoted string after the kind replaces the default title.

```markdown
!!! tip "Run this before you push"
    `md2spa check --strict` is the same check the CI job runs.
```

!!! tip "Run this before you push"
    `md2spa check --strict` is the same check the CI job runs.

An empty title — `!!! note ""` — renders the block with no title bar at all, which is
useful for a plain highlighted panel.

!!! note ""
    No title bar. Just an emphasised block of text.

## Collapsible admonitions

`???` produces the same block as a `<details>` element, collapsed by default. `???+`
produces one that starts open. Both work with JavaScript disabled, because they are real
disclosure widgets rather than scripted panels.

```markdown
??? example "Full CI configuration"
    Collapsed until the reader clicks it.

???+ info "Expanded by default"
    Open on load, but the reader can collapse it.
```

??? example "Full CI configuration"
    Collapsed until the reader clicks it. Good for long output, alternative
    platforms, and the third-choice workaround that only two readers need.

???+ info "Expanded by default"
    Open on load, but the reader can collapse it to get it out of the way.

Collapsed content is present in the HTML, so it is indexed by search and found by the
browser's in-page find.

## Kinds and their meaning

| Kind | Alert alias | Use it for |
|---|---|---|
| `note` | `[!NOTE]` | Context worth noticing while skimming. |
| `info` | — | Neutral background detail. |
| `tip` | `[!TIP]` | An optional shortcut or better way. |
| `important` | `[!IMPORTANT]` | Something the reader must do to succeed. |
| `warning` | `[!WARNING]` | Risk of a confusing failure or wasted time. |
| `caution` | `[!CAUTION]` | Risk of data loss or a security problem. |
| `danger` | — | The same weight as `caution`; use whichever word fits. |
| `example` | — | A worked example the reader can skip. |
| `quote` | — | An attributed quotation. |

A kind outside this list is passed through as a class and styled like `note`, so a
`!!! bikeshed` block still renders rather than failing the build.

!!! example "example"
    A worked example, collapsed or not, always reads better than a paragraph describing
    what the example would contain.

!!! quote "Rob Pike"
    Data dominates. If you have chosen the right data structures and organised things
    well, the algorithms will almost always be self-evident.

## Nesting

Admonitions may contain any block construct: lists, tables, code fences, and other
admonitions indented one more level.

!!! info "What the build writes"
    | Path | Contents |
    |---|---|
    | `dist/index.html` | the home page |
    | `dist/_spa/*.json` | one payload per route |
    | `dist/assets/` | hashed CSS and JS |

    ```bash
    md2spa build --out dist
    ```

## Choosing between the syntaxes

Both compile to identical HTML. Pick one per repository.

- **GitHub alerts** if the same Markdown is read in a repository web UI. Only five kinds,
  no custom titles, no collapsing.
- **MkDocs admonitions** if you need titles, collapsing or the extra kinds. The four-space
  body indentation renders as a code block in tools that do not know the syntax, which is
  ugly but not wrong.

This site uses GitHub alerts for short interjections and MkDocs blocks where a title or a
disclosure widget earns its keep.
