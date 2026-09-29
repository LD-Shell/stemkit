/*
 * STEMKit, MD Workflow Generator: checking a PLUMED input that already exists.
 * Author: Olanrewaju M. Daramola
 *
 * The file is read, checked and explained by src/core/plumed-parse.js; this
 * module shows the result and hands the file to the builder on request.
 */

import { lintPlumedInput, explainPlumedInput, importPlumedInput } from '../src/core/plumed-parse.js';
import { messageToHtml } from '../src/core/plumed.js';

const LEVELS = {
  error: { label: 'Error', badge: 'stk-badge-danger', icon: 'fa-circle-xmark', plural: 'errors' },
  warning: { label: 'Warning', badge: 'stk-badge-warn', icon: 'fa-triangle-exclamation', plural: 'warnings' },
  note: { label: 'Note', badge: 'stk-badge-accent', icon: 'fa-circle-info', plural: 'notes' }
};

/**
 * @param {object} ctx - Page helpers.
 * @param {object} builder - The PLUMED builder: `syntax()`, `version()`,
 *        `natoms()`, `currentInput()`, `load(config, fields)`.
 */
export function createPlumedCheck(ctx, builder) {
  const { $, escapeHtml, showToast } = ctx;
  const state = { tab: 'issues', timer: 0 };

  const text = () => ($('plumedCheckText') ? $('plumedCheckText').value : '');

  function jumpTo(line) {
    const area = $('plumedCheckText');
    if (!area) return;
    const lines = area.value.split('\n');
    let start = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
    const end = start + (lines[line - 1] || '').length;
    area.focus();
    area.setSelectionRange(start, end);
    // Bring the line into view: the caret alone does not scroll a textarea.
    const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 18;
    area.scrollTop = Math.max(0, (line - 3) * lineHeight);
  }

  function renderSummary(result) {
    const host = $('plumedCheckSummary');
    if (!host) return;
    if (!text().trim()) { host.innerHTML = ''; return; }
    const s = result.summary;
    const chip = (n, level) => (n
      ? `<span class="stk-badge ${LEVELS[level].badge}">${n} ${n === 1 ? LEVELS[level].label.toLowerCase() : LEVELS[level].plural}</span>`
      : '');
    const clean = !s.errors && !s.warnings;
    host.innerHTML =
      `<span class="stk-badge">${s.actions} action${s.actions === 1 ? '' : 's'}</span>` +
      chip(s.errors, 'error') + chip(s.warnings, 'warning') + chip(s.notes, 'note') +
      (clean ? '<span class="stk-badge stk-badge-ok"><i class="fa-solid fa-check" aria-hidden="true"></i> Nothing that stops PLUMED</span>' : '') +
      `<span class="sg-check-against">against PLUMED ${escapeHtml(builder.version())}` +
      `${builder.syntax() ? '' : ', structure only'}</span>`;
  }

  function renderIssues(result) {
    const host = $('plumedCheckIssues');
    if (!host) return;
    if (!text().trim()) {
      host.innerHTML = '<p class="sg-cv-empty">Paste a <code>plumed.dat</code> above, drop the file on the box, or ' +
        'take the file the builder has written. It is checked as you type: action and keyword names, ' +
        'labels and what refers to them, atom numbers, grids and the order of the lines.</p>';
      return;
    }
    if (!result.issues.length) {
      host.innerHTML = '<p class="sg-cv-empty">No problems found. The checks cover what can be seen in the file; ' +
        'run <code>plumed driver --parse-only</code> on the machine that runs the job for the final word.</p>';
      return;
    }
    host.innerHTML = `<ul class="sg-issues">${result.issues.map((i) => {
      const l = LEVELS[i.level];
      return `<li class="sg-issue sg-issue-${i.level}">
        <button type="button" class="sg-issue-line" data-line="${i.line}" title="Show line ${i.line}">
          <i class="fa-solid ${l.icon}" aria-hidden="true"></i><span class="sr-only">${l.label}, </span>Line ${i.line}</button>
        <p>${messageToHtml(i.text)}</p>
      </li>`;
    }).join('')}</ul>`;
    host.querySelectorAll('[data-line]').forEach((el) => {
      el.addEventListener('click', () => jumpTo(Number(el.getAttribute('data-line'))));
    });
  }

  function renderExplain() {
    const host = $('plumedCheckExplain');
    if (!host) return;
    const items = explainPlumedInput(text(), { syntax: builder.syntax() });
    if (!items.length) {
      host.innerHTML = '<p class="sg-cv-empty">Each action of the file is explained here in plain words: what it ' +
        'computes, what every keyword means and which later lines use its value.</p>';
      return;
    }
    host.innerHTML = items.map((e) => {
      const rows = e.keywords.map(k => `<tr>
          <th scope="row"><code>${escapeHtml(k.key)}</code></th>
          <td><code>${k.value === null ? 'on' : escapeHtml(k.value)}</code></td>
          <td>${escapeHtml(k.meaning)}</td>
        </tr>`).join('');
      const where = e.endLine > e.line ? `Lines ${e.line} to ${e.endLine}` : `Line ${e.line}`;
      return `<article class="sg-explain">
        <header>
          <button type="button" class="sg-issue-line" data-line="${e.line}" title="Show it in the file">${where}</button>
          <code class="sg-explain-name">${e.label ? `${escapeHtml(e.label)}: ` : ''}${escapeHtml(e.action)}</code>
          ${e.link ? `<a class="plumed-doclink" href="${escapeHtml(e.link)}" target="_blank" rel="noopener">Manual <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : ''}
        </header>
        <p>${escapeHtml(e.summary)}${e.outputs ? ` ${messageToHtml(e.outputs)}` : ''}</p>
        ${rows ? `<div class="sg-explain-scroll"><table class="sg-explain-t"><tbody>${rows}</tbody></table></div>` : ''}
      </article>`;
    }).join('');
    host.querySelectorAll('[data-line]').forEach((el) => {
      el.addEventListener('click', () => jumpTo(Number(el.getAttribute('data-line'))));
    });
  }

  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll('[data-check-tab]').forEach((b) => {
      b.setAttribute('aria-selected', b.getAttribute('data-check-tab') === tab ? 'true' : 'false');
    });
    if ($('plumedCheckIssues')) $('plumedCheckIssues').hidden = tab !== 'issues';
    if ($('plumedCheckExplain')) $('plumedCheckExplain').hidden = tab !== 'explain';
  }

  function run() {
    const result = lintPlumedInput(text(), { syntax: builder.syntax(), natoms: builder.natoms() });
    renderSummary(result);
    renderIssues(result);
    renderExplain();
    const btn = $('plumedCheckImport');
    if (btn) btn.disabled = !result.summary.actions;
    return result;
  }

  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(run, 200);
  }

  function setText(value) {
    const area = $('plumedCheckText');
    if (!area) return;
    area.value = value;
    run();
  }

  function readFile(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showToast(`${file.name} is larger than 2 MB; a PLUMED input is a few kilobytes.`, 'danger');
      return;
    }
    file.text().then((t) => {
      setText(t);
      showToast(`${file.name} read, ${t.split('\n').length} lines.`, 'ok');
    }).catch(() => showToast(`Could not read ${file.name}.`, 'danger'));
  }

  function openInBuilder() {
    const { config, notes, fields } = importPlumedInput(text());
    builder.load(config, fields);
    const host = $('plumedCheckNotes');
    if (host) {
      host.hidden = !notes.length;
      host.innerHTML = notes.length
        ? `<i class="fa-solid fa-circle-info" aria-hidden="true"></i><div class="sg-warn-list">` +
          '<p><strong>Opened in the builder, with these changes:</strong></p>' +
          notes.map(n => `<p>${messageToHtml(n)}</p>`).join('') + '</div>'
        : '';
    }
    showToast(
      `Opened in the builder: ${config.cvs.length} variable${config.cvs.length === 1 ? '' : 's'}, ` +
      `${config.functions.length} function${config.functions.length === 1 ? '' : 's'}.`, 'ok');
    if (!notes.length) builder.showView('input');
  }

  const on = (id, event, fn) => { if ($(id)) $(id).addEventListener(event, fn); };
  on('plumedCheckText', 'input', schedule);
  on('plumedCheckOpen', 'click', () => $('plumedCheckFile') && $('plumedCheckFile').click());
  on('plumedCheckFile', 'change', (e) => {
    readFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });
  on('plumedCheckCurrent', 'click', () => setText(builder.currentInput()));
  on('plumedCheckClear', 'click', () => {
    setText('');
    if ($('plumedCheckNotes')) $('plumedCheckNotes').hidden = true;
  });
  on('plumedCheckImport', 'click', openInBuilder);
  document.querySelectorAll('[data-check-tab]').forEach((b) => {
    b.addEventListener('click', () => showTab(b.getAttribute('data-check-tab')));
  });

  const drop = $('plumedCheckText');
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

  showTab('issues');
  return { run, setText };
}
