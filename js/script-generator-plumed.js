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
  CV_DEFS, CV_EXAMPLES, BIAS_DEFS, KEY_HELP, PREREQS, PLUMED_VERSIONS, DEFAULT_PLUMED_VERSION,
  cvAvailable, fieldsFor, reductionFieldsFor, componentsForCV, hiddenFieldsForBias,
  actionNameFor, createCV, defaultBiasValues, generatePlumedInput, messageToHtml
} from '../src/core/plumed.js';
import { loadSyntax, plumedDocUrl } from '../src/core/plumed-syntax.js';

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

  const state = {
    cvs: [],
    seq: 0,
    biasVals: {},
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
      renderCVList();
      generate();
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
      cvs: state.cvs,
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
      prints: [{
        file: getStr('plumedPrintFile', 'COLVAR'),
        stride: getStr('plumedPrintStride', stride),
        extra: getStr('plumedPrintExtra', '')
      }]
    };
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
    renderCVList();
    generate();
  }

  function removeCV(id) {
    state.cvs = state.cvs.filter(c => c.id !== id);
    renderCVList();
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
    return `<div class="${cls}${wide ? ' sg-cv-wide' : ''}">
      <label for="${attr(id)}">${escapeHtml(f.label || f.k)}${help}</label>
      <input type="text" id="${attr(id)}" class="stk-input stk-input-sm stk-mono" data-cv="${attr(inst.id)}"
             data-field="${attr(f.k)}" value="${attr(value ?? '')}" autocomplete="off" spellcheck="false"${dis}>
    </div>`;
  }

  function biasBlockHtml(inst, def) {
    const comps = componentsForCV(inst, CV_DEFS, options());
    let target;
    if (comps.length) {
      const cur = comps.includes(inst.biasValues.comp) ? inst.biasValues.comp : comps[0];
      const opts = comps.map(c =>
        `<option value="${attr(c)}"${c === cur ? ' selected' : ''}>${escapeHtml(inst.label + c)}</option>`).join('');
      target = `<select class="stk-select stk-select-sm stk-mono" data-cv-bias="${attr(inst.id)}" data-field="comp">${opts}</select>`;
    } else if (def.isCustom) {
      target = `<p class="stk-hint">The bias acts on <code>${escapeHtml(inst.label)}</code>. If the action ` +
        'outputs several values, name them under Components above.</p>';
    } else {
      target = `<p class="stk-hint">One value: the bias acts on <code>${escapeHtml(inst.label)}</code>.</p>`;
    }
    const cell = (key, label, tip) => `<div class="sg-cv-field">
        <label>${label}${helpBadge(tip)}</label>
        <input type="text" class="stk-input stk-input-sm stk-mono" data-cv-bias="${attr(inst.id)}"
               data-field="${key}" value="${attr(inst.biasValues[key] ?? '')}" autocomplete="off" spellcheck="false">
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
      const first = componentsForCV(inst, CV_DEFS, opts)[0] || '.mean';
      html += `<p class="sg-cv-sub">Reductions${helpBadge(
        'A multicolvar computes one value per atom; a reduction turns them into a single number. ' +
        'Tick a flag, or give a block such as {RATIONAL R_0=0.5}. Several blocks separated by ; ' +
        `are numbered, giving ${inst.label}.morethan-1, ${inst.label}.morethan-2. Each reduction ` +
        `switched on becomes a value to bias or print, such as ${inst.label}${first}.`)}</p>`;
      html += `<div class="sg-cv-grid">${shared.map(draw).join('')}</div>`;
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
      renderCVList();
    }
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
      bias: JSON.parse(JSON.stringify(state.biasVals))
    };
  }

  // Unknown entries are dropped: a file from a newer page, or one naming a
  // variable this page no longer has, still restores everything it can.
  function restore(data) {
    const p = data && typeof data === 'object' ? data : {};
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

  const on = (id, events, fn) => {
    const el = $(id);
    if (el) events.split(' ').forEach(e => el.addEventListener(e, fn));
  };

  on('plumedVersion', 'change', () => {
    ensureSyntax();
    populateCVSelect();
    renderBiasParams();
    renderCVList();
    if (ctx.onVersionChange) ctx.onVersionChange();
    generate();
  });
  on('plumedCategory', 'change', populateCVSelect);
  on('plumedCVSelect', 'change', updateCVDesc);
  on('plumedAddCV', 'click', addCV);
  on('plumedBias', 'change', () => {
    renderBiasParams();
    renderCVList();
    generate();
  });
  on('plumedTemp', 'input', renderBiasParams);
  for (const id of ['plumedTemp', 'plumedStride', 'plumedMolinfo', 'plumedPrintFile', 'plumedPrintStride',
    'plumedPrintExtra', 'plumedUnitLength', 'plumedUnitEnergy', 'plumedUnitTime', 'plumedWalkersN',
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

  return {
    version,
    generate,
    serialise,
    restore,
    /** Called when the PLUMED tab is shown. */
    enter() {
      ensureSyntax();
      populateCVSelect();
      populateBiasSelect();
      renderBiasParams();
      renderCVList();
    }
  };
}
