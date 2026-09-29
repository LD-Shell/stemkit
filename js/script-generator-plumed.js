/*
 * STEMKit, MD Workflow Generator: the PLUMED tab.
 * Author: Olanrewaju M. Daramola
 *
 * DOM wiring only. What the file says, which components a variable has and
 * what is wrong with an input all come from src/core/plumed.js, the module
 * the tests and the parser check exercise, so the page cannot write something
 * the package would not. The keyword table for the target release is loaded
 * on entering the tab; until it arrives the file is built without it.
 */

import {
  CV_DEFS, CV_EXAMPLES, BIAS_DEFS, FUNCTION_DEFS, FUNCTION_EXAMPLES, KEY_HELP, PREREQS,
  PLUMED_VERSIONS, DEFAULT_PLUMED_VERSION,
  cvAvailable, fieldsFor, reductionFieldsFor, componentsForCV, hiddenFieldsForBias,
  actionNameFor, availableArguments, createCV, createFunction, defaultBiasValues,
  generatePlumedInput, messageToHtml
} from '../src/core/plumed.js';
import { loadSyntax, plumedDocUrl } from '../src/core/plumed-syntax.js';
import { createPlumedCheck } from './script-generator-plumed-check.js';
import { createPlumedAtoms } from './script-generator-plumed-atoms.js';

const BIAS_GROUPS = {
  none: 'None',
  metad: 'Free energy (metadynamics)',
  restraint: 'Restraints & walls'
};

/* Fields whose value changes which components a CV has, or its label, so the
   card is drawn again when one changes. */
const REDRAW_FIELDS = new Set([
  '__label', '__variant', '__components', 'COMPONENTS', 'VMEAN', 'VSUM', 'VALUE', 'VALUES',
  'MEAN', 'SUM', 'MIN', 'ALT_MIN', 'MAX', 'HIGHEST', 'LOWEST', 'MORE_THAN', 'LESS_THAN',
  'BETWEEN', 'MOMENTS', 'PROPERTY', 'ATOMS'
]);

/**
 * @param {object} ctx - Helpers shared with the rest of the page: `$`,
 *        `getStr`, `isChecked`, `setWarnings`, `renderOutput`, `escapeHtml`.
 */
export function createPlumedBuilder(ctx) {
  const { $, getStr, isChecked, setWarnings, renderOutput, escapeHtml } = ctx;
  const attr = (s) => escapeHtml(s);

  const newPrint = (file, stride) => ({ file, stride, extra: '', all: true, args: [] });

  const state = {
    cvs: [],
    seq: 0,
    functions: [],
    fnSeq: 0,
    restraints: [],
    restraintSeq: 0,
    prints: [newPrint('COLVAR', '')],
    // Files an INCLUDE line reads, written by the per-molecule tools.
    files: {},
    biasVals: {},
    open: new Set(),
    view: 'input',
    syntax: null,
    lastResult: null
  };

  /* ---------------------------------------------------------------- *
   * Target release and its keyword table
   * ---------------------------------------------------------------- */

  function version() {
    const v = $('plumedVersion') && $('plumedVersion').value;
    return PLUMED_VERSIONS.includes(v) ? v : DEFAULT_PLUMED_VERSION;
  }

  function syntax() {
    return state.syntax && state.syntax.version === version() ? state.syntax : null;
  }

  function ensureSyntax() {
    const v = version();
    if (state.syntax && state.syntax.version === v) return;
    loadSyntax(v).then((s) => {
      if (version() !== s.version) return;
      state.syntax = s;
      populateCVSelect();
      renderBiasParams();
      renderAll();
      generate();
      check.run();
    }).catch(() => { /* the file is still built, without the table's checks */ });
  }

  const options = () => ({ version: version(), syntax: syntax() });

  function docUrl(def, inst) {
    if (!def || def.isCustom) return '';
    const action = inst ? actionNameFor(inst, def) : (def.act || def.__key);
    const s = syntax();
    if (s && s.has(action)) return s.docUrl(action);
    // An action newer than the target has no page in the target's manual.
    const v = def.minVersion && !cvAvailable(def, version()) ? def.minVersion : version();
    return plumedDocUrl(action, v);
  }

  function moduleNote(action) {
    const s = syntax();
    if (!s || !action || !s.has(action)) return '';
    const m = s.moduleOf(action);
    if (!m || m.defaultOn) return '';
    const tip = `A default PLUMED ${version()} build leaves this module out. Check with ` +
      `"plumed config has module ${m.name}"; rebuild with ./configure --enable-modules=${m.name} ` +
      '(or all) if it is missing.';
    return `<p class="sg-cv-note sg-cv-note-warn"><i class="fa-solid fa-cube" aria-hidden="true"></i>` +
      `<span>Needs the <strong>${attr(m.name)}</strong> module, which a default build leaves out.</span>` +
      `<span class="plumed-help" tabindex="0" data-tip="${attr(tip)}">?</span></p>`;
  }

  /* ---------------------------------------------------------------- *
   * The file
   * ---------------------------------------------------------------- */

  function biasParams(method) {
    const out = {};
    const def = BIAS_DEFS[method];
    const own = state.biasVals[method] || {};
    for (const p of (def && def.params) || []) {
      out[p.k] = own[p.k] !== undefined ? own[p.k] : p.def;
    }
    return out;
  }

  function readConfig() {
    const method = getStr('plumedBias', 'none');
    const stride = getStr('plumedStride', '500');
    // The select replaced a checkbox; settings saved before then still load.
    const mode = getStr('plumedWalkersMode', '') || (isChecked('plumedWalkers') ? 'mpi' : 'none');
    return {
      ...options(),
      units: {
        length: getStr('plumedUnitLength', 'nm'),
        energy: getStr('plumedUnitEnergy', 'kj/mol'),
        time: getStr('plumedUnitTime', 'ps')
      },
      molinfo: { structure: getStr('plumedMolinfo', '') },
      whole: {
        enabled: isChecked('plumedWhole'),
        residues: isChecked('plumedWholeResidues'),
        entities: getStr('plumedWholeEntities', '')
      },
      natoms: parseInt(getStr('plumedNatoms', ''), 10) || undefined,
      preamble: {
        restart: isChecked('plumedRestart'),
        load: getStr('plumedLoad', ''),
        include: getStr('plumedInclude', ''),
        definedLabels: Object.values(state.files).flatMap(f => f.labels || []),
        trusted: Object.keys(state.files),
        flush: getStr('plumedFlush', '')
      },
      cvs: state.cvs,
      functions: state.functions,
      restraints: state.restraints,
      bias: {
        method,
        params: biasParams(method),
        temp: getStr('plumedTemp', ''),
        stride,
        grid: isChecked('plumedGrid'),
        rct: isChecked('plumedRct'),
        walkers: {
          mode,
          n: getStr('plumedWalkersN', '4'),
          id: getStr('plumedWalkersId', '0'),
          dir: getStr('plumedWalkersDir', '../hills'),
          rstride: getStr('plumedWalkersRstride', '100')
        }
      },
      prints: state.prints.map(p => ({
        file: p.file,
        stride: String(p.stride || '').trim() || stride,
        extra: p.extra,
        args: p.all ? [] : p.args,
        only: !p.all
      }))
    };
  }

  /** The values a function, a wall or an output can refer to. */
  function argumentList(upTo) {
    const config = readConfig();
    if (upTo) {
      const i = state.functions.findIndex(f => f.id === upTo);
      config.functions = i < 0 ? [] : state.functions.slice(0, i);
    }
    return availableArguments(config).map(a => a.arg);
  }

  function renderAll() {
    renderCVList();
    renderFnList();
    renderRestraintList();
    renderPrintList();
    renderVersionNote();
  }

  function renderVersionNote() {
    const host = $('plumedVersionNote');
    if (!host) return;
    const s = syntax();
    host.innerHTML = s
      ? `Keywords, defaults and modules are checked against PLUMED <strong>${escapeHtml(s.release)}</strong>, ` +
        `${s.actionNames().length} actions. Match it to <code>plumed info --version</code> on the machine that runs the job.`
      : 'Set the version to match <code>plumed info --version</code> on the machine that runs the job.';
  }

  function generate() {
    const out = $('slurmOutput');
    if (!out) return;
    const result = generatePlumedInput(readConfig());
    state.lastResult = result;
    renderOutput(out, result.input.replace(/\n$/, ''));
    setWarnings($('plumedWarnings'), result.warnings.map(messageToHtml));
  }

  /* ---------------------------------------------------------------- *
   * Choosing a collective variable
   * ---------------------------------------------------------------- */

  function unavailableNote(def) {
    if (def.minVersion && !cvAvailable({ minVersion: def.minVersion }, version())) {
      return `needs PLUMED ≥ ${def.minVersion}`;
    }
    return `not in PLUMED ${version()}`;
  }

  function populateCVSelect() {
    const catSel = $('plumedCategory');
    const cvSel = $('plumedCVSelect');
    if (!catSel || !cvSel) return;
    const keep = cvSel.value;
    cvSel.innerHTML = '';
    for (const name of Object.keys(CV_DEFS)) {
      const def = CV_DEFS[name];
      if (def.cat !== catSel.value) continue;
      const opt = document.createElement('option');
      opt.value = name;
      // An entry the target cannot use stays in the list, so it can be found.
      if (cvAvailable(def, version())) {
        opt.textContent = name;
      } else {
        opt.textContent = `${name}  (${unavailableNote(def)})`;
        opt.disabled = true;
      }
      cvSel.appendChild(opt);
    }
    const kept = Array.from(cvSel.options).find(o => o.value === keep && !o.disabled);
    const first = Array.from(cvSel.options).find(o => !o.disabled);
    if (kept) cvSel.value = keep;
    else if (first) cvSel.value = first.value;
    updateCVDesc();
  }

  function updateCVDesc() {
    const cvSel = $('plumedCVSelect');
    const host = $('plumedCVDesc');
    if (!cvSel || !host) return;
    const def = CV_DEFS[cvSel.value];
    if (!def) { host.textContent = ''; return; }
    let html = escapeHtml(def.desc || '');
    const example = def.example || CV_EXAMPLES[cvSel.value];
    if (example) {
      html += ` <span class="plumed-cv-example"><strong>Example use-case:</strong> ${escapeHtml(example)}</span>`;
    }
    if (!cvAvailable(def, version())) {
      html += ` <span class="plumed-cv-gate"><strong>${escapeHtml(unavailableNote(def))}</strong>` +
        ` (your target is ${escapeHtml(version())}).` +
        (def.fallback ? ` On ${escapeHtml(version())} use <code>${escapeHtml(def.fallback)}</code> instead.` : '') +
        '</span>';
    }
    const url = docUrl(def);
    if (url) html += ` <a class="plumed-doclink" href="${attr(url)}" target="_blank" rel="noopener">Documentation <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>`;
    host.innerHTML = html;
  }

  function addCV() {
    const cvSel = $('plumedCVSelect');
    if (!cvSel || !cvSel.value) return;
    const def = CV_DEFS[cvSel.value];
    if (!def || !cvAvailable(def, version())) return;
    const inst = createCV(cvSel.value, ++state.seq, options());
    if (!inst) return;
    state.cvs.push(inst);
    renderAll();
    generate();
  }

  function removeCV(id) {
    state.cvs = state.cvs.filter(c => c.id !== id);
    renderAll();
    generate();
  }

  /* ---------------------------------------------------------------- *
   * Bias method
   * ---------------------------------------------------------------- */

  function populateBiasSelect() {
    const sel = $('plumedBias');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '';
    for (const cat of Object.keys(BIAS_GROUPS)) {
      const og = document.createElement('optgroup');
      og.label = BIAS_GROUPS[cat];
      for (const k of Object.keys(BIAS_DEFS)) {
        if (BIAS_DEFS[k].cat !== cat) continue;
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = BIAS_DEFS[k].label;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
    sel.value = current && BIAS_DEFS[current] ? current : 'wt_metad';
  }

  function renderBiasParams() {
    const host = $('plumedBiasParams');
    const sel = $('plumedBias');
    if (!host || !sel) return;
    const method = sel.value;
    const def = BIAS_DEFS[method];
    let html = def ? moduleNote(def.action) : '';
    const params = (def && def.params) || [];
    if (params.length) {
      if (!state.biasVals[method]) state.biasVals[method] = {};
      html += '<div class="sg-cv-grid">';
      for (const p of params) {
        const own = state.biasVals[method][p.k];
        const cur = own !== undefined ? own : p.def;
        const placeholder = p.fallback
          ? `global: ${getStr(p.fallback, 'unset')}`
          : (p.def === '' ? '(optional)' : '');
        html += `<div class="sg-cv-field">
          <label>${escapeHtml(p.label)}${p.perCV ? '<span class="sg-cv-per">/CV</span>' : ''}${helpBadge(p.help)}</label>
          <input type="text" class="stk-input stk-input-sm stk-mono" data-bias-key="${attr(p.k)}"
                 value="${attr(cur)}" placeholder="${attr(placeholder)}" autocomplete="off" spellcheck="false">
        </div>`;
      }
      html += '</div>';
      if (params.some(p => p.perCV)) {
        html += '<p class="stk-hint"><span class="sg-cv-per">/CV</span> fields apply one value to every biased ' +
          'CV. To set them one by one, type a comma-separated list, one value per biased CV.</p>';
      }
    } else if (method === 'none') {
      html += '<p class="stk-hint">No bias is applied: the variables are computed and printed, which is how a ' +
        'trial run is set up before choosing hill widths and grid bounds.</p>';
    }
    host.innerHTML = html;
    host.querySelectorAll('[data-bias-key]').forEach((el) => {
      el.addEventListener('input', () => {
        state.biasVals[method][el.getAttribute('data-bias-key')] = el.value;
        generate();
      });
    });
  }

  /* ---------------------------------------------------------------- *
   * Collective-variable cards
   * ---------------------------------------------------------------- */

  function helpBadge(text) {
    return text ? `<span class="plumed-help" tabindex="0" data-tip="${attr(text)}">?</span>` : '';
  }

  function fieldHtml(inst, f, off, offTip) {
    const value = inst.values[f.k];
    const help = off ? helpBadge(offTip) : helpBadge(f.help || KEY_HELP[f.k] || '');
    const dis = off ? ' disabled' : '';
    const cls = `sg-cv-field${off ? ' plumed-field-off' : ''}`;
    const id = `${inst.id}-${f.k}`;
    if (f.type === 'flag') {
      return `<div class="sg-cv-flag${off ? ' plumed-field-off' : ''}">
        <input type="checkbox" id="${attr(id)}" data-cv="${attr(inst.id)}" data-field="${attr(f.k)}"${value ? ' checked' : ''}${dis}>
        <label for="${attr(id)}">${escapeHtml(f.label || f.k)}</label>${help}
      </div>`;
    }
    if (f.type === 'select') {
      const opts = f.options.map(o =>
        `<option value="${attr(o)}"${o === value ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
      return `<div class="${cls}">
        <label for="${attr(id)}">${escapeHtml(f.label || f.k)}${help}</label>
        <select id="${attr(id)}" class="stk-select stk-select-sm" data-cv="${attr(inst.id)}" data-field="${attr(f.k)}"${dis}>${opts}</select>
      </div>`;
    }
    const wide = f.k === '__raw' || (f.type === 'text' && String(value ?? '').length > 26);
    const input = `<input type="text" id="${attr(id)}" class="stk-input stk-input-sm stk-mono" data-cv="${attr(inst.id)}"
             data-field="${attr(f.k)}" value="${attr(value ?? '')}" autocomplete="off" spellcheck="false"${dis}>`;
    const pick = f.type === 'atoms' && !off && atomsTool && atomsTool.hasStructure()
      ? `<div class="sg-cv-atoms">${input}<button type="button" class="stk-btn stk-btn-sm stk-btn-icon" data-pick="${attr(inst.id)}"
           data-field="${attr(f.k)}" aria-label="Pick ${attr(f.k)} of ${attr(inst.label)} from the structure"
           title="Pick from the structure"><i class="fa-solid fa-crosshairs" aria-hidden="true"></i></button></div>`
      : input;
    return `<div class="${cls}${wide ? ' sg-cv-wide' : ''}">
      <label for="${attr(id)}">${escapeHtml(f.label || f.k)}${help}</label>
      ${pick}
    </div>`;
  }

  function biasBlockHtml(inst, def, kind = 'cv') {
    const comps = kind === 'cv' ? componentsForCV(inst, CV_DEFS, options()) : [];
    const key = kind === 'cv' ? 'data-cv-bias' : 'data-fn-bias';
    let target;
    if (comps.length) {
      const cur = comps.includes(inst.biasValues.comp) ? inst.biasValues.comp : comps[0];
      const opts = comps.map(c =>
        `<option value="${attr(c)}"${c === cur ? ' selected' : ''}>${escapeHtml(inst.label + c)}</option>`).join('');
      target = `<select class="stk-select stk-select-sm stk-mono" ${key}="${attr(inst.id)}" data-field="comp">${opts}</select>`;
    } else if (def.isCustom) {
      target = `<p class="stk-hint">The bias acts on <code>${escapeHtml(inst.label)}</code>. If the action ` +
        'outputs several values, name them under Components above.</p>';
    } else {
      target = `<p class="stk-hint">One value: the bias acts on <code>${escapeHtml(inst.label)}</code>.</p>`;
    }
    const cell = (name, label, tip) => `<div class="sg-cv-field">
        <label>${label}${helpBadge(tip)}</label>
        <input type="text" class="stk-input stk-input-sm stk-mono" ${key}="${attr(inst.id)}"
               data-field="${name}" value="${attr(inst.biasValues[name] ?? '')}" autocomplete="off" spellcheck="false">
      </div>`;
    return `<div class="sg-cv-bias">
      <div class="sg-cv-field">
        <label>Biased value${helpBadge('The value the bias acts on. A CV that outputs several, such as label.mean and label.morethan, offers each of them here.')}</label>
        ${target}
      </div>
      <div class="sg-cv-grid sg-cv-grid-4">
        ${cell('min', 'Grid min', 'Lower edge of the bias grid. Hills outside the grid stop the run, so leave room below the lowest value the CV reaches.')}
        ${cell('max', 'Grid max', 'Upper edge of the bias grid.')}
        ${cell('bin', 'Grid bins', 'Number of grid intervals. Aim for a spacing under half of SIGMA.')}
        ${cell('sigma', 'Sigma', 'Width of the Gaussian hill for this CV, in the units of the CV. About a third to a half of its fluctuation in an unbiased run.')}
      </div>
    </div>`;
  }

  function cardHtml(inst) {
    const def = CV_DEFS[inst.type];
    const opts = options();
    const action = actionNameFor(inst, def);
    const own = fieldsFor({ ...def, compStyle: undefined }, { ...opts, action });
    const shared = reductionFieldsFor(def, { ...opts, action });
    const method = getStr('plumedBias', 'none');
    const hidden = hiddenFieldsForBias(inst, method, CV_DEFS);
    const biasName = (BIAS_DEFS[method] || {}).label || 'the selected bias';
    const offTip = `Managed by ${biasName}: this parameter does not apply and is left out of the file.`;
    const canBias = !inst.isGroup && !inst.noBias;

    let html = `<div class="sg-cv-h">
      <div class="sg-cv-id">
        <span class="sg-cv-type">${escapeHtml(inst.type)}</span>
        <input type="text" class="stk-input stk-input-sm stk-mono sg-cv-label" data-cv="${attr(inst.id)}"
               data-field="__label" value="${attr(inst.label)}" aria-label="Label of this ${attr(inst.type)}"
               title="Label" autocomplete="off" spellcheck="false">
      </div>
      <div class="sg-cv-tools">`;
    if (canBias) {
      html += `<label class="stk-check sg-cv-biasflag" title="Feed this variable to the bias; off means it is only computed and printed">
        <input type="checkbox" data-cv="${attr(inst.id)}" data-field="__bias"${inst.bias ? ' checked' : ''}> Bias</label>`;
    } else if (inst.noBias) {
      html += '<span class="stk-badge" title="A reference value, not a bias target. It is printed and can be an argument of a function.">reference</span>';
    } else {
      html += '<span class="stk-badge" title="Defines atoms for other variables to use. It has no value to print or bias.">atoms</span>';
    }
    html += `<button type="button" class="stk-btn stk-btn-sm stk-btn-ghost stk-btn-icon" data-remove="${attr(inst.id)}"
                     aria-label="Remove ${attr(inst.label)}" title="Remove"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
      </div>
    </div>`;

    const example = def.example || CV_EXAMPLES[inst.type];
    const url = docUrl(def, inst);
    if (example || url) {
      html += `<p class="plumed-cv-example">${example ? `${escapeHtml(example)} ` : ''}` +
        (url ? `<a class="plumed-doclink" href="${attr(url)}" target="_blank" rel="noopener">Documentation <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : '') +
        '</p>';
    }
    html += moduleNote(action);
    const prereq = def.prereq && PREREQS[def.prereq];
    if (prereq && !(def.prereqSkipIf && def.prereqSkipIf(inst))) {
      html += `<p class="sg-cv-note sg-cv-note-info"><i class="fa-solid fa-circle-info" aria-hidden="true"></i>` +
        `<span>Needs a <code>${escapeHtml(prereq.label)}</code> line.</span>${helpBadge(`This CV ${prereq.note}`)}</p>`;
    }

    let off = 0;
    const draw = (f) => {
      const isOff = hidden.has(f.k);
      if (isOff) off += 1;
      return fieldHtml(inst, f, isOff, offTip);
    };
    if (own.length) html += `<div class="sg-cv-grid">${own.map(draw).join('')}</div>`;
    if (shared.length) {
      const comps = componentsForCV(inst, CV_DEFS, opts);
      const first = comps[0] || '.mean';
      const on = shared.filter(f => (f.type === 'flag' ? !!inst.values[f.k] : String(inst.values[f.k] ?? '').trim() !== '')).length;
      // Closed by default: nine more fields would bury the ones that matter.
      const isOpen = state.open.has(inst.id);
      html += `<details class="sg-cv-more" data-more="${attr(inst.id)}"${isOpen ? ' open' : ''}>
        <summary><span>Reductions</span><span class="stk-badge">${on} on</span>${helpBadge(
        'A multicolvar computes one value per atom; a reduction turns them into a single number. ' +
        'Tick a flag, or give a block such as {RATIONAL R_0=0.5}. Several blocks separated by ; ' +
        `are numbered, giving ${inst.label}.morethan-1, ${inst.label}.morethan-2. Each reduction ` +
        `switched on becomes a value to bias or print, such as ${inst.label}${first}.`)}</summary>
        <div class="sg-cv-grid">${shared.map(draw).join('')}</div>
      </details>`;
    }
    if (off) {
      html += `<p class="stk-hint"><i class="fa-solid fa-ban" aria-hidden="true"></i> ${off} field${off > 1 ? 's' : ''} ` +
        'greyed out: managed by the selected bias method and left out of the file.</p>';
    }
    if (canBias && inst.bias) html += biasBlockHtml(inst, def);
    return html;
  }

  function renderCVList() {
    const host = $('plumedCVList');
    if (!host) return;
    // Entries restored for a release that lacks them would write nothing.
    if (!state.cvs.length) {
      host.innerHTML = '<p class="sg-cv-empty">Each variable you add appears here with its own settings and a ' +
        'Bias switch. Pick a category and a variable above, then press Add collective variable.</p>';
      return;
    }
    const focus = document.activeElement && host.contains(document.activeElement)
      ? { cv: document.activeElement.getAttribute('data-cv') || document.activeElement.getAttribute('data-cv-bias'),
        field: document.activeElement.getAttribute('data-field'),
        bias: document.activeElement.hasAttribute('data-cv-bias'),
        at: document.activeElement.selectionStart }
      : null;

    host.innerHTML = '';
    for (const inst of state.cvs) {
      const card = document.createElement('div');
      card.className = 'sg-cv';
      card.innerHTML = cardHtml(inst);
      host.appendChild(card);
    }

    host.querySelectorAll('[data-pick]').forEach((el) => {
      el.addEventListener('click', () => atomsTool.pickFor(el.getAttribute('data-pick'), el.getAttribute('data-field')));
    });
    host.querySelectorAll('[data-more]').forEach((el) => {
      el.addEventListener('toggle', () => {
        if (el.open) state.open.add(el.getAttribute('data-more'));
        else state.open.delete(el.getAttribute('data-more'));
      });
    });
    host.querySelectorAll('[data-remove]').forEach((el) => {
      el.addEventListener('click', () => removeCV(el.getAttribute('data-remove')));
    });
    host.querySelectorAll('[data-cv]').forEach((el) => {
      const evt = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
      el.addEventListener(evt, () => onFieldEdit(el));
    });
    host.querySelectorAll('[data-cv-bias]').forEach((el) => {
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
        const inst = state.cvs.find(c => c.id === el.getAttribute('data-cv-bias'));
        if (!inst) return;
        inst.biasValues[el.getAttribute('data-field')] = el.value;
        generate();
      });
    });

    // Drawing the list again must not take the caret away mid-word.
    if (focus && focus.cv) {
      const sel = focus.bias
        ? `[data-cv-bias="${CSS.escape(focus.cv)}"][data-field="${CSS.escape(focus.field)}"]`
        : `[data-cv="${CSS.escape(focus.cv)}"][data-field="${CSS.escape(focus.field)}"]`;
      const el = host.querySelector(sel);
      if (el) {
        el.focus({ preventScroll: true });
        if (typeof focus.at === 'number' && el.setSelectionRange) {
          try { el.setSelectionRange(focus.at, focus.at); } catch (_) { /* not a text field */ }
        }
      }
    }
  }

  function onFieldEdit(el) {
    const inst = state.cvs.find(c => c.id === el.getAttribute('data-cv'));
    if (!inst) return;
    const field = el.getAttribute('data-field');
    if (field === '__label') {
      inst.label = el.value.trim() || inst.id;
    } else if (field === '__bias') {
      inst.bias = el.checked;
    } else if (el.type === 'checkbox') {
      inst.values[field] = el.checked;
    } else {
      inst.values[field] = el.value;
    }
    if (field === '__bias' || REDRAW_FIELDS.has(field)) {
      const comps = componentsForCV(inst, CV_DEFS, options());
      if (comps.length && !comps.includes(inst.biasValues.comp)) inst.biasValues.comp = comps[0];
      if (!comps.length) inst.biasValues.comp = '';
      renderAll();
    }
    generate();
  }

  /* ---------------------------------------------------------------- *
   * Keeping the caret through a redraw
   * ---------------------------------------------------------------- */

  function rememberFocus(host) {
    const el = document.activeElement;
    if (!el || !host.contains(el) || !el.getAttribute('data-k')) return null;
    return { k: el.getAttribute('data-k'), at: el.selectionStart };
  }

  function restoreFocus(host, focus) {
    if (!focus) return;
    const el = host.querySelector(`[data-k="${CSS.escape(focus.k)}"]`);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (typeof focus.at === 'number' && el.setSelectionRange) {
      try { el.setSelectionRange(focus.at, focus.at); } catch (_) { /* not a text field */ }
    }
  }

  const removeButton = (attrName, id, label) =>
    `<button type="button" class="stk-btn stk-btn-sm stk-btn-ghost stk-btn-icon" ${attrName}="${attr(id)}"
             aria-label="Remove ${attr(label)}" title="Remove"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>`;

  /* ---------------------------------------------------------------- *
   * Functions
   * ---------------------------------------------------------------- */

  function populateFnSelect() {
    const sel = $('plumedFnType');
    if (!sel || sel.options.length) return;
    for (const k of Object.keys(FUNCTION_DEFS)) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = FUNCTION_DEFS[k].label;
      sel.appendChild(opt);
    }
  }

  function fnCardHtml(fn) {
    const def = FUNCTION_DEFS[fn.type];
    const offered = argumentList(fn.id).filter(a => !fn.args.includes(a));
    const chips = fn.args.map((a, i) => {
      const known = argumentList(fn.id).includes(a) || getStr('plumedInclude', '') !== '';
      return `<li class="sg-chip${known ? '' : ' sg-chip-bad'}" title="${known ? '' : 'Nothing above defines this value'}">
        <span class="sg-chip-n">${i + 1}</span><code>${escapeHtml(a)}</code>
        <button type="button" data-fn-up="${attr(fn.id)}" data-i="${i}" aria-label="Move ${attr(a)} earlier" title="Move earlier"${i === 0 ? ' disabled' : ''}><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button>
        <button type="button" data-fn-del="${attr(fn.id)}" data-i="${i}" aria-label="Remove ${attr(a)}" title="Remove"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </li>`;
    }).join('');
    const opts = ['<option value="">Add an argument…</option>']
      .concat(offered.map(a => `<option value="${attr(a)}">${escapeHtml(a)}</option>`)).join('');

    let html = `<div class="sg-cv-h">
      <div class="sg-cv-id">
        <span class="sg-cv-type">${escapeHtml(fn.type)}</span>
        <input type="text" class="stk-input stk-input-sm stk-mono sg-cv-label" data-fn="${attr(fn.id)}" data-field="__label"
               data-k="${attr(fn.id)}-label" value="${attr(fn.label)}" aria-label="Label of this function" title="Label"
               autocomplete="off" spellcheck="false">
      </div>
      <div class="sg-cv-tools">
        <label class="stk-check sg-cv-biasflag" title="Feed this function to the bias; off means it is only computed and printed">
          <input type="checkbox" data-fn="${attr(fn.id)}" data-field="__bias"${fn.bias ? ' checked' : ''}> Bias</label>
        ${removeButton('data-fn-remove', fn.id, fn.label)}
      </div>
    </div>
    <p class="plumed-cv-example">${escapeHtml(def.desc)}</p>
    <div class="sg-cv-field">
      <label>Arguments, in order${helpBadge('The values the function takes. The order matters: the first coefficient, or the first name in VAR, belongs to the first argument.')}</label>
      ${fn.args.length ? `<ol class="sg-chips">${chips}</ol>` : '<p class="stk-hint">None yet. Pick the values to combine.</p>'}
      <div class="sg-addrow">
        <select class="stk-select stk-select-sm stk-mono" data-fn-add="${attr(fn.id)}" aria-label="Add an argument to ${attr(fn.label)}"${offered.length ? '' : ' disabled'}>${opts}</select>
        <button type="button" class="stk-btn stk-btn-sm" data-fn-all="${attr(fn.id)}"${offered.length ? '' : ' disabled'}>Add all</button>
      </div>
    </div>
    <div class="sg-cv-grid">`;
    for (const f of def.fields) {
      const id = `${fn.id}-${f.k}`;
      const help = helpBadge(f.help || '');
      if (f.type === 'flag') {
        html += `<div class="sg-cv-flag"><input type="checkbox" id="${attr(id)}" data-fn="${attr(fn.id)}" data-field="${attr(f.k)}"${fn.values[f.k] ? ' checked' : ''}>
          <label for="${attr(id)}">${escapeHtml(f.label)}</label>${help}</div>`;
      } else {
        const wide = f.k === 'COEFFICIENTS' || f.k === 'FUNC';
        html += `<div class="sg-cv-field${wide ? ' sg-cv-wide' : ''}"><label for="${attr(id)}">${escapeHtml(f.label)}${help}</label>
          <input type="text" id="${attr(id)}" class="stk-input stk-input-sm stk-mono" data-fn="${attr(fn.id)}" data-field="${attr(f.k)}"
                 data-k="${attr(id)}" value="${attr(fn.values[f.k] ?? '')}" autocomplete="off" spellcheck="false"></div>`;
      }
    }
    html += '</div>';
    if (fn.type === 'COMBINE' && fn.args.length) {
      const n = String(fn.values.COEFFICIENTS || '').split(',').filter(x => x.trim() !== '').length;
      const ok = n === 0 || n === fn.args.length;
      html += `<p class="stk-hint${ok ? '' : ' sg-hint-bad'}">${n === 0
        ? `${fn.args.length} argument${fn.args.length === 1 ? '' : 's'}; with no coefficients each counts once.`
        : `${n} coefficient${n === 1 ? '' : 's'} for ${fn.args.length} argument${fn.args.length === 1 ? '' : 's'}.`}</p>`;
    }
    if (fn.bias) html += biasBlockHtml(fn, def, 'fn');
    return html;
  }

  function renderFnList() {
    const host = $('plumedFnList');
    if (!host) return;
    populateFnSelect();
    const focus = rememberFocus(host);
    host.innerHTML = '';
    for (const fn of state.functions) {
      const card = document.createElement('div');
      card.className = 'sg-cv';
      card.innerHTML = fnCardHtml(fn);
      host.appendChild(card);
    }
    const find = (id) => state.functions.find(f => f.id === id);
    const redraw = () => { renderFnList(); renderRestraintList(); renderPrintList(); generate(); };

    host.querySelectorAll('[data-fn-remove]').forEach(el => el.addEventListener('click', () => {
      state.functions = state.functions.filter(f => f.id !== el.getAttribute('data-fn-remove'));
      redraw();
    }));
    host.querySelectorAll('[data-fn-add]').forEach(el => el.addEventListener('change', () => {
      const fn = find(el.getAttribute('data-fn-add'));
      if (fn && el.value) { fn.args.push(el.value); redraw(); }
    }));
    host.querySelectorAll('[data-fn-all]').forEach(el => el.addEventListener('click', () => {
      const fn = find(el.getAttribute('data-fn-all'));
      if (!fn) return;
      for (const a of argumentList(fn.id)) if (!fn.args.includes(a)) fn.args.push(a);
      redraw();
    }));
    host.querySelectorAll('[data-fn-del]').forEach(el => el.addEventListener('click', () => {
      const fn = find(el.getAttribute('data-fn-del'));
      if (fn) { fn.args.splice(Number(el.getAttribute('data-i')), 1); redraw(); }
    }));
    host.querySelectorAll('[data-fn-up]').forEach(el => el.addEventListener('click', () => {
      const fn = find(el.getAttribute('data-fn-up'));
      const i = Number(el.getAttribute('data-i'));
      if (fn && i > 0) { [fn.args[i - 1], fn.args[i]] = [fn.args[i], fn.args[i - 1]]; redraw(); }
    }));
    host.querySelectorAll('[data-fn]').forEach((el) => {
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
        const fn = find(el.getAttribute('data-fn'));
        if (!fn) return;
        const field = el.getAttribute('data-field');
        if (field === '__label') fn.label = el.value.trim() || fn.id;
        else if (field === '__bias') fn.bias = el.checked;
        else if (el.type === 'checkbox') fn.values[field] = el.checked;
        else fn.values[field] = el.value;
        if (['__label', '__bias', 'COEFFICIENTS'].includes(field)) redraw();
        else generate();
      });
    });
    host.querySelectorAll('[data-fn-bias]').forEach((el) => {
      el.addEventListener('input', () => {
        const fn = find(el.getAttribute('data-fn-bias'));
        if (!fn) return;
        fn.biasValues[el.getAttribute('data-field')] = el.value;
        generate();
      });
    });
    restoreFocus(host, focus);
  }

  function addFunction() {
    const type = getStr('plumedFnType', 'COMBINE');
    const fn = createFunction(type, ++state.fnSeq);
    if (!fn) return;
    state.functions.push(fn);
    renderFnList();
    renderRestraintList();
    renderPrintList();
    generate();
  }

  /* ---------------------------------------------------------------- *
   * Walls and restraints
   * ---------------------------------------------------------------- */

  const RESTRAINT_NAMES = { upper: 'UPPER_WALLS', lower: 'LOWER_WALLS', restraint: 'RESTRAINT' };
  const RESTRAINT_PREFIX = { upper: 'uw', lower: 'lw', restraint: 'res' };

  function renderRestraintList() {
    const host = $('plumedRestraintList');
    if (!host) return;
    const focus = rememberFocus(host);
    const args = argumentList();
    host.innerHTML = '';
    for (const r of state.restraints) {
      const opts = ['<option value="">Pick a value…</option>']
        .concat(args.map(a => `<option value="${attr(a)}"${a === r.arg ? ' selected' : ''}>${escapeHtml(a)}</option>`));
      if (r.arg && !args.includes(r.arg)) {
        opts.push(`<option value="${attr(r.arg)}" selected>${escapeHtml(r.arg)} (not defined)</option>`);
      }
      const input = (k, label, tip, ph = '') => `<div class="sg-cv-field">
          <label>${label}${helpBadge(tip)}</label>
          <input type="text" class="stk-input stk-input-sm stk-mono" data-res="${attr(r.id)}" data-field="${k}"
                 data-k="${attr(r.id)}-${k}" value="${attr(r[k] ?? '')}" placeholder="${attr(ph)}" autocomplete="off" spellcheck="false">
        </div>`;
      const wall = r.type !== 'restraint';
      const card = document.createElement('div');
      card.className = 'sg-cv';
      card.innerHTML = `<div class="sg-cv-h">
          <div class="sg-cv-id">
            <span class="sg-cv-type">${RESTRAINT_NAMES[r.type]}</span>
            <input type="text" class="stk-input stk-input-sm stk-mono sg-cv-label" data-res="${attr(r.id)}" data-field="label"
                   data-k="${attr(r.id)}-label" value="${attr(r.label)}" aria-label="Label" title="Label" autocomplete="off" spellcheck="false">
          </div>
          <div class="sg-cv-tools">${removeButton('data-res-remove', r.id, r.label)}</div>
        </div>
        <div class="sg-cv-grid">
          <div class="sg-cv-field sg-cv-wide">
            <label>Acts on</label>
            <select class="stk-select stk-select-sm stk-mono" data-res="${attr(r.id)}" data-field="arg">${opts.join('')}</select>
          </div>
          ${input('at', 'AT', r.type === 'upper'
            ? 'The wall is felt when the value rises above this.'
            : r.type === 'lower' ? 'The wall is felt when the value falls below this.' : 'The value the restraint pulls toward.')}
          ${input('kappa', 'KAPPA', 'Force constant, in energy per unit of the value squared. The energy is KAPPA times the distance past the wall, to the power EXP.')}
          ${wall ? input('exp', 'EXP', 'Power of the wall. 2 is harmonic; 4 is flatter near the wall and steeper beyond.', '2') : ''}
          ${wall ? input('offset', 'OFFSET', 'Shifts where the wall starts, without moving AT.', '0') : ''}
        </div>`;
      host.appendChild(card);
    }
    const find = (id) => state.restraints.find(x => x.id === id);
    host.querySelectorAll('[data-res-remove]').forEach(el => el.addEventListener('click', () => {
      state.restraints = state.restraints.filter(x => x.id !== el.getAttribute('data-res-remove'));
      renderRestraintList();
      renderPrintList();
      generate();
    }));
    host.querySelectorAll('[data-res]').forEach((el) => {
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
        const r = find(el.getAttribute('data-res'));
        if (!r) return;
        const field = el.getAttribute('data-field');
        r[field] = field === 'label' ? (el.value.trim() || r.id) : el.value;
        if (field === 'label') renderPrintList();
        generate();
      });
    });
    restoreFocus(host, focus);
  }

  function addRestraint() {
    const type = getStr('plumedRestraintType', 'upper');
    if (!RESTRAINT_NAMES[type]) return;
    const n = ++state.restraintSeq;
    const first = argumentList()[0] || '';
    state.restraints.push({
      id: `res${n}`, type, label: `${RESTRAINT_PREFIX[type]}${n}`, arg: first,
      at: '', kappa: type === 'restraint' ? '200' : '150', exp: '', eps: '', offset: ''
    });
    renderRestraintList();
    renderPrintList();
    generate();
  }

  /* ---------------------------------------------------------------- *
   * Output files
   * ---------------------------------------------------------------- */

  function printableList() {
    const result = state.lastResult;
    const bias = result ? result.printable || [] : [];
    const out = argumentList();
    for (const a of bias) if (!out.includes(a)) out.push(a);
    return out;
  }

  function renderPrintList() {
    const host = $('plumedPrintList');
    if (!host) return;
    const focus = rememberFocus(host);
    const all = printableList();
    host.innerHTML = '';
    state.prints.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'sg-cv';
      const picks = all.map(a => `<label class="sg-pick"><input type="checkbox" data-print="${i}" data-arg="${attr(a)}"` +
        `${p.args.includes(a) ? ' checked' : ''}> <code>${escapeHtml(a)}</code></label>`).join('');
      card.innerHTML = `<div class="sg-cv-grid">
          <div class="sg-cv-field">
            <label>File${helpBadge('Name of the file this PRINT writes. The first is COLVAR by convention.')}</label>
            <input type="text" class="stk-input stk-input-sm stk-mono" data-print="${i}" data-field="file" data-k="print-${i}-file"
                   value="${attr(p.file)}" autocomplete="off" spellcheck="false">
          </div>
          <div class="sg-cv-field">
            <label>Every (steps)${helpBadge('How often a line is written. Blank takes the default STRIDE of the method panel. A larger value means a smaller file and coarser time resolution.')}</label>
            <input type="text" class="stk-input stk-input-sm stk-mono" data-print="${i}" data-field="stride" data-k="print-${i}-stride"
                   value="${attr(p.stride)}" placeholder="default: ${attr(getStr('plumedStride', '500'))}" inputmode="numeric" autocomplete="off" spellcheck="false">
          </div>
          <div class="sg-cv-flag">
            <input type="checkbox" id="print-${i}-all" data-print="${i}" data-field="all"${p.all ? ' checked' : ''}>
            <label for="print-${i}-all">Everything: each variable, function and bias</label>
            ${state.prints.length > 1 ? removeButton('data-print-remove', String(i), p.file) : ''}
          </div>
          ${p.all ? '' : `<div class="sg-cv-field sg-cv-wide"><label>Values to write</label>
            <div class="sg-picks">${picks || '<p class="stk-hint">Add a variable first.</p>'}</div></div>`}
          <div class="sg-cv-field sg-cv-wide">
            <label>Also write${helpBadge('Further values, separated by commas, such as metad.work or a value from an included file. Wildcards are allowed: metad.* writes every component of metad.')}</label>
            <input type="text" class="stk-input stk-input-sm stk-mono" data-print="${i}" data-field="extra" data-k="print-${i}-extra"
                   value="${attr(p.extra)}" placeholder="optional, e.g. metad.work" autocomplete="off" spellcheck="false">
          </div>
        </div>`;
      host.appendChild(card);
    });
    host.querySelectorAll('[data-print-remove]').forEach(el => el.addEventListener('click', () => {
      state.prints.splice(Number(el.getAttribute('data-print-remove')), 1);
      renderPrintList();
      generate();
    }));
    host.querySelectorAll('[data-print]').forEach((el) => {
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
        const p = state.prints[Number(el.getAttribute('data-print'))];
        if (!p) return;
        const arg = el.getAttribute('data-arg');
        if (arg) {
          if (el.checked && !p.args.includes(arg)) p.args.push(arg);
          if (!el.checked) p.args = p.args.filter(a => a !== arg);
        } else if (el.getAttribute('data-field') === 'all') {
          p.all = el.checked;
          renderPrintList();
        } else {
          p[el.getAttribute('data-field')] = el.value;
        }
        generate();
      });
    });
    restoreFocus(host, focus);
  }

  function addPrint() {
    const n = state.prints.length;
    const p = newPrint(n === 0 ? 'COLVAR' : `COLVAR.${n}`, '');
    if (n > 0) p.all = false;
    state.prints.push(p);
    renderPrintList();
    generate();
  }

  /* ---------------------------------------------------------------- *
   * Saved settings
   * ---------------------------------------------------------------- */

  function serialise() {
    return {
      seq: state.seq,
      cvs: state.cvs.map(c => ({
        id: c.id, type: c.type, label: c.label, bias: c.bias, isGroup: c.isGroup,
        noBias: c.noBias, values: { ...c.values }, biasValues: { ...c.biasValues }
      })),
      fnSeq: state.fnSeq,
      functions: JSON.parse(JSON.stringify(state.functions)),
      restraintSeq: state.restraintSeq,
      restraints: JSON.parse(JSON.stringify(state.restraints)),
      prints: JSON.parse(JSON.stringify(state.prints)),
      files: JSON.parse(JSON.stringify(state.files)),
      bias: JSON.parse(JSON.stringify(state.biasVals))
    };
  }

  // Unknown entries are dropped: a file from a newer page, or one naming a
  // variable this page no longer has, still restores everything it can.
  function restore(data, fields = {}) {
    const p = data && typeof data === 'object' ? data : {};
    const text = (v, d = '') => (v === undefined || v === null ? d : String(v));
    state.cvs = Array.isArray(p.cvs) ? p.cvs
      .filter(c => c && CV_DEFS[c.type] && typeof c.id === 'string')
      .map((c) => {
        const def = CV_DEFS[c.type];
        return {
          id: c.id,
          type: c.type,
          label: String(c.label || c.id),
          bias: !def.isGroup && !def.noBias && c.bias !== false,
          isGroup: !!def.isGroup,
          noBias: !!def.noBias,
          values: c.values && typeof c.values === 'object' ? { ...c.values } : {},
          biasValues: {
            ...defaultBiasValues(c.type),
            ...(c.biasValues && typeof c.biasValues === 'object' ? c.biasValues : {})
          }
        };
      }) : [];
    state.seq = Math.max(
      Number.isInteger(p.seq) ? p.seq : 0,
      ...state.cvs.map(c => parseInt(String(c.id).replace(/^cv/, ''), 10) || 0)
    );
    state.functions = Array.isArray(p.functions) ? p.functions
      .filter(f => f && FUNCTION_DEFS[f.type] && typeof f.id === 'string')
      .map(f => ({
        id: f.id,
        type: f.type,
        label: text(f.label, f.id),
        args: Array.isArray(f.args) ? f.args.map(a => text(a)).filter(Boolean) : [],
        values: f.values && typeof f.values === 'object' ? { ...f.values } : {},
        bias: !!f.bias,
        biasValues: {
          comp: '', min: '-5.0', max: '5.0', bin: '200', sigma: '0.1',
          ...(f.biasValues && typeof f.biasValues === 'object' ? f.biasValues : {})
        }
      })) : [];
    state.fnSeq = Math.max(Number.isInteger(p.fnSeq) ? p.fnSeq : 0,
      ...state.functions.map(f => parseInt(f.id.replace(/^fn/, ''), 10) || 0));
    state.restraints = Array.isArray(p.restraints) ? p.restraints
      .filter(r => r && RESTRAINT_NAMES[r.type] && typeof r.id === 'string')
      .map(r => ({
        id: r.id, type: r.type, label: text(r.label, r.id), arg: text(r.arg), at: text(r.at),
        kappa: text(r.kappa), exp: text(r.exp), eps: text(r.eps), offset: text(r.offset)
      })) : [];
    state.restraintSeq = Math.max(Number.isInteger(p.restraintSeq) ? p.restraintSeq : 0,
      ...state.restraints.map(r => parseInt(r.id.replace(/^res/, ''), 10) || 0));
    state.prints = Array.isArray(p.prints) && p.prints.length ? p.prints.filter(Boolean).map(x => ({
      file: text(x.file, 'COLVAR'), stride: text(x.stride), extra: text(x.extra),
      all: x.all !== false, args: Array.isArray(x.args) ? x.args.map(a => text(a)) : []
    })) : [{
      // Settings saved before the output list: one PRINT, kept in three fields.
      ...newPrint(text(fields.plumedPrintFile, 'COLVAR') || 'COLVAR', text(fields.plumedPrintStride)),
      extra: text(fields.plumedPrintExtra)
    }];
    state.files = {};
    if (p.files && typeof p.files === 'object') {
      for (const [name, f] of Object.entries(p.files)) {
        if (!f || typeof f.text !== 'string' || !/^[\w.-]+$/.test(name)) continue;
        state.files[name] = {
          text: f.text, note: text(f.note), forVersion: text(f.forVersion),
          labels: Array.isArray(f.labels) ? f.labels.map(l => text(l)) : []
        };
      }
    }
    state.biasVals = {};
    if (p.bias && typeof p.bias === 'object') {
      for (const method of Object.keys(p.bias)) {
        if (BIAS_DEFS[method] && p.bias[method] && typeof p.bias[method] === 'object') {
          state.biasVals[method] = { ...p.bias[method] };
        }
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  /* The grid, the reweighting factor and walkers belong to the metadynamics
     family; the other methods have no use for them. */
  function syncMethod() {
    const method = getStr('plumedBias', 'none');
    const wrap = $('plumedSpeedWrap');
    if (wrap) wrap.hidden = !['metad', 'wt_metad', 'pbmetad', 'opes'].includes(method);
  }

  const on = (id, events, fn) => {
    const el = $(id);
    if (el) events.split(' ').forEach(e => el.addEventListener(e, fn));
  };

  on('plumedVersion', 'change', () => {
    ensureSyntax();
    populateCVSelect();
    renderBiasParams();
    renderAll();
    if (ctx.onVersionChange) ctx.onVersionChange();
    generate();
    check.run();
    // Directions are written MOLECULES for 2.9 and DISTANCES from 2.10.
    const old = (v) => v === '2.9';
    const stale = Object.keys(state.files).filter(n =>
      state.files[n].forVersion && old(state.files[n].forVersion) !== old(version()));
    if (stale.length && ctx.showToast) {
      ctx.showToast(`${stale.join(', ')} was written for PLUMED ${state.files[stale[0]].forVersion}. ` +
        'Write it again for this version.', 'warn');
    }
  });
  on('plumedNatoms', 'input', () => check.run());
  on('plumedAddFn', 'click', addFunction);
  on('plumedAddRestraint', 'click', addRestraint);
  on('plumedAddPrint', 'click', addPrint);
  on('plumedRestart', 'change', generate);
  on('plumedInclude', 'input', () => { renderFnList(); generate(); });
  on('plumedStride', 'input', renderPrintList);
  on('plumedCategory', 'change', populateCVSelect);
  on('plumedCVSelect', 'change', updateCVDesc);
  on('plumedAddCV', 'click', addCV);
  on('plumedBias', 'change', () => {
    renderBiasParams();
    renderCVList();
    syncMethod();
    generate();
    renderPrintList();
  });
  on('plumedTemp', 'input', renderBiasParams);
  for (const id of ['plumedTemp', 'plumedStride', 'plumedMolinfo', 'plumedNatoms', 'plumedLoad',
    'plumedFlush', 'plumedUnitLength', 'plumedUnitEnergy', 'plumedUnitTime', 'plumedWalkersN',
    'plumedWalkersId', 'plumedWalkersDir', 'plumedWalkersRstride', 'plumedWholeEntities']) {
    on(id, 'input change', generate);
  }
  for (const id of ['plumedGrid', 'plumedRct', 'plumedWalkers', 'plumedWholeResidues']) {
    on(id, 'change', generate);
  }
  for (const id of ['plumedWalkersMode', 'plumedWhole']) {
    on(id, 'change', () => {
      if (ctx.syncVisibility) ctx.syncVisibility();
      generate();
    });
  }

  /* ---------------------------------------------------------------- *
   * Views of the output column
   * ---------------------------------------------------------------- */

  const VIEW_BOX = { input: 'scriptBox', check: 'plumedCheckBox' };

  function showView(view) {
    state.view = VIEW_BOX[view] ? view : 'input';
    document.querySelectorAll('[data-plumed-view]').forEach((b) => {
      b.setAttribute('aria-selected', b.getAttribute('data-plumed-view') === state.view ? 'true' : 'false');
    });
    for (const [v, id] of Object.entries(VIEW_BOX)) {
      if ($(id)) $(id).hidden = v !== state.view;
    }
  }

  /** Replace what the builder holds with an imported description. */
  function load(config, fields) {
    if (ctx.setFields) ctx.setFields(fields);
    state.biasVals = {};
    if (config.bias && config.bias.method !== 'none') {
      state.biasVals[config.bias.method] = { ...config.bias.params };
    }
    restore({
      cvs: config.cvs, functions: config.functions, restraints: config.restraints,
      prints: config.prints.map(p => ({ ...p })), bias: state.biasVals
    });
    if (ctx.syncVisibility) ctx.syncVisibility();
    populateBiasSelect();
    renderBiasParams();
    syncMethod();
    generate();
    renderAll();
    if (ctx.scheduleSave) ctx.scheduleSave();
  }

  function includeList() {
    return getStr('plumedInclude', '').split(/[\n,;]+|\s+/).map(x => x.trim()).filter(Boolean);
  }

  function setIncludes(list) {
    if (ctx.setFields) ctx.setFields({ plumedInclude: list.join('\n') });
  }

  const atomsTool = createPlumedAtoms(ctx, {
    version,
    files: () => state.files,
    setNatoms: (n) => { if (ctx.setFields) ctx.setFields({ plumedNatoms: String(n) }); generate(); },
    addCV(type, values, label) {
      const inst = createCV(type, ++state.seq, { ...options(), values });
      if (!inst) return;
      const taken = new Set([...state.cvs, ...state.functions].map(c => c.label));
      let name = label || inst.label;
      for (let i = 2; taken.has(name); i++) name = `${label}${i}`;
      inst.label = name;
      state.cvs.push(inst);
      renderAll();
      generate();
      if (ctx.scheduleSave) ctx.scheduleSave();
    },
    atomFields() {
      const out = [];
      for (const cv of state.cvs) {
        const def = CV_DEFS[cv.type];
        for (const f of fieldsFor({ ...def, compStyle: undefined }, options())) {
          if (f.type === 'atoms') out.push({ id: cv.id, field: f.k, label: cv.label });
        }
      }
      return out;
    },
    setAtomField(id, field, value) {
      const cv = state.cvs.find(c => c.id === id);
      if (!cv) return;
      cv.values[field] = value;
      renderAll();
      generate();
      if (ctx.scheduleSave) ctx.scheduleSave();
    },
    addInclude(name, text, note, labels, forVersion) {
      state.files[name] = { text, note, labels: labels || [], forVersion: forVersion || '' };
      const list = includeList();
      if (!list.includes(name)) setIncludes([...list, name]);
      renderFnList();
      generate();
      if (ctx.scheduleSave) ctx.scheduleSave();
    },
    removeFile(name) {
      delete state.files[name];
      setIncludes(includeList().filter(f => f !== name));
      generate();
      if (ctx.scheduleSave) ctx.scheduleSave();
    }
  });

  const check = createPlumedCheck(ctx, {
    version,
    syntax,
    natoms: () => parseInt(getStr('plumedNatoms', ''), 10) || 0,
    currentInput: () => (state.lastResult ? state.lastResult.input : ''),
    load,
    showView
  });

  document.querySelectorAll('[data-plumed-view]').forEach((b) => {
    b.addEventListener('click', () => showView(b.getAttribute('data-plumed-view')));
  });

  return {
    version,
    generate,
    serialise,
    restore,
    /** Called when another engine takes the page. */
    leave() {
      if ($('plumedViews')) $('plumedViews').hidden = true;
      for (const id of Object.values(VIEW_BOX)) if ($(id)) $(id).hidden = id !== 'scriptBox';
    },
    /** Called when the PLUMED tab is shown. */
    enter() {
      ensureSyntax();
      populateCVSelect();
      populateBiasSelect();
      renderBiasParams();
      syncMethod();
      generate();
      renderAll();
      if ($('plumedViews')) $('plumedViews').hidden = false;
      showView(state.view);
      check.run();
      atomsTool.render();
    },
    /** The side files of the input, by name. */
    files: () => state.files
  };
}
