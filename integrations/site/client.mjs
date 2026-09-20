// SPDX-License-Identifier: SUL-1.0
// Progressive enhancements for the static Worker Routing product page.
// Dependency-free: no fetch, storage, cookies, analytics or external requests.
// The canonical modules under /lib are copied into the build unchanged; this
// file only wires the coordinator's DOM to renderShareSVG and SHARE_SLOGANS.

import {renderShareSVG} from './lib/share.mjs';
import {SHARE_SLOGANS} from './lib/share-style.mjs';
import {DEMO_SHARE} from './demo.mjs';

const DEFAULT_THEME = 'sage';
const DEFAULT_PRESET = 'together';
const DEMO_FORMAT = 'banner';

// The page language is authoritative and already set by the coordinator.
const readLang = () => (String(document.documentElement.lang || '').trim().toLowerCase().startsWith('zh') ? 'zh' : 'en');
const say = (zh, en) => (readLang() === 'zh' ? zh : en);

// Synthetic sampler copy only: the selected preset's slogan for the page language.
const sloganFor = preset => {
  const entry = SHARE_SLOGANS.find(item => item.id === preset);
  return readLang() === 'zh' ? entry.zh : entry.en;
};

const svgBlobUrl = svg => URL.createObjectURL(new Blob([svg], {type: 'image/svg+xml'}));

// --- Share-card sampler -----------------------------------------------------

function initShareSampler() {
  const img = document.querySelector('#demo-preview');
  const themeButtons = [...document.querySelectorAll('[data-demo-theme]')];
  const presetSelect = document.querySelector('#demo-preset');
  const download = document.querySelector('[data-download-demo]');
  const status = document.querySelector('#demo-status');
  const lang = readLang();

  let theme = DEFAULT_THEME;
  let preset = DEFAULT_PRESET;
  let url = null;

  // Human labels for the live status line, never the internal ids.
  const activeThemeLabel = () => themeButtons.find(button => button.dataset.demoTheme === theme).getAttribute('aria-label');
  const selectedPresetLabel = () => presetSelect.selectedOptions[0].textContent;

  // Replace only the preview src; controls are never rebuilt and focus stays put.
  const emit = () => {
    if (url) URL.revokeObjectURL(url);
    url = svgBlobUrl(renderShareSVG(DEMO_SHARE, DEMO_FORMAT, lang, theme, {slogan: sloganFor(preset)}));
    img.src = url;
  };

  const reflectTheme = () => {
    for (const button of themeButtons) button.setAttribute('aria-pressed', String(button.dataset.demoTheme === theme));
  };

  const announce = () => {
    const themeLabel = activeThemeLabel();
    const presetLabel = selectedPresetLabel();
    status.textContent = say(`已预览 ${themeLabel} 主题，${presetLabel} 文案。`, `Previewing the ${themeLabel} theme with the ${presetLabel} slogan.`);
  };

  presetSelect.value = preset;
  reflectTheme();
  emit();

  for (const button of themeButtons) {
    button.addEventListener('click', () => {
      theme = button.dataset.demoTheme;
      reflectTheme();
      emit();
      announce();
    });
  }

  presetSelect.addEventListener('change', () => {
    preset = presetSelect.value;
    emit();
    announce();
  });

  download.addEventListener('click', () => {
    const name = `worker-routing-demo-${theme}-${lang}.svg`;
    const objectUrl = svgBlobUrl(renderShareSVG(DEMO_SHARE, DEMO_FORMAT, lang, theme, {slogan: sloganFor(preset)}));
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    status.textContent = say(`已开始下载 ${name}。`, `Download started: ${name}.`);
  });
}

// --- Install-prompt copy button --------------------------------------------

function selectPrompt(prompt) {
  const range = document.createRange();
  range.selectNodeContents(prompt);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function initInstallCopy() {
  const button = document.querySelector('[data-copy-install]');
  const prompt = document.querySelector('#install-prompt');
  const status = document.querySelector('#install-status');

  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(prompt.textContent);
      status.textContent = say('已复制安装提示。', 'Install prompt copied.');
    } catch {
      selectPrompt(prompt);
      status.textContent = say('未能自动复制，已选中内容，请手动复制。', 'Copy failed; the text is selected — copy it manually.');
    }
  });
}

initShareSampler();
initInstallCopy();
