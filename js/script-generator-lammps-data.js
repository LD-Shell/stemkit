/*
 * STEMKit, MD Workflow Generator: a LAMMPS data file, and the groups from it.
 * Author: Olanrewaju M. Daramola
 *
 * A data file dropped under System is read in the browser by
 * src/core/lammps-data.js: the atoms, the types with the elements their
 * masses suggest, the water model and its types, the net charge and the
 * density, and what looks wrong. The summary goes to the workflow, which
 * uses it (SHAKE on the right types, the charge for the long-range solver),
 * and the groups it suggests go to the Groups view, where they can be
 * renamed, left out or added to.
 */

import { SEVERITY, formatCount } from './script-generator-lammps-model.js';

const NAME_OK = /^[A-Za-z0-9_]+$/;
const MAX_BYTES = 256 * 1024 * 1024;

/**
 * @param {object} ctx - Page helpers (`$`, `escapeHtml`, `showToast`).
 * @param {object} hooks - `core()`, `units()`, `loadedData(summary)`, `removedData()`,
 *   `changed()`, `showStep(step)`.
 */
export function createLammpsData(ctx, hooks) {
  const { $, escapeHtml: esc, showToast } = ctx;
  const s = {
    name: '', text: null, parsed: null, summary: null, saved: false,
    // Suggested groups left out, renamed or with a new selection; the user's own.
    off: new Set(), edits: {}, custom: []
  };

  const D = () => { const c = hooks.core(); return c && c.data; };
  const fmt = (n, d = 0) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: d });
  // The charge of one atom of the type (what a force field lists), or the
  // range when its atoms differ; the type's total says little.
  const typeCharge = (t) => {
    const c = t.charges || {};
    if (Number.isFinite(c.each)) return fmt(c.each, 4);
    if (Number.isFinite(c.min) && Number.isFinite(c.max)) return `${fmt(c.min, 4)} to ${fmt(c.max, 4)}`;
    return '—';
  };

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  /* The force field chosen under System, and the atom style it writes. */
  function forceField() {
    const c = hooks.core();
    const w = c && c.workflow;
    const id = $('lxForceField') ? $('lxForceField').value : '';
    return w && Array.isArray(w.LMP_FORCE_FIELDS) ? w.LMP_FORCE_FIELDS.find(f => f.id === id) || null : null;
  }
  function atomStyleHint() {
    const ff = forceField();
    if (ff && ff.id === 'custom') return ($('lxCustomAtomStyle') && $('lxCustomAtomStyle').value.trim()) || ff.atomStyle || undefined;
    return ff && ff.atomStyle ? ff.atomStyle : undefined;
  }

  /*
   * The file says its own atom style (the "# full" comment on its Atoms
   * line), and that wins: the force field's style is used only to settle
   * columns that fit several styles.
   */
  function parse(d, text) {
    let parsed = d.parseDataFile(text);
    const hint = atomStyleHint();
    if (hint && parsed.atomStyleSource === 'columns' && (parsed.atomStyleCandidates || []).length > 1) {
      parsed = d.parseDataFile(text, { atomStyle: hint });
    }
    return parsed;
  }

  /* A file written for another atom style than the force field writes. */
  function styleClash() {
    const ff = forceField();
    const hint = atomStyleHint();
    const mine = (s.parsed && s.parsed.atomStyle) || (s.summary && s.summary.atomStyle) || '';
    if (!ff || !hint || !mine) return '';
    if (mine.split(/\s+/)[0] === hint.split(/\s+/)[0]) return '';
    const name = ff.label.replace(/^[^:(]*:\s*/, '').replace(/\s*\(.*$/, '').replace(/ with .*$/, '');
    return `This data file is atom_style ${mine}; the ${name} preset writes atom_style ${hint}: change one of them.`;
  }

  function analyse() {
    const d = D();
    if (!d || s.text === null) return false;
    try {
      s.parsed = parse(d, s.text);
      s.summary = d.summariseData(s.parsed, { units: hooks.units() });
      s.saved = false;
      return true;
    } catch (e) {
      s.parsed = null;
      s.summary = null;
      showToast(`${s.name} could not be read as a LAMMPS data file: ${e.message}`, 'danger');
      return false;
    }
  }

  function load(text, name) {
    s.text = text;
    s.name = name;
    s.off.clear();
    s.edits = {};
    if (!D()) {
      // The reader is still loading; it reads the file when it arrives.
      showToast(`${name}: read once the LAMMPS builder has loaded.`);
      return;
    }
    if (!analyse()) return;
    if ($('lxDataName') && name) $('lxDataName').value = name;
    render();
    renderGroups();
    hooks.loadedData(s.summary);
    const sum = s.summary;
    const n = (s.parsed.issues || []).filter(i => i.severity === 'error').length;
    showToast(`${name}: ${fmt(sum.natoms || 0)} atoms of ${(sum.types || []).length} types` +
      `${sum.water && sum.water.model ? `, ${sum.water.model} water` : ''}.${n ? ` ${n} problem${n === 1 ? '' : 's'}: see the summary.` : ''}`, n ? 'warn' : 'ok');
  }

  function readFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      showToast(`${file.name} is larger than 256 MB; the page reads data files up to that size.`, 'danger');
      return;
    }
    file.text().then(t => load(t, file.name)).catch(() => showToast(`Could not read ${file.name}.`, 'danger'));
  }

  function clear() {
    s.name = '';
    s.text = null;
    s.parsed = null;
    s.summary = null;
    s.saved = false;
    s.off.clear();
    s.edits = {};
    render();
    renderGroups();
    hooks.removedData();
  }

  /* ---------------------------------------------------------------- *
   * Groups
   * ---------------------------------------------------------------- */

  function suggested() {
    const d = D();
    if (!s.summary || !d || !d.groupsFromData) return [];
    try { return d.groupsFromData(s.summary) || []; } catch (_) { return []; }
  }

  /* The selection of a group line: what follows `group NAME`. */
  const selectionOf = (command) => String(command || '').trim().split(/\s+/).slice(2).join(' ');

  /** Every group the files will define, in order: the suggestions kept, then the user's. */
  function groups() {
    const out = [];
    for (const g of suggested()) {
      if (s.off.has(g.name)) continue;
      const e = s.edits[g.name] || {};
      const name = e.name || g.name;
      const sel = e.selection || selectionOf(g.command);
      out.push({ name, args: sel, command: `group ${name} ${sel}`, count: e.selection ? null : g.count, why: g.why || '', kind: 'suggested', from: g.name });
    }
    for (const g of s.custom) out.push({ ...g, args: selectionOf(g.command), kind: 'custom' });
    return out;
  }

  /* How many atoms a selection by type holds, from the summary. */
  function countOf(style, values) {
    if (!s.summary || style !== 'type') return null;
    const want = expand(values);
    if (!want) return null;
    return (s.summary.types || []).filter(t => want.has(Number(t.type))).reduce((a, t) => a + (t.count || 0), 0);
  }

  /* 1 3:5 -> {1, 3, 4, 5}; null when a word is not a number or range. */
  function expand(values) {
    const out = new Set();
    for (const w of String(values || '').trim().split(/[\s,]+/).filter(Boolean)) {
      const m = /^(\d+)(?::(\d+)(?::(\d+))?)?$/.exec(w);
      if (!m) return null;
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      const step = m[3] ? Number(m[3]) : 1;
      if (b < a || step < 1 || b - a > 1e6) return null;
      for (let i = a; i <= b; i += step) out.add(i);
    }
    return out.size ? out : null;
  }

  function preview() {
    const name = ($('lxGroupName')?.value || '').trim();
    const style = $('lxGroupStyle')?.value || 'type';
    const values = ($('lxGroupValues')?.value || '').trim();
    const out = $('lxGroupPreview');
    const btn = $('lxGroupAdd');
    let msg = '';
    let ok = false;
    const taken = new Set(['all', ...groups().map(g => g.name)]);
    if (!name && !values) msg = '';
    else if (!NAME_OK.test(name)) msg = name ? 'A group name takes letters, digits and underscores only.' : 'Give the group a name.';
    else if (taken.has(name)) msg = name === 'all' ? 'LAMMPS makes the group all itself.' : `There is already a group called ${name}.`;
    else if (!expand(values)) msg = values ? 'Values are numbers or ranges such as 1:20, separated by spaces.' : 'Say which atoms.';
    else {
      ok = true;
      const n = countOf(style, values);
      msg = `group ${name} ${style} ${values}${n !== null ? `: ${formatCount(n)} atoms` : ''}`;
    }
    if (out) {
      out.textContent = msg;
      out.className = `gx-cg-preview${msg ? (ok ? ' is-ok' : ' is-bad') : ''}`;
    }
    if (btn) btn.disabled = !ok;
    return ok ? { name, style, values } : null;
  }

  function addGroup() {
    const p = preview();
    if (!p) return;
    s.custom.push({ name: p.name, command: `group ${p.name} ${p.style} ${p.values}`, count: countOf(p.style, p.values), why: 'Yours.' });
    ['lxGroupName', 'lxGroupValues'].forEach((id) => { if ($(id)) $(id).value = ''; });
    preview();
    renderGroups();
    hooks.changed();
    ctx.scheduleSave();
    showToast(`Group ${p.name} added.`, 'ok');
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  function render() {
    const has = !!s.summary;
    const show = (id, v) => { if ($(id)) $(id).hidden = !v; };
    show('lxDataDrop', !has);
    show('lxDataBody', has);
    show('lxDataClear', has);
    if (!has) return;
    const sum = s.summary;
    const p = s.parsed || {};
    const u = hooks.units();
    const summary = $('lxDataSummary');
    if (summary) {
      const bits = [`<strong>${esc(s.name)}</strong>${s.saved ? ' (from your last visit; drop it again to read it afresh)' : ''}`];
      if (p.title) bits.push(`“${esc(p.title)}”`);
      summary.innerHTML = `${bits.join(': ')}.${sum.atomStyle || p.atomStyle ? ` Atom style <code>${esc(sum.atomStyle || p.atomStyle)}</code>.` : ''}`;
    }
    const stats = $('lxDataStats');
    if (stats) {
      const c = p.counts || {};
      const items = [['Atoms', fmt(sum.natoms || c.atoms || 0)]];
      if (sum.molecules) items.push(['Molecules', fmt(sum.molecules)]);
      for (const k of ['bonds', 'angles', 'dihedrals', 'impropers']) if (c[k]) items.push([k[0].toUpperCase() + k.slice(1), fmt(c[k])]);
      const cross = (sum.topology && sum.topology.crossterms) || c.crossterms;
      if (cross) items.push(['CMAP crossterms', fmt(cross)]);
      if (Number.isFinite(sum.charge)) items.push(['Net charge', `${Math.abs(sum.charge) < 5e-4 ? '0' : fmt(sum.charge, 4)} e`]);
      if (Number.isFinite(sum.density)) items.push(['Density', `${fmt(sum.density, 3)} g/cm³`]);
      if (sum.water && sum.water.model) {
        const conf = sum.water.confidence && sum.water.confidence !== 'high' ? ` (${sum.water.confidence} confidence)` : '';
        items.push(['Water', `${sum.water.model}${conf}, ${fmt(sum.water.count || 0)} molecules`]);
        if (Number.isFinite(sum.water.rOH) && Number.isFinite(sum.water.angleHOH)) items.push(['O–H, H–O–H', `${fmt(sum.water.rOH, 4)} Å, ${fmt(sum.water.angleHOH, 2)}°`]);
      }
      stats.innerHTML = items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    }
    const tbody = $('lxDataTypes');
    if (tbody) {
      // What the type is for: the reader's role, or the water site.
      const water = sum.water || {};
      const role = (t) => {
        const n = Number(t.type);
        if (n === Number(water.oType)) return 'water O';
        if ((water.hTypes || [water.hType]).some(h => Number(h) === n)) return 'water H';
        if (n === Number(water.mType)) return 'water M';
        return t.role && t.role !== 'water' ? t.role : '';
      };
      tbody.innerHTML = (sum.types || []).map(t => `<tr><td>${esc(t.type)}${t.label ? ` <span class="lx-dim">${esc(t.label)}</span>` : ''}</td>` +
        `<td>${esc(t.element || '?')}${role(t) ? ` <span class="lx-dim">${esc(role(t))}</span>` : ''}</td><td>${Number.isFinite(t.mass) ? fmt(t.mass, 4) : '—'}</td>` +
        `<td>${fmt(t.count || 0)}</td><td>${typeCharge(t)}</td></tr>`).join('');
      // A long table hides the force-field settings below it: closed past
      // eight types, with the count on its summary.
      const n = (sum.types || []).length;
      if ($('lxDataTypesSum')) $('lxDataTypesSum').textContent = `Atom types (${fmt(n)})`;
      if ($('lxDataTypesBox') && $('lxDataTypesBox').dataset.for !== s.name) {
        $('lxDataTypesBox').open = n <= 8;
        $('lxDataTypesBox').dataset.for = s.name;
      }
    }
    const notes = $('lxDataNotes');
    if (notes) {
      const clash = styleClash();
      // What the rigid bonds chosen under System will hold in this system.
      const rigid = $('lxRigid') ? $('lxRigid').value : 'none';
      const shake = rigid !== 'none' ? sum.shake || null : null;
      const holds = [];
      if (shake && shake.m && shake.m.length) holds.push(`every bond to an atom of mass ${shake.m.map(m => fmt(m, 3)).join(' or ')} (type${(shake.t || []).length === 1 ? '' : 's'} ${(shake.t || []).join(' ')})`);
      if (shake && shake.a && shake.a.length) holds.push(`angle type${shake.a.length === 1 ? '' : 's'} ${shake.a.join(' ')} (rigid water)`);
      const list = [...(clash ? [{ severity: 'warning', message: clash }] : []),
        ...(p.issues || []).map(i => ({ severity: i.severity || 'warning', message: i.line ? `Line ${i.line}: ${i.message}` : i.message })),
        ...(holds.length ? [{ severity: 'note', message: `${rigid === 'rattle' ? 'RATTLE' : 'SHAKE'} will hold ${holds.join(', and ')}.` }] : []),
        ...(sum.water && sum.water.note ? [{ severity: 'note', message: sum.water.note }] : []),
        ...(sum.notes || []).filter(n => !(typeof n === 'string' && /^[\d,]+ atoms of /.test(n))).map(n => (typeof n === 'string' ? { severity: 'note', message: n } : n))];
      notes.innerHTML = list.map((i) => {
        const sv = SEVERITY[i.severity] || SEVERITY.note;
        return `<p class="gx-issue gx-issue-${sv.cls}"><i class="fa-solid ${sv.icon}" aria-hidden="true"></i><span><span class="sr-only">${sv.label}: </span>${esc(i.message)}</span></p>`;
      }).join('');
    }
    void u;
  }

  function renderGroups() {
    const host = $('lxGroups');
    const empty = $('lxGroupsEmpty');
    const sugg = suggested();
    if (empty) empty.hidden = !!s.summary;
    const all = groups();
    // The restraint field offers every group by name.
    const dl = $('lxRestrainList');
    if (dl) dl.innerHTML = all.map(g => `<option value="${esc(g.name)}">${esc(g.args)}</option>`).join('');
    if (!host) return;
    const rows = [];
    if (sugg.length) {
      rows.push('<h3 class="gx-g-h">Suggested from the data file</h3><ul class="gx-glist">');
      sugg.forEach((g, i) => {
        const e = s.edits[g.name] || {};
        const off = s.off.has(g.name);
        const id = `lxG${i}`;
        rows.push(`<li class="gx-g${off ? ' is-off' : ''}">
          <div class="gx-g-top">
            <input type="checkbox" id="${id}" data-lx-g-on="${esc(g.name)}"${off ? '' : ' checked'} aria-label="Define group ${esc(e.name || g.name)}" data-nosave>
            <label class="sr-only" for="${id}n">Name of group ${esc(g.name)}</label>
            <input type="text" id="${id}n" class="stk-input stk-input-sm stk-mono lx-g-name" value="${esc(e.name || g.name)}" data-lx-g-name="${esc(g.name)}" autocomplete="off" spellcheck="false" data-nosave>
            <span class="gx-g-n">${g.count !== undefined && g.count !== null && !e.selection ? `${formatCount(g.count)} atoms` : ''}</span>
          </div>
          <div class="lx-g-sel"><code>group ${esc(e.name || g.name)}</code>
            <label class="sr-only" for="${id}s">Atoms of group ${esc(g.name)}</label>
            <input type="text" id="${id}s" class="stk-input stk-input-sm stk-mono" value="${esc(e.selection || selectionOf(g.command))}" data-lx-g-sel="${esc(g.name)}" autocomplete="off" spellcheck="false" data-nosave>
          </div>
          ${g.why ? `<p class="gx-g-why">${esc(g.why)}</p>` : ''}
        </li>`);
      });
      rows.push('</ul>');
    }
    if (s.custom.length) {
      rows.push('<h3 class="gx-g-h">Yours</h3><ul class="gx-glist">');
      s.custom.forEach((g, i) => {
        rows.push(`<li class="gx-g"><div class="gx-g-top"><code class="gx-g-name">${esc(g.name)}</code>` +
          `<span class="gx-g-n">${g.count !== null && g.count !== undefined ? `${formatCount(g.count)} atoms` : ''}</span>` +
          `<button type="button" class="stk-btn stk-btn-sm stk-btn-ghost gx-g-rm" data-lx-g-rm="${i}" aria-label="Remove group ${esc(g.name)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>` +
          `<p class="gx-g-res"><code>${esc(g.command)}</code></p></li>`);
      });
      rows.push('</ul>');
    }
    const bad = all.filter(g => !NAME_OK.test(g.name));
    const dup = all.filter((g, i) => all.findIndex(x => x.name === g.name) !== i);
    if (bad.length) rows.push(`<p class="gx-bad">${esc(bad.map(g => g.name || '(empty)').join(', '))}: a group name takes letters, digits and underscores only.</p>`);
    if (dup.length) rows.push(`<p class="gx-bad">${esc([...new Set(dup.map(g => g.name))].join(', '))}: two groups with one name; LAMMPS adds the atoms of the second to the first.</p>`);
    host.innerHTML = rows.join('');
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  const bind = (id, ev, fn) => { if ($(id)) $(id).addEventListener(ev, fn); };
  bind('lxDataChoose', 'click', () => $('lxDataFile') && $('lxDataFile').click());
  bind('lxDataFile', 'change', (e) => { readFile(e.target.files && e.target.files[0]); e.target.value = ''; });
  bind('lxDataClear', 'click', clear);
  bind('lxGroupAdd', 'click', addGroup);
  ['lxGroupName', 'lxGroupStyle', 'lxGroupValues'].forEach(id => {
    bind(id, 'input', preview);
    bind(id, 'change', preview);
  });
  bind('lxGroupValues', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addGroup(); } });
  const drop = $('lxDataDrop');
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
  const host = $('lxGroups');
  if (host) {
    // The group fields are data-nosave, so the panel's own listener leaves
    // them alone: a change here says itself what changed.
    host.addEventListener('change', (e) => {
      const t = e.target;
      const onName = t.getAttribute && t.getAttribute('data-lx-g-on');
      if (onName !== null && onName !== undefined) {
        if (t.checked) s.off.delete(onName); else s.off.add(onName);
      }
      const nameOf = t.getAttribute && t.getAttribute('data-lx-g-name');
      if (nameOf) {
        const v = t.value.trim();
        s.edits[nameOf] = { ...(s.edits[nameOf] || {}), name: v && v !== nameOf ? v : undefined };
      }
      const selOf = t.getAttribute && t.getAttribute('data-lx-g-sel');
      if (selOf) {
        const orig = (suggested().find(g => g.name === selOf) || {}).command;
        const v = t.value.trim().replace(/\s+/g, ' ');
        s.edits[selOf] = { ...(s.edits[selOf] || {}), selection: v && v !== selectionOf(orig) ? v : undefined };
      }
      e.stopPropagation();
      renderGroups();
      hooks.changed();
      ctx.scheduleSave();
    });
    host.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-lx-g-rm]');
      if (!rm) return;
      const g = s.custom.splice(Number(rm.getAttribute('data-lx-g-rm')), 1)[0];
      renderGroups();
      hooks.changed();
      ctx.scheduleSave();
      if (g) showToast(`Group ${g.name} removed.`, 'ok');
    });
  }

  return {
    /** The summary for the workflow, or null. */
    summary: () => s.summary,
    /* A new force field: columns that fit several atom styles are read
       again with its style, and the summary says whether the styles agree. */
    forceFieldChanged() {
      if (s.text !== null && s.parsed && s.parsed.atomStyleSource === 'columns') analyse();
      render();
    },
    parsed: () => s.parsed,
    fileName: () => s.name,
    groups,
    render,
    renderGroups,
    /** The reader has loaded: read a file dropped while it was loading, and the data kept from a visit. */
    coreArrived() {
      if (s.text !== null && !s.parsed) {
        if (analyse()) { render(); renderGroups(); hooks.loadedData(s.summary); }
      } else {
        render();
        renderGroups();
      }
    },
    /** A data file for the check view: parsed and summarised, not kept. */
    read(text) {
      const d = D();
      if (!d) return null;
      const parsed = parse(d, text);
      return { parsed, summary: d.summariseData(parsed, { units: hooks.units() }) };
    },
    serialise() {
      // The summary is small (per type, not per atom), so a later visit keeps
      // what the files were built from; the file itself is not saved.
      let summary = null;
      if (s.summary) {
        try {
          const json = JSON.stringify(s.summary);
          if (json.length < 200000) summary = JSON.parse(json);
        } catch (_) { summary = null; }
      }
      return {
        name: s.name || '', summary,
        title: s.parsed ? s.parsed.title || '' : '',
        off: [...s.off], edits: s.edits, custom: s.custom
      };
    },
    restore(d) {
      const x = d && typeof d === 'object' ? d : {};
      s.text = null;
      s.parsed = null;
      s.summary = x.summary && typeof x.summary === 'object' ? x.summary : null;
      s.name = typeof x.name === 'string' ? x.name : '';
      s.saved = !!s.summary;
      if (s.summary) s.parsed = { title: typeof x.title === 'string' ? x.title : '', issues: [], counts: {} };
      s.off = new Set(Array.isArray(x.off) ? x.off.filter(n => typeof n === 'string') : []);
      s.edits = x.edits && typeof x.edits === 'object' ? JSON.parse(JSON.stringify(x.edits)) : {};
      s.custom = Array.isArray(x.custom)
        ? x.custom.filter(g => g && typeof g.name === 'string' && typeof g.command === 'string').map(g => ({ name: g.name, command: g.command, count: Number.isFinite(g.count) ? g.count : null, why: 'Yours.' }))
        : [];
      render();
      renderGroups();
    }
  };
}
