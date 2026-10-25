// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

// Any mailbox reachable over IMAP. Browsers can't open connections to mail servers, so this asks the desktop
// edition's shell (shell/ImapBridge.cs) through native.js. The website has no IMAP.

import { ServiceError, SignedOut, chunks, parseUnsubscribe } from './mail.js';
import { t } from './i18n.js';
import { NATIVE, shell } from './native.js';

const BATCH = 500;

/** Asks the desktop app's IMAP bridge. */
export async function bridge(cmd, args, signal) {
  try {
    return await shell('imap.' + cmd, args, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e.status === 401) throw new SignedOut(e.message);
    throw new ServiceError(e.message, e.status);
  }
}

/** The desktop app's saved IMAP setup, or null on the website. */
export const bridgeState = () => (NATIVE ? bridge('state').catch(() => null) : Promise.resolve(null));

export class Imap {
  kind = 'imap';
  blockName = '';
  canDelete = true;
  canBlock = false;   // IMAP has no standard for server-side rules
  scanFindsUnsubscribe = true;
  archiveId = null;

  get canArchive() {
    return this.archiveId != null;
  }

  get trashName() {
    return t('imap.trash');
  }

  async folders(signal) {
    const r = await bridge('folders', {}, signal);
    this.archiveId = r.archive ?? null;
    return r.folders;
  }

  async read(folders, found, job) {
    for (const folder of folders) {
      // The bridge opens folders read-only (EXAMINE), so reading never marks anything as read.
      const { validity, uids } = await bridge('uids', { folder: folder.id }, job.signal);
      for (const batch of chunks(uids, BATCH)) {
        const r = await bridge('fetch', { folder: folder.id, validity, uids: batch }, job.signal);
        if (r.changed) break;   // the server renumbered the folder meanwhile
        for (const { list, post, ...mail } of r.mails) found({ ...mail, folderId: folder.id, other: false }, parseUnsubscribe(list, post));
        job.add(batch.length);
      }
    }
  }

  async lookup() {
    // The scan already reads every mail's unsubscribe headers.
  }

  async apply(mails, action, done, failed, job) {
    for (const group of Map.groupBy(mails, m => m.folderId).values()) {
      for (const chunk of chunks(group, BATCH)) {
        try {
          const r = await bridge('apply', { action, ids: chunk.map(m => m.id) }, job?.signal);
          const applied = new Map(r.done.map(d => [d.id, d]));
          for (const m of chunk) {
            const d = applied.get(m.id);
            // Without UIDPLUS the server doesn't say the new UID; the mail can be acted on again after a scan.
            if (d) done(m, { id: d.newId || '', folderId: this.archiveId });
            else failed(t('imap.changed'));
          }
        } catch (e) {
          if (!(e instanceof ServiceError) || e.status === 400) throw e;
          for (const _ of chunk) failed(e.message);
        }
        job?.add(chunk.length);
      }
    }
  }

  block() {
    throw new ServiceError(t('imap.noBlock'));
  }

  async body(mail, signal) {
    if (!mail.id) throw new ServiceError(t('imap.scanAgain'));
    return { ...(await bridge('body', { id: mail.id }, signal)), webLink: null };
  }

  storage(signal) {
    return bridge('storage', {}, signal);
  }

  async emptyTrash(job) {
    job.step(t('trash.emptying', this.trashName), 1);
    const { count } = await bridge('emptyTrash', {}, job.signal);
    job.add(1);
    return count;
  }
}
