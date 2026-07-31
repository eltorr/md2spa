# md2spa

Turn a folder of Markdown into a fast, searchable documentation site with a single-page-app
router — with **zero dependencies**. Node 18 or newer is the only requirement.

**[See what it produces →](https://eltorr.github.io/md2spa/)**

That site is this repository's own `content/` folder, built by this tool. The sidebar, the
search, the instant navigation and the syntax highlighting are all what you get out of the box.

## What it does

- **The folder tree is the navigation.** Drop `content/guide/install.md` into place and it
  appears in the sidebar, correctly titled, ordered and nested. There is no navigation file
  to keep in step with reality.
- **Pre-rendered, then enhanced.** Every page is complete static HTML. The client-side
  router makes navigation instant; with JavaScript disabled the site still works.
- **A real Markdown linter.** 44 rules covering frontmatter, headings, tables, code fences,
  footnotes and raw HTML. A relative link pointing at nothing fails the build instead of
  shipping.
- **Deploys anywhere without configuration.** URLs are document-relative by default, so one
  build artifact is valid at a domain root, under a `/project/` prefix on GitLab or GitHub
  Pages, and inside a subfolder of a larger site.
- **Nothing to install.** No `npm install`, no lockfile, no registry, no supply chain. CI
  runs straight from a checkout.

## Quick start

```bash
git clone https://github.com/eltorr/md2spa.git
cd md2spa

node src/cli.js dev          # http://127.0.0.1:3000, with live reload
```

Edit anything under `content/` and the browser reloads. To add a page, create a file:

```bash
mkdir -p content/guide
printf -- '---\ntitle: Installation\n---\n\n# Installation\n' > content/guide/install.md
```

It is in the sidebar before you switch back to the browser.

```bash
node src/cli.js build        # render into dist/
node src/cli.js check        # lint only; writes nothing
node --test test/*.test.js   # run the test suite
```

## Starting your own site

Replace the bundled `content/` with your own pages, then add a deployment pipeline:

```bash
node src/cli.js template            # list targets: gitlab, github, server
node src/cli.js template github     # writes .github/workflows/pages.yml
```

| Target | Writes | Publishes to |
|:---|:---|:---|
| `gitlab` | `.gitlab-ci.yml` | `https://<namespace>.gitlab.io/<project>/` |
| `github` | `.github/workflows/pages.yml`, `static/.nojekyll` | `https://<user>.github.io/<repo>/` |
| `server` | `Dockerfile`, `nginx.conf`, `docker-compose.yml` | Wherever you run the container |

Commit and push. Neither Pages host needs any path configuration.

## Commands

| Command | Purpose |
|:---|:---|
| `build` | Render `content/` into `outDir` |
| `dev` | Serve with live reload; includes drafts |
| `check` | Lint and report; writes nothing |
| `new <route>` | Scaffold a page with frontmatter |
| `init` | Scaffold a config file and starter content |
| `template [target]` | Add a deployment recipe |

`check` supports `--format pretty|json|github|junit`, so CI can surface diagnostics as
GitHub annotations or a GitLab test report. `check --list-rules` prints the full catalogue.

## Layout

```
├── md2spa.config.json    site title, theme, repository links
├── content/               your Markdown — this tree is the sidebar
├── static/                copied verbatim to the site root
├── src/                   the generator
├── templates/             deployment recipes
└── test/                  test suite
```

## Documentation

The documentation is the site itself:

- **[Getting started](https://eltorr.github.io/md2spa/getting-started/)** — installation, project structure, configuration
- **[Structuring content](https://eltorr.github.io/md2spa/structuring/)** — how folders become navigation
- **[Writing content](https://eltorr.github.io/md2spa/writing/)** — the supported Markdown dialect
- **[Reference](https://eltorr.github.io/md2spa/reference/)** — CLI, configuration keys, every diagnostic code
- **[Deploying](https://eltorr.github.io/md2spa/deploying/)** — GitLab, GitHub, Docker and others

[`SPEC.md`](SPEC.md) documents the internal contract: the AST, the module interfaces and
the rule catalogue.

## Requirements

Node.js 18 or newer. Nothing else.

## License

MIT — see [LICENSE](LICENSE).
