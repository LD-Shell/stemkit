document.addEventListener('DOMContentLoaded', () => {

    // # --- 1. Subsystem architecture ---
    // # The parser state retains the raw matrix in memory to allow instantaneous non-destructive rendering updates
    const state = {
        rawData: [],       
        headers: [],       
        xIndex: 0,         
        activeYIndices: new Set([1]), 
        title: "Log Data",
        xAxisLabel: "X",
        yAxisLabel: "Y"
    };

    // # --- 2. Interface bindings ---
    const uploadZone = document.getElementById('uploadZone');
    const dropArea = document.getElementById('dropArea');
    const fileInput = document.getElementById('fileInput');
    const workspace = document.getElementById('workspace');
    const btnCloseWorkspace = document.getElementById('btnCloseWorkspace');
    
    const fileStats = document.getElementById('fileStats');
    const xColSelect = document.getElementById('xColSelect');
    const yColContainer = document.getElementById('yColContainer');
    const btnToggleAll = document.getElementById('btnToggleAll');
    
    const plotLogY = document.getElementById('plotLogY');
    const plotMarkers = document.getElementById('plotMarkers');
    const plotSmoothing = document.getElementById('plotSmoothing');
    const plotContainer = document.getElementById('plotContainer');
    const plotLoader = document.getElementById('plotLoader');

    const COLOR_PALETTE = ['#2563eb', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899'];

    document.querySelectorAll('.accordion-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const isExpanded = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', !isExpanded);
            document.getElementById(btn.getAttribute('data-target')).classList.toggle('expanded');
        });
    });

    document.querySelectorAll('.themeToggle').forEach(btn => btn.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        if (state.rawData.length > 0) renderPlot(); 
    }));

    // # --- 3. I/O and drop handlers ---
    dropArea.addEventListener('click', () => fileInput.click());

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => dropArea.classList.add('bg-blue-100', 'dark:bg-blue-900/30', 'border-blue-400'));
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => dropArea.classList.remove('bg-blue-100', 'dark:bg-blue-900/30', 'border-blue-400'));
    });

    dropArea.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) handleFile(files[0]);
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFile(e.target.files[0]);
    });

    btnCloseWorkspace.addEventListener('click', () => {
        workspace.classList.add('hidden');
        uploadZone.classList.remove('opacity-0', 'pointer-events-none');
        fileInput.value = '';
        state.rawData = [];
        Plotly.purge(plotContainer);
    });

    // # --- 4. High-performance text parsing engine ---
    function handleFile(file) {
        plotLoader.classList.remove('hidden');
        plotLoader.classList.add('flex');
        uploadZone.classList.add('opacity-0', 'pointer-events-none');
        workspace.classList.remove('hidden');
        
        // # I am utilizing FileReader to process the massive GROMACS PMF outputs entirely client-side
        const reader = new FileReader();
        
        reader.onload = (e) => {
            const text = e.target.result;
            parseDataBuffer(text, file.name);
        };
        
        reader.readAsText(file);
    }

    function parseDataBuffer(rawText, filename) {
        const lines = rawText.split('\n');
        
        let matrix = [];
        let headers = [];
        let colCount = 0;
        
        state.title = filename;
        state.xAxisLabel = "X";
        state.yAxisLabel = "Y";

        // # I am iterating through lines to strip GROMACS metadata and compile the numerical float matrix
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line === '') continue;

            if (line.startsWith('@')) {
                if (line.includes('title ')) state.title = line.split('"')[1] || state.title;
                if (line.includes('xaxis  label ')) state.xAxisLabel = line.split('"')[1] || state.xAxisLabel;
                if (line.includes('yaxis  label ')) state.yAxisLabel = line.split('"')[1] || state.yAxisLabel;
                
                if (line.includes(' s') && line.includes(' legend ')) {
                    const match = line.match(/s(\d+) legend "(.*)"/);
                    if (match) headers[parseInt(match[1]) + 1] = match[2]; 
                }
                continue;
            }

            if (line.startsWith('#')) continue;

            const tokens = line.split(/[\s,]+/).filter(Boolean);
            if (tokens.length > 0) {
                const row = tokens.map(Number);
                if (!row.some(isNaN)) {
                    matrix.push(row);
                    if (row.length > colCount) colCount = row.length;
                }
            }
        }

        for (let c = 0; c < colCount; c++) {
            if (!headers[c]) headers[c] = (c === 0) ? state.xAxisLabel : `Dataset ${c}`;
        }

        state.rawData = matrix;
        state.headers = headers;
        state.xIndex = 0;
        
        state.activeYIndices = new Set();
        const maxAutoCols = colCount > 4 ? 2 : colCount;
        for(let i=1; i < maxAutoCols; i++) state.activeYIndices.add(i);

        fileStats.innerText = `${matrix.length.toLocaleString()} rows × ${colCount} cols`;
        
        buildControlsUI(colCount);
        renderPlot();
        
        plotLoader.classList.remove('flex');
        plotLoader.classList.add('hidden');
    }

    // # --- 5. User interface mapping ---
    function buildControlsUI(colCount) {
        xColSelect.innerHTML = '';
        state.headers.forEach((hdr, idx) => {
            const opt = document.createElement('option');
            opt.value = idx;
            opt.textContent = `[Col ${idx}] ${hdr}`;
            xColSelect.appendChild(opt);
        });
        xColSelect.value = state.xIndex;
        
        xColSelect.addEventListener('change', (e) => {
            state.xIndex = parseInt(e.target.value);
            renderPlot();
        });

        yColContainer.innerHTML = '';
        for (let i = 0; i < colCount; i++) {
            const div = document.createElement('label');
            const isActive = state.activeYIndices.has(i);
            const color = COLOR_PALETTE[i % COLOR_PALETTE.length];
            
            div.className = `flex items-center justify-between p-2 rounded-lg border cursor-pointer transition-colors ${isActive ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800' : 'bg-transparent border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'}`;
            
            div.innerHTML = `
                <div class="flex items-center gap-3 truncate">
                    <input type="checkbox" value="${i}" class="y-toggle w-4 h-4 text-blue-600 rounded focus:ring-0" ${isActive ? 'checked' : ''}>
                    <div class="w-3 h-3 rounded-full shrink-0" style="background-color: ${color}"></div>
                    <span class="text-xs font-bold text-slate-700 dark:text-slate-300 truncate" title="${state.headers[i]}">[Col ${i}] ${state.headers[i]}</span>
                </div>
            `;

            div.querySelector('input').addEventListener('change', (e) => {
                const idx = parseInt(e.target.value);
                if (e.target.checked) state.activeYIndices.add(idx);
                else state.activeYIndices.delete(idx);
                
                div.className = `flex items-center justify-between p-2 rounded-lg border cursor-pointer transition-colors ${e.target.checked ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800' : 'bg-transparent border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'}`;
                
                renderPlot();
            });
            yColContainer.appendChild(div);
        }
    }

    btnToggleAll.addEventListener('click', () => {
        const checkboxes = document.querySelectorAll('.y-toggle');
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        
        checkboxes.forEach(cb => {
            cb.checked = !allChecked;
            cb.dispatchEvent(new Event('change'));
        });
    });

    [plotLogY, plotMarkers, plotSmoothing].forEach(ctrl => {
        ctrl.addEventListener('input', renderPlot);
    });

    // # --- 6. WebGL rendering ---
    function renderPlot() {
        if (state.rawData.length === 0 || state.activeYIndices.size === 0) {
            Plotly.purge(plotContainer);
            return;
        }

        const isDark = document.documentElement.classList.contains('dark');
        const fontColor = isDark ? '#cbd5e1' : '#334155';
        const gridColor = isDark ? '#334155' : '#e2e8f0';
        const bgColor = 'transparent';

        const xData = state.rawData.map(row => row[state.xIndex]);
        const traces = [];

        const showMarkers = plotMarkers.checked;
        const smoothing = parseFloat(plotSmoothing.value);

        state.activeYIndices.forEach(yIdx => {
            const yData = state.rawData.map(row => row[yIdx]);
            
            let mode = showMarkers ? 'lines+markers' : 'lines';
            let lineConfig = { color: COLOR_PALETTE[yIdx % COLOR_PALETTE.length], width: 2 };
            
            if (smoothing > 0) {
                lineConfig.shape = 'spline';
                lineConfig.smoothing = smoothing;
            }

            traces.push({
                x: xData,
                y: yData,
                mode: mode,
                type: 'scatter', 
                name: state.headers[yIdx],
                line: lineConfig,
                marker: { size: 4 }
            });
        });

        const layout = {
            title: { text: state.title, font: { family: 'Inter', size: 16, color: fontColor } },
            plot_bgcolor: bgColor,
            paper_bgcolor: bgColor,
            font: { family: 'Inter', color: fontColor },
            xaxis: { 
                title: state.headers[state.xIndex], 
                gridcolor: gridColor, 
                zerolinecolor: gridColor 
            },
            yaxis: { 
                title: state.yAxisLabel, 
                type: plotLogY.checked ? 'log' : 'linear',
                gridcolor: gridColor, 
                zerolinecolor: gridColor 
            },
            margin: { t: 60, r: 40, b: 60, l: 60 },
            showlegend: true,
            legend: { orientation: "h", yanchor: "bottom", y: 1.02, xanchor: "right", x: 1 },
            hovermode: 'closest'
        };

        const config = {
            responsive: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['lasso2d', 'select2d'],
            toImageButtonOptions: { format: 'png', filename: 'extracted_plot', height: 600, width: 800, scale: 2 }
        };

        Plotly.react(plotContainer, traces, layout, config);
    }
});