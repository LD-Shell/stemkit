/*
 * STEMKit, MD Workflow Generator: checking a LAMMPS input that already exists.
 * Author: Olanrewaju M. Daramola
 *
 * Paste, drop or open an input: it is read as LAMMPS reads it and followed
 * top to bottom (src/core/lammps-input.js), and the page says what LAMMPS
 * would stop on, what it warns about and what helps, then explains every
 * line. With the output of `lmp -h` pasted, the check knows the packages of
 * the user's build. A data file dropped here is summarised and checked by
 * src/core/lammps-data.js instead.
 */

import { SEVERITY, expandIncludes, packagesFromHelp, basicRows, followsIncludes } from './script-generator-lammps-model.js';

/* A data file: a count line ("N atoms") and an Atoms section. */
const looksLikeData = (t) => /^\s*\d+\s+atoms\s*$/m.test(t) && /^\s*Atoms\b/m.test(t);

/**
 * @param {object} ctx - Page helpers.
 * @param {object} lx - The LAMMPS tab: `core()`, `files()`, `currentFileId()`, `showFile()`.
 */
export function createLammpsCheck(ctx, lx) {
  const { $, escapeHtml: esc, showToast } = ctx;
  const s = { tab: 'issues', timer: 0, packages: null, dataResult: null, dataName: '', builderFile: '' };
  const text = () => ($('lxChkText') ? $('lxChkText').value : '');
  const api = () => { const c = lx.core(); return c && c.input; };

  const codeHtml = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
  const lineBtn = (line) => (line ? `<button type="button" class="sg-issue-line" data-line="${line}" title="Show line ${line}">Line ${line}</button>` : '<span class="gx-chk-noline">Whole file</span>');

  function jumpTo(line) {
    const area = $('lxChkText');
    if (!area) return;
    const lines = area.value.split('\n');
    let start = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
    area.focus();
    area.setSelectionRange(start, start + (lines[line - 1] || '').length);
    const lh = parseFloat(getComputedStyle(area).lineHeight) || 18;
    area.scrollTop = Math.max(0, (line - 3) * lh);
  }

  /* The text with the builder's files it includes read in, when it names
     them: a stage input checked on its own lacks its shared settings. */
  function withIncludes(t) {
    const builder = (lx.files() || []).filter(f => f.kind === 'lammps');
    if (!builder.length || !/include\s/.test(t)) return { text: t, map: null, read: [] };
    // A checker that follows includes is given the builder's files.
    if (followsIncludes(api())) {
      const read = builder.filter(f => new RegExp(`include\\s+["']?${f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["'\\s]|$)`, 'm').test(t)).map(f => f.name);
      return { text: t, map: null, read, files: Object.fromEntries(builder.map(f => [f.name, f.text])) };
    }
    const byName = new Map(builder.map(f => [f.name, f]));
    byName.set('\u0000checked', { text: t });
    const ex = expandIncludes('\u0000checked', byName);
    if (!ex.includes.length) return { text: t, map: null, read: [] };
    return { text: `${ex.lines.join('\n')}\n`, map: ex.map, read: [...new Set(ex.includes)] };
  }

  function options() {
    return s.packages ? { packages: s.packages.packages } : {};
  }

  function run() {
    const a = api();
    const t = text();
    const verdict = $('lxChkVerdict');
    const issuesHost = $('lxChkIssues');
    const explainHost = $('lxChkExplain');
    renderData();
    if (!t.trim()) {
      if (verdict) { verdict.innerHTML = ''; verdict.className = 'gx-verdict'; }
      if (issuesHost) {
        issuesHost.innerHTML = s.dataResult ? '' : '<p class="sg-cv-empty">Paste a LAMMPS input above, drop it on the box, or take one the builder wrote. It is read the way LAMMPS reads it and followed line by line, as you type: what LAMMPS would stop on, what it warns about, and what each line does.</p>';
      }
      if (explainHost) explainHost.innerHTML = '';
      return;
    }
    if (!a || !a.checkInput) {
      if (verdict) { verdict.className = 'gx-verdict'; verdict.innerHTML = '<i class="fa-solid fa-spinner" aria-hidden="true"></i><div><p class="gx-verdict-h">Loading the LAMMPS checker...</p></div>'; }
      return;
    }
    const inc = withIncludes(t);
    const opts = inc.files ? { ...options(), files: inc.files } : options();
    let r;
    let rows = [];
    try { r = a.checkInput(inc.text, opts); } catch (e) { r = { issues: [{ line: 0, severity: 'error', message: `The checker failed on this input: ${e.message}` }], state: {} }; }
    try { rows = a.explainInput ? a.explainInput(inc.text, opts) : basicRows(a, { name: '', text: inc.text }); } catch (_) { rows = []; }
    // Rows and issues of a file the checker read for an include belong to it.
    if (inc.files) {
      rows = rows.filter(x => !x.file);
      r = { ...r, issues: (r.issues || []).map(i => (i.file ? { ...i, line: 0, message: `${i.file}, line ${i.line}: ${i.message}` } : i)) };
    }
    // Back to the lines of the text as the box shows it.
    const own = (n) => {
      if (!inc.map) return { line: n, mine: true };
      const at = inc.map[(n || 1) - 1];
      return at && at.file === '\u0000checked' ? { line: at.line, mine: true } : { line: at ? at.line : 0, mine: false, file: at ? at.file : '' };
    };
    const issues = (r.issues || []).map((i) => {
      const at = own(i.line);
      return at.mine ? { ...i, line: i.line ? at.line : 0 } : { ...i, line: 0, message: `${at.file}, line ${at.line}: ${i.message}` };
    });
    rows = rows.map(x => ({ ...x, at: own(x.line) })).filter(x => x.at.mine && !(inc.map && inc.map[x.line - 1] && inc.map[x.line - 1].include))
      .map(x => ({ ...x, line: x.at.line }));
    const errors = issues.filter(i => i.severity === 'error');
    // The error LAMMPS meets first in the order the script runs (which, in
    // a loop or after a jump, need not be the lowest line).
    const first = errors.length > 1 && r.firstError ? (() => { const at = own(r.firstError.line); return at.mine && !r.firstError.file ? { ...r.firstError, line: r.firstError.line ? at.line : 0 } : null; })() : null;
    const warnings = issues.filter(i => i.severity === 'warning');
    const notes = issues.filter(i => i.severity === 'note');
    const st = r.state || {};
    let cls = 'is-ok';
    let head;
    if (errors.length) { cls = 'is-bad'; head = `LAMMPS will stop: ${errors.length} error${errors.length === 1 ? '' : 's'}.`; }
    else if (warnings.length) { cls = 'is-warn'; head = `LAMMPS will run, with ${warnings.length} warning${warnings.length === 1 ? '' : 's'} to read.`; }
    else head = 'No problems found.';
    const commands = rows.filter(x => x.kind === 'command').length;
    const counts = [['error', errors.length], ['warning', warnings.length], ['note', notes.length]].filter(([, n]) => n)
      .map(([l, n]) => `<span class="stk-badge ${SEVERITY[l].badge}">${n} ${l}${n === 1 ? '' : 's'}</span>`).join('');
    const facts = [];
    if (st.units) facts.push(`units ${st.units}`);
    if (Array.isArray(st.runs) && st.runs.length) {
      const total = st.runs.reduce((acc, x) => acc + (Number(x.steps) || 0), 0);
      facts.push(`${st.runs.length} run${st.runs.length === 1 ? '' : 's'}${total ? `, ${total.toLocaleString('en-GB')} steps` : ''}`);
    }
    const against = `against LAMMPS ${esc(a.LAMMPS_VERSION || '')}${s.packages ? `, with your build's ${s.packages.packages.length} packages` : ''}`;
    if (verdict) {
      verdict.className = `gx-verdict ${cls}`;
      verdict.innerHTML = `<i class="fa-solid ${cls === 'is-ok' ? 'fa-circle-check' : cls === 'is-warn' ? 'fa-triangle-exclamation' : 'fa-circle-xmark'}" aria-hidden="true"></i>` +
        `<div><p class="gx-verdict-h">${esc(head)}</p><p class="gx-verdict-c">${commands} command${commands === 1 ? '' : 's'}${facts.length ? `, ${esc(facts.join(', '))}` : ''}${counts ? ' · ' : ''}${counts}` +
        ` <span class="gx-verdict-vs">${against}</span></p>` +
        `${first ? `<p class="gx-verdict-raw">LAMMPS stops first at ${first.line ? `<button type="button" class="sg-issue-line lx-first" data-line="${first.line}">line ${first.line}</button>` : 'the end'}: ${codeHtml(first.message)}</p>` : ''}` +
        `${inc.read.length ? `<p class="gx-verdict-raw">Read with ${esc(inc.read.join(', '))} from the builder, which its <code>include</code> line${inc.read.length === 1 ? ' names' : 's name'}.</p>` : ''}</div>`;
    }
    if (issuesHost) {
      const groups = [
        ['Errors: LAMMPS stops', errors, 'error'],
        ['Warnings: LAMMPS runs, but read these', warnings, 'warning'],
        ['Notes', notes, 'note']
      ].filter(x => x[1].length);
      issuesHost.innerHTML = groups.length ? groups.map(([title, list, level]) => `<h3 class="gx-chk-h">${esc(title)} <span class="gx-chk-n">${list.length}</span></h3>
        <ul class="sg-issues">${list.map(i => `<li class="sg-issue sg-issue-${level}">
          <span class="gx-chk-where"><i class="fa-solid ${SEVERITY[level].icon}" aria-hidden="true"></i><span class="sr-only">${SEVERITY[level].label}, </span>${lineBtn(i.line)}</span>
          <p>${codeHtml(i.message)}${i.url ? ` <a href="${esc(i.url)}" target="_blank" rel="noopener" class="sg-link">Manual</a>` : ''}</p>
        </li>`).join('')}</ul>`).join('')
        : '<p class="sg-cv-empty">No problems found. The checks follow LAMMPS\'s own reading of the input; a short run with your data file is the final word.</p>';
    }
    if (explainHost) {
      explainHost.innerHTML = `<ol class="gx-xl">${rows.filter(x => x.kind === 'command').map((x) => {
        const iss = (x.issues || []);
        const worst = iss.find(i => i.severity === 'error') || iss.find(i => i.severity === 'warning');
        const tags = [];
        if (x.package) tags.push(`<span class="stk-badge">${esc(x.package)}</span>`);
        if (x.status && x.status !== 'ok') {
          const lvl = x.status === 'error' || x.status === 'unknown' ? 'error' : 'warning';
          tags.push(`<span class="stk-badge ${SEVERITY[lvl].badge}">${esc(x.status)}</span>`);
        }
        return `<li class="gx-xl-row${worst ? ` gx-xl-${worst.severity}` : ''}"><div class="gx-xl-top">` +
          `<button type="button" class="sg-issue-line gx-xl-no" data-line="${x.line}" title="Show line ${x.line}">${x.line}</button>` +
          `<code class="gx-xl-name">${esc(x.title || x.command || '')}</code>${tags.join('')}` +
          `${x.url ? `<a class="gx-xl-link" href="${esc(x.url)}" target="_blank" rel="noopener">Manual<span class="sr-only">: ${esc(x.title || x.command || '')}</span> <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : ''}</div>` +
          `<p class="gx-xl-val lx-xl-text"><code>${esc(String(x.text || '').replace(/\s*#.*$/, ''))}</code></p>` +
          `${x.meaning ? `<p class="gx-xl-mean">${codeHtml(x.meaning)}</p>` : ''}${x.summary && !(x.meaning || '').startsWith(x.summary) ? `<p class="gx-xl-sum">${codeHtml(x.summary)}</p>` : ''}` +
          `${iss.map(i => `<p class="gx-issue gx-issue-${SEVERITY[i.severity] ? SEVERITY[i.severity].cls : 'note'}"><i class="fa-solid ${(SEVERITY[i.severity] || SEVERITY.note).icon}" aria-hidden="true"></i><span>${codeHtml(i.message)}</span></p>`).join('')}</li>`;
      }).join('')}</ol>`;
    }
  }

  /* A data file dropped here: its summary and what is wrong with it. */
  function renderData() {
    const host = $('lxChkData');
    if (!host) return;
    const d = s.dataResult;
    host.hidden = !d;
    if (!d) { host.innerHTML = ''; return; }
    const sum = d.summary || {};
    const issues = (d.parsed && d.parsed.issues) || [];
    const fmt = (n, k = 0) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: k });
    const facts = [`${fmt(sum.natoms || 0)} atoms`, `${(sum.types || []).length} types`];
    if (sum.molecules) facts.push(`${fmt(sum.molecules)} molecules`);
    if (Number.isFinite(sum.charge)) facts.push(`net charge ${Math.abs(sum.charge) < 5e-4 ? '0' : fmt(sum.charge, 4)} e`);
    if (Number.isFinite(sum.density)) facts.push(`${fmt(sum.density, 3)} g/cm³`);
    if (sum.water && sum.water.model) facts.push(`${sum.water.model} water`);
    host.innerHTML = `<div class="lx-chk-data-h"><p><i class="fa-solid fa-database" aria-hidden="true"></i> <strong>${esc(s.dataName)}</strong>: ${esc(facts.join(', '))}.</p>` +
      '<button type="button" class="stk-btn stk-btn-sm" data-chk-data-clear><i class="fa-solid fa-xmark" aria-hidden="true"></i> Remove</button></div>' +
      `<p class="stk-hint">${(sum.types || []).map(t => `type ${t.type}: ${t.element || '?'} (${fmt(t.count || 0)})`).join(' · ')}</p>` +
      (issues.length ? issues.map(i => {
        const sv = SEVERITY[i.severity] || SEVERITY.warning;
        return `<p class="gx-issue gx-issue-${sv.cls}"><i class="fa-solid ${sv.icon}" aria-hidden="true"></i><span>${i.line ? `Line ${i.line}: ` : ''}${esc(i.message)}</span></p>`;
      }).join('') : '<p class="gx-ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> The data file reads cleanly.</p>');
  }

  function schedule() { clearTimeout(s.timer); s.timer = setTimeout(run, 180); }

  function setText(v) {
    if ($('lxChkText')) $('lxChkText').value = v;
    run();
  }

  function readFile(file) {
    if (!file) return;
    if (file.size > 256 * 1024 * 1024) { showToast(`${file.name} is larger than 256 MB.`, 'danger'); return; }
    file.text().then((t) => {
      if (looksLikeData(t)) {
        const d = lx.readData ? lx.readData(t) : null;
        if (!d) { showToast('The data-file reader is still loading; drop it again in a moment.', 'warn'); return; }
        s.dataResult = d;
        s.dataName = file.name;
        run();
        showToast(`${file.name}: a data file, summarised above the input.`, 'ok');
        return;
      }
      setText(t.replace(/\r\n?/g, '\n'));
      showToast(`${file.name}: ${t.split('\n').length} lines read.`, 'ok');
    }).catch(() => showToast(`Could not read ${file.name}.`, 'danger'));
  }

  function readHelp() {
    const raw = $('lxChkHelp') ? $('lxChkHelp').value : '';
    const out = $('lxChkPkgs');
    if (!raw.trim()) {
      s.packages = null;
      if (out) out.textContent = '';
    } else {
      s.packages = packagesFromHelp(raw);
      if (out) {
        out.innerHTML = s.packages
          ? `${s.packages.version ? `${esc(s.packages.version)}: ` : ''}${s.packages.packages.length} packages, ${s.packages.packages.map(p => `<code>${esc(p)}</code>`).join(' ')}.`
          : 'No "Installed packages:" list in this text: paste everything <code>lmp -h</code> prints.';
      }
    }
    run();
  }

  const bind = (id, ev, fn) => { if ($(id)) $(id).addEventListener(ev, fn); };
  bind('lxChkText', 'input', schedule);
  bind('lxChkHelp', 'input', () => { clearTimeout(s.timer); s.timer = setTimeout(readHelp, 250); });
  bind('lxChkOpen', 'click', () => $('lxChkFile') && $('lxChkFile').click());
  bind('lxChkFile', 'change', (e) => { readFile(e.target.files && e.target.files[0]); e.target.value = ''; });
  bind('lxChkCurrent', 'click', () => {
    const list = lx.files() || [];
    const f = list.find(x => x.id === lx.currentFileId() && x.kind === 'lammps') || list.find(x => x.kind === 'lammps');
    if (!f) { showToast('Switch a stage on first: the builder has no input to check.', 'warn'); return; }
    setText(f.text);
    showToast(`${f.name} from the builder.`, 'ok');
  });
  bind('lxChkClear', 'click', () => { s.dataResult = null; setText(''); });
  document.querySelectorAll('[data-lx-chk]').forEach((b) => {
    b.addEventListener('click', () => {
      s.tab = b.getAttribute('data-lx-chk');
      document.querySelectorAll('[data-lx-chk]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      if ($('lxChkIssues')) $('lxChkIssues').hidden = s.tab !== 'issues';
      if ($('lxChkExplain')) $('lxChkExplain').hidden = s.tab !== 'explain';
    });
  });
  ['lxChkIssues', 'lxChkExplain'].forEach((id) => {
    bind(id, 'click', (e) => {
      const b = e.target.closest('[data-line]');
      if (b) jumpTo(Number(b.getAttribute('data-line')));
    });
  });
  bind('lxChkVerdict', 'click', (e) => {
    const btn = e.target.closest('[data-line]');
    if (btn) jumpTo(Number(btn.getAttribute('data-line')));
  });
  bind('lxChkData', 'click', (e) => {
    if (e.target.closest('[data-chk-data-clear]')) { s.dataResult = null; run(); }
  });
  const drop = $('lxChkText');
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
    show() { run(); },
    /** The checker has loaded: check what is in the box. */
    coreArrived() { if (!$('lxChkBox')?.hidden) run(); }
  };
}
