// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

// The desktop edition's link to its shell (shell/Program.cs), through the messages Photino adds to the page as
// window.external.sendMessage and receiveMessage. Each request carries an id, so a scan, a mail and a token can be on
// their way at once, and a signal can stop one. On the website there is no shell.

/** Sends requests over a transport ({ sendMessage, receiveMessage }) and settles each with the reply for its id. */
export function createBridge(transport) {
  const pending = new Map();
  const prefix = Math.random().toString(36).slice(2);   // a reloaded page ignores replies meant for the one before
  let count = 0;

  transport.receiveMessage(raw => {
    let reply;
    try {
      reply = JSON.parse(raw);
    } catch {
      return;
    }
    const call = pending.get(reply?.id);
    if (!call) return;
    pending.delete(reply.id);
    call.settle(reply);
  });

  return (cmd, args = {}, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const id = `${prefix}-${++count}`;
    const stop = () => {
      pending.delete(id);
      reject(signal.reason);
      try {
        transport.sendMessage(JSON.stringify({ id: `${prefix}-${++count}`, cmd: 'cancel', args: { id } }));
      } catch {
        // the shell is gone, so nothing is running
      }
    };
    pending.set(id, {
      settle(reply) {
        signal?.removeEventListener('abort', stop);
        if (reply.ok) resolve(reply.data ?? null);
        else reject(Object.assign(new Error(reply.error || 'The desktop app couldn\'t do that.'), { status: reply.status || 500 }));
      },
    });
    signal?.addEventListener('abort', stop, { once: true });
    try {
      transport.sendMessage(JSON.stringify({ id, cmd, args }));
    } catch (e) {
      pending.delete(id);
      signal?.removeEventListener('abort', stop);
      reject(e);
    }
  });
}

/** True inside the desktop edition, where Photino adds its messages to window.external. */
export const NATIVE = typeof window === 'object' && typeof window.external?.receiveMessage === 'function';

/** Asks the desktop shell, for example shell('open', { url }). Null on the website. */
export const shell = NATIVE ? createBridge(window.external) : null;
