// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

// About: credits, the license notice, and where this copy comes from.

/** The original project. Section 7(b) of the license asks copies to keep this attribution (see NOTICE). */
const ORIGINAL = {
  name: 'Mail Cleaner',
  author: 'XxSeRyIxX',
  profile: 'https://github.com/XxSeRyIxX',
  repo: 'https://github.com/XxSeRyIxX/mail-cleaner',
  build: 'd322843150ce2503',
  hosts: ['xxseryixx.github.io', '127.0.0.1', 'localhost'],
};

const LINKS = {
  profile: ORIGINAL.profile,
  repo: ORIGINAL.repo,
  license: `${ORIGINAL.repo}/blob/main/LICENSE`,
  issues: `${ORIGINAL.repo}/issues`,
  releases: `${ORIGINAL.repo}/releases/latest`,
};
const BITS = ['\u200b', '\u200c'];   // zero width space and non-joiner: 0 and 1
const EDGE = '\u2060';   // word joiner around them

/** The build id as invisible characters, so text copied out of the app carries it. */
export const watermark = (text = ORIGINAL.build) =>
  EDGE + [...new TextEncoder().encode(text)].map(b => b.toString(2).padStart(8, '0').replace(/[01]/g, bit => BITS[bit])).join('') + EDGE;

/** The build ids hidden in a text. */
function readWatermarks(text) {
  return [...String(text).matchAll(/\u2060([\u200b\u200c]{8,})\u2060/g)].map(([, marks]) => {
    const bits = [...marks].map(c => (c === BITS[1] ? '1' : '0')).join('');
    return new TextDecoder().decode(new Uint8Array(bits.match(/.{8}/g).map(byte => parseInt(byte, 2))));
  });
}

/** Fills in the About dialog and its links, and opens it from [data-about] buttons. `build` and `version` come from config.json. */
export function initAbout({ build, version } = {}) {
  const dialog = document.getElementById('about');
  const $ = selector => dialog.querySelector(selector);
  for (const a of document.querySelectorAll('[data-link]')) a.href = LINKS[a.dataset.link];
  $('#ab-made').append(watermark());
  const original = ORIGINAL.hosts.includes(location.hostname);
  $('#ab-copy').hidden = original;
  $('#ab-copy').textContent = `This copy runs on ${location.host}. The original ${ORIGINAL.name} is free and open source: ${ORIGINAL.repo}`;
  $('#ab-version').hidden = !build;
  if (build) {
    $('#ab-deployed').textContent = version ? `Version ${version} (${build})` : `Version ${build}`;
    $('#ab-deployed').href = `${ORIGINAL.repo}/commit/${build}`;
  }
  $('#ab-check').addEventListener('input', e => {
    const found = readWatermarks(e.target.value);
    $('#ab-found').textContent = !e.target.value ? ''
      : !found.length ? 'No build id hidden in that text.'
      : found.map(id => (id === ORIGINAL.build ? `${id}: this app's build id` : `${id}: another build id`)).join(', ');
  });

  const open = proof => {
    $('#ab-proof').hidden = !proof;
    if (proof) {
      $('#ab-id').textContent = ORIGINAL.build;
      $('#ab-where').textContent = `${location.origin}${original ? '' : ': not an address of the original'}`;
    }
    if (!dialog.open) dialog.showModal();
  };
  for (const button of document.querySelectorAll('[data-about]')) button.addEventListener('click', () => open(false));

  // The proof panel opens by typing the author's name, or by clicking the logo seven times.
  let typed = '';
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.target.closest?.('input, textarea, select')) return;
    typed = (typed + e.key.toLowerCase()).slice(-ORIGINAL.author.length);
    if (typed === ORIGINAL.author.toLowerCase()) open(true);
  });
  let clicks = [];
  document.querySelector('.brand').addEventListener('click', () => {
    const now = Date.now();
    clicks = [...clicks.filter(t => now - t < 3000), now];
    if (clicks.length >= 7) {
      clicks = [];
      open(true);
    }
  });
  console.info(`${ORIGINAL.name} by ${ORIGINAL.author}, GNU AGPL v3: ${ORIGINAL.repo} (build ${ORIGINAL.build})`);
}
