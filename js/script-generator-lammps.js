/*
 * STEMKit, MD Workflow Generator: the LAMMPS tab.
 * Author: Olanrewaju M. Daramola
 *
 * The LAMMPS counterpart of the GROMACS tab, with the same layout: four
 * views on the left (System, Stages, Groups, Job) and three on the right
 * (the run files, every command and style, checking a file). The form is
 * read into the plain state src/core/lammps-workflow.js takes, which writes
 * one input per stage; src/core/lammps-input.js explains and checks every
 * line of them, and src/core/lammps-data.js reads a data file the user drops.
 *
 * Those three modules are loaded when the tab is first shown, so a visit to
 * the GROMACS or PLUMED tab never downloads the LAMMPS reference tables.
 *
 * The job script is still written by script-generator.js, which owns the
 * scheduler header; it asks this module for the stage block (runBlock) and
 * hands the text back through setSubmit().
 */

import { buildZip } from '../src/core/zip.js';
import { walltimeToSeconds } from '../src/core/scheduler.js';
import { createLammpsReference } from './script-generator-lammps-reference.js';
import { createLammpsCheck } from './script-generator-lammps-check.js';
import { createLammpsData } from './script-generator-lammps-data.js';
import {
  STAGE_KEYS, SEVERITY, unitLabels, lengthOptions, lineHtml, explainFiles, statusOfFile,
  formatCount, formatBytes, formatTime
} from './script-generator-lammps-model.js';

const STEPS = ['system', 'stages', 'groups', 'job'];
const VIEWS = ['files', 'commands', 'check'];

/* ------------------------------------------------------------------ *
 * The core modules, loaded once, on demand
 * ------------------------------------------------------------------ */

let corePromise = null;

/**
 * Load the LAMMPS core: the reader and checker (with the reference), the
 * workflow builder and the data-file reader. A module that fails to load is
 * null, so what the others do still works.
 *
 * @returns {Promise<{input:object|null, workflow:object|null, data:object|null, failed:string[]}>}
 */
export function loadLammpsCore() {
  if (!corePromise) {
    const names = ['input', 'workflow', 'data'];
    corePromise = Promise.allSettled([
      import('../src/core/lammps-input.js'),
      import('../src/core/lammps-workflow.js'),
      import('../src/core/lammps-data.js')
    ]).then((res) => {
      const out = { failed: [] };
      res.forEach((r, i) => {
        out[names[i]] = r.status === 'fulfilled' ? r.value : null;
        if (r.status !== 'fulfilled') out.failed.push(names[i]);
      });
      return out;
    });
  }
  return corePromise;
}

/**
 * @param {object} ctx - Page helpers from script-generator.js: `$`, `escapeHtml`,
 *   `showToast`, `downloadText`, `scheduleSave`, `highlightLine`, `getStr`, `getInt`,
 *   `isChecked`, `regenerate()` (rewrites submit.sh), `onViewChange()`,
 *   `schedulerInfo()` → `{label, submit}`, `plumedInput(name)` → the PLUMED tab's
 *   files, `setFields(values)` (restore saved values into fields).
 */
export function createLammpsTab(ctx) {
  const { $, escapeHtml: esc, showToast } = ctx;
  const ui = {
    step: 'system', view: 'files', file: 'submit', mode: 'code', route: 'built',
    submit: '', submitHint: '', planCache: null, checkCache: null, pinned: null,
    timer: 0, active: false, core: null, loading: null,
    // Saved values of the fields whose options come from the workflow
    // module, put back once it has loaded and filled them.
    pending: null
  };

  /* ---------------------------------------------------------------- *
   * Reading the form
   * ---------------------------------------------------------------- */

  const val = (id, dflt = '') => { const el = $(id); return el ? String(el.value).trim() : dflt; };
  const on = (id) => ctx.isChecked(id);
  const num = (id, dflt) => { const v = parseFloat(val(id)); return Number.isFinite(v) ? v : dflt; };
  const optNum = (id) => { const v = parseFloat(val(id)); return Number.isFinite(v) && v > 0 ? v : null; };

  function setValue(id, value) {
    const el = $(id);
    if (!el) return;
    if (el.getAttribute('role') === 'switch') el.setAttribute('aria-checked', value ? 'true' : 'false');
    else if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
  }

  const W = () => (ui.core && ui.core.workflow) || null;
  const I = () => (ui.core && ui.core.input) || null;

  function forceFieldInfo(id = val('lxForceField')) {
    const list = (W() && W().LMP_FORCE_FIELDS) || [];
    return list.find(f => f.id === id) || list[0] || null;
  }
  function units() {
    const ff = forceFieldInfo();
    return (ff && ff.units) || 'real';
  }
  const U = () => unitLabels(I() && I().UNITS, units());

  const text = (id) => { const el = $(id); return el ? String(el.value) : ''; };
  /* A number the user may leave empty: null is "the preset's default". */
  const numOrNull = (id) => { const v = val(id); if (v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const intOrNull = (id) => { const n = numOrNull(id); return n !== null && Number.isInteger(n) && n > 0 ? n : null; };

  /* The fields a preset uses, from its `fields` list, and the form field of each. */
  const FF_FIELDS = {
    inner: ['lxFfInner', 'num'], cutoff: ['lxCutoff', 'num'], kspaceAccuracy: ['lxKspaceAcc', 'num'],
    cmapFile: ['lxCmap', 'text'], potentialFile: ['lxPotential', 'text'], elements: ['lxElements', 'text'],
    controlFile: ['lxControl', 'text'], qeqTolerance: ['lxQeqTol', 'num'], ljTail: ['lxLjTail', 'bool'],
    ljShift: ['lxLjShift', 'bool'], lines: ['lxCustomLines', 'text'], units: ['lxCustomUnits', 'text'],
    atomStyle: ['lxCustomAtomStyle', 'text']
  };
  const presetFields = (ff) => new Set((ff && ff.fields) || []);

  /**
   * The state the workflow module takes (see the documentation at the top
   * of src/core/lammps-workflow.js): its defaults for the force field, with
   * what the form sets on top. An empty field is null, the preset's value.
   */
  function readState() {
    const w = W();
    if (!w) return null;
    const ff = forceFieldInfo();
    const s = JSON.parse(JSON.stringify(w.defaultLammpsState(ff ? ff.id : undefined)));
    const fields = presetFields(ff);
    s.ff = {};
    for (const [key, [id, kind]] of Object.entries(FF_FIELDS)) {
      if (!fields.has(key)) continue;
      if (kind === 'bool') { s.ff[key] = on(id); continue; }
      const v = kind === 'num' ? numOrNull(id) : (key === 'lines' ? text(id) : val(id));
      if (v !== null && v !== '') s.ff[key] = v;
    }
    if (fields.has('styles')) {
      s.styles = { bond: val('lxBondStyle'), angle: val('lxAngleStyle'), dihedral: val('lxDihedralStyle'), improper: val('lxImproperStyle') };
    }
    if (fields.has('waterTypes')) s.waterTypes = { ...s.waterTypes, o: intOrNull('lxWaterO'), h: intOrNull('lxWaterH') };
    if (fields.has('extraLines') || text('lxExtraLines').trim()) s.extraLines = text('lxExtraLines');
    const cells = val('lxLatticeN', '10 10 10').split(/[\s,x×]+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
    s.system = {
      ...s.system,
      source: val('lxSource', s.system.source) || s.system.source,
      dataFile: val('lxDataName') || s.system.dataFile,
      restartFile: val('lxRestartName') || s.system.restartFile,
      lattice: {
        ...s.system.lattice,
        style: val('lxLattice', s.system.lattice.style) || s.system.lattice.style,
        constant: numOrNull('lxLatticeA') ?? s.system.lattice.constant,
        cells: cells.length === 3 ? cells : s.system.lattice.cells,
        element: val('lxElement') || s.system.lattice.element
      }
    };
    s.temperature = numOrNull('lxTemp') ?? s.temperature;
    s.pressure = numOrNull('lxPressure') ?? s.pressure;
    s.timestep = numOrNull('lxDt');
    s.constraints = val('lxRigid', s.constraints) || s.constraints;
    s.thermostat = val('lxThermostat') || s.thermostat;
    s.tdamp = numOrNull('lxTdamp');
    s.barostat = val('lxBarostat') || s.barostat;
    s.pdamp = numOrNull('lxPdamp');
    s.coupling = val('lxCouple', s.coupling) || s.coupling;
    s.bulkModulus = numOrNull('lxBulk');
    s.restraint = { group: val('lxRestrainGroup'), k: numOrNull('lxRestrainK') };
    s.seed = intOrNull('lxSeed') ?? s.seed;
    s.velocities = val('lxVelocities', s.velocities) || s.velocities;
    s.dump = { format: val('lxDumpFormat', s.dump.format) || s.dump.format, unwrap: on('lxUnwrap') };
    s.plumedStages = val('lxPlumedScope', 'prod') || 'prod';
    if (Array.isArray(s.groups)) s.groups = data.groups().map(g => ({ name: g.name, args: g.args, note: g.why || '' }));
    const outUnit = units() === 'lj' ? 'tau' : 'ps';
    for (const k of STAGE_KEYS) {
      const st = s.stages[k];
      st.on = on(`lx_${k}_on`);
      st.restrain = on(`lx_${k}_restrain`);
      if (k === 'min') {
        st.style = val('lx_min_style', st.style) || st.style;
        st.etol = numOrNull('lx_min_etol') ?? st.etol;
        st.ftol = numOrNull('lx_min_ftol') ?? st.ftol;
        st.maxiter = intOrNull('lx_min_maxiter') ?? st.maxiter;
        st.boxRelax = on('lx_min_boxrelax');
        continue;
      }
      st.length = numOrNull(`lx_${k}_len`) ?? st.length;
      st.lengthUnit = val(`lx_${k}_unit`, st.lengthUnit) || st.lengthUnit;
      st.output = {
        unit: outUnit,
        thermo: numOrNull(`lx_${k}_thermo`),
        dump: numOrNull(`lx_${k}_dump`),
        restart: numOrNull(`lx_${k}_restart`)
      };
    }
    s.stages.prod.ensemble = val('lx_prod_ens', 'NPT') || 'NPT';
    // Groups as a page made before the builder took them: in the extra lines.
    if (!Array.isArray(s.groups)) {
      const lines = data.groups().map(g => `group ${g.name} ${g.args}`);
      if (lines.length) s.extraLines = `${lines.join('\n')}${s.extraLines ? `\n${s.extraLines}` : ''}`;
    }
    return s;
  }

  /* ---------------------------------------------------------------- *
   * The workflow
   * ---------------------------------------------------------------- */

  /* The PLUMED tab's input and INCLUDE files, as it last built them. Read
     when the tab is entered and again before a zip is made. */
  let plumedCache = [];
  async function refreshPlumed() {
    if (!ctx.plumedInput) return;
    let got = [];
    try { got = await ctx.plumedInput(val('lxPlumedFile', 'plumed.dat') || 'plumed.dat'); } catch (_) { got = []; }
    const next = Array.isArray(got) ? got.filter(f => f && f.name && typeof f.text === 'string') : [];
    const changed = JSON.stringify(next) !== JSON.stringify(plumedCache);
    plumedCache = next;
    if (changed && ui.active) update();
  }

  /** The workflow for the current form, computed once per change; null until loaded. */
  function plan() {
    if (ui.planCache) return ui.planCache;
    const w = W();
    const state = readState();
    if (!w || !state) return null;
    try {
      ui.planCache = w.buildLammpsWorkflow(state, {
        data: data.summary(),
        plumed: on('lxUsePlumed') && plumedCache.length ? { files: plumedCache } : null
      });
    } catch (e) {
      ui.planCache = { units: units(), timestep: null, files: [], stages: [], issues: [{ severity: 'error', message: `The workflow could not be built: ${e.message}` }] };
    }
    return ui.planCache;
  }

  /**
   * The stage block of submit.sh, or null while the modules load or the
   * route is the user's own input. LAMMPS may use the wall time less the
   * margin set under Job (TIME_LIMIT; the job can still override it).
   */
  function runBlock(opts) {
    const w = W();
    const wf = plan();
    if (!w || !wf || ui.route !== 'built') return null;
    const wall = walltimeToSeconds(ctx.getStr('jobTime', ''));
    const margin = Math.max(0, num('lxMargin', 10)) * 60;
    const timeLimit = wall && wall > margin ? String(Math.round(wall - margin)) : '';
    return w.lammpsRunBlock(wf, { ...opts, timeLimit });
  }

  /* Checks of every input, with the files each includes read in, once per plan. */
  function checks() {
    const wf = plan();
    if (!wf || !I()) return null;
    if (!ui.checkCache) {
      // The values submit.sh gives a stage's variables on its first run.
      const vars = Object.assign({}, ...Object.values(wf.vars || {}).map(v => (v && v.first) || {}));
      // A stage that reads a restart file has the units of the stage that wrote it.
      ui.checkCache = explainFiles(I(), wf.files, { vars, order: wf.stages.map(x => x.file), restart: { units: wf.units, atomStyle: wf.atomStyle } });
    }
    return ui.checkCache;
  }

  /* ---------------------------------------------------------------- *
   * Updating
   * ---------------------------------------------------------------- */

  function invalidate() {
    ui.planCache = null;
    ui.checkCache = null;
  }

  function update() {
    clearTimeout(ui.timer);
    ui.timer = 0;
    invalidate();
    ctx.regenerate();
  }

  function schedule(delay = 120) {
    clearTimeout(ui.timer);
    ui.timer = setTimeout(update, delay);
  }

  /* ---------------------------------------------------------------- *
   * Choices that set other fields
   * ---------------------------------------------------------------- */

  function fillSelect(id, list, { keep = true } = {}) {
    const sel = $(id);
    if (!sel || !Array.isArray(list)) return;
    const cur = sel.value;
    sel.innerHTML = list.map(o => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
    if (keep && list.some(o => o.id === cur)) sel.value = cur;
  }

  /* Units follow the force field: the labels, the length menus and the
     placeholders say them. */
  function syncUnits() {
    const u = U();
    document.querySelectorAll('#lammpsPanel [data-lx-u]').forEach((el) => {
      const key = el.getAttribute('data-lx-u');
      const t = u.labels[key];
      if (t !== undefined) el.textContent = t;
    });
    for (const k of STAGE_KEYS) {
      if (k === 'min') continue;
      const sel = $(`lx_${k}_unit`);
      if (!sel || sel.dataset.units === units()) continue;
      const opts = lengthOptions(units());
      const cur = sel.value;
      sel.innerHTML = opts.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
      sel.dataset.units = units();
      sel.value = opts.some(o => o.value === cur) ? cur : opts[0].value;
    }
  }

  /* The lengths, temperature and pressure a preset starts from. */
  function presetDefaults(id) {
    const w = W();
    return w ? w.defaultLammpsState(id) : null;
  }

  /*
   * A new force field: what the old one set and the user kept goes over to
   * the new one's values (units, lengths, temperature, the bonds it was
   * parametrised with, where the atoms come from); what the user changed
   * stays. The preset's own options start empty, so they show its defaults.
   */
  function forceFieldChosen() {
    const ff = forceFieldInfo();
    if (!ff) return;
    const before = ui.ffShown ? presetDefaults(ui.ffShown) : null;
    const after = presetDefaults(ff.id);
    const same = (id, v) => String(val(id)) === String(v);
    if (after) {
      if (!before || same('lxTemp', before.temperature)) setValue('lxTemp', String(after.temperature));
      if (!before || same('lxPressure', before.pressure)) setValue('lxPressure', String(after.pressure));
      setValue('lxRigid', after.constraints);
      setValue('lxSource', after.system.source);
      const lat = after.system.lattice;
      if (lat) {
        setValue('lxLattice', lat.style);
        setValue('lxLatticeA', String(lat.constant));
        setValue('lxLatticeN', lat.cells.join(' '));
        setValue('lxElement', lat.element || '');
      }
      // Lengths the user kept at the old preset's values take the new
      // preset's, and all of them do when the units change.
      const unitsChanged = !!before && (forceFieldInfo(ui.ffShown) || {}).units !== ff.units;
      const kept = Object.fromEntries(['nvt', 'npt', 'prod'].map((k) => {
        const b = before && before.stages[k];
        return [k, !b || unitsChanged || (same(`lx_${k}_len`, b.length) && same(`lx_${k}_unit`, b.lengthUnit))];
      }));
      ui.ffShown = ff.id;
      syncUnits();
      for (const k of ['nvt', 'npt', 'prod']) {
        if (!kept[k]) continue;
        setValue(`lx_${k}_len`, String(after.stages[k].length));
        setValue(`lx_${k}_unit`, after.stages[k].lengthUnit);
      }
    }
    for (const [, [id, kind]] of Object.entries(FF_FIELDS)) {
      if (kind === 'bool') setValue(id, !!(ff.options && ff.options[Object.keys(FF_FIELDS).find(k => FF_FIELDS[k][0] === id)]));
      else if (id !== 'lxCustomUnits') setValue(id, '');
    }
    ['lxDt', 'lxTdamp', 'lxPdamp', 'lxBulk', 'lxRestrainK', 'lxBondStyle', 'lxAngleStyle', 'lxDihedralStyle', 'lxImproperStyle', 'lxWaterO', 'lxWaterH']
      .forEach(id => setValue(id, ''));
    ui.ffShown = ff.id;
    syncUnits();
    syncDerived();
    data.forceFieldChanged();
  }

  /* Hidden parts and placeholders that follow the current values; safe to
     run after restoring saved settings. */
  function syncDerived() {
    const source = val('lxSource', 'data');
    if ($('lxSourceData')) $('lxSourceData').hidden = source !== 'data';
    if ($('lxSourceLattice')) $('lxSourceLattice').hidden = source !== 'lattice';
    if ($('lxSourceRestart')) $('lxSourceRestart').hidden = source !== 'restart';
    const ff = forceFieldInfo();
    if (ff) ui.ffShown = ui.ffShown || ff.id;
    // The preset's own options, with its defaults as placeholders.
    const fields = presetFields(ff);
    document.querySelectorAll('#lammpsPanel [data-lx-field]').forEach((el) => {
      el.hidden = !fields.has(el.getAttribute('data-lx-field'));
    });
    if (ff && ff.options) {
      for (const [key, [id, kind]] of Object.entries(FF_FIELDS)) {
        const el = $(id);
        if (!el || kind === 'bool' || el.tagName === 'SELECT') continue;
        const d = ff.options[key];
        el.placeholder = d === undefined || d === '' ? (key === 'cmapFile' ? 'none' : '') : String(d);
      }
      const st = ff.styles || {};
      [['lxBondStyle', 'bond'], ['lxAngleStyle', 'angle'], ['lxDihedralStyle', 'dihedral'], ['lxImproperStyle', 'improper']]
        .forEach(([id, k]) => { if ($(id)) $(id).placeholder = st[k] || 'none'; });
    }
    const cutPanel = $('lxCutPanel');
    if (cutPanel) cutPanel.hidden = !['inner', 'cutoff', 'kspaceAccuracy'].some(k => fields.has(k));
    if ($('lxBulkWrap')) $('lxBulkWrap').hidden = val('lxBarostat') !== 'berendsen';
    ui.route = val('lxRoute', 'built') === 'own' ? 'own' : 'built';
    document.querySelectorAll('[data-lx-route]').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-lx-route') === ui.route)));
    if ($('lxRouteBuilt')) $('lxRouteBuilt').hidden = ui.route !== 'built';
    if ($('lxRouteOwn')) $('lxRouteOwn').hidden = ui.route !== 'own';
    if ($('lxPlumedWrap')) $('lxPlumedWrap').hidden = !on('lxUsePlumed');
    for (const k of STAGE_KEYS) {
      const card = document.querySelector(`.gx-stage[data-lx-stage="${k}"]`);
      if (!card) continue;
      const enabled = on(`lx_${k}_on`);
      card.classList.toggle('is-off', !enabled);
      const body = card.querySelector('[data-lx="body"]');
      if (body) body.hidden = !enabled;
      const fileBtn = card.querySelector('[data-lx-file]');
      if (fileBtn) { fileBtn.hidden = !enabled; fileBtn.setAttribute('aria-label', `Show in.${k}`); }
    }
    if ($('lxUnwrap')) $('lxUnwrap').disabled = val('lxDumpFormat') === 'none';
  }

  /* ---------------------------------------------------------------- *
   * The System view
   * ---------------------------------------------------------------- */

  const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener" class="sg-link">${text}</a>`;
  const note = (text) => `<p>${text}</p>`;
  const codeHtml = (text) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');

  function renderSystem(wf) {
    const ff = forceFieldInfo();
    const hint = $('lxFfHint');
    if (hint) hint.innerHTML = ff ? `${codeHtml(ff.summary || '')}${ff.url ? ` ${link(ff.url, 'Manual')}` : ''}` : '';
    const src = $('lxSourceHint');
    if (src) {
      const s = val('lxSource', 'data');
      src.innerHTML = s === 'data'
        ? 'The atoms, bonds and box from a data file, written by a builder such as moltemplate, CHARMM-GUI, VMD\'s TopoTools or LAMMPS itself (<code>write_data</code>). '
          + link('https://docs.lammps.org/read_data.html', 'read_data')
        : s === 'lattice'
          ? 'A box of the crystal is built in the input with <code>lattice</code>, <code>region</code> and <code>create_atoms</code>: for metals and simple solids. '
            + link('https://docs.lammps.org/lattice.html', 'lattice')
          : 'Carry on from the end of an earlier run: the atoms, velocities and box it saved. '
            + link('https://docs.lammps.org/read_restart.html', 'read_restart');
    }
    renderValues(wf);
    renderCouple(wf);
    renderDt(wf);
    renderCut(wf);
    data.render();
  }

  /* What the force field sets, as the files hold it, with the manual's pages. */
  function renderValues(wf) {
    const host = $('lxFfValues');
    if (!host) return;
    const rows = [];
    const I_ = I();
    const pick = (cmd) => {
      if (!wf || !I_) return null;
      for (const f of wf.files.filter(x => x.kind === 'lammps')) {
        const line = I_.parseInput(f.text).lines.find(l => l.kind === 'command' && l.command === cmd);
        if (line) return line.args.join(' ');
      }
      return null;
    };
    const cmds = ['units', 'atom_style', 'pair_style', 'bond_style', 'angle_style', 'dihedral_style', 'special_bonds', 'kspace_style'];
    for (const c of cmds) {
      const v = pick(c);
      if (v === null) continue;
      const style = v.split(/\s+/)[0];
      const url = I_ ? I_.lammpsDocUrl(c, style) : `https://docs.lammps.org/${c}.html`;
      rows.push([c, v, url]);
    }
    host.innerHTML = rows.length
      ? rows.map(([k, v, u]) => `<div><dt><a href="${esc(u)}" target="_blank" rel="noopener"><code>${esc(k)}</code></a></dt><dd><code>${esc(v)}</code></dd></div>`).join('') +
        '<div class="gx-values-note"><dd>As the files write them; in.settings holds the rest.</dd></div>'
      : '';
  }

  function listFrom(name) {
    return (W() && Array.isArray(W()[name])) ? W()[name] : [];
  }

  function renderCouple(wf) {
    const host = $('lxCoupleNote');
    const th = listFrom('LMP_THERMOSTATS').find(t => t.id === val('lxThermostat'));
    const ba = listFrom('LMP_BAROSTATS').find(b => b.id === val('lxBarostat'));
    const parts = [];
    if (th) parts.push(note(`${codeHtml(th.summary || '')}${th.url ? ` ${link(th.url, 'Manual')}` : ''}`));
    if (ba) parts.push(note(`${codeHtml(ba.summary || '')}${ba.url ? ` ${link(ba.url, 'Manual')}` : ''}`));
    const couple = listFrom('LMP_COUPLINGS').find(c => c.id === val('lxCouple', 'iso'));
    if (couple && couple.id !== 'iso') parts.push(note(codeHtml(couple.summary || '')));
    for (const i of (wf ? wf.issues : []).filter(x => !x.stage && /thermostat|barostat|Tdamp|Pdamp|pressure|temperature|coupl|triclinic/i.test(x.message))) {
      parts.push(`<p class="${i.severity === 'error' ? 'gx-bad' : i.severity === 'warning' ? 'gx-warn' : ''}">${codeHtml(i.message)}</p>`);
    }
    if (host) host.innerHTML = parts.join('');
    // The damping times the files use, in time units and in steps.
    const u = U();
    const steps = (t) => (wf && wf.timestep ? ` = ${formatCount(t / wf.timestep)} steps` : '');
    if ($('lxTdamp')) $('lxTdamp').placeholder = wf && wf.tdamp ? `${wf.tdamp} (automatic)` : 'automatic';
    if ($('lxPdamp')) $('lxPdamp').placeholder = wf && wf.pdamp ? `${wf.pdamp} (automatic)` : 'automatic';
    const vals = $('lxCoupleValues');
    if (vals) {
      const items = [];
      if (wf && wf.tdamp) items.push(['Tdamp', `${wf.tdamp} ${u.labels.time}${steps(wf.tdamp)}`, 'https://docs.lammps.org/fix_nh.html']);
      const npt = wf ? wf.stages.some(x => x.barostat) : false;
      if (wf && wf.pdamp && npt) items.push(['Pdamp', `${wf.pdamp} ${u.labels.time}${steps(wf.pdamp)}`, 'https://docs.lammps.org/fix_nh.html']);
      if (wf && npt) items.push(['coupling', couple ? couple.label : val('lxCouple'), 'https://docs.lammps.org/fix_nh.html']);
      vals.innerHTML = items.map(([k, v, url]) => `<div><dt><a href="${esc(url)}" target="_blank" rel="noopener"><code>${esc(k)}</code></a></dt><dd>${esc(v)}</dd></div>`).join('') +
        (items.length ? '<div class="gx-values-note"><dd>Leave the fields above empty for these; the guide below says why.</dd></div>' : '');
    }
    renderGuide();
  }

  /* The guide under the thermostat and barostat: each choice the workflow
     module offers, in its words, with the manual page. */
  function renderGuide() {
    const host = $('lxGuideBody');
    if (!host || host.dataset.built === '1') return;
    const ths = listFrom('LMP_THERMOSTATS');
    const bas = listFrom('LMP_BAROSTATS');
    if (!ths.length && !bas.length) return;
    const dl = (list) => `<dl class="gx-guide-dl">${list.map(x => `<dt>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}` +
      `${x.recommended ? ' <span class="stk-badge stk-badge-ok">recommended</span>' : ''}${x.productionOk === false ? ' <span class="stk-badge stk-badge-warn">equilibration only</span>' : ''}</dt>` +
      `<dd>${codeHtml(x.guide || x.summary || '')}</dd>`).join('')}</dl>`;
    host.innerHTML = `<h3 class="gx-guide-h">Thermostats</h3>${dl(ths)}<h3 class="gx-guide-h">Barostats</h3>${dl(bas)}
      <h3 class="gx-guide-h">Damping times</h3>
      <p class="gx-guide-p">LAMMPS asks for the damping times in time units: <code>Tdamp</code> for the temperature, <code>Pdamp</code> for the pressure. About 100 time steps for <code>Tdamp</code> and 1000 for <code>Pdamp</code> is the manual's rule of thumb; much shorter and the thermostat fights the dynamics, much longer and the target is reached slowly. The values above are what the files use.</p>
      <h3 class="gx-guide-h">Restraints under pressure</h3>
      <p class="gx-guide-p"><code>fix spring/self</code> ties each atom of a group to where it was when the fix started. Under a barostat those anchors do not move with the box, so hold atoms only while equilibrating, and let production run free.</p>
      <p class="gx-guide-p gx-guide-src">From the LAMMPS manual: ${link('https://docs.lammps.org/fix_nh.html', 'fix nvt, npt and nph')}, ${link('https://docs.lammps.org/Howto_thermostat.html', 'thermostatting')} and ${link('https://docs.lammps.org/Howto_barostat.html', 'barostatting')}.</p>`;
    host.dataset.built = '1';
  }

  function renderDt(wf) {
    const host = $('lxDtNote');
    if (!host) return;
    const parts = [];
    const u = U();
    if (wf && wf.timestep) {
      const dyn = (wf.stages || []).filter(s => s.key !== 'min' && s.steps);
      const longest = dyn.reduce((a, b) => (!a || b.steps > a.steps ? b : a), null);
      parts.push(note(`<code>timestep ${esc(String(wf.timestep))}</code>: ${esc(formatTime(wf.timestep, u))} per step` +
        (longest ? `; ${esc(longest.label.toLowerCase())} of ${esc(longest.time || '')} is ${formatCount(longest.steps)} steps.` : '.')));
    }
    if ($('lxDt')) $('lxDt').placeholder = wf && wf.timestep ? `${wf.timestep} (automatic)` : 'automatic';
    for (const i of (wf ? wf.issues : []).filter(x => /time ?step|shake|rattle|rigid|constrain/i.test(x.message))) {
      parts.push(`<p class="${i.severity === 'error' ? 'gx-bad' : 'gx-warn'}">${codeHtml(i.message)}</p>`);
    }
    host.innerHTML = parts.join('');
  }

  function renderCut(wf) {
    const host = $('lxCutNote');
    if (!host) return;
    const parts = [];
    for (const i of (wf ? wf.issues : []).filter(x => /cut-?off|kspace|pppm|ewald|charge|neighbo/i.test(x.message))) {
      parts.push(`<p class="${i.severity === 'error' ? 'gx-bad' : i.severity === 'warning' ? 'gx-warn' : ''}">${codeHtml(i.message)}</p>`);
    }
    host.innerHTML = parts.join('');
  }

  /* ---------------------------------------------------------------- *
   * The Stages view
   * ---------------------------------------------------------------- */

  function issueLine(i) {
    const s = SEVERITY[i.severity] || SEVERITY.note;
    return `<p class="gx-issue gx-issue-${s.cls}"><i class="fa-solid ${s.icon}" aria-hidden="true"></i><span><span class="sr-only">${s.label}: </span>${codeHtml(i.message)}` +
      `${i.url ? ` ${link(i.url, 'Manual')}` : ''}</span></p>`;
  }

  function stageStatus(st, wf) {
    const f = wf.files.find(x => x.name === st.file);
    return f ? statusOfFile(f, checks()) : null;
  }

  function renderStages(wf) {
    const byKey = new Map((wf ? wf.stages : []).map(s => [s.key, s]));
    for (const k of STAGE_KEYS) {
      const card = document.querySelector(`.gx-stage[data-lx-stage="${k}"]`);
      if (!card) continue;
      const st = byKey.get(k);
      const sum = card.querySelector('[data-lx="sum"]');
      const steps = card.querySelector('[data-lx="steps"]');
      const vel = card.querySelector('[data-lx="vel"]');
      const notes = card.querySelector('[data-lx="notes"]');
      if (!st) {
        if (sum) sum.textContent = on(`lx_${k}_on`) ? '' : 'Off';
        if (notes) notes.innerHTML = '';
        if (steps) steps.textContent = '';
        continue;
      }
      const bits = [];
      if (k === 'min') bits.push(`at most ${formatCount(st.steps || num('lx_min_maxiter', 5000))} iterations`);
      else bits.push(st.time || '', `${formatCount(st.steps)} steps`);
      if (st.ensemble && st.ensemble !== 'min') bits.push(String(st.ensemble).toUpperCase());
      if (st.restrain) bits.push('restrained');
      const status = stageStatus(st, wf);
      if (sum) {
        sum.innerHTML = esc(bits.filter(Boolean).join(' · ')) +
          (status && status.level !== 'ok' ? ` <span class="stk-badge ${SEVERITY[status.level].badge}">${esc(status.badge)}</span>` : '');
      }
      if (steps) steps.textContent = k === 'min' ? '' : `${formatCount(st.steps)} steps of ${formatTime(wf.timestep, U())}`;
      if (vel) vel.textContent = st.velocities || '';
      // The output intervals the stage uses, as placeholders of the fields.
      if (k !== 'min' && st.output) {
        const per = U().timeInPs ? wf.timestep * U().timeInPs : wf.timestep;
        for (const what of ['thermo', 'dump', 'restart']) {
          const el = $(`lx_${k}_${what}`);
          if (el) el.placeholder = st.output[what] ? `${Number((st.output[what] * per).toPrecision(6))}` : '0';
        }
      }
      if (notes) {
        const lines = (wf.issues || []).filter(i => i.stage === k).map(issueLine);
        notes.innerHTML = lines.join('');
      }
    }
    renderGlance(wf);
  }

  function renderGlance(wf) {
    const list = $('lxGlance');
    const totals = $('lxTotals');
    const natoms = Math.round(num('lxAtoms', 0)) || (data.summary() ? data.summary().natoms : 0);
    const stages = wf ? wf.stages : [];
    if (list) {
      list.innerHTML = stages.map((st) => {
        const status = stageStatus(st, wf) || { level: 'ok' };
        const detail = [st.key === 'min' ? `≤ ${formatCount(st.steps)} iterations` : `${formatCount(st.steps)} steps`];
        if (st.ensemble && st.ensemble !== 'min') detail.push(String(st.ensemble).toUpperCase());
        if (st.restrain) detail.push('restrained');
        const bytes = natoms > 0 ? stageBytes(st, natoms) : 0;
        if (bytes) detail.push(`≈ ${formatBytes(bytes)}`);
        const flag = status.level === 'error' ? ` <span class="stk-badge stk-badge-danger">${esc(status.badge)}</span>`
          : status.level === 'warning' ? ` <span class="stk-badge stk-badge-warn">${esc(status.badge)}</span>` : '';
        return `<li class="gx-glance-i gx-st-${status.level}">
          <button type="button" class="gx-glance-b" data-lx-file="${esc(st.key)}">
            <span class="gx-glance-dot" aria-hidden="true"></span>
            <span class="gx-glance-t"><span class="gx-glance-n">${esc(st.label)}${flag}</span><span class="gx-glance-s">${esc(detail.join(' · '))}</span></span>
            <span class="gx-glance-l">${esc(st.key === 'min' ? 'minimise' : (st.time || ''))}</span>
            <span class="sr-only">: show ${esc(st.file)}</span>
          </button>
        </li>`;
      }).join('') || `<li class="gx-glance-empty">${wf ? 'No stage is switched on.' : ui.loading ? 'Loading the LAMMPS builder...' : 'The LAMMPS builder could not be loaded: reload the page.'}</li>`;
    }
    if (totals) {
      const dyn = stages.filter(s => s.key !== 'min');
      const timeUnits = dyn.reduce((a, s) => a + (s.steps || 0) * (wf.timestep || 0), 0);
      const steps = dyn.reduce((a, s) => a + (s.steps || 0), 0);
      const items = [['Simulated', formatTime(timeUnits, U())], ['MD steps', formatCount(steps)]];
      if (natoms > 0) {
        const bytes = stages.reduce((a, s) => a + stageBytes(s, natoms), 0);
        if (bytes) items.push(['Output', `≈ ${formatBytes(bytes)}`]);
      }
      const speed = num('lxSpeed', 0);
      const ps = timeUnits * (U().timeInPs || 0);
      if (speed > 0 && ps > 0) {
        const days = ps / 1000 / speed;
        const hours = days * 24;
        items.push(['Run time', hours < 48 ? `≈ ${Number(hours.toPrecision(3))} h` : `≈ ${Number(days.toPrecision(3))} days`]);
        const wall = walltimeToSeconds(ctx.getStr('jobTime', ''));
        if (wall) items.push(['Wall time', hours * 3600 > wall ? `${Math.ceil(hours * 3600 / wall)} submissions` : 'enough']);
      }
      totals.innerHTML = wf ? items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('') : '';
    }
  }

  /* A stage's output on disk: the workflow's estimate for the data file's
     atoms, or for the count typed under Stages. */
  function stageBytes(st, natoms) {
    const wf = plan();
    if (wf && natoms === wf.natoms && Number.isFinite(st.bytes)) return st.bytes;
    const w = W();
    if (!w || !w.estimateLammpsOutput) return 0;
    try { return w.estimateLammpsOutput(st, natoms, { format: val('lxDumpFormat', 'custom') }).total || 0; } catch (_) { return 0; }
  }

  function renderStepInfo(wf) {
    const info = (step, text, alert) => {
      const b = document.querySelector(`[data-lx-step="${step}"]`);
      if (!b) return;
      const small = b.querySelector('[data-lx-info]');
      if (small) small.textContent = text;
      b.classList.toggle('gx-step-alert', !!alert);
    };
    const ff = forceFieldInfo();
    const issues = wf ? wf.issues || [] : [];
    // 'Metal: EAM (funcfl, one element)' -> 'EAM'
    const short = ff ? (ff.short || ff.label.replace(/^[^:(]*:\s*/, '').replace(/\s*\(.*$/, '').replace(/ with .*$/, '')) : '';
    info('system', short, issues.some(i => !i.stage && i.severity === 'error'));
    const dyn = wf ? wf.stages.filter(s => s.key !== 'min') : [];
    const t = dyn.reduce((a, s) => a + (s.steps || 0) * (wf.timestep || 0), 0);
    info('stages', wf ? (t ? formatTime(t, U()) : `${wf.stages.length} on`) : '',
      !!wf && wf.stages.some(s => { const st = stageStatus(s, wf); return st && st.level === 'error'; }));
    const g = data.groups();
    info('groups', g.length ? `${g.length} group${g.length === 1 ? '' : 's'}` : 'optional', false);
    info('job', ui.route === 'own' ? 'your input' : ctx.schedulerInfo().label, false);
  }

  /* ---------------------------------------------------------------- *
   * Files
   * ---------------------------------------------------------------- */

  /* The README with the page's context: the job, the scheduler, the files. */
  function readmeFile(wf, list) {
    const w = W();
    const given = wf.files.find(f => f.kind === 'md');
    if (!w || !w.lammpsReadme) return given ? given.text : '';
    try {
      return w.lammpsReadme(wf, {
        jobName: ctx.getStr('jobName', ''),
        scheduler: ctx.schedulerInfo().label,
        submit: ctx.schedulerInfo().submit,
        files: list.filter(f => f.kind !== 'md').map(f => ({ name: f.name, note: fileNote(f) }))
      });
    } catch (_) { return given ? given.text : ''; }
  }

  function files() {
    const out = [{ id: 'submit', name: 'submit.sh', kind: 'sh', text: ui.submit, executable: true }];
    const wf = plan();
    if (!wf || ui.route === 'own') return out;
    const stageFiles = new Map((wf.stages || []).map(s => [s.file, s]));
    const inputs = wf.files.filter(f => f.kind !== 'md');
    // The stage inputs in the order they run, then the rest (shared
    // settings, PLUMED), then the README.
    inputs.sort((a, b) => (stageFiles.has(b.name) ? 1 : 0) - (stageFiles.has(a.name) ? 1 : 0));
    for (const f of inputs) {
      const st = stageFiles.get(f.name) || (f.stage ? (wf.stages || []).find(s => s.key === f.stage) : null);
      out.push({ id: f.name, name: f.name, kind: f.kind === 'plumed' ? 'plumed' : 'lammps', text: f.text, notes: f.notes || {}, stage: st || null, executable: !!f.executable });
    }
    out.push({ id: 'README.md', name: 'README.md', kind: 'md', text: '' });
    out[out.length - 1].text = readmeFile(wf, out);
    return out;
  }

  /* What each file is for, for the README's list. */
  function fileNote(f) {
    if (f.kind === 'sh') return `The ${ctx.schedulerInfo().label} job script: every stage in order, skipping finished ones. Submit with \`${ctx.schedulerInfo().submit}\`.`;
    if (f.kind === 'plumed') return f.name === (val('lxPlumedFile', 'plumed.dat') || 'plumed.dat') ? 'The PLUMED input built in the PLUMED tab; fix plumed reads it.' : 'Read by an INCLUDE line of the PLUMED input.';
    if (f.stage) return `${f.stage.label}${f.stage.key !== 'min' ? `, ${f.stage.time}` : ''}${f.stage.restrain ? ', restrained' : ''}.`;
    if (f.name === 'in.system') return 'How the system is made (units, styles, the atoms); the first stage reads it.';
    if (f.name === 'in.settings') return 'What every stage needs once its system is loaded: interactions, neighbour lists, groups, time step.';
    return '';
  }

  function currentFile(list = files()) {
    return list.find(f => f.id === ui.file) || list[0];
  }

  const WHAT = {
    sh: () => (ui.route === 'own'
      ? 'The job script: your input, with the accelerator\'s flags.'
      : 'The job script: every stage in order, skipping those that already finished and carrying on one that was stopped, with the accelerator\'s flags.'),
    md: () => 'What each file is for, the stages, how to restart and how to check the run: goes into the zip.',
    plumed: () => `The PLUMED input built in the PLUMED tab; fix plumed reads it in ${val('lxPlumedScope', 'prod') === 'all' ? 'every dynamics stage' : 'production'}.`
  };

  function subOf(f) {
    if (f.kind === 'sh') return ui.route === 'own' ? 'your input' : ctx.schedulerInfo().label;
    if (f.kind === 'md') return 'notes';
    if (f.kind === 'plumed') return 'PLUMED';
    if (f.stage) return f.stage.key === 'min' ? 'minimise' : (f.stage.time || f.stage.label);
    return 'shared';
  }

  function renderTabs(list) {
    const host = $('lxFileTabs');
    if (!host) return;
    const cur = currentFile(list);
    const ch = checks();
    host.innerHTML = list.map((f) => {
      const st = f.kind === 'lammps' ? statusOfFile(f, ch) : null;
      const icon = st ? `<i class="fa-solid ${st.level === 'ok' ? 'fa-circle-check' : SEVERITY[st.level].icon} gx-ft-st gx-ft-${st.level === 'ok' ? 'ok' : SEVERITY[st.level].cls}" aria-hidden="true"></i>` : '';
      const sel = f.id === cur.id;
      return `<button type="button" role="tab" class="gx-ftab${f.stage ? ' is-stage' : ''}" data-lx-tab="${esc(f.id)}" aria-selected="${sel}" tabindex="${sel ? 0 : -1}" aria-controls="lxCodeWrap"` +
        `${st ? ` title="${esc(st.text)}"` : ''}>` +
        `<span class="gx-ftab-n">${icon}${esc(f.name)}</span><span class="gx-ftab-s">${esc(subOf(f))}${st && st.level !== 'ok' ? `<span class="sr-only">, ${esc(st.text)}</span>` : ''}</span></button>`;
    }).join('');
  }

  function renderFile(list) {
    const f = currentFile(list);
    ui.file = f.id;
    const box = $('lxFilesBox');
    if (box) box.dataset.kind = f.kind;
    const what = $('lxFileWhat');
    if (what) {
      if (f.kind === 'lammps') {
        const st = f.stage;
        what.innerHTML = `${st ? `${esc(st.label)}${st.key !== 'min' ? `: ${esc(st.time || '')}, ${formatCount(st.steps)} steps` : ''}. ` : 'Read by the stage inputs with <code>include</code>. '}` +
          'Click a line, or move along with the arrow keys, for what it does; or choose Explained.';
      } else if (!plan() && f.kind === 'sh' && ui.route === 'built') {
        what.textContent = ui.loading ? 'Loading the LAMMPS builder...' : 'The LAMMPS builder could not be loaded.';
      } else {
        what.innerHTML = WHAT[f.kind] ? WHAT[f.kind]() : '';
      }
    }
    const seg = $('lxModeSeg');
    if (seg) seg.hidden = f.kind !== 'lammps';
    const mode = f.kind === 'lammps' ? ui.mode : 'code';
    seg?.querySelectorAll('[data-lx-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('data-lx-mode') === mode)));
    const code = $('lxCode');
    const wrap = $('lxCodeWrap');
    const ex = $('lxExplain');
    if (wrap) wrap.hidden = mode !== 'code';
    if (ex) ex.hidden = mode !== 'explain';
    if (mode === 'code' && code) {
      const lines = String(f.text || '').replace(/\n$/, '').split('\n');
      const cont = continuationFlags(f);
      code.innerHTML = lines.map((l, i) => `<span class="gx-ln" data-l="${i + 1}">${lineHtml(f.kind, l, esc, ctx.highlightLine, cont[i])}</span>`).join('');
      if (ui.pinned && ui.pinned.file === f.id) {
        const el = code.querySelector(`[data-l="${ui.pinned.line}"]`);
        if (el) el.classList.add('is-pinned');
        else ui.pinned = null;
      }
    }
    if (mode === 'explain' && ex) renderExplained(f, ex);
    if ($('lxCopy')) $('lxCopy').setAttribute('aria-label', `Copy ${f.name}`);
    if ($('lxDownload')) {
      $('lxDownload').setAttribute('aria-label', `Download ${f.name}`);
      $('lxDownload').title = `Download ${f.name}`;
    }
    if (wrap) wrap.setAttribute('aria-label', f.kind === 'lammps' ? `${f.name}; arrow keys choose a line` : `${f.name}`);
    const pinnedRow = ui.pinned && ui.pinned.file === f.id ? rowFor(f, ui.pinned.line) : null;
    renderFoot(f, pinnedRow);
  }

  /* Which physical lines carry on the command above them (after an &). */
  function continuationFlags(f) {
    const lines = String(f.text || '').replace(/\n$/, '').split('\n');
    const out = new Array(lines.length).fill(false);
    if (f.kind !== 'lammps' || !I()) return out;
    for (const l of I().parseInput(f.text).lines) {
      for (let n = l.line + 1; n <= l.lastLine; n++) out[n - 1] = true;
    }
    return out;
  }

  /* The explanation of a physical line of a file: the logical line it
     belongs to, with the builder's note and the checker's issues. */
  function rowFor(f, line) {
    if (!f || f.kind !== 'lammps') return null;
    const ch = checks();
    const rows = ch && ch.rows.get(f.name);
    const row = rows ? rows.find(r => line >= r.line && line <= (r.lastLine || r.line)) : null;
    const noteText = noteFor(f, line, row);
    if (!row) return noteText ? { line, kind: 'comment', note: noteText, issues: [] } : null;
    return { ...row, note: noteText };
  }

  function noteFor(f, line, row) {
    const notes = f.notes || {};
    if (notes[line]) return notes[line];
    if (row) for (let n = row.line; n <= (row.lastLine || row.line); n++) if (notes[n]) return notes[n];
    return '';
  }

  function badge(text, cls = '') { return `<span class="stk-badge ${cls}">${esc(text)}</span>`; }

  function rowTags(r) {
    const tags = [];
    if (r.package) tags.push(badge(r.package));
    if (r.status && r.status !== 'ok') {
      const lvl = r.status === 'error' || r.status === 'unknown' ? 'error' : 'warning';
      tags.push(badge(r.status === 'unknown' ? 'unknown' : SEVERITY[lvl].label.toLowerCase(), SEVERITY[lvl].badge));
    }
    return tags.join('');
  }

  function renderExplained(f, host) {
    const ch = checks();
    const rows = (ch && ch.rows.get(f.name)) || [];
    const html = [];
    for (const r of rows) {
      if (r.kind === 'blank') continue;
      if (r.kind === 'comment') {
        const m = /^[-=\s]*(.+?)[-=\s]*$/.exec(r.comment || '');
        if (m && /^-{2,}|^={2,}/.test(r.comment || '')) html.push(`<li class="gx-xl-h">${esc(m[1])}</li>`);
        continue;
      }
      const issues = r.issues || [];
      const worst = issues.find(i => i.severity === 'error') || issues.find(i => i.severity === 'warning');
      const n = noteFor(f, r.line, r);
      html.push(`<li class="gx-xl-row${worst ? ` gx-xl-${worst.severity}` : ''}">
        <div class="gx-xl-top"><span class="gx-xl-no">${r.line}</span><code class="gx-xl-name">${esc(r.title || r.command || '')}</code>` +
        `<code class="gx-xl-val">${esc(argsText(r))}</code>${rowTags(r)}` +
        `${r.url ? `<a class="gx-xl-link" href="${esc(r.url)}" target="_blank" rel="noopener">Manual<span class="sr-only">: ${esc(r.title || r.command || '')}</span> <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : ''}</div>
        ${r.meaning ? `<p class="gx-xl-mean">${codeHtml(r.meaning)}</p>` : ''}
        ${r.summary && !(r.meaning || '').startsWith(r.summary) ? `<p class="gx-xl-sum">${codeHtml(r.summary)}</p>` : ''}
        ${n ? `<p class="gx-xl-sum lx-xl-note"><span class="lx-note-tag">Why here</span> ${codeHtml(n)}</p>` : ''}
        ${issues.map(issueLine).join('')}
      </li>`);
    }
    host.innerHTML = html.length ? `<ol class="gx-xl">${html.join('')}</ol>` : '<p class="sg-cv-empty">Loading the explanations...</p>';
  }

  /* The words after the command (and after the style, which the title
     already names), as the line has them. */
  function argsText(r) {
    const text = String(r.text || '').replace(/\s*#.*$/, '').trim();
    const words = text.split(/\s+/);
    const skip = (r.title || r.command || '').split(/\s+/).length;
    const shown = words.slice(Math.min(skip, words.length));
    // fix ID group style: the title is 'fix nvt', the ID and group are args.
    if (r.command === 'fix' || r.command === 'compute' || r.command === 'dump') return words.slice(1).join(' ');
    return shown.join(' ');
  }

  function renderFoot(f, row = null) {
    const foot = $('lxFoot');
    if (!foot) return;
    if (row) {
      if (row.kind === 'comment' || row.kind === 'blank') {
        foot.innerHTML = `<span class="gx-foot-line">Line ${ui.pinned ? ui.pinned.line : row.line}</span> ` +
          (row.note ? `<span class="lx-note-tag">Why here</span>${codeHtml(row.note)}` : 'A comment: LAMMPS ignores everything after <code>#</code>.');
        return;
      }
      const issues = row.issues || [];
      foot.innerHTML = `<span class="gx-foot-line">Line ${row.line}${row.lastLine && row.lastLine !== row.line ? `–${row.lastLine}` : ''}</span> ` +
        `<code>${esc(row.title || row.command || '')}</code> ${rowTags(row)} ${codeHtml(row.meaning || row.summary || '')}` +
        `${row.note ? ` <span class="lx-foot-note"><span class="lx-note-tag">Why here</span>${codeHtml(row.note)}</span>` : ''}` +
        `${issues.length ? ` ${issues.map(i => `<span class="gx-${i.severity === 'error' ? 'bad' : i.severity === 'warning' ? 'warn' : 'ok'} lx-foot-issue">${codeHtml(i.message)}</span>`).join(' ')}` : ''} ` +
        `${row.url ? link(row.url, `Manual<span class="sr-only">: ${esc(row.title || row.command || '')}</span>`) : ''}`;
      return;
    }
    if (f.kind === 'lammps') {
      const st = statusOfFile(f, checks());
      const docs = link('https://docs.lammps.org/Commands_all.html', 'Every command in the LAMMPS manual');
      // What applies to the whole file (the packages it needs), from the checker.
      const ch = checks();
      const whole = ((ch && ch.issues.get(f.name)) || []).filter(i => i.id === 'packages');
      foot.innerHTML = (st
        ? `<span class="gx-foot-st gx-ft-${st.level === 'ok' ? 'ok' : SEVERITY[st.level].cls}"><i class="fa-solid ${st.level === 'ok' ? 'fa-circle-check' : SEVERITY[st.level].icon}" aria-hidden="true"></i> ${esc(st.text)}.</span> `
        : '') + `${whole.map(i => codeHtml(i.message)).join(' ')} ${docs}${expectedHtml(f)}`;
    } else if (f.kind === 'sh') {
      foot.innerHTML = ui.submitHint + expectedHtml(f);
    } else if (f.kind === 'plumed') {
      foot.innerHTML = 'Built in the PLUMED tab; <code>fix plumed</code> reads it. PLUMED numbers atoms by their LAMMPS atom IDs.';
    } else {
      foot.innerHTML = 'Goes into the zip with the run files.';
    }
  }

  /* The warnings LAMMPS will print that are expected, and why each is fine:
     with the job script, and with the stage that prints it. */
  function expectedHtml(f) {
    const wf = plan();
    const list = (wf && Array.isArray(wf.expectedWarnings) ? wf.expectedWarnings : [])
      .filter(w => f.kind === 'sh' || !w.stage || (f.stage && f.stage.key === w.stage));
    if (!list.length || (f.kind === 'lammps' && !f.stage)) return '';
    return `<details class="lx-expect"><summary>LAMMPS may print ${list.length === 1 ? 'a warning' : `${list.length} warnings`} that ${list.length === 1 ? 'is' : 'are'} expected</summary>` +
      `<ul>${list.map(w => `<li><code>WARNING: ${esc(w.text)}</code> ${codeHtml(w.why || '')}</li>`).join('')}</ul></details>`;
  }

  function renderFiles() {
    const list = files();
    renderTabs(list);
    renderFile(list);
  }

  function selectFile(id, { focus = false } = {}) {
    ui.file = id;
    ui.pinned = null;
    renderFiles();
    const tab = $('lxFileTabs')?.querySelector(`[data-lx-tab="${CSS.escape(id)}"]`);
    if (focus && tab) tab.focus();
    if (tab && tab.scrollIntoView) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    ctx.scheduleSave();
  }

  /* Show a file from anywhere on the page: a stage key or a file name, and
     a line of it to point at. */
  function showFile(idOrStage, line = 0) {
    const wf = plan();
    let id = idOrStage;
    const st = wf && wf.stages.find(x => x.key === idOrStage);
    if (st) id = st.file;
    showView('files');
    if (ui.mode !== 'code' && line) ui.mode = 'code';
    selectFile(id);
    if (line) pinLine(line, { scroll: true });
    if (window.innerWidth < 1024) $('lxFilesBox')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* Pin a line: its explanation stays in the foot while the file scrolls. */
  function pinLine(line, { scroll = false } = {}) {
    const f = currentFile();
    const code = $('lxCode');
    if (!code) return;
    code.querySelectorAll('.is-pinned').forEach(x => x.classList.remove('is-pinned'));
    if (line === null) {
      ui.pinned = null;
      renderFoot(f);
      return;
    }
    const el = code.querySelector(`[data-l="${line}"]`);
    if (!el) return;
    ui.pinned = { file: f.id, line };
    el.classList.add('is-pinned');
    if (scroll) el.scrollIntoView({ block: 'nearest' });
    const row = rowFor(f, line);
    if (row) renderFoot(f, row);
    else foot(`<span class="gx-foot-line">Line ${line}</span> ${f.kind === 'lammps' ? 'A blank line.' : ''}`);
  }
  const foot = (html) => { if ($('lxFoot')) $('lxFoot').innerHTML = html; };

  /* ---------------------------------------------------------------- *
   * Steps (left) and views (right)
   * ---------------------------------------------------------------- */

  function showStep(step, { focus = false, scroll = false } = {}) {
    if (!STEPS.includes(step)) step = 'system';
    ui.step = step;
    document.querySelectorAll('[data-lx-step]').forEach((b) => {
      const sel = b.getAttribute('data-lx-step') === step;
      b.setAttribute('aria-selected', String(sel));
      b.tabIndex = sel ? 0 : -1;
      if (sel) b.setAttribute('data-stk-state', 'current');
      else b.removeAttribute('data-stk-state');
      if (sel && focus) b.focus();
    });
    document.querySelectorAll('[data-lx-pane]').forEach((p) => { p.hidden = p.getAttribute('data-lx-pane') !== step; });
    ctx.onViewChange();
    if (ui.view === 'files' && step === 'job') selectFile('submit');
    if (scroll) {
      const nav = $('lxSteps');
      if (nav && nav.getBoundingClientRect().top < 0) nav.scrollIntoView({ block: 'start' });
    }
    ctx.scheduleSave();
  }

  function showView(view, { focus = false } = {}) {
    if (!VIEWS.includes(view)) view = 'files';
    ui.view = view;
    document.querySelectorAll('[data-lx-view]').forEach((b) => {
      const sel = b.getAttribute('data-lx-view') === view;
      b.setAttribute('aria-selected', String(sel));
      b.tabIndex = sel ? 0 : -1;
      if (sel && focus) b.focus();
    });
    if ($('lxFilesBox')) $('lxFilesBox').hidden = !ui.active || view !== 'files';
    if ($('lxRefBox')) $('lxRefBox').hidden = !ui.active || view !== 'commands';
    if ($('lxChkBox')) $('lxChkBox').hidden = !ui.active || view !== 'check';
    if (ui.active && view === 'commands') reference.show();
    if (ui.active && view === 'check') check.show();
    ctx.scheduleSave();
  }

  /* Arrow keys move along a row of tabs, as in the ARIA tabs pattern. */
  function arrowTabs(container, attr, activate) {
    if (!container) return;
    container.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const tabs = Array.from(container.querySelectorAll(`[${attr}]`)).filter(t => !t.hidden);
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
        : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activate(tabs[j].getAttribute(attr));
      tabs[j].focus();
    });
  }

  /* ---------------------------------------------------------------- *
   * Rendering everything
   * ---------------------------------------------------------------- */

  /* The Job view: what the accelerator speeds up in these files, and a
     PLUMED coupling with no input to couple. */
  const SUFFIX = { gpu: 'gpu', kokkos: 'kk', intel: 'intel', omp: 'omp', opt: 'opt' };
  function renderJob(wf) {
    const host = $('lxAccelNote');
    if (host) {
      const suffix = SUFFIX[val('lmpAccel', 'none')];
      const api = I();
      if (!suffix || !wf || !api || ui.route !== 'built') host.innerHTML = '';
      else {
        const yes = new Set();
        const no = new Set();
        for (const f of wf.files.filter(x => x.kind === 'lammps')) {
          for (const l of api.parseInput(f.text).lines) {
            if (l.kind !== 'command') continue;
            const pos = { fix: 2, compute: 2 }[l.command];
            const style = pos !== undefined ? l.args[pos] : api.styleKind(l.command) && !/^(atom_style|min_style|run_style)$/.test(l.command) ? l.args[0] : '';
            if (!style || style === 'none') continue;
            const info = api.commandInfo(l.command, style);
            if (!info) continue;
            const key = `${info.command} ${info.base}`;
            if ((info.accelerators || []).includes(suffix)) yes.add(key); else if (info.kind !== 'fix' || /^(nvt|npt|nph|nve|shake|rattle|langevin|temp\/)/.test(info.base)) no.add(key);
          }
        }
        const list = (set) => [...set].map(k => `<code>${esc(k)}</code>`).join(', ');
        host.innerHTML = (yes.size ? `<p>With <code>-sf ${esc(suffix)}</code> these run accelerated: ${list(yes)}.</p>` : `<p>None of the styles these files use has a <code>/${esc(suffix)}</code> variant, so <code>-sf ${esc(suffix)}</code> changes nothing.</p>`) +
          (no.size ? `<p>These run as they are, without a <code>/${esc(suffix)}</code> variant: ${list(no)}.</p>` : '');
      }
    }
    const ph = $('lxPlumedNote');
    if (ph) {
      ph.innerHTML = on('lxUsePlumed') && !plumedCache.length
        ? '<p class="gx-bad">The PLUMED tab has no input yet: add a collective variable there, and <code>fix plumed</code> goes into the files.</p>'
        : on('lxUsePlumed') ? `<p class="gx-ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> ${esc(plumedCache.map(f => f.name).join(', '))} from the PLUMED tab go${plumedCache.length === 1 ? 'es' : ''} into the zip.</p>` : '';
    }
    const rg = $('lxRestrainGroup');
    if (rg) {
      const names = data.groups().map(g => g.name);
      rg.placeholder = names.includes('solute_heavy') ? 'solute_heavy' : data.summary() ? 'from the data file' : 'e.g. type 1:12';
    }
  }

  function render() {
    if (!ui.active) return;
    const wf = plan();
    renderSystem(wf);
    renderJob(wf);
    renderStages(wf);
    renderStepInfo(wf);
    data.renderGroups();
    renderFiles();
    reference.refresh();
    renderLoadState();
  }

  function renderLoadState() {
    const panel = $('lammpsPanel');
    if (panel) panel.classList.toggle('is-loading', !!ui.loading);
  }

  /* ---------------------------------------------------------------- *
   * Copy, download, zip
   * ---------------------------------------------------------------- */

  function copyText(text, btn) {
    const done = () => {
      const label = btn.querySelector('span');
      if (label) {
        label.textContent = 'Copied';
        setTimeout(() => { label.textContent = 'Copy'; }, 1800);
      }
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (_) { showToast('Copy failed. Select the text and copy it by hand.', 'danger'); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(fallback);
    else fallback();
  }

  function zipName() {
    const job = ctx.getStr('jobName', '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return `${job || 'lammps-run'}.zip`;
  }

  async function downloadZip() {
    await refreshPlumed();
    invalidate();
    ctx.regenerate();
    const list = files();
    const ch = checks();
    const stops = list.filter(f => f.kind === 'lammps' && (statusOfFile(f, ch) || {}).level === 'error');
    const zip = buildZip(list.map(f => ({ path: f.name, text: f.text, executable: !!f.executable })));
    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = zipName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const wf = plan();
    const needs = ui.route === 'built' && wf && Array.isArray(wf.needs) ? wf.needs : [];
    const needData = needs.length ? ` Put ${needs.join(', ')} next to them.` : '';
    const addPlumed = on('lxUsePlumed') && !list.some(f => f.kind === 'plumed')
      ? ` Add ${val('lxPlumedFile', 'plumed.dat')}, built in the PLUMED tab: it is not in the zip.` : '';
    showToast(stops.length
      ? `${zipName()}: ${list.length} files. LAMMPS will stop in ${stops.map(f => f.name).join(', ')}; see the file tabs.${addPlumed}`
      : `${zipName()}: ${list.map(f => f.name).join(', ')}.${needData}${addPlumed}`, stops.length || addPlumed ? 'warn' : 'ok');
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  const panel = $('lammpsPanel');
  const REACT = { lxForceField: forceFieldChosen };
  if (panel) {
    panel.addEventListener('change', (e) => {
      if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-nosave')) return;
      const id = e.target && e.target.id;
      if (REACT[id]) REACT[id]();
      else syncDerived();
      if (id === 'lxUsePlumed' && on('lxUsePlumed')) refreshPlumed();
      update();
    });
    panel.addEventListener('input', (e) => {
      const t = e.target;
      if (!t || t.tagName === 'SELECT' || t.type === 'checkbox' || t.hasAttribute('data-nosave')) return;
      schedule();
    });
    panel.addEventListener('click', (e) => {
      const fileBtn = e.target.closest('[data-lx-file]');
      if (fileBtn) { showFile(fileBtn.getAttribute('data-lx-file')); return; }
      const go = e.target.closest('[data-lx-go]');
      if (go) { showStep(go.getAttribute('data-lx-go'), { scroll: true }); return; }
      const route = e.target.closest('[data-lx-route]');
      if (route) {
        setValue('lxRoute', route.getAttribute('data-lx-route'));
        syncDerived();
        update();
        ctx.scheduleSave();
      }
    });
  }

  document.querySelectorAll('[data-lx-step]').forEach((b) => {
    b.addEventListener('click', () => showStep(b.getAttribute('data-lx-step'), { scroll: true }));
  });
  arrowTabs($('lxSteps'), 'data-lx-step', (s) => showStep(s));
  document.querySelectorAll('[data-lx-view]').forEach((b) => {
    b.addEventListener('click', () => showView(b.getAttribute('data-lx-view')));
  });
  arrowTabs($('lxViews'), 'data-lx-view', (v) => showView(v));

  const tabs = $('lxFileTabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lx-tab]');
      if (b) selectFile(b.getAttribute('data-lx-tab'));
    });
    arrowTabs(tabs, 'data-lx-tab', (id) => selectFile(id, { focus: true }));
  }
  $('lxModeSeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lx-mode]');
    if (!b) return;
    ui.mode = b.getAttribute('data-lx-mode');
    renderFile(files());
    ctx.scheduleSave();
  });

  // Point at a line for its meaning; click, or the arrow keys, to keep it.
  const code = $('lxCode');
  const wrap = $('lxCodeWrap');
  if (code) {
    code.addEventListener('mouseover', (e) => {
      const el = e.target.closest('.gx-ln');
      if (!el || ui.pinned) return;
      const f = currentFile();
      const row = rowFor(f, Number(el.getAttribute('data-l')));
      if (row) renderFoot(f, row);
    });
    code.addEventListener('mouseleave', () => { if (!ui.pinned) renderFoot(currentFile()); });
    code.addEventListener('click', (e) => {
      const el = e.target.closest('.gx-ln');
      if (!el) return;
      const f = currentFile();
      if (f.kind !== 'lammps') return;
      const line = Number(el.getAttribute('data-l'));
      pinLine(ui.pinned && ui.pinned.line === line && ui.pinned.file === f.id ? null : line);
    });
  }
  if (wrap) {
    wrap.addEventListener('keydown', (e) => {
      const f = currentFile();
      if (f.kind !== 'lammps') return;
      const count = $('lxCode') ? $('lxCode').querySelectorAll('.gx-ln').length : 0;
      if (!count) return;
      const cur = ui.pinned && ui.pinned.file === f.id ? ui.pinned.line : 0;
      let next = null;
      if (e.key === 'ArrowDown') next = Math.min(count, cur + 1);
      else if (e.key === 'ArrowUp') next = Math.max(1, cur - 1 || 1);
      else if (e.key === 'Home' && e.ctrlKey) next = 1;
      else if (e.key === 'End' && e.ctrlKey) next = count;
      else if (e.key === 'PageDown') next = Math.min(count, cur + 15);
      else if (e.key === 'PageUp') next = Math.max(1, cur - 15);
      else if (e.key === 'Escape' && ui.pinned) { e.preventDefault(); pinLine(null); return; }
      if (next === null) return;
      e.preventDefault();
      pinLine(next, { scroll: true });
    });
  }

  $('lxCopy')?.addEventListener('click', (e) => copyText(currentFile().text, e.currentTarget));
  $('lxDownload')?.addEventListener('click', () => {
    const f = currentFile();
    ctx.downloadText(f.text, f.name);
  });
  $('lxZip')?.addEventListener('click', downloadZip);

  /* ---------------------------------------------------------------- *
   * Sub-modules
   * ---------------------------------------------------------------- */

  const hooks = {
    core: () => ui.core,
    plan,
    files,
    showFile,
    showStep,
    showView,
    currentFileId: () => ui.file,
    checks,
    units,
    changed: () => update(),
    readData: (text) => data.read(text),
    // A data file was read: its atom count goes to the glance, its units
    // are checked against the force field's.
    loadedData(summary) {
      if (summary && summary.natoms) setValue('lxAtoms', String(summary.natoms));
      update();
      ctx.scheduleSave();
    },
    removedData() {
      update();
      ctx.scheduleSave();
    }
  };
  const data = createLammpsData(ctx, hooks);
  const reference = createLammpsReference(ctx, hooks);
  const check = createLammpsCheck(ctx, hooks);

  /* ---------------------------------------------------------------- *
   * Loading
   * ---------------------------------------------------------------- */

  function ensureCore() {
    if (ui.core || ui.loading) return ui.loading || Promise.resolve(ui.core);
    ui.loading = loadLammpsCore().then((core) => {
      ui.core = core;
      ui.loading = null;
      coreArrived();
      return core;
    }).catch(() => { ui.loading = null; return null; });
    renderLoadState();
    return ui.loading;
  }

  /* The modules are in: fill the menus they define, put back saved
     choices, and draw everything. */
  function coreArrived() {
    const w = W();
    if (w) {
      fillFamilies('lxForceField', w.LMP_FORCE_FIELDS || []);
      fillSelect('lxThermostat', w.LMP_THERMOSTATS || []);
      fillSelect('lxBarostat', w.LMP_BAROSTATS || []);
      // A saved choice is put back; one not saved (null) takes the
      // module's default, as does a menu filled for the first time.
      const pend = ui.pending || {};
      let fresh = false;
      ['lxForceField', 'lxThermostat', 'lxBarostat'].forEach((id) => {
        const sel = $(id);
        if (!sel) return;
        const want = pend[id];
        if (want !== undefined && want !== null && Array.from(sel.options).some(o => o.value === String(want))) sel.value = String(want);
        else if (want !== undefined || sel.dataset.defaulted !== '1') {
          defaultChoice(id);
          if (id === 'lxForceField') fresh = true;
        }
      });
      ui.pending = null;
      // A new visit (or a reset) starts from the preset's own values.
      if (fresh) {
        ui.ffShown = null;
        forceFieldChosen();
      } else {
        ui.ffShown = val('lxForceField');
      }
    }
    if (I() && $('lxRelease')) $('lxRelease').textContent = `LAMMPS ${I().LAMMPS_VERSION || ''}`.trim();
    if (I() && $('lxRefVersion')) $('lxRefVersion').textContent = `LAMMPS ${I().LAMMPS_VERSION || ''}`.trim();
    if (ui.core && ui.core.failed.length) {
      showToast(`Part of the LAMMPS builder could not be loaded (${ui.core.failed.join(', ')}); reload the page to try again.`, 'danger');
    }
    syncUnits();
    syncDerived();
    data.coreArrived();
    check.coreArrived();
    update();
  }

  /* The force fields, grouped by family as the presets list them. */
  function fillFamilies(id, list) {
    const sel = $(id);
    if (!sel || !Array.isArray(list)) return;
    const cur = sel.value;
    const families = [];
    for (const f of list) {
      let g = families.find(x => x.name === f.family);
      if (!g) families.push(g = { name: f.family || '', items: [] });
      g.items.push(f);
    }
    sel.innerHTML = families.map(g => `<optgroup label="${esc(g.name)}">${g.items.map(f => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join('')}</optgroup>`).join('');
    if (list.some(o => o.id === cur)) sel.value = cur;
  }

  /* The workflow module's defaults for the menus it fills. */
  function defaultChoice(id) {
    const w = W();
    const sel = $(id);
    if (!w || !sel) return;
    const d = w.defaultLammpsState(id === 'lxForceField' ? undefined : (val('lxForceField') || undefined)) || {};
    const want = id === 'lxForceField' ? d.forceField : id === 'lxThermostat' ? d.thermostat : d.barostat;
    if (want && Array.from(sel.options).some(o => o.value === want)) sel.value = want;
    sel.dataset.defaulted = '1';
  }

  /* ---------------------------------------------------------------- *
   * The page's side
   * ---------------------------------------------------------------- */

  return {
    /** Called by the page when the engine tab changes. */
    enter() {
      ui.active = true;
      if ($('lxSteps')) $('lxSteps').hidden = false;
      if ($('lxViews')) $('lxViews').hidden = false;
      showStep(ui.step);
      showView(ui.view);
      syncDerived();
      ensureCore();
      refreshPlumed();
    },
    leave() {
      ui.active = false;
      if ($('lxSteps')) $('lxSteps').hidden = true;
      if ($('lxViews')) $('lxViews').hidden = true;
      ['lxFilesBox', 'lxRefBox', 'lxChkBox'].forEach(id => { if ($(id)) $(id).hidden = true; });
    },
    step: () => ui.step,
    /** 'built' (the files of this tab) or 'own' (the user's input, by name). */
    route: () => ui.route,
    ready: () => !!W(),
    loading: () => !!ui.loading,
    runBlock,
    plan,
    /** The input files submit.sh runs, for a job array to copy into each task's directory. */
    inputNames: () => { const wf = plan(); return wf ? wf.files.filter(f => f.kind !== 'md').map(f => f.name) : []; },
    setSubmit(text, hint) {
      ui.submit = text;
      ui.submitHint = hint || '';
      render();
    },
    invalidate,
    serialise() {
      return { step: ui.step, view: ui.view, file: ui.file, mode: ui.mode, data: data.serialise() };
    },
    restore(saved, fields = {}) {
      const d = saved && typeof saved === 'object' ? saved : {};
      ui.step = STEPS.includes(d.step) ? d.step : 'system';
      ui.view = VIEWS.includes(d.view) ? d.view : 'files';
      ui.file = typeof d.file === 'string' ? d.file : 'submit';
      ui.mode = d.mode === 'explain' ? 'explain' : 'code';
      // The menus the workflow module fills may still be empty: keep their
      // saved values for when it has loaded.
      ui.pending = {};
      for (const id of ['lxForceField', 'lxThermostat', 'lxBarostat']) {
        const has = Object.prototype.hasOwnProperty.call(fields, id) && fields[id] !== '' && fields[id] !== null;
        ui.pending[id] = has ? String(fields[id]) : null;
        const sel = $(id);
        if (sel && has && Array.from(sel.options).some(o => o.value === ui.pending[id])) sel.value = ui.pending[id];
      }
      // Settings saved before the tab built its own files ran the user's
      // input: keep doing so, so their submit.sh stays what it was.
      if (!Object.prototype.hasOwnProperty.call(fields, 'lxRoute') && Object.prototype.hasOwnProperty.call(fields, 'lmpInput')) {
        setValue('lxRoute', 'own');
      }
      data.restore(d.data);
      invalidate();
      syncDerived();
      if (ui.core) coreArrived();
    }
  };
}
