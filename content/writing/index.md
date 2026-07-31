---
title: Writing content
description: The Markdown dialect md2spa understands, and the conventions that keep a large docs tree consistent.
---

# Writing content

md2spa parses CommonMark plus a small, fixed set of extensions. There is no plugin
system, which means a document that renders here renders identically on the next machine,
next year, with no configuration to reproduce.

## The dialect

| Feature | Status |
|---|---|
| CommonMark core | <span class="badge badge--ok">Supported</span> |
| GitHub tables with alignment | <span class="badge badge--ok">Supported</span> |
| Task lists | <span class="badge badge--ok">Supported</span> |
| Strikethrough | <span class="badge badge--ok">Supported</span> |
| Footnotes | <span class="badge badge--ok">Supported</span> |
| GitHub alerts (`> [!NOTE]`) | <span class="badge badge--ok">Supported</span> |
| MkDocs admonitions (`!!! note`) | <span class="badge badge--ok">Supported</span> |
| Raw HTML, allowlisted tags | <span class="badge badge--ok">Supported</span> |
| Bare-URL linkification | <span class="badge badge--info">With a hint</span> |
| Definition lists | <span class="badge badge--none">Use raw HTML</span> |
| Math, Mermaid, tabs, snippets | <span class="badge badge--none">Not supported</span> |

Anything outside the set parses as literal text. Where the text looks like a failed
attempt at a supported construct, the linter says so rather than silently swallowing it.

## Pages in this section

- [Markdown syntax](markdown-syntax.md) — every construct, with live examples.
- [Admonitions](admonitions.md) — both callout syntaxes and all the kinds.
- [Code blocks](code-blocks.md) — fences, languages, titles and highlighting.
- [Tables](tables.md) — alignment, wrapping and support matrices.
- [Links and assets](links-and-assets.md) — relative links, anchors and images.
- [Frontmatter](frontmatter.md) — the metadata block and which keys are checked.
- [Advanced](advanced/index.md) — raw HTML and footnotes.

## Conventions that scale

These are not enforced by the tool. They are what keeps a hundred-page tree readable.

- **One H1 per page, and let the frontmatter title match it.** `MD012` catches the first
  half of that; the second half is on you.
- **Never skip a heading level.** `## ` then `#### ` is a screen-reader bug, and `MD011`
  reports it.
- **Link with relative `.md` paths.** They work on GitLab, on GitHub, in your editor's
  preview, and in the built site. Absolute routes only work in the built site.
- **Write alt text.** An image with no alt is either decorative — in which case say so
  with `![](...)` deliberately — or it is content that half your readers cannot see.
- **Keep lines under about 100 characters.** Diffs stay readable and review comments
  land on the right sentence.
- **Put the answer first.** Documentation is read in a hurry, from a search result,
  halfway down the page.

## Checking as you write

```bash
md2spa check content/writing
md2spa check --strict
```

`check` parses and lints without writing any output, so it is fast enough to bind to a
save hook. The [CLI reference](../reference/cli.md#check) covers the output formats.
