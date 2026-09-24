/*
 * Plot Builder: columns from CSV files in, a publication figure out.
 *
 * Sizes. A figure is specified the way a journal specifies it: a width and
 * height in inches, a resolution in dpi, and text and lines in points
 * (1 pt = 1/72 in). Plotly lays out in CSS pixels, 96 to the inch, so the
 * figure is laid out at width x 96 by height x 96 px and every point size is
 * multiplied by PT = 96 / 72. One layout serves every output:
 *
 *   preview  laid out at the export size and scaled with a CSS transform to
 *            fit the stage, so its proportions are the export's
 *   PNG      the same layout rendered at dpi / 96: 3.5 in at 300 dpi is
 *            1050 px, and the file records 300 dpi so it opens at 3.5 in
 *   SVG      the same drawing, with its width and height given in points
 *   Python   the same figsize and dpi, point sizes, colours, axis ranges and
 *            ticks, with the plot area where Plotly put it
 *
 * Every control re-renders the preview, debounced, through Plotly.react.
 */
(() => {
    'use strict';

    const PX_PER_IN = 96;
    const PT = PX_PER_IN / 72;          // CSS px per point
    const PAD = 4 * PT;                 // outer margin; automargin adds room for text
    const AXIS_LW = 0.8;                // pt: axis lines, ticks, grid, legend frame (matplotlib's default)
    const TICK_LEN = 3.5;               // pt (matplotlib's default)
    const TITLE_PAD = 6;                // pt between the title and the plot (matplotlib's default)
    const LABEL_PAD = 4;                // pt between tick labels and axis label (matplotlib's default)
    const MIN_IN = 0.5, MAX_IN = 40;    // figure side, inches
    const MAX_SIDE = 16384, MAX_AREA = 120e6;   // what a browser canvas can reliably draw

    // Okabe-Ito (Wong 2011), in its usual order: distinct under the common
    // colour-vision deficiencies. Black last, then the cycle repeats with
    // another dash so a repeated colour is still a different trace.
    const PALETTE = ['#0072B2', '#D55E00', '#009E73', '#E69F00', '#56B4E9', '#CC79A7', '#000000'];

    // matplotlib's dash patterns, in multiples of the line width, so both draw the same dashes.
    const DASHES = {
        solid: { label: 'Solid', mpl: '-', pattern: null },
        dashed: { label: 'Dashed', mpl: '--', pattern: [3.7, 1.6] },
        dotted: { label: 'Dotted', mpl: ':', pattern: [1, 1.65] },
        dashdot: { label: 'Dash-dot', mpl: '-.', pattern: [6.4, 1.6, 1, 1.6] }
    };
    const MARKERS = {
        circle: { label: 'Circle', plotly: 'circle', mpl: 'o' },
        square: { label: 'Square', plotly: 'square', mpl: 's' },
        triangle: { label: 'Triangle', plotly: 'triangle-up', mpl: '^' },
        diamond: { label: 'Diamond', plotly: 'diamond', mpl: 'D' },
        cross: { label: 'Cross', plotly: 'x', mpl: 'X' }
    };
    const MODES = { lines: 'Line', markers: 'Points', 'lines+markers': 'Both' };

    // Installed almost everywhere, so the preview, the PNG (rasterised from an
    // SVG that cannot use web fonts), the SVG opened elsewhere and matplotlib
    // all draw the same letters. The lists are tried in order, as CSS does.
    const FONTS = {
        arial: { css: 'Arial, Helvetica, "Liberation Sans", "Nimbus Sans", sans-serif', mpl: ['Arial', 'Helvetica', 'Liberation Sans', 'Nimbus Sans'], fallback: 'DejaVu Sans' },
        times: { css: '"Times New Roman", Times, "Liberation Serif", "Nimbus Roman", serif', mpl: ['Times New Roman', 'Times', 'Liberation Serif', 'Nimbus Roman'], fallback: 'DejaVu Serif' },
        dejavu: { css: '"DejaVu Sans", Verdana, sans-serif', mpl: ['DejaVu Sans'], fallback: 'DejaVu Sans' },
        courier: { css: '"Courier New", Courier, "Liberation Mono", "Nimbus Mono PS", monospace', mpl: ['Courier New', 'Courier', 'Liberation Mono', 'Nimbus Mono PS'], fallback: 'DejaVu Sans Mono' }
    };

    const BACKGROUNDS = {
        white: { paper: '#ffffff', ink: '#1a1a1a', grid: '176,176,176', frame: '#cccccc', legend: '255,255,255', mpl: '#ffffff' },
        transparent: { paper: 'rgba(0,0,0,0)', ink: '#1a1a1a', grid: '176,176,176', frame: '#cccccc', legend: '255,255,255', mpl: 'none' },
        dark: { paper: '#0f172a', ink: '#e2e8f0', grid: '100,116,139', frame: '#475569', legend: '15,23,42', mpl: '#0f172a' }
    };

    const PRESETS = { single: [3.5, 2.6], double: [7.2, 4.5], slide: [10, 5.625], square: [4, 4] };
    const PER_IN = { in: 1, cm: 2.54, mm: 25.4 };

    const LEGENDS = {
        'top-left': { x: 0.02, y: 0.98, xanchor: 'left', yanchor: 'top', mpl: 'upper left' },
        'top-right': { x: 0.98, y: 0.98, xanchor: 'right', yanchor: 'top', mpl: 'upper right' },
        'bottom-left': { x: 0.02, y: 0.02, xanchor: 'left', yanchor: 'bottom', mpl: 'lower left' },
        'bottom-right': { x: 0.98, y: 0.02, xanchor: 'right', yanchor: 'bottom', mpl: 'lower right' },
        outside: { x: 1.02, y: 1, xanchor: 'left', yanchor: 'top', mpl: 'upper left' }
    };

    const CONFIG = { displayModeBar: false, responsive: false, doubleClick: 'autosize', scrollZoom: false, showTips: false, displaylogo: false };

    const $ = id => document.getElementById(id);
    const els = {
        pane: document.querySelector('.pb-pane'),
        drop: $('uploadZone'), fileInput: $('fileInput'), choose: $('chooseFileBtn'), files: $('fileInventory'),
        traces: $('traceList'), traceEmpty: $('traceEmpty'), addTrace: $('addTraceBtn'),
        title: $('plotTitle'), xLabel: $('xAxisLabel'), yLabel: $('yAxisLabel'),
        preset: $('sizePreset'), width: $('exportWidth'), height: $('exportHeight'), dpi: $('exportDpi'), sizeNote: $('sizeNote'),
        xMin: $('xMin'), xMax: $('xMax'), yMin: $('yMin'), yMax: $('yMax'), xLog: $('xLogScale'), yLog: $('yLogScale'), rangeNote: $('rangeNote'),
        gridX: $('showGridX'), gridY: $('showGridY'), gridOpacity: $('gridOpacity'), gridField: $('gridOpacityField'),
        legend: $('legendPosition'), font: $('fontFamily'),
        titleSize: $('titleSize'), axisSize: $('axisSize'), tickSize: $('tickSize'), legendSize: $('legendSize'),
        lineWidth: $('lineWidth'), markerSize: $('markerSize'),
        stage: $('pbStage'), sheet: $('pbSheet'), gd: $('plotlyCanvas'), empty: $('emptyPlotState'),
        readout: $('sizeReadout'), scale: $('viewScale'), hint: $('viewHint'), status: $('exportStatus'),
        png: $('downloadPngBtn'), svg: $('downloadSvgBtn'), py: $('copyPyBtn'),
        modal: $('codeModal'), code: $('codeBlock'), copyCode: $('copyCodeBtn'), downloadPy: $('downloadPyBtn'),
        closeCode: $('closeCodeBtn'), embed: $('embedData'), embedText: $('embedDataText'), toasts: $('toastContainer')
    };
    const RANGE_HINT = els.rangeNote.textContent;

    // ------------------------------------------------------------------ state
    const files = new Map();            // id -> { id, name, text, rows, headers, numeric, delimiter, renamed, example }
    let traces = [];                    // { id, fileId, x, y, name, autoName, color, mode, dash, marker }
    let nextTrace = 1;
    const size = { w: PRESETS.single[0], h: PRESETS.single[1] };   // inches
    const seg = { unit: 'in', frame: 'box', ticks: 'inside', background: 'white' };

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const trim = (v, d) => String(+v.toFixed(d));

    // ----------------------------------------------------------------- toasts
    function toast(msg, kind) {
        const el = document.createElement('div');
        const icon = kind === 'ok' ? 'fa-circle-check' : kind === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info';
        el.className = 'stk-toast' + (kind === 'ok' ? ' stk-toast-ok' : kind === 'error' ? ' stk-toast-danger' : '');
        el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        el.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span></span>`;
        el.lastChild.textContent = msg;
        els.toasts.appendChild(el);
        setTimeout(() => el.remove(), kind === 'error' ? 6000 : 4000);
    }

    // ------------------------------------------------------------------- data
    function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

    function addParsed(id, name, text, example, autoTrace) {
        const res = Papa.parse(text.replace(/\r\n?/g, '\n'), { header: true, dynamicTyping: true, skipEmptyLines: 'greedy' });
        const headers = (res.meta.fields || []).filter(h => h != null && String(h).trim() !== '');
        if (!res.data.length || headers.length < 2) {
            toast(`${name} needs a header row and at least two columns.`, 'error');
            return false;
        }
        const numeric = headers.filter(h => {
            let n = 0;
            for (const r of res.data) if (isNum(r[h])) n++;
            return n > 0 && n >= res.data.length / 2;
        });
        files.set(id, {
            id, name, example, headers, numeric,
            text: text.replace(/\r\n?/g, '\n'),
            rows: res.data,
            delimiter: res.meta.delimiter || ',',
            renamed: res.meta.renamedHeaders || {}
        });
        renderFiles();
        if (autoTrace && !traces.length) {
            addTrace(id);
            if (numeric.length < 2) toast(`${name} has fewer than two columns of numbers. Pick the columns to plot in step 2.`, 'error');
        }
        renderTraces();
        scheduleRender(0);
        return true;
    }

    async function addFiles(list) {
        for (const file of Array.from(list)) {
            if (!/\.(csv|tsv|txt)$/i.test(file.name)) { toast(`Skipped ${file.name}: the builder reads .csv, .tsv and .txt tables.`, 'error'); continue; }
            const id = `${file.name}:${file.size}`;
            if (files.has(id)) { toast(`${file.name} is already loaded.`); continue; }
            if (file.size > 50e6) { toast(`${file.name} is over 50 MB, too large to plot in the browser.`, 'error'); continue; }
            let text;
            try { text = await file.text(); } catch (e) { toast(`Could not read ${file.name}.`, 'error'); continue; }
            if (addParsed(id, file.name, text, false, true)) toast(`Loaded ${file.name}: ${files.get(id).rows.length} rows.`, 'ok');
        }
        els.fileInput.value = '';
    }

    // Two logistic growth curves read every hour, with fixed "noise", so the
    // example is the same on every load and in the Python script.
    function exampleCsv() {
        let seed = 7;
        const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const grow = (t, n0, cap, r) => cap / (1 + (cap / n0 - 1) * Math.exp(-r * t));
        const rows = ['time_h,control_OD600,treated_OD600'];
        for (let t = 0; t <= 24; t++) {
            const c = grow(t, 0.02, 1.6, 0.55) * (1 + (rand() - 0.5) * 0.08);
            const d = grow(t, 0.02, 1.1, 0.32) * (1 + (rand() - 0.5) * 0.08);
            rows.push(`${t},${c.toFixed(3)},${d.toFixed(3)}`);
        }
        return rows.join('\n') + '\n';
    }

    function loadExample() {
        if (files.has('example')) { toast('The example is already loaded.'); return; }
        if (!addParsed('example', 'growth_example.csv', exampleCsv(), true, false)) return;
        addTrace('example', { x: 'time_h', y: 'control_OD600', name: 'Control', mode: 'lines+markers', marker: 'circle' });
        addTrace('example', { x: 'time_h', y: 'treated_OD600', name: 'Treated', mode: 'lines+markers', dash: 'dashed', marker: 'square' });
        if (!els.xLabel.value.trim()) els.xLabel.value = 'Time (h)';
        if (!els.yLabel.value.trim()) els.yLabel.value = 'OD<sub>600</sub>';
        renderTraces();
        scheduleRender(0);
        toast('Loaded two bacterial growth curves. Try a log Y axis.', 'ok');
    }

    function removeFile(id) {
        const f = files.get(id);
        if (!f) return;
        files.delete(id);
        traces = traces.filter(t => t.fileId !== id);
        renderFiles();
        renderTraces();
        scheduleRender(0);
        toast(`Removed ${f.name}.`);
    }

    function renderFiles() {
        els.files.innerHTML = [...files.values()].map(f => `
            <li class="pb-file">
                <i class="fa-solid ${f.example ? 'fa-flask-vial' : 'fa-file-csv'}" aria-hidden="true"></i>
                <span class="pb-file-name" title="${esc(f.name)}">${esc(f.name)}</span>
                <span class="pb-file-meta">${f.rows.length} rows, ${f.headers.length} columns</span>
                <button type="button" class="stk-btn stk-btn-sm stk-btn-ghost stk-btn-icon" data-remove-file="${esc(f.id)}" aria-label="Remove ${esc(f.name)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
            </li>`).join('');
        els.addTrace.disabled = files.size === 0;
    }

    // ----------------------------------------------------------------- traces
    function addTrace(fileId, o = {}) {
        const f = files.get(fileId);
        const usedY = new Set(traces.filter(t => t.fileId === fileId).map(t => t.y));
        const x = o.x || f.numeric[0] || f.headers[0];
        const y = o.y || f.numeric.find(h => h !== x && !usedY.has(h)) || f.numeric.find(h => h !== x)
            || f.headers.find(h => h !== x) || f.headers[0];
        const usedC = new Set(traces.map(t => t.color.toLowerCase()));
        const free = PALETTE.find(c => !usedC.has(c.toLowerCase()));
        const round = Math.floor(traces.length / PALETTE.length);
        const t = {
            id: 't' + nextTrace++, fileId, x, y,
            name: o.name || y, autoName: !o.name,
            color: o.color || free || PALETTE[traces.length % PALETTE.length],
            mode: o.mode || 'lines',
            dash: o.dash || (free ? 'solid' : ['dashed', 'dotted', 'dashdot'][round % 3]),
            marker: o.marker || 'circle'
        };
        traces.push(t);
        return t;
    }

    const traceById = id => traces.find(t => t.id === id);

    function options(list, current) {
        return list.map(([v, l]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(l)}</option>`).join('');
    }

    function traceCard(t, i, multi) {
        const f = files.get(t.fileId);
        const cols = f.headers.map(h => [h, h]);
        const n = t.id, k = i + 1;
        const card = document.createElement('div');
        card.className = 'pb-trace';
        card.dataset.id = t.id;
        card.innerHTML = `
            <div class="pb-trace-h">
                <input type="color" class="pb-swatch" data-f="color" value="${esc(t.color)}" aria-label="Colour of trace ${k}">
                <input type="text" class="stk-input stk-input-sm" data-f="name" value="${esc(t.name)}" placeholder="${esc(t.y)}" aria-label="Legend name of trace ${k}" autocomplete="off">
                <button type="button" class="stk-btn stk-btn-sm stk-btn-ghost stk-btn-icon" data-act="remove" aria-label="Remove trace ${k}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
            </div>
            ${multi ? `<div class="stk-field"><label for="${n}-file">File</label><select id="${n}-file" class="stk-select stk-select-sm" data-f="fileId">${options([...files.values()].map(x => [x.id, x.name]), t.fileId)}</select></div>` : ''}
            <div class="pb-grid2">
                <div class="stk-field"><label for="${n}-x">X column</label><select id="${n}-x" class="stk-select stk-select-sm" data-f="x">${options(cols, t.x)}</select></div>
                <div class="stk-field"><label for="${n}-y">Y column</label><select id="${n}-y" class="stk-select stk-select-sm" data-f="y">${options(cols, t.y)}</select></div>
            </div>
            <div class="pb-grid3">
                <div class="stk-field"><label for="${n}-mode">Draw</label><select id="${n}-mode" class="stk-select stk-select-sm" data-f="mode">${options(Object.entries(MODES), t.mode)}</select></div>
                <div class="stk-field${t.mode === 'markers' ? ' is-off' : ''}"><label for="${n}-dash">Line</label><select id="${n}-dash" class="stk-select stk-select-sm" data-f="dash"${t.mode === 'markers' ? ' disabled' : ''}>${options(Object.entries(DASHES).map(([v, d]) => [v, d.label]), t.dash)}</select></div>
                <div class="stk-field${t.mode === 'lines' ? ' is-off' : ''}"><label for="${n}-marker">Marker</label><select id="${n}-marker" class="stk-select stk-select-sm" data-f="marker"${t.mode === 'lines' ? ' disabled' : ''}>${options(Object.entries(MARKERS).map(([v, d]) => [v, d.label]), t.marker)}</select></div>
            </div>
            <p class="pb-trace-note" data-note aria-live="polite"></p>`;
        return card;
    }

    function renderTraces() {
        const multi = files.size > 1;
        els.traces.replaceChildren(...traces.map((t, i) => traceCard(t, i, multi)));
        els.traceEmpty.hidden = traces.length > 0;
        els.traceEmpty.textContent = files.size
            ? 'No traces. Add one to plot a column against another.'
            : 'Each trace plots one column against another. The first is drawn as soon as a file loads.';
        els.addTrace.disabled = files.size === 0;
        refreshLabelPlaceholders();
    }

    function setDisabled(card, field, off) {
        const sel = card.querySelector(`[data-f="${field}"]`);
        sel.disabled = off;
        sel.closest('.stk-field').classList.toggle('is-off', off);
    }

    els.traces.addEventListener('input', e => {
        const el = e.target.closest('[data-f]');
        if (!el || el.tagName === 'SELECT') return;
        const t = traceById(el.closest('.pb-trace').dataset.id);
        if (el.dataset.f === 'name') { t.name = el.value; t.autoName = el.value.trim() === ''; }
        if (el.dataset.f === 'color') t.color = el.value;
    });

    els.traces.addEventListener('change', e => {
        const el = e.target.closest('select[data-f]');
        if (!el) return;
        const card = el.closest('.pb-trace');
        const t = traceById(card.dataset.id);
        const f = el.dataset.f, v = el.value;
        if (f === 'fileId') {
            const file = files.get(v);
            t.fileId = v;
            t.x = file.numeric[0] || file.headers[0];
            t.y = file.numeric.find(h => h !== t.x) || file.headers.find(h => h !== t.x) || t.x;
            if (t.autoName) t.name = t.y;
            renderTraces();
        } else if (f === 'y') {
            t.y = v;
            const name = card.querySelector('[data-f="name"]');
            name.placeholder = v;
            if (t.autoName) { t.name = v; name.value = v; }
        } else if (f === 'mode') {
            t.mode = v;
            setDisabled(card, 'dash', v === 'markers');
            setDisabled(card, 'marker', v === 'lines');
        } else {
            t[f] = v;
        }
        refreshLabelPlaceholders();
    });

    els.traces.addEventListener('click', e => {
        const btn = e.target.closest('[data-act="remove"]');
        if (!btn) return;
        const id = btn.closest('.pb-trace').dataset.id;
        const i = traces.findIndex(t => t.id === id);
        traces.splice(i, 1);
        renderTraces();
        scheduleRender(0);
        const next = els.traces.querySelectorAll('[data-act="remove"]')[Math.min(i, traces.length - 1)];
        (next || els.addTrace).focus();
    });

    els.addTrace.addEventListener('click', () => {
        if (!files.size) return;
        const last = traces[traces.length - 1];
        const t = addTrace(last && files.has(last.fileId) ? last.fileId : files.keys().next().value);
        if (last && last.fileId === t.fileId) {
            // Follow the last trace's X and style; plot a column it does not.
            const f = files.get(t.fileId);
            t.x = last.x;
            t.mode = last.mode;
            if (t.y === t.x) t.y = f.numeric.find(h => h !== t.x) || f.headers.find(h => h !== t.x) || t.y;
            if (t.autoName) t.name = t.y;
        }
        renderTraces();
        scheduleRender(0);
        const cards = els.traces.querySelectorAll('.pb-trace');
        cards[cards.length - 1].querySelector('[data-f="name"]').focus();
    });

    function seriesOf(t) {
        const f = files.get(t.fileId);
        const xs = [], ys = [];
        if (!f) return { x: xs, y: ys };
        for (const r of f.rows) {
            const a = r[t.x], b = r[t.y];
            if (isNum(a) && isNum(b)) { xs.push(a); ys.push(b); }
        }
        return { x: xs, y: ys };
    }

    // ---------------------------------------------------------------- settings
    function defaultLabel(k) {
        const t = traces[0];
        return t ? (k === 'x' ? t.x : t.y) : '';
    }

    function refreshLabelPlaceholders() {
        els.xLabel.placeholder = defaultLabel('x') || 'Column name';
        els.yLabel.placeholder = defaultLabel('y') || 'Column name';
    }

    function axisSettings(k) {
        const log = els[k + 'Log'].checked;
        const raw = [els[k + 'Min'].value.trim(), els[k + 'Max'].value.trim()];
        const vals = raw.map(v => (v === '' ? null : parseFloat(v)));
        let problem = '';
        const lim = vals.map((v, i) => {
            if (v == null) return null;
            if (!Number.isFinite(v)) { problem = `The ${k.toUpperCase()} ${i ? 'upper' : 'lower'} limit is not a number, so it is ignored.`; return null; }
            if (log && v <= 0) { problem = `A log axis starts above zero, so the ${k.toUpperCase()} limit ${v} is ignored.`; return null; }
            return v;
        });
        if (lim[0] != null && lim[1] != null && lim[0] === lim[1]) {
            problem = `The ${k.toUpperCase()} limits are equal, so the axis fits the data.`;
            lim[0] = lim[1] = null;
        }
        const own = (k === 'x' ? els.xLabel : els.yLabel).value.trim();
        return { label: own || defaultLabel(k), log, min: lim[0], max: lim[1], grid: (k === 'x' ? els.gridX : els.gridY).checked, problem };
    }

    function readSettings() {
        const x = axisSettings('x'), y = axisSettings('y');
        return {
            dpi: +els.dpi.value || 300,
            wIn: size.w, hIn: size.h,
            title: els.title.value.trim(),
            x, y,
            frame: seg.frame, ticks: seg.ticks, background: seg.background,
            gridOpacity: (+els.gridOpacity.value || 50) / 100,
            legend: els.legend.value,
            font: FONTS[els.font.value] ? els.font.value : 'arial',
            titleSize: +els.titleSize.value, labelSize: +els.axisSize.value,
            tickSize: +els.tickSize.value, legendSize: +els.legendSize.value,
            lineWidth: +els.lineWidth.value, markerSize: +els.markerSize.value
        };
    }

    const pixels = s => ({ w: Math.floor(s.wIn * s.dpi + 1e-6), h: Math.floor(s.hIn * s.dpi + 1e-6) });
    const tooBig = p => p.w > MAX_SIDE || p.h > MAX_SIDE || p.w * p.h > MAX_AREA;
    const showsLegend = s => s.legend !== 'hidden' && traces.length > 1;

    // ------------------------------------------------------------------ figure
    // Plotly's markup for the text fields is what the user types: <sub>, <sup>, <b>, <i>, <br>.
    function buildFigure(s) {
        const th = BACKGROUNDS[s.background];
        const family = FONTS[s.font].css;
        const W = s.wIn * PX_PER_IN, H = s.hIn * PX_PER_IN;
        const grid = `rgba(${th.grid},${s.gridOpacity})`;

        const data = traces.map(t => {
            const { x, y } = seriesOf(t);
            const p = DASHES[t.dash].pattern;
            return {
                type: 'scatter', mode: t.mode, x, y,
                name: t.name.trim() || t.y,
                line: {
                    color: t.color, width: s.lineWidth * PT,
                    dash: p ? p.map(v => +(v * s.lineWidth * PT).toFixed(3) + 'px').join(',') : 'solid'
                },
                marker: { color: t.color, size: s.markerSize * PT, symbol: MARKERS[t.marker].plotly, line: { width: 0 } },
                cliponaxis: true,
                hovertemplate: '%{x:.4~g}, %{y:.4~g}<extra>%{fullData.name}</extra>'
            };
        });

        const axis = a => {
            const spec = {
                type: a.log ? 'log' : 'linear',
                title: { text: a.label, font: { size: s.labelSize * PT, color: th.ink, family }, standoff: LABEL_PAD * PT },
                automargin: true,
                showline: true, linecolor: th.ink, linewidth: AXIS_LW * PT,
                mirror: s.frame === 'box' ? (s.ticks ? 'ticks' : true) : false,
                ticks: s.ticks, ticklen: TICK_LEN * PT, tickwidth: AXIS_LW * PT, tickcolor: th.ink,
                tickfont: { size: s.tickSize * PT, color: th.ink, family },
                exponentformat: 'power', showexponent: 'all',
                showgrid: a.grid, gridcolor: grid, gridwidth: AXIS_LW * PT,
                zeroline: false,
                hoverformat: '.4~g'
            };
            const f = v => (a.log ? Math.log10(v) : v);
            if (a.min != null && a.max != null) { spec.range = [f(a.min), f(a.max)]; spec.autorange = false; }
            else if (a.min != null) { spec.range = [f(a.min), null]; spec.autorange = 'max'; }
            else if (a.max != null) { spec.range = [null, f(a.max)]; spec.autorange = 'min'; }
            else spec.autorange = true;
            return spec;
        };

        const layout = {
            width: W, height: H, autosize: false,
            separators: '.',            // no thousands separator, as matplotlib
            font: { family, size: s.tickSize * PT, color: th.ink },
            paper_bgcolor: th.paper, plot_bgcolor: th.paper,
            margin: { l: PAD, r: PAD, t: PAD, b: PAD, pad: 0, autoexpand: true },
            xaxis: axis(s.x), yaxis: axis(s.y),
            showlegend: showsLegend(s),
            hovermode: 'closest', dragmode: 'zoom'
        };
        if (layout.showlegend) {
            const L = LEGENDS[s.legend] || LEGENDS['top-left'];
            layout.legend = {
                x: L.x, y: L.y, xanchor: L.xanchor, yanchor: L.yanchor, xref: 'paper', yref: 'paper',
                font: { size: s.legendSize * PT, color: th.ink, family },
                bgcolor: `rgba(${th.legend},0.8)`, bordercolor: th.frame, borderwidth: AXIS_LW * PT,
                tracegroupgap: 0
            };
        }
        if (s.title) {
            layout.title = {
                text: s.title, font: { size: s.titleSize * PT, color: th.ink, family },
                x: 0.5, xref: 'paper', xanchor: 'center',
                y: 1, yref: 'paper', yanchor: 'bottom', pad: { b: TITLE_PAD * PT },
                automargin: true
            };
        }
        return { data, layout };
    }

    // ------------------------------------------------------------------ render
    let timer = 0, dirty = true, plotted = false, hooked = false, rendering = Promise.resolve();
    let scaleK = 1, lastSettings = null;

    function scheduleRender(delay = 160) {
        dirty = true;
        clearTimeout(timer);
        timer = setTimeout(renderNow, delay);
    }

    function fitSheet(s) {
        const W = s.wIn * PX_PER_IN, H = s.hIn * PX_PER_IN;
        const cs = getComputedStyle(els.stage);
        const aw = els.stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const ah = els.stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        scaleK = Math.max(0.02, Math.min(aw / W, ah / H)) || 1;
        els.sheet.style.width = (W * scaleK).toFixed(2) + 'px';
        els.sheet.style.height = (H * scaleK).toFixed(2) + 'px';
        els.gd.style.width = W + 'px';
        els.gd.style.height = H + 'px';
        els.gd.style.transform = `scale(${scaleK})`;
    }

    function fmtIn(v) { return trim(v, v < 10 ? 2 : 1); }

    function updateReadout(s) {
        const p = pixels(s);
        const dims = `${fmtIn(s.wIn)} × ${fmtIn(s.hIn)} in`;
        els.readout.textContent = `${dims} · ${s.dpi} dpi · ${p.w} × ${p.h} px`;
        els.scale.textContent = `Shown at ${Math.round(scaleK * 100)}% of its printed size.`;
        document.querySelectorAll('[data-pb-size]').forEach(el => { el.textContent = dims; });
        let note = '';
        if (tooBig(p)) note = `At ${s.dpi} dpi the PNG would be ${p.w} × ${p.h} px, more than a browser can draw. Lower the resolution or the size; the SVG is unaffected.`;
        else if (seg.unit === 'px') note = `${p.w} × ${p.h} px at ${s.dpi} dpi is a ${dims} figure; text and lines are sized in points at that size.`;
        els.sizeNote.textContent = note;
        els.sizeNote.classList.toggle('pb-warn', tooBig(p));
        const problem = s.x.problem || s.y.problem;
        els.rangeNote.textContent = problem || RANGE_HINT;
        els.rangeNote.classList.toggle('pb-warn', !!problem);
    }

    function updateTraceNotes(s) {
        els.traces.querySelectorAll('.pb-trace').forEach(card => {
            const t = traceById(card.dataset.id);
            const note = card.querySelector('[data-note]');
            if (!t) return;
            const { x, y } = seriesOf(t);
            let msg = '';
            if (!x.length) msg = `No rows where both ${t.x} and ${t.y} are numbers, so nothing is drawn.`;
            else {
                const off = x.filter((v, i) => (s.x.log && v <= 0) || (s.y.log && y[i] <= 0)).length;
                if (off) msg = `${off} of ${x.length} points are at or below zero and are left off the log axis.`;
                else if (t.x === t.y) msg = 'X and Y are the same column.';
            }
            if (note.textContent !== msg) note.textContent = msg;
        });
    }

    function setEmpty(empty) {
        els.sheet.classList.toggle('is-empty', empty);
        els.empty.hidden = !empty;
        els.hint.hidden = empty;
        [els.png, els.svg, els.py].forEach(b => { b.disabled = empty; });
    }

    function renderNow() {
        clearTimeout(timer);
        dirty = false;
        const s = readSettings();
        lastSettings = s;
        fitSheet(s);
        updateReadout(s);
        els.sheet.classList.toggle('is-dark', s.background === 'dark');
        els.sheet.classList.toggle('is-transparent', s.background === 'transparent');
        els.gridField.classList.toggle('is-off', !(s.x.grid || s.y.grid));
        els.gridOpacity.disabled = !(s.x.grid || s.y.grid);
        const live = traces.length > 0;
        setEmpty(!live);
        if (!live) {
            if (plotted) { Plotly.purge(els.gd); plotted = false; hooked = false; }
            rendering = Promise.resolve();
            return rendering;
        }
        updateTraceNotes(s);
        els.gd.setAttribute('aria-label', `Figure preview: ${traces.length} trace${traces.length > 1 ? 's' : ''}, `
            + `${s.y.label.replace(/<[^>]+>/g, '')} against ${s.x.label.replace(/<[^>]+>/g, '')}`);
        const fig = buildFigure(s);
        fig.layout.hoverlabel = { font: { size: 12 / scaleK }, namelength: -1 };   // 12 px on screen at any scale
        rendering = Plotly.react(els.gd, fig.data, fig.layout, CONFIG).then(() => {
            plotted = true;
            if (!hooked) { els.gd.on('plotly_relayout', onRelayout); hooked = true; }
        }).catch(err => {
            console.error(err);
            toast('The preview could not be drawn with these settings.', 'error');
        });
        return rendering;
    }

    async function flush() {
        if (dirty) renderNow();
        await rendering;
    }

    // Zooming on the preview is a change to the figure: the limits it lands on
    // go into the axis fields, so the downloads and the script match what is
    // on screen. Fitting again (double-click) clears them.
    function tidy(v, span) {
        const digits = clamp(Math.ceil(Math.log10(Math.abs(v) / span || 1)) + 3, 3, 12);
        return String(parseFloat(v.toPrecision(digits)));
    }
    function onRelayout(ev) {
        let changed = false;
        ['x', 'y'].forEach(k => {
            if (ev[k + 'axis.autorange'] === true) {
                els[k + 'Min'].value = ''; els[k + 'Max'].value = '';
                changed = true;
                return;
            }
            const r = ev[k + 'axis.range'];
            let lo = ev[k + 'axis.range[0]'], hi = ev[k + 'axis.range[1]'];
            if (lo == null && r) { lo = r[0]; hi = r[1]; }
            if (lo == null || hi == null) return;
            const log = els[k + 'Log'].checked;
            if (log) { lo = Math.pow(10, lo); hi = Math.pow(10, hi); }
            const span = Math.abs(hi - lo) || 1;
            els[k + 'Min'].value = tidy(lo, span);
            els[k + 'Max'].value = tidy(hi, span);
            changed = true;
        });
        if (changed) scheduleRender(0);
    }

    new ResizeObserver(() => {
        if (!lastSettings) return;
        const before = scaleK;
        fitSheet(lastSettings);
        updateReadout(lastSettings);
        if (plotted && Math.abs(before - scaleK) > 1e-3) {
            clearTimeout(els.gd._pbHover);
            els.gd._pbHover = setTimeout(() => Plotly.relayout(els.gd, { 'hoverlabel.font.size': 12 / scaleK }), 200);
        }
    }).observe(els.stage);

    // -------------------------------------------------------------- controls
    function showSize() {
        const u = seg.unit, dpi = +els.dpi.value || 300;
        const show = v => (u === 'px' ? String(Math.round(v * dpi)) : trim(v * PER_IN[u], u === 'mm' ? 1 : u === 'cm' ? 2 : 3));
        els.width.value = show(size.w);
        els.height.value = show(size.h);
        els.width.step = els.height.step = u === 'px' ? '1' : 'any';
    }

    function readSize(input, key) {
        const v = parseFloat(input.value);
        const dpi = +els.dpi.value || 300;
        const inches = seg.unit === 'px' ? v / dpi : v / PER_IN[seg.unit];
        const ok = Number.isFinite(inches) && inches >= MIN_IN && inches <= MAX_IN;
        input.classList.toggle('is-invalid', !ok && input.value.trim() !== '');
        input.setAttribute('aria-invalid', String(!ok));
        if (ok) size[key] = inches;
        const match = Object.entries(PRESETS).find(([, [w, h]]) => Math.abs(w - size.w) < 0.005 && Math.abs(h - size.h) < 0.005);
        els.preset.value = match ? match[0] : 'custom';
    }

    function setSeg(name, value) {
        seg[name] = value;
        document.querySelectorAll(`[data-pb-seg="${name}"] > button`).forEach(b => {
            b.setAttribute('aria-pressed', String(b.dataset.value === value));
        });
    }

    document.querySelectorAll('[data-pb-seg]').forEach(group => {
        group.addEventListener('click', e => {
            const b = e.target.closest('button[data-value]');
            if (!b || b.getAttribute('aria-pressed') === 'true') return;
            const name = group.dataset.pbSeg;
            setSeg(name, b.dataset.value);
            if (name === 'unit') showSize();
            scheduleRender(0);
        });
    });

    els.preset.addEventListener('change', () => {
        const p = PRESETS[els.preset.value];
        if (!p) return;
        size.w = p[0]; size.h = p[1];
        [els.width, els.height].forEach(i => { i.classList.remove('is-invalid'); i.removeAttribute('aria-invalid'); });
        showSize();
    });
    els.width.addEventListener('input', () => readSize(els.width, 'w'));
    els.height.addEventListener('input', () => readSize(els.height, 'h'));
    [els.width, els.height].forEach(i => i.addEventListener('blur', () => { if (!i.classList.contains('is-invalid')) showSize(); }));
    els.dpi.addEventListener('change', () => {
        // A size in pixels keeps its pixels; the physical size follows.
        if (seg.unit === 'px') { readSize(els.width, 'w'); readSize(els.height, 'h'); }
    });

    function syncSlider(r) {
        const out = $(r.id + 'Val');
        if (out) out.textContent = r.value;
        r.setAttribute('aria-valuetext', `${r.value} ${r.dataset.unit === '%' ? 'percent' : 'points'}`);
    }
    els.pane.querySelectorAll('input[type="range"]').forEach(r => {
        syncSlider(r);
        r.addEventListener('input', () => syncSlider(r));
    });

    // Any change in the settings redraws the preview. Discrete choices redraw
    // at once; typing and dragging a slider settle for a moment first.
    els.pane.addEventListener('input', e => {
        const t = e.target;
        if (t === els.fileInput) return;
        scheduleRender(t.type === 'checkbox' ? 0 : 160);
    });
    els.pane.addEventListener('change', e => {
        if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') scheduleRender(0);
    });

    // ------------------------------------------------------------ file input
    els.choose.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', e => addFiles(e.target.files));
    els.drop.addEventListener('click', e => {
        if (e.target === els.fileInput || e.target.closest('button')) return;
        els.fileInput.click();
    });
    ['dragenter', 'dragover'].forEach(n => els.drop.addEventListener(n, e => {
        e.preventDefault();
        els.drop.classList.add('is-over');
    }));
    els.drop.addEventListener('dragleave', e => {
        if (!els.drop.contains(e.relatedTarget)) els.drop.classList.remove('is-over');
    });
    els.drop.addEventListener('drop', e => {
        e.preventDefault();
        els.drop.classList.remove('is-over');
        if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    els.files.addEventListener('click', e => {
        const b = e.target.closest('[data-remove-file]');
        if (b) removeFile(b.dataset.removeFile);
    });
    document.querySelectorAll('[data-pb-sample]').forEach(b => b.addEventListener('click', loadExample));

    // ---------------------------------------------------------------- export
    function slug(s) {
        const t = String(s || '').replace(/<[^>]+>/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
        return t || 'figure';
    }

    function save(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }

    // PNG files carry their resolution in a pHYs chunk. A canvas writes none,
    // so without it Word or Illustrator would place a 300 dpi figure at 72 or
    // 96 dpi, three or four times too large.
    const CRC = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();
    function crc32(bytes) {
        let c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }
    function pngWithDpi(png, dpi) {
        const ppm = Math.round(dpi / 0.0254);
        const phys = new Uint8Array(21);
        const dv = new DataView(phys.buffer);
        dv.setUint32(0, 9);
        phys.set([0x70, 0x48, 0x59, 0x73], 4);      // "pHYs"
        dv.setUint32(8, ppm);
        dv.setUint32(12, ppm);
        phys[16] = 1;                               // unit: metre
        dv.setUint32(17, crc32(phys.subarray(4, 17)));
        const parts = [png.subarray(0, 8)];
        const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
        for (let off = 8; off + 12 <= png.length;) {
            const len = view.getUint32(off);
            const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
            const end = off + 12 + len;
            if (type !== 'pHYs') parts.push(png.subarray(off, end));
            if (type === 'IHDR') parts.push(phys);
            off = end;
        }
        return new Blob(parts, { type: 'image/png' });
    }
    function dataUrlBytes(url) {
        const bin = atob(url.slice(url.indexOf(',') + 1));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    async function withBusy(btn, job) {
        if (btn.getAttribute('aria-busy') === 'true') return;
        btn.setAttribute('aria-busy', 'true');
        try { await job(); } catch (err) {
            console.error(err);
            toast('The export failed. Try a smaller size or resolution.', 'error');
        } finally { btn.removeAttribute('aria-busy'); }
    }

    function exported(msg) {
        els.status.textContent = msg;
    }

    els.png.addEventListener('click', () => withBusy(els.png, async () => {
        await flush();
        const s = lastSettings, p = pixels(s);
        if (tooBig(p)) { toast(`At ${s.dpi} dpi the PNG would be ${p.w} × ${p.h} px, more than a browser can draw. Lower the resolution or the size.`, 'error'); return; }
        const fig = buildFigure(s);
        const url = await Plotly.toImage(fig, {
            format: 'png', width: fig.layout.width, height: fig.layout.height,
            scale: s.dpi / PX_PER_IN * (1 + 1e-9)
        });
        const name = slug(s.title) + '.png';
        save(pngWithDpi(dataUrlBytes(url), s.dpi), name);
        exported(`Saved ${name}: ${p.w} × ${p.h} px at ${s.dpi} dpi (${fmtIn(s.wIn)} × ${fmtIn(s.hIn)} in).`);
    }));

    els.svg.addEventListener('click', () => withBusy(els.svg, async () => {
        await flush();
        const s = lastSettings;
        const fig = buildFigure(s);
        const url = await Plotly.toImage(fig, { format: 'svg', width: fig.layout.width, height: fig.layout.height });
        let svg = decodeURIComponent(url.slice(url.indexOf(',') + 1));
        // Width and height in points, the unit every editor reads the same way.
        const wPt = trim(s.wIn * 72, 3), hPt = trim(s.hIn * 72, 3);
        svg = svg.replace(/^(<svg\b[^>]*?)\swidth="[^"]*"\s+height="[^"]*"/, `$1 width="${wPt}pt" height="${hPt}pt"`);
        const name = slug(s.title) + '.svg';
        save(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svg], { type: 'image/svg+xml' }), name);
        exported(`Saved ${name}: ${fmtIn(s.wIn)} × ${fmtIn(s.hIn)} in (${wPt} × ${hPt} pt).`);
    }));

    // ------------------------------------------------------------- matplotlib
    const pyStr = s => "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\t/g, '\\t') + "'";
    const pyNum = v => String(parseFloat(Number(v).toPrecision(8)));
    const pyList = a => '[' + a.join(', ') + ']';

    // Plotly's text markup, as matplotlib writes it: $ is literal, <sub>,
    // <sup>, <i> and <b> become mathtext, <br> a new line, other tags go.
    function mplText(s) {
        const math = a => a.replace(/<[^>]+>/g, '').replace(/([{}\\])/g, '\\$1').replace(/ /g, '\\ ');
        return String(s)
            .replace(/\$/g, '\\$')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<sub>(.*?)<\/sub>/gi, (m, a) => `$_{${math(a)}}$`)
            .replace(/<sup>(.*?)<\/sup>/gi, (m, a) => `$^{${math(a)}}$`)
            .replace(/<i>(.*?)<\/i>/gi, (m, a) => `$\\mathit{${math(a)}}$`)
            .replace(/<b>(.*?)<\/b>/gi, (m, a) => `$\\mathbf{${math(a)}}$`)
            .replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    // A tick label as Plotly drew it: "1.5×10<sup>−4</sup>", "10<sup>2</sup>", "−5".
    function mplTick(text) {
        const m = String(text).match(/^(.*?)<sup>(.*?)<\/sup>$/);
        if (!m) return String(text).replace(/<[^>]+>/g, '');
        return '$' + m[1].replace(/−/g, '-').replace('×', '{\\times}') + '^{' + m[2].replace(/−/g, '-') + '}$';
    }
    function colRef(f, name) {
        // PapaParse renames a repeated header (x, x_1); pandas would call it x.1.
        if (f.renamed && Object.prototype.hasOwnProperty.call(f.renamed, name)) return `df.columns[${f.headers.indexOf(name)}]`;
        return pyStr(name);
    }
    function pyVarName(f) {
        const base = f.name.replace(/\.[^.]+$/, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        return (/^[A-Z]/.test(base) ? base : 'DATA_' + base) + '_CSV';
    }

    // Plotly's legend in points: each row is max(1.3 em, 16 px) + 3 px tall,
    // the box adds about 8.6 pt, and the text starts 40 px from the left edge.
    // matplotlib's row is 0.935 em of text plus labelspacing; its borderpad is
    // the same on all four sides. These are the matplotlib settings that give
    // a box of the same height and the text in the same place.
    function legendGeometry(fs) {
        const row = (Math.max(1.3 * fs * PT, 16) + 3) / PT;
        const text = 0.935 * fs;
        const borderpad = (row + 8.6 - text) / (2 * fs);
        const handletextpad = 0.5;
        const handlelength = Math.max(1, (40 / PT - borderpad * fs) / fs - handletextpad);
        const r = v => pyNum(v.toFixed(2));
        return { borderpad: r(borderpad), labelspacing: r((row - text) / fs), handlelength: r(handlelength), handletextpad: r(handletextpad) };
    }

    function pythonScript(embed) {
        const s = lastSettings, fl = els.gd._fullLayout;
        const th = BACKGROUNDS[s.background], F = FONTS[s.font];
        const used = [...new Set(traces.map(t => t.fileId))].map(id => files.get(id)).filter(Boolean);
        const vars = new Map(used.map((f, i) => [f.id, used.length === 1 ? 'df' : `df${i + 1}`]));
        const inline = used.filter(f => f.example || embed);
        const L = [];
        const p = pixels(s);
        const base = slug(s.title);

        L.push('# Figure from STEMKit Plot Builder (https://stemkit.net/plot-builder.html).');
        L.push(`# Draws it as the browser did: ${fmtIn(s.wIn)} x ${fmtIn(s.hIn)} in at ${s.dpi} dpi, with the same`);
        L.push('# fonts, sizes, colours, axis limits, ticks and legend.');
        L.push('# Needs pandas and matplotlib 3.5 or later.', '');
        if (inline.length) L.push('import io');
        L.push('import pandas as pd', 'import matplotlib.pyplot as plt', 'from matplotlib import font_manager', '');

        L.push('# Data ' + '-'.repeat(70));
        used.forEach(f => {
            const v = vars.get(f.id);
            const sep = f.delimiter && f.delimiter !== ',' ? `, sep=${pyStr(f.delimiter)}` : '';
            if (f.example || embed) {
                const name = pyVarName(f);
                const body = f.text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
                L.push(`${name} = """\\`, body.replace(/\n$/, ''), '"""');
                L.push(`${v} = pd.read_csv(io.StringIO(${name})${sep})${f.example ? '  # the example data' : ''}`);
            } else {
                L.push(`${v} = pd.read_csv(${pyStr(f.name)}${sep})  # point this at your file`);
            }
        });
        L.push('', '', 'def numeric(df, x, y):');
        L.push('    """The rows where both columns hold numbers, as the browser plotted them."""');
        L.push("    both = pd.DataFrame({'x': pd.to_numeric(df[x], errors='coerce'),");
        L.push("                         'y': pd.to_numeric(df[y], errors='coerce')}).dropna()");
        L.push("    return both['x'], both['y']", '', '');

        L.push('# Style ' + '-'.repeat(69));
        L.push('# The first of these fonts that is installed, as in the browser.');
        L.push('installed = {f.name for f in font_manager.fontManager.ttflist}');
        L.push(`FONT = next((name for name in ${pyList(F.mpl.map(pyStr))} if name in installed), ${pyStr(F.fallback)})`);
        L.push(`INK = ${pyStr(th.ink)}`);
        const ticksOn = !!s.ticks, box = s.frame === 'box';
        L.push('plt.rcParams.update({');
        L.push("    'font.family': FONT, 'svg.fonttype': 'none',");
        L.push("    'mathtext.fontset': 'custom', 'mathtext.default': 'regular',");
        L.push("    'mathtext.rm': FONT, 'mathtext.it': FONT + ':italic', 'mathtext.bf': FONT + ':bold',");
        L.push("    'mathtext.sf': FONT, 'mathtext.tt': FONT, 'mathtext.cal': FONT,");
        L.push(`    'font.size': ${pyNum(s.tickSize)}, 'axes.titlesize': ${pyNum(s.titleSize)}, 'axes.labelsize': ${pyNum(s.labelSize)},`);
        L.push(`    'xtick.labelsize': ${pyNum(s.tickSize)}, 'ytick.labelsize': ${pyNum(s.tickSize)}, 'legend.fontsize': ${pyNum(s.legendSize)},`);
        // Plotly lifts the title's baseline 0.3 em above its pad; matplotlib measures the pad to the baseline.
        L.push(`    'axes.titlepad': ${pyNum((TITLE_PAD + 0.3 * s.titleSize).toFixed(2))}, 'axes.labelpad': ${LABEL_PAD},`);
        L.push("    'text.color': INK, 'axes.labelcolor': INK, 'axes.edgecolor': INK,");
        L.push("    'xtick.color': INK, 'ytick.color': INK,");
        L.push(`    'axes.linewidth': ${AXIS_LW}, 'xtick.major.width': ${AXIS_LW}, 'ytick.major.width': ${AXIS_LW},`);
        L.push(`    'xtick.major.size': ${ticksOn ? TICK_LEN : 0}, 'ytick.major.size': ${ticksOn ? TICK_LEN : 0},`);
        L.push(`    'xtick.direction': ${pyStr(s.ticks === 'outside' ? 'out' : 'in')}, 'ytick.direction': ${pyStr(s.ticks === 'outside' ? 'out' : 'in')},`);
        L.push(`    'xtick.top': ${box && ticksOn ? 'True' : 'False'}, 'ytick.right': ${box && ticksOn ? 'True' : 'False'},`);
        L.push("    'lines.solid_capstyle': 'butt', 'lines.dash_capstyle': 'butt',");
        L.push('})', '');

        const W = fl.width, H = fl.height, sz = fl._size;
        const frac = [sz.l / W, sz.b / H, sz.w / W, sz.h / H].map(v => pyNum(v.toFixed(4)));
        // matplotlib truncates width x dpi to whole pixels, so 800 / 150 written
        // as 5.3333333 in would come out 799 px. Round the inches up at the
        // ninth decimal, which is invisible in the size and exact in pixels.
        const inch = v => String(Math.ceil(v * 1e9 - 1e-3) / 1e9);
        L.push(`fig = plt.figure(figsize=(${inch(s.wIn)}, ${inch(s.hIn)}), dpi=${s.dpi}, facecolor=${pyStr(th.mpl)})`);
        L.push('# The plot area where the browser put it, as fractions of the figure.');
        L.push(`ax = fig.add_axes((${frac.join(', ')}), facecolor=${pyStr(th.mpl)})`, '');

        L.push('# Traces ' + '-'.repeat(68));
        traces.forEach(t => {
            const f = files.get(t.fileId);
            if (!f) return;
            const v = vars.get(f.id);
            const args = [`*numeric(${v}, ${colRef(f, t.x).replace(/^df\b/, v)}, ${colRef(f, t.y).replace(/^df\b/, v)})`,
                `label=${pyStr(mplText(t.name.trim() || t.y))}`, `color=${pyStr(t.color)}`];
            if (t.mode === 'markers') args.push("linestyle='none'");
            else args.push(`linewidth=${pyNum(s.lineWidth)}`, `linestyle=${pyStr(DASHES[t.dash].mpl)}`);
            if (t.mode !== 'lines') args.push(`marker=${pyStr(MARKERS[t.marker].mpl)}`, `markersize=${pyNum(s.markerSize)}`, 'markeredgewidth=0');
            L.push(`ax.plot(${args.join(', ')})`);
        });
        L.push('');

        L.push('# Axes ' + '-'.repeat(70));
        if (s.title) L.push(`ax.set_title(${pyStr(mplText(s.title))})`);
        if (s.x.label) L.push(`ax.set_xlabel(${pyStr(mplText(s.x.label))})`);
        if (s.y.label) L.push(`ax.set_ylabel(${pyStr(mplText(s.y.label))})`);
        const tickLines = [];
        ['x', 'y'].forEach(k => {
            const ax = fl[k + 'axis'];
            const log = ax.type === 'log';
            const conv = v => (log ? Math.pow(10, v) : v);
            if (log) L.push(`ax.set_${k}scale('log', nonpositive='mask')`);
            L.push(`ax.set_${k}lim(${pyNum(conv(ax.range[0]))}, ${pyNum(conv(ax.range[1]))})`);
            const vals = (ax._vals || []).filter(v => v.text !== '' && v.text != null);
            if (!vals.length) return;
            tickLines.push(`ax.set_${k}ticks(${pyList(vals.map(v => pyNum(conv(v.x))))}, ${pyList(vals.map(v => pyStr(mplTick(v.text))))})`);
            // On a log axis Plotly draws the decades larger than the digits between them.
            const sizes = vals.map(v => (v.fontSize ? +(v.fontSize / PT).toFixed(2) : s.tickSize));
            if (sizes.some(z => Math.abs(z - s.tickSize) > 0.01)) {
                tickLines.push(`for label, size in zip(ax.get_${k}ticklabels(), ${pyList(sizes.map(pyNum))}):`, '    label.set_fontsize(size)');
            }
        });
        if (tickLines.length) {
            L.push('# Ticks where the browser put them; delete these lines to let matplotlib choose.');
            L.push(...tickLines, 'ax.minorticks_off()');
        }
        if (s.x.grid || s.y.grid) {
            const which = s.x.grid && s.y.grid ? 'both' : s.x.grid ? 'x' : 'y';
            const g = th.grid.split(',').map(n => (+n).toString(16).padStart(2, '0')).join('');
            L.push(`ax.grid(True, axis=${pyStr(which)}, color='#${g}', alpha=${pyNum(s.gridOpacity)}, linewidth=${AXIS_LW})`);
        }
        if (!box) L.push("ax.spines[['top', 'right']].set_visible(False)");
        L.push('');

        if (showsLegend(s)) {
            const Lg = LEGENDS[s.legend], g = legendGeometry(s.legendSize);
            L.push('# Legend ' + '-'.repeat(68));
            L.push('# Spacing and padding sized to match the legend Plotly draws.');
            L.push(`legend = ax.legend(loc=${pyStr(Lg.mpl)}, bbox_to_anchor=(${Lg.x}, ${Lg.y}), borderaxespad=0,`);
            L.push(`                   frameon=True, fancybox=False, framealpha=0.8, facecolor=${pyStr('#' + th.legend.split(',').map(n => (+n).toString(16).padStart(2, '0')).join(''))},`);
            L.push(`                   edgecolor=${pyStr(th.frame)}, borderpad=${g.borderpad}, labelspacing=${g.labelspacing},`);
            L.push(`                   handlelength=${g.handlelength}, handletextpad=${g.handletextpad})`);
            L.push(`legend.get_frame().set_linewidth(${AXIS_LW})`, '');
        }

        const transparent = s.background === 'transparent' ? ', transparent=True' : '';
        L.push(`fig.savefig(${pyStr(base + '.png')}, dpi=${s.dpi}${transparent})  # ${p.w} x ${p.h} px`);
        L.push(`fig.savefig(${pyStr(base + '.svg')}${transparent})  # ${trim(s.wIn * 72, 2)} x ${trim(s.hIn * 72, 2)} pt`);
        L.push('plt.show()');
        return L.join('\n') + '\n';
    }

    let lastFocus = null;
    function refreshCode() { els.code.textContent = pythonScript(els.embed.checked); }

    els.py.addEventListener('click', async () => {
        await flush();
        if (!plotted) return;
        const own = [...new Set(traces.map(t => t.fileId))].map(id => files.get(id)).filter(f => f && !f.example);
        const big = own.reduce((n, f) => n + f.text.length, 0) > 2e6;
        els.embed.closest('label').hidden = !own.length;
        els.embed.disabled = big;
        if (big) els.embed.checked = false;
        els.embedText.textContent = big
            ? 'The data is over 2 MB, too large to put in the script; it reads your file instead.'
            : 'Put the data in the script, so it runs on its own';
        refreshCode();
        lastFocus = document.activeElement;
        els.modal.hidden = false;
        els.copyCode.focus();
    });
    els.embed.addEventListener('change', refreshCode);
    function closeModal() {
        els.modal.hidden = true;
        if (lastFocus) lastFocus.focus();
    }
    els.closeCode.addEventListener('click', closeModal);
    els.modal.addEventListener('click', e => { if (e.target === els.modal) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !els.modal.hidden) closeModal(); });
    els.copyCode.addEventListener('click', () => {
        navigator.clipboard.writeText(els.code.textContent).then(() => {
            toast('Python script copied.', 'ok');
            exported('Copied the Python script.');
        }, () => toast('The browser would not allow copying. Select the text, or download the .py file.', 'error'));
    });
    els.downloadPy.addEventListener('click', () => {
        const name = slug(lastSettings.title) + '.py';
        save(new Blob([els.code.textContent], { type: 'text/x-python' }), name);
        exported(`Saved ${name}.`);
    });

    // ------------------------------------------------------------------ start
    showSize();
    renderTraces();
    renderFiles();
    renderNow();
})();
