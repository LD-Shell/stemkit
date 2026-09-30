/*
 * STEMKit, MD Workflow Generator: atoms from a structure file.
 * Author: Olanrewaju M. Daramola
 *
 * The structure is read by src/core/structure.js and turned into PLUMED atom
 * lists by src/core/plumed-atoms.js. It is held in memory only: a structure
 * can be tens of megabytes and is of no use to anyone but the person who
 * loaded it, so it is neither saved nor sent anywhere.
 *
 * The file is split by residue (name, number and chain), so a protein is
 * listed residue by residue and the page says "residues", not "molecules".
 * Distances in a selection are in nm, PLUMED's unit, whatever the file's.
 */

import { parseStructure } from '../src/core/structure.js';
import {
  speciesOf, perMoleculeGroups, perMoleculeCenters, moleculeOrientations, selectForPlumed,
  compressAtomList, safeLabel
} from '../src/core/plumed-atoms.js';
import {
  distinctAtoms, withDistinctNames, atomKeyText, ordinal, nextTicks, pickOptions, queryHasLength, loadedText,
  NUMBERING_NOTE
} from './script-generator-plumed-model.js';

const MAX_BYTES = 200 * 1024 * 1024;

/* Twenty urea molecules in water, enough to try every tool on. */
function sampleGro() {
  const urea = ['C', 'O', 'N1', 'H11', 'H12', 'N2', 'H21', 'H22'];
  const water = ['OW', 'HW1', 'HW2'];
  const lines = [];
  let n = 0;
  let res = 0;
  const add = (resName, names, x, y, z) => {
    res += 1;
    names.forEach((name, i) => {
      n += 1;
      const f = (v) => v.toFixed(3).padStart(8);
      lines.push(
        `${String(res % 100000).padStart(5)}${resName.padEnd(5)}${name.padStart(5)}${String(n % 100000).padStart(5)}` +
        `${f(x + 0.05 * i)}${f(y + 0.03 * (i % 3))}${f(z + 0.02 * (i % 2))}`);
    });
  };
  for (let i = 0; i < 20; i++) add('UREA', urea, (i % 5) * 0.6, Math.floor(i / 5) * 0.6, 0.5);
  for (let i = 0; i < 200; i++) add('SOL', water, (i % 10) * 0.3, (Math.floor(i / 10) % 10) * 0.3, 1 + Math.floor(i / 100) * 0.3);
  return ['Urea in water (sample)', String(n).padStart(5), ...lines, '   3.00000   3.00000   3.00000', ''].join('\n');
}

/**
 * @param {object} ctx - Page helpers.
 * @param {object} builder - `version()`, `addCV(type, values, label)`,
 *        `atomFields()`, `setAtomField(id, field, value)`, `addInclude(name,
 *        text, note)`, `files()`, `removeFile(name)`, `setNatoms(n)`.
 */
export function createPlumedAtoms(ctx, builder) {
  const { $, escapeHtml, showToast, downloadText } = ctx;
  // `ticks` holds the ticked atoms of one copy by their place in it, in the
  // order they were ticked: a direction runs from the first to the second.
  // `box` and `boxVectors` are the file's cell, in nm, for periodic `within:`;
  // `warnings` what the reader said about the file.
  const state = {
    atoms: [], species: [], name: '', unit: 'nm', box: null, boxVectors: null, warnings: [],
    target: '', ticks: []
  };

  const species = (name) => state.species.find(s => s.name === name);
  const fmt = (n) => Number(n).toLocaleString('en-GB');

  /* ---------------------------------------------------------------- *
   * Loading
   * ---------------------------------------------------------------- */

  function setStructure(text, name) {
    const parsed = parseStructure(text, name);
    if (!parsed) {
      showToast(`${name} is not a .gro or .pdb file.`, 'danger');
      return;
    }
    if (!parsed.atoms.length) {
      showToast(`No atoms could be read from ${name}.`, 'danger');
      return;
    }
    state.atoms = parsed.atoms;
    state.species = speciesOf(parsed.atoms);
    state.name = name;
    state.unit = parsed.unit || 'nm';
    state.box = parsed.box || null;
    state.boxVectors = parsed.boxVectors || null;
    state.warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter(Boolean) : [];
    builder.setNatoms(parsed.atoms.length);
    render();
    // speciesOf splits by residue, so a protein counts once per residue.
    showToast(loadedText(name, parsed.atoms.length, state.species, state.warnings),
      state.warnings.length ? 'warn' : 'ok');
  }

  function readFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      showToast(`${file.name} is larger than 200 MB.`, 'danger');
      return;
    }
    file.text().then(t => setStructure(t, file.name))
      .catch(() => showToast(`Could not read ${file.name}.`, 'danger'));
  }

  function clear() {
    state.atoms = [];
    state.species = [];
    state.name = '';
    state.box = null;
    state.boxVectors = null;
    state.warnings = [];
    render();
  }

  /* ---------------------------------------------------------------- *
   * Drawing
   * ---------------------------------------------------------------- */

  function fillSelect(id, values, keep) {
    const sel = $(id);
    if (!sel) return;
    const was = keep !== undefined ? keep : sel.value;
    sel.innerHTML = values.map(v => `<option value="${escapeHtml(v.value)}">${escapeHtml(v.text)}</option>`).join('');
    if (values.some(v => v.value === was)) sel.value = was;
  }

  function render() {
    const has = state.atoms.length > 0;
    if ($('plumedStructDrop')) $('plumedStructDrop').hidden = has;
    if ($('plumedStructBody')) $('plumedStructBody').hidden = !has;
    if ($('plumedStructClear')) $('plumedStructClear').hidden = !has;
    renderFiles();
    if (!has) return;

    $('plumedStructSummary').innerHTML =
      `<strong>${escapeHtml(state.name)}</strong>: ${fmt(state.atoms.length)} atom${state.atoms.length === 1 ? '' : 's'}. ` +
      `${escapeHtml(NUMBERING_NOTE)}` +
      (state.warnings.length
        ? '<span class="sg-cv-note sg-cv-note-warn plumed-struct-warn" style="margin-top:.4rem">' +
          '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>' +
          `<span>${escapeHtml(state.warnings.join(' '))}</span></span>`
        : '');
    $('plumedStructSpecies').innerHTML = state.species.map(s => `<tr>
        <td>${escapeHtml(s.name)}</td><td>${fmt(s.molecules)}</td>
        <td>${s.uniform ? s.atomsPerMolecule : `${s.atomsPerMolecule}, varies`}</td>
        <td>${s.contiguous ? `${s.firstAtom}-${s.lastAtom}` : `from ${s.firstAtom}`}</td>
      </tr>`).join('');

    const names = state.species.map(s => ({ value: s.name, text: `${s.name} (${fmt(s.molecules)})` }));
    fillSelect('plumedPickSpecies', [{ value: '', text: 'Any residue' }, ...names]);
    fillSelect('plumedMolSpecies', names);
    renderPickAtoms();
    renderMolAtoms();
    renderTargets();
    runPick();
  }

  function renderPickAtoms() {
    const s = species(($('plumedPickSpecies') || {}).value);
    const names = s ? s.atomNames : [...new Set(state.species.flatMap(x => x.atomNames))];
    fillSelect('plumedPickAtom', [{ value: '', text: 'Every atom' },
      ...[...new Set(names)].map(n => ({ value: n, text: n }))]);
  }

  /* One box per atom of a copy. An atom whose name comes again (C, C, O)
     is shown with its place among the atoms of that name, and its box
     carries a key that picks that atom of every copy, not the first C. */
  function renderMolAtoms() {
    const host = $('plumedMolAtoms');
    const s = species(($('plumedMolSpecies') || {}).value);
    state.ticks = [];
    if (!host) return;
    if (!s) { host.innerHTML = ''; return; }
    host.innerHTML = distinctAtoms(s.atomNames).map((a, i) =>
      `<label class="sg-pick" title="${escapeHtml(a.text)}, atom ${i + 1} of ${escapeHtml(s.name)}">` +
      `<input type="checkbox" data-mol-atom="${i}" value="${escapeHtml(a.key)}" aria-label="${escapeHtml(a.text)}"> ` +
      `<code>${escapeHtml(a.name)}</code>` +
      `${a.of > 1 ? `<span class="sg-pick-nth" aria-hidden="true">(${ordinal(a.nth)})</span>` : ''}</label>`).join('');
    const note = $('plumedMolNote');
    if (note) {
      note.textContent = s.uniform ? '' :
        `The copies of ${s.name} do not all have the same atoms, so check what is written.`;
    }
  }

  function renderTargets() {
    const fields = builder.atomFields();
    const opts = fields.map(f => ({ value: `${f.id}|${f.field}`, text: `${f.label} · ${f.field}` }));
    fillSelect('plumedPickTarget', [...opts, { value: 'group', text: 'A new group' }],
      state.target || undefined);
  }

  function renderFiles() {
    const files = builder.files();
    const wrap = $('plumedFilesWrap');
    const host = $('plumedFiles');
    if (!wrap || !host) return;
    const names = Object.keys(files);
    wrap.hidden = !names.length;
    host.innerHTML = names.map(n => `<li>
        <div class="sg-file-t"><code>${escapeHtml(n)}</code>${files[n].note ? `<span class="sg-file-note">${escapeHtml(files[n].note)}</span>` : ''}</div>
        <button type="button" class="stk-btn stk-btn-sm stk-btn-ghost" data-file-get="${escapeHtml(n)}"><i class="fa-solid fa-download" aria-hidden="true"></i><span class="sr-only">Download ${escapeHtml(n)}</span></button>
        <button type="button" class="stk-btn stk-btn-sm stk-btn-ghost" data-file-del="${escapeHtml(n)}"><i class="fa-solid fa-trash" aria-hidden="true"></i><span class="sr-only">Remove ${escapeHtml(n)}</span></button>
      </li>`).join('');
    host.querySelectorAll('[data-file-get]').forEach(b => b.addEventListener('click', () => {
      const n = b.getAttribute('data-file-get');
      downloadText(files[n].text, n);
    }));
    host.querySelectorAll('[data-file-del]').forEach(b => b.addEventListener('click', () => {
      builder.removeFile(b.getAttribute('data-file-del'));
      renderFiles();
    }));
  }

  /* ---------------------------------------------------------------- *
   * Picking
   * ---------------------------------------------------------------- */

  function runPick() {
    const out = $('plumedPickResult');
    const count = $('plumedPickCount');
    if (!out || !count) return { list: '', count: 0 };
    const query = ($('plumedPickQuery') || {}).value || '';
    if (!query.trim()) {
      out.textContent = '';
      count.textContent = '';
      return { list: '', count: 0 };
    }
    // A distance in the query (within:, x:, y:, z:) is in nm, the unit of a
    // PLUMED input, whether the file is a .gro (nm) or a PDB (Å). With a box
    // in the file, within: measures to the nearest periodic image.
    const options = pickOptions(state);
    const r = selectForPlumed(state.atoms, query, options);
    const periodic = options.box && /(^|[\s!])within:/i.test(query) ? ', to the nearest periodic image' : '';
    const lengths = queryHasLength(query) ? `, distances in nm${periodic}` : '';
    out.textContent = r.errors.length ? '' : r.list;
    count.textContent = r.errors.length ? r.errors[0] : `${fmt(r.count)} atom${r.count === 1 ? '' : 's'}${lengths}`;
    count.className = `stk-badge${r.errors.length ? ' stk-badge-warn' : r.count ? ' stk-badge-accent' : ''}`;
    return r;
  }

  function writeQuery() {
    const s = ($('plumedPickSpecies') || {}).value;
    const a = ($('plumedPickAtom') || {}).value;
    const q = [s ? `resn:${s}` : '', a ? `atom:${a}` : ''].filter(Boolean).join(' ');
    if ($('plumedPickQuery')) $('plumedPickQuery').value = q;
    runPick();
  }

  function usePick() {
    const r = runPick();
    if (!r.count) {
      showToast('The selection holds no atoms.', 'danger');
      return;
    }
    const target = ($('plumedPickTarget') || {}).value || 'group';
    if (target === 'group') {
      const a = ($('plumedPickAtom') || {}).value;
      builder.addCV('GROUP', { ATOMS: r.list }, safeLabel(a || ($('plumedPickSpecies') || {}).value || 'g', 'g'));
      showToast(`Group of ${fmt(r.count)} atoms added.`, 'ok');
    } else {
      const [id, field] = target.split('|');
      builder.setAtomField(id, field, r.list);
      showToast(`${fmt(r.count)} atom${r.count === 1 ? '' : 's'} written to ${field}.`, 'ok');
    }
    renderTargets();
  }

  /* ---------------------------------------------------------------- *
   * The same atoms of every copy
   * ---------------------------------------------------------------- */

  /* The keys of the ticked boxes, in the order they were ticked. A box
     ticked without a change event (none is expected) comes last, in list order. */
  function ticked() {
    const boxes = Array.from(document.querySelectorAll('[data-mol-atom]'));
    const inOrder = state.ticks
      .map(i => boxes.find(el => el.getAttribute('data-mol-atom') === String(i)))
      .filter(el => el && el.checked);
    const rest = boxes.filter(el => el.checked && !inOrder.includes(el));
    return [...inOrder, ...rest].map(el => el.value);
  }

  /* Number the ticked boxes 1, 2... so the first and second of a direction show. */
  function onTick(e) {
    const el = e.target.closest('[data-mol-atom]');
    if (!el) return;
    state.ticks = nextTicks(state.ticks, Number(el.getAttribute('data-mol-atom')), el.checked);
    document.querySelectorAll('[data-mol-atom]').forEach((box) => {
      const at = state.ticks.indexOf(Number(box.getAttribute('data-mol-atom')));
      const label = box.closest('.sg-pick');
      if (label) {
        if (at >= 0) label.setAttribute('data-order', String(at + 1));
        else label.removeAttribute('data-order');
      }
    });
  }

  const note = (text) => { if ($('plumedMolNote')) $('plumedMolNote').textContent = text; };
  // The structure with repeated atom names told apart, as the ticked keys expect.
  const keyed = (name) => withDistinctNames(state.atoms, name);

  function addGroups() {
    const name = ($('plumedMolSpecies') || {}).value;
    const names = ticked();
    if (!names.length) { note('Tick the atoms to make groups of.'); return; }
    const r = perMoleculeGroups(keyed(name), name, names);
    for (const g of r.groups) builder.addCV('GROUP', { ATOMS: g.atoms }, g.label);
    const done = r.groups.length
      ? `${r.groups.length} group${r.groups.length === 1 ? '' : 's'} added, ${fmt(r.groups[0].count)} atoms each.`
      : '';
    note([done, ...r.warnings].filter(Boolean).join(' '));
    renderTargets();
  }

  function addCenters() {
    const name = ($('plumedMolSpecies') || {}).value;
    const names = ticked();
    const s = species(name);
    if (!s) return;
    const tag = safeLabel(name.toLowerCase(), 'm');
    const group = `${tag}_centres`;
    const r = perMoleculeCenters(keyed(name), name, { atomNames: names, prefix: `${tag}c`, group });
    if (!r.lines.length) { note(r.warnings.join(' ')); return; }
    const file = `centres_${tag}.dat`;
    builder.addInclude(file, `${[...r.lines, r.groupLine].join('\n')}\n`,
      `${fmt(r.labels.length)} centres, gathered in the group ${group}`, [group, ...r.labels]);
    note(`${fmt(r.labels.length)} centres written to ${file}. Use the group ${group} wherever atoms are ` +
      `expected, such as SPECIES=${group}.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`);
    renderFiles();
  }

  function addDirections() {
    const name = ($('plumedMolSpecies') || {}).value;
    const names = ticked();
    if (names.length !== 2) {
      note('Tick two atoms: the direction of a copy runs from the atom ticked first (1) to the one ticked second (2).');
      return;
    }
    const tag = safeLabel(name.toLowerCase(), 'm');
    const label = `${tag}_dir`;
    const r = moleculeOrientations(keyed(name), name,
      { start: names[0], end: names[1], label, version: builder.version() });
    if (!r.lines.length) { note(r.warnings.join(' ')); return; }
    const s = species(name);
    const [from, to] = names.map(k => atomKeyText(k, s && s.atomNames));
    const file = `directions_${tag}.dat`;
    builder.addInclude(file, `${r.lines.join('\n')}\n`,
      `${fmt(r.count)} directions, ${from} to ${to}, labelled ${label}`, [label],
      builder.version());
    // A warning (copies that lack an atom) is shown with the result, not dropped.
    note(`${fmt(r.count)} directions, ${from} to ${to}, written to ${file} for PLUMED ${builder.version()}. ` +
      `Give SMAC SPECIES=${label}.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`);
    renderFiles();
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  const on = (id, event, fn) => { if ($(id)) $(id).addEventListener(event, fn); };
  on('plumedStructChoose', 'click', () => $('plumedStructFile') && $('plumedStructFile').click());
  on('plumedStructFile', 'change', (e) => {
    readFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });
  on('plumedStructSample', 'click', () => setStructure(sampleGro(), 'urea-in-water.gro'));
  on('plumedStructClear', 'click', clear);
  on('plumedPickSpecies', 'change', () => { renderPickAtoms(); writeQuery(); });
  on('plumedPickAtom', 'change', writeQuery);
  on('plumedPickQuery', 'input', runPick);
  on('plumedPickTarget', 'change', (e) => { state.target = e.target.value; });
  on('plumedPickUse', 'click', usePick);
  on('plumedPickCopy', 'click', () => {
    const r = runPick();
    if (!r.list) return;
    const done = () => showToast('Atom list copied.', 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(r.list).then(done).catch(() => showToast('Copy failed.', 'danger'));
    }
  });
  on('plumedMolSpecies', 'change', renderMolAtoms);
  on('plumedMolAtoms', 'change', onTick);
  on('plumedMolGroups', 'click', addGroups);
  on('plumedMolCenters', 'click', addCenters);
  on('plumedMolDirections', 'click', addDirections);

  const drop = $('plumedStructDrop');
  if (drop) {
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  }

  return {
    render,
    hasStructure: () => state.atoms.length > 0,
    /** Point the picker at one field and bring it into view. */
    pickFor(id, field) {
      state.target = `${id}|${field}`;
      renderTargets();
      const box = $('plumedPick');
      if (!box) return;
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      box.classList.remove('is-target');
      void box.offsetWidth;
      box.classList.add('is-target');
      if ($('plumedPickQuery')) $('plumedPickQuery').focus({ preventScroll: true });
    },
    compress: compressAtomList
  };
}
