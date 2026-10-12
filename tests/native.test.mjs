import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridge } from '../app/native.js';

function connection(failSend = () => false) {
  let receive;
  const sent = [];
  const ask = createBridge({
    receiveMessage: callback => { receive = callback; },
    sendMessage: raw => {
      if (failSend()) throw new Error('send failed');
      sent.push(JSON.parse(raw));
    },
  });
  return { ask, sent, reply: message => receive(JSON.stringify(message)), raw: text => receive(text) };
}

test('replies settle their own requests, in any order', async () => {
  const shell = connection();
  const first = shell.ask('imap.folders');
  const second = shell.ask('imap.body', { id: 'x' });
  assert.deepEqual(shell.sent.map(m => [m.cmd, m.args]), [['imap.folders', {}], ['imap.body', { id: 'x' }]]);
  assert.notEqual(shell.sent[0].id, shell.sent[1].id);
  shell.reply({ id: shell.sent[1].id, ok: true, data: { content: 'second' } });
  shell.reply({ id: shell.sent[0].id, ok: true, data: { folders: [] } });
  assert.deepEqual(await second, { content: 'second' });
  assert.deepEqual(await first, { folders: [] });
});

test('errors keep their status, so 401 can mean signed out', async () => {
  const shell = connection();
  const request = shell.ask('imap.uids', { folder: 'INBOX' });
  shell.reply({ id: shell.sent[0].id, ok: false, status: 401, error: 'Please sign in again.' });
  await assert.rejects(request, e => e.status === 401 && e.message === 'Please sign in again.');
});

test('stopping a request rejects it as aborted and asks the shell to cancel it', async () => {
  const shell = connection();
  const stop = new AbortController();
  const request = shell.ask('imap.fetch', { folder: 'INBOX' }, stop.signal);
  stop.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.deepEqual(shell.sent[1], { id: shell.sent[1].id, cmd: 'cancel', args: { id: shell.sent[0].id } });
  shell.reply({ id: shell.sent[0].id, ok: true, data: 'too late' });

  const stopped = AbortSignal.abort();
  await assert.rejects(shell.ask('imap.state', {}, stopped), { name: 'AbortError' });
  assert.equal(shell.sent.length, 2, 'An already stopped request is never sent.');
});

test('failed sends, malformed replies and unknown ids leave the bridge usable', async () => {
  let failing = true;
  const shell = connection(() => failing);
  await assert.rejects(shell.ask('open', { url: 'https://example.com/' }), /send failed/);
  failing = false;
  const next = shell.ask('imap.state');
  shell.raw('not json');
  shell.reply({ id: 'another-page-1', ok: true, data: 'not for us' });
  shell.reply({ id: shell.sent[0].id, ok: true });
  assert.equal(await next, null);
});

test('each page load uses its own ids, so a reloaded page ignores old replies', () => {
  const before = connection();
  const after = connection();
  before.ask('imap.state');
  after.ask('imap.state');
  assert.notEqual(before.sent[0].id, after.sent[0].id);
});
