// The J-check identity: the verifier's favicon is served from its own origin (img-src stays 'self' only), and
// every brand image the README and the agent registration point to exists in the repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('the verifier shows the J-check favicon from its own origin, and img-src allows nothing else', () => {
  const html = read('web/index.html');
  assert.match(html, /<link rel="icon" href="favicon\.svg" type="image\/svg\+xml">/);
  assert.ok(existsSync(new URL('web/favicon.svg', root)), 'web/favicon.svg is published with the page');
  assert.match(read('web/favicon.svg'), /M12 28L20\.5 36\.5L33 24V8\.5M22 8\.5H35\.5/, 'the favicon is the J-check');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  const img = csp.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === 'img-src');
  assert.deepEqual(img && img.slice(1), ["'self'"]);
});

test('every brand image the README and the agent registration use exists', () => {
  const readme = read('README.md');
  const imgs = [...readme.matchAll(/(?:src|srcset)="(docs\/brand\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(imgs.length >= 2, 'the README header shows the mark for light and dark themes');
  for (const p of imgs) assert.ok(existsSync(new URL(p, root)), `${p} exists`);
  const reg = JSON.parse(read('docs/agent-registration.json'));
  const path = reg.image.replace('https://raw.githubusercontent.com/vijaygopalbalasa/judge-protocol/master/', '');
  assert.ok(existsSync(new URL(path, root)), `${path} exists`);
});
