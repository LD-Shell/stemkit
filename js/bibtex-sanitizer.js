/**
 * BibTeX Sanitizer | UI layer.
 *
 * The brace-aware field reader and the sanitising pipeline live in
 * stemkit-core (`sanitiseText`); this file handles DOM wiring only.
 *
 * The core deliberately operates on the source text rather than round-tripping
 * through a parser: the vendored bibtex-parse-js strips nested braces, so
 * `title = {A study of {NaCl}}` would come back as `A study of NaCl` and lose
 * the capitalisation protection this tool exists to preserve.
 */
import { sanitiseText } from '../src/core/bibtex.js';

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. Interface bindings ---
  const dataInput = document.getElementById('dataInput');
  const bibOutput = document.getElementById('bibOutput');
  const bibResult = document.getElementById('bibResult');
  const bibEmpty = document.getElementById('bibEmpty');
  const btnCopyCode = document.getElementById('btnCopyCode');
  const btnDownload = document.getElementById('btnDownload');
  const btnClear = document.getElementById('btnClear');
  const toastContainer = document.getElementById('toastContainer');
  const statsLabel = document.getElementById('statsLabel');
  const rulesSummary = document.getElementById('rulesSummary');

  const optProtectTitle = document.getElementById('optProtectTitle');
  const optFixPages = document.getElementById('optFixPages');
  const optAlignEquals = document.getElementById('optAlignEquals');
  const stripOpts = document.querySelectorAll('.strip-opt');

  const EXAMPLE = `@article{smith2024,
  title={An analysis of NaCl hydration by NMR},
  author={Smith, John and Doe, Jane},
  journal={Journal of Physics},
  volume={12},
  pages={100-110},
  year={2024},
  doi={10.1000/example},
  url={https://tracking-link.example.com/abc},
  urldate={2024-05-01},
  abstract={A long abstract that bloats the bibliography file.}
}`;

  // --- 2. Event listeners ---
  const inputs = [dataInput, optProtectTitle, optFixPages, optAlignEquals]
    .filter(Boolean);
  inputs.forEach(el => el.addEventListener('input', processPipeline));
  inputs.forEach(el => el.addEventListener('change', processPipeline));
  stripOpts.forEach(opt => opt.addEventListener('change', processPipeline));

  // Offered twice: in the page head and in the empty output.
  document.querySelectorAll('[data-load-example]').forEach(btn => {
    btn.addEventListener('click', () => {
      dataInput.value = EXAMPLE;
      processPipeline();
      showToast('Loaded an example entry.');
    });
  });

  if (btnClear) btnClear.addEventListener('click', () => {
    dataInput.value = '';
    processPipeline();
    dataInput.focus();
  });

  // --- 3. Pipeline (delegated to the core) ---
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function activeFields() {
    return Array.from(stripOpts)
      .filter(opt => opt.checked)
      .map(opt => opt.value.toLowerCase());
  }

  /** The closed Rules panel still says what it will do. */
  function updateRulesSummary() {
    if (!rulesSummary) return;
    const fixes = [optProtectTitle, optFixPages, optAlignEquals]
      .filter(o => o && o.checked).length;
    rulesSummary.textContent =
      `${plural(fixes, 'fix', 'fixes')} on, ${plural(activeFields().length, 'field', 'fields')} removed`;
  }

  function showResult(text) {
    const has = text !== '';
    bibOutput.textContent = text;
    bibResult.hidden = !has;
    bibEmpty.hidden = has;
    btnCopyCode.disabled = !has;
    btnDownload.disabled = !has;
  }

  function processPipeline() {
    updateRulesSummary();
    const rawText = dataInput.value;
    if (btnClear) btnClear.disabled = rawText === '';

    if (!rawText.trim()) {
      showResult('');
      if (statsLabel) statsLabel.textContent = '';
      return;
    }

    const result = sanitiseText(rawText, {
      stripFields: activeFields(),
      fixPages: optFixPages ? optFixPages.checked : false,
      protectTitle: optProtectTitle ? optProtectTitle.checked : false,
      alignEquals: optAlignEquals ? optAlignEquals.checked : false
    });

    const text = result.text.trim();
    showResult(text);

    if (statsLabel) {
      const e = result.entriesProcessed;
      const f = result.fieldsRemoved;
      statsLabel.textContent = e === 0
        ? 'No entries found yet'
        : `${plural(e, 'entry', 'entries')} cleaned` +
          (f > 0 ? `, ${plural(f, 'field', 'fields')} removed` : '');
    }
  }

  // --- 4. Export ---
  if (btnCopyCode) btnCopyCode.addEventListener('click', () => {
    const text = bibOutput.textContent;
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => showToast('Copied the sanitized BibTeX.', 'success'),
      () => showToast('The browser blocked the clipboard. Select the text and copy it instead.', 'error')
    );
  });

  if (btnDownload) btnDownload.addEventListener('click', () => {
    const text = bibOutput.textContent;
    if (!text) return;
    const blob = new Blob([text + '\n'], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sanitized.bib';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('Saved sanitized.bib.', 'success');
  });

  // --- 5. Toasts (the shared .stk-toast component) ---
  function showToast(message, type = 'info') {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'stk-toast' +
      (type === 'success' ? ' stk-toast-ok' : type === 'error' ? ' stk-toast-danger' : '');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const icon = document.createElement('i');
    icon.className = 'fa-solid ' + (type === 'success' ? 'fa-circle-check'
      : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info');
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    body.textContent = message;
    toast.append(icon, body);
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), type === 'error' ? 5000 : 2500);
  }

  processPipeline();
});
