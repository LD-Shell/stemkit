/**
 * Error Bar Generator | UI layer.
 *
 * Group statistics, error-bar selection, tick placement, the CI-overlap
 * heuristic, and CSV export live in @stemkit/core. This file handles DOM
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

  document.querySelectorAll('[data-sample]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = SAMPLES[btn.getAttribute('data-sample')];
      if (!s) return;
      dataInput.value = s;
      const wrap = document.querySelector('.eb-samples');
      if (wrap) wrap.classList.remove('hint');
      calculate();
    });
  });

  // Pulse the sample chips once on an empty input, then stop when the user
  // begins entering their own data.
  const ebSamplesWrap = document.querySelector('.eb-samples');
  if (ebSamplesWrap && dataInput && !dataInput.value.trim()) {
    ebSamplesWrap.classList.add('hint');
    dataInput.addEventListener('input',
      () => ebSamplesWrap.classList.remove('hint'), { once: true });
  }

  function calculate() {
    const rawText = dataInput.value.trim();
    if (!rawText) return showToast('No data detected.', 'error');

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
      resultsBody.innerHTML =
        '<tr><td colspan="11" class="px-4 py-16 text-center text-slate-400">' +
        'No numeric groups found. Put a text label in the first column and ' +
        'numeric replicates in the rest, or toggle the header setting.</td></tr>';
      exportCsvBtn.disabled = true;
      if (plotEmpty) plotEmpty.style.display = '';
      if (plotHost) plotHost.innerHTML = '';
      if (sigNote) sigNote.style.display = 'none';
      return;
    }

    renderTable();
    drawPlot();
    renderSignificance();

    let msg = `Computed statistics for ${computedResults.length} ` +
              `group${computedResults.length > 1 ? 's' : ''}.`;
    if (result.skipped > 0) {
      msg += ` (${result.skipped} row${result.skipped > 1 ? 's' : ''} skipped | ` +
             `no label or no numbers.)`;
    }
    showToast(msg, 'success');
    exportCsvBtn.disabled = false;
  }

  if (calculateBtn) calculateBtn.onclick = calculate;

  if (fileInput) fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { dataInput.value = ev.target.result; calculate(); };
    reader.readAsText(file);
  });

  if (ciLevelSelect) ciLevelSelect.addEventListener('change', () => {
    currentLevel = parseFloat(ciLevelSelect.value) || 0.95;
    if (ciHeader) ciHeader.textContent = `${Math.round(currentLevel * 100)}% CI`;
    if (computedResults.length) calculate();
  });

  if (decimalsSelect) decimalsSelect.addEventListener('change', () => {
    sigFigs = parseInt(decimalsSelect.value, 10) || 4;
    if (computedResults.length) { renderTable(); drawPlot(); }
  });

  errModeTabs.forEach(tab => tab.addEventListener('click', () => {
    errorMode = tab.getAttribute('data-errmode');
    errModeTabs.forEach(t => t.classList.toggle('active', t === tab));
    drawPlot();
  }));

  // # --- 3. Table ---
  const fmt = (x) => (Number.isFinite(x) ? String(+x.toFixed(sigFigs)) : ', ');

  function renderTable() {
    const pct = Math.round(currentLevel * 100);
    resultsBody.innerHTML = computedResults.map(r => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-900/50 transition-colors">
        <td class="px-3 py-3 font-bold text-indigo-600 dark:text-indigo-400 border-r border-slate-100 dark:border-slate-800">${escapeHtml(String(r.key))}</td>
        <td class="px-3 py-3">${r.n}</td>
        <td class="px-3 py-3">${fmt(r.mean)}</td>
        <td class="px-3 py-3">${fmt(r.sd)}</td>
        <td class="px-3 py-3">${fmt(r.sem)}</td>
        <td class="px-3 py-3">${fmt(r.ci)}</td>
        <td class="px-3 py-3">${fmt(r.median)}</td>
        <td class="px-3 py-3">${fmt(r.iqr)}</td>
        <td class="px-3 py-3">${fmt(r.cv)}%</td>
        <td class="px-3 py-3">${fmt(r.min)}</td>
        <td class="px-3 py-3">${fmt(r.max)}</td>
      </tr>`).join('');
    if (ciHeader) ciHeader.textContent = `${pct}% CI`;
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

  const plotOpts = {
    title: '', yLabel: '', barWidth: 60, barOpacity: 85,
    showLegend: true, palette: 'default',
    yMinOverride: '', yMaxOverride: ''
  };

  const PALETTES = {
    default: ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899'],
    ocean: ['#0ea5e9', '#06b6d4', '#14b8a6', '#3b82f6', '#6366f1'],
    warm: ['#f59e0b', '#ef4444', '#f97316', '#dc2626', '#fbbf24'],
    mono: ['#475569', '#64748b', '#94a3b8', '#334155', '#1e293b']
  };

  document.querySelectorAll('[data-plotopt]').forEach(el => {
    el.addEventListener('input', () => {
      const key = el.getAttribute('data-plotopt');
      plotOpts[key] = el.type === 'checkbox' ? el.checked : el.value;
      drawPlot();
    });
  });

  const errFor = (r) => coreCurrentError(r, errorMode);
  const errLabel = () => coreErrorLabel(errorMode, currentLevel);

  function drawPlot() {
    if (!plotHost) return;
    if (!computedResults.length) {
      plotHost.innerHTML = '';
      if (plotEmpty) plotEmpty.style.display = '';
      return;
    }
    if (plotEmpty) plotEmpty.style.display = 'none';

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
    const bg = isDark ? '#0f172a' : '#ffffff';
    const opacity = plotOpts.barOpacity / 100;

    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px">`);
    parts.push(`<rect width="${w}" height="${h}" fill="${bg}"/>`);

    if (hasTitle) {
      parts.push(`<text x="${w / 2}" y="26" text-anchor="middle" font-size="15" font-weight="700" fill="${txt}">${escapeXml(plotOpts.title)}</text>`);
    }

    for (const t of drawTicks) {
      const y = yScale(t);
      parts.push(`<line x1="${ml}" y1="${y}" x2="${w - mr}" y2="${y}" stroke="${grid}" stroke-width="1"/>`);
      parts.push(`<text x="${ml - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="${axis}">${(+t.toPrecision(6))}</text>`);
    }

    parts.push(`<line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + plotH}" stroke="${axis}" stroke-width="1.5"/>`);
    parts.push(`<line x1="${ml}" y1="${yScale(Math.max(yMin, Math.min(0, yMax)))}" x2="${w - mr}" y2="${yScale(Math.max(yMin, Math.min(0, yMax)))}" stroke="${axis}" stroke-width="1.5"/>`);

    if (plotOpts.yLabel) {
      parts.push(`<text transform="translate(16 ${mt + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="12" font-weight="600" fill="${txt}">${escapeXml(plotOpts.yLabel)}</text>`);
    }

    data.forEach((r, i) => {
      const cx = ml + band * i + band / 2;
      const zero = yScale(Math.max(yMin, Math.min(0, yMax)));
      const top = yScale(r.mean);
      const colour = palette[i % palette.length];

      parts.push(`<rect x="${cx - barW / 2}" y="${Math.min(top, zero)}" width="${barW}" height="${Math.abs(zero - top)}" fill="${colour}" fill-opacity="${opacity}" rx="3"/>`);

      const e = errs[i];
      if (Number.isFinite(e) && e > 0) {
        const hi = yScale(r.mean + e);
        const lo = yScale(r.mean - e);
        const cap = Math.min(barW / 3, 14);
        parts.push(`<line x1="${cx}" y1="${hi}" x2="${cx}" y2="${lo}" stroke="${txt}" stroke-width="1.6"/>`);
        parts.push(`<line x1="${cx - cap}" y1="${hi}" x2="${cx + cap}" y2="${hi}" stroke="${txt}" stroke-width="1.6"/>`);
        parts.push(`<line x1="${cx - cap}" y1="${lo}" x2="${cx + cap}" y2="${lo}" stroke="${txt}" stroke-width="1.6"/>`);
      }

      parts.push(`<text x="${cx}" y="${mt + plotH + 20}" text-anchor="middle" font-size="11" fill="${txt}">${escapeXml(String(r.key))}</text>`);
      parts.push(`<text x="${cx}" y="${mt + plotH + 36}" text-anchor="middle" font-size="10" fill="${axis}">n = ${r.n}</text>`);
    });

    if (plotOpts.showLegend) {
      parts.push(`<text x="${w - mr}" y="${mt - 8}" text-anchor="end" font-size="11" font-weight="600" fill="${axis}">Error bars: ${escapeXml(errLabel())}</text>`);
    }

    parts.push('</svg>');
    plotHost.innerHTML = parts.join('');
  }

  // # --- 6. Export ---
  if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => {
    const csv = resultsToCSV(computedResults);
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'error_bar_stats.csv');
    showToast('CSV exported.', 'success');
  });

  if (exportSvgBtn) exportSvgBtn.addEventListener('click', () => {
    const svg = plotHost && plotHost.querySelector('svg');
    if (!svg) return showToast('Nothing to export yet.', 'error');
    downloadBlob(
      new Blob([svg.outerHTML], { type: 'image/svg+xml;charset=utf-8' }),
      'error_bar_plot.svg'
    );
    showToast('SVG exported.', 'success');
  });

  if (exportPngBtn) exportPngBtn.addEventListener('click', () => {
    const svg = plotHost && plotHost.querySelector('svg');
    if (!svg) return showToast('Nothing to export yet.', 'error');

    const scale = 2;
    const img = new Image();
    const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml;charset=utf-8' });
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
          const kxBlock = tex => { try { return katex.renderToString(tex, { displayMode: true, throwOnError: false, output: "html" }); } catch (e) { return '<span class="text-slate-400 text-sm">Formula unavailable.</span>'; } };
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
      Object.assign(plotOpts, {
          title: '', yLabel: '', barStyle: 'fill', barWidth: 55, barRadius: 3, barOpacity: 85,
          capWidth: 12, gridlines: true, showN: true, showValues: false, showLegend: false,
          palette: 'default', yMinOverride: '', yMaxOverride: ''
      });
      // reset the controls to match
      const set = (id, v, prop = 'value') => { const el = document.getElementById(id); if (el) el[prop] = v; };
      set('optTitle', ''); set('optYLabel', ''); set('optBarStyle', 'fill'); set('optPalette', 'default');
      set('optBarWidth', 55); set('optBarRadius', 3); set('optBarOpacity', 85); set('optCapWidth', 12);
      set('optYMin', ''); set('optYMax', '');
      set('optGridlines', true, 'checked'); set('optShowN', true, 'checked');
      set('optShowValues', false, 'checked'); set('optShowLegend', false, 'checked');
      ['optBarWidth', 'optBarRadius', 'optBarOpacity', 'optCapWidth'].forEach(id => {
          const el = document.getElementById(id), out = document.getElementById(id + 'Val'); if (el && out) out.textContent = el.value;
      });
      if (computedResults.length) drawPlot();
      showToast("Plot style reset to defaults.", "info");
  });

});
