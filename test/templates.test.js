/**
 * The deployment templates are only useful if the commands inside them actually run.
 * These tests install each template into a temporary "fork" and assert the shape, then
 * execute the exact commands the CI files invoke.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { REPO_ROOT, cleanupTemps, listFiles, tempDir, writeTree } from './helpers/harness.js';

after(cleanupTemps);

const CLI = path.join(REPO_ROOT, 'src', 'cli.js');
const TEMPLATES = path.join(REPO_ROOT, 'templates');

/** A minimal repo laid out the way a fork of md2spa is: the tool in src/, docs in content/. */
function makeFork() {
  const cwd = tempDir('md2spa-fork-');
  writeTree(cwd, {
    'content/index.md': '---\ntitle: My Docs\n---\n\n# My Docs\n\nHello.\n',
    'md2spa.config.json': '{ "title": "My Docs" }\n',
  });
  fs.mkdirSync(path.join(cwd, 'static'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'src'), path.join(cwd, 'src'), { recursive: true });
  fs.cpSync(TEMPLATES, path.join(cwd, 'templates'), { recursive: true });
  return cwd;
}

/** @returns {{ status: number, stdout: string }} */
function run(cwd, args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status ?? 1, stdout: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

test('every template directory is non-empty and ships only text files', () => {
  const targets = fs.readdirSync(TEMPLATES, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  assert.deepEqual(targets.sort(), ['github', 'gitlab', 'server']);

  for (const target of targets) {
    const files = listFiles(path.join(TEMPLATES, target));
    assert.ok(files.length > 0, `template ${target} is empty`);
  }
});

test('`template` with no argument lists the targets and exits 0', () => {
  const cwd = makeFork();
  const { status, stdout } = run(cwd, ['template']);
  assert.equal(status, 0);
  for (const name of ['gitlab', 'github', 'server']) {
    assert.match(stdout, new RegExp(name), `${name} missing from the listing`);
  }
});

test('an unknown target is a usage error, not a crash', () => {
  const cwd = makeFork();
  const { status, stdout } = run(cwd, ['template', 'heroku']);
  assert.equal(status, 2, 'expected exit code 2 (bad usage)');
  assert.match(stdout, /unknown target/);
});

test('templates never overwrite an existing file unless --force is given', () => {
  const cwd = makeFork();
  const target = path.join(cwd, '.gitlab-ci.yml');
  fs.writeFileSync(target, '# hand-written, do not clobber\n');

  run(cwd, ['template', 'gitlab']);
  assert.match(fs.readFileSync(target, 'utf8'), /hand-written/,
    'an existing file was overwritten without --force');

  run(cwd, ['template', 'gitlab', '--force']);
  assert.match(fs.readFileSync(target, 'utf8'), /GitLab Pages/,
    '--force did not overwrite');
});

test('gitlab: the pipeline commands run and produce public/', () => {
  const cwd = makeFork();
  assert.equal(run(cwd, ['template', 'gitlab']).status, 0);

  const ci = fs.readFileSync(path.join(cwd, '.gitlab-ci.yml'), 'utf8');
  // GitLab publishes the `public` directory and nothing else.
  assert.match(ci, /--out public/, 'the pages job must build into public/');
  assert.match(ci, /paths: \[public\]/);
  assert.match(ci, /junit: report\.xml/, 'the lint job should publish a JUnit report');
  // Check the executable lines, not the prose: the comments legitimately mention
  // `npm install` while explaining why there isn't one.
  const ciScript = ci.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(ciScript, /npm (ci|install)/, 'the fork layout needs no install step');

  // The exact commands from the file.
  assert.equal(run(cwd, ['check', '--format', 'junit']).status, 0);
  assert.equal(run(cwd, ['build', '--out', 'public']).status, 0);
  assert.ok(fs.existsSync(path.join(cwd, 'public', 'index.html')));
  assert.ok(fs.existsSync(path.join(cwd, 'public', '404.html')));
});

test('github: the workflow commands run, and .nojekyll reaches the site root', () => {
  const cwd = makeFork();
  assert.equal(run(cwd, ['template', 'github']).status, 0);

  const wf = fs.readFileSync(path.join(cwd, '.github/workflows/pages.yml'), 'utf8');
  assert.match(wf, /--format github/, 'lint should emit workflow annotations');
  assert.match(wf, /--out dist/);
  assert.match(wf, /pages: write/);
  assert.match(wf, /id-token: write/);

  // Jekyll drops underscore-prefixed directories, which would silently break every
  // _spa/ payload. The marker file must survive the static copy into the output.
  assert.ok(fs.existsSync(path.join(cwd, 'static', '.nojekyll')), 'template omitted .nojekyll');
  assert.equal(run(cwd, ['build', '--out', 'dist']).status, 0);
  assert.ok(fs.existsSync(path.join(cwd, 'dist', '.nojekyll')),
    '.nojekyll did not reach the built site, so Jekyll would strip _spa/');
  assert.ok(fs.existsSync(path.join(cwd, 'dist', '_spa')));
});

test('server: the Dockerfile build step runs and the nginx config matches the output', () => {
  const cwd = makeFork();
  assert.equal(run(cwd, ['template', 'server']).status, 0);

  for (const f of ['Dockerfile', 'nginx.conf', 'docker-compose.yml', '.dockerignore']) {
    assert.ok(fs.existsSync(path.join(cwd, f)), `missing ${f}`);
  }

  const dockerfile = fs.readFileSync(path.join(cwd, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /AS build/);
  assert.match(dockerfile, /FROM nginx:alpine/);
  const buildCmd = /RUN node src\/cli\.js build --out (\S+)( --strict)?/.exec(dockerfile);
  assert.ok(buildCmd, 'could not find the build step in the Dockerfile');
  assert.match(dockerfile, new RegExp(`COPY --from=build ${buildCmd[1]} /usr/share/nginx/html`),
    'the serve stage must copy from the path the build stage wrote to');

  // The build stage's own command, run for real.
  const out = path.join(cwd, 'site');
  assert.equal(run(cwd, ['build', '--out', out, '--strict']).status, 0);

  // The nginx config makes two claims about the output; check both against reality.
  const conf = fs.readFileSync(path.join(cwd, 'nginx.conf'), 'utf8');
  assert.ok(fs.existsSync(path.join(out, '404.html')), 'error_page target is missing');
  assert.match(conf, /error_page 404 \/404\.html/);

  const immutable = /\.[0-9a-f]{8}\.(css|js)$/;
  const assets = fs.readdirSync(path.join(out, 'assets'));
  assert.ok(assets.length > 0);
  for (const asset of assets) {
    assert.match(asset, immutable,
      `${asset} does not match the immutable-cache location block in nginx.conf`);
  }
});

test('the .dockerignore does not exclude anything the build needs', () => {
  const cwd = makeFork();
  run(cwd, ['template', 'server']);
  const ignored = fs.readFileSync(path.join(cwd, '.dockerignore'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  // COPY . . then `node src/cli.js build`, then stage 2 does COPY nginx.conf.
  for (const needed of ['src', 'content', 'static', 'md2spa.config.json', 'nginx.conf']) {
    assert.ok(!ignored.includes(needed), `.dockerignore excludes ${needed}, which the build needs`);
  }
});
