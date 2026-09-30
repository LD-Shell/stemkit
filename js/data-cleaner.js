/**
 * Data Cleaner | the page.
 *
 * The rules live in stemkit-core: core/data-cleaning.js reads the file, runs
 * the steps and replays a recipe; core/data-cleaning-python.js writes the
 * same recipe as a pandas script; js/python-panel.js shows that script. This
 * file wires them to the page: the file and how it is read, the form that
 * adds or edits a step, the recipe with undo and redo, the table preview and
 * the downloads.
 *
 * The recipe is the single source of truth. Every change (add, edit, switch
 * off, move, remove, undo) replaces the list of steps, and the table is
 * worked out again from the file as read, reusing the unchanged start.
 */
import {
  readTable, runRecipe, writeTable, describeStep, checkStep, checkRecipe, profileTable, readCell,
  parseRecipe, recipeToJSON, normaliseStep, applyStep, cellText, stripSpaces, exactMean, exactPopulationSD, median
} from '../src/core/data-cleaning.js';
import { generateCleaningScript, cleaningFileNames } from '../src/core/data-cleaning-python.js';
import { createPythonPanel } from './python-panel.js';

// A small file with the problems the tool is for: gaps, a repeated row,
// names typed with stray spaces and mixed case, a note in a number column,
// and a concentration spanning four orders of magnitude (try log10).
const SAMPLE_NAME = 'sample_measurements.csv';
const SAMPLE_CSV = [
  'sample,temperature_K,yield_pct,concentration_mM,operator',
  'S01,298,45.2,0.12,ana',
  'S02,303,47.9,0.35,Ben ',
  'S03,308,,1.10,ana',
  'S04,313,53.1,3.40,carl',
  'S05,318,55.8,,ben',
  'S02,303,47.9,0.35,Ben ',
  'S06,323,58.2,10.5, Ana',
  'S07,328,n.d.,32.0,carl',
  'S08,333,63.7,98.0,BEN',
  'S09,338,66.4,310,ana',
  'S10,343,68.9,950,Carl'
].join('\n') + '\n';

const PREVIEW_ROWS = 200;
const EMBED_LIMIT = 200000;

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : (many || `${one}s`)}`;
const clone = steps => steps.map(s => ({ ...s, columns: s.columns ? [...s.columns] : s.columns }));

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => startPage());
  else startPage();
}

function startPage() {
  const $ = id => document.getElementById(id);
  const ui = {
    toasts: $('dcToasts'), live: $('dcLive'),
    drop: $('uploadZone'), fileInput: $('fileInput'), choose: $('chooseFileBtn'), sample: $('loadSampleBtn'),
    pending: $('dcPendingRecipe'), workspace: $('workspace'),
    fileName: $('fileName'), meta: $('dataMeta'), change: $('changeFileBtn'),
    delimiter: $('readDelimiter'), decimal: $('readDecimal'), header: $('readHeader'),
    undo: $('undoBtn'), redo: $('redoBtn'),
    suggest: $('dcSuggest'), suggestList: $('dcSuggestList'),
    form: $('dcForm'), formTitle: $('dcFormTitle'), cancel: $('dcFormCancel'), action: $('dcAction'),
    fields: $('dcFields'), add: $('dcAddBtn'), effect: $('dcEffect'),
    count: $('dcRecipeCount'), save: $('dcSaveRecipe'), save2: $('dcSaveRecipe2'), open: $('dcOpenRecipe'),
    clear: $('dcClearRecipe'), recipeFile: $('dcRecipeFile'), empty: $('dcRecipeEmpty'), steps: $('dcSteps'),
    viewing: $('dcViewing'), viewingText: $('dcViewingText'), viewFinal: $('dcViewFinal'), note: $('previewNote'),
    head: $('tableHead'), body: $('tableBody'), colStats: $('dcColStats'),
    export: $('exportBtn'), outName: $('dcOutName'), outSize: $('dcOutSize'), exportNote: $('exportNote'),
    python: $('dcPython')
  };

  const state = {
    file: null,              // { name, text, encoding }
    settings: null,          // { delimiter, decimal, header }
    base: null,              // the table as read
    notes: null,
    steps: [],
    history: [[]],
    at: 0,
    run: null,               // { table, results }
    view: null,              // id of the step whose result the table shows
    editing: null,           // id of the step in the form
    action: 'dropMissing',
    form: null,
    nextId: 1,
    fresh: null,             // id of the step just added, to flash it
    pendingRecipe: null,
    py: { source: 'file', form: 'script' }
  };

  /* ---------------- messages ---------------- */

  function toast(message, kind = '', action = null) {
    const t = document.createElement('div');
    t.className = 'stk-toast' + (kind ? ` stk-toast-${kind}` : '');
    t.setAttribute('role', 'status');
    const icon = kind === 'danger' ? 'fa-circle-exclamation' : kind === 'ok' ? 'fa-circle-check' : kind === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info';
    t.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span></span>`;
    t.querySelector('span').textContent = message;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'stk-btn stk-btn-sm';
      b.textContent = action.label;
      b.addEventListener('click', () => { action.run(); t.remove(); });
      t.appendChild(b);
    }
    ui.toasts.appendChild(t);
    setTimeout(() => t.remove(), action ? 8000 : 3600);
  }

  let announceTimer = null;
  function announce(text) {
    clearTimeout(announceTimer);
    ui.live.textContent = '';
    announceTimer = setTimeout(() => { ui.live.textContent = text; }, 120);
  }

  function download(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Tables are never changed in place, so a table's profile can be kept.
  const profiles = new WeakMap();
  function profileOf(table) {
    let p = profiles.get(table);
    if (!p) { p = profileTable(table); profiles.set(table, p); }
    return p;
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ---------------- the Python panel ---------------- */

  const panel = createPythonPanel(ui.python, {
    title: 'Python script',
    filename: 'clean_data.py',
    sources: [{ id: 'file', label: 'Read the file' }, { id: 'embed', label: 'Data in the script' }],
    variants: [{ id: 'script', label: 'Script' }, { id: 'function', label: 'clean(df) function' }],
    empty: '# The script appears here once a file is loaded.',
    onSourceChange: (id) => {
      if (id === 'embed' && state.file && state.file.text.length > EMBED_LIMIT) {
        panel.setSource('file');
        toast(`The file is too large to put in the script (${Math.round(state.file.text.length / 1000)} kB); the script reads it instead.`, 'warn');
        return;
      }
      state.py.source = id;
      renderPython();
    },
    onVariantChange: (id) => { state.py.form = id; renderPython(); },
    onCopy: () => toast('Copied the Python script.', 'ok'),
    onDownload: (code, name) => toast(`Saved ${name}. Keep it in the folder with your data.`, 'ok')
  });

  /* ---------------- reading the file ---------------- */

  function decode(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
    } catch (e) {
      // Not UTF-8: most likely a spreadsheet's export in the Windows code page.
      return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
    }
  }

  function handleFile(file) {
    if (!file) return;
    const name = file.name || 'data.csv';
    if (/\.json$/i.test(name) || file.type === 'application/json') {
      file.text().then(openRecipeText).catch(() => toast('Could not read that file.', 'danger'));
      return;
    }
    if (!/\.(csv|tsv|txt|dat|tab)$/i.test(name) && !/^text\//.test(file.type || '')) {
      toast('Choose a .csv, .tsv, .txt or .dat file (or a saved recipe, .json).', 'danger');
      return;
    }
    file.arrayBuffer()
      .then(buffer => { const d = decode(buffer); loadText(d.text, name, d.encoding); })
      .catch(() => toast('Could not read that file.', 'danger'));
  }

  function loadText(text, name, encoding) {
    const clean = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const read = readTable(clean);
    if (!read.columns.length || !read.rows.length) {
      toast('No rows could be read from that file.', 'danger');
      return;
    }
    const hadData = !!state.base;
    state.file = { name, text: clean, encoding };
    setBase(read);
    state.view = null;
    ui.exportNote.textContent = '';
    if (state.pendingRecipe) {
      commit(stampIds(state.pendingRecipe), { quiet: true });
      toast(`Applied the recipe you opened (${plural(state.steps.length, 'step')}).`, 'ok');
      state.pendingRecipe = null;
      ui.pending.hidden = true;
    } else {
      recompute();
      if (hadData && state.steps.length) {
        const broken = state.run.results.filter(r => r.status === 'error').length;
        toast(`Applied your ${plural(state.steps.length, 'step')} to ${name}${broken ? `; ${plural(broken, 'step')} could not run and ${broken === 1 ? 'is' : 'are'} marked` : ''}.`, broken ? 'warn' : 'ok');
      }
    }
    resetForm();
    ui.drop.hidden = true;
    ui.workspace.hidden = false;
    renderAll();
  }

  function setBase(read) {
    state.settings = read.settings;
    state.base = { columns: read.columns, rows: read.rows };
    state.notes = read.notes;
    state.run = null;
  }

  function reread() {
    if (!state.file) return;
    const settings = { delimiter: ui.delimiter.value, decimal: ui.decimal.value, header: ui.header.checked };
    const read = readTable(state.file.text, settings);
    if (!read.columns.length) {
      toast('Nothing could be read with those settings.', 'danger');
      return;
    }
    setBase(read);
    recompute();
    resetForm(true);
    renderAll();
    announce(`Read again: ${plural(read.rows.length, 'row')}, ${plural(read.columns.length, 'column')}.`);
  }

  /* ---------------- the recipe ---------------- */

  function stampIds(steps) {
    return steps.map(s => ({ ...normaliseStep(s), id: state.nextId++ }));
  }

  function recompute() {
    if (!state.base) return;
    const previous = state.run && state.run.steps ? { steps: state.run.steps, results: state.run.results } : null;
    const run = runRecipe(state.base, state.steps, previous ? { reuse: previous } : {});
    state.run = { ...run, steps: state.steps };
    if (state.view !== null && !state.steps.some(s => s.id === state.view)) state.view = null;
  }

  // Replace the recipe with `steps`, keeping the old one for undo.
  function commit(steps, options = {}) {
    state.history = state.history.slice(0, state.at + 1);
    state.history.push(clone(steps));
    if (state.history.length > 200) state.history.shift();
    state.at = state.history.length - 1;
    state.steps = steps;
    if (state.editing !== null && !steps.some(s => s.id === state.editing)) stopEditing();
    recompute();
    state.fresh = options.fresh ?? null;
    renderAll({ focusStep: options.focus ?? options.fresh ?? null });
  }

  function travel(to) {
    if (to < 0 || to >= state.history.length || to === state.at) return;
    state.at = to;
    state.steps = clone(state.history[to]);
    // The step in the form may have changed under it: leave editing.
    if (state.editing !== null) { stopEditing(true); state.form = FIELD_DEFAULTS(); }
    recompute();
    state.fresh = null;
    renderAll();
  }
  const undo = () => { if (state.at > 0) { travel(state.at - 1); announce(`Undone. The recipe has ${plural(state.steps.length, 'step')}.`); } };
  const redo = () => { if (state.at < state.history.length - 1) { travel(state.at + 1); announce(`Redone. The recipe has ${plural(state.steps.length, 'step')}.`); } };

  function addStep(step) {
    const s = { ...normaliseStep(step), id: state.nextId++ };
    commit([...state.steps, s], { fresh: s.id });
    const r = state.run.results[state.steps.length - 1];
    announce(`Step ${state.steps.length} added: ${describeStep(s)}. ${r ? plural(r.rowsAfter, 'row') : ''} left.`);
    return s;
  }

  function removeStep(id) {
    const i = state.steps.findIndex(s => s.id === id);
    if (i < 0) return;
    const gone = state.steps[i];
    commit(state.steps.filter(s => s.id !== id));
    toast(`Removed step ${i + 1}: ${describeStep(gone)}.`, '', { label: 'Undo', run: undo });
  }

  function toggleStep(id) {
    commit(state.steps.map(s => {
      if (s.id !== id) return s;
      const next = { ...s };
      if (s.enabled === false) delete next.enabled; else next.enabled = false;
      return next;
    }), { focus: id });
  }

  // A move is safe when no step that could run before it fails after it.
  function moveProblem(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= state.steps.length) return 'end';
    const moved = [...state.steps];
    [moved[i], moved[j]] = [moved[j], moved[i]];
    const before = checkRecipe(state.base.columns, state.steps);
    const after = checkRecipe(state.base.columns, moved);
    for (let k = 0; k < moved.length; k++) {
      const was = before[state.steps.indexOf(moved[k])];
      if (!was && after[k]) return `Moving it would stop step ${k + 1} from running: ${after[k]}`;
    }
    return null;
  }

  function moveStep(id, dir) {
    const i = state.steps.findIndex(s => s.id === id);
    if (i < 0 || moveProblem(i, dir)) return;
    const moved = [...state.steps];
    [moved[i], moved[i + dir]] = [moved[i + dir], moved[i]];
    commit(moved, { focus: id });
    announce(`Moved to step ${i + dir + 1}.`);
    requestAnimationFrame(() => {
      const b = ui.steps.querySelector(`[data-id="${id}"] [data-act="${dir < 0 ? 'up' : 'down'}"]`);
      if (b && !b.disabled) b.focus();
      else { const t = ui.steps.querySelector(`[data-id="${id}"] .dc-step-text`); if (t) t.focus(); }
    });
  }

  /* ---------------- the form ---------------- */

  const FIELD_DEFAULTS = () => ({
    columns: [], column: (tableAtForm().columns[0]) || '', op: 'eq', value: '', descending: false, method: 'value',
    whole: true, find: '', with: '', collapse: false, mode: 'upper', decimal: state.settings ? state.settings.decimal : '.',
    invalid: 'missing', digits: '2', significant: false, ties: 'up', operation: 'log10', to: ''
  });

  // The table a step in the form would meet: the result, or for an edited
  // step the table just before it.
  function tableAtForm() {
    if (!state.run) return { columns: [], rows: [] };
    if (state.editing !== null) {
      const i = state.steps.findIndex(s => s.id === state.editing);
      if (i > 0) return state.run.results[i - 1].table;
      if (i === 0) return state.base;
    }
    return state.run.table;
  }

  function resetForm(keepAction) {
    const keep = state.form;
    state.form = FIELD_DEFAULTS();
    if (keepAction && keep) {
      const cols = new Set(tableAtForm().columns);
      state.form.columns = keep.columns.filter(c => cols.has(c));
    }
    if (!keepAction) state.action = ui.action.value || 'dropMissing';
  }

  function userNumber(text) {
    const t = String(text ?? '').trim();
    if (!t) return undefined;
    const v = readCell(t, '.');
    if (typeof v === 'number') return v;
    const w = readCell(t, ',');
    return typeof w === 'number' ? w : undefined;
  }

  function userValue(text) {
    const t = String(text ?? '').trim();
    if (!t) return undefined;
    const n = userNumber(t);
    return n !== undefined ? n : t;
  }

  function stepFromForm() {
    const f = state.form;
    const type = state.action;
    const columns = [...f.columns];
    switch (type) {
      case 'dropMissing':
      case 'dedupe':
      case 'dropColumns':
        return { type, columns };
      case 'filter': {
        const step = { type, column: f.column, op: f.op };
        if (['gt', 'gte', 'lt', 'lte'].includes(f.op)) step.value = userNumber(f.value);
        else if (f.op === 'contains' || f.op === 'notContains') step.value = String(f.value).trim() || undefined;
        else if (f.op === 'eq' || f.op === 'ne') step.value = userValue(f.value);
        return step;
      }
      case 'sort':
        return { type, column: f.column, descending: !!f.descending };
      case 'fill':
        return { type, columns, method: f.method, ...(f.method === 'value' ? { value: userValue(f.value) } : {}) };
      case 'replace':
        return f.whole
          ? { type, columns, whole: true, find: userValue(f.find), with: String(f.with).trim() === '' ? null : userValue(f.with) }
          : { type, columns, whole: false, find: f.find === '' ? undefined : f.find, with: f.with };
      case 'trim':
        return { type, columns, collapse: !!f.collapse };
      case 'case':
        return { type, columns, mode: f.mode };
      case 'toNumber':
        return { type, columns, decimal: f.decimal, invalid: f.invalid };
      case 'round':
        return { type, columns, digits: /^\s*-?\d+\s*$/.test(f.digits) ? Number(f.digits) : NaN, significant: !!f.significant, ties: f.ties };
      case 'transform':
        return { type, columns, operation: f.operation, ...(f.operation === 'multiply' || f.operation === 'add' ? { value: userNumber(f.value) } : {}) };
      case 'rename':
        return { type, column: f.column, to: f.to };
      default:
        return { type };
    }
  }

  function formFromStep(step) {
    const f = FIELD_DEFAULTS();
    const text = v => (v === null || v === undefined ? '' : String(v));
    Object.assign(f, {
      columns: step.columns ? [...step.columns] : [],
      column: step.column ?? f.column,
      op: step.op ?? f.op,
      value: text(step.value),
      descending: !!step.descending,
      method: step.method ?? f.method,
      whole: step.whole !== false,
      find: text(step.find),
      with: text(step.with),
      collapse: !!step.collapse,
      mode: step.mode ?? f.mode,
      decimal: step.decimal ?? f.decimal,
      invalid: step.invalid ?? f.invalid,
      digits: step.digits !== undefined ? String(step.digits) : f.digits,
      significant: !!step.significant,
      ties: step.ties ?? f.ties,
      operation: step.operation ?? f.operation,
      to: step.to ?? ''
    });
    return f;
  }

  const OPS = [['eq', 'is'], ['ne', 'is not'], ['gt', 'is more than'], ['gte', 'is at least'], ['lt', 'is less than'],
    ['lte', 'is at most'], ['contains', 'contains'], ['notContains', 'does not contain'], ['missing', 'is missing'], ['present', 'is not missing']];

  let fieldSeq = 0;
  const fid = () => `dcf${++fieldSeq}`;

  function selectField(key, label, options, value) {
    const id = fid();
    return `<div class="stk-field"><label for="${id}">${label}</label><select id="${id}" class="stk-select" data-key="${key}">${
      options.map(([v, l]) => `<option value="${escapeHtml(String(v))}"${String(v) === String(value) ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')
    }</select></div>`;
  }

  function textField(key, label, value, extra = {}) {
    const id = fid();
    const hint = extra.hint ? `<p class="stk-hint" id="${id}-h">${extra.hint}</p>` : '';
    return `<div class="stk-field"><label for="${id}">${label}</label><input id="${id}" class="stk-input${extra.mono ? ' stk-mono' : ''}" data-key="${key}" type="text" value="${escapeHtml(value)}" autocomplete="off" spellcheck="false"${extra.placeholder ? ` placeholder="${escapeHtml(extra.placeholder)}"` : ''}${extra.inputmode ? ` inputmode="${extra.inputmode}"` : ''}${hint ? ` aria-describedby="${id}-h"` : ''}>${hint}</div>`;
  }

  function segField(key, label, options, value) {
    const id = fid();
    return `<div class="stk-field"><span class="stk-label-sm" id="${id}">${label}</span><div class="stk-seg stk-seg-fill" role="group" aria-labelledby="${id}">${
      options.map(([v, l]) => `<button type="button" data-key="${key}" data-value="${escapeHtml(String(v))}" aria-pressed="${String(v) === String(value)}" class="${String(v) === String(value) ? 'is-active' : ''}">${escapeHtml(l)}</button>`).join('')
    }</div></div>`;
  }

  function columnField(label, value) {
    const cols = tableAtForm().columns;
    return selectField('column', label, cols.map(c => [c, c]), value);
  }

  function columnsField(label, allLabel) {
    const cols = tableAtForm().columns;
    const picked = new Set(state.form.columns);
    const id = fid();
    const chips = cols.map(c => {
      const on = picked.has(c);
      return `<button type="button" class="dc-col" data-col="${escapeHtml(c)}" aria-pressed="${on}" title="${escapeHtml(c)}">${on ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : ''}<span>${escapeHtml(c)}</span></button>`;
    }).join('');
    const all = allLabel ? `<button type="button" class="dc-col dc-col-all" data-col="" aria-pressed="${picked.size === 0}">${picked.size === 0 ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : ''}<span>${escapeHtml(allLabel)}</span></button>` : '';
    return `<div class="stk-field"><span class="stk-label-sm" id="${id}">${label}</span><div class="dc-cols stk-scroll" role="group" aria-labelledby="${id}">${all}${chips}</div></div>`;
  }

  function renderFields() {
    const f = state.form;
    const a = state.action;
    let html = '';
    switch (a) {
      case 'dropMissing':
        html = columnsField('Look for missing values in', 'Any column');
        break;
      case 'dedupe':
        html = columnsField('A row repeats an earlier one when these match', 'Every column');
        break;
      case 'filter':
        html = `<div class="dc-row">${columnField('Column', f.column)}${selectField('op', 'Test', OPS, f.op)}</div>`;
        if (f.op !== 'missing' && f.op !== 'present') {
          const numeric = ['gt', 'gte', 'lt', 'lte'].includes(f.op);
          html += textField('value', numeric ? 'Number' : 'Value', f.value, {
            mono: true,
            inputmode: numeric ? 'decimal' : undefined,
            hint: numeric ? 'Only numbers pass this test; text and missing values are dropped.'
              : (f.op === 'eq' || f.op === 'ne') ? 'A number matches numbers; anything else matches text exactly, case included.' : 'Case is ignored.'
          });
        }
        break;
      case 'sort':
        html = columnField('Sort by', f.column) + segField('descending', 'Order', [[false, 'Ascending'], [true, 'Descending']], f.descending);
        break;
      case 'fill':
        html = columnsField('Columns', 'Every column') +
          selectField('method', 'Fill with', [['value', 'A value'], ['mean', 'The column mean'], ['median', 'The column median'], ['previous', 'The value above']], f.method);
        if (f.method === 'value') html += textField('value', 'Value', f.value, { mono: true, hint: 'A number, or text.' });
        break;
      case 'replace':
        html = columnsField('Columns', 'Every column') +
          segField('whole', 'Match', [[true, 'Whole cells'], [false, 'Text inside cells']], f.whole) +
          `<div class="dc-row">${textField('find', 'Find', f.find, { mono: true })}${textField('with', 'Replace with', f.with, { mono: true, placeholder: f.whole ? 'empty: missing' : 'empty: remove it' })}</div>`;
        break;
      case 'trim':
        html = columnsField('Columns', 'Every column') +
          `<label class="stk-check"><input type="checkbox" data-key="collapse"${f.collapse ? ' checked' : ''}> Also shrink runs of spaces inside to one</label>`;
        break;
      case 'case':
        html = columnsField('Columns', 'Every column') + segField('mode', 'Change to', [['upper', 'UPPER'], ['lower', 'lower'], ['title', 'Title']], f.mode);
        break;
      case 'toNumber':
        html = columnsField('Columns', 'Every column') +
          segField('decimal', 'Decimal separator', [['.', 'Point, 1.5'], [',', 'Comma, 1,5']], f.decimal) +
          segField('invalid', 'Text that is not a number', [['missing', 'Becomes missing'], ['keep', 'Stays as it is']], f.invalid);
        break;
      case 'round':
        html = columnsField('Columns', 'Every column') +
          `<div class="dc-row">${textField('digits', 'Digits', f.digits, { mono: true, inputmode: 'numeric' })}${selectField('significant', 'Counting', [[false, 'Decimal places'], [true, 'Significant figures']], f.significant)}</div>` +
          selectField('ties', 'Halfway values, such as 2.5', [['up', 'Away from zero (2.5 to 3)'], ['even', 'To the even digit (2.5 to 2)']], f.ties);
        break;
      case 'transform':
        html = columnsField('Columns', 'Every column') + selectField('operation', 'Transformation', [
          ['log10', 'log10(x)'], ['ln', 'ln(x), natural log'], ['abs', 'Absolute value, |x|'], ['minmax', 'Rescale to 0 to 1 (min-max)'],
          ['zscore', 'Z-score, (x - mean) / SD'], ['multiply', 'Multiply by a number'], ['add', 'Add a number']], f.operation);
        if (f.operation === 'multiply' || f.operation === 'add') {
          html += textField('value', f.operation === 'multiply' ? 'Multiply by' : 'Add (a negative number subtracts)', f.value, { mono: true, inputmode: 'decimal' });
        }
        if (f.operation === 'log10' || f.operation === 'ln') html += '<p class="stk-hint">Zero and negative values have no logarithm and become missing.</p>';
        if (f.operation === 'zscore') html += '<p class="stk-hint">Uses the population SD (divide by n), as scikit-learn does.</p>';
        break;
      case 'rename':
        html = `<div class="dc-row">${columnField('Column', f.column)}${textField('to', 'New name', f.to, { mono: true })}</div>`;
        break;
      case 'dropColumns':
        html = columnsField('Columns to remove', null);
        break;
      default:
        break;
    }
    const active = document.activeElement;
    const key = active && ui.fields.contains(active) ? active.getAttribute('data-key') : null;
    ui.fields.innerHTML = html;
    if (key) {
      const again = ui.fields.querySelector(`input[data-key="${key}"], select[data-key="${key}"]`);
      if (again) again.focus();
    }
    renderPicked();
    scheduleEffect();
  }

  // The columns the form uses, marked in the table's header.
  function renderPicked() {
    const f = state.form;
    if (!f) return;
    const single = ['filter', 'sort', 'rename'].includes(state.action);
    const picked = new Set(single ? [f.column] : f.columns);
    for (const th of ui.head.querySelectorAll('th[data-col]')) {
      th.classList.toggle('is-picked', picked.has(th.dataset.col));
    }
    renderColStats(picked.size === 1 ? [...picked][0] : null);
  }

  // Statistics of the one column the form uses, in the table shown.
  function renderColStats(name) {
    const t = state.run ? viewedTable() : null;
    const i = t && name ? t.columns.indexOf(name) : -1;
    if (i < 0) { ui.colStats.hidden = true; return; }
    const values = [];
    let missing = 0;
    let texts = 0;
    for (const row of t.rows) {
      const v = row[i];
      if (v === null || v === undefined) missing++;
      else if (typeof v === 'number') values.push(v);
      else texts++;
    }
    const fmt = x => (Number.isInteger(x) ? x.toLocaleString('en-GB') : String(Number(x.toPrecision(6))));
    const item = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    let html = `<div class="dc-colstats-name"><dt class="sr-only">Column</dt><dd>${escapeHtml(name)}</dd></div>` +
      item('Numbers', values.length.toLocaleString('en-GB')) + item('Missing', missing.toLocaleString('en-GB'));
    if (texts) html += item('Text', texts.toLocaleString('en-GB'));
    if (values.length) {
      let low = values[0];
      let high = values[0];
      for (const v of values) { if (v < low) low = v; if (v > high) high = v; }
      html += item('Mean', fmt(exactMean(values))) + item('Median', fmt(median(values))) +
        item('SD (σ)', fmt(exactPopulationSD(values))) + item('Min', fmt(low)) + item('Max', fmt(high));
    }
    ui.colStats.innerHTML = html;
    ui.colStats.hidden = false;
  }

  ui.fields.addEventListener('input', (e) => {
    const key = e.target.getAttribute('data-key');
    if (!key) return;
    state.form[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (e.target.tagName === 'SELECT') {
      const v = e.target.value;
      if (key === 'significant') state.form.significant = v === 'true';
      if (['op', 'method', 'operation'].includes(key)) { renderFields(); return; }
    }
    scheduleEffect();
  });
  ui.fields.addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') e.target.dispatchEvent(new Event('input', { bubbles: true }));
  });
  ui.fields.addEventListener('click', (e) => {
    const chip = e.target.closest('.dc-col');
    if (chip) {
      const col = chip.dataset.col;
      const f = state.form;
      if (!col) f.columns = [];
      else if (f.columns.includes(col)) f.columns = f.columns.filter(c => c !== col);
      else f.columns = [...f.columns, col];
      renderFields();
      const again = ui.fields.querySelector(`.dc-col[data-col="${CSS.escape(col)}"]`);
      if (again) again.focus();
      return;
    }
    const seg = e.target.closest('button[data-key]');
    if (seg) {
      const key = seg.dataset.key;
      let v = seg.dataset.value;
      if (v === 'true' || v === 'false') v = v === 'true';
      state.form[key] = v;
      renderFields();
      const again = ui.fields.querySelector(`button[data-key="${key}"][data-value="${CSS.escape(seg.dataset.value)}"]`);
      if (again) again.focus();
    }
  });

  ui.action.addEventListener('change', () => {
    state.action = ui.action.value;
    // Columns chosen for one step carry over to the next, except into
    // "Remove columns", where a carried-over choice would be a trap.
    if (state.action === 'dropColumns') state.form.columns = [];
    const cols = tableAtForm().columns;
    if (!cols.includes(state.form.column)) state.form.column = cols[0] || '';
    renderFields();
  });

  // What the step in the form would do, before it is added.
  const scheduleEffect = debounce(renderEffect, 120);
  function renderEffect() {
    if (!state.run) return;
    const step = stepFromForm();
    const table = tableAtForm();
    const problem = checkStep(step, table.columns);
    // A field still to fill in is a hint, not an error.
    const waiting = !!problem && /^(Enter|Choose)/.test(problem);
    ui.effect.classList.toggle('is-error', !!problem && !waiting);
    if (problem) {
      ui.effect.textContent = problem;
      return;
    }
    const r = applyStep(table, normaliseStep(step));
    const before = table.rows.length;
    const after = r.table.rows.length;
    let text;
    if (step.type === 'sort') text = `Puts ${plural(before, 'row')} in order.`;
    else if (step.type === 'rename') text = `Renames ${step.column} to ${stripSpaces(step.to)}.`;
    else if (step.type === 'dropColumns') text = `Leaves ${plural(r.table.columns.length, 'column')} of ${table.columns.length}.`;
    else if (before !== after) text = `Keeps ${plural(after, 'row')} of ${before.toLocaleString('en-GB')}.`;
    else if (['dropMissing', 'dedupe', 'filter'].includes(step.type)) text = `Keeps all ${plural(before, 'row')}.`;
    else text = r.changed ? `Changes ${plural(r.changed, 'cell')}.` : 'Changes nothing in this table.';
    if (r.note) text += ` ${r.note[0].toUpperCase()}${r.note.slice(1)}.`;
    ui.effect.textContent = text;
  }

  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.run) return;
    const step = stepFromForm();
    const problem = checkStep(step, tableAtForm().columns);
    if (problem) {
      ui.effect.textContent = problem;
      ui.effect.classList.add('is-error');
      announce(problem);
      const empty = ui.fields.querySelector('input[type="text"]:not([value]), input[type="text"][value=""]');
      if (/^Enter/.test(problem) && empty) empty.focus();
      return;
    }
    if (state.editing !== null) {
      const id = state.editing;
      const i = state.steps.findIndex(s => s.id === id);
      const next = [...state.steps];
      const old = state.steps[i];
      next[i] = { ...normaliseStep(step), id, ...(old.enabled === false ? { enabled: false } : {}) };
      stopEditing(true);
      commit(next, { focus: id });
      announce(`Step ${i + 1} changed: ${describeStep(next[i])}.`);
      return;
    }
    addStep(step);
    for (const k of ['value', 'find', 'with', 'to']) state.form[k] = '';
    renderFields();
  });

  function startEditing(id) {
    const step = state.steps.find(s => s.id === id);
    if (!step) return;
    state.editing = id;
    state.action = step.type;
    ui.action.value = step.type;
    state.form = formFromStep(step);
    ui.form.classList.add('is-editing');
    const i = state.steps.indexOf(step);
    ui.formTitle.textContent = `Edit step ${i + 1}`;
    ui.add.querySelector('span').textContent = 'Save changes';
    ui.add.querySelector('i').className = 'fa-solid fa-check';
    ui.cancel.hidden = false;
    renderFields();
    renderRecipe();
    ui.form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    ui.action.focus({ preventScroll: true });
    panelReveal(i);
  }

  function stopEditing(silent) {
    const id = state.editing;
    state.editing = null;
    ui.form.classList.remove('is-editing');
    ui.formTitle.textContent = 'Add a step';
    ui.add.querySelector('span').textContent = 'Add step';
    ui.add.querySelector('i').className = 'fa-solid fa-plus';
    ui.cancel.hidden = true;
    if (!silent && state.run) {
      state.form = FIELD_DEFAULTS();
      renderFields();
      renderRecipe();
      const b = id !== null && ui.steps.querySelector(`[data-id="${id}"] [data-act="edit"]`);
      if (b) b.focus();
    }
  }
  ui.cancel.addEventListener('click', () => stopEditing());
  ui.form.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.editing !== null) { e.preventDefault(); stopEditing(); } });

  /* ---------------- suggestions ---------------- */

  function suggestions() {
    const t = state.run.table;
    const p = profileOf(t);
    const out = [];
    if (p.duplicateRows) out.push({ label: `Remove ${plural(p.duplicateRows, 'repeated row')}`, step: { type: 'dedupe', columns: [] } });
    const padded = p.columns.filter(c => c.padded > 0);
    if (padded.length) {
      const cells = padded.reduce((a, c) => a + c.padded, 0);
      out.push({ label: `Trim spaces (${plural(cells, 'cell')})`, step: { type: 'trim', columns: padded.length === t.columns.length ? [] : padded.map(c => c.name) } });
    }
    for (const c of p.columns) {
      if (out.length >= 4) break;
      if (c.texts > 0 && c.numbers >= 2 * c.texts) {
        const lost = c.texts - c.numeric;
        out.push({
          label: `Make ${c.name} numbers${lost ? ` (${plural(lost, 'text cell')} ${lost === 1 ? 'becomes' : 'become'} missing)` : ''}`,
          step: { type: 'toNumber', columns: [c.name], decimal: state.settings.decimal, invalid: 'missing' }
        });
      }
    }
    if (out.length < 4 && p.missing) {
      const dropped = t.rows.filter(r => r.some(v => v === null)).length;
      out.push({ label: `Drop ${plural(dropped, 'row')} with missing values`, step: { type: 'dropMissing', columns: [] } });
    }
    return out.slice(0, 4);
  }

  let suggested = [];
  function renderSuggestions() {
    suggested = state.view === null ? suggestions() : [];
    ui.suggest.hidden = !suggested.length;
    ui.suggestList.innerHTML = suggested.map((s, i) =>
      `<button type="button" class="dc-chip" data-i="${i}"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${escapeHtml(s.label)}</button>`).join('');
  }
  ui.suggestList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const s = suggested[+b.dataset.i];
    if (!s) return;
    const step = addStep(s.step);
    toast(`Added step ${state.steps.length}: ${describeStep(step)}.`, 'ok', { label: 'Undo', run: undo });
    const next = ui.suggestList.querySelector('button') || ui.action;
    next.focus();
  });

  /* ---------------- the recipe list ---------------- */

  function stepMeta(r, step) {
    if (r.status === 'off') return { text: 'Switched off: the table skips it.', kind: 'off' };
    if (r.status === 'error') return { text: `Skipped: ${r.error}`, kind: 'error' };
    const parts = [];
    if (r.rowsAfter !== r.rowsBefore) parts.push(`${r.rowsBefore.toLocaleString('en-GB')} → ${plural(r.rowsAfter, 'row')}`);
    else parts.push(plural(r.rowsAfter, 'row'));
    if (r.columnsAfter !== r.columnsBefore) parts.push(`${r.columnsBefore} → ${plural(r.columnsAfter, 'column')}`);
    if (r.changed) parts.push(`${plural(r.changed, 'cell')} changed`);
    else if (!['dropMissing', 'dedupe', 'filter', 'sort', 'rename', 'dropColumns'].includes(step.type)) parts.push('no cells changed');
    if (r.note) parts.push(r.note);
    return { text: parts.join(' · '), kind: r.rowsAfter < r.rowsBefore ? 'cut' : '' };
  }

  function renderRecipe(options = {}) {
    const steps = state.steps;
    const results = state.run ? state.run.results : [];
    ui.count.textContent = steps.length ? String(steps.length) : '';
    ui.empty.hidden = steps.length > 0;
    ui.save.disabled = !steps.length;
    ui.save2.disabled = !steps.length;
    ui.clear.disabled = !steps.length;
    ui.undo.disabled = state.at === 0;
    ui.redo.disabled = state.at >= state.history.length - 1;
    ui.steps.innerHTML = steps.map((s, i) => {
      const r = results[i] || { status: 'ok', rowsBefore: 0, rowsAfter: 0, columnsBefore: 0, columnsAfter: 0, changed: 0 };
      const meta = stepMeta(r, s);
      const n = i + 1;
      const up = i > 0 ? moveProblem(i, -1) : 'end';
      const down = i < steps.length - 1 ? moveProblem(i, 1) : 'end';
      const cls = ['dc-step', s.enabled === false ? 'is-off' : '', r.status === 'error' ? 'is-error' : '',
        state.view === s.id ? 'is-viewing' : '', state.editing === s.id ? 'is-editing' : '', state.fresh === s.id ? 'is-new' : ''].filter(Boolean).join(' ');
      const moveTitle = (p, dir) => (p === 'end' ? '' : p ? ` title="${escapeHtml(p)}"` : ` title="Move step ${n} ${dir}"`);
      return `<li class="${cls}" data-id="${s.id}">
        <span class="dc-step-n" aria-hidden="true">${n}</span>
        <div class="dc-step-main">
          <button type="button" class="dc-step-text" data-act="view" aria-pressed="${state.view === s.id}" aria-label="Step ${n}: ${escapeHtml(describeStep(s))}. Show the table after this step">${escapeHtml(describeStep(s))}</button>
          <p class="dc-step-meta${meta.kind ? ` is-${meta.kind}` : ''}">${escapeHtml(meta.text)}</p>
        </div>
        <div class="dc-step-tools">
          <button type="button" class="stk-switch" role="switch" data-act="toggle" aria-checked="${s.enabled !== false}" aria-label="Step ${n} on" title="${s.enabled === false ? 'Switch on' : 'Switch off'}"></button>
          <button type="button" class="stk-btn stk-btn-sm stk-btn-icon stk-btn-ghost" data-act="edit" aria-label="Edit step ${n}" title="Edit"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
          <button type="button" class="stk-btn stk-btn-sm stk-btn-icon stk-btn-ghost" data-act="up" aria-label="Move step ${n} up"${moveTitle(up, 'up')}${up ? ' disabled' : ''}><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button>
          <button type="button" class="stk-btn stk-btn-sm stk-btn-icon stk-btn-ghost" data-act="down" aria-label="Move step ${n} down"${moveTitle(down, 'down')}${down ? ' disabled' : ''}><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button>
          <button type="button" class="stk-btn stk-btn-sm stk-btn-icon stk-btn-ghost dc-step-x" data-act="remove" aria-label="Remove step ${n}" title="Remove"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </div>
      </li>`;
    }).join('');
    if (options.focusStep !== undefined && options.focusStep !== null && state.fresh === options.focusStep) {
      const li = ui.steps.querySelector(`[data-id="${options.focusStep}"]`);
      if (li) li.scrollIntoView({ block: 'nearest' });
    }
  }

  ui.steps.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = +b.closest('[data-id]').dataset.id;
    const act = b.dataset.act;
    // The list is redrawn after each action; keep the keyboard where it was.
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const again = ui.steps.querySelector(`[data-id="${id}"] [data-act="${act}"]`);
      if (again && !again.disabled) again.focus();
    });
    switch (act) {
      case 'view':
        state.view = state.view === id ? null : id;
        renderRecipe();
        renderTable();
        renderSuggestions();
        if (state.view !== null) {
          const i = state.steps.findIndex(s => s.id === id);
          panelReveal(i);
          announce(`Showing the table after step ${i + 1}.`);
        } else announce('Showing the result.');
        break;
      case 'toggle': {
        const on = state.steps.find(s => s.id === id).enabled === false;
        toggleStep(id);
        const again = ui.steps.querySelector(`[data-id="${id}"] [data-act="toggle"]`);
        if (again) again.focus();
        announce(`Step ${state.steps.findIndex(s => s.id === id) + 1} switched ${on ? 'on' : 'off'}.`);
        break;
      }
      case 'edit':
        if (state.editing === id) stopEditing(); else startEditing(id);
        break;
      case 'up': moveStep(id, -1); break;
      case 'down': moveStep(id, 1); break;
      case 'remove': {
        const i = state.steps.findIndex(s => s.id === id);
        removeStep(id);
        const next = ui.steps.querySelectorAll('.dc-step-text')[Math.min(i, state.steps.length - 1)];
        (next || ui.action).focus();
        break;
      }
      default: break;
    }
  });

  ui.undo.addEventListener('click', undo);
  ui.redo.addEventListener('click', redo);
  document.addEventListener('keydown', (e) => {
    if (!state.base || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });

  ui.clear.addEventListener('click', () => {
    if (!state.steps.length) return;
    const n = state.steps.length;
    commit([]);
    toast(`Cleared the recipe (${plural(n, 'step')}).`, '', { label: 'Undo', run: undo });
  });

  ui.viewFinal.addEventListener('click', () => {
    state.view = null;
    renderRecipe();
    renderTable();
    renderSuggestions();
    announce('Showing the result.');
  });

  /* ---------------- saving and opening recipes ---------------- */

  function saveRecipe() {
    if (!state.steps.length) return;
    const names = cleaningFileNames(state.file ? state.file.name : 'data.csv');
    const s = state.settings || {};
    const json = recipeToJSON(state.steps, {
      fileName: state.file ? state.file.name : undefined,
      delimiter: s.delimiter, decimal: s.decimal, header: s.header
    });
    const name = `${names.stem}_recipe.json`;
    download(json, name, 'application/json');
    toast(`Saved ${name}. Open it here to apply the same steps to another file.`, 'ok');
  }
  ui.save.addEventListener('click', saveRecipe);
  ui.save2.addEventListener('click', saveRecipe);
  ui.open.addEventListener('click', () => ui.recipeFile.click());
  ui.recipeFile.addEventListener('change', () => {
    const f = ui.recipeFile.files[0];
    ui.recipeFile.value = '';
    if (f) f.text().then(openRecipeText).catch(() => toast('Could not read that file.', 'danger'));
  });

  function openRecipeText(text) {
    let recipe;
    try {
      recipe = parseRecipe(text);
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }
    if (!state.base) {
      state.pendingRecipe = recipe.steps;
      ui.pending.hidden = false;
      ui.pending.textContent = `Recipe ready: ${plural(recipe.steps.length, 'step')}. Load the data to apply it.`;
      toast(`Opened a recipe with ${plural(recipe.steps.length, 'step')}. Now load the data.`, 'ok');
      return;
    }
    const replaced = state.steps.length;
    commit(stampIds(recipe.steps));
    const broken = state.run.results.filter(r => r.status === 'error').length;
    toast(`Opened a recipe with ${plural(recipe.steps.length, 'step')}${replaced ? `, in place of your ${replaced}` : ''}${broken ? `; ${plural(broken, 'step')} cannot run on this file` : ''}.`, broken ? 'warn' : 'ok', { label: 'Undo', run: undo });
  }

  /* ---------------- the table ---------------- */

  function viewIndex() {
    return state.view === null ? -1 : state.steps.findIndex(s => s.id === state.view);
  }

  function viewedTable() {
    const i = viewIndex();
    return i < 0 ? state.run.table : state.run.results[i].table;
  }

  function columnKind(c) {
    const bits = [];
    if (c.numbers && !c.texts) bits.push('numbers');
    else if (c.texts && !c.numbers) bits.push('text');
    else if (c.texts && c.numbers) bits.push(`numbers, ${plural(c.texts, 'text cell')}`);
    else bits.push('empty');
    if (c.missing && (c.numbers || c.texts)) bits.push(`${c.missing.toLocaleString('en-GB')} missing`);
    return bits.join(' · ');
  }

  function renderTable() {
    const t = viewedTable();
    const i = viewIndex();
    const p = profileOf(t);
    const mixed = p.columns.map(c => c.numbers > 0 && c.texts > 0);
    const numeric = p.columns.map(c => c.numbers > 0 && c.texts === 0);
    ui.head.innerHTML = '<tr><th scope="col" class="dc-rn"><span class="sr-only">Row</span>#</th>' + t.columns.map((name, k) => {
      const c = p.columns[k];
      return `<th scope="col" data-col="${escapeHtml(name)}" class="${numeric[k] ? 'is-num' : ''}"><button type="button" class="dc-th" title="Use ${escapeHtml(name)} in the step"><span class="dc-th-name">${escapeHtml(name)}</span><span class="dc-th-kind">${escapeHtml(columnKind(c))}</span></button></th>`;
    }).join('') + '</tr>';
    const limit = Math.min(t.rows.length, PREVIEW_ROWS);
    const rows = [];
    for (let r = 0; r < limit; r++) {
      const row = t.rows[r];
      let cells = `<td class="dc-rn">${r + 1}</td>`;
      for (let k = 0; k < t.columns.length; k++) {
        const v = row[k];
        if (v === null || v === undefined) cells += `<td class="dc-gapcell${numeric[k] ? ' is-num' : ''}"><span class="dc-gap" title="Missing value">–</span></td>`;
        else if (typeof v === 'number') cells += `<td class="${numeric[k] ? 'is-num' : 'dc-numtext'}">${escapeHtml(cellText(v))}</td>`;
        else {
          const cls = [];
          if (stripSpaces(v) !== v) cls.push('dc-pad');
          if (mixed[k]) cls.push('dc-odd');
          const title = cls.includes('dc-pad') ? ' title="Spaces at the ends"' : cls.includes('dc-odd') ? ' title="Text in a column of numbers"' : '';
          cells += `<td${cls.length ? ` class="${cls.join(' ')}"` : ''}${title}>${escapeHtml(v)}</td>`;
        }
      }
      rows.push(`<tr>${cells}</tr>`);
    }
    ui.body.innerHTML = rows.join('') || `<tr><td class="dc-none" colspan="${t.columns.length + 1}">No rows are left at this point.</td></tr>`;
    const size = `${plural(t.rows.length, 'row')} × ${plural(t.columns.length, 'column')}`;
    ui.note.textContent = t.rows.length > limit ? `${size}; the first ${limit} shown, the download has them all` : size;
    ui.viewing.hidden = i < 0;
    if (i >= 0) ui.viewingText.textContent = `After step ${i + 1} of ${state.steps.length}`;
    renderPicked();
  }

  ui.head.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-col]');
    if (!th || !state.form) return;
    const col = th.dataset.col;
    if (!tableAtForm().columns.includes(col)) {
      toast(`${col} is not in the table the step would meet.`, 'warn');
      return;
    }
    const single = ['filter', 'sort', 'rename'].includes(state.action);
    if (single) state.form.column = col;
    else if (state.form.columns.includes(col)) state.form.columns = state.form.columns.filter(c => c !== col);
    else state.form.columns = [...state.form.columns, col];
    renderFields();
    announce(single ? `${col} chosen for the step.` : `${col} ${state.form.columns.includes(col) ? 'added to' : 'taken out of'} the step's columns.`);
  });

  /* ---------------- the file bar and the outputs ---------------- */

  function renderFileBar() {
    const s = state.settings;
    ui.fileName.textContent = state.file.name;
    ui.delimiter.value = s.delimiter;
    ui.decimal.value = s.decimal;
    ui.header.checked = s.header;
    const p = profileOf(state.base);
    const bits = [`${plural(state.base.rows.length, 'row')}`, plural(state.base.columns.length, 'column')];
    if (p.missing) bits.push(`${p.missing.toLocaleString('en-GB')} missing`);
    if (p.duplicateRows) bits.push(plural(p.duplicateRows, 'repeated row'));
    let meta = `As read: ${bits.join(' · ')}.`;
    if (state.notes && state.notes.shortRows) meta += ` ${plural(state.notes.shortRows, 'row')} had fewer values than there are columns; the rest are missing.`;
    if (state.file.encoding !== 'utf-8') meta += ` Read as ${state.file.encoding === 'windows-1252' ? 'Windows-1252' : 'UTF-16'} text.`;
    ui.meta.textContent = meta;
  }

  function renderOutputs() {
    const names = cleaningFileNames(state.file.name);
    const t = state.run.table;
    ui.outName.textContent = names.output;
    ui.outSize.textContent = ` · ${plural(t.rows.length, 'row')}, ${plural(t.columns.length, 'column')}`;
    ui.export.disabled = t.rows.length === 0 && t.columns.length === 0;
  }

  ui.export.addEventListener('click', () => {
    if (!state.run) return;
    const names = cleaningFileNames(state.file.name);
    const t = state.run.table;
    download(writeTable(t), names.output, 'text/csv;charset=utf-8');
    ui.exportNote.textContent = `Saved ${names.output}: ${plural(t.rows.length, 'row')}, ${plural(t.columns.length, 'column')}, after ${plural(state.run.results.filter(r => r.status === 'ok').length, 'step')}.`;
    toast(`Saved ${names.output}.`, 'ok');
  });

  /* ---------------- the script ---------------- */

  let revealNext = null;
  function panelReveal(i) {
    revealNext = i;
    renderPython();
  }

  function renderPython() {
    if (!state.base) return;
    const names = cleaningFileNames(state.file.name);
    const embed = state.py.source === 'embed' && state.file.text.length <= EMBED_LIMIT;
    let result;
    try {
      result = generateCleaningScript({
        steps: state.steps,
        columns: state.base.columns,
        source: { fileName: state.file.name, ...state.settings, encoding: state.file.encoding },
        form: state.py.form,
        data: embed ? 'embed' : 'file',
        text: state.file.text
      });
    } catch (err) {
      panel.setCode(`# The script could not be written: ${err && err.message ? err.message : err}`);
      return;
    }
    const range = revealNext !== null && revealNext >= 0 ? result.steps[revealNext] : null;
    revealNext = null;
    panel.setFilename(names.script);
    panel.setCode(result.code, range ? { reveal: range } : {});
    const esc = escapeHtml;
    const read = embed
      ? 'The data are inside the script'
      : `It reads <code>${esc(state.file.name)}</code> from the folder you run it in`;
    const fn = state.py.form === 'function'
      ? ` Or import it: <code>from ${esc(names.script.replace(/\.py$/, ''))} import read_table, clean</code>.`
      : '';
    panel.setNote(`Runs with Python 3.8 or later and pandas: <code>python ${esc(names.script)}</code>. ${read}, prints the rows after each step and writes <code>${esc(names.output)}</code>, the same file as the download.${fn}`);
  }
  const schedulePython = debounce(renderPython, 60);

  /* ---------------- everything ---------------- */

  function renderAll(options = {}) {
    if (!state.base) return;
    if (!state.form) resetForm();
    renderFileBar();
    renderRecipe(options);
    renderSuggestions();
    renderTable();
    renderOutputs();
    const cols = tableAtForm().columns;
    state.form.columns = state.form.columns.filter(c => cols.includes(c));
    if (!cols.includes(state.form.column)) state.form.column = cols[0] || '';
    renderFields();
    if (options.focusStep !== undefined && options.focusStep !== null) {
      const i = state.steps.findIndex(s => s.id === options.focusStep);
      revealNext = i;
      renderPython();
    } else schedulePython();
  }

  /* ---------------- loading ---------------- */

  ['dragenter', 'dragover'].forEach(evt => ui.drop.addEventListener(evt, (e) => {
    e.preventDefault();
    ui.drop.classList.add('is-over');
  }));
  ui.drop.addEventListener('dragleave', (e) => {
    if (!ui.drop.contains(e.relatedTarget)) ui.drop.classList.remove('is-over');
  });
  ui.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    ui.drop.classList.remove('is-over');
    for (const f of e.dataTransfer.files) handleFile(f);
  });
  ui.drop.addEventListener('click', (e) => {
    if (!e.target.closest('button')) ui.fileInput.click();
  });
  // A file dropped on the workspace loads too, keeping the recipe.
  ui.workspace.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  ui.workspace.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    handleFile(e.dataTransfer.files[0]);
  });
  ui.choose.addEventListener('click', () => ui.fileInput.click());
  ui.sample.addEventListener('click', () => loadText(SAMPLE_CSV, SAMPLE_NAME, 'utf-8'));
  ui.change.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', () => {
    const f = ui.fileInput.files[0];
    ui.fileInput.value = '';
    handleFile(f);
  });
  [ui.delimiter, ui.decimal, ui.header].forEach(el => el.addEventListener('change', reread));

  state.action = ui.action.value || 'dropMissing';
  panel.setNote('Runs with Python 3.8 or later and pandas.');
}
