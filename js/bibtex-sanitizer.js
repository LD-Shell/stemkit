/**
 * BibTeX Sanitizer | UI layer.
 *
 * The brace-aware field reader and the sanitising pipeline live in
 * @stemkit/core (`sanitiseText`); this file handles DOM wiring only.
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
  const btnCopyCode = document.getElementById('btnCopyCode');
  const btnDownload = document.getElementById('btnDownload');
  const btnLoadExample = document.getElementById('btnLoadExample');
  const toastContainer = document.getElementById('toastContainer');
  const statsLabel = document.getElementById('statsLabel');

  const optProtectTitle = document.getElementById('optProtectTitle');
  const optFixPages = document.getElementById('optFixPages');
  const optAlignEquals = document.getElementById('optAlignEquals');
  const stripOpts = document.querySelectorAll('.strip-opt');

  const PLACEHOLDER = 'Processed syntax will appear here...';

  const EXAMPLE = `@article{smith2024,
  title={An analysis of {NaCl} molecular dynamics},
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

  document.querySelectorAll('.accordion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', !expanded);
      const target = document.getElementById(btn.getAttribute('data-target'));
      if (target) target.classList.toggle('expanded');
    });
  });

  if (btnLoadExample) btnLoadExample.addEventListener('click', () => {
    dataInput.value = EXAMPLE;
    processPipeline();
    showToast('Loaded a sample entry.');
  });

  // --- 3. Pipeline (delegated to the core) ---
  function processPipeline() {
    const rawText = dataInput.value;

    if (!rawText.trim()) {
      bibOutput.textContent = PLACEHOLDER;
      if (statsLabel) statsLabel.textContent = 'Waiting for input...';
      return;
    }

    const stripFields = Array.from(stripOpts)
      .filter(opt => opt.checked)
      .map(opt => opt.value.toLowerCase());

    const result = sanitiseText(rawText, {
      stripFields,
      fixPages: optFixPages ? optFixPages.checked : false,
      protectTitle: optProtectTitle ? optProtectTitle.checked : false,
      alignEquals: optAlignEquals ? optAlignEquals.checked : false
    });

    bibOutput.textContent = result.text.trim() || PLACEHOLDER;

    if (statsLabel) {
      const e = result.entriesProcessed;
      const f = result.fieldsRemoved;
      statsLabel.textContent =
        `${e} ${e === 1 ? 'entry' : 'entries'} processed` +
        (f > 0 ? ` · ${f} ${f === 1 ? 'field' : 'fields'} removed` : '');
    }
  }

  // --- 4. Export ---
  if (btnCopyCode) btnCopyCode.addEventListener('click', () => {
    const text = bibOutput.textContent;
    if (!text || text === PLACEHOLDER) return;
    navigator.clipboard.writeText(text).then(() => showToast('BibTeX copied.'));
  });

  if (btnDownload) btnDownload.addEventListener('click', () => {
    const text = bibOutput.textContent;
    if (!text || text === PLACEHOLDER) return;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sanitized.bib';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('Downloaded sanitized.bib');
  });

  // --- 5. Toasts ---
  function showToast(message) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className =
      'bg-slate-800 text-white text-xs font-bold px-4 py-2 rounded-lg shadow-xl ' +
      'transition-opacity duration-300';
    toast.innerText = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  processPipeline();
});
