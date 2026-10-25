// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

// Signing in. On the website it all happens in this page. Microsoft: OAuth 2.0 authorization code with PKCE,
// registered as a single-page app. Google: the Google Identity Services token client. Microsoft and Google refuse
// sign-ins inside an app's webview, so the desktop edition signs in in the user's browser through its shell
// (shell/SignIn.cs), which keeps the refresh tokens. Access tokens stay in this tab (session storage) and only ever go
// to Microsoft or Google. The app registrations are public IDs, never secrets.

import { SignedOut, base64Bytes, storage } from './mail.js';
import { t } from './i18n.js';
import { NATIVE, shell } from './native.js';

const tab = storage(sessionStorage);

/** This page's address without file name, query or fragment: the redirect URI registered for Microsoft. */
export const appUrl = () => location.origin + location.pathname.replace(/[^/]*$/, '');

/** The desktop edition's redirect URI for Microsoft ("Mobile and desktop applications", any port): see shell/SignIn.cs. */
export const DESKTOP_REDIRECT = 'http://localhost/mail-cleaner';

/** The site's config.json: the default app registrations and the deployed commit, filled in by .github/workflows/pages.yml. */
export async function loadDefaults() {
  try {
    const res = await fetch('config.json', { cache: 'no-cache' });
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

const base64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomText = length => base64Url(crypto.getRandomValues(new Uint8Array(length)));

/** Token errors that mean the user has to sign in again. */
const SIGN_IN_AGAIN = ['invalid_grant', 'interaction_required'];

/** A sign-in for one app registration, kept in this tab's session storage. Subclasses say how to renew() the token. */
class SignIn {
  constructor(key, clientId) {
    this.key = key;
    this.clientId = clientId;
    this.session = tab.get(key);
    if (this.session?.clientId !== clientId) this.session = null;
    this.renewing = null;
  }

  get signedIn() {
    return Boolean(this.session);
  }

  get user() {
    return this.session?.user || '';
  }

  /** Keeps a token answer ({ access_token, expires_in }) and the rest of the session. */
  save(answer, values) {
    this.session = { clientId: this.clientId, access: answer.access_token, expires: Date.now() + (Number(answer.expires_in) || 3600) * 1000, ...values };
    tab.set(this.key, this.session);
  }

  /** A valid access token, renewed once at a time when it is about to expire. */
  token(force = false) {
    const s = this.session;
    if (!s) return Promise.reject(new SignedOut());
    if (!force && s.expires - Date.now() > this.margin) return Promise.resolve(s.access);
    this.renewing ??= this.renew().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  forget() {
    this.session = null;
    tab.remove(this.key);
  }

  signOut() {
    this.forget();
  }
}

// ---------- Microsoft ----------

const MS_SCOPES = 'openid profile offline_access Mail.ReadWrite MailboxSettings.ReadWrite';
const MS_SESSION = 'microsoft';
const MS_PENDING = 'microsoft.pending';
const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad';   // the tenant of outlook.com, hotmail and live accounts

/** Microsoft's sign-in errors, turned into the step that fixes them. */
function explain(error, description) {
  const text = String(description || '').split(/\r?\n/)[0];
  const fix = t('auth.fix', NATIVE ? t('auth.fixDesktop', DESKTOP_REDIRECT) : t('auth.fixWeb', appUrl()));
  if (/AADSTS9002326|AADSTS9002327|AADSTS90023\b|AADSTS7000218|AADSTS70002\b/.test(text)) {
    return t(NATIVE ? 'auth.notDesktop' : 'auth.notSpa', fix);
  }
  if (/AADSTS50011/.test(text)) return t(NATIVE ? 'auth.redirectDesktop' : 'auth.redirectWeb', fix);
  if (/AADSTS700016/.test(text)) return t('auth.unknownId');
  if (error === 'access_denied' || error === 'consent_required') return t('auth.deniedMail');
  return t('auth.msStopped', error || t('error.unknown'), text).trim();
}

export class Microsoft extends SignIn {
  margin = 5 * 60_000;

  constructor({ clientId, tenant }) {
    super(MS_SESSION, clientId);
    this.tenant = tenant || 'common';
  }

  get personal() {
    return this.session?.tid === CONSUMERS;
  }

  endpoint(path) {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.tenant)}/oauth2/v2.0/${path}`;
  }

  /** Goes to Microsoft's sign-in page, which sends the browser back to this page with a one-time code. */
  async signIn() {
    const verifier = randomText(48);
    const state = randomText(24);
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    tab.set(MS_PENDING, { state, verifier, clientId: this.clientId, tenant: this.tenant, redirectUri: appUrl() });
    const query = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: appUrl(),
      response_mode: 'fragment',   // the code stays in the browser: fragments never reach the web server
      scope: MS_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    location.assign(`${this.endpoint('authorize')}?${query}`);
  }

  /** Finishes the sign-in when Microsoft just sent the browser back here. Null when this page load isn't that. */
  static async complete() {
    const reply = new URLSearchParams(location.hash.slice(1));
    if (!reply.has('state')) return null;
    history.replaceState(null, '', location.pathname + location.search);   // keep the code out of the address bar and history
    const pending = tab.get(MS_PENDING);
    tab.remove(MS_PENDING);
    if (!pending || reply.get('state') !== pending.state) throw new Error(t('auth.wrongReply'));
    if (reply.has('error')) throw new Error(explain(reply.get('error'), reply.get('error_description')));
    const ms = new Microsoft(pending);
    await ms.redeem({ grant_type: 'authorization_code', code: reply.get('code') || '', redirect_uri: pending.redirectUri, code_verifier: pending.verifier });
    return ms;
  }

  async redeem(fields) {
    let res;
    try {
      res = await fetch(this.endpoint('token'), { method: 'POST', body: new URLSearchParams({ client_id: this.clientId, scope: MS_SCOPES, ...fields }) });
    } catch {
      throw new Error(t('auth.msUnreachable'));
    }
    this.accept(await res.json().catch(() => ({})), fields.grant_type === 'refresh_token');
  }

  /** Keeps a token answer with who signed in, or turns its error into words. A refused renewal means signing in again. */
  accept(data, renewing = false) {
    if (!data.access_token) {
      if (renewing && SIGN_IN_AGAIN.includes(data.error)) throw new SignedOut();
      throw new Error(explain(data.error, data.error_description));
    }
    let claims = {};
    try {
      claims = JSON.parse(new TextDecoder().decode(base64Bytes(data.id_token.split('.')[1])));   // only to show who is signed in
    } catch {
      // no ID token
    }
    this.save(data, {
      refresh: data.refresh_token || this.session?.refresh || '',
      user: claims.preferred_username || claims.email || this.session?.user || '',
      tid: claims.tid || this.session?.tid || '',
    });
  }

  /** Uses the refresh token, which Microsoft keeps valid for 24 hours in a browser. */
  async renew() {
    const refresh = this.session?.refresh;
    if (!refresh) throw new SignedOut();
    await this.redeem({ grant_type: 'refresh_token', refresh_token: refresh });
    return this.session.access;
  }
}

/** Microsoft in the desktop edition: the shell signs in in the user's browser and renews the token. */
class DesktopMicrosoft extends Microsoft {
  async signIn(signal) {
    this.accept(await shell('auth.signIn', { provider: 'microsoft', clientId: this.clientId, tenant: this.tenant }, signal));
  }

  async renew() {
    this.accept(await shell('auth.renew', { provider: 'microsoft' }), true);
    return this.session.access;
  }

  signOut() {
    this.forget();
    return shell('auth.signOut', { provider: 'microsoft' });
  }
}

// ---------- Google ----------

const GOOGLE_SESSION = 'google';
const GIS = 'https://accounts.google.com/gsi/client';
const MAIL_SCOPE = 'https://mail.google.com/';   // deleting mail for good (Empty Trash) needs full access
const FILTER_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic';   // the block filters
const STORAGE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';   // optional: lets the Drive API report the storage quota

let gisLoading = null;

function loadGis() {
  gisLoading ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve();
      return;
    }
    const script = Object.assign(document.createElement('script'), { src: GIS, async: true });
    script.onload = () => resolve();
    script.onerror = () => {
      gisLoading = null;
      script.remove();
      reject(new Error(t('auth.gisFailed')));
    };
    document.head.append(script);
  });
  return gisLoading;
}

function googleError(error, description) {
  if (error === 'popup_closed') return t('auth.popupClosed');
  if (error === 'popup_failed_to_open') return t('auth.popupBlocked');
  if (error === 'access_denied') return t('auth.deniedGmail');
  if (error === 'invalid_client' || /client_secret/i.test(description)) return t('auth.badSecret');
  return t('auth.googleStopped', error, description ? `. ${description}` : '');
}

/** Google asked which permissions to allow and not all were ticked. */
const missingScopes = () => new Error(t('auth.scopes'));

/** The signed-in Gmail address. */
async function gmailAddress(token) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
  const profile = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Gmail: ' + (profile.error?.message || t('net.answered', res.status)));
  return profile.emailAddress || '';
}

class Google extends SignIn {
  margin = 2 * 60_000;

  /** `askToContinue(renew)` shows a Continue button and calls `renew` from its click; Google needs a click to open its window. */
  constructor({ clientId }, askToContinue) {
    super(GOOGLE_SESSION, clientId);
    this.askToContinue = askToContinue;
    this.client = null;
    this.waiting = null;
  }

  /** Loads Google's token client ahead of time, so a click can open its window at once (browsers block it later). */
  async prepare() {
    await loadGis();
    this.client ??= google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: [MAIL_SCOPE, FILTER_SCOPE, STORAGE_SCOPE].join(' '),
      callback: r => this.answer(r),
      error_callback: e => this.answer({ error: e?.type || 'unknown' }),
    });
  }

  answer(r) {
    const waiting = this.waiting;
    this.waiting = null;
    if (!waiting) return;
    if (r.error) waiting.reject(new Error(googleError(r.error, r.error_description)));
    else if (!google.accounts.oauth2.hasGrantedAllScopes(r, MAIL_SCOPE, FILTER_SCOPE)) waiting.reject(missingScopes());
    else waiting.resolve(r);
  }

  /** Opens Google's window. Must run straight from a click. */
  request(prompt) {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error(t('auth.loading')));
        return;
      }
      this.waiting?.reject(new Error(t('auth.replaced')));
      this.waiting = { resolve, reject };
      this.client.requestAccessToken(this.session?.user ? { prompt, login_hint: this.session.user } : { prompt });
    });
  }

  async signIn() {
    if (!this.client) await this.prepare();
    const r = await this.request('select_account');
    this.save(r, { user: await gmailAddress(r.access_token) });
  }

  /** Google's browser tokens last an hour and only a click may open its window again, so this asks the user for one. */
  renew() {
    return this.askToContinue(async () => {
      const r = await this.request('');   // usually opens and closes by itself: the user already allowed the app
      this.save(r, { user: this.user });
      return r.access_token;
    });
  }

  /** Signs out and revokes the app's access to the Google account. */
  signOut() {
    const token = this.session?.access;
    this.forget();
    if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  }
}

/**
 * Gmail in the desktop edition: the shell signs in in the user's browser with a Desktop app client. Those get refresh
 * tokens, so there's no hourly Continue.
 */
class DesktopGoogle extends SignIn {
  margin = 2 * 60_000;

  constructor({ clientId, secret }) {
    super(GOOGLE_SESSION, clientId);
    this.secret = secret || '';
  }

  prepare() {
    return Promise.resolve();
  }

  async signIn(signal) {
    const answer = this.check(await shell('auth.signIn', { provider: 'google', clientId: this.clientId, secret: this.secret }, signal));
    const granted = String(answer.scope || '').split(' ');
    if (![MAIL_SCOPE, FILTER_SCOPE].every(scope => granted.includes(scope))) throw missingScopes();
    this.save(answer, { user: await gmailAddress(answer.access_token) });
  }

  async renew() {
    const answer = await shell('auth.renew', { provider: 'google' });
    if (SIGN_IN_AGAIN.includes(answer.error)) throw new SignedOut();
    this.save(this.check(answer), { user: this.user });
    return answer.access_token;
  }

  check(answer) {
    if (!answer.access_token) throw new Error(googleError(answer.error || 'unknown_error', answer.error_description));
    return answer;
  }

  /** Signs out; the shell revokes the app's access to the Google account. */
  signOut() {
    this.forget();
    return shell('auth.signOut', { provider: 'google' });
  }
}

/** The sign-in for Outlook or Gmail: in this page on the website, in the user's browser in the desktop edition. */
export function signInFor(kind, app, askToContinue) {
  if (kind === 'gmail') return NATIVE ? new DesktopGoogle(app) : new Google(app, askToContinue);
  return NATIVE ? new DesktopMicrosoft(app) : new Microsoft(app);
}
