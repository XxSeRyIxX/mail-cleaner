// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

// Gmail mailboxes, through the Gmail API. Labels play the part of folders.

import { RestClient, ServiceError, Pacer, pool, chunks, parseAddress, parseUnsubscribe, decodeWords, decodeText, base64Bytes, htmlText, fmt } from './mail.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';
// Google's storage quota is shared by Gmail, Drive and Photos, and only the Drive API reports it.
const ABOUT = 'https://www.googleapis.com/drive/v3/about?fields=storageQuota';
const MANAGE = 'https://one.google.com/storage';
const ALL = 'ALL';
const METADATA = 'format=metadata&metadataHeaders=From&metadataHeaders=Subject' +
  '&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post' +
  '&fields=id%2ClabelIds%2CsizeEstimate%2CinternalDate%2Csnippet%2Cpayload(mimeType%2Cheaders)';
const SYSTEM = [
  ['INBOX', 'Inbox', 'inbox'],
  ['SPAM', 'Spam', 'junkemail'],
  [ALL, 'All mail', 'all'],
  ['CATEGORY_PROMOTIONS', 'Promotions', null],
  ['CATEGORY_SOCIAL', 'Social', null],
  ['CATEGORY_UPDATES', 'Updates', null],
  ['CATEGORY_FORUMS', 'Forums', null],
];
const LABELS = { trash: [['TRASH'], []], archive: [[], ['INBOX']], read: [[], ['UNREAD']], unread: [['UNREAD'], []] };
const enc = encodeURIComponent;
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));   // Google sends 64-bit numbers as strings
const headerOf = (part, name) => (part.headers || []).find(h => (h.name || '').toLowerCase() === name)?.value || '';

export class Gmail {
  kind = 'gmail';
  trashName = 'Trash';
  blockName = 'the Gmail filters';
  canDelete = true;
  canArchive = true;
  canBlock = true;
  scanFindsUnsubscribe = true;

  /** `auth` is the Google sign-in: token(force), and user, the Gmail address for links to Gmail. */
  constructor(auth) {
    this.auth = auth;
    // Google allows each user 250 quota units a second, and reading one mail costs 5. Stay a bit under that.
    const pacer = new Pacer(200, 200);
    this.api = new RestClient({
      base: GMAIL,
      name: 'Gmail',
      token: force => auth.token(force),
      slow: 'Google asked this app to slow down',
      busy: 'Gmail is busy',
      throttled: (status, data) => status === 403 && (data?.error?.errors || []).some(e => /rateLimitExceeded/.test(e.reason)),
      before: (cost, signal) => pacer.take(cost, signal),
    });
  }

  async folders(signal) {
    const { labels = [] } = await this.api.get('labels', { signal });
    const user = labels.filter(l => l.type === 'user').sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const counts = new Map();
    await pool([...SYSTEM.filter(([id]) => id !== ALL).map(([id]) => id), ...user.map(l => l.id)], 8, async id => {
      try {
        const label = await this.api.get(`labels/${enc(id)}`, { signal });
        counts.set(id, { total: label.messagesTotal || 0, unread: label.messagesUnread || 0 });
      } catch (e) {
        if (!(e instanceof ServiceError && (e.status === 404 || e.status === 400))) throw e;
      }
    }, signal);
    const profile = await this.api.get('profile', { signal });
    const result = [];
    for (const [id, name, wellKnown] of SYSTEM) {
      if (id === ALL) result.push({ id, name, path: name, total: profile.messagesTotal || 0, unread: 0, size: 0, wellKnown });
      else if (counts.has(id)) result.push({ id, name, path: name, ...counts.get(id), size: 0, wellKnown });
    }
    for (const l of user) {
      if (counts.has(l.id)) result.push({ id: l.id, name: l.name.split('/').pop(), path: l.name.replaceAll('/', ' / '), ...counts.get(l.id), size: 0, wellKnown: null });
    }
    return result;
  }

  /** The ids of the mails matching `params` (labelIds, includeSpamTrash), a page at a time. */
  async *list(params, job) {
    const query = new URLSearchParams({ ...params, maxResults: 500, fields: 'messages(id),nextPageToken' });
    do {
      const page = await this.api.get(`messages?${query}`, { job, cost: 5 });
      yield (page.messages || []).map(m => m.id).filter(Boolean);
      query.set('pageToken', page.nextPageToken || '');
    } while (query.get('pageToken'));
  }

  /** A mail's headers, as a scanned mail and its unsubscribe info. */
  async metadata(id, folderId, job) {
    return parseMessage(await this.api.get(`messages/${enc(id)}?${METADATA}`, { job, cost: 5 }), folderId);
  }

  async read(folders, found, job) {
    const seen = new Set();
    // "All mail" last, so a mail keeps its more specific place (Inbox, Spam, a label).
    for (const folder of [...folders].sort((a, b) => (a.id === ALL) - (b.id === ALL))) {
      const params = folder.id === ALL ? {} : { labelIds: folder.id, includeSpamTrash: folder.id === 'SPAM' };
      for await (const listed of this.list(params, job)) {
        const fresh = listed.filter(id => !seen.has(id) && seen.add(id));
        job.add(listed.length - fresh.length);
        await pool(fresh, 16, async id => {
          try {
            const { mail, info } = await this.metadata(id, folder.id, job);
            found(mail, info);
          } catch (e) {
            if (!(e instanceof ServiceError && e.status === 404)) throw e;   // deleted meanwhile
          }
          job.add(1);
        }, job.signal);
      }
    }
  }

  lookup(senders, found, job) {
    return pool(senders, 8, async s => {
      try {
        found(s.email, (await this.metadata(s.id, '', job)).info);
      } catch (e) {
        if (!(e instanceof ServiceError)) throw e;
      }
      job?.add(1);
    }, job?.signal);
  }

  async apply(mails, action, done, failed, job) {
    const [add, remove] = LABELS[action] ?? [[], []];
    for (const chunk of chunks(mails, 1000)) {
      const ids = chunk.map(m => m.id);
      try {
        if (action === 'delete') await this.deleteForGood(ids, job);
        else await this.api.send('POST', 'messages/batchModify', { body: { ids, addLabelIds: add, removeLabelIds: remove }, job, cost: 50 });
      } catch (e) {
        if (!(e instanceof ServiceError)) throw e;
        if (action === 'trash' && e.status === 400) {
          await this.trashEach(chunk, done, failed, job);   // in case Gmail refuses the TRASH label in bulk
          continue;
        }
        for (const _ of chunk) failed(e.message);
        job?.add(chunk.length);
        continue;
      }
      for (const m of chunk) done(m, { folderId: m.folderId === 'INBOX' ? ALL : m.folderId });
      job?.add(chunk.length);
    }
  }

  trashEach(mails, done, failed, job) {
    return pool(mails, 8, async m => {
      try {
        await this.api.send('POST', `messages/${enc(m.id)}/trash`, { job, cost: 5 });
        done(m);
      } catch (e) {
        if (!(e instanceof ServiceError)) throw e;
        if (e.status === 404) done(m);
        else failed(e.message);
      }
      job?.add(1);
    }, job?.signal);
  }

  /** Deletes up to 1,000 mails for good, skipping Trash. */
  async deleteForGood(ids, job) {
    try {
      await this.api.send('POST', 'messages/batchDelete', { body: { ids }, job, cost: 50 });
    } catch (e) {
      if (e instanceof ServiceError && e.status === 403) {
        throw new ServiceError("Gmail didn't allow deleting mail for good. Sign out, sign in again and allow everything Google asks about.", 403);
      }
      throw e;
    }
  }

  /** Gmail filters whose action is "Delete it". Returns how many addresses or domains were new. */
  async block(patterns, job) {
    const { filter: filters = [] } = await this.api.get('settings/filters', { job });
    const blocked = new Set();
    for (const f of filters) {
      if (!(f.action?.addLabelIds || []).includes('TRASH')) continue;
      for (const part of (f.criteria?.from || '').split(/\s+OR\s+|\s*\|\s*/)) blocked.add(part.trim().replace(/^[({]+|[)}]+$/g, '').trim().toLowerCase());
    }
    const fresh = [...new Set(patterns.map(p => p.toLowerCase()))].filter(p => !blocked.has(p));
    // Gmail rejects filter criteria longer than about 1,500 characters.
    let group = [];
    const save = async () => {
      if (!group.length) return;
      await this.api.send('POST', 'settings/filters', { body: { criteria: { from: group.join(' OR ') }, action: { addLabelIds: ['TRASH'] } }, job, cost: 5 });
      group = [];
    };
    for (const p of fresh) {
      if (group.length && [...group, p].join(' OR ').length > 1000) await save();
      group.push(p);
    }
    await save();
    return fresh.length;
  }

  async body(mail, signal) {
    const m = await this.api.get(`messages/${enc(mail.id)}?format=full`, { signal, cost: 5 });
    const payload = m.payload || {};
    const header = name => decodeWords(headerOf(payload, name));
    const html = findPart(payload, 'text/html');
    const part = html || findPart(payload, 'text/plain');
    return {
      subject: header('subject'),
      from: header('from'),
      to: [header('to'), header('cc')].filter(Boolean).join(', '),
      content: part ? await this.decodePart(mail.id, part, signal) : '',
      isHtml: Boolean(html),
      webLink: `https://mail.google.com/mail/?authuser=${enc(this.auth.user)}#all/${enc(mail.id)}`,
    };
  }

  async decodePart(mailId, part, signal) {
    let data = part.body?.data;
    if (!data) data = (await this.api.get(`messages/${enc(mailId)}/attachments/${enc(part.body.attachmentId)}`, { signal, cost: 5 })).data || '';
    const type = headerOf(part, 'content-type');
    return decodeText(base64Bytes(data), /charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1] || 'utf-8');
  }

  async storage(signal) {
    const label = await this.api.get('labels/TRASH', { signal });
    const trash = { name: 'Trash', size: null, count: label.messagesTotal || 0 };
    try {
      const { storageQuota: q = {} } = await this.api.get(ABOUT, { signal });
      const used = num(q.usage);
      const drive = num(q.usageInDrive) ?? 0;
      const parts = used == null ? []
        : [{ name: 'Gmail and Google Photos', size: Math.max(0, used - drive), count: null }, { name: 'Google Drive', size: drive, count: null }];
      return { total: num(q.limit), used, parts, trash, note: null, manageUrl: MANAGE };   // no limit: unlimited storage
    } catch (e) {
      if (!(e instanceof ServiceError && [400, 403, 404].includes(e.status))) throw e;
      const note = /scope/i.test(e.message)
        ? 'To see your total Google storage here, sign out, sign in again and allow the app to see your Google Drive storage.'
        : "Google didn't share your total storage: the Google Drive API is off in the app's Google Cloud project.";
      return { total: null, used: null, parts: [], trash, note, manageUrl: MANAGE };
    }
  }

  async emptyTrash(job) {
    const label = await this.api.get('labels/TRASH', { job });
    job.step('Finding the mails in Trash', label.messagesTotal || 0);
    const ids = [];
    for await (const listed of this.list({ labelIds: 'TRASH', includeSpamTrash: true }, job)) {
      ids.push(...listed);
      job.add(listed.length);
    }
    job.step(`Deleting ${fmt(ids.length)} mails from Trash`, ids.length);
    for (const chunk of chunks(ids, 1000)) {
      await this.deleteForGood(chunk, job);
      job.add(chunk.length);
    }
    return ids.length;
  }
}

function findPart(part, mimeType) {
  if (!part || typeof part !== 'object') return null;
  if ((part.mimeType || '').toLowerCase() === mimeType && !part.filename && (part.body?.data || part.body?.attachmentId)) return part;
  for (const child of part.parts || []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function parseMessage(m, folderId) {
  const payload = m.payload || {};
  let from = '';
  let subject = '';
  let list = '';
  let post = '';
  for (const { name = '', value = '' } of payload.headers || []) {
    switch (name.toLowerCase()) {
      case 'from': from = value; break;
      case 'subject': subject = value; break;
      case 'list-unsubscribe': list += value; break;
      case 'list-unsubscribe-post': post += value; break;
    }
  }
  const { email, name } = parseAddress(from);
  const labels = new Set(m.labelIds || []);
  return {
    mail: {
      id: m.id,
      folderId,
      email,
      name,
      subject: decodeWords(subject),
      t: Number(m.internalDate) || 0,
      size: m.sizeEstimate || 0,
      read: !labels.has('UNREAD'),
      other: labels.has('CATEGORY_PROMOTIONS') || labels.has('CATEGORY_SOCIAL'),
      attach: (payload.mimeType || '').toLowerCase() === 'multipart/mixed',
    },
    info: parseUnsubscribe(list, post, htmlText(m.snippet)),
  };
}
