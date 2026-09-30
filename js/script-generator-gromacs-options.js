/*
 * STEMKit, MD Workflow Generator: every GROMACS .mdp option, and checking a
 * file that already exists.
 * Author: Olanrewaju M. Daramola
 *
 * All options: the manual's sections in order (src/core/gromacs-mdp.js), each
 * option with its summary, default, unit and allowed values, the full manual
 * text on request, and the value it has in one of the builder's files; set a
 * value there and it goes into that file (or every file), reset puts back
 * what the builder writes.
 *
 * Check a file: grompp's verdict on a pasted or dropped .mdp, the problems by
 * severity, the file line by line, and "Open in the builder" to continue
 * from it.
 */

import {
  sectionsInOrder, optionInfo, searchOptions, loadMdpDocs, parseMdp, checkMdp, explainMdp,
  normaliseName, MDP_RELEASE
} from '../src/core/gromacs-mdp.js';
import { GX_STAGE, GX_STAGES, builderFromMdp, diffOverrides } from './script-generator-gromacs-model.js';

const KIND_TEXT = {
  enum: 'one of the values below', boolean: 'yes or no', integer: 'a whole number', real: 'a number',
  text: 'text', group: 'an index group name', groups: 'index group names', 'group-pairs': 'pairs of group names',
  reals: 'numbers', integers: 'whole numbers', words: 'words'
};
const STATUS_BADGE = { deprecated: 'stk-badge-warn', limited: 'stk-badge-warn', unsupported: 'stk-badge-danger', removed: 'stk-badge-danger', rejected: 'stk-badge-danger', renamed: 'stk-badge-warn' };

/* ------------------------------------------------------------------ *
 * All options
 * ------------------------------------------------------------------ */

/**
 * @param {object} ctx - Page helpers.
 * @param {object} gx - The GROMACS tab: `plan()`, `overrides()`, `setOverride(stage, name, value)`,
 *   `currentFileId()`, `showFile(id)`.
 */
export function createGromacsOptions(ctx, gx) {
  const { $, escapeHtml: esc } = ctx;
  const s = { built: false, rows: new Map(), open: new Set(), file: null, docs: null, timer: 0, sections: [] };

  const list = $('gxOptList');

  function stageFile() {
    const stages = gx.plan().stages;
    if (!stages.length) return null;
    return stages.find(p => p.key === s.file) || stages.find(p => p.key === gx.currentFileId()) ||
      stages.find(p => p.key === 'prod') || stages[stages.length - 1];
  }

  function build() {
    if (s.built || !list) return;
    s.built = true;
    s.sections = sectionsInOrder();
    const sec = $('gxOptSection');
    if (sec) {
      sec.innerHTML = '<option value="">All sections</option>' +
        s.sections.map(x => `<option value="${esc(x.id)}">${esc(x.title)} (${x.options.length})</option>`).join('');
    }
    const frag = document.createDocumentFragment();
    for (const section of s.sections) {
      const h = document.createElement('h3');
      h.className = 'gx-opt-sec';
      h.dataset.section = section.id;
      h.innerHTML = `<span>${esc(section.title)}</span><a href="${esc(section.url)}" target="_blank" rel="noopener" class="sg-link">Manual<span class="sr-only">: ${esc(section.title)}</span></a>`;
      frag.appendChild(h);
      for (const name of section.options) {
        const info = optionInfo(name);
        const row = document.createElement('div');
        row.className = 'gx-opt';
        row.dataset.name = name;
        row.dataset.section = section.id;
        const bid = `gxOpt_${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
        const st = info.status ? `<span class="stk-badge ${STATUS_BADGE[info.status.status] || 'stk-badge-warn'}">${esc(info.status.status)}</span>` : '';
        row.innerHTML = `<button type="button" class="gx-opt-h" id="${bid}" aria-expanded="false" aria-controls="${bid}_b">` +
          `<span class="gx-opt-top"><code class="gx-opt-name">${esc(name)}</code>${st}<span class="gx-opt-val" data-val></span></span>` +
          `<span class="gx-opt-sum">${esc(info.summary || '')}</span></button>` +
          `<div class="gx-opt-b" id="${bid}_b" role="region" aria-labelledby="${bid}" hidden></div>`;
        s.rows.set(name, { row, info });
        frag.appendChild(row);
      }
    }
    list.appendChild(frag);
  }

  function fileSelect() {
    const sel = $('gxOptFile');
    if (!sel) return;
    const stages = gx.plan().stages;
    const cur = stageFile();
    s.file = cur ? cur.key : null;
    sel.innerHTML = stages.map(p => `<option value="${esc(p.key)}">${esc(p.file)}</option>`).join('') || '<option value="">no stage on</option>';
    sel.disabled = !stages.length;
    if (cur) sel.value = cur.key;
  }

  /* The values the chosen file holds, by canonical name. */
  function fileValues() {
    const p = stageFile();
    if (!p) return { plan: null, values: {}, generated: {}, mine: {} };
    const values = parseMdp(p.text).values;
    const generated = parseMdp(p.generatedText).values;
    const mine = (gx.overrides()[p.key]) || {};
    return { plan: p, values, generated, mine };
  }

  function valueChip(name, fv) {
    const mineKey = Object.keys(fv.mine).find(k => normaliseName(k) === normaliseName(name));
    if (mineKey !== undefined) {
      const v = fv.mine[mineKey];
      return v === null ? { html: '<em>removed</em>', cls: 'is-mine' } : { html: `${esc(v)} <small>yours</small>`, cls: 'is-mine' };
    }
    if (Object.prototype.hasOwnProperty.call(fv.values, name)) return { html: esc(fv.values[name]), cls: 'is-set' };
    return { html: '', cls: '' };
  }

  function filter() {
    if (!list) return;
    const q = ($('gxOptFind')?.value || '').trim();
    const section = $('gxOptSection')?.value || '';
    const only = !!$('gxOptOnly')?.checked;
    const fv = fileValues();
    let shown = 0;
    let order = null;
    if (q) order = searchOptions(q, { limit: 400 }).map(r => r.name);
    const allowed = order ? new Set(order) : null;
    for (const [name, { row }] of s.rows) {
      const ok = (!allowed || allowed.has(name)) && (!section || row.dataset.section === section) &&
        (!only || Object.prototype.hasOwnProperty.call(fv.values, name));
      row.hidden = !ok;
      if (ok) shown++;
    }
    // Search results in rank order, without the section headings.
    list.classList.toggle('is-search', !!q);
    if (order) {
      for (const name of order) {
        const r = s.rows.get(name);
        if (r && !r.row.hidden) list.appendChild(r.row);
      }
    } else if (list.dataset.ordered !== 'sections') {
      for (const section2 of s.sections) {
        const h = list.querySelector(`.gx-opt-sec[data-section="${CSS.escape(section2.id)}"]`);
        if (h) list.appendChild(h);
        for (const name of section2.options) { const r = s.rows.get(name); if (r) list.appendChild(r.row); }
      }
    }
    list.dataset.ordered = order ? 'search' : 'sections';
    list.querySelectorAll('.gx-opt-sec').forEach((h) => {
      const any = s.sections.find(x => x.id === h.dataset.section)?.options.some(n => !s.rows.get(n).row.hidden);
      h.hidden = !!q || !any;
    });
    const count = $('gxOptCount');
    if (count) count.textContent = `${shown} of ${s.rows.size}`;
    let none = list.querySelector('.gx-opt-none');
    if (!shown) {
      if (!none) {
        none = document.createElement('p');
        none.className = 'gx-opt-none sg-cv-empty';
        list.appendChild(none);
      }
      none.textContent = q ? `No option matches "${q}". Try a word from what it does, such as "barostat" or "cut-off".` : 'No option here.';
      none.hidden = false;
    } else if (none) none.hidden = true;
    refreshValues(fv);
  }

  function refreshValues(fv = fileValues()) {
    for (const [name, { row }] of s.rows) {
      if (row.hidden) continue;
      const chip = row.querySelector('[data-val]');
      const c = valueChip(name, fv);
      chip.innerHTML = c.html;
      chip.className = `gx-opt-val ${c.cls}`;
    }
    for (const name of s.open) renderDetail(name, fv);
  }

  function valueEditor(info, current, id) {
    if (info.kind === 'enum' || info.kind === 'boolean') {
      const values = info.kind === 'boolean' ? ['yes', 'no'] : info.accepted.filter(a => !['rejected'].includes((info.values.find(v => v.value === a) || {}).status));
      const cur = current === null ? '' : current;
      const match = values.find(v => normaliseName(v) === normaliseName(cur)) ||
        (info.kind === 'boolean' && cur ? (['yes', 'true', '1'].includes(cur.toLowerCase()) ? 'yes' : 'no') : '');
      return `<select id="${id}" class="stk-select stk-select-sm stk-mono" data-nosave>` +
        `<option value=""${match ? '' : ' selected'}>not set: default ${esc(info.default || 'none')}</option>` +
        values.map(v => `<option value="${esc(v)}"${v === match ? ' selected' : ''}>${esc(v)}</option>`).join('') + '</select>';
    }
    return `<input type="text" id="${id}" class="stk-input stk-input-sm stk-mono" data-nosave value="${esc(current === null ? '' : current)}" ` +
      `placeholder="not set: default ${esc(info.default === '' ? 'none' : info.default)}" autocomplete="off" spellcheck="false">`;
  }

  function renderDetail(name, fv = fileValues()) {
    const entry = s.rows.get(name);
    if (!entry) return;
    const { row, info } = entry;
    const body = row.querySelector('.gx-opt-b');
    const p = fv.plan;
    const id = `gxOptEdit_${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const inFile = Object.prototype.hasOwnProperty.call(fv.values, name) ? fv.values[name] : null;
    const gen = Object.prototype.hasOwnProperty.call(fv.generated, name) ? fv.generated[name] : null;
    const mineKey = Object.keys(fv.mine).find(k => normaliseName(k) === normaliseName(name));
    const mine = mineKey !== undefined;
    const kv = [
      ['Section', `<a href="${esc(info.section.url)}" target="_blank" rel="noopener" class="sg-link">${esc(info.section.title)}</a>`],
      ['Takes', esc(KIND_TEXT[info.kind] || info.kind) + (info.per ? `, one per <code>${esc(info.per)}</code> group` : '') + (info.count ? `, ${info.count} values` : '')],
      ['Default', info.default === '' ? (info.defaultFrom ? `from <code>${esc(info.defaultFrom)}</code>` : 'none') : `<code>${esc(info.default)}</code>`]
    ];
    if (info.unit) kv.push(['Unit', esc(info.unit)]);
    if (info.readWhen) kv.push(['Read', `only when <code>${esc(info.readWhen.when)}</code>`]);
    const values = info.values.length ? `<ul class="gx-opt-values">${info.values.map(v => `<li><a href="${esc(v.url)}" target="_blank" rel="noopener"><code>${esc(v.value)}</code></a>` +
      `${v.status ? ` <span class="stk-badge ${STATUS_BADGE[v.status] || 'stk-badge-warn'}">${esc(v.status)}</span>` : ''} ${esc(v.summary)}${v.note ? ` <span class="gx-opt-note">${esc(v.note)}</span>` : ''}</li>`).join('')}</ul>` : '';
    const cases = info.cases.length ? `<ul class="gx-opt-values">${info.cases.map(c => `<li><a href="${esc(c.url)}" target="_blank" rel="noopener"><code>${esc(c.value)}</code></a> ${esc(c.summary)}</li>`).join('')}</ul>` : '';
    const related = info.related.length ? `<p class="gx-opt-rel">See also ${info.related.map(r => `<button type="button" class="gx-opt-jump" data-jump="${esc(r)}">${esc(r)}</button>`).join(' ')}</p>` : '';
    let where;
    if (!p) where = '<p class="stk-hint">Switch a stage on to set values.</p>';
    else {
      const state = mine ? (fv.mine[mineKey] === null ? `You removed it from <code>${esc(p.file)}</code>` : `You set it in <code>${esc(p.file)}</code>${gen !== null ? `; the builder writes <code>${esc(gen)}</code>` : ''}`)
        : inFile !== null ? `<code>${esc(p.file)}</code> sets <code>${esc(inFile)}</code>, as the builder writes it`
          : `Not in <code>${esc(p.file)}</code>: grompp uses the default${info.default === '' ? '' : ` (<code>${esc(info.default)}</code>)`}`;
      where = `<div class="gx-opt-edit">
        <p class="gx-opt-state">${state}.</p>
        <label for="${id}" class="sr-only">Value of ${esc(name)} in ${esc(p.file)}</label>
        <div class="gx-opt-editrow">${valueEditor(info, inFile, id)}
          <button type="button" class="stk-btn stk-btn-sm stk-btn-primary" data-opt-set="one">Set</button>
          <button type="button" class="stk-btn stk-btn-sm" data-opt-set="all" title="Set it in every .mdp file of the workflow">Every file</button>
          ${mine ? '<button type="button" class="stk-btn stk-btn-sm stk-btn-ghost" data-opt-set="reset">Reset to generated</button>' : ''}
          <button type="button" class="stk-btn stk-btn-sm stk-btn-ghost" data-opt-set="show" aria-label="Show ${esc(p.file)}"><i class="fa-regular fa-file-lines" aria-hidden="true"></i></button>
        </div>
      </div>`;
    }
    body.innerHTML = `<dl class="stk-kv gx-opt-kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${info.status && info.status.note ? `<p class="gx-opt-note">${esc(info.status.note)}</p>` : ''}
      ${values}${cases}${where}${related}
      <div class="gx-opt-more">
        <button type="button" class="stk-btn stk-btn-sm stk-btn-ghost" data-opt-docs aria-expanded="false"><i class="fa-solid fa-book-open" aria-hidden="true"></i> The manual's text</button>
        <a href="${esc(info.url)}" target="_blank" rel="noopener" class="sg-link">Open in the GROMACS ${esc(MDP_RELEASE)} manual <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>
      </div>
      <div class="gx-opt-docs" data-docs hidden></div>`;
  }

  function toggle(name, open) {
    const entry = s.rows.get(name);
    if (!entry) return;
    const btn = entry.row.querySelector('.gx-opt-h');
    const body = entry.row.querySelector('.gx-opt-b');
    const want = open === undefined ? btn.getAttribute('aria-expanded') !== 'true' : open;
    btn.setAttribute('aria-expanded', String(want));
    body.hidden = !want;
    entry.row.classList.toggle('is-open', want);
    if (want) { s.open.add(name); renderDetail(name); } else s.open.delete(name);
  }

  function jump(name) {
    const info = optionInfo(name);
    const target = info && !info.obsolete ? info.name : name;
    const find = (t) => (s.rows.has(t) ? t : [...s.rows.keys()].find(n => normaliseName(n) === normaliseName(t)));
    // Numbered families are listed by their first member: pull-coord2-k is pull-coord1-k.
    const key = find(target) || find(target.replace(/\d+/g, '1'));
    if (!key) return;
    if ($('gxOptFind')) $('gxOptFind').value = '';
    if ($('gxOptSection')) $('gxOptSection').value = '';
    if ($('gxOptOnly')) $('gxOptOnly').checked = false;
    filter();
    toggle(key, true);
    const btn = s.rows.get(key).row.querySelector('.gx-opt-h');
    btn.scrollIntoView({ block: 'start' });
    btn.focus({ preventScroll: true });
  }

  function onClick(e) {
    const head = e.target.closest('.gx-opt-h');
    if (head) { toggle(head.parentElement.dataset.name); return; }
    const j = e.target.closest('[data-jump]');
    if (j) { jump(j.getAttribute('data-jump')); return; }
    const docLink = e.target.closest('a[data-mdp]');
    if (docLink && docLink.closest('[data-docs]')) {
      e.preventDefault();
      jump(docLink.getAttribute('data-mdp'));
      return;
    }
    const row = e.target.closest('.gx-opt');
    if (!row) return;
    const name = row.dataset.name;
    const docsBtn = e.target.closest('[data-opt-docs]');
    if (docsBtn) {
      const host = row.querySelector('[data-docs]');
      const open = docsBtn.getAttribute('aria-expanded') !== 'true';
      docsBtn.setAttribute('aria-expanded', String(open));
      host.hidden = !open;
      if (open && !host.dataset.loaded) {
        host.innerHTML = '<p class="stk-hint">Loading the manual...</p>';
        loadMdpDocs().then((docs) => {
          const html = docs.option(name);
          const info = s.rows.get(name).info;
          const valueHtml = info.values.map(v => {
            const t = docs.value(name, v.value);
            return t ? `<h4><code>${esc(v.value)}</code></h4>${t}` : '';
          }).join('');
          host.innerHTML = (html || valueHtml) ? `${html}${valueHtml}` : '<p class="stk-hint">The manual has no text of its own for this option.</p>';
          host.querySelectorAll('a[href]:not([data-mdp])').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
          host.dataset.loaded = '1';
        }).catch(() => { host.innerHTML = '<p class="stk-hint">The manual text could not be loaded.</p>'; });
      }
      return;
    }
    const act = e.target.closest('[data-opt-set]');
    if (!act) return;
    const p = stageFile();
    if (!p) return;
    const kind = act.getAttribute('data-opt-set');
    if (kind === 'show') { gx.showFile(p.key); return; }
    if (kind === 'reset') {
      const fv = fileValues();
      const k = Object.keys(fv.mine).find(x => normaliseName(x) === normaliseName(name));
      gx.setOverride(p.key, k || name, undefined);
      ctx.showToast(`${name} in ${p.file} is back to what the builder writes.`, 'ok');
      return;
    }
    const input = row.querySelector(`#gxOptEdit_${CSS.escape(name.replace(/[^A-Za-z0-9_-]/g, '_'))}`);
    const raw = input ? String(input.value).trim() : '';
    const value = raw === '' ? null : raw;
    const targets = kind === 'all' ? gx.plan().stages : [p];
    for (const t of targets) {
      const gen = parseMdp(t.generatedText).values;
      const same = value !== null && Object.prototype.hasOwnProperty.call(gen, name) && normaliseName(gen[name]) === normaliseName(value);
      const absent = value === null && !Object.prototype.hasOwnProperty.call(gen, name);
      gx.setOverride(t.key, name, same || absent ? undefined : value);
    }
    ctx.showToast(`${name} ${value === null ? 'removed from' : `= ${value} in`} ${kind === 'all' ? 'every .mdp file' : p.file}.`, 'ok');
  }

  if (list) {
    list.addEventListener('click', onClick);
    list.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('.gx-opt-edit input')) {
        e.preventDefault();
        e.target.closest('.gx-opt').querySelector('[data-opt-set="one"]').click();
      }
    });
  }
  $('gxOptFind')?.addEventListener('input', () => { clearTimeout(s.timer); s.timer = setTimeout(filter, 90); });
  $('gxOptSection')?.addEventListener('change', filter);
  $('gxOptOnly')?.addEventListener('change', filter);
  $('gxOptFile')?.addEventListener('change', (e) => { s.file = e.target.value; filter(); });

  return {
    show() { build(); fileSelect(); filter(); },
    refresh() { if (!s.built || $('gxOptBox')?.hidden) return; fileSelect(); refreshValues(); },
    jump(name) { build(); fileSelect(); filter(); jump(name); }
  };
}

/* ------------------------------------------------------------------ *
 * Check a file
 * ------------------------------------------------------------------ */

const LEVELS = {
  error: { label: 'Error', plural: 'errors', icon: 'fa-circle-xmark' },
  warning: { label: 'Warning', plural: 'warnings', icon: 'fa-triangle-exclamation' },
  note: { label: 'Note', plural: 'notes', icon: 'fa-circle-info' }
};

/**
 * @param {object} ctx - Page helpers.
 * @param {object} gx - The GROMACS tab (see createGromacsOptions), plus `load()`,
 *   `readState()`, `index()`, `forceField()`, `files()`.
 */
export function createGromacsCheck(ctx, gx) {
  const { $, escapeHtml: esc, showToast } = ctx;
  const s = { tab: 'issues', timer: 0, result: null, guess: null };
  const text = () => ($('gxChkText') ? $('gxChkText').value : '');

  function context(parsed) {
    const ff = $('gxChkFf') ? $('gxChkFf').value : '';
    const c = {};
    if (ff) {
      c.forceField = ff;
      c.system = ff === 'martini3' ? 'coarse-grained' : 'all-atom';
    }
    const idx = gx.index();
    if (idx.loaded() && $('gxChkNdx') && $('gxChkNdx').checked) c.indexGroups = idx.names();
    return c;
  }

  function jumpTo(line) {
    const area = $('gxChkText');
    if (!area) return;
    const lines = area.value.split('\n');
    let start = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
    area.focus();
    area.setSelectionRange(start, start + (lines[line - 1] || '').length);
    const lh = parseFloat(getComputedStyle(area).lineHeight) || 18;
    area.scrollTop = Math.max(0, (line - 3) * lh);
  }

  const lineBtn = (line) => (line ? `<button type="button" class="sg-issue-line" data-line="${line}" title="Show line ${line}">Line ${line}</button>` : '<span class="gx-chk-noline">Not set</span>');

  function run() {
    const t = text();
    const verdict = $('gxChkVerdict');
    const issuesHost = $('gxChkIssues');
    const explainHost = $('gxChkExplain');
    const importBtn = $('gxChkImport');
    if (!t.trim()) {
      s.result = null;
      if (verdict) { verdict.innerHTML = ''; verdict.className = 'gx-verdict'; }
      if (issuesHost) issuesHost.innerHTML = '<p class="sg-cv-empty">Paste an <code>.mdp</code> file above, drop it on the box, or take one the builder wrote. It is read the way grompp reads it and checked against grompp\'s own rules, as you type.</p>';
      if (explainHost) explainHost.innerHTML = '';
      if (importBtn) importBtn.disabled = true;
      return;
    }
    const parsed = parseMdp(t);
    const maxwarn = Math.max(0, parseInt($('gxChkMaxwarn')?.value || '0', 10) || 0);
    const r = checkMdp(parsed, { context: context(parsed), maxwarn });
    s.result = r;
    const g = r.grompp;
    const mdrun = r.issues.filter(i => i.source === 'mdrun' && i.severity === 'error').length;
    let cls = 'is-ok';
    let head;
    if (g.errors) { cls = 'is-bad'; head = `grompp will stop: ${g.errors} error${g.errors === 1 ? '' : 's'}.`; }
    else if (!g.passes) { cls = 'is-warn'; head = `grompp will stop at ${g.warnings} warning${g.warnings === 1 ? '' : 's'}, unless run with -maxwarn ${g.warnings}.`; }
    else if (mdrun) { cls = 'is-bad'; head = `grompp accepts it, but mdrun will stop (${mdrun}).`; }
    else head = g.warnings ? `grompp will pass with -maxwarn ${maxwarn} (${g.warnings} warning${g.warnings === 1 ? '' : 's'} allowed).` : 'grompp will pass.';
    const counts = ['error', 'warning', 'note'].map(l => {
      const n = r.issues.filter(i => i.severity === l && i.source === 'grompp').length;
      return n ? `<span class="stk-badge ${l === 'error' ? 'stk-badge-danger' : l === 'warning' ? 'stk-badge-warn' : 'stk-badge-accent'}">${n} ${n === 1 ? LEVELS[l].label.toLowerCase() : LEVELS[l].plural}</span>` : '';
    }).join('');
    const advice = r.issues.filter(i => i.source === 'advice').length;
    if (verdict) {
      verdict.className = `gx-verdict ${cls}`;
      verdict.innerHTML = `<i class="fa-solid ${cls === 'is-ok' ? 'fa-circle-check' : cls === 'is-warn' ? 'fa-triangle-exclamation' : 'fa-circle-xmark'}" aria-hidden="true"></i>` +
        `<div><p class="gx-verdict-h">${esc(head)}</p><p class="gx-verdict-c">${parsed.entries.length} options${counts ? ' · ' : ''}${counts}` +
        `${advice ? ` <span class="stk-badge">${advice} suggestion${advice === 1 ? '' : 's'}</span>` : ''} <span class="gx-verdict-vs">against GROMACS ${esc(MDP_RELEASE)}</span></p></div>`;
    }
    if (issuesHost) {
      const groups = [
        ['Errors: grompp stops', r.issues.filter(i => i.severity === 'error' && i.source !== 'mdrun'), 'error'],
        ['mdrun will stop', r.issues.filter(i => i.source === 'mdrun' && i.severity === 'error'), 'error'],
        ['Warnings: grompp stops without -maxwarn', r.issues.filter(i => i.severity === 'warning' && i.source === 'grompp'), 'warning'],
        ['Notes from grompp', r.issues.filter(i => i.severity === 'note' && i.source === 'grompp'), 'note'],
        ['Suggestions', r.issues.filter(i => i.source === 'advice' || (i.source === 'mdrun' && i.severity !== 'error')), 'note']
      ].filter(x => x[1].length);
      issuesHost.innerHTML = groups.length ? groups.map(([title, list, level]) => `<h3 class="gx-chk-h">${esc(title)} <span class="gx-chk-n">${list.length}</span></h3>
        <ul class="sg-issues">${list.map(i => `<li class="sg-issue sg-issue-${level}">
          <span class="gx-chk-where"><i class="fa-solid ${LEVELS[level].icon}" aria-hidden="true"></i><span class="sr-only">${LEVELS[level].label}, </span>${lineBtn(i.line)}</span>
          <p>${i.option ? `<a href="${esc(i.url)}" target="_blank" rel="noopener" class="gx-chk-opt"><code>${esc(i.option)}</code></a> ` : ''}${esc(i.message)}` +
          `${i.assumes ? ` <span class="gx-opt-note">Assumed: ${esc(i.assumes)}</span>` : ''}</p>
        </li>`).join('')}</ul>`).join('')
        : '<p class="sg-cv-empty">No problems found. The checks follow grompp\'s own; run <code>gmx grompp</code> with your topology for the final word.</p>';
    }
    if (explainHost) {
      const rows = explainMdp(parsed, { context: context(parsed) });
      explainHost.innerHTML = `<ol class="gx-xl">${rows.filter(x => x.kind !== 'blank').map(x => {
        if (x.kind === 'comment') return '';
        const worst = x.issues.find(i => i.severity === 'error') || x.issues.find(i => i.severity === 'warning');
        const tags = [];
        if (x.isDefault) tags.push('<span class="stk-badge">default</span>');
        if (x.status !== 'ok') tags.push(`<span class="stk-badge ${x.status === 'unknown' || x.status === 'duplicate' ? 'stk-badge-danger' : 'stk-badge-warn'}">${esc(x.status)}</span>`);
        return `<li class="gx-xl-row${worst ? ` gx-xl-${worst.severity}` : ''}"><div class="gx-xl-top">` +
          `<button type="button" class="sg-issue-line gx-xl-no" data-line="${x.line}" title="Show line ${x.line}">${x.line}</button>` +
          `<code class="gx-xl-name">${esc(x.name || x.text.split('=')[0].trim())}</code><code class="gx-xl-val">= ${esc(x.value)}</code>${tags.join('')}` +
          `${x.url ? `<a class="gx-xl-link" href="${esc(x.valueUrl || x.url)}" target="_blank" rel="noopener">Manual<span class="sr-only">: ${esc(x.name || '')}</span> <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : ''}</div>` +
          `<p class="gx-xl-mean">${esc(x.meaning)}</p>${x.summary && !x.meaning.startsWith(x.summary) ? `<p class="gx-xl-sum">${esc(x.summary)}</p>` : ''}</li>`;
      }).join('')}</ol>`;
    }
    // What the builder would open it as.
    s.guess = builderFromMdp(t, gx.readState());
    const sel = $('gxChkStage');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = GX_STAGES.map(d => `<option value="${d.key}">${d.key === s.guess.stage ? `As ${esc(d.label.toLowerCase())} (detected)` : `As ${esc(d.label.toLowerCase())}`}</option>`).join('');
      sel.value = sel.dataset.user === '1' && cur ? cur : s.guess.stage;
    }
    if (importBtn) importBtn.disabled = !parsed.entries.length;
  }

  function schedule() { clearTimeout(s.timer); s.timer = setTimeout(run, 180); }

  function setText(v) {
    if ($('gxChkText')) $('gxChkText').value = v;
    if ($('gxChkStage')) $('gxChkStage').dataset.user = '';
    run();
  }

  function readFile(file) {
    if (!file) return;
    if (file.size > 1024 * 1024) { showToast(`${file.name} is larger than 1 MB; an .mdp file is a few kilobytes.`, 'danger'); return; }
    file.text().then((t) => { setText(t); showToast(`${file.name}: ${t.split('\n').length} lines read.`, 'ok'); })
      .catch(() => showToast(`Could not read ${file.name}.`, 'danger'));
  }

  function openInBuilder() {
    const t = text();
    if (!t.trim()) return;
    const stage = $('gxChkStage')?.value || (s.guess && s.guess.stage) || 'prod';
    const current = gx.readState();
    const guess = builderFromMdp(t, current);
    // Load the shared choices and the stage, then keep as options set by
    // hand whatever the builder would still write differently.
    gx.load(stage, guess.shared, guess.stageState, null);
    const p = gx.plan().stages.find(x => x.key === stage);
    const overrides = p ? diffOverrides(t, p.generatedText) : {};
    gx.load(stage, {}, {}, overrides);
    const n = Object.keys(overrides).length;
    const file = GX_STAGE[stage].label.toLowerCase();
    showToast(`Opened as ${file}${n ? `: ${n} option${n === 1 ? '' : 's'} kept as you set ${n === 1 ? 'it' : 'them'} (see All options)` : ''}.` +
      `${guess.notes.length ? ` ${guess.notes.join(' ')}` : ''}`, 'ok');
    gx.showFile(stage);
  }

  const bind = (id, ev, fn) => { if ($(id)) $(id).addEventListener(ev, fn); };
  bind('gxChkText', 'input', schedule);
  bind('gxChkOpen', 'click', () => $('gxChkFile') && $('gxChkFile').click());
  bind('gxChkFile', 'change', (e) => { readFile(e.target.files && e.target.files[0]); e.target.value = ''; });
  bind('gxChkCurrent', 'click', () => {
    const list = gx.files();
    const f = list.find(x => x.id === gx.currentFileId() && x.kind === 'mdp') || list.find(x => x.kind === 'mdp');
    if (!f) { showToast('Switch a stage on first: the builder has no .mdp file to check.', 'warn'); return; }
    setText(f.text);
    if ($('gxChkFf')) $('gxChkFf').value = gx.forceField();
    if ($('gxChkMaxwarn')) $('gxChkMaxwarn').value = String(f.plan.maxwarn || 0);
    run();
  });
  bind('gxChkClear', 'click', () => setText(''));
  bind('gxChkFf', 'change', run);
  bind('gxChkMaxwarn', 'input', schedule);
  bind('gxChkNdx', 'change', run);
  bind('gxChkImport', 'click', openInBuilder);
  bind('gxChkStage', 'change', (e) => { e.target.dataset.user = '1'; });
  document.querySelectorAll('[data-gx-chk]').forEach((b) => {
    b.addEventListener('click', () => {
      s.tab = b.getAttribute('data-gx-chk');
      document.querySelectorAll('[data-gx-chk]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      if ($('gxChkIssues')) $('gxChkIssues').hidden = s.tab !== 'issues';
      if ($('gxChkExplain')) $('gxChkExplain').hidden = s.tab !== 'explain';
    });
  });
  ['gxChkIssues', 'gxChkExplain'].forEach((id) => {
    bind(id, 'click', (e) => {
      const b = e.target.closest('[data-line]');
      if (b) jumpTo(Number(b.getAttribute('data-line')));
    });
  });
  const drop = $('gxChkText');
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

  return {
    show() {
      if ($('gxChkFf') && !$('gxChkFf').dataset.touched && !text().trim()) $('gxChkFf').value = gx.forceField();
      run();
    },
    /* The index may have come or gone. */
    refreshContext() {
      const wrap = $('gxChkNdxWrap');
      if (wrap) wrap.hidden = !gx.index().loaded();
    }
  };
}

