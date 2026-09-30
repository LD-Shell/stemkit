/*
 * STEMKit, MD Workflow Generator: reading what a PLUMED run wrote.
 * Author: Olanrewaju M. Daramola
 *
 * A COLVAR from a trial run gives the hill widths and grids for the builder;
 * a HILLS file gives the free-energy surface and shows whether the bias has
 * settled. The numbers come from src/core/plumed-analysis.js, which is tested
 * against PLUMED's own sum_hills.
 *
 * The figures are drawn one at a time by the plot area every plotting page
 * shares (mountFigure in js/figure-plot.js): the same header, style panel,
 * PDF, PNG and SVG, and Python panel as the Curve Fitter. What each figure
 * shows, and the Python that computes it from the person's files, come from
 * src/core/plumed-analysis-figures.js. The plot area and Plotly are loaded
 * when the first file is read, not with the page.
 */

import {
  parseColvar, fileKind, hillsVariables, columnSummary, suggestBias, driftOf, hillHeights,
  poolRuns, valueColumns, biasColumn
} from '../src/core/plumed-analysis.js';
import {
  ANALYSIS_FIGURES, ENERGY_LABELS, availableFigures, analysisFigure, analysisScript, analysisData, fmt
} from '../src/core/plumed-analysis-figures.js';
import { findTarget } from './script-generator-plumed-model.js';

const PLOTLY_SRC = 'js/dependencies/plotly.min.js';
const MAX_BYTES = 300 * 1024 * 1024;
// Variables that cannot go below zero, so a suggested grid need not reach far
// under the values seen. The global Steinhardt Q3/Q4/Q6 are norms and qualify;
// LOCAL_Q3/Q4/Q6 are normalised dot products that run from -1 to 1 and do not.
const NON_NEGATIVE = /^(DISTANCE|COORDINATION|COORDINATIONNUMBER|GYRATION|RMSD|DRMSD|CONTACTMAP|Q[346]|ALPHARMSD|ANTIBETARMSD|PARABETARMSD|VOLUME)/;
const STYLE_KEY = 'stemkit.plumed-analyse.styles';
const FIGURE_KEY = 'stemkit.plumed-analyse.figure';

/**
 * Whether a biased value cannot be negative, so that its grid may start just
 * below zero. A distance cannot, but the components of DISTANCE
 * (`COMPONENTS` gives d.x, d.y, d.z; `SCALED_COMPONENTS` d.a, d.b, d.c) are
 * signed, even when a trial run happened to see them positive only.
 *
 * @param {{arg:string, type:string}} [target] - What the bias acts on.
 * @returns {boolean}
 */
export function cannotBeNegative(target) {
  return !!(target && NON_NEGATIVE.test(target.type) &&
    !(/^DISTANCE/.test(target.type) && /\.[xyzabc]$/.test(target.arg)));
}

let plotlyLoading = null;
function loadPlotly() {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  if (!plotlyLoading) {
    plotlyLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PLOTLY_SRC;
      s.onload = () => resolve(window.Plotly);
      s.onerror = () => { plotlyLoading = null; reject(new Error('The chart library could not be loaded.')); };
      document.head.appendChild(s);
    });
  }
  return plotlyLoading;
}

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const isEmpty = (o) => !o || (typeof o === 'object' && !Array.isArray(o) && !Object.keys(o).length);

function readStore(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
}

/*
 * The person's look for each figure, kept as three parts so that it follows
 * the data: the look of the figure (size, fonts, colours) by figure; the
 * labels and x limits by what the figure is along (a label written for d
 * should not stay when the figure shows t); and each panel by what it shows
 * (the panel of a value keeps its y label and limits when others are added).
 */
const LABEL_FIELDS = ['title', 'xLabel', 'xLim'];

export function composeStyle(styles, a) {
  const out = clone(styles[a.styleKey] || {});
  const labels = styles[`${a.styleKey}|label|${a.labelKey}`] || {};
  for (const k of LABEL_FIELDS) if (labels[k] !== undefined) out[k] = clone(labels[k]);
  if (labels.series) {
    out.series = out.series || {};
    for (const [id, s] of Object.entries(labels.series)) {
      const q = out.series[id] || {};
      if (s.label !== undefined) q.label = s.label;
      if (s.colorbar) q.colorbar = { ...(q.colorbar || {}), ...s.colorbar };
      out.series[id] = q;
    }
  }
  const panels = a.panelKeys.map((k) => clone(styles[`${a.styleKey}|panel|${k}`] || {}));
  if (panels.some((p) => !isEmpty(p))) out.panels = panels;
  return out;
}

export function decomposeStyle(styles, a, style) {
  const s = clone(style || {});
  const labels = {};
  for (const k of LABEL_FIELDS) if (s[k] !== undefined) { labels[k] = s[k]; delete s[k]; }
  if (s.series) {
    for (const [id, q] of Object.entries(s.series)) {
      const l = {};
      if (q.label !== undefined) { l.label = q.label; delete q.label; }
      if (q.colorbar && q.colorbar.label !== undefined) {
        l.colorbar = { label: q.colorbar.label };
        delete q.colorbar.label;
        if (isEmpty(q.colorbar)) delete q.colorbar;
      }
      if (!isEmpty(l)) (labels.series = labels.series || {})[id] = l;
      if (isEmpty(q)) delete s.series[id];
    }
    if (isEmpty(s.series)) delete s.series;
  }
  const panels = Array.isArray(s.panels) ? s.panels : [];
  delete s.panels;
  const put = (key, v) => { if (isEmpty(v)) delete styles[key]; else styles[key] = v; };
  put(a.styleKey, s);
  put(`${a.styleKey}|label|${a.labelKey}`, labels);
  a.panelKeys.forEach((k, i) => put(`${a.styleKey}|panel|${k}`, panels[i] || {}));
  return styles;
}

/* "d", "d and t", "d, t and u". */
const listed = (names) => (names.length > 2
  ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  : names.join(' and '));

/**
 * What the figure shows, in a sentence or two, with the numbers that matter.
 *
 * @param {object} a - The figure, from analysisFigure.
 * @param {{unit:string, temperature:string, code:function(string):string,
 *   count:function(number):string}} say - The energy unit and temperature,
 *   as HTML; how a name is set as code (escaped); how a count is written.
 * @returns {string} HTML.
 */
export function analysisNote(a, { unit: u, temperature, code, count }) {
  const r = a.result;
  switch (a.id) {
    case 'series':
      return `One panel for each value ticked above, sharing the time axis. ` +
        (r.thinned
          ? `The page draws the lowest and highest point of each stretch of the ${count(r.rows)} rows, which is ` +
            'the same line; the script reads and draws every row.'
          : `All ${count(r.rows)} rows are drawn.`);
    case 'histogram':
      return `${count(r.n)} values of ${code(r.column)} in ${r.bins} bins ` +
        `${fmt(r.width)} wide, from ${fmt(r.min)} to ${fmt(r.max)}.`;
    case 'reweight': {
      const skip = r.skip;
      return `Each frame is weighted by exp(V/kT) with V from ${code(r.bias)}, at ` +
        `${temperature} K (kT = ${fmt(r.kT)} ${u}). ` +
        `${count(r.frames)} frames carry the weight of ` +
        `<strong>${count(Math.round(r.effective))}</strong> equally weighted ones.` +
        (skip ? ` The first fifth of the run is left out, since ${code(r.bias)} still grows there; ` +
          `print ${code('metad.rbias')} with ${code('CALC_RCT')} to use the whole run.` : '') +
        (r.effective < 50 ? ' <strong>That is too few to trust the surface.</strong>' : '') +
        ' Gaps are bins no frame reached.';
    }
    case 'fes': {
      // A surface along fewer variables than the hills have is not their
      // plain sum: the others are integrated out at kT, as --idw and --kt do.
      const out = r.integrated || [];
      const opening = out.length
        ? `The ${count(r.hills)} hills summed over ${listed([...r.variables, ...out].map(code))}, with ` +
          `${listed(out.map(code))} integrated out at kT = ${fmt(r.kT)} ${u}, as ` +
          `${code(`plumed sum_hills --idw ${r.variables.join(',')} --kt ${fmt(r.kT, 6)}`)} gives it`
        : `The negative sum of all ${count(r.hills)} hills, as ${code('plumed sum_hills')} gives it`;
      return `${opening}, with its lowest point at zero; it reaches ${fmt(r.max)} ${u}.` +
        (r.y ? ' The colour bar gives the free energy; dark is low.' : '');
    }
    case 'convergence': {
      const out = r.integrated || [];
      const aside = out.length ? `, with ${listed(out.map(code))} integrated out at kT = ${fmt(r.kT)} ${u}` : '';
      return `Each line sums the hills up to a time${aside}; the darkest is the whole run. Lines that lie on ` +
        'top of one another say the surface has stopped changing.' +
        (r.change !== null
          ? ` Over the last ${r.part} of the run it moved by at most <strong>${fmt(r.change)} ${u}</strong> ` +
            'where it is below 16 kT.'
          : '');
    }
    case 'heights': {
      const tempered = r.tempered ? ' (the γ/(γ−1) a well-tempered file carries is taken off)' : '';
      return `The mean height of each block of hills, as deposited${tempered}. The first hill was ` +
        `${fmt(r.first)} ${u}; the last tenth of the run averages ${fmt(r.last)} ${u}.`;
    }
    default:
      return '';
  }
}

/**
 * @param {object} ctx - Page helpers.
 * @param {object} builder - `targets()`, `applySuggestions(list)`,
 *        `temperature()`, `energyUnit()`.
 */
export function createPlumedAnalyse(ctx, builder) {
  const { $, escapeHtml, showToast, downloadText } = ctx;
  const state = {
    colvar: null, colvarName: '', colvarNotes: [],
    hills: null, hillsNames: [], hillsNotes: [],
    suggestions: [],
    active: readStore(FIGURE_KEY, 'series'),
    opts: { columns: null, column: '', bins: 50, reweightBins: 60, along: null, variable: '', slices: 5, contours: true },
    current: null
  };
  let styles = readStore(STYLE_KEY, {});
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)) styles = {};

  const unit = () => ENERGY_LABELS[builder.energyUnit()] || builder.energyUnit();
  const timeUnit = () => ($('plumedUnitTime') && $('plumedUnitTime').value) || 'ps';
  const code = (s) => `<code>${escapeHtml(s)}</code>`;
  const count = (n) => Number(n).toLocaleString('en-GB');
  const run = () => ({
    colvar: state.colvar, colvarFile: state.colvarName,
    hills: state.hills, hillsFiles: state.hillsNames
  });

  /* ---------------------------------------------------------------- *
   * COLVAR: the table of widths and grids
   * ---------------------------------------------------------------- */

  function renderColvar() {
    const wrap = $('plumedAnColvar');
    if (!wrap) return;
    const c = state.colvar;
    wrap.hidden = !c;
    if (!c) return;
    const cols = valueColumns(c);
    const targets = builder.targets();
    const biased = !!biasColumn(c);
    state.suggestions = [];
    const rows = cols.map((name) => {
      const period = c.periods[name] || null;
      // PLUMED 2.10 and later head the column of cv1.mean as cv1_mean.
      const target = findTarget(targets, name);
      const s = suggestBias(c.columns[name], { period, nonNegative: cannotBeNegative(target) });
      const drift = driftOf(c.columns[name], period);
      const sum = s ? s.summary : columnSummary(c.columns[name], period);
      // `arg` is the builder's name for the value, `column` the file's.
      if (s && s.sigma && target) state.suggestions.push({ ...s, arg: target.arg, column: name });
      return `<tr>
        <th scope="row"><code>${escapeHtml(name)}</code>${target ? ' <span class="stk-badge stk-badge-accent">biased</span>' : ''}</th>
        <td>${fmt(sum.mean)}</td><td>${fmt(sum.sd)}</td><td>${fmt(sum.min)} to ${fmt(sum.max)}</td>
        <td>${s && s.sigma ? code(s.sigma) : '–'}</td>
        <td>${s && s.sigma ? `${code(s.min)} to ${code(s.max)}, ${code(s.bin)} bins` : '–'}</td>
        <td>${drift.drifting ? '<span class="stk-badge stk-badge-warn">still drifting</span>' : ''}</td>
      </tr>`;
    }).join('');

    const notes = state.colvarNotes.length ? ` ${escapeHtml(state.colvarNotes.join(' '))}` : '';
    $('plumedAnColvarHead').innerHTML =
      `<strong>${escapeHtml(state.colvarName)}</strong>: ${count(c.rows)} rows` +
      `${c.parts > 1 ? ` in ${c.parts} parts` : ''}, ${cols.length} value${cols.length === 1 ? '' : 's'}.${notes}`;
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
          ? `Use for ${state.suggestions.map(s => s.column).join(', ')}`
          : 'No column matches a biased variable';
    }
  }

  /* ---------------------------------------------------------------- *
   * HILLS: what the heights say
   * ---------------------------------------------------------------- */

  function renderHills() {
    const wrap = $('plumedAnHills');
    if (!wrap) return;
    const h = state.hills;
    wrap.hidden = !h;
    if (!h) return;
    const vars = hillsVariables(h.fields);
    const heights = hillHeights(h);
    const last = h.columns.time ? h.columns.time[h.rows - 1] : h.rows;
    const pct = Math.round(heights.ratio * 100);
    let verdict;
    if (!heights.tempered) {
      verdict = 'The run is not well-tempered, so every hill has the same height and the surface keeps ' +
        'oscillating by about that much. Average the surface over the last part of the run.';
    } else if (heights.ratio < 0.1) {
      verdict = `The hills have fallen to <strong>${pct}%</strong> of their first height: the bias changes ` +
        'slowly now. Check under Convergence that the surface has stopped changing shape too.';
    } else if (heights.ratio < 0.4) {
      verdict = `The hills are at <strong>${pct}%</strong> of their first height: the basins in reach are ` +
        'filling, and the run is not finished.';
    } else {
      verdict = `The hills are still at <strong>${pct}%</strong> of their first height: the run is at an early ` +
        'stage, or the variable keeps finding new ground.';
    }
    const names = state.hillsNames;
    const who = names.length > 1
      ? `${names.map(n => `<strong>${escapeHtml(n)}</strong>`).join(', ')} (${names.length} walkers, summed together)`
      : `<strong>${escapeHtml(names[0] || 'HILLS')}</strong>`;
    const notes = state.hillsNotes.length ? ` ${escapeHtml(state.hillsNotes.join(' '))}` : '';
    $('plumedAnHillsHead').innerHTML =
      `${who}: ${count(h.rows)} hills on ${vars.map(code).join(' and ')}, up to time ${fmt(last, 5)}` +
      `${heights.tempered ? `, bias factor ${fmt(heights.biasFactor)}` : ''}. ${verdict}${notes}`;
  }

  /* ---------------------------------------------------------------- *
   * Figures
   * ---------------------------------------------------------------- */

  let plot = null;
  let plotLoading = null;
  /* In the two-column layout the figure should fit in the column under the
     picker and its controls, so that all of it can be read while it is
     styled; stacked, it may be as wide as the page. The column sticks under
     the navigation bar at 100vh - 7rem (src/script-generator.css) once the
     page is scrolled, whatever its height at this moment. */
  const wide = window.matchMedia('(min-width: 1024px)');
  function maxScale() {
    if (!wide.matches) return 2;
    const column = $('outputColumn');
    const body = $('plumedAnBox') && $('plumedAnBox').querySelector('.sg-tool-body');
    const section = $('plumedAnFigures');
    const stage = $('plumedAnPlot') && $('plumedAnPlot').querySelector('.fg-stage');
    if (!column || !body || !section || !stage) return 2;
    // The figure being drawn (the last drawing's size may be another figure's).
    const f = plot && plot.figure();
    const tall = (f ? f.height : 4.8) * 96;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const bodyRoom = window.innerHeight - 7 * rem - (body.getBoundingClientRect().top - column.getBoundingClientRect().top) - rem;
    const above = stage.getBoundingClientRect().top - section.getBoundingClientRect().top;
    return Math.max(0.5, Math.min(2, (bodyRoom - above - 28) / tall));
  }
  // A new window height changes how large the figure may be.
  let lastHeight = window.innerHeight;
  window.addEventListener('resize', () => {
    if (Math.abs(window.innerHeight - lastHeight) < 40 || !plot || !state.current) return;
    lastHeight = window.innerHeight;
    plot.update(state.current.figure);
  });

  function exported(r, err, format) {
    if (err) {
      showToast(`The ${format.toUpperCase()} could not be made: ${err && err.message ? err.message : err}`, 'danger');
      return;
    }
    showToast(`Saved ${r.filename} (${fmt(r.widthIn)} × ${fmt(r.heightIn)} in).`, 'ok');
  }

  function pythonNote(fig, source) {
    const a = state.current;
    const file = `${fig.export.filename}.py`;
    const saves = `${fig.export.filename}.${fig.export.format}`;
    const reads = a ? a.python.reads : [];
    const lead = `Runs with Python 3, numpy and matplotlib 3.6 or later: ${code(`python ${file}`)}. `;
    if (source === 'files') {
      const cli = '<a href="assets/plumed/analyse_plumed.py" class="sg-link" download>analyse_plumed.py</a>';
      return lead + `It reads ${reads.map(code).join(', ')} from the same folder, computes what the page shows with the ` +
        `functions of ${cli}, and saves ${code(saves)}.`;
    }
    return lead + `It holds the numbers the page computed and saves ${code(saves)}.`;
  }

  function ensurePlot() {
    if (plot) return Promise.resolve(plot);
    if (plotLoading) return plotLoading;
    const host = $('plumedAnPlot');
    plotLoading = Promise.all([loadPlotly(), import('./figure-plot.js')]).then(([, figures]) => {
      plot = figures.mountFigure(host, {
        // On the left, over the builder, so that the figure on the right stays
        // in view while it is styled; a sheet from the bottom on a phone.
        styleDrawer: { side: 'left' },
        // The drawer names the figure being styled, which changes with the picker.
        styleTitle: () => {
          const f = ANALYSIS_FIGURES.find(x => x.id === state.active);
          return f ? `Style: ${f.label}` : 'Style';
        },
        style: state.current ? composeStyle(styles, state.current) : {},
        onStyleChange: (style) => {
          if (!state.current) return;
          decomposeStyle(styles, state.current, style);
          writeStore(STYLE_KEY, styles);
        },
        maxScale,
        onExport: exported,
        label: 'The figure, as the saved file will look',
        python: {
          host: $('plumedAnPython'),
          headingLevel: 4,
          sources: [{ id: 'files', label: 'Read the files' }, { id: 'embed', label: 'Data in the script' }],
          script: (fig, source) => analysisScript(fig, source, state.current ? state.current.python : null),
          note: pythonNote,
          empty: '# The script appears here once there is a figure to draw.'
        }
      });
      return plot;
    }).catch((err) => {
      plotLoading = null;
      const notes = host && host.querySelector('.fg-notes');
      if (notes) {
        notes.textContent = `The plot could not load (${err && err.message ? err.message : err}). ` +
          'The numbers above still work; reload the page to try again.';
        notes.hidden = false;
      }
      throw err;
    });
    return plotLoading;
  }

  function figureOptions() {
    return {
      temperature: builder.temperature(), energy: builder.energyUnit(), timeUnit: timeUnit(),
      ...state.opts
    };
  }

  const setOptions = (sel, list, value) => {
    sel.innerHTML = list.map(([v, label]) =>
      `<option value="${escapeHtml(v)}"${v === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
  };

  /* The controls of the figure shown, filled from what it drew. */
  function renderControls(a) {
    const show = (id, on) => { if ($(id)) $(id).hidden = !on; };
    const o = a.options;
    const c = state.colvar;
    show('plumedAnColsWrap', a.id === 'series');
    show('plumedAnColumnWrap', a.id === 'histogram' || a.id === 'reweight');
    show('plumedAnAlongWrap', a.id === 'fes' && o.vars.length > 1);
    show('plumedAnVariableWrap', a.id === 'convergence' && o.vars.length > 1);
    show('plumedAnSlicesWrap', a.id === 'convergence');
    show('plumedAnBinsWrap', a.id === 'histogram' || a.id === 'reweight');
    show('plumedAnContoursWrap', a.id === 'fes' && o.along.length === 2);
    if (a.id === 'series' && c) {
      const all = c.fields.filter(f => f !== 'time');
      $('plumedAnCols').innerHTML = all.map((f, i) => {
        const on = o.columns.includes(f);
        const full = !on && o.columns.length >= 8;
        return `<label class="sg-an-chip"><input type="checkbox" value="${escapeHtml(f)}" id="plumedAnCol${i}"${on ? ' checked' : ''}` +
          `${full ? ' disabled' : ''}> <span class="stk-mono">${escapeHtml(f)}</span></label>`;
      }).join('');
    }
    if (a.id === 'histogram' || a.id === 'reweight') {
      setOptions($('plumedAnColumn'), o.values.map(v => [v, v]), o.column);
      $('plumedAnBins').value = String(a.id === 'histogram' ? o.bins : o.reweightBins);
      if ($('plumedAnBins').value !== String(a.id === 'histogram' ? o.bins : o.reweightBins)) $('plumedAnBins').value = '50';
    }
    if (a.id === 'fes') {
      const pairs = o.vars.map(v => [v, v]);
      if (o.vars.length > 1) pairs.push([o.vars.slice(0, 2).join(','), `${o.vars[0]} and ${o.vars[1]}`]);
      setOptions($('plumedAnAlong'), pairs, o.along.join(','));
      $('plumedAnContours').checked = o.contours;
    }
    if (a.id === 'convergence') {
      setOptions($('plumedAnVariable'), o.vars.map(v => [v, v]), o.variable);
      $('plumedAnSlices').value = String(o.slices);
    }
    const data = analysisData(a);
    show('plumedAnData', !!data);
    if (data) {
      $('plumedAnDataName').textContent = data.filename;
      $('plumedAnData').setAttribute('aria-label', `Download ${data.filename}, the numbers of the figure`);
    }
  }

  /* What the figure says, in a sentence or two, with the numbers that matter. */
  const noteFor = (a) => analysisNote(a, {
    unit: escapeHtml(unit()), temperature: escapeHtml(String(builder.temperature())), code, count
  });

  function renderPicker(ids) {
    const buttons = Array.from(document.querySelectorAll('#plumedAnPick [data-an-fig]'));
    for (const b of buttons) {
      const id = b.getAttribute('data-an-fig');
      const on = id === state.active;
      b.hidden = !ids.includes(id);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    if ($('plumedAnFigPanel')) $('plumedAnFigPanel').setAttribute('aria-labelledby', `plumedAnTab-${state.active}`);
  }

  let drawSeq = 0;
  function renderFigures() {
    const wrap = $('plumedAnFigures');
    if (!wrap) return;
    const r = run();
    const ids = availableFigures(r);
    wrap.hidden = !ids.length;
    if (!ids.length) {
      state.current = null;
      if (plot) plot.update(null);
      return;
    }
    if (!ids.includes(state.active)) state.active = ids[0];
    renderPicker(ids);
    const a = analysisFigure(state.active, r, figureOptions());
    state.current = a;
    if (!a) {
      $('plumedAnNote').textContent = 'There is too little in the file to draw this figure.';
      if (plot) plot.update(null);
      return;
    }
    // What was drawn becomes what is asked for next, so the choices stay.
    Object.assign(state.opts, {
      columns: a.options.columns, column: a.options.column, along: a.options.along, variable: a.options.variable
    });
    renderControls(a);
    $('plumedAnPlotTitle').textContent = a.title;
    $('plumedAnNote').innerHTML = noteFor(a);
    const seq = ++drawSeq;
    ensurePlot().then((p) => {
      if (seq !== drawSeq || state.current !== a) return;
      const style = composeStyle(styles, a);
      if (JSON.stringify(style) !== JSON.stringify(p.getStyle())) p.setStyle(style);
      p.update(a.figure);
    }, () => { /* the plot area could not load; its notes say so */ }).catch((err) => {
      const notes = $('plumedAnPlot') && $('plumedAnPlot').querySelector('.fg-notes');
      if (notes) {
        notes.textContent = `The figure could not be drawn: ${err && err.message ? err.message : err}`;
        notes.hidden = false;
      }
    });
  }

  function choose(id) {
    if (!ANALYSIS_FIGURES.some(f => f.id === id)) return;
    state.active = id;
    writeStore(FIGURE_KEY, id);
    renderFigures();
  }

  /* ---------------------------------------------------------------- *
   * Files
   * ---------------------------------------------------------------- */

  /*
   * One or more files read together. A COLVAR is read one at a time; several
   * HILLS files of the same variables are the walkers of one run, and their
   * hills are summed together. A run continued from a checkpoint is read as
   * one: COLVAR rows a later part wrote again are counted once, while every
   * hill in a HILLS file is kept, as a restarted METAD reads them all back
   * into its bias and plumed sum_hills sums them all.
   */
  function take(list) {
    const colvars = [];
    const hills = [];
    for (const { name, text } of list) {
      const parsed = parseColvar(text, { keepOverlap: false });
      if (!parsed.rows) {
        showToast(`${name}: ${parsed.errors[0] || 'no rows of numbers.'}`, 'danger');
        continue;
      }
      (fileKind(parsed.fields) === 'hills' ? hills : colvars).push({ name, parsed });
    }
    const told = [];
    if (colvars.length) {
      const first = colvars[0];
      state.colvar = first.parsed;
      state.colvarName = first.name;
      state.colvarNotes = first.parsed.errors.slice();
      state.opts.columns = null;
      told.push(`${first.name} (${count(first.parsed.rows)} rows)`);
      if (colvars.length > 1) {
        showToast(`A COLVAR is read one at a time: ${first.name} was read, ${colvars.slice(1).map(c => c.name).join(', ')} not.`, 'danger');
      }
    }
    if (hills.length) {
      let group = hills;
      let pooled = poolRuns(group.map(x => x.parsed), group.map(x => x.name));
      if (!pooled) {
        group = [hills[0]];
        pooled = hills[0].parsed;
        showToast(`The HILLS files do not have the same columns, so only ${hills[0].name} was read.`, 'danger');
      }
      state.hills = pooled;
      state.hillsNames = group.map(x => x.name);
      state.hillsNotes = [];
      for (const x of group) for (const e of x.parsed.errors) state.hillsNotes.push(group.length > 1 ? `${x.name}: ${e}` : e);
      if (pooled.errors.length > group[0].parsed.errors.length) state.hillsNotes.push(...pooled.errors.slice(group[0].parsed.errors.length));
      state.opts.along = null;
      state.opts.variable = '';
      told.push(group.length > 1
        ? `${group.map(x => x.name).join(', ')} as ${group.length} walkers (${count(pooled.rows)} hills)`
        : `${group[0].name} (${count(pooled.rows)} hills)`);
    }
    if (!colvars.length && !hills.length) return;
    // A new file shows its own first figure unless the one shown still applies.
    if (hills.length && !colvars.length && !['fes', 'convergence', 'heights'].includes(state.active)) state.active = 'fes';
    if (colvars.length && !hills.length && ['fes', 'convergence', 'heights'].includes(state.active) && !state.hills) state.active = 'series';
    render();
    showToast(`Read ${told.join(' and ')}.`, 'ok');
  }

  function readFiles(files) {
    const list = Array.from(files || []).filter((file) => {
      if (file.size > MAX_BYTES) {
        showToast(`${file.name} is larger than 300 MB.`, 'danger');
        return false;
      }
      return true;
    });
    if (!list.length) return;
    Promise.all(list.map(file => file.text().then(text => ({ name: file.name, text }))
      .catch(() => { showToast(`Could not read ${file.name}.`, 'danger'); return null; })))
      .then(read => take(read.filter(Boolean)));
  }

  function render() {
    const any = !!(state.colvar || state.hills);
    if ($('plumedAnEmpty')) $('plumedAnEmpty').hidden = any;
    if ($('plumedAnClear')) $('plumedAnClear').hidden = !any;
    renderColvar();
    renderHills();
    renderFigures();
  }

  function sample() {
    Promise.all(['COLVAR', 'HILLS'].map(n =>
      fetch(`assets/samples/plumed/${n}`).then(r => (r.ok ? r.text() : Promise.reject(new Error(n))))
        .then(text => ({ name: n, text }))))
      .then(take)
      .catch(() => showToast('The sample files could not be loaded.', 'danger'));
  }

  /* ---------------------------------------------------------------- *
   * Controls
   * ---------------------------------------------------------------- */

  const on = (id, event, fn) => { if ($(id)) $(id).addEventListener(event, fn); };
  on('plumedAnChoose', 'click', () => $('plumedAnFile') && $('plumedAnFile').click());
  on('plumedAnFile', 'change', (e) => { readFiles(e.target.files); e.target.value = ''; });
  on('plumedAnSample', 'click', sample);
  on('plumedAnClear', 'click', () => {
    Object.assign(state, { colvar: null, colvarName: '', colvarNotes: [], hills: null, hillsNames: [], hillsNotes: [] });
    if (plot) plot.closeStyle();
    render();
  });
  on('plumedAnApply', 'click', () => {
    const n = builder.applySuggestions(state.suggestions);
    showToast(n ? `Hill width and grid set for ${n} variable${n === 1 ? '' : 's'}.` : 'Nothing to set.', n ? 'ok' : 'danger');
  });

  const pick = $('plumedAnPick');
  if (pick) {
    pick.addEventListener('click', (e) => {
      const b = e.target.closest('[data-an-fig]');
      if (b) choose(b.getAttribute('data-an-fig'));
    });
    // Arrow keys move along the tabs, as in any tab list.
    pick.addEventListener('keydown', (e) => {
      const tabs = Array.from(pick.querySelectorAll('[data-an-fig]')).filter(b => !b.hidden);
      const at = tabs.findIndex(b => b.getAttribute('data-an-fig') === state.active);
      let next = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % tabs.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next < 0) return;
      e.preventDefault();
      choose(tabs[next].getAttribute('data-an-fig'));
      tabs[next].focus();
    });
  }
  on('plumedAnCols', 'change', () => {
    const picked = Array.from($('plumedAnCols').querySelectorAll('input:checked')).map(i => i.value);
    if (!picked.length) {
      showToast('Keep at least one value to draw.', 'danger');
      renderFigures();
      return;
    }
    state.opts.columns = picked;
    renderFigures();
  });
  on('plumedAnColumn', 'change', (e) => { state.opts.column = e.target.value; renderFigures(); });
  on('plumedAnBins', 'change', (e) => {
    const n = parseInt(e.target.value, 10);
    if (state.active === 'reweight') state.opts.reweightBins = n; else state.opts.bins = n;
    renderFigures();
  });
  on('plumedAnAlong', 'change', (e) => { state.opts.along = e.target.value.split(','); renderFigures(); });
  on('plumedAnVariable', 'change', (e) => { state.opts.variable = e.target.value; renderFigures(); });
  on('plumedAnSlices', 'change', (e) => { state.opts.slices = parseInt(e.target.value, 10); renderFigures(); });
  on('plumedAnContours', 'change', (e) => { state.opts.contours = e.target.checked; renderFigures(); });
  on('plumedAnData', 'click', () => {
    const d = analysisData(state.current);
    if (d) downloadText(d.text, d.filename);
  });
  // The labels and kT follow the builder's units.
  on('plumedUnitEnergy', 'change', () => { if (state.colvar || state.hills) render(); });
  on('plumedUnitTime', 'change', () => { if (state.colvar || state.hills) renderFigures(); });

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

  return {
    render,
    refresh: () => { if (state.colvar || state.hills) { renderColvar(); renderFigures(); } }
  };
}
