---
title: Diagnostics
description: All 49 md2spa rule codes, what triggers each one, and how to fix it.
---

# Diagnostics

md2spa lints while it builds. Every finding has a stable code, a severity, a file, a line
and a column, and — where a fix is mechanical — a hint that tells you what to type.

This page lists every rule. It is the reference the linter is only useful with.

## How to read a diagnostic

The default `pretty` format prints the location, severity and code on one line, then the
offending source with a caret, then the hint:

```
content/guide/install.md:12:3  error  MD030  table missing the delimiter row
   |
12 | | Feature | Status |
   |   ^
   = hint: add a row like `|---|---|` directly beneath the header row
```

`--format json`, `--format github` and `--format junit` carry exactly the same fields in
machine-readable shapes. See [CLI output formats](cli.md#output-formats).

## Severity

| Severity | Effect on the build |
|:---|:---|
| `error` | Always fatal. Exit code `1`. |
| `warning` | Reported. Fatal only under `--strict`. |
| `info` | Reported. Never fatal. |
| `off` | Not reported at all. Only reachable through the `rules` config. |

The split follows one rule: a finding is an **error** when the rendered output would be
wrong or misleading, a **warning** when the output is fine but the source has a defect,
and **info** when it is a matter of consistency.

## Frontmatter and file level

| Code | Severity | Triggered by | How to fix |
|:---|:---|:---|:---|
| `MD001` | error | An unterminated frontmatter block, or a line inside it that is not a `key: value` pair | Close the block with `---`. Look for a missing colon, a tab, or a value that needs quoting |
| `MD002` | error | A checked frontmatter key with the wrong type, such as `order: "3"` or `draft: yes` | Use the documented type. Numbers unquoted, booleans as `true` or `false`, lists as arrays |
| `MD003` | warning | A file that is empty, or contains only frontmatter | Add content, delete the file, or mark it `draft: true` until it has some |
| `MD004` | info | CRLF line endings anywhere in the file | Re-save with LF. Add `*.md text eol=lf` to `.gitattributes` so it stays fixed |
| `MD005` | info | A UTF-8 byte order mark at the start of the file | Re-save as UTF-8 without a BOM |

The checked frontmatter types are listed under
[Frontmatter](../writing/frontmatter.md#checked-keys). Keys outside that list are never
type-checked and never warn.

## Headings

| Code | Severity | Triggered by | How to fix |
|:---|:---|:---|:---|
| `MD010` | error | `#Heading` — no space between the hashes and the text | Add a space. Without it the line is a paragraph, not a heading |
| `MD011` | warning | A skipped heading level, such as `##` followed by `####` | Promote the deeper heading, or add the level you skipped |
| `MD012` | warning | More than one H1 in a document | Demote the extras to H2. One document, one title |
| `MD013` | warning | No H1 anywhere and no frontmatter `title` | Add a frontmatter `title`, an H1, or both |
| `MD014` | info | Two headings that produce the same anchor id; the second is suffixed `-1` | Rename one of them. An auto-suffixed anchor breaks as soon as the page is reordered |
| `MD015` | error | A heading with no text, such as a bare `##` | Add text, or delete the line |

## Code blocks

| Code | Severity | Triggered by | How to fix |
|:---|:---|:---|:---|
| `MD020` | error | A fenced block that is never closed before the end of the file | Add the closing fence. It must be at least as long as the opening one |
| `MD021` | warning | An unmatched backtick run in inline code | Balance the runs, or wrap a literal backtick in a longer run |
| `MD022` | info | A fence language the highlighter does not recognise | Correct the id, use a known alias, or drop the language for plain output |

`MD022` is the rule that catches a typo like ```` ```jsno ````, which otherwise renders as
an unstyled block that nobody notices. See [Code blocks](../writing/code-blocks.md#languages).

## Tables

| Code | Severity | Triggered by | How to fix |
|:---|:---|:---|:---|
| `MD030` | error | A table header with no delimiter row under it | Add a row of dashes, `\|---\|---\|`, directly beneath the header |
| `MD031` | warning | A body row whose cell count differs from the header | Add or remove pipes. Escape a literal pipe as `\|` |
| `MD032` | error | A delimiter row that is not made of `---`, `:--`, `--:` or `:-:` | Use one of those four forms. `===` and `:-` are not delimiter syntax |

## Links and images

| Code | Severity | Triggered by | How to fix |
|:---|:---|:---|:---|
| `MD040` | error | A link or image whose bracket or parenthesis is never closed | Close it, or escape the bracket as `\[` if you meant it literally |
| `MD041` | error | `[text][ref]` where no `[ref]:` definition exists | Add the definition, or fix the identifier. Identifiers are case-insensitive |
| `MD042` | error | An empty destination: `[text]()` | Supply a destination, or remove the link markup |
| `MD043` | warning | An image with no alt text | Describe what the image says. If it is decorative, say so deliberately with empty alt |
| `MD044` | error | An internal link pointing at a page that does not exist | Fix the path, or create the page. Paths resolve against the source file's directory |
| `MD045` | warning | A link whose fragment matches no heading id on the target page | Copy the anchor from the target page's heading permalink |
| `MD046` | warning | A local asset that does not exist under `staticDir` or `contentDir` | Fix the path, or add the file to `static/` |
| `MD047` | info | A bare URL, linkified automatically | Wrap it in `<...>` or `[text](...)`, or set `"MD047": "off"` |
| `MD048` | info | A link reference definition that nothing uses | Use it, or delete it |

`MD044` and `MD045` are checked across the whole content tree, even when you run
`md2spa check` on one file. See [Links and assets](../writing/links-and-assets.md).

## Inline markup and raw HTML

| Code | Severity | Triggered by | How to fix |
|:---|:---|:---|:---|
| `MD050` | warning | An emphasis or strong marker opened and not closed on the same line | Close it, or escape the marker as `\*` if it is literal |
| `MD051` | warning | A raw HTML tag opened and never closed, or closed without being opened | Balance the tags. The sanitiser closes dangling tags so the output stays valid, then reports where it had to |
| `MD052` | warning | A disallowed HTML tag, attribute or URL scheme; it was escaped or stripped | Use an allowlisted tag, a class instead of `style`, and a safe URL scheme |

`MD052` never fires for tags that are not real HTML elements. `<your-volume>` and `<key>`
are escaped silently, because in technical prose they are almost always placeholders. The
full policy is in [Custom HTML](../writing/advanced/custom-html.md).

## Lists and structure

| Code | Severity | Triggered by | How to fix |
|:---|:---|:---|:---|
| `MD060` | info | Mixed markers inside one list, such as `-` then `*` | Pick one marker per list. A changed marker starts a new list in CommonMark |
| `MD061` | info | Ordered list numbering that is not sequential | Renumber. The output renumbers anyway, so the source is the only place it shows |
| `MD062` | warning | List item indentation that is ambiguous — three spaces, or a tab | Indent nested items to the parent's content column: two spaces under `-` |
| `MD063` | info | A hard tab used for indentation | Use spaces. Tab width is a per-reader setting, so tabs make indentation unpredictable |
| `MD064` | error | An admonition block that is never closed | Close the block. `!!!` bodies end at the first dedent; alert blockquotes end at a blank line |
| `MD065` | info | Trailing whitespace that is not a two-space hard break | Trim it. For a deliberate hard break, end the line with a backslash instead |

## Footnotes

| Code | Severity | Triggered by | How to fix |
|:---|:---|:---|:---|
| `MD070` | error | `[^id]` with no matching `[^id]:` definition | Add the definition, or remove the reference. Without one, the reference renders as literal text |
| `MD071` | info | A definition that nothing references | Reference it, or delete it |
| `MD072` | warning | The same footnote identifier defined more than once | Rename one of them. Only the last definition is kept |

See [Footnotes](../writing/advanced/footnotes.md).

## Diagrams

| Code | Severity | Triggered by | How to fix |
|:---|:---|:---|:---|
| `MD080` | info | A `mermaid` fence whose diagram type md2spa cannot draw, such as `gantt` or `classDiagram`, or one that parses but declares no nodes | Nothing. The block renders as code. A placeholder fence is deliberately not an error, so it cannot fail a `--strict` build |
| `MD081` | error | A line inside a `mermaid` fence that the parser cannot read, or an `activate` with no `deactivate` | Read the message: it names what it expected at that column. Only the documented subset is accepted |
| `MD082` | warning | A node or participant used without being declared; it was created automatically | Declare it. A mistyped id becomes a second node rather than an error, which is the bug this rule exists to catch |
| `MD083` | info | A `%%{init}%%` directive, ignored | Remove it. Colour and layout come from the theme; use `theme.diagram` or your own CSS |
| `MD084` | warning | A diagram over the size limits: 300 nodes, 600 edges, 60 participants, 400 messages | Split it. Over the limit the fence renders as a code block instead |

Only `MD081` is fatal. Every other diagram problem degrades to a code block, so a diagram
md2spa cannot draw never blocks a build. See [Diagrams](../writing/diagrams.md).

## Configuration and site

| Code | Severity | Triggered by | How to fix |
|:---|:---|:---|:---|
| `CFG001` | error | A config value with the wrong type, an invalid enum value, or a config file that will not parse | Check the type in the [config reference](config-reference.md). JSON configs may contain comments; JS configs need a default export |
| `CFG002` | warning | A config key md2spa does not recognise | Check the spelling, or remove the key. Unknown keys are ignored, so a config for a newer version still builds |
| `CFG003` | error | `contentDir` does not exist | Create it, set `contentDir`, or run `md2spa init` |
| `NAV001` | error | Two content files that map to the same route, such as `guide.md` and `guide/index.md` | Rename or remove one. Two pages at one URL means one of them is unreachable |
| `NAV002` | info | A folder with no `index.md`; a section landing page was generated for it | Nothing, if the generated page is fine. Add an `index.md` to write your own |
| `HTM001` | error | The generated HTML failed the well-formedness check: unbalanced tags, a duplicate `id`, or a missing required meta element | This is a bug in md2spa or a pathological input. The message names the element and the line |

## Overriding severity

Any code can be reassigned in the config:

```json
{
  "rules": {
    "MD047": "off",
    "MD043": "error",
    "MD063": "warning"
  }
}
```

Valid values are `"off"`, `"info"`, `"warning"` and `"error"`. An unknown code produces
`CFG002`; an unknown severity produces `CFG001`.

`md2spa check --list-rules` prints every code with its default severity, which is the
fastest way to find the one you want to change.

## Which rules to promote

Three are worth raising on a docs site that people rely on:

- `MD043` to `error` if accessibility is a requirement rather than a preference.
- `MD045` to `error` once your anchors are clean, so they stay clean.
- `MD014` to `warning` on a site with a lot of cross-linking, because auto-suffixed
  anchors are silent link rot.

And one is worth lowering:

- `MD047` to `off` if your house style writes bare URLs on purpose.

The blunt alternative is `--strict`, which promotes every warning at once. That is the
right setting for CI and the wrong one for a first draft.
