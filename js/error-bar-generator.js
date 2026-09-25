/**
 * Error Bar Generator | UI layer.
 *
 * Group statistics, error-bar selection, tick placement, the CI-overlap
 * heuristic, and CSV export live in stemkit-core. This file handles DOM
 * wiring, SVG rendering, and file export.
 */
import { registerFromGlobals } from '../src/core/vendor.js';
import {
  computeGroups,
  currentError as coreCurrentError,
  errorLabel as coreErrorLabel,
  niceTicks,
  resultsToCSV,
  nonOverlappingPairs
} from '../src/core/error-bars.js';

// jStat and Papa are loaded as UMD globals by the page's <script> tags.
registerFromGlobals();

document.addEventListener('DOMContentLoaded', () => {

  // # --- 1. State and bindings ---
  let computedResults = [];
  let currentLevel = 0.95;
  let errorMode = 'ci';
  let sigFigs = 4;

  const dataInput = document.getElementById('dataInput');
  const fileInput = document.getElementById('fileInput');
  const hasHeaders = document.getElementById('hasHeaders');
  const calculateBtn = document.getElementById('calculateBtn');
  const resultsBody = document.getElementById('resultsBody');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const theoryContainer = document.getElementById('theoryContainer');
  const ciLevelSelect = document.getElementById('ciLevel');
  const ciHeader = document.getElementById('ciHeader');
  const decimalsSelect = document.getElementById('decimals');

  const plotHost = document.getElementById('plotHost');
  const plotEmpty = document.getElementById('plotEmpty');
  const plotResult = document.getElementById('plotResult');
  const errModeTabs = document.querySelectorAll('[data-errmode]');
  const exportPngBtn = document.getElementById('exportPngBtn');
  const exportSvgBtn = document.getElementById('exportSvgBtn');
  const sigNote = document.getElementById('sigNote');

  const SAMPLES = {
    basic: 'Label,Rep1,Rep2,Rep3,Rep4\nControl,4.5,4.2,4.8,4.6\nLow Dose,6.1,6.5,6.2,6.3\nHigh Dose,8.3,8.1,8.9,8.5',
    overlap: 'Group,M1,M2,M3,M4\nAlpha,10.2,9.1,11.5,8.8\nBeta,10.8,9.6,12.1,9.4\nGamma,11.1,10.2,12.4,9.9',
    many: 'Sample,Trial1,Trial2,Trial3\npH 4,2.1,2.3,2.0\npH 5,3.4,3.6,3.5\npH 6,5.8,6.0,5.9\npH 7,8.2,8.5,8.1\npH 8,6.1,5.9,6.3\npH 9,3.2,3.0,3.4',
    ragged: 'Condition,V1,V2,V3,V4,V5\nBaseline,12.1,12.4,11.9\nStress,18.2,17.9,18.5,18.1,18.3\nRecovery,14.0,14.3',
    negative: 'Region,Q1,Q2,Q3,Q4\nNorth,-2.5,-1.8,-3.1,-2.2\nEquator,0.5,-0.3,1.1,-0.8\nSouth,3.2,2.8,3.6,3.0',
    messy: 'Label,Rep1,Rep2,Rep3\n\nControl,4.5,4.2,4.8\n\nTreatment,6.1,6.5,6.2\n\nNotes: run on 2026-03-01,,,'
  };

  // The example chips under the box, and the one in the plot's empty state.
  // The chip for the loaded example stays marked until the data is edited.
  const chips = document.querySelectorAll('.eb-chip');
  const markChip = (key) => chips.forEach(c =>
    c.setAttribute('aria-pressed', String(c.getAttribute('data-sample') === key)));
  markChip(null);

  document.querySelectorAll('[data-sample]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-sample');
      const s = SAMPLES[key];
      if (!s) return;
      dataInput.value = s;
      markChip(key);
      calculate();
    });
  });

  // Editing the data unmarks the example; emptying the box clears the
  // results, so no statistics are shown for data that is no longer there.
  dataInput.addEventListener('input', () => {
    markChip(null);
    if (!dataInput.value.trim()) clearResults();
  });

  /** Back to the state before the first calculation. */
  function clearResults(message) {
    computedResults = [];
    resultsBody.innerHTML =
      '<tr><td colspan="11" class="px-4 py-16 text-center text-slate-500 dark:text-slate-400">' +
      (message || 'N, mean, SD, SEM, median, IQR, CV and the confidence interval for each group appear here.') +
      '</td></tr>';
    exportCsvBtn.disabled = true;
    drawPlot();
    if (sigNote) sigNote.style.display = 'none';
  }

  function calculate() {
    const rawText = dataInput.value.trim();
    if (!rawText) return showToast('Paste or upload some data first.', 'error');

    // Parsed without header mode so the core can decide for itself whether the
    // first row is a header; the control acts as an explicit override.
    const parsed = Papa.parse(rawText, {
      header: false, dynamicTyping: true, skipEmptyLines: true
    });

    const rows = (parsed.data || [])
      .filter(r => Array.isArray(r) && r.some(c => c !== null && c !== ''));

    if (rows.length === 0) return showToast('Could not parse any rows.', 'error');
    if (rows[0].length < 2) {
      return showToast('Each row needs a label plus at least one value.', 'error');
    }

    const mode = (hasHeaders && hasHeaders.value) || 'auto';
    const hasHeader = mode === 'auto' ? 'auto' : (mode === 'yes');

    const result = computeGroups(rows, { level: currentLevel, hasHeader });
    computedResults = result.results;

    if (computedResults.length === 0) {
      clearResults('No numeric groups found. Put a text label in the first column and ' +
        'numeric replicates in the rest, or change the header setting.');
      return;
    }

    renderTable();
    drawPlot();
    renderSignificance();

    let msg = `Computed statistics for ${computedResults.length} ` +
              `group${computedResults.length > 1 ? 's' : ''}.`;
    if (result.skipped > 0) {
      msg += ` Skipped ${result.skipped} row${result.skipped > 1 ? 's' : ''} ` +
             `with no label or no numbers.`;
    }
    showToast(msg, 'success');
    exportCsvBtn.disabled = false;
  }

  if (calculateBtn) calculateBtn.onclick = calculate;

  if (fileInput) fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { dataInput.value = ev.target.result; markChip(null); calculate(); };
    reader.readAsText(file);
    fileInput.value = '';
  });

  if (ciLevelSelect) ciLevelSelect.addEventListener('change', () => {
    currentLevel = parseFloat(ciLevelSelect.value) || 0.95;
    if (ciHeader) ciHeader.textContent = `${Math.round(currentLevel * 100)}% CI (±)`;
    if (computedResults.length) calculate();
  });

  if (decimalsSelect) decimalsSelect.addEventListener('change', () => {
    sigFigs = parseInt(decimalsSelect.value, 10) || 4;
    if (computedResults.length) { renderTable(); drawPlot(); }
  });

  // One control, three states: exactly one button is pressed, and it is the
  // error the plot is drawing.
  errModeTabs.forEach(tab => tab.addEventListener('click', () => {
    errorMode = tab.getAttribute('data-errmode');
    errModeTabs.forEach(t => t.setAttribute('aria-pressed', String(t === tab)));
    drawPlot();
  }));

  // # --- 3. Table ---
  // A value that cannot be computed (a single replicate has no SD) shows as
  // an en dash rather than a zero that looks like a measurement.
  const fmt = (x) => (Number.isFinite(x) ? String(+x.toFixed(sigFigs)) : '–');

  // Cells in the order of the table's headings: Label, N, Mean, SD, SEM,
  // Median, IQR, CV, Min/Max, t*, CI.
  function renderTable() {
    const pct = Math.round(currentLevel * 100);
    resultsBody.innerHTML = computedResults.map(r => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-900/50 transition-colors">
        <td class="px-3 py-3 font-bold text-brand-700 dark:text-brand-300 border-r border-slate-100 dark:border-slate-800">${escapeHtml(String(r.key))}</td>
        <td class="px-3 py-3">${r.n}</td>
        <td class="px-3 py-3 font-mono">${fmt(r.mean)}</td>
        <td class="px-3 py-3 font-mono">${r.n > 1 ? fmt(r.sd) : '–'}</td>
        <td class="px-3 py-3 font-mono">${r.n > 1 ? fmt(r.sem) : '–'}</td>
        <td class="px-3 py-3 font-mono">${fmt(r.median)}</td>
        <td class="px-3 py-3 font-mono">${fmt(r.iqr)}</td>
        <td class="px-3 py-3 font-mono">${r.n > 1 && r.mean !== 0 ? fmt(r.cv) + '%' : '–'}</td>
        <td class="px-3 py-3 font-mono">${fmt(r.min)} / ${fmt(r.max)}</td>
        <td class="px-3 py-3 font-mono">${r.n > 1 ? fmt(r.t) : '–'}</td>
        <td class="px-3 py-3 font-mono font-bold">${r.n > 1 ? fmt(r.ci) : '–'}</td>
      </tr>`).join('');
    if (ciHeader) ciHeader.textContent = `${pct}% CI (±)`;
  }

  // # --- 4. Significance cue ---
  function renderSignificance() {
    if (!sigNote) return;
    const { separated, allOverlap, comparable } = nonOverlappingPairs(computedResults);

    if (comparable < 2) {
      sigNote.style.display = 'none';
      return;
    }
    const pct = Math.round(currentLevel * 100);

    if (separated.length) {
      const pairs = separated.map(p => `${p.a} vs ${p.b}`);
      sigNote.className = 'sig-note sig-yes';
      sigNote.innerHTML =
        `<i class="fa-solid fa-circle-check"></i> Non-overlapping ${pct}% CIs ` +
        `(suggestive of a significant difference): ` +
        `<strong>${pairs.map(escapeHtml).join(', ')}</strong>. This is a visual ` +
        `heuristic, confirm with a formal test (t-test / ANOVA).`;
    } else if (allOverlap) {
      sigNote.className = 'sig-note sig-no';
      sigNote.innerHTML =
        `<i class="fa-solid fa-circle-info"></i> All ${pct}% CIs overlap, so no ` +
        `pair shows a clear difference by the non-overlap heuristic. Note: ` +
        `overlapping CIs do <em>not</em> prove groups are equal, use a formal test.`;
    }
    sigNote.style.display = 'block';
  }

  // # --- 5. SVG plot ---
  const PLOT = { w: 720, h: 440, ml: 64, mr: 24, mt: 28, mb: 84 };

  const PLOT_DEFAULTS = {
    title: '', yLabel: '', barStyle: 'fill', barWidth: 55, barRadius: 3,
    barOpacity: 85, capWidth: 12, gridlines: true, showN: true,
    showValues: false, showLegend: false, palette: 'default',
    yMinOverride: '', yMaxOverride: ''
  };
  const plotOpts = { ...PLOT_DEFAULTS };

  // Keys match the options of the Color palette select. Series colours are
  // data, so they are not tied to the site's accent beyond the first bar.
  const PALETTES = {
    default: ['#3574b0', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899'],
    blue: ['#1e3a8a', '#2563eb', '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe', '#1d4ed8', '#38bdf8'],
    viridis: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725', '#35b779', '#31688e'],
    warm: ['#7c2d12', '#c2410c', '#ea580c', '#f59e0b', '#eab308', '#dc2626', '#db2777', '#f97316'],
    gray: ['#1f2937', '#374151', '#4b5563', '#6b7280', '#9ca3af', '#d1d5db', '#111827', '#e5e7eb']
  };

  // Each Customize plot control writes one option and redraws: text and
  // sliders as they change, selects and checkboxes on change.
  const OPT_CONTROLS = [
    ['optTitle', 'title', 'text'], ['optYLabel', 'yLabel', 'text'],
    ['optBarStyle', 'barStyle', 'text'], ['optPalette', 'palette', 'text'],
    ['optBarWidth', 'barWidth', 'num'], ['optBarRadius', 'barRadius', 'num'],
    ['optBarOpacity', 'barOpacity', 'num'], ['optCapWidth', 'capWidth', 'num'],
    ['optYMin', 'yMinOverride', 'text'], ['optYMax', 'yMaxOverride', 'text'],
    ['optGridlines', 'gridlines', 'bool'], ['optShowN', 'showN', 'bool'],
    ['optShowValues', 'showValues', 'bool'], ['optShowLegend', 'showLegend', 'bool']
  ];
  const syncSliderLabels = () => {
    ['optBarWidth', 'optBarRadius', 'optBarOpacity', 'optCapWidth'].forEach(id => {
      const el = document.getElementById(id);
      const out = document.getElementById(id + 'Val');
      if (el && out) out.textContent = el.value;
    });
  };
  OPT_CONTROLS.forEach(([id, key, kind]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const read = () => {
      plotOpts[key] = kind === 'bool' ? el.checked : kind === 'num' ? parseFloat(el.value) : el.value;
      syncSliderLabels();
      if (computedResults.length) drawPlot();
    };
    el.addEventListener(kind === 'bool' || el.tagName === 'SELECT' ? 'change' : 'input', read);
  });
  syncSliderLabels();

  const errFor = (r) => coreCurrentError(r, errorMode);
  const errLabel = () => coreErrorLabel(errorMode, currentLevel);

  function drawPlot() {
    if (!plotHost) return;
    const has = computedResults.length > 0;
    if (plotEmpty) plotEmpty.classList.toggle('hidden', has);
    if (plotResult) plotResult.classList.toggle('hidden', !has);
    if (exportPngBtn) exportPngBtn.disabled = !has;
    if (exportSvgBtn) exportSvgBtn.disabled = !has;
    if (!has) {
      plotHost.innerHTML = '';
      return;
    }


    const data = computedResults;
    const errs = data.map(errFor);

    let yMin = Math.min(0, ...data.map((r, i) => r.mean - errs[i]));
    let yMax = Math.max(...data.map((r, i) => r.mean + errs[i]));
    if (yMax === yMin) yMax = yMin + 1;

    const ticks = niceTicks(yMin, yMax, 5);
    yMin = Math.min(yMin, ticks[0]);
    yMax = Math.max(yMax, ticks[ticks.length - 1]);

    const oMin = parseFloat(plotOpts.yMinOverride);
    const oMax = parseFloat(plotOpts.yMaxOverride);
    if (Number.isFinite(oMin)) yMin = oMin;
    if (Number.isFinite(oMax)) yMax = oMax;
    if (yMax <= yMin) yMax = yMin + 1;

    const drawTicks = niceTicks(yMin, yMax, 5)
      .filter(t => t >= yMin - 1e-9 && t <= yMax + 1e-9);

    const hasTitle = String(plotOpts.title).trim().length > 0;
    const mt = PLOT.mt + (hasTitle ? 28 : 0) + (plotOpts.showLegend ? 22 : 0);
    const { w, h, ml, mr, mb } = PLOT;
    const plotW = w - ml - mr;
    const plotH = h - mt - mb;
    const yScale = v => mt + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    const n = data.length;
    const band = plotW / n;
    const barW = Math.min(120, band * (plotOpts.barWidth / 100));

    const palette = PALETTES[plotOpts.palette] || PALETTES.default;
    const isDark = document.documentElement.classList.contains('dark');
    const axis = isDark ? '#94a3b8' : '#64748b';
    const grid = isDark ? 'rgba(148,163,184,.18)' : 'rgba(148,163,184,.25)';
    const txt = isDark ? '#e2e8f0' : '#1e293b';
    // Matches the panel behind it (slate-950 in the dark theme, white in light).
    const bg = isDark ? '#020617' : '#ffffff';
    const opacity = plotOpts.barOpacity / 100;
    const clip = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px" font-family="Inter, system-ui, sans-serif" role="img" aria-label="Bar chart of group means with ${escapeXml(errLabel())} error bars">`);
    parts.push(`<rect width="${w}" height="${h}" fill="${bg}"/>`);

    if (hasTitle) {
      parts.push(`<text x="${ml + plotW / 2}" y="26" text-anchor="middle" font-size="15" font-weight="700" fill="${txt}">${escapeXml(plotOpts.title)}</text>`);
    }

    for (const t of drawTicks) {
      const y = yScale(t);
      if (plotOpts.gridlines) parts.push(`<line x1="${ml}" y1="${y}" x2="${w - mr}" y2="${y}" stroke="${grid}" stroke-width="1"/>`);
      parts.push(`<text x="${ml - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="${axis}">${(+t.toPrecision(6))}</text>`);
    }

    const zero = yScale(Math.max(yMin, Math.min(0, yMax)));
    parts.push(`<line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + plotH}" stroke="${axis}" stroke-width="1.5"/>`);
    parts.push(`<line x1="${ml}" y1="${zero}" x2="${w - mr}" y2="${zero}" stroke="${axis}" stroke-width="1.5"/>`);

    // The y label says which error the bars show unless the user names it.
    const yl = String(plotOpts.yLabel).trim() || `Mean ± ${errLabel()}`;
    parts.push(`<text transform="translate(16 ${mt + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="12" font-weight="600" fill="${axis}">${escapeXml(yl)}</text>`);

    data.forEach((r, i) => {
      const cx = ml + band * i + band / 2;
      const top = yScale(r.mean);
      const colour = palette[i % palette.length];
      const bx = cx - barW / 2;
      const by = Math.min(top, zero);
      const bh = Math.abs(zero - top);

      if (plotOpts.barStyle === 'outline') {
        parts.push(`<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="${plotOpts.barRadius}" fill="none" stroke="${colour}" stroke-width="2.5" stroke-opacity="${opacity}"/>`);
      } else {
        parts.push(`<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="${plotOpts.barRadius}" fill="${colour}" fill-opacity="${opacity}"/>`);
      }

      const e = errs[i];
      if (Number.isFinite(e) && e > 0) {
        const hi = yScale(r.mean + e);
        const lo = yScale(r.mean - e);
        const cap = Math.min(plotOpts.capWidth, barW / 2);
        parts.push(`<line x1="${cx}" y1="${hi}" x2="${cx}" y2="${lo}" stroke="${txt}" stroke-width="1.6"/>`);
        parts.push(`<line x1="${cx - cap}" y1="${hi}" x2="${cx + cap}" y2="${hi}" stroke="${txt}" stroke-width="1.6"/>`);
        parts.push(`<line x1="${cx - cap}" y1="${lo}" x2="${cx + cap}" y2="${lo}" stroke="${txt}" stroke-width="1.6"/>`);
      }

      if (plotOpts.showValues) {
        const vy = yScale(r.mean + (Number.isFinite(e) && e > 0 ? e : 0)) - 6;
        parts.push(`<text x="${cx}" y="${vy}" text-anchor="middle" font-size="11" font-weight="600" fill="${txt}">${fmt(r.mean)}</text>`);
      }

      parts.push(`<text x="${cx}" y="${mt + plotH + 20}" text-anchor="middle" font-size="11" fill="${txt}">${escapeXml(clip(String(r.key), 16))}</text>`);
      if (plotOpts.showN) parts.push(`<text x="${cx}" y="${mt + plotH + 36}" text-anchor="middle" font-size="11" fill="${axis}">n = ${r.n}</text>`);
    });

    // Legend: one swatch per group, across the top.
    if (plotOpts.showLegend) {
      let lx = ml;
      const ly = mt - 12;
      data.forEach((r, i) => {
        const label = clip(String(r.key), 14);
        parts.push(`<rect x="${lx}" y="${ly - 9}" width="11" height="11" rx="2" fill="${palette[i % palette.length]}" fill-opacity="${opacity}"/>`);
        parts.push(`<text x="${lx + 16}" y="${ly}" font-size="11" fill="${txt}">${escapeXml(label)}</text>`);
        lx += 30 + label.length * 6.6;
      });
    }

    parts.push('</svg>');
    plotHost.innerHTML = parts.join('');
  }

  // Redraw when the theme changes, so the chart's background and text follow.
  new MutationObserver(() => { if (computedResults.length) drawPlot(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  /** The plot as a standalone SVG string at its full drawing size. */
  function plotSvgMarkup() {
    const svg = plotHost && plotHost.querySelector('svg');
    if (!svg) return null;
    const copy = svg.cloneNode(true);
    copy.setAttribute('width', PLOT.w);
    copy.setAttribute('height', PLOT.h);
    copy.removeAttribute('style');
    return copy.outerHTML;
  }

  // # --- 6. Export ---
  if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => {
    const csv = resultsToCSV(computedResults);
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'error_bar_stats.csv');
    showToast('CSV exported.', 'success');
  });

  if (exportSvgBtn) exportSvgBtn.addEventListener('click', () => {
    const markup = plotSvgMarkup();
    if (!markup) return showToast('Nothing to export yet.', 'error');
    downloadBlob(
      new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }),
      'error_bar_plot.svg'
    );
    showToast('SVG exported.', 'success');
  });

  if (exportPngBtn) exportPngBtn.addEventListener('click', () => {
    const markup = plotSvgMarkup();
    if (!markup) return showToast('Nothing to export yet.', 'error');

    const scale = 2;
    const img = new Image();
    const blob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = PLOT.w * scale;
      canvas.height = PLOT.h * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => {
        downloadBlob(b, 'error_bar_plot.png');
        showToast('PNG exported.', 'success');
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showToast('Could not rasterise the plot.', 'error');
    };
    img.src = url;
  });

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // # --- 7. Utilities ---
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  }

  function showToast(msg, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    const colors = type === 'success'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200'
      : type === 'error'
        ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-200'
        : 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/40 dark:text-blue-200';
    toast.className = `px-4 py-3 rounded-xl border shadow-lg text-sm font-medium transition-all ${colors}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // # --- 3. Theory (KaTeX, robust) ---
  function renderTheory() {
      if (!theoryContainer) return;
      const texMain = String.raw`\begin{aligned}
          \bar{x} &= \frac{1}{n}\sum_{i=1}^{n} x_i
          \qquad s = \sqrt{\frac{\sum_{i=1}^{n}(x_i - \bar{x})^2}{n-1}} \\[8pt]
          \mathrm{SEM} &= \frac{s}{\sqrt{n}}
          \qquad \mathrm{CI}_{1-\alpha} = \bar{x} \pm t^{*}_{\alpha/2,\,n-1}\cdot \mathrm{SEM}
      \end{aligned}`;
      const texSpread = String.raw`\begin{aligned}
          \tilde{x} &= \begin{cases} x_{((n+1)/2)} & n \text{ odd} \\[2pt]
              \tfrac{1}{2}\left(x_{(n/2)} + x_{(n/2+1)}\right) & n \text{ even} \end{cases}
          \qquad \mathrm{IQR} = Q_3 - Q_1 \\[8pt]
          \mathrm{CV} &= \frac{s}{\lvert \bar{x} \rvert}\times 100\%
          \qquad \text{range} = [\,x_{\min},\, x_{\max}\,]
      \end{aligned}`;
      if (typeof katex !== 'undefined') {
          const kxBlock = tex => { try { return katex.renderToString(tex, { displayMode: true, throwOnError: false, output: "html" }); } catch (e) { return '<span class="text-slate-500 dark:text-slate-400 text-sm">Formula unavailable.</span>'; } };
          theoryContainer.innerHTML =
              `<div class="mf-block-label">Central tendency &amp; inference</div>${kxBlock(texMain)}
               <div class="mf-block-label" style="margin-top:1rem;">Spread &amp; robustness</div>${kxBlock(texSpread)}`;
          renderDefs();
      }
  }
  function renderDefs() {
      const defs = [
          [`\\bar{x}`, `group mean`],
          [`\\tilde{x}`, `median \u2014 middle value; robust to outliers`],
          [`n`, `number of replicates in the group`],
          [`s`, `sample standard deviation (n\u22121 denominator)`],
          [`\\mathrm{SEM}`, `standard error of the mean = s / \u221an`],
          [`Q_1,\\ Q_3`, `first and third quartiles (25th, 75th percentiles)`],
          [`\\mathrm{IQR}`, `interquartile range = Q\u2083 \u2212 Q\u2081; spread of the middle 50%`],
          [`\\mathrm{CV}`, `coefficient of variation \u2014 SD relative to the mean, as a %`],
          [`x_{\\min},\\ x_{\\max}`, `smallest and largest replicate values`],
          [`t^{*}_{\\alpha/2,\\,n-1}`, `Student\u2019s t critical value at the chosen level, df = n\u22121`],
          [`\\mathrm{CI}`, `confidence interval; half-width = t* \u00d7 SEM`]
      ];
      const kx = tex => { try { return katex.renderToString(tex, { throwOnError: false, output: "html" }); } catch (e) { return tex; } };
      const items = defs.map(([s, m]) => `<div class="mf-def"><dt>${kx(s)}</dt><dd>${m}</dd></div>`).join('');
      const host = document.getElementById('theoryDefs');
      if (host) host.innerHTML = `<div class="mf-defs"><div class="mf-defs-title">Where:</div><dl>${items}</dl></div>`;
  }
  renderTheory();

  const resetPlotBtn = document.getElementById('resetPlotBtn');
  if (resetPlotBtn) resetPlotBtn.addEventListener('click', () => {
    Object.assign(plotOpts, PLOT_DEFAULTS);
    // Put every control back to match.
    OPT_CONTROLS.forEach(([id, key, kind]) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (kind === 'bool') el.checked = PLOT_DEFAULTS[key];
      else el.value = PLOT_DEFAULTS[key];
    });
    syncSliderLabels();
    if (computedResults.length) drawPlot();
    showToast('Plot style reset to the defaults.', 'info');
  });


});
