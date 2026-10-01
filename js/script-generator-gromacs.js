/*
 * STEMKit, MD Workflow Generator: the GROMACS tab.
 * Author: Olanrewaju M. Daramola
 *
 * Four views on the left (System, Stages, Index groups, Job) and three on the
 * right (the run files, every .mdp option, checking a file). The form is read
 * into a plain state object, js/script-generator-gromacs-model.js turns it
 * into one plan per stage (the .mdp text from src/core/gromacs-mdp.js and
 * grompp's verdict on it), and this module shows the result: the files with
 * every line explained, the workflow at a glance, and one zip with all of it.
 *
 * The job script itself is still written by script-generator.js, which owns
 * the scheduler header; it asks this module for the plan and hands the text
 * back through setSubmit().
 */

import {
  explainMdp, optionInfo, mdpDocUrl, FORCE_FIELDS, THERMOSTATS, SYSTEM_TYPES,
  formatDuration, MDP_RELEASE, gromacsVersion, gromacsVersionInfo, versionChanges, DEFAULT_GROMACS_VERSION
} from '../src/core/gromacs-mdp.js';
import { buildZip } from '../src/core/zip.js';
import { walltimeToSeconds } from '../src/core/scheduler.js';
import {
  GX_STAGES, GX_STAGE, resolveWorkflow, estimateOutput, formatBytes, formatCount,
  workflowReadme, parseSchedule, stageLength, barostatLabel, plumedStages
} from './script-generator-gromacs-model.js';
import { createGromacsIndex } from './script-generator-gromacs-index.js';
import { createGromacsOptions, createGromacsCheck } from './script-generator-gromacs-options.js';

const STEPS = ['system', 'stages', 'index', 'job'];
const VIEWS = ['files', 'options', 'check'];

/* Force field of the builder -> force-field files of the topology header, and back. */
const FF_TO_TOP = { amber: 'amber99sb-ildn', charmm36: 'charmm36', gromos54a7: 'gromos54a7', 'opls-aa': 'opls-aa', martini3: 'martini3' };
const TOP_TO_FF = Object.fromEntries(Object.entries(FF_TO_TOP).map(([a, b]) => [b, a]));
const FF_WATER = { amber: 'tip3p', charmm36: 'tip3p', gromos54a7: 'spc', 'opls-aa': 'tip4p' };
const FF_SHORT = { amber: 'AMBER', charmm36: 'CHARMM36', gromos54a7: 'GROMOS', 'opls-aa': 'OPLS-AA', martini3: 'Martini 3' };

const SEVERITY = {
  error: { label: 'Error', badge: 'stk-badge-danger', icon: 'fa-circle-xmark' },
  warning: { label: 'Warning', badge: 'stk-badge-warn', icon: 'fa-triangle-exclamation' },
  note: { label: 'Note', badge: 'stk-badge-accent', icon: 'fa-circle-info' }
};

/**
 * @param {object} ctx - Page helpers from script-generator.js: `$`, `escapeHtml`,
 *   `showToast`, `downloadText`, `scheduleSave`, `highlightLine`, `regenerate()`
 *   (rewrites submit.sh and the topology header), `onTopologyChange()`,
 *   `schedulerInfo()` → `{label, submit, hint}`, `getStr`, `getInt`, `isChecked`,
 *   `onViewChange()`, `plumedFiles()` → names of the files the PLUMED tab wrote
 *   for its INCLUDE lines.
 */
export function createGromacsTab(ctx) {
  const { $, escapeHtml: esc, showToast } = ctx;
  const ui = {
    step: 'system', view: 'files', file: 'submit', mode: 'code',
    overrides: {}, submit: '', submitHint: '', topology: '', planCache: null,
    explainCache: new Map(), pinned: null, timer: 0, active: false,
    // An index built on an earlier visit: {name, file, natoms}. The page
    // keeps the settings that depend on it (the index name, tc-grps) but not
    // the structure it came from, so until that is loaded again the index is
    // missing from the zip, and the page says so.
    lostIndex: null
  };

  /* ---------------------------------------------------------------- *
   * Reading the form
   * ---------------------------------------------------------------- */

  const val = (id, dflt = '') => { const el = $(id); return el ? String(el.value).trim() : dflt; };
  const on = (id) => ctx.isChecked(id);
  const numOr = (id, dflt) => { const v = parseFloat(val(id)); return Number.isFinite(v) ? v : dflt; };
  const lengthPs = (key) => {
    const v = numOr(`stage_${key}_len`, NaN);
    if (!Number.isFinite(v)) return GX_STAGE[key].lengthPs || 0;
    return val(`stage_${key}_unit`, 'ps') === 'ns' ? v * 1000 : v;
  };

  function readState() {
    const stages = {};
    for (const def of GX_STAGES) {
      const k = def.key;
      const st = {
        on: on(`stage_${k}_on`),
        mdp: val(`stage_${k}_mdp`) || def.mdp,
        deffnm: val(`stage_${k}_deffnm`) || def.deffnm,
        posres: on(`stage_${k}_posres`)
      };
      if (def.dynamics) {
        st.lengthPs = lengthPs(k);
        st.velocities = val(`stage_${k}_vel`, 'auto') || 'auto';
        st.output = {
          xtcPs: numOr(`stage_${k}_xtc`, 0), energyPs: numOr(`stage_${k}_edr`, 0),
          logPs: numOr(`stage_${k}_log`, 0), trrPs: numOr(`stage_${k}_trr`, 0)
        };
      }
      stages[k] = st;
    }
    Object.assign(stages.em, { method: val('stage_em_method', 'steep'), emtol: numOr('stage_em_emtol', 1000), emSteps: numOr('stage_em_steps', 50000) });
    stages.prod.ensemble = val('stage_prod_ens', 'NPT');
    Object.assign(stages.anneal, { schedule: val('stage_anneal_sched'), annealType: val('stage_anneal_type', 'single'), pressure: on('stage_anneal_p') });
    Object.assign(stages.pull, {
      ensemble: val('stage_pull_ens', 'NPT'),
      pull: {
        mode: val('stage_pull_mode', 'umbrella'), group1: val('stage_pull_g1'), group2: val('stage_pull_g2'),
        geometry: val('stage_pull_geom', 'distance'), dim: val('stage_pull_dim'), vec: val('stage_pull_vec'),
        k: numOr('stage_pull_k', 1000), rate: numOr('stage_pull_rate', 0.01), outputPs: numOr('stage_pull_pout', 1)
      }
    });
    // With the structure loaded, an atom near the centre of each pull group
    // (pull-groupN-pbcatom): the middle atom by number, which grompp takes
    // otherwise, can sit at the edge of a large group, and a membrane always
    // reaches further than grompp allows from it.
    if (stages.pull.on && index.loaded()) {
      const p = stages.pull.pull;
      p.pbcatom1 = index.centralAtom(p.group1 || 'Protein');
      p.pbcatom2 = index.centralAtom(p.group2 || 'LIG');
    }
    const dtFs = numOr('gxDt', NaN);
    return {
      gromacsVersion: gromacsVersion(val('gxVersion', DEFAULT_GROMACS_VERSION)),
      forceField: val('gxForceField', 'amber'),
      system: val('gxSystem', 'protein'),
      temperature: numOr('gxTemp', 300),
      pressure: numOr('gxPressure', 1),
      thermostat: val('gxThermostat', 'v-rescale'),
      barostat: val('gxBarostat', 'c-rescale'),
      couplingType: val('gxPcouplType', 'isotropic'),
      tcGroups: val('gxTcGrps'),
      constraints: val('gxConstraints', 'h-bonds'),
      hmr: on('gxHmr'),
      dtFs: dtFs > 0 ? dtFs : null,
      stages,
      overrides: ui.overrides,
      hasIndexFile: !!val('gmxIndex'),
      indexLost: lostIndex(),
      index: index.loaded() ? { groups: index.names(), natoms: index.natoms() } : null,
      box: index.box(),
      // The coordinates and groups grompp's pull code works from, for the
      // check of how far apart the pull groups start.
      structure: index.pullStructure()
    };
  }

  /* The index built on an earlier visit, while the scripts still name it
     and no structure has been loaded again; null otherwise. */
  function lostIndex() {
    const l = ui.lostIndex;
    return l && !index.loaded() && val('gmxIndex') === l.name ? l : null;
  }

  /** The workflow for the current form, computed once per change. */
  function plan() {
    if (!ui.planCache) ui.planCache = resolveWorkflow(readState());
    return ui.planCache;
  }

  /** How the job script should call grompp: the index and restarts. */
  function runOptions() {
    const built = index.loaded();
    const name = val('gmxIndex') || (built ? 'index.ndx' : '');
    return { index: name, indexFromFiles: built, resume: on('gxResume'), plumed: plumedOptions() };
  }

  /* -plumed for mdrun, as chosen under Job. The input itself is built in
     the PLUMED tab and is not one of the run files. */
  function plumedOptions() {
    return { on: on('gmxUsePlumed'), file: val('gmxPlumedFile', 'plumed.dat') || 'plumed.dat', scope: val('gmxPlumedScope', 'prod') };
  }

  /* ---------------------------------------------------------------- *
   * Reacting to choices: defaults that follow other fields
   * ---------------------------------------------------------------- */

  function setValue(id, value) {
    const el = $(id);
    if (!el) return;
    if (el.getAttribute('role') === 'switch') el.setAttribute('aria-checked', value ? 'true' : 'false');
    else if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
  }

  /* The force field sets the bonds, the time step's placeholder, whether
     HMR applies, and the topology header's files and water model. */
  function forceFieldChosen() {
    const id = val('gxForceField', 'amber');
    const ff = FORCE_FIELDS[id] || FORCE_FIELDS.amber;
    // The bonds the force field was parametrised with: all of them for
    // GROMOS, those to hydrogen for the others, none for Martini.
    setValue('gxConstraints', ff.constraints);
    if (!ff.hmr) setValue('gxHmr', false);
    const top = FF_TO_TOP[id];
    if (top && $('topForcefield') && $('topForcefield').value !== top) {
      setValue('topForcefield', top);
      if (FF_WATER[id]) setValue('topSolvent', FF_WATER[id]);
      ctx.onTopologyChange();
    }
    syncDerived();
  }

  function topologyChosen() {
    const id = TOP_TO_FF[val('topForcefield')];
    if (id && val('gxForceField') !== id) {
      setValue('gxForceField', id);
      const ff = FORCE_FIELDS[id];
      setValue('gxConstraints', ff.constraints);
      if (!ff.hmr) setValue('gxHmr', false);
      if (FF_WATER[id] && val('topSolvent') !== FF_WATER[id]) {
        setValue('topSolvent', FF_WATER[id]);
        ctx.onTopologyChange();
      }
      syncDerived();
      invalidate();
    }
  }

  /* The system type sets the box scaling, the temperature groups and
     whether the equilibration stages hold the solute. */
  function systemChosen() {
    const id = val('gxSystem', 'protein');
    const sys = SYSTEM_TYPES[id] || SYSTEM_TYPES.protein;
    setValue('gxPcouplType', sys.pcoupltype);
    const rec = index.loaded() ? index.recommendation() : null;
    setValue('gxTcGrps', rec && rec.names.length ? rec.names.join(' ') : sys.tcGroups.join(' '));
    const hold = id !== 'solution';
    setValue('stage_nvt_posres', hold);
    setValue('stage_npt_posres', hold);
    syncDerived();
  }

  /* Conjugate gradient runs after a steepest-descent stage that already
     stops below 1000 kJ/mol/nm, so it needs a lower target to do anything. */
  function emMethodChosen() {
    const cgOn = val('stage_em_method', 'steep') === 'cg';
    const tol = numOr('stage_em_emtol', NaN);
    if (cgOn && tol === 1000) setValue('stage_em_emtol', '100');
    else if (!cgOn && tol === 100) setValue('stage_em_emtol', '1000');
    syncDerived();
  }

  /* The GROMACS release: before 2024 there is no mass-repartition-factor,
     so hydrogen mass repartitioning is switched off (as for Martini). */
  function versionChosen() {
    if (!hmrAvailable() && on('gxHmr')) {
      setValue('gxHmr', false);
      if (numOr('gxDt', NaN) === 4) setValue('gxDt', '');
    }
    syncDerived();
  }

  function chosenVersion() {
    return gromacsVersion(val('gxVersion', DEFAULT_GROMACS_VERSION));
  }

  function hmrAvailable() {
    return Number(chosenVersion()) >= 2024;
  }

  function hmrChosen() {
    if (on('gxHmr')) {
      if (val('gxConstraints') === 'none') setValue('gxConstraints', 'h-bonds');
      const dt = numOr('gxDt', NaN);
      if (dt > 0 && dt !== 4) setValue('gxDt', '');
    } else if (numOr('gxDt', NaN) === 4) {
      setValue('gxDt', '');
    }
    syncDerived();
  }

  /* Enabled and disabled fields, placeholders and hidden parts that follow
     the current values. Safe to run after restoring saved settings. */
  function syncDerived() {
    const ff = FORCE_FIELDS[val('gxForceField', 'amber')] || FORCE_FIELDS.amber;
    const cg = ff.resolution === 'coarse-grained';
    if ($('gxConstraints')) $('gxConstraints').disabled = cg;
    const hmrBtn = $('gxHmr');
    const hmrOk = ff.hmr && hmrAvailable();
    if (hmrBtn) {
      hmrBtn.disabled = !hmrOk;
      hmrBtn.setAttribute('aria-disabled', String(!hmrOk));
    }
    const hmrHint = $('gxHmrHint');
    if (hmrHint) {
      const version = chosenVersion();
      hmrHint.textContent = !hmrAvailable()
        ? `Not with GROMACS ${version}: its grompp has no mass-repartition-factor (new in 2024) and stops on it. For 4 fs, repartition ` +
          'the topology itself (see below) and set the time step to 4 fs, or choose GROMACS 2024 or newer above.'
        : 'Makes hydrogens three times heavier, taking the mass from the atom each is bonded to, so a 4 fs step stays stable. Needs GROMACS 2024 or newer.';
    }
    const auto = on('gxHmr') && ff.hmr ? 4 : (!cg && val('gxConstraints') === 'none' ? 1 : ff.dt * 1000);
    if ($('gxDt')) $('gxDt').placeholder = `${auto} (automatic)`;
    for (const def of GX_STAGES) {
      const card = document.querySelector(`.gx-stage[data-stage="${def.key}"]`);
      if (!card) continue;
      const enabled = on(`stage_${def.key}_on`);
      card.classList.toggle('is-off', !enabled);
      const body = card.querySelector('[data-gx="body"]');
      if (body) body.hidden = !enabled;
      const fname = card.querySelector('[data-gx="fname"]');
      if (fname) fname.textContent = val(`stage_${def.key}_mdp`) || def.mdp;
      const fileBtn = card.querySelector('[data-gx-file]');
      if (fileBtn) {
        fileBtn.hidden = !enabled;
        fileBtn.setAttribute('aria-label', `Show ${val(`stage_${def.key}_mdp`) || def.mdp}`);
      }
    }
    const direction = val('stage_pull_geom') === 'direction';
    const vec = document.querySelector('.gx-stage[data-stage="pull"] [data-gx="vec"]');
    if (vec) vec.hidden = !direction;
    const rate = document.querySelector('.gx-stage[data-stage="pull"] [data-gx="rate"]');
    if (rate) rate.hidden = val('stage_pull_mode') !== 'steered';
  }

  /* ---------------------------------------------------------------- *
   * Updating
   * ---------------------------------------------------------------- */

  function invalidate() {
    ui.planCache = null;
    ui.explainCache.clear();
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
   * The System view: what the choices mean
   * ---------------------------------------------------------------- */

  const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener" class="sg-link">${text}</a>`;

  /* What the chosen release reads differently from the newest, said under
     the choice; the panel's badge names the release. */
  function renderVersion(wf) {
    const version = wf.version;
    const info = gromacsVersionInfo(version);
    const badge = $('gxVersionBadge');
    if (badge) badge.textContent = info.label;
    const host = $('gxVersionHint');
    if (!host) return;
    if (version === DEFAULT_GROMACS_VERSION) {
      host.innerHTML = `Files for the newest release, checked as grompp ${esc(MDP_RELEASE)} reads them. <code>gmx --version</code> says which one a cluster has.`;
      return;
    }
    // The two the builder's files would use first, then the rest by release.
    const changes = versionChanges(version);
    const code = (n) => `<code>${esc(n)}</code>`;
    const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
    const parts = [`Files for GROMACS ${esc(version)}, checked as grompp ${esc(info.release)} reads them.`];
    if (Number(version) < 2024) {
      parts.push(`No hydrogen mass repartitioning (${code('mass-repartition-factor')} is new in 2024), and Martini files fix ` +
        `${code('rlist')} without ${code('verlet-buffer-pressure-tolerance')} (2024).`);
    }
    const shown = new Set(['mass-repartition-factor', 'verlet-buffer-pressure-tolerance']);
    const bySince = new Map();
    for (const c of changes.filter(x => x.change === 'added' && !shown.has(x.option))) {
      const name = /^colvars/.test(c.option) ? 'Colvars' : /^nnpot/.test(c.option) ? 'neural-network potentials'
        : /^awh1/.test(c.option) ? 'the AWH growth options' : code(c.option);
      if (!bySince.has(c.since)) bySince.set(c.since, []);
      if (!bySince.get(c.since).includes(name)) bySince.get(c.since).push(name);
    }
    if (bySince.size) parts.push(`Also new after ${esc(version)}: ${[...bySince].map(([y, names]) => `${list(names)} (${esc(y)})`).join('; ')}.`);
    const defaults = changes.filter(x => x.change === 'default');
    if (defaults.length) {
      parts.push(`Its defaults: ${list(defaults.map(c => `${code(c.option)} ${esc(c.before)}${c.option === 'tau-p' ? ' ps' : ''} (changed in ${esc(c.since)})`))}.`);
    }
    host.innerHTML = parts.join(' ');
  }

  function renderSystem(wf) {
    renderVersion(wf);
    const ff = wf.forceField;
    const cg = ff.resolution === 'coarse-grained';
    const ffHint = $('gxFfHint');
    if (ffHint) {
      const ref = ff.references[0];
      const rigid = ff.constraints === 'all-bonds' ? 'all bonds rigid' : 'the bonds to hydrogen rigid';
      ffHint.innerHTML = `${esc(ff.why.cutoff)}. ${esc(ff.why.dispCorr)}. ` +
        `${cg ? '20 fs time step, no constraints' : `${ff.dt * 1000} fs with ${rigid}`}; water: ${esc(ff.water)}. ` +
        (ref ? link(ref.url, esc(ref.text)) : '');
    }
    const sysHint = $('gxSystemHint');
    if (sysHint) {
      const id = wf.system;
      sysHint.innerHTML = id === 'membrane'
        ? 'The membrane plane (x/y) and its normal (z) scale separately. CHARMM-GUI\'s index file names the temperature groups <code>SOLU MEMB SOLV</code>, ' +
          'with <code>SOLU</code> only when the system has a solute: for a bilayer of lipids alone, use <code>MEMB SOLV</code>. Load your structure under Index groups for groups of your own.'
        : id === 'solution'
          ? 'One temperature group for the whole system and no position restraints: a liquid has no solute to hold, and grompp warns about a <code>-DPOSRES</code> the topology never uses.'
          : 'The solute is held while the solvent relaxes, then released; solute and solvent get a temperature group each.';
    }
    renderTcHint(wf);
    renderCouple(wf);
    renderDt(wf);
  }

  function renderTcHint(wf) {
    const host = $('gxTcHint');
    if (!host) return;
    const parts = [];
    if (index.loaded()) {
      const rec = index.recommendation();
      const current = wf.tcGroups.join(' ');
      if (rec && rec.names.length && rec.names.join(' ').toLowerCase() !== current.toLowerCase()) {
        parts.push(`<p class="stk-hint">For your structure: <code>${esc(rec.names.join(' '))}</code>. ${esc(rec.reason)} ` +
          '<button type="button" class="stk-btn stk-btn-sm gx-inline-btn" data-gx-act="use-tc">Use it</button></p>');
      }
      const cov = index.coverage(wf.tcGroups);
      if (cov) {
        parts.push(cov.ok
          ? `<p class="gx-ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Every one of the ${formatCount(index.natoms())} atoms is in exactly one of these groups.</p>`
          : cov.errors.map(e => `<p class="gx-bad"><i class="fa-solid fa-circle-xmark" aria-hidden="true"></i> ${esc(e)}</p>`).join(''));
      }
    } else {
      parts.push('<p class="stk-hint">Every atom must be in exactly one group. <code>Protein</code> and <code>Non-Protein</code> are groups GROMACS makes itself; ' +
        'any other name needs an index file, which Index groups builds from your structure.</p>');
      // CHARMM-GUI writes SOLU only when there is a solute (a protein, a
      // peptide, a ligand); its index for a bilayer alone has MEMB and SOLV.
      if (wf.tcGroups.some(g => g.toUpperCase() === 'SOLU')) {
        parts.push('<p class="stk-hint">CHARMM-GUI\'s index file has a <code>SOLU</code> group only when the system has a solute: ' +
          'for a bilayer of lipids alone, grompp stops on <code>SOLU</code>, so use <code>MEMB SOLV</code>.</p>');
      }
    }
    // A name no index defines, or an index lost with the structure it came
    // from: grompp stops on it, so it is said where tc-grps is chosen.
    if (wf.indexWarning) parts.push(`<p class="gx-bad"><i class="fa-solid fa-circle-xmark" aria-hidden="true"></i> ${esc(wf.indexWarning)}</p>`);
    host.innerHTML = parts.join('');
  }

  function renderCouple(wf) {
    const host = $('gxCoupleNote');
    const vals = $('gxCoupleValues');
    const ff = wf.forceField;
    const th = val('gxThermostat', 'v-rescale');
    const ba = val('gxBarostat', 'c-rescale');
    const type = val('gxPcouplType', 'isotropic');
    const notes = [];
    if (th === 'v-rescale') notes.push('V-rescale gives the correct canonical ensemble and is stable from the first step: the one to use unless you have a reason.');
    if (th === 'nose-hoover') notes.push('Nose-Hoover oscillates when the temperature starts away from the target; the equilibration stages still settle it, and production then samples the right ensemble without random numbers.');
    if (th === 'berendsen') notes.push('Berendsen gives the wrong kinetic-energy distribution; grompp warns, so submit.sh adds <code>-maxwarn</code>.');
    if (ba === 'c-rescale') notes.push(type === 'anisotropic'
      ? `C-rescale cannot scale the box anisotropically in GROMACS ${wf.version}, so every stage with a barostat uses Parrinello-Rahman.`
      : 'C-rescale in every stage with a barostat: stable while equilibrating and correct in production.');
    if (ba === 'parrinello-rahman') notes.push('Parrinello-Rahman in production; NPT equilibration uses C-rescale, because Parrinello-Rahman oscillates when the box is far from equilibrium' +
      `${type === 'anisotropic' ? ' (except with anisotropic scaling, which C-rescale cannot do)' : ''}.`);
    if (ba === 'berendsen') notes.push('Berendsen gives the wrong volume fluctuations; grompp warns, so submit.sh adds <code>-maxwarn</code>. It is kept in every stage with a barostat, NPT equilibration included.');
    if (type === 'semiisotropic') notes.push('Semi-isotropic: two values each for <code>ref-p</code> and <code>compressibility</code>, the membrane plane (x/y) first, then z.');
    if (type === 'anisotropic') {
      notes.push('Anisotropic: six values each (xx yy zz xy xz yz). The off-diagonal compressibilities are 0, so the box angles cannot change: ' +
        '<strong>the box must be rectangular</strong>. A rhombic dodecahedron or any other triclinic box (<code>editconf -bt dodecahedron</code>, ' +
        'the usual protein box) becomes too skewed as it shrinks, and mdrun stops ("Triclinic box is too skewed").');
    }
    if (wf.system === 'membrane' && type !== 'semiisotropic') notes.push('A membrane is normally coupled semi-isotropically, so the area per lipid can relax on its own.');
    // With a structure loaded its box is known: a triclinic one under
    // anisotropic coupling is said here, where the coupling is chosen.
    const skewed = wf.warnings.find(w => /too skewed/.test(w));
    if (host) host.innerHTML = notes.map(n => `<p>${n}</p>`).join('') + (skewed ? `<p class="gx-bad">${esc(skewed)}</p>` : '');
    if (vals) {
      // The values the files hold, read from them: the force field's
      // conventions (Martini's are longer), after any option set by hand.
      const first = (key) => wf.stages.find(p => p.key === key);
      // The first value of an option as a plain number: "4.0 4.0" -> "4".
      const first1 = (x) => {
        const w = String(x ?? '').trim().split(/\s+/)[0];
        return w && Number.isFinite(Number(w)) ? String(Number(w)) : w;
      };
      const tau = (p) => (p && p.checked ? first1(p.checked['tau-p']) : '');
      const dyn = wf.stages.find(p => p.dynamics && p.checked && p.checked['tau-t'] !== undefined);
      const T = dyn ? first1(dyn.checked['tau-t']) : (ff.tauT[th] ?? ff.tauT['v-rescale']);
      const nptP = first('npt');
      const prodP = first('prod');
      const tauEq = nptP && nptP.barostat !== 'none' ? tau(nptP) : '';
      const tauProd = prodP && prodP.barostat !== 'none' ? tau(prodP) : '';
      const pr = ba === 'parrinello-rahman' || type === 'anisotropic';
      const fallback = ff.tauP[pr ? 'parrinello-rahman' : ba] ?? ff.tauP['c-rescale'];
      const tauText = tauEq && tauProd && tauEq !== tauProd ? `${tauEq} ps (NPT, ${barostatLabel(nptP)}), ${tauProd} ps (production, ${barostatLabel(prodP)})`
        : `${tauEq || tauProd || fallback} ps`;
      const items = [
        ['tau-t', `${T} ps`, mdpDocUrl('tau-t')],
        ['tau-p', tauText, mdpDocUrl('tau-p')],
        ['compressibility', `${ff.compressibility} bar⁻¹`, mdpDocUrl('compressibility')],
        ['refcoord-scaling', 'com, in restrained stages with a barostat', mdpDocUrl('refcoord-scaling', 'com')]
      ];
      vals.innerHTML = items.map(([k, v, u]) => `<div><dt><a href="${esc(u)}" target="_blank" rel="noopener"><code>${esc(k)}</code></a></dt><dd>${esc(v)}</dd></div>`).join('') +
        '<div class="gx-values-note"><dd>From the force field\'s conventions; change any of them under All options.</dd></div>';
    }
  }

  function renderDt(wf) {
    const host = $('gxDtNote');
    if (!host) return;
    const parts = [];
    const dyn = wf.stages.filter(p => p.dynamics);
    const dt = wf.dt;
    const limited = dyn.filter(p => !p.unlimited);
    if (limited.length) {
      const longest = limited.reduce((a, b) => (b.lengthPs > a.lengthPs ? b : a));
      parts.push(`<p>dt = ${Number((dt * 1000).toPrecision(6))} fs: ${esc(longest.label.toLowerCase())} of ${esc(formatDuration(longest.lengthPs))} is ${formatCount(longest.nsteps)} steps.</p>`);
    }
    if (wf.hmr) {
      parts.push(`<p><code>mass-repartition-factor = 3</code> goes into every dynamics stage. ${link(mdpDocUrl('mass-repartition-factor'), 'Manual')}</p>`);
      // The note needs bonds between heavy atoms that are not constrained:
      // a protein has them, a box of water and ions does not.
      if (wf.constraints === 'h-bonds') {
        parts.push(wf.system === 'solution'
          ? '<p>If the liquid\'s molecules have bonds between heavy atoms (C=O, C-C), grompp will note that they oscillate in fewer than ten 4 fs steps: expected with repartitioned hydrogens and only the bonds to hydrogen rigid. Water and ions have none, so it says nothing for them.</p>'
          : '<p>grompp will note that bonds such as C=O oscillate in fewer than ten 4 fs steps: expected with repartitioned hydrogens and only the bonds to hydrogen rigid.</p>');
      }
    }
    for (const w of wf.warnings.filter(x => /time step|repartition|flexible/i.test(x))) parts.push(`<p class="gx-bad">${esc(w)}</p>`);
    const ownDt = wf.stages.find(p => p.warnings.some(x => /dt = /.test(x)));
    if (ownDt) parts.push(`<p class="gx-bad">${esc(ownDt.warnings.find(x => /dt = /.test(x)))}</p>`);
    host.innerHTML = parts.join('');
  }

  /* ---------------------------------------------------------------- *
   * The Stages view
   * ---------------------------------------------------------------- */

  function issueLine(i) {
    const s = SEVERITY[i.severity] || SEVERITY.note;
    const where = i.source === 'mdrun' ? ' (mdrun)' : i.source === 'advice' ? ' (advice)' : '';
    // The pull checks measure the structure loaded under Index groups, which
    // is not what grompp reads for a later stage: say what they went by.
    const assumed = i.assumes && /^pull-/.test(i.id) ? ` <span class="gx-opt-note">Assumed: ${esc(i.assumes)}.</span>` : '';
    return `<p class="gx-issue gx-issue-${i.severity}"><i class="fa-solid ${s.icon}" aria-hidden="true"></i><span><span class="sr-only">${s.label}${where}: </span>${esc(i.message)}` +
      `${i.url ? ` ${link(i.url, `<code>${esc(i.option || 'Manual')}</code>`)}` : ''}${assumed}</span></p>`;
  }

  function renderStages(wf) {
    const byKey = new Map(wf.stages.map(p => [p.key, p]));
    let prevDyn = false;
    for (const def of GX_STAGES) {
      const card = document.querySelector(`.gx-stage[data-stage="${def.key}"]`);
      if (!card) continue;
      const p = byKey.get(def.key);
      const sum = card.querySelector('[data-gx="sum"]');
      const steps = card.querySelector('[data-gx="steps"]');
      const vel = card.querySelector('[data-gx="vel"]');
      const notes = card.querySelector('[data-gx="notes"]');
      if (!p) {
        if (sum) sum.textContent = 'Off';
        if (notes) notes.innerHTML = '';
        continue;
      }
      const bits = [];
      const pre = def.key === 'em' ? byKey.get('em-steep') : null;
      if (p.dynamics) bits.push(stageLength(p), p.unlimited ? 'nsteps = -1' : `${formatCount(p.nsteps)} steps`);
      else bits.push(pre ? `steepest descent, then conjugate gradient, each at most ${formatCount(p.nsteps)} steps` : p.nsteps < 0 ? 'no step limit' : `at most ${formatCount(p.nsteps)} steps`);
      if (p.restrained || p.posres) bits.push('restrained');
      if (barostatLabel(p)) bits.push(barostatLabel(p));
      else if (p.dynamics) bits.push('NVT');
      const st = statusOf({ kind: 'mdp', plan: p });
      const stPre = pre ? statusOf({ kind: 'mdp', plan: pre }) : null;
      const worst = [stPre, st].find(x => x && x.level === 'error') || [stPre, st].find(x => x && x.level === 'warning');
      if (sum) {
        sum.innerHTML = esc(bits.join(' · ')) +
          (worst ? ` <span class="stk-badge ${worst.level === 'error' ? 'stk-badge-danger' : 'stk-badge-warn'}">${esc(worst.badge)}</span>` : '');
      }
      if (steps) steps.textContent = p.dynamics ? (p.unlimited ? 'nsteps = -1: runs until stopped' : `${formatCount(p.nsteps)} steps of ${Number((p.dt * 1000).toPrecision(6))} fs`) : '';
      if (vel) {
        vel.textContent = !p.dynamics ? ''
          : p.genVel ? `New velocities at ${p.settings.temperature} K${p.velocitiesAuto ? ': the first dynamics stage' : ''}.`
            : p.fromPrevious ? 'Carried over from the previous stage\'s checkpoint (grompp -t).'
              : 'Read from the start coordinates, which must hold velocities.';
      }
      const lines = [];
      const note = (text) => `<p class="gx-issue gx-issue-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>${text}</span></p>`;
      const warnLine = (text) => `<p class="gx-issue gx-issue-warning"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>${esc(text)}</span></p>`;
      if (pre) {
        lines.push(note(`Steepest descent runs first (<code>${esc(pre.file)}</code>, to <code>${esc(pre.deffnm)}.gro</code>) to relieve the clashes, ` +
          'where conjugate gradient is slow; conjugate gradient then runs with flexible water (<code>define = -DFLEXIBLE</code>), ' +
          'because GROMACS cannot use SETTLE in it: with rigid water mdrun stops with "The coordinates could not be constrained".'));
        for (const i of pre.issues.filter(x => x.severity !== 'note' && x.source !== 'advice')) lines.push(issueLine(i));
      }
      // A deprecated method is reported by the checker too, with grompp's words.
      const gromppSays = p.issues.filter(i => i.source === 'grompp').map(i => i.message).join(' ');
      for (const w of p.warnings.filter(x => !(/\(deprecated\)/.test(x) && /Berendsen/.test(gromppSays)))) lines.push(warnLine(w));
      for (const i of p.issues.filter(x => x.severity !== 'note' && x.source !== 'advice')) lines.push(issueLine(i));
      if (!p.errors.length && p.needsIndexMessage) lines.push(warnLine(p.needsIndexMessage));
      if (p.barostatNote) lines.push(note(esc(p.barostatNote)));
      if (def.key === 'pull') {
        // The reference atoms for periodic images: the page's, from the
        // loaded structure, while the file still has them.
        const v = p.checked || {};
        const ours = [1, 2].filter(n => p.pbcAtoms && p.pbcAtoms[n - 1] > 0 && Number(v[`pull-group${n}-pbcatom`]) === p.pbcAtoms[n - 1]);
        if (ours.length) {
          const one = ours.length === 1;
          lines.push(note(`${one ? 'An atom near the centre of the group' : 'Atoms near the centre of each group'} in ${esc(index.fileName())}: ` +
            `${ours.map(n => `<code>pull-group${n}-pbcatom = ${p.pbcAtoms[n - 1]}</code> (${esc(v[`pull-group${n}-name`] || '')})`).join(', ')}. ` +
            `grompp takes ${one ? 'the group\'s periodic images from it' : 'each group\'s periodic images from its atom'}, and ` +
            `<code>pull-pbc-ref-prev-step-com = yes</code> then follows ${one ? 'its' : 'each group\'s'} centre of mass.`));
        } else if (!index.loaded() && p.warnings.some(w => /quarter of the box/.test(w))) {
          lines.push(note('Load the structure under Index groups and the page puts an atom near the centre of each group in the file.'));
        }
      }
      if (def.key === 'anneal') {
        const sched = parseSchedule(val('stage_anneal_sched'));
        const hint = card.querySelector('[data-gx="sched"]');
        if (hint) {
          // annealing = periodic starts the schedule over once its last
          // time is reached (mdp-options.rst); single holds the last value.
          const after = val('stage_anneal_type', 'single') === 'periodic'
            ? 'and the schedule starts over from the first point once the last time is reached'
            : 'and holds after the last';
          hint.textContent = sched.errors.length ? sched.errors[0]
            : `${sched.points.length} points, ${sched.points[0] ? sched.points[0][1] : '?'} K to ${sched.points.length ? sched.points[sched.points.length - 1][1] : '?'} K; the temperature changes linearly between them ${after}.`;
          hint.classList.toggle('sg-hint-bad', !!sched.errors.length);
        }
      }
      if (notes) notes.innerHTML = lines.join('');
      prevDyn = prevDyn || def.dynamics;
    }
    renderGlance(wf);
  }

  function renderGlance(wf) {
    const list = $('gxGlance');
    const totals = $('gxTotals');
    const natoms = Math.round(numOr('gxAtoms', 0));
    if (list) {
      list.innerHTML = wf.stages.map((p) => {
        const e = natoms > 0 ? estimateOutput(p, natoms) : null;
        const st = statusOf({ kind: 'mdp', plan: p });
        const status = st.level;
        const detail = [p.nsteps < 0 ? 'no step limit' : p.dynamics ? `${formatCount(p.nsteps)} steps` : `≤ ${formatCount(p.nsteps)} steps`];
        if (e && p.dynamics && e.frames.xtc) detail.push(`${formatCount(e.frames.xtc)} frames`);
        if (e && !e.unknown) detail.push(`≈ ${formatBytes(e.total)}`);
        if (p.restrained || p.posres) detail.push('restrained');
        const flag = status === 'error' ? ` <span class="stk-badge stk-badge-danger">${esc(st.badge)}</span>`
          : status === 'warning' ? ` <span class="stk-badge stk-badge-warn">${esc(st.badge)}</span>` : '';
        return `<li class="gx-glance-i gx-st-${status}">
          <button type="button" class="gx-glance-b" data-gx-file="${esc(p.key)}">
            <span class="gx-glance-dot" aria-hidden="true"></span>
            <span class="gx-glance-t"><span class="gx-glance-n">${esc(p.label)}${flag}</span><span class="gx-glance-s">${esc(detail.join(' · '))}</span></span>
            <span class="gx-glance-l">${esc(stageLength(p))}</span>
            <span class="sr-only">: show ${esc(p.file)}</span>
          </button>
        </li>`;
      }).join('') || '<li class="gx-glance-empty">No stage is switched on.</li>';
    }
    if (totals) {
      // Totals of what the files will run; a stage with nsteps = -1 runs
      // until stopped, so it has none.
      const dyn = wf.stages.filter(p => p.dynamics);
      const open = dyn.some(p => p.unlimited);
      const ps = dyn.filter(p => !p.unlimited).reduce((a, p) => a + p.lengthPs, 0);
      const steps = dyn.filter(p => !p.unlimited).reduce((a, p) => a + p.nsteps, 0);
      const items = [['Simulated', open ? 'no limit' : formatDuration(ps)], ['MD steps', open ? 'no limit' : formatCount(steps)]];
      if (natoms > 0 && !open) {
        const bytes = wf.stages.reduce((a, p) => a + estimateOutput(p, natoms).total, 0);
        items.push(['Output', `≈ ${formatBytes(bytes)}`]);
      }
      const speed = numOr('gxSpeed', 0);
      if (speed > 0 && ps > 0 && !open) {
        const days = ps / 1000 / speed;
        const hours = days * 24;
        items.push(['Run time', hours < 48 ? `≈ ${Number(hours.toPrecision(3))} h` : `≈ ${Number(days.toPrecision(3))} days`]);
        const wall = walltimeToSeconds(ctx.getStr('jobTime', ''));
        if (wall) {
          const need = hours * 3600;
          items.push(['Wall time', need > wall ? `${Math.ceil(need / wall)} submissions` : 'enough']);
        }
      }
      totals.innerHTML = items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    }
  }

  /* ---------------------------------------------------------------- *
   * Files
   * ---------------------------------------------------------------- */

  const WHAT = {
    submit: () => `The job script: grompp and mdrun for each stage, in order${on('gxResume') ? ', skipping those that already finished' : ''}.`,
    top: () => 'The top of topol.top: the force field, water and ion includes. Add your molecules and their counts, or keep the topology pdb2gmx wrote.',
    index: () => `The groups the .mdp files name (tc-grps, pull groups), numbered as grompp numbers the atoms; submit.sh passes it with -n.`,
    readme: () => 'What each file is for, the stages, what grompp will say and how to restart: goes into the zip.'
  };

  /* The PLUMED tab's input and the files its INCLUDE lines read, as it last
     built them. It is read when this tab is entered and again before a zip
     is made: the PLUMED tab cannot change while this one is showing. */
  let plumedCache = [];
  async function refreshPlumed() {
    if (!ctx.plumedInput) return;
    let got = [];
    try { got = await ctx.plumedInput(plumedOptions().file); } catch (_) { got = []; }
    const next = Array.isArray(got) ? got.filter(f => f && f.name && typeof f.text === 'string') : [];
    const changed = JSON.stringify(next) !== JSON.stringify(plumedCache);
    plumedCache = next;
    if (changed && ui.active) render();
  }

  function files() {
    const wf = plan();
    const out = [{ id: 'submit', name: 'submit.sh', kind: 'sh', text: ui.submit, executable: true }];
    for (const p of wf.stages) out.push({ id: p.key, name: p.file, kind: 'mdp', text: p.text, plan: p });
    if (index.loaded()) out.push({ id: 'index', name: runOptions().index || 'index.ndx', kind: 'ndx', text: index.ndxText() });
    // Carried only when a stage runs with -plumed; a name the zip already
    // holds is not overwritten.
    const plumedIn = plumedStages(wf.stages, plumedOptions()).length ? plumedCache : [];
    const taken = new Set(out.map(f => f.name));
    plumedIn.forEach((f, i) => {
      if (!taken.has(f.name)) out.push({ id: `plumed-${i}`, name: f.name, kind: 'plumed', text: f.text, main: i === 0 });
    });
    out.push({ id: 'top', name: val('gmxTopol', 'topol.top') || 'topol.top', kind: 'top', text: ui.topology, zip: false });
    out.push({ id: 'readme', name: 'README.md', kind: 'md', text: '' });
    const readme = out[out.length - 1];
    readme.text = workflowReadme(wf, {
      jobName: ctx.getStr('jobName', ''),
      scheduler: ctx.schedulerInfo().label,
      submit: ctx.schedulerInfo().submit,
      startConf: val('gmxStartConf', 'system.gro'),
      topol: val('gmxTopol', 'topol.top'),
      index: runOptions().index,
      indexBuilt: index.loaded(),
      indexLost: lostIndex(),
      resume: on('gxResume'),
      array: on('jobArrayToggle'),
      plumed: {
        ...plumedOptions(),
        includes: ctx.plumedFiles ? ctx.plumedFiles() : [],
        inZip: out.filter(f => f.kind === 'plumed').map(f => f.name),
        text: (out.find(f => f.kind === 'plumed' && f.main) || {}).text || ''
      },
      natoms: Math.round(numOr('gxAtoms', 0)),
      files: out.filter(f => f.zip !== false).map(f => ({ name: f.name, note: fileNote(f) }))
    });
    return out;
  }

  function fileNote(f) {
    if (f.kind === 'sh') return `The ${ctx.schedulerInfo().label} job script: grompp and mdrun for every stage, in order. Submit with \`${ctx.schedulerInfo().submit}\`.`;
    if (f.kind === 'mdp') {
      const p = f.plan;
      return `${p.label}${p.dynamics ? `, ${stageLength(p)}` : ''}${p.restrained || p.posres ? ', solute restrained' : ''}.`;
    }
    if (f.kind === 'ndx') return 'Index groups built from your structure; read by grompp with -n.';
    if (f.kind === 'plumed') {
      return f.main ? 'The PLUMED input built in the PLUMED tab; mdrun reads it with -plumed.'
        : `Read by an INCLUDE line of ${plumedOptions().file}; written by the PLUMED tab.`;
    }
    if (f.kind === 'md') return 'This file.';
    return '';
  }

  function currentFile(list = files()) {
    return list.find(f => f.id === ui.file) || list[0];
  }

  /* One line of an .mdp file, coloured: name, value, comment. */
  function mdpLineHtml(line) {
    const semi = line.indexOf(';');
    const code = semi < 0 ? line : line.slice(0, semi);
    const comment = semi < 0 ? '' : line.slice(semi);
    let out = '';
    if (code.trim()) {
      const eq = code.indexOf('=');
      out += eq >= 0
        ? `<span class="tok-k">${esc(code.slice(0, eq))}</span>=<span class="tok-n">${esc(code.slice(eq + 1))}</span>`
        : esc(code);
    }
    if (comment) out += `<span class="${!code.trim() && /^;\s*----/.test(comment) ? 'tok-h' : 'tok-c'}">${esc(comment)}</span>`;
    return out;
  }

  function lineHtml(f, line) {
    if (f.kind === 'mdp') return mdpLineHtml(line);
    if (f.kind === 'sh') return ctx.highlightLine(line, {});
    if (f.kind === 'top') return ctx.highlightLine(line, { topology: true });
    if (f.kind === 'ndx') return /^\s*\[/.test(line) ? `<span class="tok-d">${esc(line)}</span>` : esc(line);
    if (f.kind === 'md') return /^#/.test(line) ? `<span class="tok-d">${esc(line)}</span>` : esc(line);
    if (f.kind === 'plumed') return /^\s*#/.test(line) ? `<span class="tok-c">${esc(line)}</span>` : esc(line);
    return esc(line);
  }

  function explainRows(f) {
    if (f.kind !== 'mdp') return null;
    if (!ui.explainCache.has(f.text)) {
      const p = f.plan;
      const context = { posres: p.posres, forceField: plan().forceField.id, system: plan().forceField.resolution === 'coarse-grained' ? 'coarse-grained' : 'all-atom' };
      if (index.loaded()) {
        context.indexGroups = index.names();
        context.structure = index.pullStructure();
      }
      ui.explainCache.set(f.text, explainMdp(f.text, { context, version: plan().version }));
    }
    return ui.explainCache.get(f.text);
  }

  /* A file's verdict: level, the text for its tab and a short badge. */
  function statusOf(f) {
    if (f.kind !== 'mdp') return null;
    const p = f.plan;
    if (p.errors.length) return { level: 'error', badge: 'grompp stops', text: `grompp stops: ${p.errors.length} error${p.errors.length === 1 ? '' : 's'}` };
    if (p.mdrunStops.length) return { level: 'error', badge: 'mdrun stops', text: 'mdrun stops' };
    // grompp stops on a group no index defines, unless the system happens
    // to have a residue of that name: not certain, so a warning.
    if (p.needsIndex && p.needsIndex.length) {
      return { level: 'warning', badge: 'needs an index', text: `grompp needs an index file for ${p.needsIndex.join(', ')}` };
    }
    if (p.maxwarn) return { level: 'warning', badge: `-maxwarn ${p.maxwarn}`, text: `${p.maxwarn} warning${p.maxwarn === 1 ? '' : 's'}: -maxwarn ${p.maxwarn}` };
    return { level: 'ok', text: p.grompp.notes ? `grompp passes, ${p.grompp.notes} note${p.grompp.notes === 1 ? '' : 's'}` : 'grompp passes' };
  }

  function renderTabs(list) {
    const host = $('gxFileTabs');
    if (!host) return;
    const cur = currentFile(list);
    host.innerHTML = list.map((f) => {
      const st = statusOf(f);
      const sub = f.kind === 'mdp' ? stageLength(f.plan)
        : f.kind === 'sh' ? ctx.schedulerInfo().label : f.kind === 'ndx' ? `${index.groups().length} groups` : f.kind === 'top' ? 'header'
          : f.kind === 'plumed' ? (f.main ? 'PLUMED' : 'included') : 'notes';
      const icon = st ? `<i class="fa-solid ${st.level === 'ok' ? 'fa-circle-check' : SEVERITY[st.level].icon} gx-ft-st gx-ft-${st.level}" aria-hidden="true"></i>` : '';
      const sel = f.id === cur.id;
      return `<button type="button" role="tab" class="gx-ftab${f.kind === 'mdp' ? ' is-stage' : ''}" data-gx-tab="${esc(f.id)}" aria-selected="${sel}" tabindex="${sel ? 0 : -1}" aria-controls="gxCodeWrap"` +
        `${st ? ` title="${esc(st.text)}"` : ''}>` +
        `<span class="gx-ftab-n">${icon}${esc(f.name)}</span><span class="gx-ftab-s">${esc(sub)}${st && st.level !== 'ok' ? `<span class="sr-only">, ${esc(st.text)}</span>` : ''}</span></button>`;
    }).join('');
  }

  function renderFile(list) {
    const f = currentFile(list);
    ui.file = f.id;
    if ($('gxFilesBox')) $('gxFilesBox').dataset.kind = f.kind;
    const what = $('gxFileWhat');
    if (what) {
      if (f.kind === 'mdp') {
        const p = f.plan;
        what.innerHTML = `${esc(p.label)}${p.dynamics ? `: ${esc(stageLength(p))}${p.unlimited ? '' : `, ${formatCount(p.nsteps)} steps`}` : ''}. ` +
          'Point at a line for what it does, or choose Explained.';
      } else {
        what.innerHTML = WHAT[f.id] ? WHAT[f.id]() : '';
      }
    }
    const seg = $('gxModeSeg');
    if (seg) seg.hidden = f.kind !== 'mdp';
    const mode = f.kind === 'mdp' ? ui.mode : 'code';
    seg?.querySelectorAll('[data-gx-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('data-gx-mode') === mode)));
    const code = $('gxCode');
    const wrap = $('gxCodeWrap');
    const ex = $('gxExplain');
    if (wrap) wrap.hidden = mode !== 'code';
    if (ex) ex.hidden = mode !== 'explain';
    if (mode === 'code' && code) {
      const lines = f.text.replace(/\n$/, '').split('\n');
      code.innerHTML = lines.map((l, i) => `<span class="gx-ln" data-l="${i + 1}">${lineHtml(f, l)}</span>`).join('');
      if (ui.pinned && ui.pinned.file === f.id) {
        const el = code.querySelector(`[data-l="${ui.pinned.line}"]`);
        if (el) el.classList.add('is-pinned');
        else ui.pinned = null;
      }
    }
    if (mode === 'explain' && ex) renderExplained(f, ex);
    if ($('gxCopy')) $('gxCopy').setAttribute('aria-label', `Copy ${f.name}`);
    if ($('gxDownload')) {
      $('gxDownload').setAttribute('aria-label', `Download ${f.name}`);
      $('gxDownload').title = `Download ${f.name}`;
    }
    renderFoot(f);
  }

  function badge(text, cls = '') { return `<span class="stk-badge ${cls}">${esc(text)}</span>`; }

  function renderExplained(f, host) {
    const rows = explainRows(f) || [];
    const overridden = new Set(f.plan.overridden.map(n => n.toLowerCase()));
    const html = [];
    for (const r of rows) {
      if (r.kind === 'comment') {
        const m = /^----\s*(.+?)\s*----$/.exec(r.comment);
        if (m) html.push(`<li class="gx-xl-h">${esc(m[1])}</li>`);
        continue;
      }
      if (r.kind === 'blank') continue;
      const worst = r.issues.find(i => i.severity === 'error') || r.issues.find(i => i.severity === 'warning');
      const tags = [];
      if (r.name && overridden.has(r.name.toLowerCase())) tags.push(badge('set by you', 'stk-badge-accent'));
      if (r.isDefault) tags.push(badge('default'));
      if (r.status !== 'ok') tags.push(badge(r.status, r.status === 'unknown' || r.status === 'duplicate' ? 'stk-badge-danger' : 'stk-badge-warn'));
      html.push(`<li class="gx-xl-row${worst ? ` gx-xl-${worst.severity}` : ''}">
        <div class="gx-xl-top"><span class="gx-xl-no">${r.line}</span><code class="gx-xl-name">${esc(r.name || r.text.split('=')[0].trim())}</code><code class="gx-xl-val">= ${esc(r.value)}</code>${tags.join('')}` +
        `${r.url ? `<a class="gx-xl-link" href="${esc(r.valueUrl || r.url)}" target="_blank" rel="noopener">Manual<span class="sr-only">: ${esc(r.name || '')}</span> <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : ''}</div>
        <p class="gx-xl-mean">${esc(r.meaning)}</p>
        ${r.summary && !r.meaning.startsWith(r.summary) ? `<p class="gx-xl-sum">${esc(r.summary)}${r.unit ? ` (${esc(r.unit)})` : ''}</p>` : ''}
        ${r.issues.filter(i => i.severity !== 'note' || i.source === 'grompp').map(issueLine).join('')}
      </li>`);
    }
    host.innerHTML = `<ol class="gx-xl">${html.join('')}</ol>`;
  }

  function renderFoot(f, row = null) {
    const foot = $('gxFoot');
    if (!foot) return;
    if (row) {
      const tags = [];
      if (row.isDefault) tags.push(badge('default'));
      if (row.issues.length) {
        const worst = row.issues.find(i => i.severity === 'error') || row.issues.find(i => i.severity === 'warning') || row.issues[0];
        tags.push(badge(SEVERITY[worst.severity].label, SEVERITY[worst.severity].badge));
      }
      if (row.kind === 'comment' || row.kind === 'blank') {
        foot.innerHTML = `<span class="gx-foot-line">Line ${row.line}</span> A comment: grompp ignores everything after <code>;</code>.`;
        return;
      }
      foot.innerHTML = `<span class="gx-foot-line">Line ${row.line}</span> ` +
        `${row.name ? `<code>${esc(row.name)}</code> ` : ''}${tags.join(' ')} ${esc(row.meaning)}` +
        `${row.issues.length ? ` ${esc(row.issues.map(i => i.message).join(' '))}` : ''} ` +
        `${row.url ? link(row.valueUrl || row.url, `Manual<span class="sr-only">: ${esc(row.name || '')}</span>`) : ''}`;
      return;
    }
    if (f.kind === 'mdp') {
      const st = statusOf(f);
      const p = f.plan;
      const reasons = p.maxwarn ? ` ${esc(p.maxwarnReasons.join(' '))}` : '';
      const errors = p.errors.length ? ` ${esc(p.errors.map(e => e.message).join(' '))}` : '';
      foot.innerHTML = `<span class="gx-foot-st gx-ft-${st.level}"><i class="fa-solid ${st.level === 'ok' ? 'fa-circle-check' : SEVERITY[st.level].icon}" aria-hidden="true"></i> ${esc(st.text)}.</span>${reasons}${errors} ` +
        `${link(gromacsVersionInfo(plan().version).manual, `Every option in the GROMACS ${esc(gromacsVersionInfo(plan().version).release)} manual`)}`;
    } else if (f.kind === 'sh') {
      foot.innerHTML = ui.submitHint;
    } else if (f.kind === 'ndx') {
      foot.innerHTML = `${index.groups().length} groups for ${formatCount(index.natoms())} atoms, from ${esc(index.fileName())}.`;
    } else if (f.kind === 'top') {
      foot.innerHTML = 'A header to start from; not in the zip, so it cannot overwrite the topology you already have.';
    } else {
      foot.innerHTML = 'Goes into the zip with the run files.';
    }
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
    if (focus) $('gxFileTabs')?.querySelector(`[data-gx-tab="${CSS.escape(id)}"]`)?.focus();
    const tab = $('gxFileTabs')?.querySelector(`[data-gx-tab="${CSS.escape(id)}"]`);
    if (tab && tab.scrollIntoView) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    ctx.scheduleSave();
  }

  /* Show a file from anywhere on the page: the Files view, that tab. */
  function showFile(id) {
    showView('files');
    selectFile(id);
    if (window.innerWidth < 1024) $('gxFilesBox')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------------------------------------------------------- *
   * Steps (left) and views (right)
   * ---------------------------------------------------------------- */

  function showStep(step, { focus = false, scroll = false } = {}) {
    if (!STEPS.includes(step)) step = 'system';
    ui.step = step;
    document.querySelectorAll('[data-gx-step]').forEach((b) => {
      const sel = b.getAttribute('data-gx-step') === step;
      b.setAttribute('aria-selected', String(sel));
      b.tabIndex = sel ? 0 : -1;
      if (sel) b.setAttribute('data-stk-state', 'current');
      else b.removeAttribute('data-stk-state');
      if (sel && focus) b.focus();
    });
    document.querySelectorAll('[data-gx-pane]').forEach((p) => { p.hidden = p.getAttribute('data-gx-pane') !== step; });
    ctx.onViewChange();
    // The output follows: the index next to Index groups, the script next to Job.
    if (ui.view === 'files') {
      if (step === 'index' && index.loaded()) selectFile('index');
      else if (step === 'job') selectFile('submit');
    }
    if (scroll) {
      const nav = $('gxSteps');
      if (nav && nav.getBoundingClientRect().top < 0) nav.scrollIntoView({ block: 'start' });
    }
    ctx.scheduleSave();
  }

  function showView(view, { focus = false } = {}) {
    if (!VIEWS.includes(view)) view = 'files';
    ui.view = view;
    document.querySelectorAll('[data-gx-view]').forEach((b) => {
      const sel = b.getAttribute('data-gx-view') === view;
      b.setAttribute('aria-selected', String(sel));
      b.tabIndex = sel ? 0 : -1;
      if (sel && focus) b.focus();
    });
    if ($('gxFilesBox')) $('gxFilesBox').hidden = !ui.active || view !== 'files';
    if ($('gxOptBox')) $('gxOptBox').hidden = !ui.active || view !== 'options';
    if ($('gxChkBox')) $('gxChkBox').hidden = !ui.active || view !== 'check';
    if (view === 'options') options.show();
    if (view === 'check') check.show();
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

  function renderStepInfo(wf) {
    const info = (step, text, alert) => {
      const b = document.querySelector(`[data-gx-step="${step}"]`);
      if (!b) return;
      const small = b.querySelector('[data-gx-info]');
      if (small) small.textContent = text;
      b.classList.toggle('gx-step-alert', !!alert);
    };
    const T = numOr('gxTemp', 300);
    info('system', `${FF_SHORT[wf.forceField.id] || ''}`, wf.warnings.some(w => /time step|repartition|flexible/i.test(w)) || !!wf.indexWarning);
    const dynPs = wf.stages.filter(p => p.dynamics && !p.unlimited).reduce((a, p) => a + p.lengthPs, 0);
    const open = wf.stages.some(p => p.unlimited);
    info('stages', open ? 'no limit' : dynPs ? formatDuration(dynPs) : `${wf.stages.length} on`,
      wf.stages.some(p => p.errors.length || p.mdrunStops.length || (p.needsIndex && p.needsIndex.length)));
    const sys = document.querySelector('[data-gx-step="system"]');
    if (sys) sys.title = `${FF_SHORT[wf.forceField.id] || ''}, ${T} K`;
    const cov = index.loaded() ? index.coverage(wf.tcGroups) : null;
    info('index', index.loaded() ? `${index.groups().length} groups` : lostIndex() ? 'load again' : 'optional', (cov && !cov.ok) || !!lostIndex());
    info('job', ctx.schedulerInfo().label, false);
  }

  /* ---------------------------------------------------------------- *
   * Rendering everything
   * ---------------------------------------------------------------- */

  function render() {
    if (!ui.active) return;
    const wf = plan();
    renderSystem(wf);
    renderStages(wf);
    renderStepInfo(wf);
    index.renderChecks(wf);
    renderFiles();
    options.refresh();
    check.refreshContext();
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
    return `${job || 'gromacs-run'}.zip`;
  }

  async function downloadZip() {
    await refreshPlumed();
    const list = files().filter(f => f.zip !== false);
    // Files grompp or mdrun will stop on, or that need an index nobody gave.
    const stops = plan().stages.filter(p => p.errors.length || p.mdrunStops.length || (p.needsIndex && p.needsIndex.length));
    const zip = buildZip(list.map(f => ({ path: f.name, text: f.text, executable: !!f.executable })));
    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = zipName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    // mdrun -plumed reads an input the zip holds only once the PLUMED tab has built it.
    const plumed = plumedOptions();
    const addPlumed = plumedStages(plan().stages, plumed).length && !list.some(f => f.kind === 'plumed' && f.main)
      ? ` Add ${plumed.file}, built in the PLUMED tab: it is not in the zip, and submit.sh stops without it.` : '';
    showToast(stops.length
      ? `${zipName()}: ${list.length} files. The run will stop at ${stops.map(p => p.file).join(', ')}; see the Stages view.${addPlumed}`
      : `${zipName()}: ${list.map(f => f.name).join(', ')}.${addPlumed}`, stops.length || addPlumed ? 'warn' : 'ok');
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  const panel = $('gromacsPanel');
  const REACT = {
    gxForceField: forceFieldChosen,
    gxSystem: systemChosen,
    gxHmr: hmrChosen,
    gxVersion: versionChosen,
    stage_em_method: emMethodChosen,
    topForcefield: topologyChosen
  };
  if (panel) {
    panel.addEventListener('change', (e) => {
      const id = e.target && e.target.id;
      if (REACT[id]) REACT[id]();
      else if (/^stage_\w+_(on|geom|mode)$/.test(id || '') || id === 'gxConstraints') syncDerived();
      update();
    });
    panel.addEventListener('input', (e) => {
      const t = e.target;
      if (!t || t.tagName === 'SELECT' || t.type === 'checkbox') return;
      if (/^stage_\w+_mdp$/.test(t.id)) syncDerived();
      schedule();
    });
    panel.addEventListener('click', (e) => {
      const fileBtn = e.target.closest('[data-gx-file]');
      if (fileBtn) { showFile(fileBtn.getAttribute('data-gx-file')); return; }
      const act = e.target.closest('[data-gx-act]');
      if (act && act.getAttribute('data-gx-act') === 'use-tc') useRecommendedTc();
    });
  }

  document.querySelectorAll('[data-gx-step]').forEach((b) => {
    b.addEventListener('click', () => showStep(b.getAttribute('data-gx-step'), { scroll: true }));
  });
  arrowTabs($('gxSteps'), 'data-gx-step', (s) => showStep(s));
  document.querySelectorAll('[data-gx-view]').forEach((b) => {
    b.addEventListener('click', () => showView(b.getAttribute('data-gx-view')));
  });
  arrowTabs($('gxViews'), 'data-gx-view', (v) => showView(v));

  const tabs = $('gxFileTabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-gx-tab]');
      if (b) selectFile(b.getAttribute('data-gx-tab'));
    });
    arrowTabs(tabs, 'data-gx-tab', (id) => selectFile(id, { focus: true }));
  }
  $('gxModeSeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-gx-mode]');
    if (!b) return;
    ui.mode = b.getAttribute('data-gx-mode');
    renderFile(files());
    ctx.scheduleSave();
  });

  // Point at a line for its meaning; click to keep it while scrolling.
  const code = $('gxCode');
  if (code) {
    const rowFor = (el) => {
      const f = currentFile();
      const rows = explainRows(f);
      if (!rows) return null;
      return rows[Number(el.getAttribute('data-l')) - 1] || null;
    };
    code.addEventListener('mouseover', (e) => {
      const el = e.target.closest('.gx-ln');
      if (!el || ui.pinned) return;
      const row = rowFor(el);
      if (row) renderFoot(currentFile(), row);
    });
    code.addEventListener('mouseleave', () => { if (!ui.pinned) renderFoot(currentFile()); });
    code.addEventListener('click', (e) => {
      const el = e.target.closest('.gx-ln');
      if (!el) return;
      const f = currentFile();
      if (f.kind !== 'mdp') return;
      const line = Number(el.getAttribute('data-l'));
      code.querySelectorAll('.is-pinned').forEach(x => x.classList.remove('is-pinned'));
      if (ui.pinned && ui.pinned.line === line && ui.pinned.file === f.id) {
        ui.pinned = null;
        renderFoot(f);
        return;
      }
      ui.pinned = { file: f.id, line };
      el.classList.add('is-pinned');
      const row = rowFor(el);
      if (row) renderFoot(f, row);
    });
  }

  $('gxCopy')?.addEventListener('click', (e) => copyText(currentFile().text, e.currentTarget));
  $('gxDownload')?.addEventListener('click', () => {
    const f = currentFile();
    ctx.downloadText(f.text, f.name);
  });
  $('gxZip')?.addEventListener('click', downloadZip);

  function useRecommendedTc() {
    const rec = index.loaded() ? index.recommendation() : null;
    if (!rec || !rec.names.length) return;
    setValue('gxTcGrps', rec.names.join(' '));
    if (!val('gmxIndex')) setValue('gmxIndex', 'index.ndx');
    update();
    ctx.scheduleSave();
    showToast(`tc-grps = ${rec.names.join(' ')} in every .mdp file.`, 'ok');
  }

  /* ---------------------------------------------------------------- *
   * Sub-modules
   * ---------------------------------------------------------------- */

  const index = createGromacsIndex(ctx, {
    changed: () => update(),
    loadedStructure: (natoms, rec) => {
      ui.lostIndex = null;
      setValue('gxAtoms', String(natoms));
      if (rec && rec.names.length) {
        setValue('gxTcGrps', rec.names.join(' '));
        if (!val('gmxIndex')) setValue('gmxIndex', 'index.ndx');
      }
      update();
      ctx.scheduleSave();
    },
    removed: () => {
      ui.lostIndex = null;
      if (val('gmxIndex') === 'index.ndx') setValue('gmxIndex', '');
      const sys = SYSTEM_TYPES[val('gxSystem', 'protein')] || SYSTEM_TYPES.protein;
      setValue('gxTcGrps', sys.tcGroups.join(' '));
      update();
      ctx.scheduleSave();
    },
    showIndexFile: () => showFile('index'),
    tcGroups: () => plan().tcGroups
  });

  const hooks = {
    plan,
    files,
    showFile,
    showView,
    currentFileId: () => ui.file,
    overrides: () => ui.overrides,
    setOverride(stage, name, value) {
      if (!ui.overrides[stage]) ui.overrides[stage] = {};
      if (value === undefined) delete ui.overrides[stage][name];
      else ui.overrides[stage][name] = value;
      if (!Object.keys(ui.overrides[stage]).length) delete ui.overrides[stage];
      update();
      ctx.scheduleSave();
    },
    /* Continue from an .mdp file: shared choices into the form, the stage
       switched on, and the rest kept as options set by hand. */
    load(stageKey, shared, stageState, overrides) {
      const map = {
        forceField: 'gxForceField', system: 'gxSystem', temperature: 'gxTemp', pressure: 'gxPressure',
        thermostat: 'gxThermostat', barostat: 'gxBarostat', couplingType: 'gxPcouplType', tcGroups: 'gxTcGrps',
        constraints: 'gxConstraints', hmr: 'gxHmr'
      };
      const before = val('gxForceField', 'amber');
      for (const [k, id] of Object.entries(map)) if (shared[k] !== undefined) setValue(id, shared[k]);
      // A file that changes the force field but does not say which bonds are
      // rigid (a minimisation file, say) gets the force field's, as picking
      // the force field does.
      if (shared.forceField && shared.forceField !== before && shared.constraints === undefined && FORCE_FIELDS[shared.forceField]) {
        setValue('gxConstraints', FORCE_FIELDS[shared.forceField].constraints);
      }
      if ('dtFs' in shared) setValue('gxDt', shared.dtFs ? String(shared.dtFs) : '');
      const top = FF_TO_TOP[shared.forceField];
      if (top) { setValue('topForcefield', top); if (FF_WATER[shared.forceField]) setValue('topSolvent', FF_WATER[shared.forceField]); }
      const k = stageKey;
      const s = stageState;
      setValue(`stage_${k}_on`, true);
      if ('posres' in s) setValue(`stage_${k}_posres`, s.posres);
      if (s.lengthPs !== undefined) {
        const ns = s.lengthPs >= 1000 && Number.isInteger(s.lengthPs / 1000);
        setValue(`stage_${k}_len`, String(ns ? s.lengthPs / 1000 : s.lengthPs));
        setValue(`stage_${k}_unit`, ns ? 'ns' : 'ps');
      }
      if (s.velocities) setValue(`stage_${k}_vel`, s.velocities);
      if (s.output) {
        setValue(`stage_${k}_xtc`, String(s.output.xtcPs));
        setValue(`stage_${k}_edr`, String(s.output.energyPs));
        setValue(`stage_${k}_log`, String(s.output.logPs));
        setValue(`stage_${k}_trr`, String(s.output.trrPs));
      }
      if (k === 'em') {
        if (s.method) setValue('stage_em_method', s.method);
        if (s.emtol !== undefined) setValue('stage_em_emtol', String(s.emtol));
        if (s.emSteps !== undefined) setValue('stage_em_steps', String(s.emSteps));
      }
      if (s.ensemble && (k === 'prod' || k === 'pull')) setValue(`stage_${k}_ens`, s.ensemble);
      if (k === 'anneal') {
        if (s.schedule) setValue('stage_anneal_sched', s.schedule);
        if (s.annealType) setValue('stage_anneal_type', s.annealType);
        if ('pressure' in s) setValue('stage_anneal_p', !!s.pressure);
      }
      if (k === 'pull' && s.pull) {
        const p = s.pull;
        setValue('stage_pull_mode', p.mode); setValue('stage_pull_g1', p.group1); setValue('stage_pull_g2', p.group2);
        setValue('stage_pull_geom', p.geometry); setValue('stage_pull_dim', p.dim); setValue('stage_pull_vec', p.vec);
        setValue('stage_pull_k', String(p.k)); setValue('stage_pull_rate', String(p.rate)); setValue('stage_pull_pout', String(p.outputPs));
      }
      if (overrides === null) delete ui.overrides[k];
      else if (overrides) {
        if (Object.keys(overrides).length) ui.overrides[k] = overrides;
        else delete ui.overrides[k];
      }
      syncDerived();
      ctx.onTopologyChange();
      update();
      ctx.scheduleSave();
    },
    readState,
    index: () => index,
    forceField: () => val('gxForceField', 'amber')
  };
  const options = createGromacsOptions(ctx, hooks);
  const check = createGromacsCheck(ctx, hooks);

  /* ---------------------------------------------------------------- *
   * The page's side
   * ---------------------------------------------------------------- */

  return {
    plan,
    runOptions,
    /** Called by the page when the engine tab changes. */
    enter() {
      ui.active = true;
      if ($('gxSteps')) $('gxSteps').hidden = false;
      if ($('gxViews')) $('gxViews').hidden = false;
      showStep(ui.step);
      showView(ui.view);
      syncDerived();
      refreshPlumed();
    },
    leave() {
      ui.active = false;
      if ($('gxSteps')) $('gxSteps').hidden = true;
      if ($('gxViews')) $('gxViews').hidden = true;
      ['gxFilesBox', 'gxOptBox', 'gxChkBox'].forEach(id => { if ($(id)) $(id).hidden = true; });
    },
    step: () => ui.step,
    setSubmit(text, hint) {
      ui.submit = text;
      ui.submitHint = hint || '';
      render();
    },
    setTopology(text) {
      ui.topology = text;
      if (ui.active && ui.file === 'top') renderFiles();
    },
    invalidate,
    serialise() {
      // The structure is not saved (it can be tens of MB), but what was
      // built from it is named, so a later visit can say the index is gone.
      const built = index.loaded()
        ? { name: runOptions().index || 'index.ndx', file: index.fileName(), natoms: index.natoms() }
        : lostIndex();
      return { overrides: ui.overrides, step: ui.step, view: ui.view, file: ui.file, mode: ui.mode, index: built || null };
    },
    restore(data, fields = {}) {
      const d = data && typeof data === 'object' ? data : {};
      // Settings saved before the builder had its own force field: follow
      // the topology header's.
      if (!Object.prototype.hasOwnProperty.call(fields, 'gxForceField') && TOP_TO_FF[fields.topForcefield]) {
        setValue('gxForceField', TOP_TO_FF[fields.topForcefield]);
      }
      ui.overrides = d.overrides && typeof d.overrides === 'object' ? JSON.parse(JSON.stringify(d.overrides)) : {};
      ui.step = STEPS.includes(d.step) ? d.step : 'system';
      ui.view = VIEWS.includes(d.view) ? d.view : 'files';
      ui.file = typeof d.file === 'string' ? d.file : 'submit';
      ui.mode = d.mode === 'explain' ? 'explain' : 'code';
      const lost = d.index && typeof d.index === 'object' && typeof d.index.name === 'string' && d.index.name ? d.index : null;
      ui.lostIndex = lost && !index.loaded()
        ? { name: lost.name, file: typeof lost.file === 'string' ? lost.file : '', natoms: Number(lost.natoms) || 0 }
        : null;
      invalidate();
      syncDerived();
    }
  };
}
