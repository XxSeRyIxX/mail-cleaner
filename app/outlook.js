// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

// Outlook.com and Microsoft 365 mailboxes, through Microsoft Graph.

import { RestClient, ServiceError, pool, pause, sleep, backoff, isTransient, parseUnsubscribe, plural } from './mail.js';
import { t } from './i18n.js';

const GRAPH = 'https://graph.microsoft.com/v1.0/';
const PAGE = 500;
const READERS = 4;   // Outlook allows 4 concurrent requests per mailbox
const SLOW = 'outlook.slow';   // what to tell the user while waiting, by its i18n.js name
const BUSY = 'outlook.busy';
// Found again by these names, so they stay the same in every language.
const RULE = 'Mail Cleaner: blocked senders';
const OLD_RULE = 'Outlook Cleaner: blocked senders';   // the app's name before it handled Gmail
const MAIL_FIELDS = 'id,from,subject,receivedDateTime,isRead,inferenceClassification,hasAttachments';
const FOLDER_FIELDS = 'id,displayName,childFolderCount,totalItemCount,unreadItemCount';
// Graph has no size property; these ask for the MAPI ones (PidTagMessageSize, PidTagMessageSizeExtended).
const SIZE = {
  mail: "&$expand=singleValueExtendedProperties($filter=id%20eq%20'Integer%200x0E08')",
  folder: "&$expand=singleValueExtendedProperties($filter=id%20eq%20'Long%200x0E08')",
};
// The mailbox quota in KB: PidTagProhibitReceiveQuota, PidTagProhibitSendQuota, PidTagStorageQuotaLimit.
const QUOTA_TAGS = [0x666a, 0x666e, 0x3ff5];
const QUOTA = "?$select=id&$expand=singleValueExtendedProperties($filter=id%20eq%20'Integer%200x666A'" +
  "%20or%20id%20eq%20'Integer%200x666E'%20or%20id%20eq%20'Integer%200x3FF5')";
const WELL_KNOWN = ['inbox', 'junkemail', 'archive', 'deleteditems', 'sentitems', 'drafts', 'outbox'];
const PINNED = ['inbox', 'junkemail', 'archive'];
const NOT_SCANNED = new Set(['deleteditems', 'sentitems', 'drafts', 'outbox']);
const enc = encodeURIComponent;

export class Outlook {
  kind = 'outlook';
  canDelete = true;
  canBlock = true;
  scanFindsUnsubscribe = false;
  archiveId = null;
  sizes = { mail: true, folder: true };   // switched off if Graph rejects the size properties

  /** `auth` is the Microsoft sign-in: token(force), and personal for outlook.com accounts. */
  constructor(auth) {
    this.auth = auth;
    this.api = new RestClient({ base: GRAPH, name: 'Microsoft Graph', token: force => auth.token(force), slow: SLOW, busy: BUSY });
  }

  get canArchive() {
    return this.archiveId != null;
  }

  get trashName() {
    return t('outlook.trash');
  }

  get blockName() {
    return t('outlook.blockName');
  }

  /** Up to 20 requests in one JSON batch. Graph runs at most 4 of them at a time, Outlook's per-mailbox limit. */
  async batch(requests, job, signal) {
    const data = await this.api.send('POST', '$batch', { body: { requests: requests.map((r, i) => ({ id: String(i), ...r })) }, job, signal });
    // Graph answers every request; if one is ever missing, treat it as "try again".
    const results = requests.map(() => ({ status: 503, ok: false, body: null, retryAfter: null }));
    for (const r of data.responses || []) {
      const i = Number(r.id);
      if (!(i >= 0 && i < results.length)) continue;
      const wait = Number(Object.entries(r.headers || {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]);
      results[i] = { status: r.status, ok: r.status >= 200 && r.status < 300, body: r.body ?? null, retryAfter: wait >= 0 ? wait * 1000 : null };
    }
    return results;
  }

  /** One request per item in batches of 20, retrying throttled ones and slowing down while Outlook keeps throttling. */
  async forEachBatch(items, request, done, job) {
    const signal = job?.signal;
    const queue = [...items];
    const tries = new Map();
    let pace = 0;
    while (queue.length) {
      signal?.throwIfAborted();
      if (pace) await sleep(pace, signal);
      const chunk = queue.splice(0, 20);
      const results = await this.batch(chunk.map(request), job, signal);
      let wait = 0;
      let throttled = false;
      chunk.forEach((item, i) => {
        const r = results[i];
        const attempt = (tries.get(item) || 0) + 1;
        if (isTransient(r.status) && attempt <= 20) {
          tries.set(item, attempt);
          queue.push(item);
          throttled ||= r.status === 429;
          wait = Math.max(wait, r.retryAfter ?? backoff(Math.min(attempt, 5)));
          return;
        }
        done(item, r);
        job?.add(1);
      });
      pace = throttled ? Math.min(Math.max(pace * 2, 1000), 10000) : pace < 500 ? 0 : pace / 2;
      if (wait) await pause(wait, throttled ? SLOW : BUSY, job, signal);
    }
  }

  async getAll(url, job, signal = job?.signal) {
    const items = [];
    for (let next = url; next; ) {
      const page = await this.api.get(next, { job, signal });
      items.push(...(page.value || []));
      next = page['@odata.nextLink'] || null;
    }
    return items;
  }

  async folders(signal) {
    const rank = f => (PINNED.includes(f.wellKnown) ? PINNED.indexOf(f.wellKnown) : PINNED.length);
    return (await this.allFolders(signal))
      .filter(n => !n.notScanned)
      .map(n => n.folder)
      .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  }

  /** Every folder, with the id of the top-level folder it sits in and whether the scan leaves it out. */
  async allFolders(signal) {
    // Folder names are localized ("Bandeja de entrada"...), so special folders are looked up by their well-known name.
    const found = await this.batch(WELL_KNOWN.map(name => ({ method: 'GET', url: `/me/mailFolders/${name}?$select=id` })), null, signal);
    const known = new Map();
    found.forEach((r, i) => {
      if (r.ok && r.body?.id) known.set(r.body.id, WELL_KNOWN[i]);
    });
    this.archiveId = [...known].find(([, name]) => name === 'archive')?.[0] ?? null;

    const nodes = [];
    const levels = [{ url: `me/mailFolders?$top=250&$select=${FOLDER_FIELDS}`, prefix: '', top: null, notScanned: false }];
    while (levels.length) {
      const level = levels.shift();
      for (const f of await this.withSizes('folder', level.url, url => this.getAll(url, null, signal))) {
        const wellKnown = known.get(f.id) ?? null;
        const name = f.displayName || '';
        const path = level.prefix + name;
        const top = level.top ?? f.id;
        const notScanned = level.notScanned || NOT_SCANNED.has(wellKnown);
        nodes.push({
          folder: { id: f.id, name, path, total: f.totalItemCount || 0, unread: f.unreadItemCount || 0, size: extendedNumber(f), wellKnown },
          top,
          notScanned,
        });
        if (f.childFolderCount > 0) {
          levels.push({ url: `me/mailFolders/${enc(f.id)}/childFolders?$top=250&$select=${FOLDER_FIELDS}`, prefix: path + ' / ', top, notScanned });
        }
      }
    }
    return nodes;
  }

  /** Gets `url` asking for the mail or folder sizes, until Graph rejects that once. */
  async withSizes(kind, url, get) {
    if (this.sizes[kind] && !url.startsWith('https://')) {   // nextLinks already carry the $expand of their request
      try {
        return await get(url + SIZE[kind]);
      } catch (e) {
        if (e.status !== 400) throw e;
        this.sizes[kind] = false;
      }
    }
    return get(url);
  }

  async read(folders, found, job) {
    // Folder sizes are known, so every page can be fetched at once with $skip.
    const pages = folders.flatMap(folder =>
      Array.from({ length: Math.max(1, Math.ceil(folder.total / PAGE)) }, (_, p) => ({ folder, skip: p * PAGE })));
    await pool(pages, READERS, async ({ folder, skip }) => {
      // Only the last page follows nextLink, to catch mail that arrived after the folder was counted.
      const last = skip + PAGE >= folder.total;
      let url = `me/mailFolders/${enc(folder.id)}/messages?$select=${MAIL_FIELDS}&$orderby=receivedDateTime%20desc&$top=${PAGE}&$skip=${skip}`;
      while (url) {
        const page = await this.withSizes('mail', url, next => this.api.get(next, { job }));
        let added = 0;
        for (const m of page.value || []) if (found(parseMail(m, folder.id), null)) added++;
        job.add(added);
        url = last ? page['@odata.nextLink'] || null : null;
      }
    }, job.signal);
  }

  /** Reads the List-Unsubscribe headers and a text preview of each sender's latest mail. */
  lookup(senders, found, job) {
    return this.forEachBatch(senders,
      s => ({ method: 'GET', url: `/me/messages/${enc(s.id)}?$select=internetMessageHeaders,bodyPreview` }),
      (s, r) => {
        if (r.ok && r.body) found(s.email, senderInfo(r.body));
      },
      job);
  }

  async apply(mails, action, done, failed, job) {
    const archive = this.archiveId;
    await this.forEachBatch(mails, m => mailRequest(m, action), (m, r) => {
      if (r.ok || (r.status === 404 && (action === 'trash' || action === 'delete'))) {   // 404: it's already gone
        done(m, { id: r.body?.id || m.id, folderId: archive });   // a move gives the mail a new id
      } else {
        failed(graphError(r.body));
      }
    }, job);
  }

  /** Keeps one Inbox rule that deletes all mail from blocked senders. Returns how many were new. */
  async block(patterns, job) {
    const rules = await this.getAll('me/mailFolders/inbox/messageRules', job);
    const rule = rules.find(r => r.displayName === RULE || r.displayName === OLD_RULE);
    const all = new Set((rule?.conditions?.senderContains || []).map(s => String(s).toLowerCase()).filter(Boolean));
    const before = all.size;
    for (const p of patterns) all.add(p.toLowerCase());
    if (rule && all.size === before) return 0;
    const conditions = { senderContains: [...all].sort() };
    if (rule) {
      await this.api.send('PATCH', `me/mailFolders/inbox/messageRules/${enc(rule.id)}`, { body: { displayName: RULE, conditions, isEnabled: true }, job });
    } else {
      await this.api.send('POST', 'me/mailFolders/inbox/messageRules', {
        body: { displayName: RULE, sequence: 1, isEnabled: true, conditions, actions: { delete: true, stopProcessingRules: true } },
        job,
      });
    }
    return all.size - before;
  }

  async body(mail, signal) {
    const m = await this.api.get(`me/messages/${enc(mail.id)}?$select=subject,from,toRecipients,ccRecipients,body,webLink`,
      { signal, headers: { Prefer: 'outlook.body-content-type="html"' } });
    return {
      subject: m.subject || '',
      from: address(m.from),
      to: [...(m.toRecipients || []), ...(m.ccRecipients || [])].map(address).filter(Boolean).join(', '),
      content: m.body?.content || '',
      isHtml: (m.body?.contentType || '').toLowerCase() !== 'text',
      webLink: m.webLink || null,
    };
  }

  /** Folder sizes grouped by top-level folder, Deleted Items, and the quota when the mailbox shows it. */
  async storage(signal) {
    const nodes = await this.allFolders(signal);
    const sized = this.sizes.folder;
    const tops = new Map();
    for (const n of nodes) {
      let t = tops.get(n.top);
      if (!t) tops.set(n.top, (t = { folder: null, size: 0, count: 0 }));
      if (n.folder.id === n.top) t.folder = n.folder;
      t.size += n.folder.size;
      t.count += n.folder.total;
    }
    const parts = [...tops.values()].filter(t => t.folder).sort((a, b) => b.size - a.size || b.count - a.count);
    const trash = parts.find(t => t.folder.wellKnown === 'deleteditems');
    const quota = await this.quota(signal);
    const personal = this.auth.personal;
    return {
      total: quota,
      used: sized ? nodes.reduce((n, x) => n + x.folder.size, 0) : null,
      parts: parts.map(t => ({ name: t.folder.name, size: sized ? t.size : null, count: t.count })),
      trash: { name: trash?.folder.name ?? this.trashName, size: sized ? trash?.size ?? 0 : null, count: trash?.count ?? 0 },
      note: quota != null ? null : personal ? t('outlook.notePersonal') : t('outlook.noteWork'),
      manageUrl: personal ? 'https://outlook.live.com/mail/0/options/general/storage' : 'https://outlook.office.com/mail/options/general/storage',
    };
  }

  async quota(signal) {
    try {
      const root = await this.api.get('me/mailFolders/msgfolderroot' + QUOTA, { signal });
      const kb = new Map();
      for (const p of root.singleValueExtendedProperties || []) {
        const tag = parseInt(String(p.id).split(' ')[1], 16);
        if (Number.isFinite(tag)) kb.set(tag, Number(p.value));
      }
      for (const tag of QUOTA_TAGS) {
        const value = kb.get(tag);
        if (value > 0 && value < 2 ** 31 - 1) return value * 1024;   // 2^31 - 1 means no limit
      }
    } catch (e) {
      if (!(e instanceof ServiceError)) throw e;
    }
    return null;
  }

  /** Deletes every mail in Deleted Items and its subfolders. Outlook keeps them a while in Recoverable Items. */
  async emptyTrash(job) {
    const nodes = await this.allFolders(job.signal);
    const trashId = nodes.find(n => n.folder.wellKnown === 'deleteditems')?.folder.id;
    const folders = trashId ? nodes.filter(n => n.top === trashId).map(n => n.folder) : [];
    job.step(t('trash.finding', this.trashName), folders.reduce((n, f) => n + f.total, 0));
    const ids = [];
    for (const folder of folders) {
      for (let url = `me/mailFolders/${enc(folder.id)}/messages?$select=id&$top=1000`; url; ) {
        const page = await this.api.get(url, { job });
        const found = (page.value || []).map(m => m.id).filter(Boolean);
        ids.push(...found);
        job.add(found.length);
        url = page['@odata.nextLink'] || null;
      }
    }
    job.step(t('trash.deleting', plural(ids.length, 'mail'), this.trashName), ids.length);
    let deleted = 0;
    await this.forEachBatch(ids, id => ({ method: 'DELETE', url: `/me/messages/${enc(id)}` }), (_, r) => {
      if (r.ok || r.status === 404) deleted++;
      else job.fail(t('trash.failed', graphError(r.body)));
    }, job);
    return deleted;
  }
}

function mailRequest(m, action) {
  const url = `/me/messages/${enc(m.id)}`;
  if (action === 'delete') return { method: 'DELETE', url };
  if (action === 'read' || action === 'unread') return withBody('PATCH', url, { isRead: action === 'read' });
  return withBody('POST', `${url}/move`, { destinationId: action === 'archive' ? 'archive' : 'deleteditems' });
}

const withBody = (method, url, body) => ({ method, url, headers: { 'Content-Type': 'application/json' }, body });
const graphError = body => body?.error?.message || t('error.unknown');

function parseMail(m, folderId) {
  const a = m.from?.emailAddress || {};
  return {
    id: m.id,
    folderId,
    email: (a.address || '').trim().toLowerCase(),
    name: (a.name || '').trim(),
    subject: m.subject || '',
    t: Date.parse(m.receivedDateTime) || 0,
    size: extendedNumber(m),
    read: m.isRead === true,
    other: m.inferenceClassification === 'other',
    attach: m.hasAttachments === true,
  };
}

function senderInfo(message) {
  let list = '';
  let post = '';
  for (const h of message.internetMessageHeaders || []) {
    const name = (h.name || '').toLowerCase();
    if (name === 'list-unsubscribe') list += h.value || '';
    else if (name === 'list-unsubscribe-post') post += h.value || '';
  }
  return parseUnsubscribe(list, post, message.bodyPreview || '');
}

function extendedNumber(e) {
  for (const p of e.singleValueExtendedProperties || []) {
    const n = Number(p.value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function address(recipient) {
  const a = recipient?.emailAddress;
  if (!a) return '';
  const name = (a.name || '').trim();
  const email = a.address || '';
  return name && name.toLowerCase() !== email.toLowerCase() ? `${name} <${email}>` : email;
}
