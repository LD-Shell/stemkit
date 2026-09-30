/*
 * STEMKit, MD Workflow Generator: reading what a PLUMED run wrote.
 * Author: Olanrewaju M. Daramola
 *
 * A COLVAR from a trial run gives the hill widths and grids for the builder;
 * a HILLS file gives the free-energy surface and shows whether the bias has
 * settled. The numbers come from src/core/plumed-analysis.js, which is tested
 * against PLUMED's own sum_hills. Plotly is fetched when the first file is
 * dropped, not with the page.
 */

import {
  parseColvar, fileKind, hillsVariables, columnSummary, suggestBias, driftOf, sumHills,
  fesOverTime, hillHeights, reweight, thermalEnergy
} from '../src/core/plumed-analysis.js';

const PLOTLY_SRC = 'js/dependencies/plotly.min.js';
const MAX_BYTES = 300 * 1024 * 1024;
const NON_NEGATIVE = /^(DISTANCE|COORDINATION|COORDINATIONNUMBER|GYRATION|RMSD|DRMSD|CONTACTMAP|Q[346]|LOCAL_Q[346]|ALPHARMSD|ANTIBETARMSD|PARABETARMSD|VOLUME)/;
const ENERGY_LABEL = { 'kj/mol': 'kJ/mol', 'kcal/mol': 'kcal/mol', eV: 'eV', Ha: 'Hartree' };

let plotlyLoading = null;
function loadPlotly() {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  if (!plotlyLoading) {
    plotlyLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PLOTLY_SRC;
      s.onload = () => resolve(window.Plotly);
      s.onerror = () => { plotlyLoading = null; reject(new Error('plotly')); };
      document.head.appendChild(s);
    });
  }
  return plotlyLoading;
}

/**
 * @param {object} ctx - Page helpers.
 * @param {object} builder - `targets()`, `applySuggestions(list)`,
 *        `temperature()`, `energyUnit()`.
 */
export function createPlumedAnalyse(ctx, builder) {
  const { $, escapeHtml, showToast, downloadText } = ctx;
  const state = { colvar: null, colvarName: '', hills: null, hillsName: '', column: '', along: '', suggestions: [] };

  const fmt = (v, digits = 3) => (Number.isFinite(v) ? Number(v.toPrecision(digits)).toString() : '–');
  const unit = () => ENERGY_LABEL[builder.energyUnit()] || builder.energyUnit();

  /* Colours follow the page theme; the two series colours were checked for
     colour-blind separation and contrast on each surface. */
  function theme() {
    const dark = document.documentElement.classList.contains('dark');
    const css = getComputedStyle(document.documentElement);
    const v = (n, d) => (css.getPropertyValue(n).trim() || d);
    return {
      dark,
      series: dark ? '#4f8fcb' : '#1f5c96',
      second: dark ? '#d95926' : '#eb6834',
      text: v('--stk-fg', dark ? '#f1f5f9' : '#0f172a'),
      muted: v('--stk-fg-3', dark ? '#94a3b8' : '#64748b'),
      grid: v('--stk-border', dark ? '#1e293b' : '#e2e8f0'),
      surface: v('--stk-surface', dark ? '#0f172a' : '#ffffff')
    };
  }

  function layout(t, xTitle, yTitle, extra = {}) {
    const axis = (title) => ({
      title: { text: title, font: { size: 12, color: t.muted }, standoff: 8 },
      color: t.muted, gridcolor: t.grid, zerolinecolor: t.grid, linecolor: t.grid,
      tickfont: { size: 11, color: t.muted }, automargin: true
    });
    return {
      margin: { l: 56, r: 16, t: 12, b: 44 },
      height: 280,
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'Inter, system-ui, sans-serif', color: t.text, size: 12 },
      xaxis: axis(xTitle),
      yaxis: axis(yTitle),
      showlegend: false,
      hovermode: 'x unified',
      hoverlabel: { bgcolor: t.surface, bordercolor: t.grid, font: { color: t.text, size: 12 } },
      ...extra
    };
  }

  const CONFIG = { displayModeBar: false, responsive: true };

  function draw(id, traces, lay) {
    const el = $(id);
    if (!el) return;
    loadPlotly().then((Plotly) => {
      Plotly.react(el, traces, lay, CONFIG);
    }).catch(() => {
      el.innerHTML = '<p class="stk-hint">The chart library could not be loaded. The numbers above and the ' +
        'downloads still work.</p>';
    });
  }

  /* One hue, faint to strong, for the same surface at later and later times.
     The faintest still has 3:1 contrast with the surface. */
  function ramp(t, n) {
    const from = t.dark ? [70, 120, 170] : [100, 148, 194];
    const to = t.dark ? [147, 197, 253] : [20, 62, 105];
    return Array.from({ length: n }, (_, i) => {
      const k = n === 1 ? 1 : i / (n - 1);
      const c = from.map((a, j) => Math.round(a + (to[j] - a) * k));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    });
  }

  /* ---------------------------------------------------------------- *
   * COLVAR
   * ---------------------------------------------------------------- */

  function valueColumns(c) {
    return c.fields.filter(f => f !== 'time' && !/\.(bias|rbias|rct|work|force2|zed|neff|nker)$/.test(f));
  }

  function biasColumn(c) {
    return c.fields.find(f => /\.rbias$/.test(f)) || c.fields.find(f => /\.bias$/.test(f)) || '';
  }

  function renderColvar() {
    const wrap = $('plumedAnColvar');
    if (!wrap) return;
    const c = state.colvar;
    wrap.hidden = !c;
    if (!c) return;
    const cols = valueColumns(c);
    if (!cols.includes(state.column)) state.column = cols[0] || '';

    const targets = builder.targets();
    const biased = c.fields.some(f => /\.(bias|rbias)$/.test(f));
    state.suggestions = [];
    const rows = cols.map((name) => {
      const period = c.periods[name] || null;
      const target = targets.find(t => t.arg === name);
      const s = suggestBias(c.columns[name], {
        period, nonNegative: !!(target && NON_NEGATIVE.test(target.type))
      });
      const drift = driftOf(c.columns[name], period);
      const sum = s ? s.summary : columnSummary(c.columns[name], period);
      if (s && s.sigma && target) state.suggestions.push({ arg: name, ...s });
      return `<tr>
        <th scope="row"><code>${escapeHtml(name)}</code>${target ? ' <span class="stk-badge stk-badge-accent">biased</span>' : ''}</th>
        <td>${fmt(sum.mean)}</td><td>${fmt(sum.sd)}</td><td>${fmt(sum.min)} to ${fmt(sum.max)}</td>
        <td>${s && s.sigma ? `<code>${escapeHtml(s.sigma)}</code>` : '–'}</td>
        <td>${s && s.sigma ? `<code>${escapeHtml(s.min)}</code> to <code>${escapeHtml(s.max)}</code>, <code>${escapeHtml(s.bin)}</code> bins` : '–'}</td>
        <td>${drift.drifting ? '<span class="stk-badge stk-badge-warn">still drifting</span>' : ''}</td>
      </tr>`;
    }).join('');

    $('plumedAnColvarHead').innerHTML =
      `<strong>${escapeHtml(state.colvarName)}</strong>: ${c.rows.toLocaleString('en-GB')} rows, ` +
      `${cols.length} value${cols.length === 1 ? '' : 's'}.` +
      (c.errors.length ? ` ${escapeHtml(c.errors.join(' '))}` : '');
    $('plumedAnTable').innerHTML = rows;
    $('plumedAnAdvice').innerHTML = biased
      ? 'This run was biased, so the spread of a biased variable is wider than its fluctuation in one basin. ' +
        'Take hill widths from a run with the method set to None.'
      : 'Sigma is half the standard deviation; the grid is wider than the range seen, since the bias will ' +
        'push the variable further. A variable marked as drifting had not settled, so its spread overstates ' +
        'its fluctuation: run longer, or use the last part of the run.';
    const apply = $('plumedAnApply');
    if (apply) {
      apply.disabled = !state.suggestions.length || biased;
      apply.textContent = biased
        ? 'A biased run gives no hill widths'
        : state.suggestions.length
          ? `Use for ${state.suggestions.map(s => s.arg).join(', ')}`
          : 'No column matches a biased variable';
    }

    const sel = $('plumedAnColumn');
    sel.innerHTML = cols.map(n => `<option value="${escapeHtml(n)}"${n === state.column ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    drawColvar();
    renderReweight();
  }

  function drawColvar() {
    const c = state.colvar;
    if (!c || !state.column) return;
    const t = theme();
    const y = c.columns[state.column];
    const x = c.columns.time || Float64Array.from(y, (_, i) => i);
    // A long run is thinned for drawing; the statistics use every row.
    const step = Math.max(1, Math.floor(y.length / 4000));
    const xs = [];
    const ys = [];
    for (let i = 0; i < y.length; i += step) { xs.push(x[i]); ys.push(y[i]); }
    draw('plumedAnTrace', [{
      x: xs, y: ys, type: 'scattergl', mode: 'lines', line: { color: t.series, width: 1.5 },
      name: state.column, hovertemplate: `%{y:.4g}<extra></extra>`
    }], layout(t, c.columns.time ? 'Time' : 'Row', state.column));
  }

  function renderReweight() {
    const c = state.colvar;
    const wrap = $('plumedAnReweight');
    if (!wrap) return;
    const bias = c ? biasColumn(c) : '';
    wrap.hidden = !bias;
    if (!bias) return;
    const kT = thermalEnergy(builder.temperature(), builder.energyUnit());
    const skip = Math.floor(c.rows * (/\.rbias$/.test(bias) ? 0 : 0.2));
    const r = reweight(c.columns[state.column], c.columns[bias], {
      kT, bins: 60, skip, period: c.periods[state.column] || undefined
    });
    const note = $('plumedAnReweightNote');
    if (!r) {
      note.textContent = 'There is too little to reweight.';
      return;
    }
    note.innerHTML =
      `Each frame is weighted by exp(V/kT) with V from <code>${escapeHtml(bias)}</code>, at ` +
      `${escapeHtml(String(builder.temperature()))} K (kT = ${fmt(kT)} ${escapeHtml(unit())}). ` +
      `${r.frames.toLocaleString('en-GB')} frames carry the weight of ` +
      `<strong>${Math.round(r.effective).toLocaleString('en-GB')}</strong> equally weighted ones.` +
      (skip ? ` The first fifth of the run is left out, since <code>${escapeHtml(bias)}</code> still grows there; ` +
        'print <code>metad.rbias</code> with <code>CALC_RCT</code> to use the whole run.' : '') +
      (r.effective < 50 ? ' <strong>That is too few to trust the surface.</strong>' : '');
    const t = theme();
    draw('plumedAnReweightPlot', [{
      x: Array.from(r.x), y: Array.from(r.f), type: 'scatter', mode: 'lines+markers',
      line: { color: t.series, width: 2 }, marker: { size: 5, color: t.series },
      connectgaps: false, hovertemplate: `%{y:.3g} ${unit()}<extra></extra>`
    }], layout(t, state.column, `Free energy (${unit()})`));
  }

  /* ---------------------------------------------------------------- *
   * HILLS
   * ---------------------------------------------------------------- */

  function renderHills() {
    const wrap = $('plumedAnHills');
    if (!wrap) return;
    const h = state.hills;
    wrap.hidden = !h;
    if (!h) return;
    const vars = hillsVariables(h.fields);
    const heights = hillHeights(h);
    const t = theme();
    const last = h.columns.time ? h.columns.time[h.rows - 1] : h.rows;

    let verdict;
    if (!heights.tempered) {
      verdict = 'The run is not well-tempered, so every hill has the same height and the surface keeps ' +
        'oscillating by about that much. Average the surface over the last part of the run.';
    } else if (heights.ratio < 0.1) {
      verdict = `The hills have fallen to <strong>${Math.round(heights.ratio * 100)}%</strong> of their first ` +
        'height: the bias changes slowly now. Check below that the surface has stopped changing shape too.';
    } else if (heights.ratio < 0.4) {
      verdict = `The hills are at <strong>${Math.round(heights.ratio * 100)}%</strong> of their first height: ` +
        'the basins in reach are filling, and the run is not finished.';
    } else {
      verdict = `The hills are still at <strong>${Math.round(heights.ratio * 100)}%</strong> of their first ` +
        'height: the run is at an early stage, or the variable keeps finding new ground.';
    }
    $('plumedAnHillsHead').innerHTML =
      `<strong>${escapeHtml(state.hillsName)}</strong>: ${h.rows.toLocaleString('en-GB')} hills on ` +
      `${vars.map(v => `<code>${escapeHtml(v)}</code>`).join(' and ')}, up to time ${fmt(last, 5)}` +
      `${heights.tempered ? `, bias factor ${fmt(heights.biasFactor)}` : ''}. ${verdict}`;

    draw('plumedAnHeights', [{
      x: heights.time, y: heights.height, type: 'scatter', mode: 'lines',
      line: { color: t.series, width: 2 }, hovertemplate: `%{y:.3g} ${unit()}<extra></extra>`
    }], layout(t, 'Time', `Hill height (${unit()})`, { height: 220 }));

    const along = $('plumedAnAlong');
    const opts = vars.length > 1 ? [...vars, vars.slice(0, 2).join(' , ')] : vars;
    if (!opts.includes(state.along)) state.along = opts[opts.length - 1];
    along.innerHTML = opts.map(o => `<option value="${escapeHtml(o)}"${o === state.along ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
    along.parentElement.hidden = opts.length < 2;
    drawFes();
  }

  function drawFes() {
    const h = state.hills;
    if (!h) return;
    const t = theme();
    const two = state.along.includes(' , ');
    const note = $('plumedAnFesNote');
    if (two) {
      const s = sumHills(h, { variables: state.along.split(' , '), bins: 100 });
      const z = [];
      for (let j = 0; j < s.shape[1]; j++) {
        const row = [];
        for (let i = 0; i < s.shape[0]; i++) row.push(s.f[i * s.shape[1] + j]);
        z.push(row);
      }
      // One hue: the deep basins dark on a light page, light on a dark one.
      const scale = t.dark
        ? [[0, '#bfdbfe'], [0.5, '#3b82c4'], [1, '#0f172a']]
        : [[0, '#143e69'], [0.5, '#6da5d6'], [1, '#f4f8fc']];
      draw('plumedAnFes', [{
        x: Array.from(s.x), y: Array.from(s.y), z, type: 'heatmap', colorscale: scale, zsmooth: 'best',
        colorbar: { title: { text: unit(), font: { size: 11, color: t.muted } }, thickness: 12, len: 0.9, tickfont: { size: 10, color: t.muted }, outlinewidth: 0 },
        hovertemplate: `${s.variables[0]} %{x:.3g}<br>${s.variables[1]} %{y:.3g}<br>%{z:.3g} ${unit()}<extra></extra>`
      }], layout(t, s.variables[0], s.variables[1], { height: 340, hovermode: 'closest', margin: { l: 56, r: 8, t: 12, b: 44 } }));
      note.innerHTML = `The surface is the negative sum of all ${s.hills.toLocaleString('en-GB')} hills, as ` +
        '<code>plumed sum_hills</code> gives it, with its lowest point at zero. Dark is low.';
      state.fes = s;
      return;
    }
    const slices = fesOverTime(h, { variable: state.along, slices: 5, bins: 300 });
    const colours = ramp(t, slices.length);
    const traces = slices.map((s, i) => ({
      x: Array.from(s.x), y: Array.from(s.f), type: 'scatter', mode: 'lines',
      name: `to ${fmt(s.time, 4)}`,
      line: { color: colours[i], width: i === slices.length - 1 ? 2.5 : 1.5 },
      hovertemplate: `%{y:.3g} ${unit()}<extra>to ${fmt(s.time, 4)}</extra>`
    }));
    draw('plumedAnFes', traces, layout(t, state.along, `Free energy (${unit()})`, {
      height: 320, showlegend: true,
      legend: { orientation: 'h', y: -0.28, x: 0, font: { size: 11, color: t.muted }, title: { text: 'Hills summed ', font: { size: 11, color: t.muted } } },
      margin: { l: 56, r: 16, t: 12, b: 76 }
    }));
    const lastTwo = slices.slice(-2);
    let change = 0;
    if (lastTwo.length === 2) {
      // Compare where the surface is low enough to be sampled, below 16 kT.
      const low = 16 * thermalEnergy(builder.temperature(), builder.energyUnit());
      for (let i = 0; i < lastTwo[0].f.length; i++) {
        if (lastTwo[1].f[i] < low) change = Math.max(change, Math.abs(lastTwo[1].f[i] - lastTwo[0].f[i]));
      }
    }
    note.innerHTML = 'Each line sums the hills up to a time; the darkest is the whole run. Lines that lie on top ' +
      'of one another say the surface has stopped changing. ' +
      (lastTwo.length === 2
        ? `Over the last fifth of the run it moved by at most <strong>${fmt(change)} ${escapeHtml(unit())}</strong>.`
        : '');
    state.fes = { variables: [state.along], x: slices[slices.length - 1].x, y: null, f: slices[slices.length - 1].f };
  }

  function downloadFes() {
    const s = state.fes;
    if (!s) return;
    const lines = [];
    if (s.y) {
      lines.push(`#! FIELDS ${s.variables[0]} ${s.variables[1]} file.free`);
      for (let j = 0; j < s.y.length; j++) {
        for (let i = 0; i < s.x.length; i++) lines.push(`${s.x[i]} ${s.y[j]} ${s.f[i * s.y.length + j]}`);
        lines.push('');
      }
    } else {
      lines.push(`#! FIELDS ${s.variables[0]} file.free`);
      for (let i = 0; i < s.x.length; i++) lines.push(`${s.x[i]} ${s.f[i]}`);
    }
    downloadText(`${lines.join('\n')}\n`, 'fes.dat');
  }

  /* ---------------------------------------------------------------- *
   * Files
   * ---------------------------------------------------------------- */

  function take(text, name) {
    const parsed = parseColvar(text);
    if (!parsed.rows) {
      showToast(`${name}: ${parsed.errors[0] || 'no rows of numbers.'}`, 'danger');
      return;
    }
    if (fileKind(parsed.fields) === 'hills') {
      state.hills = parsed;
      state.hillsName = name;
      state.along = '';
    } else {
      state.colvar = parsed;
      state.colvarName = name;
      state.column = '';
    }
    render();
    showToast(`${name} read as ${fileKind(parsed.fields) === 'hills' ? 'hills' : 'a COLVAR'}: ` +
      `${parsed.rows.toLocaleString('en-GB')} rows.`, 'ok');
  }

  function readFiles(files) {
    for (const file of Array.from(files || [])) {
      if (file.size > MAX_BYTES) {
        showToast(`${file.name} is larger than 300 MB.`, 'danger');
        continue;
      }
      file.text().then(t => take(t, file.name)).catch(() => showToast(`Could not read ${file.name}.`, 'danger'));
    }
  }

  function render() {
    const any = !!(state.colvar || state.hills);
    if ($('plumedAnDrop')) $('plumedAnDrop').classList.toggle('stk-drop-sm', true);
    if ($('plumedAnEmpty')) $('plumedAnEmpty').hidden = any;
    if ($('plumedAnClear')) $('plumedAnClear').hidden = !any;
    renderColvar();
    renderHills();
  }

  function sample() {
    Promise.all(['COLVAR', 'HILLS_d'].map(n =>
      fetch(`assets/samples/plumed/${n}`).then(r => (r.ok ? r.text() : Promise.reject(new Error(n))))))
      .then(([c, h]) => { take(c, 'COLVAR'); take(h, 'HILLS'); })
      .catch(() => showToast('The sample files could not be loaded.', 'danger'));
  }

  const on = (id, event, fn) => { if ($(id)) $(id).addEventListener(event, fn); };
  on('plumedAnChoose', 'click', () => $('plumedAnFile') && $('plumedAnFile').click());
  on('plumedAnFile', 'change', (e) => { readFiles(e.target.files); e.target.value = ''; });
  on('plumedAnSample', 'click', sample);
  on('plumedAnClear', 'click', () => {
    state.colvar = null;
    state.hills = null;
    render();
  });
  on('plumedAnColumn', 'change', (e) => { state.column = e.target.value; drawColvar(); renderReweight(); });
  on('plumedAnAlong', 'change', (e) => { state.along = e.target.value; drawFes(); });
  on('plumedAnApply', 'click', () => {
    const n = builder.applySuggestions(state.suggestions);
    showToast(n ? `Hill width and grid set for ${n} variable${n === 1 ? '' : 's'}.` : 'Nothing to set.', n ? 'ok' : 'danger');
  });
  on('plumedAnFesGet', 'click', downloadFes);

  const drop = $('plumedAnDrop');
  if (drop) {
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      readFiles(e.dataTransfer && e.dataTransfer.files);
    });
  }
  // Charts are drawn in the colours of the theme they were made in.
  new MutationObserver(() => { if (state.colvar || state.hills) render(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  return { render, refresh: () => { if (state.colvar) renderColvar(); } };
}
