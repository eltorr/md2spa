---
title: GitLab Pages
description: A .gitlab-ci.yml that publishes to GitLab Pages unmodified, plus a lint job that reports into the merge request.
order: 1
---

# GitLab Pages

GitLab Pages serves whatever a job leaves in `public/`. The configuration below works
without editing, at any project path, because `base: "auto"` means the output does not
need to know where it will be served from.

## The pipeline

```yaml
image: node:20-alpine

pages:
  stage: deploy
  script:
    - npx md2spa build --out public
  artifacts:
    paths:
      - public
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

lint:
  stage: test
  script:
    - npx md2spa check --format junit > report.xml
  artifacts:
    when: always
    reports:
      junit: report.xml
```

Two jobs, no cache configuration, no install step. There is nothing to install: md2spa
has no dependencies, so `npx` fetches one tarball and runs it.

The published site lands at `https://<namespace>.gitlab.io/<project>/`, or at your custom
domain if you have configured one. Neither URL appears anywhere in the config, and moving
between them needs no rebuild.

## Why there is no install job

A typical Pages pipeline runs `npm ci` and caches `node_modules`. Both steps exist to
manage a dependency tree. With no dependencies:

- No `npm ci`. The `npx` invocation is the install.
- No cache keys to invalidate, and no cache that can go stale and poison a build.
- No lockfile to conflict in a merge request.
- No audit failures from a transitive package you have never heard of.

If you prefer a pinned version, add md2spa as a dev dependency and call it directly:

```yaml
pages:
  stage: deploy
  script:
    - npm ci
    - npx md2spa build --out public
  artifacts:
    paths:
      - public
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

## The lint job

`md2spa check --format junit` writes JUnit XML, which GitLab renders as a test report on
the merge request. Each diagnostic becomes a test case, so a reviewer sees "3 broken
links" without opening the job log.

Add `--strict` once the tree is clean, to keep it that way:

```yaml
lint:
  stage: test
  script:
    - npx md2spa check --strict --format junit > report.xml
  artifacts:
    when: always
    reports:
      junit: report.xml
```

`when: always` matters. Without it the artifact is dropped when the job fails, which is
exactly the run whose report you wanted.

> [!IMPORTANT]
> `md2spa check` exits non-zero when it finds errors, and a non-zero exit fails the job
> before the artifact is uploaded — unless `when: always` is set. Set it.

## Merge request previews

GitLab can publish a preview per merge request. The site path changes on every branch,
which is precisely the case `base: "auto"` was built for.

```yaml
preview:
  stage: deploy
  script:
    - npx md2spa build --out public
  artifacts:
    paths:
      - public
  environment:
    name: preview/$CI_COMMIT_REF_SLUG
    url: $CI_PAGES_URL
  rules:
    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'
```

No `--base` flag, no environment-specific config file. The same command produces output
that is correct at both the preview path and the production path.

## Setting siteUrl

`siteUrl` is the one value that has to know where the site lives, because canonical links
and sitemap entries are absolute by definition. GitLab exports it:

```yaml
pages:
  script:
    - npx md2spa build --out public
  variables:
    MD2SPA_SITE_URL: $CI_PAGES_URL
```

Read it from a JavaScript config:

```js
export default {
  title: 'Handbook',
  siteUrl: process.env.MD2SPA_SITE_URL || '',
};
```

Leaving `siteUrl` empty is fine. You lose canonical tags, absolute sitemap URLs and Open
Graph URLs; everything else is unaffected.

## Custom domains

Add the domain in **Settings → Pages**, add the DNS records GitLab shows you, and let it
provision a certificate. Nothing in the build changes. If you set `siteUrl`, update it to
the custom domain so canonical links point at the URL you want indexed.

## Troubleshooting

| Symptom | Cause | Fix |
|:---|:---|:---|
| 404 on every page | The job did not put files in `public/` | The output directory must be `public`. Use `--out public` |
| CSS and JS 404, HTML loads | Assets are being requested from the wrong path | Check that `base` is `"auto"` or matches the deployed path exactly |
| Pipeline green, site not updated | The `pages` job did not run on the default branch | Check the `rules:` clause and the branch name |
| Links work, deep reloads 404 | Directory indexes are not being served | Keep `cleanUrls: true`; GitLab Pages serves `index.html` from a directory |
| Job fails with no diagnostics printed | An error-severity finding with `--quiet` | Drop `--quiet`, or run `md2spa check` to see the findings |

More detail on the path question is in [Base paths](advanced/base-paths.md).
