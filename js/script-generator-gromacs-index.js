/*
 * STEMKit, MD Workflow Generator: GROMACS index groups from a structure.
 * Author: Olanrewaju M. Daramola
 *
 * A .gro or .pdb is read the way GROMACS reads it (src/core/gromacs-ndx.js):
 * the groups `gmx make_ndx` makes, the ones a set-up needs on top (ligand,
 * complex, pocket, membrane, solvent), the temperature groups for the system,
 * and groups of the user's own from residue and atom names, distances and
 * combinations. The result is index.ndx, and the checks grompp will make of
 * every group the .mdp files name.
 */

import {
  readGromacsStructure, defaultGroups, suggestGroups, customGroup, writeNdx, describeGroups,
  checkGroupCoverage, checkMdpGroups, findIndexGroup, sanitiseGroupName, isValidGroupName
} from '../src/core/gromacs-ndx.js';
import { parseMdp } from '../src/core/gromacs-mdp.js';
import { centralAtom } from './script-generator-gromacs-model.js';

const KIND_LABEL = {
  ligand: 'ligands', complex: 'complex', pocket: 'pocket', membrane: 'membrane',
  solvent: 'solvent', 'tc-grps': 'for tc-grps', custom: 'yours'
};
const ROLE_LABEL = {
  protein: 'protein', nucleic: 'nucleic acid', ligand: 'ligand', lipid: 'lipid', water: 'water',
  ion: 'ion', cosolvent: 'cosolvent'
};

const SAMPLES = {
  complex: { file: 'complex.gro', label: 'a peptide with a ligand in water' },
  membrane: { file: 'membrane.gro', label: 'a CHARMM-style bilayer with a peptide' }
};

/**
 * @param {object} ctx - Page helpers (`$`, `escapeHtml`, `showToast`, `downloadText`).
 * @param {object} hooks - `changed()`, `loadedStructure(natoms, recommendation)`,
 *   `removed()`, `showIndexFile()`, `tcGroups()`.
 */
export function createGromacsIndex(ctx, hooks) {
  const { $, escapeHtml: esc, showToast } = ctx;
  const s = { top: null, fileName: '', defaults: [], sugg: null, off: new Set(), custom: [], preview: null, timer: 0 };

  const fmt = (n) => Number(n).toLocaleString('en-GB');
  const words = (v) => String(v || '').split(/[\s,]+/).map(x => x.trim()).filter(Boolean);

  function loaded() { return !!(s.top && s.top.atoms.length); }
  function natoms() { return s.top ? s.top.atoms.length : 0; }

  /** Every group index.ndx will hold, in order: make_ndx's, the suggestions kept, the user's. */
  function groups() {
    if (!loaded()) return [];
    return [
      ...s.defaults.map(g => ({ ...g, kind: 'default' })),
      ...s.sugg.groups.filter(g => !s.off.has(g.name)),
      ...s.custom
    ];
  }

  function recommendation() { return s.sugg ? s.sugg.tcGrps : null; }

  function coverage(names) {
    if (!loaded()) return null;
    return checkGroupCoverage(groups(), names, natoms(), { coverage: 'all', option: 'tc-grps' });
  }

  /* An atom near the centre of a group of the index (from 1), for
     pull-groupN-pbcatom; 0 for a group of one atom or a name not in it.
     Worked out once per group: the plan asks on every change. */
  const centres = new WeakMap();
  function centralAtomOf(name) {
    if (!loaded()) return 0;
    const all = groups();
    const i = findIndexGroup(all, name);
    if (i < 0 || all[i].atoms.length < 2) return 0;
    const atoms = all[i].atoms;
    if (!centres.has(atoms)) centres.set(atoms, centralAtom(s.top.atoms, atoms, s.top.box));
    return centres.get(atoms);
  }

  /* ---------------------------------------------------------------- *
   * Loading
   * ---------------------------------------------------------------- */

  function load(text, name) {
    const top = readGromacsStructure(text, name);
    if (!top.atoms.length) {
      showToast(`${name}: no atoms read. ${top.errors[0] || 'Is it a .gro or .pdb file?'}`, 'danger');
      return;
    }
    s.top = top;
    s.fileName = name;
    s.defaults = defaultGroups(top);
    s.sugg = suggestGroups(top);
    s.off.clear();
    s.custom = [];
    render();
    const rec = recommendation();
    hooks.loadedStructure(top.atoms.length, rec);
    showToast(`${name}: ${fmt(top.atoms.length)} atoms, ${groups().length} groups.` +
      (rec && rec.names.length ? ` tc-grps = ${rec.names.join(' ')} in every .mdp file.` : ''), 'ok');
  }

  function readFile(file) {
    if (!file) return;
    if (file.size > 80 * 1024 * 1024) {
      showToast(`${file.name} is larger than 80 MB; index groups are made from the coordinates grompp reads, a .gro or .pdb.`, 'danger');
      return;
    }
    file.text().then(t => load(t, file.name)).catch(() => showToast(`Could not read ${file.name}.`, 'danger'));
  }

  function loadSample(key) {
    const sample = SAMPLES[key];
    fetch(`assets/samples/gromacs/${sample.file}`)
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(t => load(t, sample.file))
      .catch(() => showToast(`The sample (${sample.label}) could not be loaded.`, 'danger'));
  }

  function clear() {
    s.top = null;
    s.fileName = '';
    s.defaults = [];
    s.sugg = null;
    s.custom = [];
    s.off.clear();
    render();
    hooks.removed();
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  function render() {
    const has = loaded();
    const show = (id, v) => { if ($(id)) $(id).hidden = !v; };
    show('gxNdxDrop', !has);
    show('gxNdxBody', has);
    show('gxNdxClear', has);
    show('gxTcCard', has);
    show('gxGroupsCard', has);
    show('gxCustomCard', has);
    fillDatalist();
    if (!has) return;
    const comp = s.sugg.composition;
    const residues = s.top.residues.length;
    const ligs = s.sugg.ligands;
    const summary = $('gxNdxSummary');
    if (summary) {
      summary.innerHTML = `<strong>${esc(s.fileName)}</strong>: ${fmt(natoms())} atoms in ${fmt(residues)} residues` +
        `${ligs.length ? `; ligand${ligs.length === 1 ? '' : 's'} ${ligs.map(l => `<code>${esc(l.name)}</code>`).join(', ')}` : ''}` +
        `${s.sugg.lipids.length ? `; lipids ${s.sugg.lipids.map(l => `<code>${esc(l)}</code>`).join(', ')}` : ''}.`;
    }
    const tbody = $('gxNdxComp');
    if (tbody) {
      tbody.innerHTML = comp.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.type)}</td><td>${esc(ROLE_LABEL[c.role] || c.role)}</td>` +
        `<td>${fmt(c.residues)}</td><td>${fmt(c.atoms)}</td></tr>`).join('');
    }
    const notes = [...(s.top.errors || []), ...(s.top.warnings || []), ...s.sugg.notes];
    const nb = $('gxNdxNotes');
    if (nb) {
      nb.hidden = !notes.length;
      nb.innerHTML = notes.length ? `<i class="fa-solid fa-circle-info" aria-hidden="true"></i><div class="sg-warn-list">${notes.map(n => `<p>${esc(n)}</p>`).join('')}</div>` : '';
    }
    const rec = recommendation();
    if ($('gxTcLine')) $('gxTcLine').textContent = rec && rec.names.length ? rec.line : 'tc-grps = System';
    if ($('gxTcReason')) $('gxTcReason').textContent = rec ? rec.reason : '';
    renderGroups();
    fillSelects();
    preview();
  }

  function fillDatalist() {
    const dl = $('gxGroupNames');
    if (dl) dl.innerHTML = groups().map(g => `<option value="${esc(g.name)}"></option>`).join('');
  }

  function renderGroups() {
    const host = $('gxGroups');
    if (!host) return;
    const all = groups();
    const number = new Map(all.map((g, i) => [g, i]));
    const described = describeGroups(all, s.top);
    const info = new Map(all.map((g, i) => [g, described.groups[i]]));
    const resText = (d) => {
      if (!d) return '';
      const names = d.residueNames.slice(0, 4).map(r => `${r.name}${r.residues > 1 ? ` ×${fmt(r.residues)}` : ''}`);
      return names.join(', ') + (d.residueNames.length > 4 ? `, +${d.residueNames.length - 4} more` : '');
    };
    const row = (g, extra) => {
      const d = info.get(g);
      return `<div class="gx-g-top">${extra.lead || ''}<span class="gx-g-no" title="Group number in make_ndx">${number.has(g) ? number.get(g) : '–'}</span>` +
        `<code class="gx-g-name">${esc(g.name)}</code>${g.kind && KIND_LABEL[g.kind] ? `<span class="stk-badge${g.kind === 'custom' ? ' stk-badge-accent' : ''}">${esc(KIND_LABEL[g.kind])}</span>` : ''}` +
        `<span class="gx-g-n">${fmt(g.atoms.length)} atoms</span>${extra.tail || ''}</div>` +
        `<p class="gx-g-res">${esc(resText(d))}</p>`;
    };
    const sugg = s.sugg.groups;
    const parts = [];
    if (sugg.length) {
      parts.push(`<h3 class="gx-g-h">Suggested for this system</h3><ul class="gx-glist">${sugg.map((g) => {
        const off = s.off.has(g.name);
        const id = `gxSugg_${g.name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
        return `<li class="gx-g${off ? ' is-off' : ''}">${row(g, {
          lead: `<input type="checkbox" id="${esc(id)}" data-nosave data-g-sugg="${esc(g.name)}"${off ? '' : ' checked'} aria-label="Include ${esc(g.name)}">`
        })}<p class="gx-g-why"><label for="${esc(id)}">${esc(g.reason)}</label></p></li>`;
      }).join('')}</ul>`);
    }
    if (s.custom.length) {
      parts.push(`<h3 class="gx-g-h">Yours</h3><ul class="gx-glist">${s.custom.map((g, i) => `<li class="gx-g">${row(g, {
        tail: `<button type="button" class="stk-btn stk-btn-sm stk-btn-ghost gx-g-rm" data-g-rm="${i}" aria-label="Remove ${esc(g.name)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`
      })}${g.how ? `<p class="gx-g-why">${esc(g.how)}</p>` : ''}</li>`).join('')}</ul>`);
    }
    parts.push(`<details class="stk-disclosure gx-g-defaults"><summary>The ${s.defaults.length} groups make_ndx makes</summary><div>` +
      `<div class="stk-table-wrap"><table class="sg-species gx-g-table"><thead><tr><th scope="col">#</th><th scope="col">Group</th><th scope="col">Atoms</th><th scope="col">Residues</th></tr></thead><tbody>` +
      s.defaults.map((g, i) => {
        const d = described.groups[i];
        return `<tr><td>${i}</td><td>${esc(g.name)}</td><td>${fmt(g.atoms.length)}</td><td>${esc(resText(d))}</td></tr>`;
      }).join('') + '</tbody></table></div></div></details>');
    const warns = described.warnings.filter(w => w.group !== null);
    if (warns.length) {
      parts.push(`<div class="gx-check-list">${warns.map(w => `<p class="${w.level === 'error' ? 'gx-bad' : 'gx-warn'}"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${esc(w.message)}</p>`).join('')}</div>`);
    }
    host.innerHTML = parts.join('');
  }

  function fillSelects() {
    const all = groups();
    const opts = (first) => (first ? `<option value="">${esc(first)}</option>` : '') +
      all.map(g => `<option value="${esc(g.name)}">${esc(g.name)} (${fmt(g.atoms.length)})</option>`).join('');
    const keep = (id, first, fallback) => {
      const el = $(id);
      if (!el) return;
      const cur = el.value;
      el.innerHTML = opts(first);
      if (cur && Array.from(el.options).some(o => o.value === cur)) el.value = cur;
      else if (fallback && Array.from(el.options).some(o => o.value === fallback)) el.value = fallback;
    };
    const lig = s.sugg.ligands[0];
    keep('gxCgFrom', 'all atoms', '');
    keep('gxCgWithinOf', '', lig ? lig.name : (all[1] ? all[1].name : ''));
    keep('gxCgCombineWith', '', '');
  }

  /* Checks of every group the .mdp files name, against this index. */
  function renderChecks(wf) {
    const host = $('gxTcCheck');
    if (!host || !loaded()) return;
    const lines = [];
    const all = groups();
    const cov = coverage(wf.tcGroups);
    if (cov) {
      lines.push(cov.ok
        ? `<p class="gx-ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> <code>tc-grps = ${esc(wf.tcGroups.join(' '))}</code>: every atom in exactly one group.</p>`
        : cov.errors.map(e => `<p class="gx-bad"><i class="fa-solid fa-circle-xmark" aria-hidden="true"></i> ${esc(e)}</p>`).join(''));
    }
    const seen = new Set();
    for (const p of wf.stages) {
      const values = parseMdp(p.text).values;
      delete values['tc-grps'];
      const r = checkMdpGroups(all, values, natoms());
      for (const o of r.options) {
        for (const e of o.errors) {
          const msg = `${p.file}: ${e}`;
          if (!seen.has(e)) { seen.add(e); lines.push(`<p class="gx-bad"><i class="fa-solid fa-circle-xmark" aria-hidden="true"></i> ${esc(msg)}</p>`); }
        }
      }
    }
    const rec = recommendation();
    const btn = $('gxTcUse');
    if (btn && rec) {
      const same = rec.names.join(' ').toLowerCase() === wf.tcGroups.join(' ').toLowerCase();
      btn.disabled = same || !rec.names.length;
      btn.innerHTML = same ? '<i class="fa-solid fa-check" aria-hidden="true"></i> In use in the .mdp files'
        : '<i class="fa-solid fa-arrow-right" aria-hidden="true"></i> Use in the .mdp files';
    }
    host.innerHTML = lines.join('');
  }

  /* ---------------------------------------------------------------- *
   * Making a group
   * ---------------------------------------------------------------- */

  const v = (id) => ($(id) ? String($(id).value).trim() : '');
  const checked = (id) => !!($(id) && $(id).checked);

  function specFromForm() {
    const base = {};
    const how = [];
    if (v('gxCgFrom')) { base.group = v('gxCgFrom'); how.push(`in ${v('gxCgFrom')}`); }
    if (words(v('gxCgRes')).length) { base.resname = words(v('gxCgRes')); how.push(`residues ${base.resname.join(' ')}`); }
    if (v('gxCgResnr')) { base.resnr = v('gxCgResnr'); how.push(`residue numbers ${base.resnr}`); }
    if (words(v('gxCgAtom')).length) { base.atomname = words(v('gxCgAtom')); how.push(`atoms ${base.atomname.join(' ')}`); }
    if (words(v('gxCgChain')).length) { base.chain = words(v('gxCgChain')); how.push(`chain ${base.chain.join(' ')}`); }
    if (words(v('gxCgElem')).length) { base.element = words(v('gxCgElem')); how.push(`elements ${base.element.join(' ')}`); }
    if (checked('gxCgWithinOn') && v('gxCgWithinOf')) {
      const d = Number(v('gxCgWithin'));
      base.within = { distance: Number.isFinite(d) ? d : 0.5, of: v('gxCgWithinOf'), byResidue: checked('gxCgByRes') };
      how.push(`within ${base.within.distance} nm of ${base.within.of}${base.within.byResidue ? ', whole residues' : ''}`);
    }
    if (v('gxCgQuery')) { base.query = v('gxCgQuery'); how.push(`matching "${base.query}"`); }
    const combine = v('gxCgCombine');
    const other = v('gxCgCombineWith');
    const any = Object.keys(base).length;
    if (!any && !(combine && other)) return null;
    let spec = base;
    if (combine && other) {
      if (combine === 'or') { spec = any ? { or: [base, { group: other }] } : { group: other }; how.push(`plus ${other}`); }
      if (combine === 'and') { spec = { ...base, and: [{ group: other }] }; how.push(`also in ${other}`); }
      if (combine === 'not') { spec = { ...base, not: { group: other } }; how.push(`not in ${other}`); }
    }
    return { spec, how: how.join(', ') };
  }

  /* Fields that mean nothing yet: the distance until it is switched on, the
     group to combine with until there is a way to combine. */
  function syncBuilder() {
    const near = checked('gxCgWithinOn');
    ['gxCgWithin', 'gxCgWithinOf', 'gxCgByRes'].forEach((id) => { if ($(id)) $(id).disabled = !near; });
    const combine = !!v('gxCgCombine');
    if ($('gxCgCombineWith')) $('gxCgCombineWith').hidden = !combine;
  }

  function preview() {
    syncBuilder();
    const out = $('gxCgPreview');
    const add = $('gxCgAdd');
    s.preview = null;
    if (!loaded()) return;
    const made = specFromForm();
    if (!made) {
      if (out) { out.textContent = 'Fill in at least one line to see which atoms it takes.'; out.className = 'gx-cg-preview'; }
      if (add) add.disabled = true;
      return;
    }
    const r = customGroup(s.top, made.spec, { groups: groups() });
    const name = v('gxCgName') ? sanitiseGroupName(v('gxCgName')) : r.name;
    const taken = findIndexGroup(groups(), name) >= 0;
    let msg;
    let bad = false;
    if (r.errors.length) { msg = r.errors.join(' '); bad = true; }
    else if (!r.atoms.length) { msg = 'No atom matches all of these.'; bad = true; }
    else {
      const d = describeGroups([{ name, atoms: r.atoms }], s.top).groups[0];
      const res = d.residueNames.slice(0, 5).map(x => `${x.name}${x.residues > 1 ? ` ×${fmt(x.residues)}` : ''}`).join(', ');
      msg = `${name}: ${fmt(r.atoms.length)} atoms in ${fmt(d.residues)} residue${d.residues === 1 ? '' : 's'} (${res}${d.residueNames.length > 5 ? ', ...' : ''}).`;
      if (taken) { msg += ` A group is already called ${name}; give this one another name.`; bad = true; }
      if (v('gxCgName') && !isValidGroupName(v('gxCgName'))) msg += ` It will be written as ${name}: no spaces, brackets or semicolons in a group name.`;
    }
    if (out) { out.textContent = msg; out.className = `gx-cg-preview${bad ? ' is-bad' : ' is-ok'}`; }
    if (add) add.disabled = bad;
    if (!bad) s.preview = { name, atoms: r.atoms, how: made.how };
  }

  function addGroup() {
    preview();
    if (!s.preview) return;
    s.custom.push({ name: s.preview.name, atoms: s.preview.atoms, kind: 'custom', how: s.preview.how });
    ['gxCgName', 'gxCgRes', 'gxCgResnr', 'gxCgAtom', 'gxCgChain', 'gxCgElem', 'gxCgQuery'].forEach((id) => { if ($(id)) $(id).value = ''; });
    if ($('gxCgWithinOn')) $('gxCgWithinOn').checked = false;
    if ($('gxCgCombine')) $('gxCgCombine').value = '';
    showToast(`${s.preview.name} added: ${fmt(s.preview.atoms.length)} atoms.`, 'ok');
    render();
    hooks.changed();
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  const bind = (id, ev, fn) => { if ($(id)) $(id).addEventListener(ev, fn); };
  bind('gxNdxChoose', 'click', () => $('gxNdxFile') && $('gxNdxFile').click());
  bind('gxNdxFile', 'change', (e) => { readFile(e.target.files && e.target.files[0]); e.target.value = ''; });
  bind('gxNdxSample', 'click', () => loadSample('complex'));
  bind('gxNdxSampleMemb', 'click', () => loadSample('membrane'));
  bind('gxNdxClear', 'click', clear);
  bind('gxNdxView', 'click', () => hooks.showIndexFile());
  bind('gxNdxDownload', 'click', () => ctx.downloadText(writeNdx(groups()), 'index.ndx'));
  bind('gxCgAdd', 'click', addGroup);
  const drop = $('gxNdxDrop');
  if (drop) {
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      drop.classList.remove('is-over');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      e.preventDefault();
      readFile(file);
    });
  }
  const groupsHost = $('gxGroups');
  if (groupsHost) {
    groupsHost.addEventListener('change', (e) => {
      const name = e.target.getAttribute && e.target.getAttribute('data-g-sugg');
      if (!name) return;
      if (e.target.checked) s.off.delete(name);
      else s.off.add(name);
      render();
      hooks.changed();
    });
    groupsHost.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-g-rm]');
      if (!rm) return;
      const g = s.custom.splice(Number(rm.getAttribute('data-g-rm')), 1)[0];
      render();
      hooks.changed();
      if (g) showToast(`${g.name} removed.`, 'ok');
    });
  }
  const custom = $('gxCustomCard');
  if (custom) {
    const later = () => { syncBuilder(); clearTimeout(s.timer); s.timer = setTimeout(preview, 150); };
    custom.addEventListener('input', later);
    custom.addEventListener('change', later);
  }

  render();

  return {
    loaded, natoms, groups, recommendation, coverage, renderChecks,
    centralAtom: centralAtomOf,
    names: () => groups().map(g => g.name),
    ndxText: () => writeNdx(groups()),
    fileName: () => s.fileName,
    /** The structure's box vectors as rows (nm), or null. */
    box: () => (loaded() && Array.isArray(s.top.box) ? s.top.box : null)
  };
}
