---
title: Markdown syntax
description: Every Markdown construct md2spa supports, shown as source and as rendered output on the same page.
order: 1
---

# Markdown syntax

This page is the complete dialect. Each section shows the source and, immediately after
it, the rendered result — the page you are reading is the output of the source it quotes.
The baseline is the [CommonMark specification][commonmark]; the extensions are listed in
[Writing content](index.md).

## Headings

ATX headings use one to six `#` characters followed by a space. Closing hashes are
optional and are stripped. Setext headings underlined with `===` or `---` produce H1 and
H2 respectively.

```markdown
# Level one
## Level two
### Level three ###

Setext level one
================

Setext level two
----------------
```

The `#` and the text must be separated by a space. `#Heading` is a paragraph that starts
with a hash, and md2spa reports it as `MD010` rather than guessing.

Every heading gets an id derived from its text, and a permalink anchor you can hover to
reveal. The slug rules match GitHub and Python-Markdown, so anchors copied from an
existing wiki keep resolving. Punctuation is deleted rather than replaced, which is why
"M1 Pro/Max/Ultra devices" becomes `m1-promaxultra-devices` and not
`m1-pro-max-ultra-devices`.

Two headings with the same text get numeric suffixes — `overview`, `overview-1` — and an
`MD014` note, because an auto-suffixed anchor is a link that will break the next time
someone reorders the page.

## Paragraphs and line breaks

A blank line separates paragraphs. A single newline inside a paragraph is a soft break and
collapses to a space, so you can wrap source lines wherever you like without changing the
output.

For a hard break — a `<br>` inside one paragraph — end the line with a backslash, or with
two spaces.

```markdown
Roses are red\
violets are blue.

Roses are red··
violets are blue.
```

The backslash form is preferred because it survives editors that trim trailing whitespace,
and because it is visible in a diff. Here it is live:

Ground floor: reception\
First floor: engineering\
Second floor: the coffee machine that matters

## Emphasis

| Source | Renders as |
|---|---|
| `*emphasis*` or `_emphasis_` | *emphasis* |
| `**strong**` or `__strong__` | **strong** |
| `***both***` | ***both*** |
| `~~struck through~~` | ~~struck through~~ |
| `` `inline code` `` | `inline code` |

Underscore emphasis does not apply inside a word, so `snake_case_identifiers` survives
intact. Asterisk emphasis does, which is why `a*b*c` renders as a*b*c.

Inline code spans use runs of backticks. To include a literal backtick, wrap the span in a
longer run: `` `a` `` is written with two backticks on each side. An unmatched run is
reported as `MD021` instead of eating the rest of the line.

## Lists

### Bullet lists

Use `-`, `*` or `+`. Pick one and keep it — mixing markers inside a single list produces
`MD060`.

- Espresso
- Cortado
- Flat white

### Ordered lists

Use `1.` or `1)`. The first number sets the start value; the rest are renumbered, but
md2spa reports `MD061` when the source numbering is not sequential, because
non-sequential source is almost always a paste accident.

1. Read the error message.
2. Read it again, slowly.
3. Fix the thing it actually said.

### Nested lists

Indent a nested list to the parent's content column — two spaces under `- `. Three-space
and tab indentation is ambiguous and produces `MD062` or `MD063`.

- Build inputs
  - `content/` — Markdown sources
  - `static/` — verbatim assets
  - `md2spa.config.json` — one file, all settings
- Build outputs
  - `dist/` — the site
  - `dist/_spa/` — one JSON payload per route

### Loose and tight lists

A list with a blank line between items is *loose*: each item is wrapped in a paragraph and
gets vertical spacing. Without blank lines it is *tight* and renders compactly. Both of
the lists above are tight; this one is loose:

- The parser decides tightness per list, not per document.

- You control it with blank lines, exactly as CommonMark specifies.

### Task lists

Prefix an item with `[ ]` or `[x]`. The checkboxes render as disabled inputs.

- [x] Parse CommonMark
- [x] Report useful diagnostics
- [ ] Achieve inbox zero

## Blockquotes

A `>` prefix quotes a block. Quotes nest, and they may contain any other block construct.

> The best documentation is the documentation that exists.
>
> > Nested quotes work, and so do lists inside quotes:
> >
> > - like this one
> > - and this one

A blockquote whose first line is `> [!NOTE]` is not a quote — it is an admonition. See
[Admonitions](admonitions.md).

## Thematic breaks

Three or more `-`, `*` or `_` on a line of their own. All three forms are identical in the
output.

---

The break above was written as `---`. Because it follows a blank line it cannot be
mistaken for a setext underline.

## Code

Fenced code uses three or more backticks or three or more tildes. The word after the fence
is the language; anything after that is metadata.

Indented code — four spaces, no fence — also works, but has no language and therefore no
highlighting:

    $ md2spa build
    dist/ written, 24 pages, 0 errors

Fences are covered in detail in [Code blocks](code-blocks.md), including titles, unknown
languages and how to show a fence inside a fence.

## Tables

A header row, a delimiter row, then body rows. The delimiter row sets alignment: `:--`
left, `:-:` centre, `--:` right, `---` default.

```markdown
| Left | Centre | Right |
|:-----|:------:|------:|
| a    |   b    |     c |
```

| Left | Centre | Right |
|:-----|:------:|------:|
| Node | 18+ | required |
| Dependencies | none | 0 |
| Output size | small | 96 KB |

Leading and trailing pipes are optional, and column widths do not need to line up. A
missing delimiter row is `MD030`; a malformed one is `MD032`; a row with the wrong number
of cells is `MD031`. More in [Tables](tables.md).

## Links

### Inline links

`[text](url)` with an optional quoted title.

```markdown
[The CLI reference](../reference/cli.md)
[With a title](../reference/cli.md "Every command and flag")
[Straight to a section](../reference/cli.md#build)
```

Internal links are written as relative paths to the `.md` file and rewritten to routes at
build time. That means the same link works in your editor's preview, in the repository web
UI, and in the built site. See [Links and assets](links-and-assets.md).

### Reference links

Define the destination once, use it many times. Definitions may sit anywhere in the file
and are not rendered.

```markdown
The [CommonMark spec][commonmark] is the baseline.

[commonmark]: https://spec.commonmark.org/current/ "CommonMark specification"
```

A reference with no matching definition is `MD041`. A definition nobody uses is `MD048`.
This page defines `[commonmark]` and `[gfm]` at the bottom and uses both, so neither
fires.

The shortcut form `[commonmark]` — no second bracket pair — resolves against the same
definitions. The [GFM specification][gfm] describes the table and task-list extensions
md2spa implements.

### Autolinks

Wrap a URL or an email address in angle brackets and it becomes a link with itself as the
text: <https://spec.commonmark.org/current/> and <mailto:docs@example.com>.

### Bare URLs

A URL written with no brackets at all is still linkified, but it produces `MD047` at info
severity as a nudge toward the explicit form:

```markdown
See https://example.com/docs for details.
```

Turn the rule off with `"rules": { "MD047": "off" }` if your house style prefers bare URLs.

## Images

`![alt text](src)`, with the same relative-path resolution as links.

```markdown
![The md2spa logo](../../logo.svg)
![With a title](../../logo.svg "md2spa")
```

![The md2spa logo](../../logo.svg)

An image with an empty alt attribute is treated as decorative. That is a legitimate
choice, but it is reported as `MD043` at warning severity so it stays a choice rather than
an oversight.

## Inline HTML

Allowlisted HTML passes through. Press <kbd>Ctrl</kbd> + <kbd>K</kbd> to open search.
Superscripts and subscripts work — I<sup>2</sup>C, H<sub>2</sub>O — and so do
<abbr title="Abstract Syntax Tree">AST</abbr>, <mark>highlighted text</mark>, inserted
text as <ins>this</ins>, and <span class="badge badge--ok">status badges</span>.

Tags outside the allowlist are escaped. Real HTML elements that could execute code are
escaped *and* reported as `MD052`; anything that is not a known HTML element — the
`<your-volume>` and `<key>` placeholders that fill technical prose — is escaped silently
with no diagnostic. The full policy is in [Custom HTML](advanced/custom-html.md).

## Entities

Named and numeric character references pass through unchanged: &copy; 2024, &mdash; an
em dash &#8212; and &#x21A9; an arrow. A stray `&` that is not part of a reference is
escaped, so `AT&T` renders correctly without any escaping on your part.

## Footnotes

`[^1]` in the text, `[^1]: definition` anywhere in the file. Definitions are collected
into a section at the end of the article regardless of where you wrote them. Worked
examples are in [Footnotes](advanced/footnotes.md).

## What is not supported

Definition lists, math, diagram fences, content tabs, include directives, and attribute
lists (`{: .class }`) are not part of the dialect and never will be. Each one is a private
extension that turns a Markdown file into a file that only one tool can read.

Where an extension solves a real problem, the answer is raw HTML: `<dl>` for definition
lists, `<details>` for disclosure, `<sup>` for footnote-like markers in tables. Those are
in the allowlist and they render everywhere.

[commonmark]: https://spec.commonmark.org/current/ "CommonMark specification"
[gfm]: https://github.github.com/gfm/ "GitHub Flavored Markdown specification"
