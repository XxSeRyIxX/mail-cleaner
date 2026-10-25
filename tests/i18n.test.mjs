import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STRINGS, NOUNS, PAGE_ES, setLang, t, tn, noun, langForBrowser, fmt } from '../app/i18n.js';
import { plural } from '../app/mail.js';

const app = name => readFileSync(new URL(`../app/${name}`, import.meta.url), 'utf8');
const scripts = ['app.js', 'mail.js', 'auth.js', 'gmail.js', 'outlook.js', 'imap.js', 'about.js', 'native.js'].map(app).join('\n');
const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(m => m[0]).sort().join();

/** Runs fn with the interface in Spanish, then puts English back. */
function inSpanish(fn) {
  setLang('es');
  try {
    return fn();
  } finally {
    setLang('en');
  }
}

test('English and Spanish have the same texts with the same placeholders, and the same words', () => {
  assert.deepEqual(Object.keys(STRINGS.es).sort(), Object.keys(STRINGS.en).sort());
  for (const key of Object.keys(STRINGS.en)) assert.equal(placeholders(STRINGS.es[key]), placeholders(STRINGS.en[key]), key);
  assert.deepEqual(Object.keys(NOUNS.es).sort(), Object.keys(NOUNS.en).sort());
});

test('every text the scripts ask for exists, and every text is used', () => {
  const keys = Object.keys(STRINGS.en);
  const used = new Set();
  for (const [, call, key] of scripts.matchAll(/\b(t|tn)\('([^'$]+)'/g)) {
    if (call === 'tn') used.add(`${key}.one`).add(`${key}.other`);
    else used.add(key);
  }
  // Put together at run time: t(`${kind}.${word}`), t(`progress.${action}`), tn(`done.${action}`), t(`unsubKind.${kind}`) and the like.
  const words = ['service', 'company', 'junk', 'other', 'otherWhy', 'otherAi', 'block', 'limits', 'deleteNote', 'restoreNote',
    'trashNote', 'emptyNote', 'manage'];
  for (const kind of ['outlook', 'gmail', 'imap']) for (const word of words) used.add(`${kind}.${word}`);
  for (const action of ['archive', 'read', 'unread']) used.add(`progress.${action}`);
  for (const action of ['trash', 'delete', 'archive', 'read', 'unread']) used.add(`done.${action}.one`).add(`done.${action}.other`);
  for (const kind of ['oneClick', 'link', 'none']) used.add(`unsubKind.${kind}`);
  for (const id of ['INBOX', 'SPAM', 'ALL', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']) used.add(`gmail.${id}`);
  for (const key of ['outlook.slow', 'outlook.busy', 'gmail.slow', 'gmail.busy', 'wait.connection', 'scan.done', 'scan.partly',
    'storage.google', 'storage.folders', 'auth.notDesktop', 'auth.notSpa', 'auth.redirectDesktop', 'auth.redirectWeb',
    'about.ours', 'about.other']) used.add(key);
  assert.deepEqual([...used].filter(key => !keys.includes(key)), [], 'asked for but missing');
  assert.deepEqual(keys.filter(key => !used.has(key)), [], 'never used');
});

test('every translated part of the page has its Spanish, and nothing else does', () => {
  const page = app('index.html');
  const names = new Set([...page.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(m => m[1]));
  assert.deepEqual([...names].filter(name => !(name in PAGE_ES)), []);
  assert.deepEqual(Object.keys(PAGE_ES).filter(name => !names.has(name)), []);
  // The translations are set as HTML: formatting and links, never scripts or handlers.
  for (const [name, html] of [...Object.entries(PAGE_ES), ...Object.entries(STRINGS.es), ...Object.entries(STRINGS.en)]) {
    assert.doesNotMatch(html, /<script|\son\w+\s*=|javascript:/i, name);
  }
});

test('counts and words follow the language', () => {
  assert.equal(plural(1, 'mail'), '1 mail');
  assert.equal(plural(1200, 'sender'), `${fmt(1200)} senders`);
  assert.equal(plural(2, 'moreFolder'), '2 more folders');
  assert.equal(tn('done.trash', 1, 'Trash'), '1 mail moved to Trash.');
  assert.equal(noun('unknown', 2), 'unknown');
  inSpanish(() => {
    assert.equal(plural(1, 'mail'), '1 correo');
    assert.equal(plural(2, 'moreFolder'), '2 carpetas más');
    assert.equal(plural(1200, 'sender'), `${(1200).toLocaleString('es')} remitentes`);
    assert.equal(tn('done.trash', 3, t('gmail.trash')), '3 correos movidos a Papelera.');
    assert.equal(t('missing.key'), 'missing.key');
  });
  assert.equal(langForBrowser(['es-MX', 'en']), 'es');
  assert.equal(langForBrowser(['en-GB', 'es']), 'en');
  assert.equal(langForBrowser(['de', 'es-ES']), 'es');
  assert.equal(langForBrowser(['de']), 'en');
  assert.equal(langForBrowser(undefined), 'en');
});

test('the Spanish privacy policy has the same sections as the English one', () => {
  const headings = page => [...app(page).matchAll(/<h2>/g)].length;
  assert.equal(headings('privacy.es.html'), headings('privacy.html'));
  assert.equal(STRINGS.es['privacy.page'], 'privacy.es.html');
  for (const page of ['privacy.html', 'privacy.es.html']) assert.match(app(page), /<article/);
});
