/*
 * STEMKit, MD Workflow Generator: every LAMMPS command and style.
 * Author: Olanrewaju M. Daramola
 *
 * The LAMMPS counterpart of the GROMACS tab's "All options": every command
 * and style of the release the reference describes (src/core/lammps-reference.js,
 * through lammps-input.js), searchable and filtered by kind. A row opens to
 * its syntax, keywords, package, accelerated variants and defaults, with the
 * manual page; the rows the run files use are marked, with the lines.
 *
 * There are about two thousand entries, so the list is drawn a page at a
 * time; the keyword tables load the first time a row is opened.
 */

const PAGE = 120;

/**
 * @param {object} ctx - Page helpers.
 * @param {object} lx - The LAMMPS tab: `core()`, `plan()`, `showFile(name)`, `files()`.
 */
export function createLammpsReference(ctx, lx) {
  const { $, escapeHtml: esc } = ctx;
  const s = { built: false, shown: PAGE, open: new Set(), timer: 0, used: new Map(), usedFor: null, list: [] };
  const list = $('lxRefList');

  const api = () => { const c = lx.core(); return c && c.input; };

  /* Where the run files use each command and style: key -> [{file, line}]. */
  function usedMap() {
    const a = api();
    const wf = lx.plan();
    if (!a || !wf) return new Map();
    if (s.usedFor === wf) return s.used;
    const used = new Map();
    for (const f of wf.files.filter(x => x.kind === 'lammps')) {
      for (const l of a.parseInput(f.text).lines) {
        if (l.kind !== 'command') continue;
        const keys = [l.command];
        const pos = { fix: 2, compute: 2, dump: 2, region: 1 }[l.command];
        const style = pos !== undefined ? l.args[pos] : (a.styleKind && a.styleKind(l.command) ? l.args[0] : null);
        if (style) {
          const info = a.commandInfo(l.command, style);
          if (info) keys.push(`${info.command} ${info.base}`);
        }
        for (const k of keys) {
          if (!used.has(k)) used.set(k, []);
          used.get(k).push({ file: f.name, line: l.line });
        }
      }
    }
    s.used = used;
    s.usedFor = wf;
    return used;
  }

  const keyOf = (info) => (info.kind === 'command' ? info.base : `${info.command} ${info.base}`);

  function build() {
    const a = api();
    if (s.built || !list || !a) return;
    s.built = true;
    const sel = $('lxRefKind');
    if (sel) {
      sel.innerHTML = '<option value="">Every kind</option>' +
        a.COMMAND_KINDS.map(k => `<option value="${esc(k.id)}">${esc(k.label)}</option>`).join('');
    }
  }

  /* The entries the bar asks for, in order. */
  function entries() {
    const a = api();
    if (!a) return [];
    const q = ($('lxRefFind')?.value || '').trim();
    const kind = $('lxRefKind')?.value || '';
    const only = !!$('lxRefOnly')?.checked;
    let out = q ? a.searchCommands(q, { kind, limit: 400 }) : a.listCommands({ kind });
    if (only) {
      const used = usedMap();
      out = out.filter(i => used.has(keyOf(i)));
    }
    return out;
  }

  function filter() {
    if (!list) return;
    build();
    const a = api();
    if (!a) {
      list.innerHTML = '<p class="sg-cv-empty">Loading the LAMMPS reference...</p>';
      return;
    }
    s.list = entries();
    s.shown = PAGE;
    draw();
  }

  function draw() {
    const q = ($('lxRefFind')?.value || '').trim();
    const a = api();
    const used = usedMap();
    const rows = s.list.slice(0, s.shown);
    const kinds = new Map(a.COMMAND_KINDS.map(k => [k.id, k.label]));
    const html = [];
    let last = '';
    for (const info of rows) {
      if (!q && info.kind !== last) {
        html.push(`<h3 class="gx-opt-sec"><span>${esc(kinds.get(info.kind) || info.kind)}</span></h3>`);
        last = info.kind;
      }
      html.push(rowHtml(info, used));
    }
    if (!rows.length) {
      html.push(`<p class="gx-opt-none sg-cv-empty">${q ? `Nothing matches "${esc(q)}". Try a word from what it does, such as "thermostat" or "long-range".` : 'Nothing here.'}</p>`);
    }
    if (s.list.length > s.shown) {
      html.push(`<div class="lx-ref-more"><button type="button" class="stk-btn stk-btn-sm" data-ref-more>Show ${Math.min(PAGE, s.list.length - s.shown)} more of ${s.list.length - s.shown}</button></div>`);
    }
    list.innerHTML = html.join('');
    list.classList.toggle('is-search', !!q);
    for (const key of s.open) {
      const row = list.querySelector(`.gx-opt[data-key="${CSS.escape(key)}"]`);
      if (row) openRow(row, true);
    }
    const count = $('lxRefCount');
    if (count) count.textContent = `${s.list.length.toLocaleString('en-GB')}${q ? ' found' : ''}`;
  }

  function idFor(key) { return `lxRef_${key.replace(/[^A-Za-z0-9_-]/g, '_')}`; }

  function rowHtml(info, used) {
    const key = keyOf(info);
    const id = idFor(key);
    const tags = [];
    if (info.removed) tags.push('<span class="stk-badge stk-badge-danger">removed</span>');
    if (info.package) tags.push(`<span class="stk-badge">${esc(info.package)}</span>`);
    const inFiles = used.get(key);
    const mark = inFiles ? `<span class="gx-opt-val is-mine">in ${esc([...new Set(inFiles.map(u => u.file))].join(', '))}</span>` : '<span class="gx-opt-val"></span>';
    return `<div class="gx-opt${inFiles ? ' is-used' : ''}" data-key="${esc(key)}">` +
      `<button type="button" class="gx-opt-h" id="${id}" aria-expanded="false" aria-controls="${id}_b">` +
      `<span class="gx-opt-top"><code class="gx-opt-name">${esc(key)}</code>${tags.join('')}${mark}</span>` +
      `<span class="gx-opt-sum">${esc(info.summary || (info.category ? `${info.category} command.` : ''))}</span></button>` +
      `<div class="gx-opt-b" id="${id}_b" role="region" aria-labelledby="${id}" hidden></div></div>`;
  }

  function detailHtml(info) {
    const a = api();
    const used = usedMap().get(keyOf(info)) || [];
    const kv = [];
    kv.push(['Kind', esc((a.COMMAND_KINDS.find(k => k.id === info.kind) || {}).label || info.kind)]);
    kv.push(['Package', info.package ? `${esc(info.package)}${info.packages && info.packages.length > 1 ? ` (a build needs ${esc(info.packages.join(', '))})` : ''}` : 'Core LAMMPS: every build has it']);
    if (info.accelerators && info.accelerators.length) {
      kv.push(['Accelerated', info.accelerators.map(x => `<code>${esc(info.base)}/${esc(x)}</code>`).join(' ')]);
    }
    if (info.category) kv.push(['Group', esc(info.category)]);
    const syntax = info.syntax ? `<pre class="lx-ref-syntax">${esc(info.syntax)}</pre>` : '';
    const args = info.args && info.args.length ? `<p class="gx-opt-state">Arguments: ${info.args.map(x => `<code>${esc(x)}</code>`).join(' ')}</p>` : '';
    const details = a.lammpsDetailsLoaded && a.lammpsDetailsLoaded();
    let kw = '';
    if (info.keywords && info.keywords.length) {
      kw = `<h4 class="lx-ref-h">Keywords</h4><ul class="gx-opt-values">${info.keywords.map(k => `<li><code>${esc(k.name)}</code>` +
        `${k.choices ? ` ${k.choices.map(c => `<code>${esc(c)}</code>`).join(' | ')}` : k.values && k.values.length ? ` <code>${esc(k.values.join(' '))}</code>` : ''}` +
        `${k.units && Object.keys(k.units).length ? ` <span class="gx-opt-note">(${esc(Object.entries(k.units).map(([n, u]) => `${n} in ${u}`).join(', '))})</span>` : ''}</li>`).join('')}</ul>`;
    } else if (!details) {
      kw = '<p class="stk-hint" data-ref-loading>Loading the keywords...</p>';
    }
    let defaults = '';
    if (info.defaults) {
      const d = Array.isArray(info.defaults) ? info.defaults : Object.entries(info.defaults).map(([k, v]) => `${k} = ${v}`);
      if (d.length) defaults = `<h4 class="lx-ref-h">Defaults</h4><ul class="gx-opt-values">${d.map(x => `<li><code>${esc(x)}</code></li>`).join('')}</ul>`;
    }
    const where = used.length
      ? `<div class="gx-opt-edit"><p class="gx-opt-state">Your files use it: ${used.slice(0, 12).map(u => `<button type="button" class="gx-opt-jump" data-ref-go="${esc(u.file)}" data-ref-line="${u.line}">${esc(u.file)}:${u.line}</button>`).join(' ')}${used.length > 12 ? ` and ${used.length - 12} more` : ''}</p></div>`
      : '';
    const removed = info.removed ? `<p class="gx-bad">${esc(info.removed.note)}</p>` : '';
    return `<dl class="stk-kv gx-opt-kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${removed}${syntax}${args}${kw}${defaults}${where}
      <div class="gx-opt-more">${info.url ? `<a href="${esc(info.url)}" target="_blank" rel="noopener" class="sg-link">Open ${esc(info.page || 'the page')} in the LAMMPS manual <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : '<span class="gx-opt-note">No page of its own in the manual.</span>'}</div>`;
  }

  function openRow(row, want) {
    const a = api();
    const btn = row.querySelector('.gx-opt-h');
    const body = row.querySelector('.gx-opt-b');
    const key = row.dataset.key;
    btn.setAttribute('aria-expanded', String(want));
    body.hidden = !want;
    row.classList.toggle('is-open', want);
    if (!want) { s.open.delete(key); return; }
    s.open.add(key);
    const info = a.commandInfo(key);
    body.innerHTML = info ? detailHtml(info) : '<p class="stk-hint">Not in the reference.</p>';
    if (a.loadLammpsDetails && !a.lammpsDetailsLoaded()) {
      a.loadLammpsDetails().then(() => {
        if (s.open.has(key) && row.isConnected) body.innerHTML = detailHtml(a.commandInfo(key));
      }).catch(() => {
        const l = body.querySelector('[data-ref-loading]');
        if (l) l.textContent = 'The keyword table could not be loaded.';
      });
    }
  }

  function jump(key) {
    const a = api();
    if (!a) return;
    if ($('lxRefFind')) $('lxRefFind').value = '';
    if ($('lxRefKind')) $('lxRefKind').value = '';
    if ($('lxRefOnly')) $('lxRefOnly').checked = false;
    const info = a.commandInfo(key);
    if (!info) return;
    s.list = a.listCommands({ kind: info.kind });
    if ($('lxRefKind')) $('lxRefKind').value = info.kind;
    const i = s.list.findIndex(x => keyOf(x) === keyOf(info));
    s.shown = Math.max(PAGE, i + 20);
    s.open.add(keyOf(info));
    draw();
    const row = list.querySelector(`.gx-opt[data-key="${CSS.escape(keyOf(info))}"]`);
    if (row) {
      const btn = row.querySelector('.gx-opt-h');
      btn.scrollIntoView({ block: 'start' });
      btn.focus({ preventScroll: true });
    }
  }

  if (list) {
    list.addEventListener('click', (e) => {
      const head = e.target.closest('.gx-opt-h');
      if (head) {
        const row = head.parentElement;
        openRow(row, head.getAttribute('aria-expanded') !== 'true');
        return;
      }
      const more = e.target.closest('[data-ref-more]');
      if (more) { s.shown += PAGE; draw(); return; }
      const go = e.target.closest('[data-ref-go]');
      if (go) lx.showFile(go.getAttribute('data-ref-go'), Number(go.getAttribute('data-ref-line')));
    });
  }
  $('lxRefFind')?.addEventListener('input', () => { clearTimeout(s.timer); s.timer = setTimeout(filter, 110); });
  $('lxRefKind')?.addEventListener('change', filter);
  $('lxRefOnly')?.addEventListener('change', filter);

  return {
    show() { filter(); },
    refresh() {
      if (!s.built || $('lxRefBox')?.hidden) return;
      s.usedFor = null;
      const shown = s.shown;
      s.list = entries();
      s.shown = shown;
      draw();
    },
    jump(key) { build(); jump(key); }
  };
}
