/**
 * Scientific Converter | UI layer.
 *
 * The unit database and all conversion arithmetic live in stemkit-core; this
 * file renders the live conversion matrix and handles DOM wiring only.
 *
 * The page presents every unit in a category at once: typing into any field
 * fills all the others. That is why this reads a whole category from UNIT_DB
 * rather than driving a pair of from/to dropdowns.
 */
import { UNIT_DB, Units } from '../src/core/index.js';

document.addEventListener('DOMContentLoaded', () => {

  /* --- 1. Interface bindings --- */
  const matrixGrid = document.getElementById('matrixGrid');
  const tabs = document.querySelectorAll('.cat-tab');
  const catScroller = document.getElementById('catScroller');
  const cardTitle = document.getElementById('scCardTitle');
  const categoryNote = document.getElementById('categoryNote');
  const btnReset = document.getElementById('btnReset');
  const btnExample = document.getElementById('btnExample');
  const btnExampleText = document.getElementById('btnExampleText');
  const toastContainer = document.getElementById('toastContainer');

  if (!matrixGrid) return;

  let activeCategory = 'energy';

  // A value worth seeing in each quantity's first unit: one of the base unit
  // everywhere except temperature, where 1 K says little and room
  // temperature is what people look up.
  const EXAMPLES = { temperature: 298.15 };
  const exampleFor = key => (key in EXAMPLES ? EXAMPLES[key] : 1);

  /* --- 2. Rendering --- */

  // Core keeps symbols plain so it stays presentation-neutral; the page can
  // render the marked-up form when one is provided.
  const label = u => u.nameHtml || u.name;
  const sym = u => u.symbolHtml || u.symbol;
  // "kcal / mol (kcal/mol)" says the same thing twice; show it once.
  const squash = t => String(t).replace(/\s+/g, '');
  const unitLabel = u => (squash(u.name) === squash(u.symbol) ? sym(u) : `${label(u)} (${sym(u)})`);

  const firstUnit = catData => Object.entries(catData.units)[0];

  function renderGrid(categoryKey) {
    const catData = UNIT_DB[categoryKey];
    if (!catData) return;

    activeCategory = categoryKey;

    let activeTab = null;
    tabs.forEach(tab => {
      const isActive = tab.getAttribute('data-cat') === categoryKey;
      tab.setAttribute('aria-pressed', String(isActive));
      if (isActive) activeTab = tab;
    });
    // The card takes the tab's own wording, which is sentence case, rather
    // than the catalogue title in core.
    if (cardTitle && activeTab) cardTitle.textContent = activeTab.textContent.trim();

    if (categoryNote) {
      categoryNote.innerHTML = catData.note
        ? `<i class="fa-solid fa-circle-info" aria-hidden="true"></i>${catData.note}`
        : '';
      categoryNote.hidden = !catData.note;
    }

    if (btnExampleText) {
      const [, unit] = firstUnit(catData);
      btnExampleText.innerHTML = `Try ${exampleFor(categoryKey)} ${sym(unit)}`;
    }

    matrixGrid.innerHTML = '';
    Object.entries(catData.units).forEach(([unitKey, unitData]) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'flex flex-col gap-1.5 relative';

      const refLine = unitData.ref
        ? `<div class="mt-2 pt-2 border-t border-slate-600/60 text-xs text-slate-300 flex items-start gap-1.5"><i class="fa-solid fa-book-bookmark mt-[3px]"></i><span>${unitData.ref}</span></div>`
        : '';

      // The name and symbol are one span: the label is a flex row, and bare
      // text beside <sub>/<sup> would become separate items with the gap
      // between them ("E h", "cm -1").
      wrapper.innerHTML = `
                <div class="flex justify-between items-center">
                    <label for="val_${unitKey}" class="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                        <span class="sc-unit">${unitLabel(unitData)}</span>
                        <span class="info-trigger">
                            <i class="fa-solid fa-circle-info info-icon text-xs"></i>
                            <div class="tooltip absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-80 max-w-[80vw] p-4 bg-slate-800 text-white text-sm rounded-xl shadow-2xl z-50 font-normal leading-relaxed text-left">
                                ${unitData.desc || ''}
                                ${refLine}
                            </div>
                        </span>
                    </label>
                </div>
                <div class="relative flex items-center">
                    <input type="text" inputmode="decimal" id="val_${unitKey}" data-unit="${unitKey}" class="unit-input w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl p-3 pr-12 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors" placeholder="0.0" autocomplete="off" spellcheck="false">
                    <button type="button" class="copy-btn absolute right-3 text-slate-500 dark:text-slate-400 hover:text-brand-600 dark:hover:text-brand-300 transition-colors" data-target="val_${unitKey}" title="Copy value" aria-label="Copy the ${unitData.name} value"><i class="fa-regular fa-copy"></i></button>
                </div>
            `;
      matrixGrid.appendChild(wrapper);
    });

    bindMatrixEvents();
  }

  /* --- 3. Input handling --- */

  /** Trim grouping commas; reject partial entries such as "-" or ".". */
  function parseInput(valStr) {
    const cleanStr = valStr.replace(/,/g, '').trim();
    if (cleanStr === '' || cleanStr === '-' || cleanStr === '.') return null;
    const num = Number(cleanStr);
    return Number.isNaN(num) ? null : num;
  }

  /** Fill every field except the one being typed into. */
  function executeConversion(sourceValue, sourceUnitKey) {
    document.querySelectorAll('.unit-input').forEach(input => {
      const targetKey = input.getAttribute('data-unit');
      if (targetKey === sourceUnitKey) return;

      const result = Units.convert(sourceValue, activeCategory, sourceUnitKey, targetKey);
      input.value = formatResult(result);
    });
  }

  /**
   * Format a converted value for display.
   *
   * The core `formatValue` works in significant figures, which is right for a
   * general-purpose helper but drops meaningful digits from the large,
   * high-precision constants this tool exists to show (e.g. a hartree is
   * 219474.6313632 cm^-1, not 219474.63). So the matrix keeps the original
   * tool's rule: exponential only at the extremes, otherwise up to eight
   * decimal places with trailing zeros trimmed.
   */
  function formatResult(value) {
    if (value === 0 || !Number.isFinite(value)) return '';
    const mag = Math.abs(value);
    if (mag > 1e7 || mag < 1e-4) return value.toExponential(6);
    return parseFloat(value.toFixed(8)).toString();
  }

  /** Mark the field the other numbers were computed from. */
  function markSource(input) {
    document.querySelectorAll('.unit-input').forEach(inp => inp.classList.toggle('is-source', inp === input));
  }

  function bindMatrixEvents() {
    const inputs = document.querySelectorAll('.unit-input');

    inputs.forEach(input => {
      input.addEventListener('input', (e) => {
        const rawVal = e.target.value;
        const parsedValue = parseInput(rawVal);
        markSource(e.target);

        if (parsedValue !== null) {
          executeConversion(parsedValue, e.target.getAttribute('data-unit'));
        } else if (rawVal.trim() === '') {
          inputs.forEach(inp => { if (inp !== e.target) inp.value = ''; });
        }
      });
    });

    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const button = e.currentTarget;
        const targetInput = document.getElementById(button.getAttribute('data-target'));
        if (!targetInput || !targetInput.value) {
          showToast('Nothing to copy yet. Type a value in any field first.');
          return;
        }
        navigator.clipboard.writeText(targetInput.value).then(() => {
          showToast(`Copied ${targetInput.value}`, 'success');
          const icon = button.querySelector('i');
          icon.className = 'fa-solid fa-check text-emerald-600 dark:text-emerald-400';
          setTimeout(() => { icon.className = 'fa-regular fa-copy'; }, 1500);
        }, () => showToast('The browser blocked the clipboard. Select the value and copy it instead.', 'error'));
      });
    });
  }

  /* --- 4. Global listeners --- */
  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      renderGrid(e.currentTarget.getAttribute('data-cat'));
      // On a phone the tabs scroll sideways; keep the chosen one in view.
      e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  });

  // Tell the tab row which of its edges still hide tabs, for the fades.
  const tabRow = catScroller && catScroller.querySelector('.sc-cats');
  function syncTabEdges() {
    if (!tabRow) return;
    const max = tabRow.scrollWidth - tabRow.clientWidth;
    catScroller.dataset.start = String(tabRow.scrollLeft <= 1);
    catScroller.dataset.end = String(tabRow.scrollLeft >= max - 1);
  }
  if (tabRow) {
    tabRow.addEventListener('scroll', syncTabEdges, { passive: true });
    window.addEventListener('resize', syncTabEdges);
    syncTabEdges();
  }

  if (btnReset) btnReset.addEventListener('click', () => {
    document.querySelectorAll('.unit-input').forEach(input => {
      input.value = '';
      input.classList.remove('is-source');
    });
  });

  if (btnExample) btnExample.addEventListener('click', () => {
    const catData = UNIT_DB[activeCategory];
    if (!catData) return;
    const [unitKey] = firstUnit(catData);
    const input = document.getElementById(`val_${unitKey}`);
    if (!input) return;
    input.value = String(exampleFor(activeCategory));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });

  function showToast(message, type = 'info') {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'stk-toast' +
      (type === 'success' ? ' stk-toast-ok' : type === 'error' ? ' stk-toast-danger' : '');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const icon = document.createElement('i');
    icon.className = 'fa-solid ' +
      (type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info');
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    body.textContent = message;
    toast.append(icon, body);
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), type === 'error' ? 5000 : 2200);
  }

  /* --- 5. Documentation tabs (Method & References) --- */
  document.querySelectorAll('.doc-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const key = tab.getAttribute('data-doc-tab');
      document.querySelectorAll('.doc-tab').forEach(t => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      document.querySelectorAll('.doc-pane').forEach(p => {
        const on = p.getAttribute('data-doc-pane') === key;
        p.classList.toggle('active', on);
        p.classList.toggle('doc-enter', on);
      });
    });
  });

  renderGrid('energy');
});
