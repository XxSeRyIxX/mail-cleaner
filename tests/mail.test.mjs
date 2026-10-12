import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chunks, mailPage, parseUnsubscribe } from '../app/mail.js';

const policyOf = page => page.match(/Content-Security-Policy" content="([^"]+)"/)[1];

test('unsubscribe headers give the web link, the address and one-click support', () => {
  const info = parseUnsubscribe('<mailto:leave@example.com?subject=stop>, <http://example.com/u>, <https://example.com/u?id=1>',
    'List-Unsubscribe=One-Click');
  assert.equal(info.url, 'https://example.com/u?id=1');
  assert.equal(info.mailto, 'mailto:leave@example.com?subject=stop');
  assert.equal(info.oneClick, true);
  assert.equal(parseUnsubscribe('<http://example.com/u>', 'List-Unsubscribe=One-Click').oneClick, false, 'One click needs https.');
  assert.deepEqual(parseUnsubscribe('not a link'), { url: null, mailto: null, oneClick: false, preview: '' });
});

test('a mail page blocks scripts, forms and, until allowed, remote images', () => {
  const page = mailPage({ content: '<script>alert(1)</script><img src="https://tracker.example/p.gif">', isHtml: true });
  const policy = policyOf(page);
  assert.match(policy, /^default-src 'none';/);
  assert.doesNotMatch(policy, /script-src/);
  assert.match(policy, /form-action 'none'/);
  assert.match(policy, /img-src data:;/);
  assert.match(policyOf(mailPage({ content: 'x', isHtml: true }, true)), /img-src data: https: http:;/);
});

test('with the relay only the relay may run, never the mail\'s own scripts', () => {
  const page = mailPage({ content: '<script>alert(1)</script><a href="https://example.com/">x</a>', isHtml: true }, false, true);
  const relay = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const hash = `'sha256-${createHash('sha256').update(relay, 'utf8').digest('base64')}'`;
  assert.match(policyOf(page), new RegExp(`script-src ${hash.replace(/[+/]/g, '\\$&')};`));
  assert.ok(readFileSync(new URL('../app/index.html', import.meta.url), 'utf8').includes(hash),
    'index.html must allow the relay by the same hash: mail frames inherit the page\'s policy.');
  assert.match(page, /<script>alert\(1\)<\/script>/, 'The mail\'s script stays, and no policy allows it.');
});

test('index.html allows each of its inline scripts by hash', () => {
  const page = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length, 'index.html should have its desktop marker.');
  for (const code of scripts) {
    const hash = `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`;
    assert.ok(policyOf(page).includes(hash), `index.html's policy must allow "${code.slice(0, 40)}..." with ${hash}.`);
  }
});

test('a mail page drops refresh redirects and escapes plain text', () => {
  const html = mailPage({ content: '<meta content="0;url=https://evil.example/" http-equiv="refresh"><p>Hi</p>', isHtml: true });
  assert.doesNotMatch(html, /refresh/i);
  const text = mailPage({ content: '<b>not bold</b>', isHtml: false });
  assert.match(text, /<pre>&#60;b&#62;not bold&#60;\/b&#62;<\/pre>/);
  assert.match(mailPage({ content: '  ', isHtml: true }), /This mail has no text/);
});

test('chunks splits into slices of at most the given size', () => {
  assert.deepEqual([...chunks([1, 2, 3, 4, 5], 2)], [[1, 2], [3, 4], [5]]);
  assert.deepEqual([...chunks([], 2)], []);
});
