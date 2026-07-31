---
title: Code blocks
description: Fenced and indented code, language ids, filename captions, copy buttons and build-time highlighting.
order: 3
---

# Code blocks

Code is the reason most people open a documentation site. md2spa highlights it at build
time, so the page carries no syntax-highlighting library and nothing runs in the reader's
browser to produce it.

## Fenced blocks

Open with three or more backticks or three or more tildes, close with at least as many of
the same character. The closing fence must be at least as long as the opening one, which
is how a fence can contain another fence.

~~~markdown
```js
const routes = pages.map((page) => page.route);
```
~~~

```js
const routes = pages.map((page) => page.route);
```

Tilde fences are useful when the content itself contains backtick fences — the block above
was written with `~~~markdown` on the outside. An opening fence with no matching close
reports `MD020` and the block runs to the end of the file.

## The info string

Everything after the opening fence is the info string. The first word is the language; the
rest is metadata.

~~~markdown
```bash title="scripts/build.sh"
md2spa build --out public
```
~~~

```bash title="scripts/build.sh"
md2spa build --out public
```

Two metadata forms produce a caption above the block:

- `title="scripts/build.sh"` — an explicit title.
- A bare filename, as in ```` ```js server.js ````, which is the shorthand GitHub users
  expect.

Anything else in the info string is preserved on the node and ignored by the default
theme, so `linenums="1"` or `hl_lines="3 4"` will not break a build if you paste content
from another generator.

## Languages

The language id selects a grammar. The ids this site uses are `bash`, `css`, `html`, `js`,
`json`, `markdown` and `yaml`; common aliases such as `sh`, `shell`, `javascript` and `md`
resolve to the same grammars.

A fence whose language the highlighter does not know still renders correctly — the code is
escaped and the block is styled — but the build records `MD022` at info severity. That
turns a typo like ```` ```jsno ```` into a visible finding instead of a silently unstyled
block.

Omit the language entirely for output, transcripts and anything that is not source code:

```
$ md2spa build
content/  25 pages
dist/     58 files, 0 errors, 0 warnings
```

## Indented code

Four leading spaces also produce a code block. It has no language and therefore no
highlighting, and it cannot appear directly after a paragraph without a blank line:

    export PATH="$PWD/node_modules/.bin:$PATH"

Prefer fences. Indented code interacts badly with lists, is invisible in a diff, and gives
you nowhere to put a language id.

## What the renderer emits

Understanding the markup helps when you write custom CSS.

```html
<figure class="code" data-lang="js">
  <figcaption class="code__title">server.js</figcaption>
  <pre class="code__pre"><code class="language-js">...</code></pre>
</figure>
```

The `<figcaption>` is present only when the info string supplied a title. Highlight spans
use two classes, a constant `tok` plus a modifier:

| Class | Token |
|---|---|
| `tok--kw` | keywords |
| `tok--str` | strings |
| `tok--num` | numbers |
| `tok--com` | comments |
| `tok--fn` | function names |
| `tok--type` | types and classes |
| `tok--var` | variables and identifiers |
| `tok--op` | operators |
| `tok--punc` | punctuation |
| `tok--attr` | attributes and property keys |
| `tok--builtin` | built-in globals |
| `tok--meta` | preprocessor and shebang lines |
| `tok--ins` | inserted lines in a diff |
| `tok--del` | removed lines in a diff |

Because the classes are stable, restyling the theme is a stylesheet change. Because the
spans are generated at build time, the page contains no highlighting code at all.

## Copy buttons

Every block gets a copy button, injected by the SPA runtime after the page loads. It
copies the code with the highlighting markup stripped and the trailing newline preserved.

With JavaScript disabled the button is absent and the code is still selectable. Nothing
about the block depends on the script running.

> [!TIP]
> Write shell examples without a `$` prompt when the reader is meant to copy them. With
> the prompt, a copy-paste run fails on the first line. Use a prompt only in transcripts
> where you also show the output.

## Long lines

Code blocks scroll horizontally rather than wrapping, because wrapped code is unreadable
and a wrapped shell command is dangerous. Keep example lines under about 80 characters
where you can, and break long commands with a trailing backslash:

```bash
md2spa build \
  --out public \
  --base /handbook/ \
  --strict
```

## Highlighting can be turned off

Set `"highlight": false` to skip the highlighter entirely. Blocks still render with the
`language-*` class on the `<code>` element, so a client-side highlighter can be added by a
custom theme. Builds get marginally faster; `MD022` stops firing.

The full key list is in the [Configuration reference](../reference/config-reference.md).
