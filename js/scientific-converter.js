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
// The units module alone: the whole library would load every other module
// (about 1 MB) for nothing.
import * as Units from '../src/core/units.js';

const { UNIT_DB } = Units;

/* --- Reading and writing numbers ---
   Pure, so the tests can import them; the page below is the only caller. */

const SIGN = '[+\\-\u2212]?';
const EXPONENT = `(?:[eE]${SIGN}\\d+)?`;
const PLAIN = new RegExp(`^${SIGN}(?:\\d+\\.?\\d*|\\.\\d+)${EXPONENT}$`);
const GROUPED = new RegExp(`^${SIGN}[1-9]\\d{0,2}(?:,\\d{3})+(?:\\.\\d*)?${EXPONENT}$`);

/**
 * Read a typed number, or say why it is not one.
 *
 * A result is only ever shown for the number the person meant, so anything
 * that could be read two ways is refused rather than guessed. The rule:
 *
 *  1. White space around the text is ignored. Nothing at all is `empty`,
 *     which is not an error.
 *  2. A number is an optional sign (+, - or the typographic minus), digits
 *     with at most one decimal point and a digit on at least one side of it
 *     (`5`, `5.`, `.5`, `0.5`), and optionally an exponent: e or E, an
 *     optional sign and at least one digit (`-2e-3`, `1.5E3`).
 *  3. Commas are thousands separators, and only where they can be nothing
 *     else: the whole part is a group of one to three digits, not starting
 *     with 0, then groups of exactly three, and either there are two or more
 *     commas (`1,234,567`) or a decimal point follows (`1,234.5`).
 *  4. Everything else is refused. One comma and no point (`1,5`, `1,500`)
 *     may be a decimal comma or a thousands separator: reason `comma`, with
 *     the two readings to choose from. Other misplaced commas are `comma`
 *     too. `0x10`, `Infinity`, `NaN`, `1e`, `1 000`, `1.2.3` and a lone sign
 *     or point are `format`.
 *  5. A number a double cannot hold is refused as `range`: one that
 *     overflows (`1e999`), or one that is not zero but would be stored as
 *     zero (`1e-999`).
 *
 * @param {string} text
 * @returns {{ok: true, value: number} | {ok: false, reason: 'empty'|'comma'|'format'|'range', readings?: string[]}}
 */
export function parseInput(text) {
  const typed = String(text).trim();
  if (typed === '') return { ok: false, reason: 'empty' };

  let digits;
  if (PLAIN.test(typed)) digits = typed;
  else if (GROUPED.test(typed) && (typed.includes('.') || typed.split(',').length > 2)) digits = typed.replace(/,/g, '');
  else if (typed.includes(',')) {
    const lone = /^([+\-\u2212]?)(\d+),(\d+)$/.exec(typed);
    if (!lone) return { ok: false, reason: 'comma' };
    const [, sign, whole, rest] = lone;
    return { ok: false, reason: 'comma', readings: [`${sign}${whole}.${rest}`, sign + `${whole}${rest}`.replace(/^0+(?=\d)/, '')] };
  } else return { ok: false, reason: 'format' };

  const value = Number(digits.replace(/\u2212/g, '-'));
  const mantissa = digits.split(/[eE]/)[0];
  if (!Number.isFinite(value) || (value === 0 && /[1-9]/.test(mantissa))) return { ok: false, reason: 'range' };
  return { ok: true, value };
}

/**
 * What to tell the person about text {@link parseInput} refused: one short
 * sentence saying how to type the number. Empty when there is nothing to say.
 *
 * @param {ReturnType<typeof parseInput>} parsed
 * @returns {string}
 */
export function inputMessage(parsed) {
  if (parsed.ok || parsed.reason === 'empty') return '';
  if (parsed.reason === 'comma') {
    return parsed.readings
      ? `A comma here could mean ${parsed.readings[0]} or ${parsed.readings[1]}. Type the one you mean.`
      : 'Commas only work between groups of three digits, as in 1,234,567 or 1,234.5.';
  }
  if (parsed.reason === 'range') return 'This number is too large or too small to convert.';
  return 'Type a number such as 1234.5 or 1.5e-3.';
}

/**
 * Format a converted value for display.
 *
 * The core `formatValue` works in significant figures, which is right for a
 * general-purpose helper but drops meaningful digits from the large,
 * high-precision constants this tool exists to show (e.g. a hartree is
 * 219474.6313632 cm^-1, not 219474.63). So the matrix keeps the original
 * tool's rule: exponential only at the extremes, otherwise up to eight
 * decimal places with trailing zeros trimmed. Zero is a result like any
 * other (273.15 K is 0 degC); only a value with no finite answer is blank.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatResult(value) {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const mag = Math.abs(value);
  if (mag > 1e7 || mag < 1e-4) return value.toExponential(6);
  return parseFloat(value.toFixed(8)).toString();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {

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
  // The same in plain text, for the names of a unit's buttons: three fields
  // are called "Energy" in spectroscopy, and the symbol tells them apart.
  const unitText = u => (squash(u.name) === squash(u.symbol) ? u.symbol : `${u.name} (${u.symbol})`);

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

    closeNote();
    matrixGrid.innerHTML = '';
    Object.entries(catData.units).forEach(([unitKey, unitData]) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'flex flex-col gap-1.5 relative';

      const refLine = unitData.ref
        ? `<div class="mt-2 pt-2 border-t border-slate-600/60 text-xs text-slate-300 flex items-start gap-1.5"><i class="fa-solid fa-book-bookmark mt-[3px]" aria-hidden="true"></i><span>${unitData.ref}</span></div>`
        : '';

      // The note is a tooltip on a button of its own, beside the label rather
      // than inside it: a label names its field and nothing else, and a
      // button can be reached by keyboard and by touch. The button points at
      // the note with aria-describedby, so a screen reader reads it there.
      wrapper.innerHTML = `
                <div class="sc-field-head">
                    <label for="val_${unitKey}" class="text-sm font-bold text-slate-700 dark:text-slate-300">
                        <span class="sc-unit">${unitLabel(unitData)}</span>
                    </label>
                    <div class="info-trigger">
                        <button type="button" class="info-btn" aria-label="About ${unitText(unitData)}" aria-describedby="tip_${unitKey}"><i class="fa-solid fa-circle-info" aria-hidden="true"></i></button>
                        <div class="sc-tip" id="tip_${unitKey}" role="tooltip">
                            <div class="p-4 bg-slate-800 text-white text-sm rounded-xl shadow-2xl font-normal leading-relaxed text-left">
                                ${unitData.desc || ''}
                                ${refLine}
                            </div>
                        </div>
                    </div>
                </div>
                <div class="relative flex items-center">
                    <input type="text" inputmode="decimal" id="val_${unitKey}" data-unit="${unitKey}" class="unit-input w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl p-3 pr-12 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors" placeholder="0.0" autocomplete="off" spellcheck="false">
                    <button type="button" class="copy-btn absolute right-3 text-slate-500 dark:text-slate-400 hover:text-brand-600 dark:hover:text-brand-300 transition-colors" data-target="val_${unitKey}" title="Copy value" aria-label="Copy the ${unitText(unitData)} value"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>
                </div>
                <p class="stk-error sc-field-msg" id="err_${unitKey}" aria-live="polite"></p>
            `;
      matrixGrid.appendChild(wrapper);
    });

    bindMatrixEvents();
  }

  /* --- 3. Input handling --- */

  const fields = () => matrixGrid.querySelectorAll('.unit-input');

  /** Fill every field except the one being typed into. */
  function executeConversion(sourceValue, sourceUnitKey) {
    fields().forEach(input => {
      const targetKey = input.getAttribute('data-unit');
      if (targetKey === sourceUnitKey) return;

      const result = Units.convert(sourceValue, activeCategory, sourceUnitKey, targetKey);
      input.value = formatResult(result);
    });
  }

  /** Empty every field but the one given (or all of them). */
  function clearOthers(source) {
    fields().forEach(input => { if (input !== source) input.value = ''; });
  }

  /**
   * Say what is wrong with a field, or that nothing is. The message sits
   * under the field and is tied to it, so it is read with the field; only
   * the field being typed into can be wrong, so every other one is reset.
   */
  function markInvalid(source, message) {
    fields().forEach(input => {
      const note = document.getElementById(`err_${input.getAttribute('data-unit')}`);
      const bad = input === source && message !== '';
      if (bad) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', note.id);
        note.innerHTML = '<i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><span></span>';
        note.lastChild.textContent = message;
      } else {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
        note.textContent = '';
      }
    });
  }

  /** Mark the field the other numbers were computed from. */
  function markSource(input) {
    fields().forEach(inp => inp.classList.toggle('is-source', inp === input));
  }

  /* --- Unit notes ---
     One note is open at a time. Pointing at a unit's button or reaching it
     with the keyboard opens its note for as long as the pointer or the focus
     stays; pressing the button keeps it open, which is how touch gets it,
     and pressing again, Escape, or a press anywhere else closes it. */
  let openNote = null;
  let noteTimer = 0;

  function closeNote() {
    clearTimeout(noteTimer);
    if (openNote) openNote.removeAttribute('data-open');
    openNote = null;
  }

  function showNote(trigger, how) {
    clearTimeout(noteTimer);
    if (openNote && openNote !== trigger) closeNote();
    openNote = trigger;
    trigger.setAttribute('data-open', how);
  }

  function bindNotes() {
    matrixGrid.querySelectorAll('.info-trigger').forEach(trigger => {
      const button = trigger.querySelector('.info-btn');
      const opened = () => trigger.getAttribute('data-open');

      trigger.addEventListener('mouseenter', () => {
        if (opened()) clearTimeout(noteTimer);
        else showNote(trigger, 'hover');
      });
      // A moment's grace, so the pointer can cross from the button to the
      // note without the note closing under it.
      trigger.addEventListener('mouseleave', () => {
        if (opened() !== 'hover') return;
        noteTimer = setTimeout(() => { if (opened() === 'hover') closeNote(); }, 150);
      });
      button.addEventListener('focus', () => {
        if (!opened() && button.matches(':focus-visible')) showNote(trigger, 'focus');
      });
      // Focus moving on closes the note. A press on the note itself (to
      // select its text) also takes focus from the button, to nowhere, and
      // must not close a note that was pressed open.
      button.addEventListener('blur', (e) => {
        if (opened() === 'focus' || (opened() === 'pinned' && e.relatedTarget)) closeNote();
      });
      button.addEventListener('click', () => {
        if (opened() === 'hover' || !opened()) showNote(trigger, 'pinned');
        else closeNote();
      });
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openNote) closeNote();
  });
  document.addEventListener('pointerdown', (e) => {
    if (openNote && !openNote.contains(e.target)) closeNote();
  });

  function bindMatrixEvents() {
    fields().forEach(input => {
      input.addEventListener('input', (e) => {
        const parsed = parseInput(e.target.value);
        markSource(e.target);
        markInvalid(e.target, inputMessage(parsed));

        // Text that is not a number leaves nothing to show: the other fields
        // would otherwise keep the results of whatever was typed before it.
        if (parsed.ok) executeConversion(parsed.value, e.target.getAttribute('data-unit'));
        else clearOthers(e.target);
      });
    });

    bindNotes();

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
    clearOthers(null);
    markSource(null);
    markInvalid(null, '');
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
  // The method tabs follow the ARIA tabs pattern: the selected tab carries
  // aria-selected, only it is in the tab order, and the arrow keys, Home and
  // End move between tabs, selecting as they go. Each pane is named by its
  // tab, and a pane with nothing in it to focus is a tab stop itself, so the
  // keyboard reaches its text.
  const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const docTabs = Array.from(document.querySelectorAll('.doc-tab'));
  const docPanes = Array.from(document.querySelectorAll('.doc-pane'));
  function selectDocTab(tab, focus) {
    const key = tab.getAttribute('data-doc-tab');
    docTabs.forEach(x => {
      const on = x === tab;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', on ? 'true' : 'false');
      x.tabIndex = on ? 0 : -1;
    });
    docPanes.forEach(pane => {
      const on = pane.getAttribute('data-doc-pane') === key;
      pane.classList.toggle('active', on);
      pane.classList.toggle('doc-enter', on);
    });
    if (focus) tab.focus();
  }
  docPanes.forEach(pane => {
    if (pane.querySelector(FOCUSABLE)) pane.removeAttribute('tabindex');
    else pane.tabIndex = 0;
  });
  docTabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectDocTab(tab, false));
    tab.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const last = docTabs.length - 1;
      const to = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      selectDocTab(docTabs[to], true);
    });
  });

  renderGrid('energy');
});
