---
title: Reference overview
description: The three exhaustive reference pages: every command, every config key, every diagnostic code.
---

# Reference overview

Three pages, each complete. Where the guides explain why, these list what.

- [CLI](cli.md) — every command, every flag, every exit code.
- [Configuration reference](config-reference.md) — every key in the config file, with its
  type and default.
- [Diagnostics](diagnostics.md) — all 44 rule codes, what triggers each one, and how to
  fix it.

## A note on this section

The sidebar shows this folder as "Reference" while this page is titled "Reference
overview". That is `content/reference/_meta.json` at work:

```json
{
  "title": "Reference",
  "order": ["index.md", "cli.md", "config-reference.md", "diagnostics.md"],
  "collapsed": false
}
```

`title` renames the folder in the sidebar without renaming the page. `order` fixes the
sibling order, which matters here because alphabetical sorting would put
`config-reference.md` before `cli.md` and diagnostics last — readable, but not the order
you want to meet them in.

See [Project structure](../getting-started/project-structure.md#_metajson) for every key
`_meta.json` accepts.

## Stability

| Surface | Stability |
|:---|:---|
| CLI commands and flags | <span class="badge badge--ok">Stable</span> |
| Config keys | <span class="badge badge--ok">Stable</span> |
| Diagnostic codes | <span class="badge badge--ok">Stable</span> |
| Generated class names | <span class="badge badge--ok">Stable</span> |
| SPA payload shape | <span class="badge badge--info">Internal</span> |
| AST node shapes | <span class="badge badge--info">Internal</span> |

Stable surfaces do not change within a major version. A diagnostic code is never reused
for a different rule: if a rule is retired, its code is retired with it.

The two internal surfaces are documented because they are useful when you are debugging a
build, not because you should build against them.
