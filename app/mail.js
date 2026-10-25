// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

// What every mail service shares: jobs, pacing and retries, mail header parsing, the scanned mailbox and the
// cleanup steps. No DOM here; the services live in outlook.js, gmail.js and imap.js.

import { fmt, t, tn, noun } from './i18n.js';

export { fmt };
/** "3 mails", in the interface language: `key` names the word in i18n.js. */
export const plural = (n, key) => `${fmt(n)} ${noun(key, n)}`;
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** Consecutive slices of at most `size` items. */
export function* chunks(items, size) {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** JSON values in localStorage or sessionStorage, under the app's prefix. */
export function storage(area, prefix = 'oc.') {
  return {
    get(key, fallback = null) {
      try {
        return JSON.parse(area.getItem(prefix + key)) ?? fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      area.setItem(prefix + key, JSON.stringify(value));
    },
    remove(key) {
      area.removeItem(prefix + key);
    },
  };
}

// ---------- Errors ----------

/** An error answer from a mail service, with its HTTP status when there is one. */
export class ServiceError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/** The sign-in expired or was refused: the user has to sign in again. */
export class SignedOut extends Error {
  constructor(message = t('signedOut')) {
    super(message);
  }
}

export const isAbort = e => e?.name === 'AbortError';

// ---------- Waiting and pacing ----------

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Waits, and tells the user why when a job is running. `reason` names the text in i18n.js; anything but a connection
 * problem is the service asking the app to slow down, which the page explains.
 */
export async function pause(ms, reason, job, signal = job?.signal) {
  if (!job) return sleep(ms, signal);
  job.note = t('wait.note', t(reason), Math.max(1, Math.ceil(ms / 1000)));
  job.throttled = reason !== 'wait.connection';
  try {
    await sleep(ms, signal);
  } finally {
    job.note = '';
    job.throttled = false;
  }
}

export const backoff = attempt => (Math.min(60, 2 ** attempt) + Math.random()) * 1000;

/** Runs `work` on every item, at most `limit` at a time. The first error stops it, once the running ones finish. */
export async function pool(items, limit, work, signal) {
  let next = 0;
  let error = null;
  const worker = async () => {
    while (!error && next < items.length) {
      const item = items[next++];
      try {
        signal?.throwIfAborted();
        await work(item);
      } catch (e) {
        error ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (error) throw error;
}

/** Spends quota units at a steady rate: `rate` a second, in bursts of up to `burst`. First come, first served. */
export class Pacer {
  constructor(rate, burst) {
    Object.assign(this, { rate, burst, tokens: burst, at: performance.now(), queue: Promise.resolve() });
  }

  take(cost, signal) {
    const turn = this.queue.then(async () => {
      for (;;) {
        const now = performance.now();
        this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
        this.at = now;
        if (this.tokens >= cost) {
          this.tokens -= cost;
          return;
        }
        await sleep(((cost - this.tokens) / this.rate) * 1000, signal);
      }
    });
    this.queue = turn.catch(() => {});
    return turn;
  }
}

// ---------- REST APIs ----------

const MAX_ATTEMPTS = 8;
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
export const isTransient = status => TRANSIENT.has(status);

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/** Retry-After in ms, when the service shares it (browsers only see it when the service allows that). */
function retryAfter(res) {
  const value = res.headers.get('Retry-After');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * A JSON REST API called with the user's access token. It waits and retries when the service asks it to slow down
 * or has a hiccup, and asks for a fresh token once when the service says the token expired.
 * Options: base, name, token(force), slow and busy (the i18n.js names of what to tell the user while waiting),
 * throttled(status, data) for services that don't use 429, and before(cost, signal) to pace requests.
 */
export class RestClient {
  constructor(options) {
    Object.assign(this, options);
  }

  get(path, options) {
    return this.send('GET', path, options);
  }

  async send(method, path, { body, headers, job, signal = job?.signal, cost = 1 } = {}) {
    const url = path.startsWith('https://') ? path : this.base + path;
    let renewed = false;
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      if (this.before) await this.before(cost, signal);
      const token = await this.token();
      let res;
      let data;
      try {
        res = await fetch(url, {
          method,
          signal,
          headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        data = parseJson(await res.text());
      } catch (e) {
        if (signal?.aborted) throw e;
        if (attempt >= MAX_ATTEMPTS) throw new ServiceError(t('net.unreachable', this.name));
        await pause(backoff(attempt), 'wait.connection', job, signal);
        continue;
      }
      if (res.ok) return data;
      if (res.status === 401) {
        if (renewed) throw new SignedOut();
        renewed = true;
        attempt--;
        await this.token(true);
        continue;
      }
      const throttled = res.status === 429 || Boolean(this.throttled?.(res.status, data));
      if ((throttled || isTransient(res.status)) && attempt < MAX_ATTEMPTS) {
        await pause(retryAfter(res) ?? backoff(attempt), throttled ? this.slow : this.busy, job, signal);
        continue;
      }
      throw new ServiceError(`${this.name}: ${data?.error?.message || t('net.answered', res.status)}`, res.status);
    }
  }
}

// ---------- Mail headers ----------

/** RFC 2369 List-Unsubscribe and RFC 8058 List-Unsubscribe-Post, plus a text preview of the mail. */
export function parseUnsubscribe(list = '', post = '', preview = '') {
  let https = null;
  let http = null;
  let mailto = null;
  for (const [, inside] of String(list).matchAll(/<([^>]+)>/g)) {
    const candidate = inside.replace(/\s+/g, '');
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol === 'https:') https ??= url.href;
    else if (url.protocol === 'http:') http ??= url.href;
    else if (url.protocol === 'mailto:') mailto ??= candidate;
  }
  return { url: https ?? http, mailto, oneClick: Boolean(https) && /List-Unsubscribe=One-Click/i.test(post), preview: String(preview).trim() };
}

/** Base64 or base64url into bytes. */
export function base64Bytes(data) {
  const s = String(data).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
}

/** Text in a mail's charset (windows-1252, iso-8859-15...), falling back to UTF-8. */
export function decodeText(bytes, charset = 'utf-8') {
  try {
    return new TextDecoder(charset.trim().replace(/^"|"$/g, '') || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function quotedPrintable(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const hex = text[i] === '=' ? text.slice(i + 1, i + 3) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

// Adjacent encoded words are joined without the whitespace between them (RFC 2047 section 6.2).
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=(?:\s+(?==\?))?/g;

/** Decodes RFC 2047 words such as =?UTF-8?B?SG9sYQ==?=. */
export function decodeWords(value) {
  const text = String(value ?? '');
  if (!text.includes('=?')) return text;
  return text.replace(ENCODED_WORD, (word, charset, encoding, data) => {
    try {
      const bytes = /b/i.test(encoding) ? base64Bytes(data) : quotedPrintable(data.replace(/_/g, ' '));
      return new TextDecoder(charset.split('*')[0]).decode(bytes);
    } catch {
      return word;
    }
  });
}

const unquote = s => s.trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1').trim();

/** "Name <a@b.com>" into { email: 'a@b.com', name: 'Name' }. */
export function parseAddress(header) {
  const text = decodeWords(header).trim();
  const angle = /<([^<>]*@[^<>]*)>/.exec(text);
  if (angle) return { email: angle[1].trim().toLowerCase(), name: unquote(text.slice(0, angle.index)) };
  const comment = /^(\S+@\S+)\s*\((.*)\)$/.exec(text);
  if (comment) return { email: comment[1].toLowerCase(), name: comment[2].trim() };
  return text.includes('@') ? { email: unquote(text).toLowerCase(), name: '' } : { email: '', name: unquote(text) };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** Gmail's snippets come HTML-escaped. */
export function htmlText(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? all;
    const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return all;
    }
  });
}

// ---------- Unsubscribing and showing mail ----------

/** Unsubscribe links come from strangers' mail: never let them reach an IP address or a local network name. */
function isPublicHost(host) {
  if (host.startsWith('[') || /^[\d.]+$/.test(host) || !host.includes('.')) return false;
  return !/(^|\.)(localhost|local|lan|home|internal|intranet|corp|localdomain|home\.arpa)$/i.test(host);
}

/**
 * RFC 8058 one-click unsubscribe: one POST from this browser, without cookies or referrer, only to https on the
 * standard port. The answer is opaque to the page, so a request that reached their server counts as done.
 */
async function oneClick(url, signal) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:' || target.port || target.username || target.password || !isPublicHost(target.hostname)) return false;
  try {
    await fetch(target.href, {
      method: 'POST',
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]),
    });
    return true;
  } catch (e) {
    if (signal?.aborted) throw e;
    return false;
  }
}

const VIEWER_STYLE = 'html{background:#fff;color:#111;color-scheme:light}body{margin:16px;font:14px/1.5 system-ui,sans-serif;' +
  'overflow-wrap:anywhere}img{max-width:100%}pre{white-space:pre-wrap;font:inherit;margin:0}.none{color:#777}';

// For the desktop edition, whose webview can't open a link from the frame in a new window: hands clicked links and
// Escape to the page. Both the page's policy (index.html) and the frame's allow exactly this script, by its hash;
// tests/mail.test.mjs checks that the three agree.
const FRAME_RELAY = "addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('a[href],area[href]');" +
  "if(a){e.preventDefault();parent.postMessage({mailLink:a.href},'*')}});" +
  "addEventListener('keydown',e=>{if(e.key==='Escape')parent.postMessage({mailKey:'Escape'},'*')})";
const FRAME_RELAY_HASH = "'sha256-LWPZg8NMc2iP+skodLnE5gZQXyqTY5T8fFsRHmKO1uI='";

/**
 * A mail as a page for the viewer's sandboxed frame. Its own Content Security Policy blocks scripts and forms and,
 * until the user asks for them, remote images and fonts: they tell the sender you opened the mail. With the relay,
 * only the relay may run; the mail's own scripts still can't.
 */
export function mailPage(body, images = false, relay = false) {
  const remote = images ? ' https: http:' : '';
  const scripts = relay ? ` script-src ${FRAME_RELAY_HASH};` : '';
  const policy = `default-src 'none';${scripts} style-src 'unsafe-inline'; img-src data:${remote}; font-src data:${remote}; base-uri 'none'; form-action 'none'`;
  const head = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<meta name="referrer" content="no-referrer"><base target="_blank"><style>${VIEWER_STYLE}</style>` +
    (relay ? `<script>${FRAME_RELAY}</script>` : '');
  const content = String(body.content ?? '');
  if (!content.trim()) return head + `<p class="none">${t('mail.noText')}</p>`;
  return head + (body.isHtml ? content.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '') : `<pre>${esc(content)}</pre>`);
}

// ---------- Jobs ----------

/** A long operation, followed by the page. Steps reset the progress counter. */
class Job {
  static #lastId = 0;

  constructor(kind, title) {
    Object.assign(this, {
      id: ++Job.#lastId, kind, title, running: true, background: false, preempted: false, reported: false,
      total: 0, done: 0, failed: 0, note: '', result: '', warning: '', error: '', signedOut: false, manual: [],
      startedAt: Date.now(), controller: new AbortController(), finished: Promise.resolve(),
    });
  }

  get signal() {
    return this.controller.signal;
  }

  step(title, total) {
    Object.assign(this, { title, total, done: 0, startedAt: Date.now() });
  }

  add(n) {
    this.done += n;
  }

  fail(reason) {
    this.failed++;
    this.warning ||= reason;
  }

  cancel() {
    this.controller.abort();
  }
}

let current = null;

/** The running job, or the last one. */
export const currentJob = () => current;

/**
 * Runs one job at a time, so the mail service's per-mailbox limits are never shared between operations.
 * A background job (the unsubscribe lookup after a scan) gives way; any other running job is a conflict.
 */
async function startJob(kind, title, work) {
  if (current?.running) {
    if (!current.background) throw new Error(t('job.another'));
    current.preempted = true;
    current.cancel();
    await current.finished;
  }
  const job = (current = new Job(kind, title));
  job.finished = (async () => {
    try {
      await work(job);
    } catch (e) {
      if (job.signal.aborted && isAbort(e)) {
        if (!job.preempted) {
          job.result = job.background
            ? t('job.stoppedLookup', job.result, fmt(job.done), fmt(job.total)).trim()
            : t('job.stopped', fmt(job.done), fmt(job.total));
        }
      } else {
        job.error = e?.message || String(e);
        job.signedOut = e instanceof SignedOut;
      }
    } finally {
      job.note = '';
      job.running = false;
    }
  })();
  return job;
}

/** Throws when an operation that needs the mailbox to itself is running. */
function ensureIdle() {
  if (current?.running && !current.background) throw new Error(t('busy'));
}

export function clearJob() {
  current?.cancel();
  current = null;
}

// ---------- The mailbox ----------

const MAX_SENDER_CHECKS = 500;
const QUICK_LIMIT = 50;
const ACTIONS = ['trash', 'delete', 'archive', 'read', 'unread'];

function checkAction(action, service) {
  if (!ACTIONS.includes(action)) throw new Error(t('action.unknown'));
  if (action === 'delete' && !service.canDelete) throw new Error(t('action.noDelete'));
  if (action === 'archive' && !service.canArchive) throw new Error(t('action.noArchive'));
}

/** Only the mails the action would change. */
const pending = (mails, action) =>
  action === 'read' ? mails.filter(m => !m.read) : action === 'unread' ? mails.filter(m => m.read) : mails;

function progressText(action, n) {
  const mails = plural(n, 'mail');
  if (action === 'archive' || action === 'read' || action === 'unread') return t(`progress.${action}`, mails);
  return t('progress.remove', mails);
}

const summaryText = (action, done, trash) => tn(`done.${action}`, done, trash);

const cleanList = values => [...new Set((values || []).map(v => String(v).trim().toLowerCase()).filter(v => v.includes('@')))];

/**
 * The scanned mailbox, whichever service it comes from, and what the app does with it. A service (provider) offers:
 * kind, trashName, blockName, canDelete, canArchive, canBlock, scanFindsUnsubscribe, folders(), read(folders, found, job),
 * lookup(senders, found, job), apply(mails, action, done, failed, job), block(patterns, job), body(mail), storage() and
 * emptyTrash(job). apply calls done(mail, changes) for each mail it changed, where an archive passes the mail's new
 * { id, folderId }. read, lookup and apply add to the job's progress.
 * A mail is { id, folderId, email, name, subject, t, size, read, other, attach }, newest first.
 */
export class Mailbox {
  constructor(provider) {
    this.provider = provider;
    this.folders = [];
    this.scanned = [];   // the folders of the last scan
    this.mails = [];
    this.info = new Map();   // sender address -> unsubscribe info from their latest mail
    this.complete = true;
    this.usedAtStart = null;   // storage use when first measured, to show what cleaning freed
  }

  async listFolders(signal) {
    this.folders = await this.provider.folders(signal);
    return this.folders;
  }

  scan(folderIds, checkSenders) {
    const targets = this.folders.filter(f => folderIds.includes(f.id));
    if (!targets.length) throw new Error(t('scan.noFolder'));
    const service = this.provider;
    return startJob('scan', t('scan.title'), async job => {
      job.step(t('scan.reading', targets.map(f => f.name).join(', ')), targets.reduce((n, f) => n + f.total, 0));
      const found = new Map();
      const newest = new Map();
      let finished = false;
      try {
        await service.read(targets, (mail, info) => {
          if (found.has(mail.id)) return false;
          mail.email ||= mail.name ? mail.name.toLowerCase() : t('unknownSender');
          found.set(mail.id, mail);
          const known = newest.get(mail.email);
          if (info && (!known || mail.t > known.t)) newest.set(mail.email, { t: mail.t, info });
          return true;
        }, job);
        finished = true;
      } finally {
        // A stopped scan still shows what it read.
        for (const [email, latest] of newest) this.info.set(email, latest.info);
        this.mails = [...found.values()].sort((a, b) => b.t - a.t);
        this.scanned = targets;
        this.complete = finished;
      }
      job.result = tn('scan.result', this.mails.length);
      if (!checkSenders || service.scanFindsUnsubscribe) return;
      const todo = this.sendersToCheck();
      if (!todo.length) return;
      job.background = true;   // the table is usable now; starting any action stops this lookup
      job.step(t('lookup.title'), todo.length);
      await this.#lookup(todo, job);
      const links = todo.filter(s => this.info.get(s.email)?.url || this.info.get(s.email)?.mailto).length;
      job.result += tn('lookup.result', links, fmt(todo.length));
    });
  }

  /** Senders worth an unsubscribe lookup: repeat senders that the service doesn't file as junk, busiest first. */
  sendersToCheck() {
    const junk = this.folders.find(f => f.wellKnown === 'junkemail')?.id;
    const groups = new Map();
    for (const m of this.mails) {   // newest first, so a sender's first mail is their latest
      if (!m.email.includes('@')) continue;
      let g = groups.get(m.email);
      if (!g) groups.set(m.email, (g = { email: m.email, id: m.id, count: 0, junk: 0 }));
      g.count++;
      if (m.folderId === junk) g.junk++;
    }
    return [...groups.values()]
      .filter(g => !this.info.has(g.email) && g.count >= 2 && g.junk * 2 < g.count)
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_SENDER_CHECKS)
      .map(({ email, id }) => ({ email, id }));
  }

  /** The newest mail of each of these senders. */
  latestMails(emails) {
    const wanted = new Set(emails);
    const latest = new Map();
    for (const m of this.mails) if (wanted.has(m.email) && !latest.has(m.email)) latest.set(m.email, m.id);
    return [...latest].map(([email, id]) => ({ email, id }));
  }

  /** Reads the unsubscribe info of each sender's latest mail. */
  #lookup(senders, job) {
    return this.provider.lookup(senders, (email, info) => this.info.set(email, info), job);
  }

  /** A sender's unsubscribe info, looked up now if the scan didn't check that sender. */
  async sender(email) {
    if (!this.info.has(email)) {
      ensureIdle();
      await this.#lookup(this.latestMails([email]), null);
    }
    return this.info.get(email) ?? parseUnsubscribe();
  }

  /** Applies an action through the service and keeps the mailbox in step. */
  async apply(mails, action, job) {
    let done = 0;
    let failed = 0;
    const gone = new Set();
    try {
      await this.provider.apply(mails, action,
        (mail, changes) => {
          if (action === 'trash' || action === 'delete') gone.add(mail);
          else Object.assign(mail, action === 'archive' ? changes : { read: action === 'read' });
          done++;
        },
        reason => {
          failed++;
          job?.fail(t('apply.failed', reason));
        },
        job);
    } finally {
      if (gone.size) this.mails = this.mails.filter(m => !gone.has(m));
    }
    return { done, failed };
  }

  /** The cleanup job: block, unsubscribe, then the mail action. */
  clean({ mails = [], action = 'trash', unsubscribe = [], block = [] }) {
    const service = this.provider;
    checkAction(action, service);
    const targets = pending(mails, action);
    const emails = cleanList(unsubscribe);
    const blocked = service.canBlock ? cleanList(block) : [];
    if (!targets.length && !emails.length && !blocked.length) throw new Error(action === 'read' ? t('clean.alreadyRead') : t('clean.nothing'));
    return startJob('clean', t('clean.title'), async job => {
      const summary = [];
      if (blocked.length) {
        job.step(t('block.updating', service.blockName), 1);
        try {
          const added = await service.block(blocked, job);
          summary.push(tn('block.done', added));
          job.add(1);
        } catch (e) {
          if (!(e instanceof ServiceError)) throw e;
          job.warning = t('block.failed', service.blockName, e.message);
        }
      }
      if (emails.length) summary.push(await this.unsubscribe(emails, job));
      if (targets.length) {
        job.step(progressText(action, targets.length), targets.length);
        const { done } = await this.apply(targets, action, job);
        summary.push(summaryText(action, done, service.trashName));
      }
      job.result = summary.join(' ');
    });
  }

  async unsubscribe(emails, job) {
    const unknown = this.latestMails(emails).filter(s => !this.info.has(s.email));
    if (unknown.length) {
      job.step(t('lookup.title'), unknown.length);
      await this.#lookup(unknown, job);
    }
    job.step(t('unsub.step', plural(emails.length, 'sender')), emails.length);
    let automatic = 0;
    let none = 0;
    await pool(emails, 6, async email => {
      const info = this.info.get(email);
      if (info?.oneClick && info.url && (await oneClick(info.url, job.signal))) automatic++;
      else if (info?.url || info?.mailto) job.manual.push({ email, url: info.url || info.mailto });
      else none++;
      job.add(1);
    }, job.signal);
    const manual = job.manual.length;
    return t('unsub.done', plural(automatic, 'sender')) +
      (manual ? tn('unsub.manual', manual) : '') +
      (none ? tn('unsub.noWay', none) : '') + '.';
  }

  /** A quick change to a few mails (the one in the viewer), done right away instead of as a job. */
  async act(mails, action) {
    checkAction(action, this.provider);
    ensureIdle();
    if (mails.length > QUICK_LIMIT) throw new Error(t('quick.tooMany'));
    return this.apply(pending(mails, action), action, null);
  }

  /** Empties Deleted Items or Trash, which frees the space its mails still take. */
  emptyTrash() {
    const service = this.provider;
    const trash = service.trashName;
    return startJob('trash', t('trash.emptying', trash), async job => {
      const count = await service.emptyTrash(job);
      job.result = count === 0 ? t('trash.wasEmpty', trash) : tn('trash.emptied', count, trash);
    });
  }

  async storage(signal) {
    const info = await this.provider.storage(signal);
    if (typeof info.used === 'number') {
      this.usedAtStart ??= info.used;
      info.freed = Math.max(0, this.usedAtStart - info.used);
    }
    return info;
  }
}
