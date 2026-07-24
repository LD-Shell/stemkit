/**
 * Scientific Converter | UI layer.
 *
 * The unit database and all conversion arithmetic live in @stemkit/core; this
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
  const categoryBadge = document.getElementById('categoryBadge');
  const categoryIcon = document.getElementById('categoryIcon');
  const categoryName = document.getElementById('categoryName');
  const categoryNote = document.getElementById('categoryNote');
  const btnReset = document.getElementById('btnReset');
  const toastContainer = document.getElementById('toastContainer');

  if (!matrixGrid) return;

  let activeCategory = 'energy';
  let activeColor = 'orange';

  /* --- 2. Rendering --- */

  // Core keeps symbols plain so it stays presentation-neutral; the page can
  // render the marked-up form when one is provided.
  const label = u => u.nameHtml || u.name;
  const sym = u => u.symbolHtml || u.symbol;

  function renderGrid(categoryKey) {
    const catData = UNIT_DB[categoryKey];
    if (!catData) return;

    activeCategory = categoryKey;
    activeColor = catData.color;

    if (categoryIcon) categoryIcon.className = `fa-solid ${catData.icon}`;
    if (categoryName) categoryName.innerText = catData.title;
    if (categoryBadge) {
      categoryBadge.className =
        `inline-flex items-center gap-2 bg-${activeColor}-100 dark:bg-${activeColor}-900/30 ` +
        `text-${activeColor}-700 dark:text-${activeColor}-400 px-3 py-1 rounded-full text-xs ` +
        `font-bold uppercase tracking-widest mb-4 border border-${activeColor}-200 ` +
        `dark:border-${activeColor}-800/50 transition-colors`;
    }

    if (categoryNote) {
      categoryNote.innerHTML = catData.note
        ? `<i class="fa-solid fa-circle-info mr-1 text-${activeColor}-500"></i> ${catData.note}`
        : '';
      categoryNote.style.display = catData.note ? 'block' : 'none';
    }

    tabs.forEach(tab => {
      const isActive = tab.getAttribute('data-cat') === categoryKey;
      const tColor = tab.getAttribute('data-color');
      tab.className = isActive
        ? `cat-tab px-5 py-2.5 rounded-xl text-sm transition-all border border-${tColor}-300 ` +
          `dark:border-${tColor}-700 bg-${tColor}-50 dark:bg-${tColor}-900/20 text-${tColor}-700 ` +
          `dark:text-${tColor}-300 font-bold whitespace-nowrap shadow-sm`
        : 'cat-tab px-5 py-2.5 rounded-xl text-sm transition-all border border-slate-200 ' +
          'dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 ' +
          'hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap';
      tab.setAttribute('aria-pressed', String(isActive));
    });

    matrixGrid.innerHTML = '';
    Object.entries(catData.units).forEach(([unitKey, unitData]) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'flex flex-col gap-1.5 relative';

      const refLine = unitData.ref
        ? `<div class="mt-2 pt-2 border-t border-slate-600/60 text-xs text-slate-300 flex items-start gap-1.5"><i class="fa-solid fa-book-bookmark mt-[3px]"></i><span>${unitData.ref}</span></div>`
        : '';

      wrapper.innerHTML = `
                <div class="flex justify-between items-center">
                    <label for="val_${unitKey}" class="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                        ${label(unitData)} (${sym(unitData)})
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
                    <input type="text" inputmode="decimal" id="val_${unitKey}" data-unit="${unitKey}" class="unit-input w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl p-3 pr-12 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-${activeColor}-500 transition-all" placeholder="0.0">
                    <button class="copy-btn absolute right-3 text-slate-400 hover:text-${activeColor}-500 transition-colors" data-target="val_${unitKey}" title="Copy value" aria-label="Copy value"><i class="fa-regular fa-copy"></i></button>
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

  function bindMatrixEvents() {
    const inputs = document.querySelectorAll('.unit-input');

    inputs.forEach(input => {
      input.addEventListener('input', (e) => {
        const rawVal = e.target.value;
        const parsedValue = parseInput(rawVal);

        if (parsedValue !== null) {
          executeConversion(parsedValue, e.target.getAttribute('data-unit'));
        } else if (rawVal.trim() === '') {
          inputs.forEach(inp => { if (inp !== e.target) inp.value = ''; });
        }
      });

      input.addEventListener('focus', (e) => {
        inputs.forEach(inp => inp.classList.remove(
          `bg-${activeColor}-50`, `dark:bg-${activeColor}-900/20`, `border-${activeColor}-400`));
        e.target.classList.add(
          `bg-${activeColor}-50`, `dark:bg-${activeColor}-900/20`, `border-${activeColor}-400`);
      });
    });

    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetInput = document.getElementById(e.currentTarget.getAttribute('data-target'));
        if (!targetInput || !targetInput.value) return;
        navigator.clipboard.writeText(targetInput.value).then(() => {
          showToast('Value copied to clipboard!');
          const icon = e.currentTarget.querySelector('i');
          icon.className = 'fa-solid fa-check text-emerald-500';
          setTimeout(() => { icon.className = 'fa-regular fa-copy'; }, 1500);
        });
      });
    });
  }

  /* --- 4. Global listeners --- */
  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      renderGrid(e.currentTarget.getAttribute('data-cat'));
    });
  });

  if (btnReset) btnReset.addEventListener('click', () => {
    document.querySelectorAll('.unit-input').forEach(input => {
      input.value = '';
      input.classList.remove(
        `bg-${activeColor}-50`, `dark:bg-${activeColor}-900/20`, `border-${activeColor}-400`);
    });
  });

  function showToast(message) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'bg-slate-800 text-white text-xs font-bold px-4 py-2 rounded-lg shadow-xl transform transition-all duration-300 translate-y-[-20px] opacity-0';
    toast.innerText = message;
    toastContainer.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.remove('translate-y-[-20px]', 'opacity-0');
      toast.classList.add('translate-y-0', 'opacity-100');
    });

    setTimeout(() => {
      toast.classList.remove('translate-y-0', 'opacity-100');
      toast.classList.add('translate-y-[-20px]', 'opacity-0');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  /* --- 5. Documentation tabs (Method & References) --- */
  document.querySelectorAll('.doc-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const key = tab.getAttribute('data-doc-tab');
      document.querySelectorAll('.doc-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.doc-pane').forEach(p =>
        p.classList.toggle('active', p.getAttribute('data-doc-pane') === key));
    });
  });

  renderGrid('energy');
});
