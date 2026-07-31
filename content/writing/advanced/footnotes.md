---
title: Footnotes
description: Footnote references and definitions, how they are numbered and collected, and the three rules that keep them honest.
order: 2
---

# Footnotes

A footnote moves a caveat out of the sentence without losing it. Use one when the detail
matters to a reader who is checking your work, but would derail a reader who is following
the instructions.[^why]

## Syntax

A reference is `[^identifier]` in the text. A definition is `[^identifier]: text` on its
own line, anywhere in the file.

```markdown
The dialect is CommonMark plus a fixed set of extensions.[^spec]

[^spec]: The baseline is the CommonMark specification, version 0.31.
```

Identifiers may be numbers or words. Words are better: `[^spec]` survives a reordering
that turns `[^1]` into `[^3]`, and it tells you what the note is about when you meet it in
a diff.

The dialect is CommonMark plus a fixed set of extensions.[^spec] Where the two disagree,
CommonMark wins, because a document that only renders correctly in one tool is not a
document.[^disagree]

## Numbering and placement

Footnotes are numbered by **order of first reference**, not by the order the definitions
appear. Write definitions wherever they are convenient — immediately under the paragraph
that uses them, or all together at the end of the file — and the rendered numbering comes
out the same.

Every definition is collected into a single `<section class="footnotes">` at the end of
the article, after the last paragraph and before the previous/next links. Each one gets a
back-reference arrow that returns to the exact reference that sent you there.

Referencing the same footnote twice reuses the same number.[^spec] The back-reference
points at the first occurrence.

## Multi-paragraph footnotes

Indent continuation blocks by four spaces, exactly like a list item.

```markdown
[^long]: The first paragraph of the note.

    A second paragraph, indented four spaces. Lists and code fences
    work here too.
```

The footnote at the end of this sentence has two paragraphs.[^long]

Keep them short anyway. A footnote long enough to need two paragraphs is usually a section
that has been demoted for the wrong reason.

## When to use a footnote

Good reasons:

- A caveat that applies to one specific claim, such as a version cutoff or a platform
  exception.
- A citation, so the sentence reads cleanly without a parenthetical URL.
- An aside that a curious reader will want and a hurried reader will not.

Bad reasons:

- Hiding something the reader needs. If they need it, it belongs in the sentence, or in a
  `> [!IMPORTANT]` block.
- Table annotations. A footnote reference inside a table cell works, but it sends the
  reader to the bottom of a long page. Use `<sup>` markers and a note directly under the
  table instead, as [Tables](../tables.md) does.
- Long asides. Promote them to a section and link to it.

## Diagnostics

| Code | Severity | Fires when |
|:---|:---|:---|
| `MD070` | error | A reference has no matching definition |
| `MD071` | info | A definition is never referenced |
| `MD072` | warning | The same identifier is defined twice |

`MD070` is an error because the alternative is a page that renders `[^spec]` as literal
text in the middle of a sentence. `MD071` is only informational: an orphaned definition is
usually a reference that was deleted during an edit, which is worth knowing about but not
worth failing a build over.

`MD072` keeps the second definition and reports the first. Two definitions with one
identifier is always a mistake, and picking either one silently would make the mistake
invisible.

## Alternatives

- For a table annotation, `<sup>1</sup>` plus a note under the table.
- For a citation you want people to click, an ordinary inline link.
- For an aside worth a paragraph, an `!!! info` admonition. See
  [Admonitions](../admonitions.md).
- For something the reader must not miss, no footnote at all.

[^why]: This page has four footnotes, which is three more than most pages should have. It
    is a demonstration, not a style guide.

[^spec]: The baseline is the CommonMark specification. Extensions come from the GitHub
    Flavored Markdown spec and from Python-Markdown's admonition syntax.

[^disagree]: In practice they rarely disagree. The places they do are emphasis adjacency
    and how many backticks close a code span, and both are edge cases you should not be
    writing on purpose.

[^long]: The first paragraph of a multi-paragraph footnote. It ends here.

    This is the second paragraph, indented four spaces so the parser knows it belongs to
    the note rather than to the document. Code fences and lists work here too, though if
    you need them you have almost certainly outgrown the footnote.
