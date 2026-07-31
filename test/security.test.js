/**
 * Adversarial input -- SPEC.md §4b ("Raw-HTML policy") and §11.
 *
 * Markdown in a docs repo is written by many hands and often generated. The contract is:
 *
 *   - nothing executable ever reaches the output, whatever the author typed;
 *   - `<details>/<summary>` and other allowlisted markup still work, because real docs
 *     depend on them;
 *   - angle-bracket placeholders (`<your-volume>`) are escaped **silently**, because
 *     warning about them would drown every real finding.
 *
 * Plus one server-side case: the dev server must refuse to serve files outside `outDir`.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { isSafeUrl } from '../src/util/html.js';
import {
  REPO_ROOT, buildTempSite, cleanupTemps, render, tempDir, writeTree,
} from './helpers/harness.js';

after(cleanupTemps);

/**
 * The `<article class="md">…</article>` region of a full document, or the whole string
 * when it is already a fragment. Head-level `<script>`/`<style>` from the theme bootstrap
 * are legitimate, so the adversarial checks are scoped to the content area.
 *
 * @param {string} html
 * @returns {string}
 */
function articleOf(html) {
  const start = html.indexOf('<article class="md"');
  if (start < 0) return html;
  const end = html.indexOf('</article>', start);
  return html.slice(start, end < 0 ? html.length : end + '</article>'.length);
}

/**
 * Every *live* tag in a fragment -- escaped text such as `&lt;svg onload=…&gt;` is inert
 * and correct output, so the checks below must look at real markup only.
 *
 * @param {string} html
 * @returns {string[]}
 */
function liveTags(html) {
  return [...html.matchAll(/<\/?[a-zA-Z][^>]*>/g)].map((m) => m[0]);
}

/**
 * Lowercased element names of every live tag.
 * @param {string} html
 * @returns {string[]}
 */
function liveTagNames(html) {
  return liveTags(html)
    .map((tag) => (/^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag) || [])[1])
    .filter(Boolean)
    .map((name) => name.toLowerCase());
}

/**
 * @typedef {Object} AttackCase
 * @property {string} name
 * @property {string} markdown
 * @property {string[]} [forbiddenTags] element names that must not appear as live markup
 * @property {RegExp[]} [forbiddenAttrs] attribute patterns that must not appear on any live tag
 * @property {boolean} expectDiagnostic whether MD052 must be reported
 */

/** Any inline event handler, on any element. */
const EVENT_HANDLER = /\son[a-z]+\s*=/i;

/** @type {AttackCase[]} */
const ATTACKS = [
  {
    name: '<script> block',
    markdown: '# T\n\n<script>alert(1)</script>\n',
    forbiddenTags: ['script'],
    expectDiagnostic: true,
  },
  {
    name: '<script> inline in a paragraph',
    markdown: '# T\n\nText <script>alert(1)</script> more text.\n',
    forbiddenTags: ['script'],
    expectDiagnostic: true,
  },
  {
    name: 'img with an onerror handler',
    markdown: '# T\n\n<img src="x" onerror="alert(1)">\n',
    forbiddenAttrs: [EVENT_HANDLER],
    expectDiagnostic: true,
  },
  {
    name: 'div with an onclick handler',
    markdown: '# T\n\n<div onclick="steal()">Click</div>\n',
    forbiddenAttrs: [EVENT_HANDLER],
    expectDiagnostic: true,
  },
  {
    name: 'anchor with an onmouseover handler',
    markdown: '# T\n\n<a href="https://example.com/" onmouseover="x()">hover</a>\n',
    forbiddenAttrs: [EVENT_HANDLER],
    expectDiagnostic: true,
  },
  {
    name: '<iframe>',
    markdown: '# T\n\n<iframe src="https://evil.example/"></iframe>\n',
    forbiddenTags: ['iframe'],
    expectDiagnostic: true,
  },
  {
    name: '<style>',
    markdown: '# T\n\n<style>body { display: none }</style>\n',
    forbiddenTags: ['style'],
    expectDiagnostic: true,
  },
  {
    name: '<svg onload=>',
    markdown: '# T\n\n<svg onload="alert(1)"><circle r="1"></circle></svg>\n',
    forbiddenTags: ['svg', 'circle'],
    forbiddenAttrs: [EVENT_HANDLER],
    expectDiagnostic: true,
  },
  {
    name: '<object> / <embed>',
    markdown: '# T\n\n<object data="evil.swf"></object>\n\n<embed src="evil.swf">\n',
    forbiddenTags: ['object', 'embed'],
    expectDiagnostic: true,
  },
  {
    name: '<form> and <input>',
    markdown: '# T\n\n<form action="https://evil.example/"><input name="password"></form>\n',
    forbiddenTags: ['form', 'input'],
    expectDiagnostic: true,
  },
  {
    name: '<meta http-equiv refresh>',
    markdown: '# T\n\n<meta http-equiv="refresh" content="0;url=https://evil.example/">\n',
    forbiddenTags: ['meta'],
    forbiddenAttrs: [/\shttp-equiv\s*=/i],
    expectDiagnostic: true,
  },
  {
    name: '<base href>',
    markdown: '# T\n\n<base href="https://evil.example/">\n',
    forbiddenTags: ['base'],
    expectDiagnostic: true,
  },
  {
    name: 'style attribute',
    markdown: '# T\n\n<span style="position:fixed;inset:0">overlay</span>\n',
    forbiddenAttrs: [/\sstyle\s*=/i],
    expectDiagnostic: true,
  },
];

for (const attack of ATTACKS) {
  test(`renderer neutralises: ${attack.name}`, async () => {
    const { html, codes } = await render(attack.markdown);
    const names = liveTagNames(html);
    for (const tag of attack.forbiddenTags || []) {
      assert.ok(
        !names.includes(tag),
        `live <${tag}> survived into:\n${html}`,
      );
    }
    for (const pattern of attack.forbiddenAttrs || []) {
      for (const tag of liveTags(html)) {
        assert.ok(!pattern.test(tag), `${String(pattern)} survived on ${tag}\nin:\n${html}`);
      }
    }
    if (attack.expectDiagnostic) {
      assert.ok(
        codes.includes('MD052'),
        `no MD052 for ${attack.name}; got ${codes.join(', ') || '(none)'}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Dangerous URLs
// ---------------------------------------------------------------------------

const BAD_URLS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'data:image/svg+xml,<svg onload="alert(1)"/>',
  'vbscript:msgbox(1)',
];

for (const url of BAD_URLS) {
  test(`link destination is rejected: ${url.slice(0, 40)}`, async () => {
    const { html } = await render(`# T\n\n[click](${url})\n`);
    const article = articleOf(html);
    assert.ok(!/href="javascript:/i.test(article), `javascript: href survived:\n${article}`);
    assert.ok(!/href="vbscript:/i.test(article), `vbscript: href survived:\n${article}`);
    assert.ok(!/href="data:text\/html/i.test(article), `data:text/html href survived:\n${article}`);
    assert.ok(!/href="data:image\/svg/i.test(article), `data:image/svg href survived:\n${article}`);
  });

  test(`image source is rejected: ${url.slice(0, 40)}`, async () => {
    const { html } = await render(`# T\n\n![x](${url})\n`);
    const article = articleOf(html);
    assert.ok(!/src="javascript:/i.test(article));
    assert.ok(!/src="vbscript:/i.test(article));
    assert.ok(!/src="data:text\/html/i.test(article));
    assert.ok(!/src="data:image\/svg/i.test(article));
  });
}

test('raw HTML anchors with dangerous hrefs lose the href and report MD052', async () => {
  const { html, codes } = await render('# T\n\n<a href="javascript:alert(1)">click</a>\n');
  assert.ok(!/javascript:/i.test(articleOf(html)));
  assert.ok(codes.includes('MD052'));
});

test('isSafeUrl rejects control-character scheme obfuscation', () => {
  assert.equal(isSafeUrl('java\tscript:alert(1)'), false);
  assert.equal(isSafeUrl('java\nscript:alert(1)'), false);
  assert.equal(isSafeUrl(' javascript:alert(1)'), false);
  assert.equal(isSafeUrl('https://example.com/'), true);
  assert.equal(isSafeUrl('mailto:a@b.co'), true);
  assert.equal(isSafeUrl('../guide/'), true);
  assert.equal(isSafeUrl('data:image/png;base64,AAAA'), true);
});

// This one is a deliberate stretch: SPEC §4b says a `javascript:` URL is *always* stripped,
// and a browser decodes character references inside an attribute value before parsing the
// scheme. So `java&#9;script:` is a javascript: URL and must not survive.
test('entity-encoded scheme obfuscation does not survive', async () => {
  const { html } = await render('# T\n\n<a href="java&#9;script:alert(1)">click</a>\n');
  const article = articleOf(html);
  assert.ok(
    !/href="java&#9;script:/i.test(article) && !/href="java&#x9;script:/i.test(article),
    `entity-encoded javascript: URL survived:\n${article}`,
  );
});

// ---------------------------------------------------------------------------
// What must NOT be flagged, and what must survive
// ---------------------------------------------------------------------------

test('unknown element names are escaped silently -- no diagnostic', async () => {
  const source = [
    '# T', '',
    'Write the image to `<your-volume>` and wait <num> seconds.', '',
    'The manifest uses <key>CFBundleName</key> and <VDM> blocks.', '',
  ].join('\n');
  const { html, codes } = await render(source);
  assert.match(html, /&lt;your-volume&gt;/);
  assert.match(html, /&lt;num&gt;/);
  assert.match(html, /&lt;key&gt;CFBundleName&lt;\/key&gt;/);
  assert.match(html, /&lt;VDM&gt;/);
  assert.deepEqual(
    codes.filter((c) => c === 'MD052'),
    [],
    'placeholders must never produce MD052 -- that would make the linter useless',
  );
});

test('<details>/<summary> survive intact', async () => {
  const { html, codes } = await render(
    '# T\n\n<details>\n<summary>Show the log</summary>\n\nHidden body.\n\n</details>\n',
  );
  assert.match(html, /<details>/);
  assert.match(html, /<summary>Show the log<\/summary>/);
  assert.match(html, /<\/details>/);
  assert.ok(!codes.includes('MD052'), 'allowlisted markup must not be reported');
});

test('safe attributes on allowlisted tags are preserved', async () => {
  const { html } = await render(
    '# T\n\n<img src="https://example.com/a.png" alt="A" width="10" height="10">\n',
  );
  assert.match(html, /src="https:\/\/example\.com\/a\.png"/);
  assert.match(html, /alt="A"/);
  assert.match(html, /width="10"/);
});

test('code fences never execute -- their contents are escaped', async () => {
  const { html } = await render(
    '# T\n\n```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```\n',
  );
  const article = articleOf(html);
  // The highlighter wraps tokens in <span class="tok …">, so the check is on live markup:
  // no script/img element and no event handler may exist inside the rendered fence.
  const names = liveTagNames(article);
  assert.ok(!names.includes('script'), 'a script tag escaped a code fence');
  assert.ok(!names.includes('img'), 'an img tag escaped a code fence');
  for (const tag of liveTags(article)) {
    assert.ok(!EVENT_HANDLER.test(tag), `an event handler escaped a code fence: ${tag}`);
  }
  assert.match(article, /&lt;/);
});

// ---------------------------------------------------------------------------
// Nothing dangerous survives a full build
// ---------------------------------------------------------------------------

test('a hostile document produces a clean built page and a clean SPA payload', async () => {
  const hostile = [
    '---', 'title: Hostile', '---', '',
    '# Hostile', '',
    '<script>alert(1)</script>', '',
    '<img src="x" onerror="alert(1)">', '',
    '<iframe src="https://evil.example/"></iframe>', '',
    '<style>body{display:none}</style>', '',
    '<svg onload="alert(1)"></svg>', '',
    '[a](javascript:alert(1))', '',
    '[b](data:text/html,<script>alert(1)</script>)', '',
    '<a href="#" onmouseover="steal()">c</a>', '',
  ].join('\n');

  const site = await buildTempSite({
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\nWelcome.\n',
    'content/hostile.md': hostile,
  });

  const article = articleOf(site.read('hostile/index.html'));
  const payload = JSON.parse(site.read('_spa/hostile/index.json'));

  for (const region of [article, payload.html]) {
    const names = liveTagNames(region);
    for (const forbidden of ['script', 'iframe', 'style', 'svg', 'object', 'embed', 'form']) {
      assert.ok(!names.includes(forbidden), `<${forbidden}> reached the output`);
    }
    for (const tag of liveTags(region)) {
      assert.ok(!EVENT_HANDLER.test(tag), `an event handler reached the output: ${tag}`);
      assert.ok(!/javascript:/i.test(tag), `a javascript: URL reached the output: ${tag}`);
      assert.ok(!/data:text\/html/i.test(tag), `a data:text/html URL reached the output: ${tag}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Dev server: path traversal
// ---------------------------------------------------------------------------

/** @returns {Promise<number>} an unused TCP port */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Wait until something accepts TCP connections on `port`.
 * `stop()` short-circuits the wait when the child process has already died, so a dev
 * server that cannot start fails the test immediately instead of burning the timeout.
 *
 * @param {number} port
 * @param {number} timeoutMs
 * @param {() => boolean} [stop]
 * @returns {Promise<boolean>}
 */
async function waitForPort(port, timeoutMs, stop = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stop()) {
    const up = await new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.setTimeout(500);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (up) return true;
    await new Promise((r) => { setTimeout(r, 100); });
  }
  return false;
}

/**
 * Send a raw HTTP request so the literal request target survives -- `fetch` and
 * `http.request` both normalise `..` away before it reaches the server.
 *
 * @param {number} port
 * @param {string} target the request target, used verbatim
 * @returns {Promise<string>} the full response, headers included
 */
function rawRequest(port, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 5000);
    socket.on('connect', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
    socket.on('close', () => { clearTimeout(timer); resolve(data); });
  });
}

test('the dev server refuses to serve files outside outDir', async (t) => {
  const cwd = tempDir('md2spa-dev-');
  writeTree(cwd, {
    'md2spa.config.json': JSON.stringify({ title: 'Dev Site', contentDir: 'content', outDir: 'dist' }),
    'content/index.md': '---\ntitle: Home\n---\n\n# Home\n\nWelcome.\n',
    'secret.txt': 'TOP-SECRET-MD2SPA-SENTINEL\n',
  });

  const port = await freePort();
  const child = spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'src', 'cli.js'), 'dev', '--port', String(port), '--host', '127.0.0.1'],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  let exited = false;
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  child.stdout.on('data', () => {});
  child.on('exit', () => { exited = true; });
  child.on('error', (err) => { exited = true; stderr += String(err && err.message); });
  t.after(() => { child.kill('SIGKILL'); });

  const up = await waitForPort(port, 20000, () => exited);
  assert.ok(up, `the dev server never listened on ${port}. stderr:\n${stderr}`);

  // Control: a normal request must work, otherwise the traversal result means nothing.
  const ok = await rawRequest(port, '/');
  assert.match(ok, /^HTTP\/1\.1 200/, `GET / did not return 200:\n${ok.slice(0, 400)}`);

  const traversals = [
    '/../secret.txt',
    '/../../secret.txt',
    '/./../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/assets/../../secret.txt',
  ];
  for (const target of traversals) {
    const response = await rawRequest(port, target);
    assert.ok(
      !response.includes('TOP-SECRET-MD2SPA-SENTINEL'),
      `path traversal succeeded for ${target}`,
    );
    assert.match(
      response,
      /^HTTP\/1\.1 (400|403|404)/,
      `${target} should be rejected, got:\n${response.slice(0, 200)}`,
    );
  }
});
