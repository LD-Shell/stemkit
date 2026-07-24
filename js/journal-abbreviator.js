/**
 * Journal Abbreviator | UI layer.
 *
 * The dictionary engine, matching, and unknown-title detection live in
 * @stemkit/core; this file handles DOM wiring and highlighted rendering.
 */
import {
  buildEngine,
  parseCustomRules,
  processText,
  segmentText,
  findUnknownTitles
} from '../src/core/journals.js';
import { loadIso4, deriveRulesForUnknowns } from '../src/core/iso4.js';

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. Interface bindings ---
  const dataInput = document.getElementById('dataInput');
  const visualOutput = document.getElementById('visualOutput');
  const rawOutput = document.getElementById('rawOutput');
  const btnClear = document.getElementById('btnClear');
  const btnCopyText = document.getElementById('btnCopyText');
  const btnExample = document.getElementById('btnExample');
  const toggleHighlights = document.getElementById('toggleHighlights');
  const customRules = document.getElementById('customRules');
  const dictLabel = document.getElementById('dictLabel');
  const statsLabel = document.getElementById('statsLabel');
  const toastContainer = document.getElementById('toastContainer');

  // Chosen to exercise the awkward cases: a lowercase journal name, one with a
  // colon in the title, a "The ..." prefix, and a journal absent from the
  // dictionary so the unmatched path is visible too.
  const EXAMPLE = [
    'Smith, J.; Doe, A. Journal of the American Chemical Society 2024, 146, 1122.',
    'Lee, K. et al. Physical Review Letters 2023, 130, 045501.',
    'Patel, R. Chemical Communications 2022, 58, 8890.',
    'Nguyen, T. energy & environmental science 2021, 14, 4561.',
    'Garcia, M. The Journal of Chemical Physics 2020, 153, 044302.',
    'Zhou, L. Journal of Physics: Condensed Matter 2019, 31, 275901.',
    'Okafor, C. Journal of Imaginary Results 2018, 3, 12.'
  ].join('\n');

  let engine = null;

  // Tier two: the ISO 4 word list. Optional, the tool works without it, just
  // limited to titles the dictionary already knows.
  let iso4Engine = null;
  let iso4Stats = null;
  let iso4Status = 'idle';   // idle | loading | ready | absent | error

  /** Where the LTWA export is expected to live, relative to the page. */
  const LTWA_PATH = 'abbr/abbreviation.csv';

  /**
   * Load the LTWA once, in the background.
   *
   * The export is a couple of megabytes, so this deliberately does not block
   * first paint: the dictionary tier renders immediately and the page
   * re-renders if and when the word list arrives.
   */
  async function loadIso4Engine() {
    if (iso4Status !== 'idle') return;
    iso4Status = 'loading';
    updateDictLabel();
    try {
      const res = await fetch(LTWA_PATH);
      if (!res.ok) {
        iso4Status = res.status === 404 ? 'absent' : 'error';
        updateDictLabel();
        return;
      }
      const text = await res.text();
      const { engine: e, stats } = loadIso4(text);
      if (!stats.indexed) {
        iso4Status = 'error';
        updateDictLabel();
        return;
      }
      iso4Engine = e;
      iso4Stats = stats;
      iso4Status = 'ready';
      updateDictLabel();
      render();
      showToast(`ISO 4 word list loaded, ${stats.indexed.toLocaleString()} rules.`);
    } catch (err) {
      console.error(err);
      iso4Status = 'error';
      updateDictLabel();
    }
  }

  // --- 2. Engine construction ---
  function rebuildEngine() {
    // The built-in dictionary is installed as a global by js/journal-data.js.
    const builtin = Array.isArray(window.STEMKIT_JOURNALS)
      ? window.STEMKIT_JOURNALS
      : [];
    const custom = parseCustomRules(customRules ? customRules.value : '');

    engine = buildEngine(builtin, custom);

    updateDictLabel();
  }

  /** Report both tiers, so it is clear which one produced a result. */
  function updateDictLabel() {
    if (!dictLabel || !engine) return;
    let label =
      `${engine.builtinCount} built-in` +
      (engine.customCount ? ` + ${engine.customCount} custom` : '') +
      ` (${engine.entryCount} unique)`;

    if (iso4Status === 'ready' && iso4Stats) {
      label += ` · ISO 4: ${iso4Stats.indexed.toLocaleString()} word rules`;
    } else if (iso4Status === 'loading') {
      label += ' · loading ISO 4 word list…';
    } else if (iso4Status === 'error') {
      label += ' · ISO 4 word list could not be read';
    }
    dictLabel.textContent = label;
  }

  // --- 3. Event listeners ---
  if (dataInput) dataInput.addEventListener('input', render);

  // Custom rules persist across sessions, so a user's house style survives a
  // reload. Storage may be unavailable (private mode, disabled), in which case
  // the tool still works, it just does not remember between visits.
  const CUSTOM_STORE_KEY = 'stemkit-journal-custom-rules';
  if (customRules) {
    try {
      const saved = localStorage.getItem(CUSTOM_STORE_KEY);
      if (saved) {
        customRules.value = saved;
        rebuildEngine();
      }
    } catch (e) { /* storage unavailable | run without persistence */ }

    let debounce = null;
    customRules.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        try { localStorage.setItem(CUSTOM_STORE_KEY, customRules.value); } catch (e) {}
        rebuildEngine();
        render();
      }, 250);
    });
  }
  if (toggleHighlights) toggleHighlights.addEventListener('change', render);

  document.querySelectorAll('.accordion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', !expanded);
      const target = document.getElementById(btn.getAttribute('data-target'));
      if (target) target.classList.toggle('expanded');
    });
  });

  if (btnExample) btnExample.addEventListener('click', () => {
    dataInput.value = EXAMPLE;
    render();
  });

  if (btnClear) btnClear.addEventListener('click', () => {
    dataInput.value = '';
    render();
  });

  // --- 4. Rendering ---

  /**
   * Engine to use for this pass.
   *
   * The dictionary is authoritative, so it runs first. Anything it did not
   * recognise is put through ISO 4, and the results are folded back in as
   * ordinary rules, that way replacement, highlighting and counting all stay
   * in one code path instead of being duplicated per tier.
   */
  function activeEngine(text) {
    if (!iso4Engine || !engine) return engine;

    const unknowns = findUnknownTitles(text, engine);
    if (!unknowns.length) return engine;

    const derived = deriveRulesForUnknowns(unknowns, iso4Engine);
    if (!derived.length) return engine;

    const builtin = Array.isArray(window.STEMKIT_JOURNALS)
      ? window.STEMKIT_JOURNALS
      : [];
    const custom = parseCustomRules(customRules ? customRules.value : '');
    return buildEngine(builtin, [...custom, ...derived]);
  }

  function render() {
    if (!engine) rebuildEngine();
    const text = dataInput ? dataInput.value : '';

    if (!text.trim()) {
      if (visualOutput) {
        visualOutput.innerHTML =
          '<span class="text-slate-400">Paste a reference list to abbreviate.</span>';
      }
      if (rawOutput) rawOutput.textContent = '';
      if (statsLabel) statsLabel.textContent = '';
      return;
    }

    const eng = activeEngine(text);
    const result = processText(text, eng);
    if (rawOutput) rawOutput.textContent = result.text;

    const highlight = toggleHighlights ? toggleHighlights.checked : true;
    if (visualOutput) {
      visualOutput.innerHTML = highlight
        ? renderHighlighted(text, eng)
        : escapeHtml(result.text);
    }

    if (statsLabel) {
      // Recognised counts every dictionary hit; changed counts only the ones
      // that actually rewrote the text, since some journals are not
      // abbreviated at all.
      const changed = result.replacements.filter(r => r.changed).length;
      const unknown = result.unknown.length;
      statsLabel.textContent =
        `${changed} abbreviated · ${result.replacements.length} recognised` +
        (unknown ? ` · ${unknown} unknown` : '');
    }
  }

  /** Build highlighted HTML from the core's segments. */
  function renderHighlighted(text, eng) {
    const segments = segmentText(text, eng || engine);
    const parts = [];

    for (const seg of segments) {
      if (seg.type === 'text') {
        parts.push(markUnknown(seg.value));
        continue;
      }
      const cls = seg.changed
        ? 'ja-hit'
        : 'ja-hit ja-hit-identity';
      parts.push(
        `<mark class="${cls}" title="${escapeHtml(seg.original)}">` +
        `${escapeHtml(seg.value)}</mark>`
      );
    }
    return parts.join('');
  }

  /** Flag journal-like titles the dictionary does not know. */
  function markUnknown(chunk) {
    const unknown = findUnknownTitles(chunk, engine);
    if (unknown.length === 0) return escapeHtml(chunk);

    let html = escapeHtml(chunk);
    for (const title of unknown) {
      const escaped = escapeHtml(title);
      html = html.split(escaped).join(
        `<mark class="ja-unknown" title="Not in the dictionary">${escaped}</mark>`
      );
    }
    return html;
  }

  // --- 5. Copy ---
  if (btnCopyText) btnCopyText.addEventListener('click', () => {
    const text = rawOutput ? rawOutput.textContent : '';
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => showToast('Abbreviated text copied.'));
  });

  // --- 6. Utilities ---
  function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

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

  rebuildEngine();
  render();

  // Kick off the optional ISO 4 tier; the dictionary already works.
  loadIso4Engine();

});