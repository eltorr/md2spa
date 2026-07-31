---
title: Configuration reference
description: Every key md2spa accepts, with its type, default, and what happens when the value is wrong.
---

# Configuration reference

Every key is optional. The tables below give the exact default that applies when a key is
absent. For where the file lives and how to override it per run, see
[Configuration](../getting-started/configuration.md).

## Site identity

| Key | Type | Default | Effect |
|:---|:---|:---|:---|
| `title` | string | `"Documentation"` | Site title. Top bar, `<title>` suffix, search header, Open Graph site name. |
| `description` | string | `""` | Default meta description for pages that set none. |
| `lang` | string | `"en"` | Value of the `lang` attribute on `<html>`. |
| `siteUrl` | string | `""` | Absolute origin and path, e.g. `https://acme.gitlab.io/handbook`. Required for canonical links, `sitemap.xml` and Open Graph URLs. Trailing slashes are stripped. |

An empty `siteUrl` is not an error. It only means the sitemap contains site-relative paths
and no canonical or `og:url` tags are emitted.

## Paths

| Key | Type | Default | Effect |
|:---|:---|:---|:---|
| `contentDir` | string | `"content"` | Markdown source root. Missing directory is `CFG003`, an error. |
| `outDir` | string | `"dist"` | Build output. Emptied before every build. |
| `staticDir` | string | `"static"` | Copied verbatim to the site root. Absent is fine. |

Relative paths resolve against the working directory, not against the config file. All
three accept absolute paths.

> [!CAUTION]
> `outDir` is emptied at the start of every build. Never point it at a directory that
> holds anything you have not generated. The build refuses to empty a path fewer than two
> segments deep, which stops the worst accidents but not all of them.

## Output shape

| Key | Type | Default | Effect |
|:---|:---|:---|:---|
| `base` | string | `"auto"` | `"auto"`, `"/"`, or `"/prefix/"`. See [Base paths](../deploying/advanced/base-paths.md). |
| `cleanUrls` | boolean | `true` | `true` writes `guide/install/index.html`; `false` writes `guide/install.html`. |
| `spa` | boolean | `true` | Emit the client-side router and one JSON payload per route. |
| `search` | boolean | `true` | Build `search-index.json` and enable the search modal. |
| `highlight` | boolean | `true` | Run the build-time syntax highlighter. |
| `mermaid` | boolean | `true` | Draw `mermaid` fences as inline SVG. `false` leaves them as code blocks. |
| `strict` | boolean | `false` | Treat warnings as errors. `--strict` sets this per run. |
| `buildDate` | string or null | `null` | An ISO date string to show in the footer. `null` omits it. |

`buildDate` is the only thing that can put a timestamp in the output, and it is opt-in
precisely so that builds stay byte-for-byte reproducible by default.

## `toc`

Controls the right-hand table of contents.

| Key | Type | Default | Effect |
|:---|:---|:---|:---|
| `toc.minDepth` | number | `2` | Shallowest heading level to include. Clamped to 1–6. |
| `toc.maxDepth` | number | `3` | Deepest heading level to include. Clamped to between `minDepth` and 6. |

The defaults list H2 and H3, which is right for almost every page. Setting `maxDepth` to
`2` gives a flat list of sections; setting `minDepth` to `1` includes the page title
itself, which is redundant with the breadcrumb above it.

Individual pages opt out with frontmatter `toc: false`.

## `nav`

Controls the sidebar tree.

| Key | Type | Default | Effect |
|:---|:---|:---|:---|
| `nav.collapseDepth` | number | `1` | Groups deeper than this start collapsed. `0` collapses everything. |
| `nav.sort` | string | `"auto"` | `"auto"`, `"alpha"` or `"manual"`. |
| `nav.filter` | boolean | `true` | Show the live filter box above the tree. |

`"auto"` applies the full ordering rules: frontmatter `order`, then `_meta.json`, then
alphabetical with `index.md` first. `"alpha"` ignores `order` and `_meta.json` entirely.
`"manual"` uses only `_meta.json` order and appends unlisted items alphabetically.

Groups on the path to the current page always expand, whatever `collapseDepth` says.

## `theme`

| Key | Type | Default | Effect |
|:---|:---|:---|:---|
| `theme.accent` | string | `"#5b5bd6"` | Accent colour in light mode. Links, active nav rail, focus rings. |
| `theme.accentDark` | string | `"#a5a5ff"` | Accent colour in dark mode. Needs to be lighter to hold contrast. |
| `theme.defaultMode` | string | `"auto"` | `"auto"`, `"light"` or `"dark"`. `"auto"` follows the operating system. |
| `theme.font` | string | `""` | CSS `font-family` override for body text. Empty uses the system stack. |
| `theme.monoFont` | string | `""` | CSS `font-family` override for code. |
| `theme.logo` | string | `""` | Path under `staticDir`, e.g. `"logo.svg"`. Shown in the top bar. |
| `theme.favicon` | string | `""` | Path under `staticDir`, e.g. `"favicon.svg"`. |

Font values are emitted as a CSS custom property, so they must be valid `font-family`
syntax and must name fonts the reader already has. md2spa never loads a remote font: that
is a request to a third party on every page view, and it breaks offline and under a strict
Content-Security-Policy.

Pick `accent` and `accentDark` as a pair. The light one has to reach 4.5:1 against white,
the dark one against near-black. This site uses `#0b6bcb` and `#7cc4ff`.

## `theme.diagram`

An optional block of overrides for [diagrams](../writing/diagrams.md#theming). Every key
is optional; an absent key leaves the diagram inheriting the theme.

| Key | Type | Custom property | Effect |
|:---|:---|:---|:---|
| `theme.diagram.nodeBg` | string | `--dg-node-bg` | Node fill. Defaults to `--bg-subtle`. |
| `theme.diagram.nodeBorder` | string | `--dg-node-border` | Node stroke. Defaults to `--border-strong`. |
| `theme.diagram.nodeFg` | string | `--dg-node-fg` | Label text. Defaults to `--text`. |
| `theme.diagram.edge` | string | `--dg-edge` | Edge lines and arrowheads. Defaults to `--border-strong`. |
| `theme.diagram.accent` | string | `--dg-accent` | Activation bars, dividers and other highlights. Defaults to `--accent`. |
| `theme.diagram.fontSize` | string | `--dg-font-size` | Base label size, as a CSS length. Defaults to `--fs-sm`. |

```json
{
  "theme": {
    "diagram": {
      "nodeBg": "#f6f8fa",
      "nodeBorder": "#c9d1d9",
      "edge": "#8b949e"
    }
  }
}
```

These values apply to both themes, so a literal colour has to hold contrast in light and
dark. Where it cannot, leave the block out and override the `--dg-*` properties under each
theme's selector in your own stylesheet instead. There is no `diagramDark` key, precisely
so that the theme-aware default stays the easy path.

## `repo`

| Key | Type | Default | Effect |
|:---|:---|:---|:---|
| `repo.url` | string | `""` | Repository link in the top bar. Empty hides the link. |
| `repo.label` | string | `""` | Accessible name for that link, e.g. `"GitLab"`. |
| `repo.editBase` | string | `""` | Prefix for the per-page edit link. Empty hides the link. |

`editBase` is joined with each page's path relative to `contentDir`. For GitLab the shape
is `https://gitlab.com/acme/docs/-/edit/main/content`; for GitHub it is
`https://github.com/acme/docs/edit/main/content`.

## `footer`

| Key | Type | Default | Effect |
|:---|:---|:---|:---|
| `footer.text` | string | `""` | A line of text in the site footer. |
| `footer.links` | array | `[]` | Objects of the shape `{ "label": "...", "url": "..." }`. |

Entries missing a string `label` or a string `url` are dropped silently rather than
rendering a link to nowhere.

```json
{
  "footer": {
    "text": "Licensed under CC BY 4.0.",
    "links": [
      { "label": "Repository", "url": "https://gitlab.com/acme/handbook" },
      { "label": "Issues", "url": "https://gitlab.com/acme/handbook/-/issues" }
    ]
  }
}
```

## `rules`

An object mapping diagnostic codes to severities.

| Value | Effect |
|:---|:---|
| `"off"` | Never report the rule |
| `"info"` | Report it, never fail the build |
| `"warning"` | Report it; fails the build only under `--strict` |
| `"error"` | Report it and fail the build |

```json
{
  "rules": {
    "MD047": "off",
    "MD043": "error",
    "MD063": "warning"
  }
}
```

An unrecognised code is `CFG002`; an unrecognised severity is `CFG001`. Every code is
listed in [Diagnostics](diagnostics.md).

## Validation and normalisation

Type checking happens before anything else runs.

| Situation | Result |
|:---|:---|
| A key has the wrong type | `CFG001`, error |
| A top-level or nested key is not recognised | `CFG002`, warning; the key is ignored |
| `contentDir` does not exist | `CFG003`, error |
| The file is not valid JSON | `CFG001`, error; defaults are used |
| A `.js` or `.mjs` config has no default export object | `CFG001`, error |

After validation, several values are normalised rather than rejected:

- `base` gets leading and trailing slashes added and duplicate slashes collapsed, unless
  it is `"auto"`.
- `siteUrl` loses trailing slashes.
- `theme.defaultMode` outside `auto` / `light` / `dark` becomes `"auto"`, with a `CFG001`.
- `nav.sort` outside `auto` / `alpha` / `manual` becomes `"auto"`, with a `CFG001`.
- `toc.minDepth` and `toc.maxDepth` are rounded and clamped.
- `nav.collapseDepth` is rounded and floored at `0`.
- Malformed `footer.links` entries are removed.

Because unknown keys warn rather than fail, a config written for a newer version of
md2spa still builds on an older one.

## The complete default config

Everything below is what you get with no config file at all.

```json
{
  "title": "Documentation",
  "description": "",
  "lang": "en",
  "base": "auto",
  "siteUrl": "",
  "contentDir": "content",
  "outDir": "dist",
  "staticDir": "static",
  "cleanUrls": true,
  "spa": true,
  "search": true,
  "highlight": true,
  "mermaid": true,
  "strict": false,
  "buildDate": null,
  "toc": { "minDepth": 2, "maxDepth": 3 },
  "nav": { "collapseDepth": 1, "sort": "auto", "filter": true },
  "theme": {
    "accent": "#5b5bd6",
    "accentDark": "#a5a5ff",
    "defaultMode": "auto",
    "font": "",
    "monoFont": "",
    "logo": "",
    "favicon": ""
  },
  "repo": { "url": "", "label": "", "editBase": "" },
  "footer": { "text": "", "links": [] },
  "rules": {}
}
```

## Config file names

Probed in order; the first match wins.

1. `md2spa.config.json`
2. `md2spa.config.js`
3. `md2spa.config.mjs`
4. `.md2sparc.json`

`--config <path>` skips the probe. JSON files may contain `//` and `/* */` comments.
