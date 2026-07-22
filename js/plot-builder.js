document.addEventListener("DOMContentLoaded", () => {
    
    // # --- 1. State management and architecture ---
    
    // # I am decoupling data storage from visual traces to allow multiple traces per file
    const dataStore = {}; 
    let traces = []; 
    let traceCounter = 0;

    const defaultColors = ['#4f46e5', '#ef4444', '#10b981', '#f59e0b', '#06b6d4', '#8b5cf6', '#ec4899'];

    // # Caching DOM references
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    const fileInventory = document.getElementById('fileInventory');
    
    const datasetContainer = document.getElementById('datasetContainer');
    const traceList = document.getElementById('traceList');
    const addTraceBtn = document.getElementById('addTraceBtn');
    const updatePlotBtn = document.getElementById('updatePlotBtn');
    
    const plotTitle = document.getElementById('plotTitle');
    const xAxisLabel = document.getElementById('xAxisLabel');
    const yAxisLabel = document.getElementById('yAxisLabel');
    const xLogScale = document.getElementById('xLogScale');
    const yLogScale = document.getElementById('yLogScale');
    const showFrame = document.getElementById('showFrame');
    const showGridX = document.getElementById('showGridX');
    const showGridY = document.getElementById('showGridY');
    const tickStyle = document.getElementById('tickStyle');
    const legendPosition = document.getElementById('legendPosition');
    
    const plotlyCanvas = document.getElementById('plotlyCanvas');
    const emptyPlotState = document.getElementById('emptyPlotState');

    // Style-panel controls
    const fontFamily = document.getElementById('fontFamily');
    const colorTheme = document.getElementById('colorTheme');
    const titleSize = document.getElementById('titleSize');
    const axisSize = document.getElementById('axisSize');
    const tickSize = document.getElementById('tickSize');
    const markerSize = document.getElementById('markerSize');
    const lineWidth = document.getElementById('lineWidth');
    const gridOpacity = document.getElementById('gridOpacity');
    const exportWidth = document.getElementById('exportWidth');
    const exportHeight = document.getElementById('exportHeight');
    const exportScale = document.getElementById('exportScale');

    // Live-update the little value badges + re-render on any style change
    [['titleSize','titleSizeVal'],['axisSize','axisSizeVal'],['tickSize','tickSizeVal'],
     ['markerSize','markerSizeVal'],['lineWidth','lineWidthVal'],['gridOpacity','gridOpacityVal']].forEach(([id,out]) => {
        const el = document.getElementById(id), o = document.getElementById(out);
        if (el && o) { const s = () => { o.textContent = el.value; if (traces.length) renderPlot(); }; el.addEventListener('input', s); }
    });
    [fontFamily, colorTheme].forEach(el => el && el.addEventListener('change', () => { if (traces.length) renderPlot(); }));

    // Effective theme: 'auto' follows the app, else forced light/dark
    const effDark = () => colorTheme && colorTheme.value !== 'auto' ? colorTheme.value === 'dark' : isDark();

    // Built-in sample dataset (skips file upload so users can try the tool instantly)
    const sampleBtn = document.getElementById('loadSampleBtn');
    if (sampleBtn) sampleBtn.addEventListener('click', () => {
        const fileId = 'sample_growth.csv';
        if (dataStore[fileId]) { showToast('Sample already loaded.', 'info'); return; }
        const rows = [];
        for (let t = 0; t <= 24; t += 2) {
            rows.push({
                time_h: t,
                control_OD: +(0.05 * Math.exp(0.18 * t) + (Math.random() - 0.5) * 0.05).toFixed(3),
                treated_OD: +(0.05 * Math.exp(0.11 * t) + (Math.random() - 0.5) * 0.04).toFixed(3)
            });
        }
        dataStore[fileId] = { filename: 'sample_growth.csv', headers: ['time_h', 'control_OD', 'treated_OD'], data: rows };
        updateFileInventory();
        datasetContainer.classList.remove('hidden');
        createNewTrace(fileId);
        showToast('Sample dataset loaded — bacterial growth curves.', 'success');
    });

    // # Configuring theme logic
    const isDark = () => document.documentElement.classList.contains('dark');
    // The HTML toggle already flips the .dark class; here we only re-render so the
    // plot colours track the theme (toggling again would cancel out).
    document.querySelectorAll('.themeToggle').forEach(btn => btn.addEventListener('click', () => {
        if (traces.length > 0) setTimeout(renderPlot, 30);
    }));

    // # --- 2. Data ingestion and parsing ---
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); }, false);
    });

    uploadZone.addEventListener('dragover', () => uploadZone.classList.add('border-indigo-500'));
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('border-indigo-500'));
    uploadZone.addEventListener('drop', (e) => {
        uploadZone.classList.remove('border-indigo-500');
        handleFiles(e.dataTransfer.files);
    });
    uploadZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

    function handleFiles(files) {
        Array.from(files).forEach(file => {
            if (!file.name.endsWith('.csv')) {
                showToast(`Skipped ${file.name}: CSV required.`, 'error');
                return;
            }

            // # I am using the file name and size as a unique dictionary key to prevent redundant loads
            const fileId = `${file.name}_${file.size}`;
            if (dataStore[fileId]) {
                showToast(`${file.name} is already loaded.`, 'info');
                return;
            }

            Papa.parse(file, {
                header: true,
                dynamicTyping: true,
                skipEmptyLines: true,
                complete: function(results) {
                    if (results.errors.length > 0 && results.data.length === 0) {
                        showToast(`Failed to parse ${file.name}`, 'error');
                        return;
                    }

                    const headers = results.meta.fields;
                    if (headers.length < 2) {
                        showToast(`${file.name} requires at least 2 columns.`, 'error');
                        return;
                    }

                    dataStore[fileId] = {
                        filename: file.name,
                        headers: headers,
                        data: results.data
                    };

                    updateFileInventory();
                    
                    // # Generating initial trace automatically for the first uploaded file
                    if (Object.keys(dataStore).length === 1 && traces.length === 0) {
                        createNewTrace(fileId);
                        datasetContainer.classList.remove('hidden');
                        emptyPlotState.classList.add('hidden');
                    }
                    
                    showToast(`${file.name} added to memory pool.`, 'success');
                }
            });
        });
        fileInput.value = '';
    }

    function updateFileInventory() {
        fileInventory.innerHTML = '';
        Object.keys(dataStore).forEach(fileId => {
            const badge = document.createElement('div');
            badge.className = 'text-xs font-medium bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 px-3 py-1.5 rounded flex justify-between items-center';
            badge.innerHTML = `<span><i class="fa-solid fa-file-csv mr-1"></i> ${dataStore[fileId].filename}</span>`;
            fileInventory.appendChild(badge);
        });
    }

    // # --- 3. Trace configuration setup ---
    addTraceBtn.addEventListener('click', () => {
        const fileIds = Object.keys(dataStore);
        if (fileIds.length === 0) return;
        createNewTrace(fileIds[0]); 
    });

    function createNewTrace(defaultFileId) {
        traceCounter++;
        const tId = `trace_${traceCounter}`;
        const colorIndex = traces.length % defaultColors.length;
        
        const ds = dataStore[defaultFileId];
        
        traces.push({
            id: tId,
            fileId: defaultFileId,
            config: {
                name: `Trace ${traceCounter}`,
                xCol: ds.headers[0],
                yCol: ds.headers[1] || ds.headers[0],
                color: defaultColors[colorIndex],
                type: 'scatter',
                mode: 'lines'
            }
        });
        
        renderTraceUI();
    }

    function renderTraceUI() {
        traceList.innerHTML = '';
        const fileIds = Object.keys(dataStore);

        traces.forEach(trace => {
            const card = document.createElement('div');
            card.className = 'bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 flex flex-col gap-3 relative';
            
            // # Creating dropdowns to map traces to memory files
            const fileOptions = fileIds.map(fid => `<option value="${fid}" ${trace.fileId === fid ? 'selected' : ''}>${dataStore[fid].filename}</option>`).join('');
            
            const currentHeaders = dataStore[trace.fileId].headers;
            const xOptions = currentHeaders.map(h => `<option value="${h}" ${trace.config.xCol === h ? 'selected' : ''}>${h}</option>`).join('');
            const yOptions = currentHeaders.map(h => `<option value="${h}" ${trace.config.yCol === h ? 'selected' : ''}>${h}</option>`).join('');

            card.innerHTML = `
                <div class="flex justify-between items-center pr-6">
                    <input type="text" class="trace-name text-sm font-bold bg-transparent outline-none border-b border-transparent focus:border-indigo-500 w-full truncate" value="${trace.config.name}" data-id="${trace.id}">
                </div>
                
                <button class="remove-trace absolute top-3 right-3 text-slate-400 hover:text-red-500 transition-colors" data-id="${trace.id}">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>

                <div>
                    <select class="trace-file w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded text-xs py-1.5 px-2 outline-none font-medium text-slate-600 dark:text-slate-300" data-id="${trace.id}">
                        ${fileOptions}
                    </select>
                </div>

                <div class="grid grid-cols-2 gap-2">
                    <div>
                        <label class="text-[10px] uppercase font-bold text-slate-500">X-Axis</label>
                        <select class="trace-x w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded text-xs py-1 px-2 outline-none" data-id="${trace.id}">
                            ${xOptions}
                        </select>
                    </div>
                    <div>
                        <label class="text-[10px] uppercase font-bold text-slate-500">Y-Axis</label>
                        <select class="trace-y w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded text-xs py-1 px-2 outline-none" data-id="${trace.id}">
                            ${yOptions}
                        </select>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-2">
                    <div>
                        <label class="text-[10px] uppercase font-bold text-slate-500">Style</label>
                        <select class="trace-mode w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded text-xs py-1 px-2 outline-none" data-id="${trace.id}">
                            <option value="lines" ${trace.config.mode === 'lines' ? 'selected' : ''}>Line</option>
                            <option value="markers" ${trace.config.mode === 'markers' ? 'selected' : ''}>Scatter</option>
                            <option value="lines+markers" ${trace.config.mode === 'lines+markers' ? 'selected' : ''}>Line + Markers</option>
                        </select>
                    </div>
                    <div>
                        <label class="text-[10px] uppercase font-bold text-slate-500">Color</label>
                        <input type="color" class="trace-color w-full h-6 rounded cursor-pointer border-none bg-transparent p-0" value="${trace.config.color}" data-id="${trace.id}">
                    </div>
                </div>
            `;

            // # Binding state mutation event listeners
            card.querySelector('.trace-name').addEventListener('change', (e) => updateTrace(trace.id, 'name', e.target.value));
            card.querySelector('.trace-mode').addEventListener('change', (e) => updateTrace(trace.id, 'mode', e.target.value));
            card.querySelector('.trace-color').addEventListener('change', (e) => updateTrace(trace.id, 'color', e.target.value));
            card.querySelector('.trace-x').addEventListener('change', (e) => updateTrace(trace.id, 'xCol', e.target.value));
            card.querySelector('.trace-y').addEventListener('change', (e) => updateTrace(trace.id, 'yCol', e.target.value));
            
            // # Handling dataset reassignment
            card.querySelector('.trace-file').addEventListener('change', (e) => {
                const tr = traces.find(t => t.id === trace.id);
                tr.fileId = e.target.value;
                const newHeaders = dataStore[tr.fileId].headers;
                tr.config.xCol = newHeaders[0];
                tr.config.yCol = newHeaders[1] || newHeaders[0];
                renderTraceUI(); 
            });

            card.querySelector('.remove-trace').addEventListener('click', () => {
                traces = traces.filter(t => t.id !== trace.id);
                renderTraceUI();
                if (traces.length === 0) {
                    Plotly.purge(plotlyCanvas);
                    emptyPlotState.classList.remove('hidden');
                }
            });

            traceList.appendChild(card);
        });
    }

    function updateTrace(id, key, value) {
        const trace = traces.find(t => t.id === id);
        if (trace) trace.config[key] = value;
    }

    // # --- 4. Plotly execution engine ---
    updatePlotBtn.addEventListener('click', renderPlot);

    function renderPlot() {
        if (traces.length === 0) return;
        emptyPlotState.classList.add('hidden');

        const plotData = traces.map(trace => {
            const raw = dataStore[trace.fileId].data;
            const xCol = trace.config.xCol;
            const yCol = trace.config.yCol;

            // # I am isolating numeric data to prevent Plotly from failing on NaN strings
            const xData = [];
            const yData = [];
            for (let i = 0; i < raw.length; i++) {
                if (typeof raw[i][xCol] === 'number' && typeof raw[i][yCol] === 'number') {
                    xData.push(raw[i][xCol]);
                    yData.push(raw[i][yCol]);
                }
            }

            return {
                x: xData,
                y: yData,
                mode: trace.config.mode,
                type: trace.config.type,
                name: trace.config.name,
                marker: { color: trace.config.color, size: parseInt(markerSize.value, 10) || 6 },
                line: { color: trace.config.color, width: parseInt(lineWidth.value, 10) || 2 }
            };
        });

        // # Interpreting aesthetic controls
        const dark = effDark();
        const textColor = dark ? '#cbd5e1' : '#475569';
        const axisColor = dark ? '#475569' : '#cbd5e1';
        const gOp = (parseInt(gridOpacity.value, 10) || 0) / 100;
        const mix = (hex, a) => { const c = dark ? [30,41,59] : [241,245,249]; const b = hex.match(/\w\w/g).map(h=>parseInt(h,16)); return `rgba(${Math.round(b[0]*a+c[0]*(1-a))},${Math.round(b[1]*a+c[1]*(1-a))},${Math.round(b[2]*a+c[2]*(1-a))},1)`; };
        const gridColor = dark ? `rgba(30,41,59,${gOp})` : `rgba(148,163,184,${gOp*0.5})`;
        const fam = fontFamily.value;
        const tSize = parseInt(titleSize.value, 10) || 18;
        const aSize = parseInt(axisSize.value, 10) || 14;
        const kSize = parseInt(tickSize.value, 10) || 12;
        const tickDir = tickStyle.value;
        const boxFrame = showFrame.checked;

        const commonAxisConfig = {
            gridcolor: gridColor,
            zerolinecolor: gridColor,
            tickfont: { color: textColor, size: kSize, family: fam },
            showgrid: false,
            ticks: tickDir,
            tickcolor: axisColor,
            showline: true,
            linecolor: axisColor,
            linewidth: 1,
            mirror: boxFrame ? 'ticks' : false
        };

        const layout = {
            title: { text: plotTitle.value, font: { color: textColor, family: fam, size: tSize } },
            xaxis: {
                ...commonAxisConfig,
                title: { text: xAxisLabel.value, font: { color: textColor, size: aSize, family: fam } },
                type: xLogScale.checked ? 'log' : 'linear',
                showgrid: showGridX.checked
            },
            yaxis: {
                ...commonAxisConfig,
                title: { text: yAxisLabel.value, font: { color: textColor, size: aSize, family: fam } },
                type: yLogScale.checked ? 'log' : 'linear',
                showgrid: showGridY.checked
            },
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            font: { family: fam, color: textColor },
            margin: { t: plotTitle.value ? 50 : 30, l: 60, r: boxFrame ? 30 : 20, b: 50 },
            autosize: true
        };

        // # Resolving legend position matrix
        const legPos = legendPosition.value;
        layout.showlegend = legPos !== 'hidden';
        if (layout.showlegend) {
            layout.legend = { font: { color: textColor, family: fam }, bgcolor: dark ? 'rgba(15,23,42,0.8)' : 'rgba(255,255,255,0.8)', bordercolor: axisColor, borderwidth: 1 };
            if (legPos === 'top-right') { layout.legend.x = 0.99; layout.legend.y = 0.99; layout.legend.xanchor = 'right'; layout.legend.yanchor = 'top'; }
            else if (legPos === 'top-left') { layout.legend.x = 0.01; layout.legend.y = 0.99; layout.legend.xanchor = 'left'; layout.legend.yanchor = 'top'; }
            else if (legPos === 'bottom-right') { layout.legend.x = 0.99; layout.legend.y = 0.01; layout.legend.xanchor = 'right'; layout.legend.yanchor = 'bottom'; }
            else if (legPos === 'outside') { layout.legend.x = 1.02; layout.legend.y = 1; layout.legend.xanchor = 'left'; layout.legend.yanchor = 'top'; layout.margin.r = 150; }
        }

        const config = { responsive: true, displayModeBar: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };

        Plotly.newPlot(plotlyCanvas, plotData, layout, config);
    }

    // # Executing export operations (honour the export-dimension controls)
    const expDims = () => ({
        width: parseInt(exportWidth.value, 10) || 1200,
        height: parseInt(exportHeight.value, 10) || 800,
        scale: parseInt(exportScale.value, 10) || 2
    });
    document.getElementById('downloadSvgBtn').addEventListener('click', () => {
        if (!traces.length) return showToast('Add a trace and render first.', 'error');
        const { width, height } = expDims();
        Plotly.downloadImage(plotlyCanvas, { format: 'svg', width, height, filename: 'stemkit_figure' });
    });
    document.getElementById('downloadPngBtn').addEventListener('click', () => {
        if (!traces.length) return showToast('Add a trace and render first.', 'error');
        const { width, height, scale } = expDims();
        Plotly.downloadImage(plotlyCanvas, { format: 'png', width, height, scale, filename: 'stemkit_figure_highres' });
    });

    // # --- matplotlib code export ---
    function pyStr(s) { return "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
    function generateMatplotlib() {
        if (!traces.length) return "# Add at least one trace, then click Python again.";
        const dark = effDark();
        const fam = fontFamily.value.split(',')[0].replace(/['"]/g, '').trim();
        const tSize = parseInt(titleSize.value, 10) || 18;
        const aSize = parseInt(axisSize.value, 10) || 14;
        const kSize = parseInt(tickSize.value, 10) || 12;
        const mSize = parseInt(markerSize.value, 10) || 6;
        const lw = parseInt(lineWidth.value, 10) || 2;
        const gOp = (parseInt(gridOpacity.value, 10) || 0) / 100;
        const { width, height, scale } = expDims();
        const dpi = 100 * scale;
        const figW = (width / 100).toFixed(2), figH = (height / 100).toFixed(2);

        // unique files used
        const fileIds = [...new Set(traces.map(t => t.fileId))];
        const fileVar = {};
        fileIds.forEach((fid, i) => { fileVar[fid] = fileIds.length === 1 ? 'df' : `df${i + 1}`; });

        let c = `import pandas as pd\nimport matplotlib.pyplot as plt\n\n`;
        c += `# --- Load your data (point each path at your CSV) ---\n`;
        fileIds.forEach(fid => {
            const name = (dataStore[fid] && dataStore[fid].filename) || `${fid}.csv`;
            c += `${fileVar[fid]} = pd.read_csv(${pyStr(name)})\n`;
        });
        c += `\n# --- Style ---\n`;
        c += `plt.rcParams.update({\n`;
        c += `    'font.family': ${pyStr(fam)},\n`;
        c += `    'font.size': ${kSize},\n`;
        c += `    'axes.titlesize': ${tSize},\n`;
        c += `    'axes.labelsize': ${aSize},\n`;
        if (dark) {
            c += `    'figure.facecolor': '#0f172a', 'axes.facecolor': '#0f172a',\n`;
            c += `    'axes.edgecolor': '#475569', 'text.color': '#cbd5e1',\n`;
            c += `    'axes.labelcolor': '#cbd5e1', 'xtick.color': '#cbd5e1', 'ytick.color': '#cbd5e1',\n`;
        }
        c += `})\n\n`;
        c += `fig, ax = plt.subplots(figsize=(${figW}, ${figH}), dpi=${dpi})\n\n`;

        c += `# --- Traces ---\n`;
        traces.forEach(t => {
            const v = fileVar[t.fileId];
            const xc = t.config.xCol, yc = t.config.yCol;
            const mode = t.config.mode || 'lines';
            const args = `${v}[${pyStr(xc)}], ${v}[${pyStr(yc)}]`;
            const label = `label=${pyStr(t.config.name)}`;
            const col = `color=${pyStr(t.config.color)}`;
            if (mode === 'markers') {
                c += `ax.scatter(${args}, ${label}, ${col}, s=${mSize * mSize})\n`;
            } else if (mode === 'lines+markers') {
                c += `ax.plot(${args}, ${label}, ${col}, linewidth=${lw}, marker='o', markersize=${mSize})\n`;
            } else {
                c += `ax.plot(${args}, ${label}, ${col}, linewidth=${lw})\n`;
            }
        });

        c += `\n# --- Axes & labels ---\n`;
        if (plotTitle.value) c += `ax.set_title(${pyStr(plotTitle.value)})\n`;
        c += `ax.set_xlabel(${pyStr(xAxisLabel.value || 'x')})\n`;
        c += `ax.set_ylabel(${pyStr(yAxisLabel.value || 'y')})\n`;
        if (xLogScale.checked) c += `ax.set_xscale('log')\n`;
        if (yLogScale.checked) c += `ax.set_yscale('log')\n`;
        if (showGridX.checked || showGridY.checked) {
            const axisArg = showGridX.checked && showGridY.checked ? 'both' : (showGridX.checked ? 'x' : 'y');
            c += `ax.grid(True, axis=${pyStr(axisArg)}, alpha=${gOp.toFixed(2)})\n`;
        }
        if (!showFrame.checked) { c += `ax.spines['top'].set_visible(False)\nax.spines['right'].set_visible(False)\n`; }
        if (tickStyle.value === 'inside') c += `ax.tick_params(direction='in')\n`;
        else if (tickStyle.value === 'outside') c += `ax.tick_params(direction='out')\n`;

        const legPos = legendPosition.value;
        if (legPos !== 'hidden') {
            const loc = legPos === 'top-right' ? 'upper right' : legPos === 'top-left' ? 'upper left'
                : legPos === 'bottom-right' ? 'lower right' : 'center left';
            if (legPos === 'outside') c += `ax.legend(loc='center left', bbox_to_anchor=(1.02, 0.5), frameon=True)\n`;
            else c += `ax.legend(loc=${pyStr(loc)}, frameon=True)\n`;
        }
        c += `\nfig.tight_layout()\n`;
        c += `fig.savefig('figure.png', dpi=${dpi}, bbox_inches='tight')\n`;
        c += `fig.savefig('figure.svg', bbox_inches='tight')\n`;
        c += `plt.show()\n`;
        return c;
    }

    const codeModal = document.getElementById('codeModal');
    const codeBlock = document.getElementById('codeBlock');
    document.getElementById('copyPyBtn').addEventListener('click', () => {
        codeBlock.textContent = generateMatplotlib();
        codeModal.classList.add('open');
    });
    document.getElementById('closeCodeBtn').addEventListener('click', () => codeModal.classList.remove('open'));
    codeModal.addEventListener('click', (e) => { if (e.target === codeModal) codeModal.classList.remove('open'); });
    document.getElementById('copyCodeBtn').addEventListener('click', () => {
        navigator.clipboard.writeText(codeBlock.textContent).then(() => showToast('matplotlib code copied.', 'success'));
    });

    // # --- 5. Notification utility ---
    function showToast(msg, type) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-red-50 text-red-800 border-red-200';
        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        toast.innerHTML = `<i class="fa-solid ${type==='success'?'fa-check-circle':'fa-triangle-exclamation'} mr-2"></i> ${msg}`;
        container.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
    }
});