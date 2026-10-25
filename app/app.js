// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

// The page: connect, scan, pick what to clean, review and clean up. The mail services sit behind mail.js.

import { Mailbox, SignedOut, currentJob, clearJob, isAbort, mailPage, fmt, plural, sleep, esc, storage } from './mail.js';
import { t, tn, lang, setLang, langForBrowser, intl, translatePage } from './i18n.js';
import { Microsoft, signInFor, appUrl, loadDefaults, DESKTOP_REDIRECT } from './auth.js';
import { Outlook } from './outlook.js';
import { Gmail } from './gmail.js';
import { Imap, bridge, bridgeState } from './imap.js';
import { initAbout, fillAbout, watermark } from './about.js';
import { NATIVE, shell } from './native.js';

// ---------- Helpers ----------

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const pct = (part, whole) => (whole ? Math.round((100 * part) / whole) : 0);
const sum = (items, pick) => items.reduce((n, item) => n + pick(item), 0);
const DAY = 86400000;
const MB = 1024 * 1024;
const PAGE = 300;
const day = ms => (ms > 0 ? intl(Intl.DateTimeFormat, { year: 'numeric', month: 'short', day: 'numeric' }).format(ms) : '');
const dateTime = ms => (ms > 0 ? intl(Intl.DateTimeFormat, { dateStyle: 'medium', timeStyle: 'short' }).format(ms) : '');
const isoDay = ms => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '');
const webUrl = url => (/^https?:\/\//i.test(url || '') ? url : null);
const domainOf = email => (email.includes('@') ? email.slice(email.lastIndexOf('@') + 1).trim().toLowerCase() : '');
const saved = storage(localStorage);

function size(bytes) {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${intl(Intl.NumberFormat, { maximumFractionDigits: i >= 2 ? 1 : 0 }).format(bytes / 1024 ** i)} ${units[i]}`;
}

function duration(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
}

function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), bad ? 9000 : 5000);
}

function showError(selector, message) {
  $(selector).textContent = message || '';
  $(selector).hidden = !message;
}

/** Shows an error, or goes back to the sign-in when it expired. */
function failed(e) {
  if (e instanceof SignedOut) signedOut(e.message);
  else if (!isAbort(e)) toast(e.message, true);
}

// ---------- The mail service's words ----------

const KINDS = ['outlook', 'gmail', 'imap'];
const WORDS = ['service', 'company', 'junk', 'other', 'otherWhy', 'otherAi', 'block', 'limits', 'deleteNote', 'restoreNote',
  'trashNote', 'emptyNote', 'manage'];

/** A mail service's words in the interface language (i18n.js), such as T.junk. IMAP has no "other" tab, so T.other is empty. */
const wordsFor = kind => Object.fromEntries(WORDS.map(word => [word, t(`${kind}.${word}`)]));
let T = wordsFor('outlook');

/** The words for this service, with the name it gives its trash. */
function setProvider(provider) {
  T = { ...wordsFor(provider.kind), trash: provider.trashName };
  $('#chip-junk').textContent = t('chip.junk', T.junk);
  $('#mv-web').textContent = t('mv.web', T.service);
  $('#cl-delete-note').textContent = T.deleteNote;
  for (const el of $$('.trash-name')) el.textContent = T.trash;
}

// ---------- Spam heuristics ----------

const SPAM_THRESHOLD = 40;
const BULK_LOCAL = /(no-?reply|do-?not-?reply|no-?responder|newsletter|news|boletin|marketing|promo|offers?|ofertas?|deals?|mailer|mailing|campaign|bounce|notification|notificacion|noticias|novedades|digest)/i;
const GENERIC_LOCAL = /^(info|hello|hola|hi|team|equipo|contact|contacto|support|soporte|updates?|alerts?|mail|email|admin|service|servicio)$/i;
const BULK_HOST = /^(e|em|email|emails|mail|mailer|mailing|news|newsletter|info|marketing|mkt|promo|offers|ofertas|click|send|bounce|crm|comms|notifications?|updates?)\d*\./i;
const SERVICE_HOST = /(mailchimp|mcsv\.net|rsgsv\.net|mcdlv\.net|sendgrid|exacttarget|mktomail|hubspot|klaviyo|sendinblue|brevo|mailgun|mailjet|constantcontact|amazonses|sparkpost|mandrill|createsend|emarsys|selligent|sfmc)/i;
const SHARED_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.es', 'hotmail.com', 'hotmail.es', 'live.com', 'live.es',
  'msn.com', 'yahoo.com', 'yahoo.es', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.es', 'gmx.net', 'yandex.com', 'mail.com', 'telefonica.net', 'movistar.es',
]);
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'gob', 'edu', 'ac', 'or', 'ne', 'go', 'nom', 'ltd', 'plc']);

/** "mail.shop.co.uk" -> "shop.co.uk", "news.brand.com" -> "brand.com" */
function baseDomain(host) {
  const parts = host.split('.');
  const n = parts.length;
  if (n <= 2) return host;
  return parts.slice(parts[n - 1].length === 2 && SECOND_LEVEL.has(parts[n - 2]) ? -3 : -2).join('.');
}

const hasUnsub = s => Boolean(s.info?.url || s.info?.mailto);

/** 0 to 100 from signals the mail service already gives us, plus the reasons. Uses all of the sender's mail. */
function scoreSender(s) {
  const n = s.count || 1;
  const local = s.email.split('@')[0];
  const why = [];
  let score = 0;
  if (s.junk) { score += 45 * s.junk / n; why.push(t('why.junk', pct(s.junk, n), T.junk)); }
  if (s.other) { score += 20 * s.other / n; why.push(t('why.other', pct(s.other, n), T.otherWhy)); }
  if (n >= 3 && s.unread) { score += 20 * s.unread / n; why.push(t('why.unread', pct(s.unread, n))); }
  if (BULK_LOCAL.test(local)) { score += 12; why.push(t('why.bulk')); }
  else if (GENERIC_LOCAL.test(local)) { score += 5; why.push(t('why.generic')); }
  if (BULK_HOST.test(s.host) || SERVICE_HOST.test(s.host)) { score += 8; why.push(t('why.service')); }
  if (hasUnsub(s)) { score += 10; why.push(t('why.unsub')); }
  if (n >= 10) { score += 10 * Math.min(n / 50, 1); why.push(plural(n, 'mail')); }
  s.score = Math.min(100, Math.round(score));
  s.reasons = why.join(' · ') || t('why.none');
}

// ---------- State ----------

/**
 * The connection: the default app registrations (config.json), the desktop app's IMAP bridge (null on the website),
 * which service, its sign-in, a desktop sign-in waiting for the browser, and the scanned mailbox.
 */
const S = { defaults: {}, bridge: null, kind: 'outlook', auth: null, signingIn: null, box: null };

/** The scanned mailbox for the page: senders and folders once, then one small object per mail (newest first). */
const M = { sizes: false, folders: [], junk: -1, senders: [], mails: [], byMail: new Map() };

/** Filters. Mail filters pick which mails count; sender filters pick which rows show. */
const F = { group: 'sender', q: '', chips: new Set(), age: 0, mailSize: 0, minMails: 1, minTotal: 0, sort: { key: 'count', dir: -1 } };

const UI = {
  folders: [],
  folderSel: new Set(saved.get('folders', [])),
  showAllFolders: false,
  rows: [],
  limit: PAGE,
  selected: new Set(),
  list: saved.get('list', []),
  watching: false,
  busy: false,
  storage: null,
};

/** The open sender preview and mail viewer. The viewer's list holds the mailbox's own mail objects. */
const PV = { key: null, byDomain: false, limit: 200, mails: [] };
const MV = { list: [], pos: 0, images: false, loading: 0, body: null };

// ---------- Views ----------

function showView(name) {
  for (const view of ['connect', 'main']) $('#view-' + view).hidden = view !== name;
  $('#intro').hidden = NATIVE || name !== 'connect';
  $('#account').hidden = name !== 'main';
  document.documentElement.classList.remove('booting');
}

// ---------- Connect ----------

/** The published app registration (config.json) for Outlook or Gmail. */
const defaultApp = kind => S.defaults?.[kind === 'gmail' ? 'google' : 'microsoft'] || {};

/** The app registration for Outlook or Gmail: the user's own when they saved one, else the published default. */
function appFor(kind) {
  const own = saved.get('apps', {})[kind];
  if (own?.clientId) return { ...own, own: true };
  const app = defaultApp(kind);
  return { clientId: app.clientId || '', tenant: app.tenant || 'common', secret: app.secret || '', own: false };
}

/** Saves the user's own app registration, or with null goes back to the default. */
function saveApp(kind, app) {
  const apps = saved.get('apps', {});
  if (app) apps[kind] = app;
  else delete apps[kind];
  saved.set('apps', apps);
}

/** The sign-in for a service, picking up this tab's session when there is one. */
function makeAuth(kind) {
  if (kind === 'imap') {
    const st = S.bridge;
    return st && { signedIn: st.signedIn, user: st.email, signOut: () => bridge('logout', {}), forget() {} };
  }
  const app = appFor(kind);
  if (!app.clientId) return null;
  return signInFor(kind, app, askToContinue);
}

function showConnect(kind, error = '') {
  S.signingIn?.abort();
  S.kind = kind;
  S.auth = makeAuth(kind);
  showView('connect');
  for (const b of $$('#providers button')) b.classList.toggle('on', b.dataset.provider === kind);
  $('#oauth').hidden = kind === 'imap';
  $('#imap').hidden = kind !== 'imap';
  if (kind === 'imap') {
    showImap(error);
    return;
  }
  const gmail = kind === 'gmail';
  const app = appFor(kind);
  const ready = Boolean(app.clientId);
  $('#login').hidden = !ready;
  $('#login-note').hidden = !ready;
  showError('#login-error', error);
  $('#own-app').open = !ready;
  $('#steps-outlook').hidden = gmail;
  $('#steps-gmail').hidden = !gmail;
  $('#f-tenant').hidden = gmail;
  $('#f-secret').hidden = !gmail || !NATIVE;
  $('#client-id').value = app.own ? app.clientId : '';
  $('#client-secret').value = app.own ? app.secret || '' : '';
  $('#client-id').placeholder = gmail ? '1234567890-abc123.apps.googleusercontent.com' : '1a2b3c4d-1234-5678-9abc-def012345678';
  $('#tenant').value = app.tenant || 'common';
  $('#app-default').hidden = !app.own;
  showError('#app-error', '');
  connectTexts();
  // So the click can open Google's window right away: browsers block windows opened after a delay.
  if (gmail && S.auth) S.auth.prepare().catch(e => showError('#login-error', e.message));
}

/** The sign-in texts that name the service or depend on the setup, in the interface language. */
function connectTexts() {
  for (const el of $$('.redirect-uri')) el.textContent = appUrl();
  for (const el of $$('.desktop-redirect')) el.textContent = DESKTOP_REDIRECT;
  for (const el of $$('.js-origin')) el.textContent = location.origin;
  if (S.kind === 'imap') {
    if (S.bridge) $('#imap-keep').textContent = S.bridge.remembered ? t('imap.keepWindows') : t('imap.keepSession');
    return;
  }
  const app = appFor(S.kind);
  const company = t(`${S.kind}.company`);
  $('#login').textContent = t('login', company);
  $('#login-note').textContent = t('login.note', company, NATIVE ? t('login.inBrowser') : '');
  $('#own-app-title').textContent = !app.clientId ? t('ownApp.setup', company) : app.own ? t('ownApp.own') : t('ownApp.instead');
  $('#app-default').textContent = defaultApp(S.kind).clientId ? t('ownApp.default') : t('ownApp.remove');
}

function showImap(error) {
  const st = S.bridge;
  $('#imap-desktop-only').hidden = Boolean(st);
  $('#imap-form').hidden = !st;
  if (!st) return;
  $('#imap-email').value = st.email || '';
  $('#imap-user').value = st.user || '';
  $('#imap-host').value = st.host || '';
  $('#imap-host').dataset.auto = 'yes';   // from the saved setup: replaced when the address moves to another domain
  $('#imap-host').dataset.domain = domainOf(st.email || '');
  $('#imap-port').value = st.port || 993;
  $('#imap-security').value = st.security || 'ssl';
  $('#imap-password').value = '';
  connectTexts();
  $('#imap-tip').hidden = true;
  showError('#imap-error', error || st.error);
}

/** Fills in the IMAP server for the typed address, unless the user typed a server themselves. */
async function findImapServer() {
  const email = $('#imap-email').value.trim();
  const host = $('#imap-host');
  $('#imap-tip').hidden = true;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
  if (host.value.trim() && (host.dataset.auto !== 'yes' || host.dataset.domain === domainOf(email))) return;
  try {
    const s = await bridge('lookup', { email });
    // Too late if the address changed or the user typed a server meanwhile.
    if ($('#imap-email').value.trim() !== email || (host.value.trim() && host.dataset.auto !== 'yes')) return;
    const tip = s.useInstead === 'gmail' ? t('imap.useGmail') : s.useInstead === 'outlook' ? t('imap.useOutlook') : s.tip;
    $('#imap-tip').textContent = tip || '';
    $('#imap-tip').hidden = !tip;
    if (s.useInstead) return;
    host.value = s.host || '';
    host.dataset.auto = 'yes';
    host.dataset.domain = domainOf(email);
    $('#imap-port').value = s.port || 993;
    $('#imap-security').value = s.security || 'ssl';
    if (s.user) $('#imap-user').value = s.user;
  } catch {
    // Not found: the user types the server their provider documents.
  }
}

/** Google's sign-in lasts an hour, and only a click may open its window again: ask for one. Resolves to the new token. */
function askToContinue(renew) {
  return new Promise((resolve, reject) => {
    const dialog = $('#renew');
    let settled = false;
    const settle = (finish, value) => {
      settled = true;
      if (dialog.open) dialog.close();
      finish(value);
    };
    $('#rn-ok').onclick = async () => {
      showError('#rn-error', '');
      $('#rn-ok').disabled = true;
      try {
        settle(resolve, await renew());   // renew() opens Google's window before its first await, inside this click
      } catch (e) {
        showError('#rn-error', e.message);
      } finally {
        $('#rn-ok').disabled = false;
      }
    };
    $('#rn-stop').onclick = () => dialog.close();
    dialog.onclose = () => {
      if (!settled) settle(reject, new Error(t('renew.stopped')));
    };
    showError('#rn-error', '');
    if (!dialog.open) dialog.showModal();
  });
}

/** Opens the main view for the signed-in service. */
async function enter() {
  const auth = S.auth;
  const provider = S.kind === 'gmail' ? new Gmail(auth) : S.kind === 'imap' ? new Imap() : new Outlook(auth);
  S.box = new Mailbox(provider);
  saved.set('provider', S.kind);
  setProvider(provider);
  showView('main');
  $('#account-name').textContent = auth.user || '';
  $('#scan-unsub').checked = saved.get('scanUnsub', true);
  $('#scan-unsub-box').hidden = provider.scanFindsUnsubscribe;
  if (S.kind === 'gmail') auth.prepare().catch(() => {});   // so Continue can open Google's window when the hour is up
  loadMails();
  loadStorage();
  try {
    await loadFolders();
  } catch (e) {
    failed(e);
  }
}

/** Closes the mailbox: stops the job and forgets what was scanned. */
function leave() {
  clearJob();
  S.box = null;
  Object.assign(M, { folders: [], senders: [], mails: [], byMail: new Map(), junk: -1 });
  UI.selected.clear();
  UI.folders = [];
  UI.storage = null;
  for (const dialog of $$('dialog')) if (dialog.open) dialog.close();
  renderStorage();
  renderAll();
}

/** Back to signing in to the same service, with the desktop app's IMAP setup read again. */
async function backToConnect(message = '') {
  if (S.kind === 'imap') S.bridge = await bridgeState();
  showConnect(S.kind, message);
}

/** The sign-in expired or the server refused it: back to signing in, keeping the setup. */
async function signedOut(message) {
  if (!S.box) return;
  S.auth?.forget();
  leave();
  await backToConnect(message);
}

// ---------- Folders and scanning ----------

async function loadFolders() {
  const box = S.box;
  const folders = await box.listFolders();
  if (box !== S.box) return;
  UI.folders = folders;
  const ids = new Set(folders.map(f => f.id));
  for (const id of [...UI.folderSel]) if (!ids.has(id)) UI.folderSel.delete(id);
  if (!UI.folderSel.size) {
    for (const f of folders) if (f.wellKnown === 'inbox' || f.wellKnown === 'junkemail') UI.folderSel.add(f.id);
  }
  renderFolders();
}

function renderFolders() {
  const chip = f => {
    const on = UI.folderSel.has(f.id);
    return `<label class="chip${on ? ' on' : ''}" title="${esc(t('folder.unread', f.path, fmt(f.unread)))}">
      <input type="checkbox" value="${esc(f.id)}"${on ? ' checked' : ''}>${esc(f.path)}
      <span class="count">${fmt(f.total)}${f.size ? ' · ' + size(f.size) : ''}</span></label>`;
  };
  const pinned = UI.folders.filter(f => f.wellKnown);
  const others = UI.folders.filter(f => !f.wellKnown);
  $('#folders').innerHTML = pinned.map(chip).join('') + (UI.showAllFolders ? others.map(chip).join('') : '');
  $('#more-folders').hidden = !others.length;
  $('#more-folders').textContent = UI.showAllFolders ? t('folders.hide') : t('folders.show', plural(others.length, 'moreFolder'));
  renderScanButton();
}

function renderScanButton() {
  const chosen = UI.folders.filter(f => UI.folderSel.has(f.id));
  $('#scan').textContent = chosen.length
    ? t('scan.button', plural(chosen.length, 'folder'), plural(sum(chosen, f => f.total), 'mail')) : t('scan.pick');
  $('#scan').disabled = !chosen.length || UI.busy;
}

async function startScan() {
  saved.set('scanUnsub', $('#scan-unsub').checked);
  try {
    await S.box.scan([...UI.folderSel], $('#scan-unsub').checked);
    watchJob();
  } catch (e) {
    failed(e);
  }
}

function newSender(i, email, name, info) {
  const host = domainOf(email);
  return {
    i, email, name, label: name || email, lname: name.toLowerCase(), host, domain: host ? baseDomain(host) : '', info: info || null,
    count: 0, unread: 0, other: 0, junk: 0, size: 0, latest: 0, subjects: [],
  };
}

/** Builds the page's view of the mailbox: senders and folders by index, and per-sender totals. */
function loadMails() {
  const box = S.box;
  if (!box) return;
  const known = new Map(box.folders.map(f => [f.id, f]));
  const folderIndex = new Map();
  const senderIndex = new Map();
  M.folders = [];
  M.senders = [];
  M.mails = box.mails.map(mail => {
    let f = folderIndex.get(mail.folderId);
    if (f === undefined) {
      f = M.folders.length;
      folderIndex.set(mail.folderId, f);
      const info = known.get(mail.folderId);
      M.folders.push({ id: mail.folderId, path: info?.path ?? '', wellKnown: info?.wellKnown ?? null });
    }
    let s = senderIndex.get(mail.email);
    if (s === undefined) {
      s = M.senders.length;
      senderIndex.set(mail.email, s);
      M.senders.push(newSender(s, mail.email, mail.name, box.info.get(mail.email)));
    } else if (!M.senders[s].name && mail.name) {
      Object.assign(M.senders[s], { name: mail.name, label: mail.name, lname: mail.name.toLowerCase() });
    }
    return {
      mail, s, f, t: mail.t, size: mail.size, read: mail.read, other: mail.other, attach: mail.attach,
      subject: mail.subject, lsubject: mail.subject.toLowerCase(),
    };
  });
  M.byMail = new Map(M.mails.map(m => [m.mail, m]));
  M.junk = M.folders.findIndex(f => f.wellKnown === 'junkemail');
  M.sizes = M.mails.some(m => m.size > 0);
  for (const m of M.mails) {
    const s = M.senders[m.s];
    s.count++;
    s.size += m.size;
    if (!m.read) s.unread++;
    if (m.other) s.other++;
    if (m.f === M.junk) s.junk++;
    if (!s.latest) s.latest = m.t;   // mails come newest first
    if (s.subjects.length < 3 && m.subject && !s.subjects.includes(m.subject)) s.subjects.push(m.subject);
  }
  for (const s of M.senders) scoreSender(s);
  document.body.classList.toggle('no-sizes', !M.sizes);
  renderAll();
  // Keep the selection of rows that still exist, and the open windows up to date.
  const keys = new Set(UI.rows.map(r => r.key));
  for (const key of [...UI.selected]) if (!keys.has(key)) UI.selected.delete(key);
  renderBulk();
  if ($('#preview').open) renderPreview();
  if ($('#mail').open) renderMailHeader();
}

// ---------- Filtering and grouping ----------

const keyOf = (s, byDomain) => (byDomain && s.domain ? '@' + s.domain : s.email);

/** The mail filters as a test: Remove only touches mails that pass them. */
function mailFilter() {
  const cutoff = F.age ? Date.now() - F.age * DAY : Infinity;
  const attachOnly = F.chips.has('attach');
  return m => {
    if (m.t > cutoff || m.size < F.mailSize || (attachOnly && !m.attach)) return false;
    if (!F.q) return true;
    const s = M.senders[m.s];
    return s.email.includes(F.q) || s.lname.includes(F.q) || m.lsubject.includes(F.q);
  };
}

/** Rows for the table: the mails that pass the mail filters, grouped, then the groups that pass the sender filters. */
function computeRows() {
  const byDomain = F.group === 'domain';
  const passes = mailFilter();
  const groups = new Map();
  for (const m of M.mails) {
    if (!passes(m)) continue;
    const s = M.senders[m.s];
    const key = keyOf(s, byDomain);
    let g = groups.get(key);
    if (!g) {
      g = { key, isDomain: key.startsWith('@'), senders: new Set(), mails: [], count: 0, unread: 0, junk: 0, size: 0, latest: m.t, subject: m.subject };
      groups.set(key, g);
    }
    g.senders.add(s);
    g.mails.push(m);
    g.count++;
    g.size += m.size;
    if (!m.read) g.unread++;
    if (m.f === M.junk) g.junk++;
  }

  const rows = [];
  for (const g of groups.values()) {
    describeGroup(g);
    if (g.count < F.minMails || g.size < F.minTotal) continue;
    if (F.chips.has('spam') && g.score < SPAM_THRESHOLD) continue;
    if (F.chips.has('unsub') && !g.unsub) continue;
    if (F.chips.has('unopened') && g.unread < g.count) continue;
    if (F.chips.has('junk') && !g.junk) continue;
    rows.push(g);
  }
  const { key, dir } = F.sort;
  return rows.sort((a, b) => {
    const x = a[key];
    const y = b[key];
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir || b.count - a.count;
  });
}

function describeGroup(g) {
  const senders = [...g.senders];
  g.unreadPct = pct(g.unread, g.count);
  g.unsub = senders.some(hasUnsub);
  g.oneClick = senders.some(s => s.info?.oneClick);
  if (g.isDomain) {
    const domain = g.key.slice(1);
    const shared = SHARED_PROVIDERS.has(domain);
    g.label = domain;
    g.sub = shared ? t('group.shared') : plural(senders.length, 'sender');
    g.score = shared ? 0 : Math.round(sum(senders, s => s.score * s.count) / sum(senders, s => s.count));
    g.reasons = shared ? t('group.sharedWhy') : t('group.average', plural(senders.length, 'sender'));
  } else {
    const s = senders[0];
    g.label = s.label;
    g.sub = s.name ? s.email : '';
    g.score = s.score;
    g.reasons = s.reasons;
  }
}

function filtersActive() {
  return Boolean(F.q || F.chips.size || F.age || F.mailSize || F.minMails > 1 || F.minTotal);
}

/** Describes the mail filters, because Remove only touches the mails that pass them. */
function scopeText() {
  const parts = [];
  if (F.age) parts.push(t('scope.older', $('#f-age').selectedOptions[0].textContent));
  if (F.mailSize) parts.push(t('scope.bigger', $('#f-mailsize').selectedOptions[0].textContent));
  if (F.chips.has('attach')) parts.push(t('scope.attach'));
  if (F.q) parts.push(t('scope.matching', F.q));
  return parts.length ? t('scope.only', parts.join(', ')) : '';
}

/** Shows the table from its first page again, after a filter or the grouping changed. */
function refilter() {
  UI.limit = PAGE;
  renderTable();
}

function resetFilters() {
  Object.assign(F, { q: '', chips: new Set(), age: 0, mailSize: 0, minMails: 1, minTotal: 0 });
  $('#search').value = '';
  for (const id of ['#f-age', '#f-mailsize', '#f-total']) $(id).value = '0';
  $('#f-mails').value = '1';
  refilter();
}

// ---------- Rendering ----------

function renderAll() {
  renderStats();
  renderTable();
  renderList();
}

function renderStats() {
  const has = M.mails.length > 0;
  $('#stats').hidden = !has;
  $('#results').hidden = !has;
  const scanned = S.box?.scanned.map(f => f.path).join(', ');
  $('#scan-info').textContent = has ? t(S.box.complete ? 'scan.done' : 'scan.partly', scanned) : t('scan.start', T.junk);
  if (!has) return;

  const space = bytes => (M.sizes ? ` · ${size(bytes)}` : '');
  const unread = sum(M.senders, s => s.unread);
  const spam = M.senders.filter(s => s.score >= SPAM_THRESHOLD);
  const unsub = M.senders.filter(hasUnsub);
  const junk = M.mails.filter(m => m.f === M.junk);
  $('#stats').innerHTML = `
    <div class="stat"><b>${fmt(M.mails.length)}</b>
      <span>${tn('stats.mails', M.mails.length, space(sum(M.mails, m => m.size)), pct(unread, M.mails.length), plural(M.senders.length, 'sender'))}</span></div>
    <div class="stat alert"><b>${fmt(sum(spam, s => s.count))}</b>
      <span>${t('stats.spam', space(sum(spam, s => s.size)), plural(spam.length, 'sender'))}</span>
      <div class="row">${spam.length ? `<button class="btn small" data-show="spam">${t('show')}</button><button class="btn small danger" data-act="spam">${t('removeAll')}</button>` : ''}</div></div>
    <div class="stat"><b>${fmt(unsub.length)}</b>
      <span>${tn('stats.unsub', unsub.length, fmt(unsub.filter(s => s.info.oneClick).length))}</span>
      <div class="row">${unsub.length ? `<button class="btn small" data-show="unsub">${t('show')}</button>` : ''}</div></div>
    <div class="stat"><b>${fmt(junk.length)}</b>
      <span>${t('stats.in', esc(T.junk), space(sum(junk, m => m.size)))}</span>
      <div class="row">${junk.length ? `<button class="btn small" data-act="junk">${esc(t('emptyFolder', T.junk))}</button>` : ''}</div></div>`;
}

function rowHtml(r) {
  const selected = UI.selected.has(r.key);
  const level = r.score >= 70 ? 'hi' : r.score >= SPAM_THRESHOLD ? 'mid' : 'lo';
  const badge = r.oneClick ? `<span class="badge" title="${t('badge.oneClickWhy')}">${t('badge.oneClick')}</span>`
    : r.unsub ? `<span class="badge" title="${t('badge.unsubWhy')}">${t('badge.unsub')}</span>` : '';
  return `<tr data-key="${esc(r.key)}"${selected ? ' class="sel"' : ''}>
    <td><input type="checkbox"${selected ? ' checked' : ''} aria-label="${t('select')}"></td>
    <td class="who"><div class="name" title="${esc(r.label)}">${esc(r.label)}${badge}</div><div class="sub" title="${esc(r.sub)}">${esc(r.sub)}</div></td>
    <td class="num">${fmt(r.count)}</td>
    <td class="num size-only">${size(r.size)}</td>
    <td class="num">${r.unreadPct}%</td>
    <td class="num"><span class="score ${level}" title="${esc(r.reasons)}">${r.score}</span></td>
    <td class="nowrap">${day(r.latest)}</td>
    <td class="ellipsis" title="${esc(r.subject)}">${esc(r.subject) || `<span class="muted">${t('noSubject')}</span>`}</td>
    <td class="actions"><button class="btn small ghost" data-act="view">${t('view')}</button><button class="btn small danger-ghost" data-act="remove">${t('remove')}</button></td>
  </tr>`;
}

function renderTable() {
  const rows = (UI.rows = computeRows());
  $('#rows').innerHTML = rows.slice(0, UI.limit).map(rowHtml).join('');
  $('#empty').hidden = rows.length > 0;
  $('#empty').textContent = filtersActive() ? t('empty.filters') : t('empty.none');
  const more = rows.length - UI.limit;
  $('#show-more').hidden = more <= 0;
  $('#show-more').textContent = tn('showMore', more);
  $('#sel-all').checked = rows.length > 0 && rows.every(r => UI.selected.has(r.key));
  $('th.c-who').textContent = F.group === 'domain' ? t('th.domain') : t('th.sender');
  for (const th of $$('th[data-sort]')) {
    th.classList.toggle('asc', th.dataset.sort === F.sort.key && F.sort.dir > 0);
    th.classList.toggle('desc', th.dataset.sort === F.sort.key && F.sort.dir < 0);
  }
  for (const chip of $$('#chips .chip')) chip.classList.toggle('on', F.chips.has(chip.dataset.chip));
  for (const button of $$('#group button')) button.classList.toggle('on', button.dataset.group === F.group);
  $('#f-reset').hidden = !filtersActive();
  $('#summary').innerHTML = `<b>${plural(rows.length, F.group === 'domain' ? 'domain' : 'sender')}</b> · ` +
    `${plural(sum(rows, r => r.count), 'mail')}${M.sizes ? ' · ' + size(sum(rows, r => r.size)) : ''}` +
    (filtersActive() ? t('summary.match') : '');
  renderBulk();
}

const selectedRows = () => UI.rows.filter(r => UI.selected.has(r.key));

function renderBulk() {
  const rows = selectedRows();
  $('#bulk').hidden = !rows.length;
  if (!rows.length) return;
  const unread = sum(rows, r => r.unread);
  $('#bulk-text').textContent = [tn('selected', rows.length), plural(sum(rows, r => r.count), 'mail'),
    M.sizes && size(sum(rows, r => r.size)), unread && t('unread', fmt(unread))].filter(Boolean).join(' · ');
  $('#bulk-read').disabled = UI.busy || !unread;
  $('#bulk-archive').hidden = !S.box.provider.canArchive;
}

// ---------- Remove list ----------

/** Senders matched by remove-list keys ("a@b.com", or "@b.com" which also covers subdomains). */
function listSenders(keys) {
  const emails = new Set();
  const domains = [];
  for (const k of keys) {
    if (k.startsWith('@')) domains.push(k.slice(1));
    else emails.add(k);
  }
  return M.senders.filter(s => emails.has(s.email) || (s.host && domains.some(d => s.host === d || s.host.endsWith('.' + d))));
}

function mailsOf(senders) {
  const ids = new Set(senders.map(s => s.i));
  return M.mails.filter(m => ids.has(m.s));
}

function renderList() {
  $('#list').innerHTML = UI.list.length
    ? UI.list.map(k => `<li data-key="${esc(k)}"><span class="k" title="${esc(k)}">${esc(k)}</span>
        <span class="n">${fmt(sum(listSenders([k]), s => s.count))}</span>
        <button class="x" title="${t('list.takeOff')}" aria-label="${t('list.takeOff')}">&times;</button></li>`).join('')
    : `<li class="none">${t('list.empty')}</li>`;
  const senders = listSenders(UI.list);
  const count = sum(senders, s => s.count);
  $('#list-total').textContent = UI.list.length
    ? t('list.total', plural(count, 'mail'), M.sizes ? ` (${size(sum(senders, s => s.size))})` : '', plural(senders.length, 'sender'))
    : '';
  $('#list-clean').textContent = count ? t('list.remove', plural(count, 'mail')) : t('remove');
  $('#list-clean').disabled = !UI.list.length || UI.busy;
}

function addToList(keys) {
  const fresh = [...new Set(keys)].filter(k => !UI.list.includes(k));
  if (!fresh.length) {
    toast(t('list.already'));
    return;
  }
  UI.list.push(...fresh);
  saved.set('list', UI.list);
  renderList();
  toast(fresh.length === 1 ? t('list.added', fresh[0]) : t('list.addedMany', fmt(fresh.length)));
}

/** Accepts "a@b.com", "@b.com", "b.com", "Name <a@b.com>" or several of them separated by commas/spaces. */
function parseEntries(text) {
  const ok = [];
  const bad = [];
  for (let part of text.split(/[\s,;]+/)) {
    part = part.trim().toLowerCase().replace(/^mailto:/, '').replace(/^[<"'(]+|[>"')]+$/g, '');
    if (!part.includes('@') && !part.includes('.')) continue;   // a display name like "John"
    if (!part.includes('@')) part = '@' + part;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part) || /^@([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(part)) ok.push(part);
    else bad.push(part);
  }
  return { ok, bad };
}

// ---------- Cleaning ----------

function ask(dialog, ok, cancel) {
  return new Promise(resolve => {
    const finish = answer => {
      resolve(answer);
      if (dialog.open) dialog.close();
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    dialog.onclose = () => finish(false);
    dialog.showModal();
  });
}

/** Starts a cleanup job and follows it. */
async function runJob(start) {
  try {
    await start();
  } catch (e) {
    failed(e);
    return false;
  }
  UI.selected.clear();
  renderTable();
  watchJob();
  return true;
}

/**
 * The one cleanup dialog. `mails` is exactly what Remove touches, `senders` can be unsubscribed from,
 * `block` holds the addresses or @domains for the block rule or filter.
 */
async function openClean({ title, who = '', mails = [], senders = [], block = [], scope = '', unsubscribe = false, mode = null }) {
  if (UI.busy) {
    toast(t('busy'));
    return;
  }
  // Unsubscribing from real spam only tells the spammer your address works.
  const mostlyJunk = s => s.junk * 2 >= s.count;
  const eligible = senders.filter(s => s.host && !mostlyJunk(s) && (!s.info || hasUnsub(s)));
  const skipped = senders.filter(s => s.host && mostlyJunk(s)).length;
  const oneClick = eligible.filter(s => s.info?.oneClick).length;
  const links = eligible.filter(s => hasUnsub(s) && !s.info.oneClick).length;
  const unknown = eligible.filter(s => !s.info).length;

  $('#cl-title').textContent = title;
  const top = [...senders].sort((a, b) => b.count - a.count);
  const names = top.slice(0, 5).map(s => s.label);
  $('#cl-who').textContent = who || (names.length
    ? t('clean.from', names.join(', '), top.length > 5 ? t('clean.andMore', plural(top.length - 5, 'moreSender')) : '')
    : t('clean.noMail'));
  $('#cl-scope').textContent = scope;
  $('#cl-scope').hidden = !scope;
  const shared = block.filter(k => k.startsWith('@') && SHARED_PROVIDERS.has(k.slice(1)));
  $('#cl-warn').hidden = !shared.length;
  $('#cl-warn').textContent = tn('clean.shared', shared.length, shared.map(k => k.slice(1)).join(', '));

  const { canArchive, canDelete, canBlock } = S.box.provider;
  const bytes = M.sizes ? ` (${size(sum(mails, m => m.size))})` : '';
  $('#cl-remove-box').hidden = !mails.length;
  $('#cl-remove').checked = !unsubscribe || saved.get('alsoRemove', true);
  $('#cl-trash-text').innerHTML = t('clean.trash', esc(T.trash), esc(T.restoreNote));
  $('#cl-archive-box').hidden = !canArchive;
  $('#cl-delete-box').hidden = !canDelete;
  const allowed = ['trash', canArchive && 'archive', canDelete && 'delete'].filter(Boolean);
  const preferred = mode || saved.get('mode', 'trash');
  $(`input[name=cl-mode][value=${allowed.includes(preferred) ? preferred : 'trash'}]`).checked = true;

  $('#cl-unsub-box').hidden = !eligible.length;
  const how = [
    oneClick && t('clean.auto', fmt(oneClick)),
    links && t('clean.link', fmt(links)),
    unknown && t('clean.checked', fmt(unknown)),
    skipped && t('clean.skipping', plural(skipped, 'junkSender')),
  ].filter(Boolean);
  $('#cl-unsub-text').textContent = t('clean.unsub', plural(eligible.length, 'sender'), how.length ? ` (${how.join(', ')})` : '');
  $('#cl-unsub').checked = unsubscribe || (!mode && saved.get('alsoUnsub', false));

  $('#cl-block-box').hidden = !block.length || !canBlock;
  $('#cl-block-text').innerHTML = t('clean.block', esc(T.block));
  $('#cl-block').checked = !mode && saved.get('block', false);

  const ticked = name => !$(`#cl-${name}-box`).hidden && $(`#cl-${name}`).checked;
  const choice = () => ({ remove: ticked('remove'), unsub: ticked('unsub'), blk: ticked('block'), action: $('input[name=cl-mode]:checked').value });
  const sync = () => {
    const { remove, unsub, blk, action } = choice();
    const verb = action === 'archive' ? t('archive') : t('remove');
    $('#cl-remove-text').textContent = `${verb} ${plural(mails.length, 'mail')}${bytes}`;
    $('#cl-mode').hidden = !remove;
    $('#cl-ok').disabled = !remove && !unsub && !blk;
    $('#cl-ok').className = 'btn ' + (remove && action === 'archive' && !blk ? 'primary' : 'danger');
    $('#cl-ok').textContent = remove && !unsub && !blk ? `${verb} ${plural(mails.length, 'mail')}`
      : !remove && unsub && !blk ? t('unsubscribe') : t('cleanUp');
  };
  for (const input of $$('#clean input')) input.onchange = sync;
  sync();

  if (!(await ask($('#clean'), $('#cl-ok'), $('#cl-cancel')))) return;

  const { remove, unsub, blk, action } = choice();
  if (remove && !mode) saved.set('mode', action);
  if (!$('#cl-unsub-box').hidden && !mode) saved.set(unsubscribe ? 'alsoRemove' : 'alsoUnsub', unsubscribe ? remove : unsub);
  if (block.length && !mode) saved.set('block', blk);
  await runJob(() => S.box.clean({
    mails: remove ? mails.map(m => m.mail) : [],
    action,
    unsubscribe: unsub ? eligible.map(s => s.email) : [],
    block: blk ? block : [],
  }));
}

function cleanRows(rows, { unsubscribe = false, mode = null } = {}) {
  const noun = F.group === 'domain' ? 'domain' : 'sender';
  const verb = mode === 'archive' ? t('archive') : t('cleanUp');
  openClean({
    title: rows.length === 1 ? `${verb} ${rows[0].label}` : `${verb} ${plural(rows.length, noun)}`,
    mails: rows.flatMap(r => r.mails),
    senders: [...new Set(rows.flatMap(r => [...r.senders]))],
    block: mode ? [] : rows.map(r => r.key),
    scope: scopeText(),
    unsubscribe,
    mode,
  });
}

function cleanSenders(title, senders, block, scope) {
  openClean({ title, mails: mailsOf(senders), senders, block, scope });
}

/** Marks the unread mails of these rows (as filtered) as read. Harmless, so no confirmation. */
function markRowsRead(rows) {
  const unread = rows.flatMap(r => r.mails).filter(m => !m.read);
  if (!unread.length) {
    toast(t('allRead'));
    return;
  }
  runJob(() => S.box.clean({ mails: unread.map(m => m.mail), action: 'read' }));
}

// ---------- Storage ----------

async function loadStorage() {
  const box = S.box;
  if (!box) return;
  let info;
  try {
    info = await box.storage();
  } catch (e) {
    if (e instanceof SignedOut) {
      signedOut(e.message);
      return;
    }
    info = { error: e.message };
  }
  if (box !== S.box) return;
  UI.storage = info;
  renderStorage();
}

/** The quota and what uses it (biggest folders, or Gmail against Drive), plus the trash and its Empty button. */
function renderStorage() {
  const st = UI.storage;
  $('#storage').hidden = !st;
  if (!st) return;
  const gmail = S.kind === 'gmail';
  const known = typeof st.used === 'number';
  const freed = st.freed > 0 ? ` <span class="ok-text">· ${t('storage.freed', size(st.freed))}</span>` : '';
  $('#st-summary').innerHTML = st.error ? `<span class="error">${esc(t('storage.error', st.error))}</span>`
    : !known ? ''
    : st.total ? `${t('storage.used', size(st.used), size(st.total), gmail ? t('storage.shared') : '')} ` +
      `<span class="muted">${t('storage.free', pct(st.used, st.total), size(Math.max(0, st.total - st.used)))}</span>${freed}`
    : `${t(gmail ? 'storage.google' : 'storage.folders', size(st.used))}${freed}`;

  const parts = (st.parts || []).filter(p => (known ? p.size : p.count) > 0);
  const items = parts.slice(0, 5).map((p, i) => ({ ...p, cls: p.name === st.trash?.name ? 'part-trash' : `part-${i}` }));
  const rest = parts.slice(5);
  if (rest.length) items.push({ name: plural(rest.length, 'moreFolder'), size: sum(rest, p => p.size || 0), count: sum(rest, p => p.count || 0), cls: 'part-rest' });
  const amount = p => (known ? size(p.size) : plural(p.count, 'mail'));
  $('#st-legend').innerHTML = items.map(p => `<span class="${p.cls}">${esc(p.name)} <b>${amount(p)}</b></span>`).join('');
  const scale = st.total || st.used;
  $('#st-meter').hidden = !known || !scale;
  $('#st-meter').innerHTML = items.map(p => `<span class="${p.cls}" title="${esc(p.name)}: ${amount(p)}"></span>`).join('');
  $$('#st-meter span').forEach((span, i) => { span.style.width = `${(100 * (items[i].size || 0)) / scale}%`; });

  const count = st.trash?.count || 0;
  $('#st-trash-row').hidden = Boolean(st.error) || !st.trash;
  $('#st-trash').innerHTML = count
    ? t('storage.trash', esc(T.trash), plural(count, 'mail'), st.trash.size ? ` (${size(st.trash.size)})` : '', esc(T.trashNote))
    : t('storage.trashEmpty', esc(T.trash));
  $('#st-empty').hidden = !count;
  $('#st-empty').textContent = t('emptyFolder', T.trash);
  $('#st-empty').disabled = UI.busy;
  $('#st-note').textContent = st.note || '';
  $('#st-note').hidden = !st.note;
  const manage = webUrl(st.manageUrl);
  $('#st-manage').hidden = !manage;
  if (manage) {
    $('#st-manage').href = manage;
    $('#st-manage').textContent = T.manage;
  }
}

function confirmBox(title, text, okText) {
  $('#cf-title').textContent = title;
  $('#cf-text').textContent = text;
  $('#cf-ok').textContent = okText;
  return ask($('#confirm'), $('#cf-ok'), $('#cf-cancel'));
}

async function emptyTrash() {
  const trash = UI.storage?.trash;
  if (!trash?.count || UI.busy) return;
  const what = `${plural(trash.count, 'mail')}${trash.size ? ` (${size(trash.size)})` : ''}`;
  // Graph deletes one mail per request, and Outlook allows roughly 1,000 a minute; Gmail deletes 1,000 per request.
  const slow = S.kind === 'outlook' && trash.count > 2000 ? t('trash.slow', duration(trash.count / 16), T.trash) : '';
  const ok = await confirmBox(t('trash.confirm', T.trash), t('trash.text', what, T.trash, T.emptyNote, slow), t('emptyFolder', T.trash));
  if (!ok) return;
  try {
    await S.box.emptyTrash();
    watchJob();
  } catch (e) {
    failed(e);
  }
}

// ---------- Jobs ----------

/** Follows the running operation. A background job (the unsubscribe lookup) leaves the app usable. */
async function watchJob() {
  if (UI.watching) return;
  UI.watching = true;
  let shown = null;   // the background job whose results are already on screen
  try {
    for (;;) {
      const job = currentJob();
      if (!job || job.reported) break;
      renderJob(job);
      setBusy(job.running && !job.background);
      if (job.running && job.background && shown !== job.id) {
        shown = job.id;
        loadMails();   // the table is ready while links are still being looked up
      }
      if (!job.running) {
        job.reported = true;
        if (job.signedOut) {
          signedOut(job.error);
          break;
        }
        if (!job.preempted) {
          if (job.error) toast(job.error, true);
          else if (job.result) toast(job.result);
          if (job.warning) toast(job.warning, true);
        }
        loadMails();
        if (job.kind === 'clean' || job.kind === 'trash') loadStorage();
        if (job.kind === 'clean') await loadFolders().catch(failed);
        if (job.manual.length) showManualLinks(job.manual);
        break;
      }
      await Promise.race([job.finished, sleep(500)]);
    }
  } finally {
    UI.watching = false;
    $('#job').hidden = true;
    setBusy(false);
  }
}

function renderJob(job) {
  $('#job').hidden = !job.running;
  $('#job-title').textContent = job.title;
  const total = Math.max(job.total, job.done);
  $('#job-bar').style.width = (total ? (100 * job.done) / total : 0).toFixed(1) + '%';
  const seconds = (Date.now() - job.startedAt) / 1000;
  const rate = seconds > 3 && job.done ? job.done / seconds : 0;
  const left = rate && total > job.done ? t('job.left', duration((total - job.done) / rate)) : '';
  $('#job-text').textContent = t('of', fmt(job.done), fmt(total)) + (job.failed ? tn('job.failed', job.failed) : '') + left;
  $('#job-note').textContent = job.note || '';
  const help = [
    job.background && t('job.background'),
    job.throttled && T.limits,
  ].filter(Boolean).join(' ');
  $('#job-help').textContent = help;
  $('#job-help').hidden = !help;
}

function setBusy(busy) {
  UI.busy = busy;
  for (const id of ['#bulk-remove', '#bulk-archive', '#bulk-unsub', '#pv-remove', '#pv-unsub', '#pv-read', '#mv-read', '#mv-archive', '#mv-delete', '#st-empty']) {
    $(id).disabled = busy;
    $(id).title = busy ? t('busy') : '';
  }
  renderScanButton();
  renderBulk();
  renderList();
}

function showManualLinks(links) {
  $('#links-list').innerHTML = links
    .filter(l => /^(https?:|mailto:)/i.test(l.url))
    .map(l => {
      const mail = /^mailto:/i.test(l.url);
      return `<li><span title="${esc(l.email)}">${esc(l.email)}</span>
        <a class="btn small" href="${esc(l.url)}"${mail ? '' : ' target="_blank"'} rel="noopener noreferrer">${mail ? t('links.mail') : t('links.open')}</a></li>`;
    })
    .join('');
  $('#links').showModal();
}

// ---------- Sender preview ----------

function openPreview(row) {
  PV.key = row.key;
  PV.byDomain = row.isDomain;
  PV.limit = 200;
  renderPreview();
  $('#preview').showModal();
  $('.scroll', $('#preview')).scrollTop = 0;
  lookupUnsub();
}

/** This sender's (or domain's) mails that pass the mail filters, newest first. */
function previewMails() {
  const passes = mailFilter();
  return M.mails.filter(m => passes(m) && keyOf(M.senders[m.s], PV.byDomain) === PV.key);
}

function previewSenders() {
  const counts = new Map();
  for (const m of PV.mails) counts.set(m.s, (counts.get(m.s) || 0) + 1);
  return [...counts.keys()].map(i => M.senders[i]).sort((a, b) => counts.get(b.i) - counts.get(a.i));
}

function renderPreview() {
  PV.mails = previewMails();
  const senders = previewSenders();
  const single = !PV.byDomain && senders.length === 1 ? senders[0] : null;
  $('#pv-title').textContent = single?.name ? `${single.name} <${single.email}>` : PV.key.replace(/^@/, '');
  renderUnsubInfo(senders);
  const preview = single?.info?.preview;
  $('#pv-latest').hidden = !preview;
  $('#pv-latest').textContent = preview ? t('pv.latest', preview) : '';

  const shown = PV.mails.slice(0, PV.limit);
  $('#pv-rows').innerHTML = shown.map((m, pos) => {
    const from = M.senders[m.s].email;
    const folder = M.folders[m.f]?.path ?? '';
    return `<tr data-pos="${pos}"${m.read ? '' : ' class="unread"'} title="${t('pv.open')}">
      <td class="nowrap">${day(m.t)}</td>
      <td class="ellipsis">${esc(from)}</td>
      <td class="ellipsis">${esc(m.subject) || `<span class="muted">${t('noSubject')}</span>`}</td>
      <td class="num size-only">${size(m.size)}</td>
      <td class="ellipsis">${esc(folder)}</td></tr>`;
  }).join('');
  const more = PV.mails.length - shown.length;
  $('#pv-more').hidden = more <= 0;
  $('#pv-more').textContent = tn('showMore', more);
  const unread = PV.mails.filter(m => !m.read).length;
  $('#pv-note').textContent = [
    PV.mails.length ? t('pv.count', plural(PV.mails.length, 'mail'), unread ? t('pv.unread', fmt(unread)) : '') : t('pv.none'),
    scopeText(),
  ].filter(Boolean).join(' ');

  const row = currentPreviewRow();
  $('#pv-add').disabled = UI.list.includes(PV.key);
  $('#pv-read').disabled = UI.busy || !unread;
  $('#pv-unsub').hidden = !senders.some(hasUnsub) && senders.every(s => s.info);
  $('#pv-remove').textContent = tn('pv.remove', PV.mails.length);
  $('#pv-remove').disabled = UI.busy || !row;
}

/** A row-like group for the preview's mails, for the cleanup dialog. */
function currentPreviewRow() {
  if (!PV.mails.length) return null;
  const g = { key: PV.key, isDomain: PV.byDomain, senders: new Set(PV.mails.map(m => M.senders[m.s])), mails: PV.mails };
  g.label = PV.byDomain ? PV.key.slice(1) : [...g.senders][0].label;
  return g;
}

function renderUnsubInfo(senders) {
  const box = $('#pv-unsub-info');
  const shown = senders.slice(0, 8);
  if (!shown.length) {
    box.hidden = true;
    return;
  }
  const line = s => {
    const who = PV.byDomain ? `<span class="who">${esc(s.email)}</span> ` : '';
    if (!s.info) return `<li>${who}<span class="muted">${t('unsub.checking')}</span></li>`;
    const url = webUrl(s.info.url);
    const mailto = /^mailto:/i.test(s.info.mailto || '') ? s.info.mailto : null;
    if (!url && !mailto) return `<li>${who}<span class="muted">${t('unsub.none')}</span></li>`;
    const how = s.info.oneClick ? t('unsub.oneClick') : '';
    const links = [
      url && `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${t('unsub.page')}</a>`,
      mailto && `<a href="${esc(mailto)}" rel="noopener noreferrer" title="${esc(mailto)}">${t('unsub.mail')}</a>`,
    ].filter(Boolean).join(t('unsub.or'));
    return `<li>${who}${how} ${links}</li>`;
  };
  box.innerHTML = `<b>${t('unsubscribe')}</b><ul>${shown.map(line).join('')}</ul>` +
    `<p class="muted small">${t('unsub.careful')}</p>`;
  box.hidden = false;
}

/** Looks up the unsubscribe info of the preview's senders that the scan didn't check. */
async function lookupUnsub() {
  const key = PV.key;
  for (const s of previewSenders().filter(x => !x.info && x.host).slice(0, 4)) {
    try {
      s.info = await S.box.sender(s.email);
      scoreSender(s);
    } catch {
      return;   // busy with an operation; the scan's lookup or a later visit fills it in
    }
    if (PV.key !== key || !$('#preview').open) return;
    renderPreview();
  }
}

// ---------- Mail viewer ----------

function openMail(list, pos) {
  MV.list = list;
  MV.pos = pos;
  MV.images = false;
  if (!$('#mail').open) $('#mail').showModal();
  showMail();
}

const viewedMail = () => M.byMail.get(MV.list[MV.pos]);

function renderMailHeader() {
  const m = viewedMail();
  if (!m) return;
  const s = M.senders[m.s];
  $('#mv-subject').textContent = m.subject || t('noSubject');
  if (!$('#mv-from').textContent) $('#mv-from').textContent = s.name ? `${s.name} <${s.email}>` : s.email;
  $('#mv-meta').textContent = [dateTime(m.t), M.folders[m.f]?.path, M.sizes && size(m.size), m.attach && t('mv.attach')]
    .filter(Boolean).join(' · ');
  $('#mv-pos').textContent = t('of', fmt(MV.pos + 1), fmt(MV.list.length));
  $('#mv-newer').disabled = MV.pos <= 0;
  $('#mv-older').disabled = MV.pos >= MV.list.length - 1;
  $('#mv-read').textContent = m.read ? t('mv.unread') : t('mv.read');
  $('#mv-archive').hidden = !S.box.provider.canArchive || ['archive', 'all'].includes(M.folders[m.f]?.wellKnown);
}

async function showMail() {
  const m = viewedMail();
  if (!m) {
    $('#mail').close();
    return;
  }
  const ticket = ++MV.loading;
  MV.body = null;
  $('#mv-from').textContent = '';
  $('#mv-to').textContent = '';
  $('#mv-web').hidden = true;
  $('#mv-images').hidden = MV.images;
  $('#mv-status').textContent = t('mv.loading');
  $('#mv-body').srcdoc = '';
  renderMailHeader();
  try {
    const d = await S.box.provider.body(m.mail);
    if (ticket !== MV.loading) return;
    MV.body = d;
    $('#mv-from').textContent = d.from || $('#mv-from').textContent;
    $('#mv-to').textContent = d.to ? t('mv.to', d.to) : '';
    const web = webUrl(d.webLink);
    $('#mv-web').hidden = !web;
    if (web) $('#mv-web').href = web;
    $('#mv-body').srcdoc = mailPage(d, MV.images, NATIVE);
    $('#mv-status').textContent = '';
    renderMailHeader();
  } catch (e) {
    if (ticket !== MV.loading) return;
    if (e instanceof SignedOut) signedOut(e.message);
    else $('#mv-status').textContent = e.message;
  }
}

/** One quick change to the mail on screen, then the next mail when it left this list. */
async function actOnMail(action) {
  const m = viewedMail();
  if (!m) return;
  try {
    const r = await S.box.act([m.mail], action);
    if (r.failed) toast(t('mv.failed'), true);
    loadMails();
  } catch (e) {
    failed(e);
    return;
  }
  if (action === 'trash' || action === 'delete') {
    MV.list.splice(MV.pos, 1);
    if (MV.pos >= MV.list.length) MV.pos = MV.list.length - 1;
    if (MV.pos < 0) $('#mail').close();
    else showMail();
  } else {
    if (action === 'archive') toast(t('mv.archived'));
    renderMailHeader();
  }
}

// ---------- Let an AI choose ----------

const oneLine = s => String(s ?? '').replace(/[\s|]+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '\u2026' : s);
/** How a sender offers to unsubscribe: oneClick, link, none, or ? when not checked. */
const unsubKind = s => (!s.info ? '?' : s.info.oneClick ? 'oneClick' : hasUnsub(s) ? 'link' : 'none');
const unsubWord = s => (s.info ? t(`unsubKind.${unsubKind(s)}`) : '?');
// The CSV columns are for other programs, so their values stay the same in every language.
const UNSUB_CSV = { '?': '?', oneClick: 'one-click', link: 'link', none: 'none' };

function exportSenders() {
  const scope = $('#ex-scope').value;
  const list = (scope === 'view' ? [...new Set(UI.rows.flatMap(r => [...r.senders]))] : [...M.senders]).filter(s => s.host);
  if (scope === 'count' || scope === 'size') return list.sort((a, b) => b[scope] - a[scope]).slice(0, 250);
  return list;
}

function buildPrompt(senders, { subjects, preview, notes }) {
  const unread = t('col.unread');
  const inJunk = t('col.in', T.junk);
  const inOther = T.other && t('col.in', T.other);
  const unsub = t('col.unsub');
  const columns = [t('col.address'), t('col.name'), t('col.mails'), ...(M.sizes ? [t('col.space')] : []), unread, inJunk,
    ...(inOther ? [inOther] : []), unsub, t('col.latest')];
  if (subjects) columns.push(t('col.subjects'));
  if (preview) columns.push(t('col.preview'));
  const row = cells => `| ${cells.map(c => String(c).replace(/\|/g, '\\|')).join(' | ')} |`;
  const rows = senders.map(s => {
    const cells = [s.email, clip(oneLine(s.name), 40) || '-', s.count, ...(M.sizes ? [size(s.size)] : []),
      `${pct(s.unread, s.count)}%`, s.junk, ...(inOther ? [`${pct(s.other, s.count)}%`] : []), unsubWord(s), isoDay(s.latest)];
    if (subjects) cells.push(s.subjects.map(x => clip(oneLine(x), 70)).join(' ; ') || '-');
    if (preview) cells.push(clip(oneLine(s.info?.preview), 160) || '-');
    return row(cells);
  });
  return [
    t('ai.title') + watermark(),
    '',
    t('ai.intro'),
    '',
    t('ai.remove'),
    t('ai.keep'),
    t('ai.unsure'),
    t('ai.data'),
    ...(notes.trim() ? ['', t('ai.rules'), '', t('ai.rulesWin'), '', notes.trim()] : []),
    '',
    t('ai.senders'),
    '',
    t('ai.unread', unread),
    t('ai.junk', inJunk, T.junk),
    ...(inOther ? [t('ai.other', inOther, T.otherAi)] : []),
    t('ai.unsub', unsub, t('unsubKind.oneClick'), t('unsubKind.link'), t('unsubKind.none')),
    '',
    '<<<DATA',
    '',
    row(columns),
    row(columns.map(() => '---')),
    ...rows,
    '',
    'DATA>>>',
    '',
    t('ai.answer'),
    '',
    t('ai.parts'),
    t('ai.part1'),
    t('ai.part2'),
  ].join('\n');
}

function renderExport() {
  const senders = exportSenders();
  const options = { subjects: $('#ex-subjects').checked, preview: $('#ex-preview').checked, notes: $('#ex-notes').value };
  const text = buildPrompt(senders, options);
  $('#ex-text').value = text;
  $('#ex-size').textContent = t('ex.size', plural(senders.length, 'sender'), plural(sum(senders, s => s.count), 'mail'),
    fmt(text.length), fmt(Math.ceil(text.length / 4))) + (text.length > 20000 ? t('ex.long') : '') + t('ex.fewer');
  saved.set('ai', { scope: $('#ex-scope').value, ...options });
}

function openExport() {
  const prefs = saved.get('ai', {});
  const scopes = $$('#ex-scope option').filter(o => M.sizes || !o.classList.contains('size-only')).map(o => o.value);
  $('#ex-scope').value = scopes.includes(prefs.scope) ? prefs.scope : 'count';
  $('#ex-subjects').checked = prefs.subjects !== false;
  $('#ex-preview').checked = prefs.preview === true;
  $('#ex-preview').disabled = !M.senders.some(s => s.info?.preview);
  $('#ex-notes').value = prefs.notes || '';
  renderExport();
  $('#export').showModal();
}

async function copyExport() {
  const text = $('#ex-text').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $('#ex-text').select();
    document.execCommand('copy');
  }
  toast(t('ex.copied'));
}

function csvCell(value) {
  if (typeof value === 'number') return String(value);
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // subjects come from strangers: don't let Excel run them as formulas
  return `"${s.replace(/"/g, '""')}"`;
}

/** Saves an export: a download in a browser, a file in Downloads in the desktop edition. Resolves to its path when known. */
async function saveFile(name, text, type) {
  if (NATIVE) return (await shell('save', { name, text })).path;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return '';
}

function downloadCsv(name, rows) {
  const csv = '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  saveFile(`${name}-${isoDay(Date.now())}.csv`, csv, 'text/csv;charset=utf-8')
    .then(path => path && toast(t('savedTo', path)), e => toast(e.message, true));
}

/** For prompts too long to paste: most AI chats take an attached file. */
function downloadPrompt() {
  saveFile(`mail-cleaner-ai-${isoDay(Date.now())}.md`, $('#ex-text').value, 'text/markdown;charset=utf-8')
    .then(path => toast(t('ex.saved', path ? t('ex.savedTo', path) : '')), e => toast(e.message, true));
}

function downloadSendersCsv() {
  const rows = [['email', 'name', 'domain', 'mails', 'size_bytes', 'unread', 'in_junk', 'in_other', 'latest', 'spam_score',
    'unsubscribe', 'unsubscribe_url', 'unsubscribe_mailto', 'recent_subjects', 'latest_preview']];
  for (const s of M.senders) {
    rows.push([s.email, s.name, s.domain, s.count, s.size, s.unread, s.junk, s.other, isoDay(s.latest), s.score,
      UNSUB_CSV[unsubKind(s)], s.info?.url ?? '', s.info?.mailto ?? '', s.subjects.join(' | '), s.info?.preview ?? '']);
  }
  downloadCsv(`${S.kind}-senders`, rows);
}

function downloadMailsCsv() {
  const rows = [['received', 'from', 'name', 'subject', 'folder', 'size_bytes', 'read', 'inbox_tab', 'attachments']];
  for (const m of M.mails) {
    const s = M.senders[m.s];
    rows.push([new Date(m.t).toISOString(), s.email, s.name, m.subject, M.folders[m.f]?.path ?? '', m.size,
      m.read ? 'yes' : 'no', m.other ? 'other' : 'focused', m.attach ? 'yes' : 'no']);
  }
  downloadCsv(`${S.kind}-mails`, rows);
}

/** Addresses and @domains from the AI's answer; only its code blocks count when it has any. */
function parseAiAnswer(text) {
  const answer = text.replace(/<<<DATA[\s\S]*?DATA>>>/g, ' ');   // in case the whole chat was pasted
  const blocks = [...answer.matchAll(/```[^\n]*\n?([\s\S]*?)```/g)].map(m => m[1]);
  const source = (blocks.length ? blocks.join('\n') : answer).toLowerCase();
  const found = new Set();
  for (const m of source.matchAll(/[a-z0-9._%+'-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g)) found.add(m[0].replace(/^['.]+/, ''));
  if (blocks.length) {
    for (const line of source.split('\n')) {
      const bare = line.trim().replace(/^[-*\u2022]\s*/, '');
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(bare)) found.add('@' + bare);   // "example.com" inside the list means the domain
    }
  }
  return { keys: [...found], fromCodeBlock: blocks.length > 0 };
}

function renderImport() {
  const text = $('#im-text').value;
  const { keys, fromCodeBlock } = parseAiAnswer(text);
  $('#im-note').textContent = !text.trim() ? ''
    : !keys.length ? t('im.none')
    : fromCodeBlock ? tn('im.found', keys.length)
    : t('im.noBlock');
  $('#im-list').innerHTML = keys.map(key => {
    const senders = listSenders([key]);
    const count = sum(senders, s => s.count);
    const opened = count ? 100 - pct(sum(senders, s => s.unread), count) : 0;
    const listed = UI.list.includes(key);
    const shared = key.startsWith('@') && SHARED_PROVIDERS.has(key.slice(1));
    const risky = !listed && (shared || (count > 0 && opened >= 50));
    const info = listed ? t('im.listed')
      : shared ? t('im.shared')
      : count ? t('im.opened', plural(count, 'mail'), opened) + (risky ? t('im.sure') : '')
      : t('im.noMail');
    const checked = !listed && fromCodeBlock && !risky;
    return `<label class="option"><input type="checkbox" value="${esc(key)}"${listed ? ' disabled' : ''}${checked ? ' checked' : ''}>
      <span>${esc(key)} <span class="${risky ? 'warn-text' : 'muted'}">${esc(info)}</span></span></label>`;
  }).join('');
  renderImportButton();
}

const importKeys = () => $$('#im-list input:checked').map(box => box.value);

function renderImportButton() {
  const keys = importKeys();
  $('#im-add').disabled = !keys.length;
  $('#im-add').textContent = keys.length
    ? t('im.add', plural(keys.length, 'entry'), plural(sum(listSenders(keys), s => s.count), 'mail'))
    : t('im.addNone');
}

function openImport() {
  $('#im-text').value = '';
  renderImport();
  $('#import').showModal();
  $('#im-text').focus();
}

// ---------- Wiring ----------

/** The privacy policy over the app, so reading it doesn't lose a scan. Its links open in a new tab. */
async function openPrivacy() {
  const res = await fetch(t('privacy.page'));
  if (!res.ok) throw new Error(t('privacy.failed', res.status));
  const article = new DOMParser().parseFromString(await res.text(), 'text/html').querySelector('article');
  article.querySelector('h1')?.remove();
  for (const link of article.querySelectorAll('a[href]')) Object.assign(link, { target: '_blank', rel: 'noopener noreferrer' });
  $('#privacy-body').replaceChildren(...article.children);
  $('#privacy').showModal();
}

function wireConnect() {
  $('#providers').addEventListener('click', e => {
    const kind = e.target.closest('[data-provider]')?.dataset.provider;
    if (kind) showConnect(kind);
  });
  $('#login').addEventListener('click', async () => {
    const auth = S.auth;
    if (!auth) return;
    showError('#login-error', '');
    $('#login').disabled = true;
    saved.set('provider', S.kind);
    // The desktop edition waits for the user's browser, which can take a while, so it can be cancelled.
    const waiting = NATIVE ? new AbortController() : null;
    S.signingIn = waiting;
    $('#login-wait').hidden = !waiting;
    try {
      await auth.signIn(waiting?.signal);   // Google's window opens before the first await; Microsoft leaves the page and comes back
      if (auth.signedIn && auth === S.auth) await enter();
    } catch (e) {
      if (!isAbort(e)) showError('#login-error', e.message);
    } finally {
      if (S.signingIn === waiting) S.signingIn = null;
      $('#login').disabled = false;
      $('#login-wait').hidden = true;
    }
  });
  $('#login-cancel').addEventListener('click', () => S.signingIn?.abort());
  $('#app-form').addEventListener('submit', e => {
    e.preventDefault();
    const kind = S.kind;
    const clientId = $('#client-id').value.trim();
    const secret = $('#client-secret').value.trim();
    const problem = kind === 'gmail'
      ? !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId) && t('app.notGoogle')
      : !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(clientId) && t('app.notMicrosoft');
    if (problem) {
      showError('#app-error', problem);
      return;
    }
    saveApp(kind, kind !== 'gmail' ? { clientId, tenant: $('#tenant').value } : NATIVE ? { clientId, secret } : { clientId });
    showConnect(kind);
    toast(t('app.saved', t(`${kind}.company`)));
  });
  $('#app-default').addEventListener('click', () => {
    saveApp(S.kind, null);
    showConnect(S.kind);
  });
  $('#imap-form').addEventListener('submit', async e => {
    e.preventDefault();
    const button = $('#imap-save');
    button.disabled = true;
    button.textContent = t('imap.checking');
    showError('#imap-error', '');
    try {
      await bridge('setup', {
        email: $('#imap-email').value, user: $('#imap-user').value, host: $('#imap-host').value,
        port: Number($('#imap-port').value) || 993, security: $('#imap-security').value, password: $('#imap-password').value,
      });
      $('#imap-password').value = '';
      S.bridge = await bridgeState();
      S.auth = makeAuth('imap');
      await enter();
    } catch (err) {
      showError('#imap-error', err.message);
    } finally {
      button.disabled = false;
      button.textContent = t('imap.connect');
    }
  });
  $('#imap-email').addEventListener('change', findImapServer);
  $('#imap-host').addEventListener('input', () => { $('#imap-host').dataset.auto = ''; });
  $('#logout').addEventListener('click', async () => {
    const auth = S.auth;
    leave();
    try {
      await auth?.signOut();
    } catch (e) {
      toast(e.message, true);
    }
    await backToConnect();
  });
}

function wire() {
  wireConnect();
  // On the website, Ctrl or Shift and a click still open the page itself.
  document.addEventListener('click', e => {
    if (!e.target.closest?.('a[data-privacy]') || (!NATIVE && (e.ctrlKey || e.metaKey || e.shiftKey))) return;
    e.preventDefault();
    openPrivacy().catch(err => toast(err.message, true));
  });
  $('#folders').addEventListener('change', e => {
    const box = e.target;
    if (box.type !== 'checkbox') return;
    if (box.checked) UI.folderSel.add(box.value);
    else UI.folderSel.delete(box.value);
    box.closest('.chip').classList.toggle('on', box.checked);
    saved.set('folders', [...UI.folderSel]);
    renderScanButton();
  });
  $('#more-folders').addEventListener('click', () => {
    UI.showAllFolders = !UI.showAllFolders;
    renderFolders();
  });
  $('#scan').addEventListener('click', startScan);
  $('#job-cancel').addEventListener('click', () => currentJob()?.cancel());
  $('#st-empty').addEventListener('click', emptyTrash);

  $('#stats').addEventListener('click', e => {
    const show = e.target.closest('[data-show]')?.dataset.show;
    if (show) {
      F.chips = new Set([show]);
      refilter();
      $('#results').scrollIntoView({ behavior: 'smooth' });
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'spam') {
      const spam = M.senders.filter(s => s.score >= SPAM_THRESHOLD);
      cleanSenders(t('spam.title', plural(spam.length, 'spamSender')), spam, spam.map(s => s.email), t('anyAge'));
    }
    if (act === 'junk') {
      openClean({ title: t('emptyFolder', T.junk), who: t('junk.who', T.junk), mails: M.mails.filter(m => m.f === M.junk) });
    }
  });

  $('#group').addEventListener('click', e => {
    const group = e.target.closest('button')?.dataset.group;
    if (!group || group === F.group) return;
    F.group = group;
    UI.selected.clear();
    refilter();
  });
  $('#search').addEventListener('input', debounce(() => {
    F.q = $('#search').value.trim().toLowerCase();
    refilter();
  }, 150));
  $('#chips').addEventListener('click', e => {
    const chip = e.target.closest('[data-chip]')?.dataset.chip;
    if (!chip) return;
    if (F.chips.has(chip)) F.chips.delete(chip);
    else F.chips.add(chip);
    refilter();
  });
  const filterSelect = (id, apply) => $(id).addEventListener('change', e => {
    apply(Number(e.target.value));
    refilter();
  });
  filterSelect('#f-age', v => { F.age = v; });
  filterSelect('#f-mails', v => { F.minMails = v; });
  filterSelect('#f-total', v => { F.minTotal = v * MB; });
  filterSelect('#f-mailsize', v => { F.mailSize = v * MB; });
  $('#f-reset').addEventListener('click', resetFilters);

  $('thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    F.sort = { key, dir: F.sort.key === key ? -F.sort.dir : key === 'label' ? 1 : -1 };
    renderTable();
  });
  $('#sel-all').addEventListener('change', e => {
    for (const r of UI.rows) {
      if (e.target.checked) UI.selected.add(r.key);
      else UI.selected.delete(r.key);
    }
    renderTable();
  });
  $('#rows').addEventListener('change', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr || e.target.type !== 'checkbox') return;
    if (e.target.checked) UI.selected.add(tr.dataset.key);
    else UI.selected.delete(tr.dataset.key);
    tr.classList.toggle('sel', e.target.checked);
    $('#sel-all').checked = UI.rows.every(r => UI.selected.has(r.key));
    renderBulk();
  });
  $('#rows').addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const key = e.target.closest('tr[data-key]')?.dataset.key;
    const row = act && UI.rows.find(r => r.key === key);
    if (!row) return;
    if (act === 'view') openPreview(row);
    if (act === 'remove') cleanRows([row]);
  });
  $('#show-more').addEventListener('click', () => {
    UI.limit += PAGE;
    renderTable();
  });

  $('#bulk-remove').addEventListener('click', () => cleanRows(selectedRows()));
  $('#bulk-archive').addEventListener('click', () => cleanRows(selectedRows(), { mode: 'archive' }));
  $('#bulk-read').addEventListener('click', () => markRowsRead(selectedRows()));
  $('#bulk-unsub').addEventListener('click', () => cleanRows(selectedRows(), { unsubscribe: true }));
  $('#bulk-add').addEventListener('click', () => {
    addToList(selectedRows().map(r => r.key));
    UI.selected.clear();
    renderTable();
  });
  $('#bulk-clear').addEventListener('click', () => {
    UI.selected.clear();
    renderTable();
  });

  $('#pv-rows').addEventListener('click', e => {
    const pos = Number(e.target.closest('tr[data-pos]')?.dataset.pos);
    if (Number.isInteger(pos)) openMail(PV.mails.map(m => m.mail), pos);
  });
  $('#pv-more').addEventListener('click', () => {
    PV.limit += 500;
    renderPreview();
  });
  $('#pv-add').addEventListener('click', () => {
    $('#preview').close();
    addToList([PV.key]);
  });
  $('#pv-read').addEventListener('click', () => {
    const row = currentPreviewRow();
    if (row) markRowsRead([row]);
  });
  const cleanPreview = options => {
    const row = currentPreviewRow();
    $('#preview').close();
    if (row) cleanRows([row], options);
  };
  $('#pv-unsub').addEventListener('click', () => cleanPreview({ unsubscribe: true }));
  $('#pv-remove').addEventListener('click', () => cleanPreview());

  $('#mv-newer').addEventListener('click', () => {
    MV.pos--;
    showMail();
  });
  $('#mv-older').addEventListener('click', () => {
    MV.pos++;
    showMail();
  });
  $('#mv-read').addEventListener('click', () => actOnMail(viewedMail()?.read ? 'unread' : 'read'));
  $('#mv-archive').addEventListener('click', () => actOnMail('archive'));
  $('#mv-delete').addEventListener('click', () => actOnMail('trash'));
  $('#mv-images').addEventListener('click', () => {
    MV.images = true;
    $('#mv-images').hidden = true;
    if (MV.body) $('#mv-body').srcdoc = mailPage(MV.body, true, NATIVE);
  });
  $('#mail').addEventListener('close', () => {
    MV.loading++;
    MV.body = null;
    $('#mv-body').srcdoc = '';
  });

  $('#add-form').addEventListener('submit', e => {
    e.preventDefault();
    const { ok, bad } = parseEntries($('#add-input').value);
    if (ok.length) addToList(ok);
    $('#add-input').value = bad.join(' ');
    if (bad.length) toast(t('add.bad', bad.join(', ')), true);
    else if (!ok.length) toast(t('add.hint'), true);
  });
  $('#list').addEventListener('click', e => {
    if (!e.target.closest('.x')) return;
    const key = e.target.closest('li').dataset.key;
    UI.list = UI.list.filter(k => k !== key);
    saved.set('list', UI.list);
    renderList();
  });
  $('#list-clean').addEventListener('click', () => {
    const senders = listSenders(UI.list);
    cleanSenders(t('list.title'), senders, UI.list, t('anyAge'));
  });

  $('#ai-export').addEventListener('click', openExport);
  for (const id of ['#ex-scope', '#ex-subjects', '#ex-preview']) $(id).addEventListener('change', renderExport);
  $('#ex-notes').addEventListener('input', debounce(renderExport, 200));
  $('#ex-copy').addEventListener('click', copyExport);
  $('#ex-download').addEventListener('click', downloadPrompt);
  $('#ex-csv-senders').addEventListener('click', downloadSendersCsv);
  $('#ex-csv-mails').addEventListener('click', downloadMailsCsv);

  $('#ai-import').addEventListener('click', openImport);
  $('#im-text').addEventListener('input', debounce(renderImport, 150));
  $('#im-list').addEventListener('change', renderImportButton);
  $('#im-add').addEventListener('click', () => {
    const keys = importKeys();
    $('#import').close();
    addToList(keys);
  });

  for (const button of $$('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
  for (const dialog of $$('dialog')) closeOutside(dialog);
  $('#lang').addEventListener('click', e => {
    const choice = e.target.closest('[data-lang]')?.dataset.lang;
    if (!choice || choice === lang()) return;
    saved.set('lang', setLang(choice));
    showLanguage();
  });
}

/**
 * A click on the dimmed backdrop closes a dialog, as Escape does, which also answers Cancel or Stop. A drag that only
 * ends outside, selecting text, doesn't: the press has to start outside too.
 */
function closeOutside(dialog) {
  const outside = e => {
    const r = dialog.getBoundingClientRect();
    return e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', e => { pressedOutside = outside(e); });
  dialog.addEventListener('click', e => {
    if (pressedOutside && outside(e)) dialog.close();
    pressedOutside = false;
  });
}

// ---------- Language ----------

/** Puts the page, and everything the scripts wrote into it, in the interface language. */
function showLanguage() {
  translatePage(document);
  // Translated parts are rebuilt, so the edition's parts and the links are set again.
  for (const el of $$('[data-only]')) el.hidden = el.dataset.only !== (NATIVE ? 'desktop' : 'web');
  for (const button of $$('#lang [data-lang]')) button.classList.toggle('on', button.dataset.lang === lang());
  for (const link of $$('a[data-privacy]')) link.href = t('privacy.page');
  fillAbout();
  if (NATIVE) shell('lang', { lang: lang() }).catch(() => {});
  if (!$('#view-connect').hidden) connectTexts();
  if (!S.box) return;
  setProvider(S.box.provider);
  renderFolders();
  loadMails();
  // Its notes and names come from the mail service's side, in the language asked for.
  loadStorage();
}

// ---------- Desktop edition ----------

/** Opens a link in the user's browser or mail app: the desktop app's webview can't open windows of its own. */
function openOutside(url) {
  shell('open', { url }).catch(e => toast(e.message, true));
}

function initDesktop() {
  // Links go to the user's browser. The app's own pages have no address outside the app.
  document.addEventListener('click', e => {
    const link = e.target.closest?.('a[href]');
    if (!link || e.defaultPrevented) return;
    const url = new URL(link.getAttribute('href'), location.href);
    if (url.origin === location.origin) return;
    e.preventDefault();
    openOutside(url.href);
  });
  // A file dropped on a webview replaces the app with that file.
  document.addEventListener('dragover', e => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
  document.addEventListener('drop', e => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  // Webviews don't all close a dialog on Escape, and a focused mail frame keeps the key to itself.
  const closeTopDialog = () => $$('dialog[open]').at(-1)?.close();
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    closeTopDialog();
  });
  // Mail frames may only run the relay (mailPage), which hands clicked links and Escape over here.
  $('#mv-body').sandbox.value = 'allow-scripts';
  window.addEventListener('message', e => {
    if (e.source !== $('#mv-body').contentWindow) return;
    if (typeof e.data?.mailLink === 'string') openOutside(e.data.mailLink);
    if (e.data?.mailKey === 'Escape') closeTopDialog();
  });
}

async function start() {
  setLang(saved.get('lang') || langForBrowser(navigator.languages));
  // Never run inside another site's frame: it could trick you into clicking Remove.
  if (window.top !== window.self) {
    document.body.textContent = t('frame');
    return;
  }
  showLanguage();
  if (NATIVE) initDesktop();
  wire();
  [S.defaults, S.bridge] = await Promise.all([loadDefaults(), bridgeState()]);
  initAbout(S.defaults);
  try {
    const ms = await Microsoft.complete();   // back from Microsoft's sign-in page?
    if (ms) {
      S.kind = 'outlook';
      S.auth = ms;
      await enter();
      return;
    }
  } catch (e) {
    showConnect('outlook', e.message);
    return;
  }
  let kind = saved.get('provider', 'outlook');
  if (!KINDS.includes(kind) || (kind === 'imap' && !S.bridge)) kind = 'outlook';
  S.kind = kind;
  S.auth = makeAuth(kind);
  if (S.auth?.signedIn) await enter();   // still signed in, in this tab
  else showConnect(kind);
}

// The page stays hidden (booting) until it shows a view; whatever goes wrong on the way, it doesn't stay blank.
start().finally(() => document.documentElement.classList.remove('booting'));
