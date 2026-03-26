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

    // # Configuring theme logic
    const isDark = () => document.documentElement.classList.contains('dark');
    document.querySelectorAll('.themeToggle').forEach(btn => btn.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = isDark() ? 'dark' : 'light';
        if (traces.length > 0) renderPlot();
    });

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
                marker: { color: trace.config.color, size: 6 },
                line: { color: trace.config.color, width: 2 }
            };
        });

        // # Interpreting aesthetic controls
        const textColor = isDark() ? '#cbd5e1' : '#475569';
        const axisColor = isDark() ? '#475569' : '#cbd5e1';
        const gridColor = isDark() ? '#1e293b' : '#f1f5f9';
        const tickDir = tickStyle.value;
        const boxFrame = showFrame.checked;

        const commonAxisConfig = {
            gridcolor: gridColor,
            zerolinecolor: gridColor,
            tickfont: { color: textColor },
            showgrid: false,
            ticks: tickDir,
            tickcolor: axisColor,
            showline: true,
            linecolor: axisColor,
            linewidth: 1,
            mirror: boxFrame ? 'ticks' : false
        };

        const layout = {
            title: { text: plotTitle.value, font: { color: textColor, family: 'Inter' } },
            xaxis: {
                ...commonAxisConfig,
                title: { text: xAxisLabel.value, font: { color: textColor } },
                type: xLogScale.checked ? 'log' : 'linear',
                showgrid: showGridX.checked
            },
            yaxis: {
                ...commonAxisConfig,
                title: { text: yAxisLabel.value, font: { color: textColor } },
                type: yLogScale.checked ? 'log' : 'linear',
                showgrid: showGridY.checked
            },
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            margin: { t: plotTitle.value ? 50 : 30, l: 60, r: boxFrame ? 30 : 20, b: 50 },
            autosize: true
        };

        // # Resolving legend position matrix
        const legPos = legendPosition.value;
        layout.showlegend = legPos !== 'hidden';
        if (layout.showlegend) {
            layout.legend = { font: { color: textColor }, bgcolor: isDark() ? 'rgba(15,23,42,0.8)' : 'rgba(255,255,255,0.8)', bordercolor: axisColor, borderwidth: 1 };
            if (legPos === 'top-right') { layout.legend.x = 0.99; layout.legend.y = 0.99; layout.legend.xanchor = 'right'; layout.legend.yanchor = 'top'; }
            else if (legPos === 'top-left') { layout.legend.x = 0.01; layout.legend.y = 0.99; layout.legend.xanchor = 'left'; layout.legend.yanchor = 'top'; }
            else if (legPos === 'bottom-right') { layout.legend.x = 0.99; layout.legend.y = 0.01; layout.legend.xanchor = 'right'; layout.legend.yanchor = 'bottom'; }
            else if (legPos === 'outside') { layout.legend.x = 1.02; layout.legend.y = 1; layout.legend.xanchor = 'left'; layout.legend.yanchor = 'top'; layout.margin.r = 150; }
        }

        const config = { responsive: true, displayModeBar: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };

        Plotly.newPlot(plotlyCanvas, plotData, layout, config);
    }

    // # Executing export operations
    document.getElementById('downloadSvgBtn').addEventListener('click', () => {
        if(traces.length > 0) Plotly.downloadImage(plotlyCanvas, {format: 'svg', width: 1200, height: 800, filename: 'stemkit_figure'});
    });
    document.getElementById('downloadPngBtn').addEventListener('click', () => {
        if(traces.length > 0) Plotly.downloadImage(plotlyCanvas, {format: 'png', width: 2400, height: 1600, filename: 'stemkit_figure_highres'});
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