document.addEventListener('DOMContentLoaded', () => {
    
    // --- 1. State machine and dynamic structures ---
    const PALETTE = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];
    let datasetCounter = 1;

    const state = {
        mode: 'idle', 
        image: null,
        showBackground: true,
        calibration: { pxX1: null, pxX2: null, pxY1: null, pxY2: null },
        datasets: [{ id: 'ds_1', name: 'Series 1', color: PALETTE[0], points: [] }],
        activeDatasetId: 'ds_1',
        mouseX: 0,
        mouseY: 0,
        isDragging: false,
        lastTracePoint: null,
        autoTolerance: 30,
        eraseRadius: 10
    };

    // --- 2. Component bindings ---
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    const workspace = document.getElementById('workspace');
    const canvasContainer = document.getElementById('canvasContainer');
    
    const canvas = document.getElementById('plotCanvas');
    const ctx = canvas.getContext('2d');
    const loupe = document.getElementById('loupeCanvas');
    const loupeCtx = loupe.getContext('2d');

    const btnCalibX1 = document.getElementById('btnCalibX1');
    const btnCalibX2 = document.getElementById('btnCalibX2');
    const btnCalibY1 = document.getElementById('btnCalibY1');
    const btnCalibY2 = document.getElementById('btnCalibY2');
    
    const valX1 = document.getElementById('valX1');
    const valX2 = document.getElementById('valX2');
    const valY1 = document.getElementById('valY1');
    const valY2 = document.getElementById('valY2');
    const isLogX = document.getElementById('isLogX');
    const isLogY = document.getElementById('isLogY');
    
    const datasetList = document.getElementById('datasetList');
    const btnAddDataset = document.getElementById('btnAddDataset');

    const btnManualMode = document.getElementById('btnManualMode');
    const btnAutoMode = document.getElementById('btnAutoMode');
    const btnEraseMode = document.getElementById('btnEraseMode');
    const autoControls = document.getElementById('autoControls');
    const colorTolerance = document.getElementById('colorTolerance');
    const toleranceVal = document.getElementById('toleranceVal');
    
    const eraseControls = document.getElementById('eraseControls');
    const eraseRadiusSlider = document.getElementById('eraseRadius');
    const eraseRadiusVal = document.getElementById('eraseRadiusVal');

    const btnUndo = document.getElementById('btnUndo');
    const toggleBackground = document.getElementById('toggleBackground');
    const eyeIcon = document.getElementById('eyeIcon');
    const csvFilename = document.getElementById('csvFilename');
    const exportCsvBtn = document.getElementById('exportCsvBtn');

    const btnGeneratePython = document.getElementById('btnGeneratePython');
    const btnPreviewPlot = document.getElementById('btnPreviewPlot');
    const pythonModal = document.getElementById('pythonModal');
    const pythonCodeBlock = document.getElementById('pythonCodeBlock');
    const closePythonModal = document.getElementById('closePythonModal');
    const copyPythonBtn = document.getElementById('copyPythonBtn');

    // Accordion initialization logic
    document.querySelectorAll('.accordion-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const isExpanded = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', !isExpanded);
            const target = document.getElementById(btn.getAttribute('data-target'));
            target.classList.toggle('expanded');
        });
    });

    // --- 3. I/O handling ---
    uploadZone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                state.image = img;
                uploadZone.classList.add('hidden');
                workspace.classList.remove('hidden');
                workspace.classList.add('flex');
                canvas.width = img.width;
                canvas.height = img.height;
                renderDatasetUI();
                renderViewport();
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    });

    colorTolerance.addEventListener('input', (e) => {
        state.autoTolerance = parseInt(e.target.value);
        toleranceVal.innerText = state.autoTolerance;
    });

    eraseRadiusSlider.addEventListener('input', (e) => {
        state.eraseRadius = parseInt(e.target.value);
        eraseRadiusVal.innerText = state.eraseRadius;
        updateLoupe({ clientX: state.mouseX, clientY: state.mouseY, type: 'artificial' });
    });

    toggleBackground.addEventListener('change', (e) => {
        state.showBackground = e.target.checked;
        eyeIcon.className = state.showBackground ? 'fa-solid fa-eye text-slate-600 dark:text-slate-400' : 'fa-solid fa-eye-slash text-slate-400 dark:text-slate-600';
        renderViewport();
    });

    // --- 4. Subsystem mapping and dataset UI ---
    function renderDatasetUI() {
        datasetList.innerHTML = '';
        state.datasets.forEach(ds => {
            const div = document.createElement('div');
            const isActive = ds.id === state.activeDatasetId;
            div.className = `dataset-btn flex justify-between items-center px-2 py-1.5 rounded-lg border cursor-pointer transition-colors ${isActive ? 'active' : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'}`;
            
            div.innerHTML = `
                <div class="flex items-center gap-2 flex-grow">
                    <input type="color" class="ds-color-picker w-5 h-5 cursor-pointer bg-transparent border-0" value="${ds.color}" data-id="${ds.id}">
                    <input type="text" class="ds-name-input text-xs bg-transparent border border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-indigo-500 focus:ring-0 focus:outline-none px-1 py-0.5 rounded transition-colors ${isActive ? 'text-indigo-900 dark:text-indigo-300 font-bold' : 'text-slate-700 dark:text-slate-300'}" value="${ds.name}" data-id="${ds.id}" style="width: 120px;" title="Click to rename">
                    <span class="text-[10px] text-slate-400 font-mono">(${ds.points.length})</span>
                </div>
                <button class="delete-ds text-slate-400 hover:text-red-500 px-2 py-1 rounded transition-colors"><i class="fa-solid fa-trash-can text-xs pointer-events-none"></i></button>
            `;

            div.addEventListener('click', (e) => {
                if (e.target.classList.contains('ds-color-picker') || e.target.classList.contains('ds-name-input')) return;
                if (e.target.closest('.delete-ds')) {
                    if (state.datasets.length === 1) return; 
                    state.datasets = state.datasets.filter(d => d.id !== ds.id);
                    if (state.activeDatasetId === ds.id) state.activeDatasetId = state.datasets[0].id;
                    renderDatasetUI();
                    renderViewport();
                    return;
                }
                state.activeDatasetId = ds.id;
                renderDatasetUI();
            });
            datasetList.appendChild(div);
        });

        document.querySelectorAll('.ds-color-picker').forEach(picker => {
            picker.addEventListener('input', (e) => {
                const dataset = state.datasets.find(d => d.id === e.target.getAttribute('data-id'));
                if (dataset) { dataset.color = e.target.value; renderViewport(); }
            });
        });
        document.querySelectorAll('.ds-name-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const dataset = state.datasets.find(d => d.id === e.target.getAttribute('data-id'));
                if (dataset) dataset.name = e.target.value;
            });
        });
    }

    btnAddDataset.addEventListener('click', () => {
        datasetCounter++;
        const color = PALETTE[(datasetCounter - 1) % PALETTE.length];
        const newDs = { id: `ds_${datasetCounter}`, name: `Series ${datasetCounter}`, color: color, points: [] };
        state.datasets.push(newDs);
        state.activeDatasetId = newDs.id;
        renderDatasetUI();
    });

    function getActiveDataset() { return state.datasets.find(ds => ds.id === state.activeDatasetId); }

    function mapScale(px, px1, px2, val1, val2, useLog) {
        if (useLog) {
            if (val1 <= 0 || val2 <= 0) return null;
            const logV1 = Math.log10(val1);
            const logV2 = Math.log10(val2);
            return Math.pow(10, logV1 + ((px - px1) * (logV2 - logV1)) / (px2 - px1));
        }
        return val1 + ((px - px1) * (val2 - val1)) / (px2 - px1);
    }

    function computeLogicalCoordinates(px, py) {
        const logX1 = parseFloat(valX1.value), logX2 = parseFloat(valX2.value);
        const logY1 = parseFloat(valY1.value), logY2 = parseFloat(valY2.value);

        if (isNaN(logX1) || isNaN(logX2) || isNaN(logY1) || isNaN(logY2) ||
            state.calibration.pxX1 === null || state.calibration.pxX2 === null ||
            state.calibration.pxY1 === null || state.calibration.pxY2 === null) return null;

        const logicalX = mapScale(px, state.calibration.pxX1, state.calibration.pxX2, logX1, logX2, isLogX.checked);
        const logicalY = mapScale(py, state.calibration.pxY1, state.calibration.pxY2, logY1, logY2, isLogY.checked);
        if (logicalX === null || logicalY === null) return null;
        return { x: logicalX, y: logicalY };
    }

    function generateCSVString() {
        let csvStr = "Dataset,X,Y\n";
        state.datasets.forEach(ds => {
            ds.points.forEach(pt => {
                const xStr = isLogX.checked ? pt.logicalX.toExponential(4) : pt.logicalX.toFixed(4);
                const yStr = isLogY.checked ? pt.logicalY.toExponential(4) : pt.logicalY.toFixed(4);
                csvStr += `"${ds.name}",${xStr},${yStr}\n`;
            });
        });
        return csvStr;
    }

    // --- 5. Data generation, rendering, and erasing engines ---
    function colorDistance(r1, g1, b1, r2, g2, b2) {
        return Math.sqrt(Math.pow(r1-r2, 2) + Math.pow(g1-g2, 2) + Math.pow(b1-b2, 2));
    }

    function executeAutoExtraction(targetX, targetY) {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imgData.data;
        const width = canvas.width, height = canvas.height;
        const targetIndex = (targetY * width + targetX) * 4;
        const tR = data[targetIndex], tG = data[targetIndex + 1], tB = data[targetIndex + 2];
        const activeDs = getActiveDataset();
        const extractedPoints = [];

        for (let x = 0; x < width; x += 3) {
            let ySum = 0, matchCount = 0;
            for (let y = 0; y < height; y++) {
                const idx = (y * width + x) * 4;
                const d = colorDistance(tR, tG, tB, data[idx], data[idx+1], data[idx+2]);
                if (d <= state.autoTolerance) { ySum += y; matchCount++; }
            }
            if (matchCount > 0) {
                const avgY = Math.round(ySum / matchCount);
                const logical = computeLogicalCoordinates(x, avgY);
                if (logical) extractedPoints.push({ pxX: x, pxY: avgY, logicalX: logical.x, logicalY: logical.y });
            }
        }
        activeDs.points = activeDs.points.concat(extractedPoints);
        renderDatasetUI();
        renderViewport();
    }

    function erasePoints(px, py) {
        const activeDs = getActiveDataset();
        const originalLength = activeDs.points.length;
        activeDs.points = activeDs.points.filter(pt => {
            const dist = Math.sqrt(Math.pow(pt.pxX - px, 2) + Math.pow(pt.pxY - py, 2));
            return dist > state.eraseRadius;
        });
        if (activeDs.points.length !== originalLength) {
            renderDatasetUI();
            renderViewport();
        }
    }

    function renderViewport() {
        if (!state.image) return;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (state.showBackground) ctx.drawImage(state.image, 0, 0);

        ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
        if (state.calibration.pxX1 !== null) { ctx.strokeStyle = '#ef4444'; ctx.beginPath(); ctx.moveTo(state.calibration.pxX1, 0); ctx.lineTo(state.calibration.pxX1, canvas.height); ctx.stroke(); }
        if (state.calibration.pxX2 !== null) { ctx.strokeStyle = '#b91c1c'; ctx.beginPath(); ctx.moveTo(state.calibration.pxX2, 0); ctx.lineTo(state.calibration.pxX2, canvas.height); ctx.stroke(); }
        if (state.calibration.pxY1 !== null) { ctx.strokeStyle = '#3b82f6'; ctx.beginPath(); ctx.moveTo(0, state.calibration.pxY1); ctx.lineTo(canvas.width, state.calibration.pxY1); ctx.stroke(); }
        if (state.calibration.pxY2 !== null) { ctx.strokeStyle = '#1d4ed8'; ctx.beginPath(); ctx.moveTo(0, state.calibration.pxY2); ctx.lineTo(canvas.width, state.calibration.pxY2); ctx.stroke(); }
        ctx.setLineDash([]);

        state.datasets.forEach(ds => {
            if (ds.points.length === 0) return;
            ctx.strokeStyle = ds.color; ctx.fillStyle = ds.color; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(ds.points[0].pxX, ds.points[0].pxY);
            for (let i = 1; i < ds.points.length; i++) ctx.lineTo(ds.points[i].pxX, ds.points[i].pxY);
            ctx.stroke();
            ds.points.forEach(pt => { ctx.beginPath(); ctx.arc(pt.pxX, pt.pxY, 2.5, 0, Math.PI * 2); ctx.fill(); });
        });

        // Integrating the full crosshair and deletion radius into the main viewport
        if (state.mode !== 'idle') {
            ctx.lineWidth = 1;
            if (state.mode === 'erase') {
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
                ctx.beginPath();
                ctx.arc(state.mouseX, state.mouseY, state.eraseRadius, 0, Math.PI * 2);
                ctx.stroke();
                ctx.strokeStyle = '#ef4444';
            } else {
                ctx.strokeStyle = state.mode.startsWith('digitize') ? getActiveDataset().color : '#f59e0b';
            }
            
            ctx.beginPath();
            ctx.moveTo(state.mouseX, 0); ctx.lineTo(state.mouseX, canvas.height);
            ctx.moveTo(0, state.mouseY); ctx.lineTo(canvas.width, state.mouseY);
            ctx.stroke();
        }
    }

    function updateLoupe(evt) {
        if (state.mode === 'idle') { loupe.classList.add('hidden'); canvas.classList.remove('loupe-active'); return; }
        if (evt.type === 'artificial') return; 

        loupe.classList.remove('hidden'); canvas.classList.add('loupe-active');
        const rect = canvasContainer.getBoundingClientRect();
        const clientX = evt.clientX || rect.left + state.mouseX * (rect.width / canvas.width);
        const clientY = evt.clientY || rect.top + state.mouseY * (rect.height / canvas.height);
        
        loupe.style.left = `${(clientX - rect.left) + 15}px`;
        loupe.style.top = `${(clientY - rect.top) - 135}px`;

        loupeCtx.clearRect(0, 0, loupe.width, loupe.height);
        loupeCtx.fillStyle = '#ffffff'; loupeCtx.fillRect(0, 0, loupe.width, loupe.height);
        
        loupeCtx.imageSmoothingEnabled = false; 
        loupeCtx.drawImage(canvas, state.mouseX - 20, state.mouseY - 20, 40, 40, 0, 0, loupe.width, loupe.height);
        
        // Integrating the centralized tracking crosshair directly into the eraser visualization
        if (state.mode === 'erase') {
            loupeCtx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
            loupeCtx.lineWidth = 1.5;
            loupeCtx.beginPath();
            loupeCtx.arc(loupe.width / 2, loupe.height / 2, state.eraseRadius * 3, 0, Math.PI * 2);
            loupeCtx.stroke();
            
            loupeCtx.strokeStyle = '#ef4444';
            loupeCtx.lineWidth = 1;
        } else {
            loupeCtx.strokeStyle = state.mode.startsWith('digitize') ? getActiveDataset().color : '#f59e0b';
            loupeCtx.lineWidth = 2;
        }
        
        loupeCtx.beginPath();
        loupeCtx.moveTo(loupe.width / 2, 0); loupeCtx.lineTo(loupe.width / 2, loupe.height);
        loupeCtx.moveTo(0, loupe.height / 2); loupeCtx.lineTo(loupe.width, loupe.height / 2);
        loupeCtx.stroke();
    }

    function setMode(newMode, activeBtn) {
        state.mode = newMode;
        document.querySelectorAll('.calib-btn, #btnManualMode, #btnAutoMode, #btnEraseMode').forEach(btn => {
            btn.classList.remove('ring-2', 'ring-indigo-500', 'border-indigo-500', 'border-red-500');
            if(btn.id === 'btnManualMode') btn.className = "border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold py-1.5 rounded-lg text-[11px] transition-all duration-200";
            if(btn.id === 'btnAutoMode') btn.className = "border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/20 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 text-indigo-700 dark:text-indigo-400 font-bold py-1.5 rounded-lg text-[11px] transition-all duration-200";
            if(btn.id === 'btnEraseMode') btn.className = "border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 text-red-700 dark:text-red-400 font-bold py-1.5 rounded-lg text-[11px] transition-all duration-200";
        });
        
        autoControls.classList.add('hidden');
        eraseControls.classList.add('hidden');
        
        if (activeBtn) {
            if(activeBtn.id === 'btnManualMode') {
                activeBtn.className = "border border-indigo-600 bg-indigo-600 text-white font-bold py-1.5 rounded-lg text-[11px] transition-all duration-200 shadow-inner";
            } else if(activeBtn.id === 'btnAutoMode') {
                activeBtn.className = "border border-indigo-600 bg-indigo-600 text-white font-bold py-1.5 rounded-lg text-[11px] transition-all duration-200 shadow-inner";
                autoControls.classList.remove('hidden');
            } else if(activeBtn.id === 'btnEraseMode') {
                activeBtn.className = "border border-red-600 bg-red-600 text-white font-bold py-1.5 rounded-lg text-[11px] transition-all duration-200 shadow-inner";
                eraseControls.classList.remove('hidden');
            } else {
                activeBtn.classList.add('border-indigo-500', 'ring-2', 'ring-indigo-200');
            }
        }
        renderViewport();
    }

    btnCalibX1.addEventListener('click', () => setMode('calibX1', btnCalibX1));
    btnCalibX2.addEventListener('click', () => setMode('calibX2', btnCalibX2));
    btnCalibY1.addEventListener('click', () => setMode('calibY1', btnCalibY1));
    btnCalibY2.addEventListener('click', () => setMode('calibY2', btnCalibY2));
    
    function verifyCalibration() {
        if (!computeLogicalCoordinates(0, 0)) { alert('Please complete the spatial calibration step before extracting data.'); return false; }
        return true;
    }

    btnManualMode.addEventListener('click', () => { if(verifyCalibration()) setMode('digitize_manual', btnManualMode); });
    btnAutoMode.addEventListener('click', () => { if(verifyCalibration()) setMode('digitize_auto', btnAutoMode); });
    btnEraseMode.addEventListener('click', () => setMode('erase', btnEraseMode));

    btnUndo.addEventListener('click', () => {
        const activeDs = getActiveDataset();
        if (activeDs && activeDs.points.length > 0) {
            activeDs.points.pop();
            renderDatasetUI();
            renderViewport();
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        state.mouseX = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
        state.mouseY = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
        
        if (state.mode === 'digitize_manual' && state.isDragging) {
            if (state.lastTracePoint) {
                const d = Math.sqrt(Math.pow(state.mouseX - state.lastTracePoint.x, 2) + Math.pow(state.mouseY - state.lastTracePoint.y, 2));
                if (d >= 8) {
                    const logical = computeLogicalCoordinates(state.mouseX, state.mouseY);
                    if (logical) getActiveDataset().points.push({ pxX: state.mouseX, pxY: state.mouseY, logicalX: logical.x, logicalY: logical.y });
                    state.lastTracePoint = {x: state.mouseX, y: state.mouseY};
                    renderDatasetUI();
                }
            } else state.lastTracePoint = {x: state.mouseX, y: state.mouseY};
        } else if (state.mode === 'erase' && state.isDragging) {
            erasePoints(state.mouseX, state.mouseY);
        }
        
        renderViewport(); updateLoupe(e);
    });

    canvas.addEventListener('mousedown', (e) => {
        const rect = canvas.getBoundingClientRect();
        const px = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
        const py = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
        
        if (state.mode === 'calibX1') { state.calibration.pxX1 = px; setMode('idle', null); }
        else if (state.mode === 'calibX2') { state.calibration.pxX2 = px; setMode('idle', null); }
        else if (state.mode === 'calibY1') { state.calibration.pxY1 = py; setMode('idle', null); }
        else if (state.mode === 'calibY2') { state.calibration.pxY2 = py; setMode('idle', null); }
        else if (state.mode === 'digitize_manual') {
            state.isDragging = true;
            const logical = computeLogicalCoordinates(px, py);
            if (logical) getActiveDataset().points.push({ pxX: px, pxY: py, logicalX: logical.x, logicalY: logical.y });
            state.lastTracePoint = {x: px, y: py};
            renderDatasetUI();
        }
        else if (state.mode === 'digitize_auto') {
            if (!state.showBackground) { alert("Please toggle the background image visibility on to use the color-based sweep algorithm."); return; }
            executeAutoExtraction(px, py); setMode('idle', null);
        }
        else if (state.mode === 'erase') {
            state.isDragging = true;
            erasePoints(px, py);
        }
        updateLoupe(e);
    });

    canvas.addEventListener('mouseup', () => { state.isDragging = false; state.lastTracePoint = null; });
    canvas.addEventListener('mouseleave', () => { state.isDragging = false; state.lastTracePoint = null; loupe.classList.add('hidden'); });

    exportCsvBtn.addEventListener('click', () => {
        const filename = (csvFilename.value.trim() || 'extracted_data') + '.csv';
        const blob = new Blob([generateCSVString()], { type: 'text/csv' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = filename; a.click(); URL.revokeObjectURL(a.href);
    });

    // --- 6. Advanced Python script generator & internal Plotly preview module ---
    btnGeneratePython.addEventListener('click', () => {
        const xLab = document.getElementById('pyXLabel').value;
        const yLab = document.getElementById('pyYLabel').value;
        const fW = document.getElementById('pyFigWidth').value || 8;
        const fH = document.getElementById('pyFigHeight').value || 6;
        const layoutMode = document.getElementById('pyPlotLayout').value;
        const bgTrans = document.getElementById('pyBgTrans').checked ? 'True' : 'False';
        const showGrid = document.getElementById('pyShowGrid').checked ? 'True' : 'False';
        const filename = (csvFilename.value.trim() || 'extracted_data') + '.csv';

        let pyCode = `import pandas as pd
import matplotlib.pyplot as plt

# --- 1. Environment configuration ---
plt.rcParams['axes.labelsize'] = 14
plt.rcParams['xtick.labelsize'] = 12
plt.rcParams['ytick.labelsize'] = 12
plt.rcParams['legend.fontsize'] = 12
plt.rcParams['legend.frameon'] = False

# --- 2. Data ingestion ---
try:
    df = pd.read_csv('${filename}', skipinitialspace=True)
except FileNotFoundError:
    print("Error: ${filename} not found in the working directory.")
    exit()

# --- 3. Rendering architecture ---
`;
        
        const activeDatasets = state.datasets.filter(ds => ds.points.length > 0);

        if (layoutMode === 'subplots') {
            pyCode += `fig, axes = plt.subplots(nrows=${activeDatasets.length}, ncols=1, figsize=(${fW}, ${fH}), sharex=True)\n`;
            pyCode += `if ${activeDatasets.length} == 1: axes = [axes]\n\n`;
            
            activeDatasets.forEach((ds, i) => {
                pyCode += `subset_${ds.id} = df[df['Dataset'] == '${ds.name}']\n`;
                pyCode += `axes[${i}].plot(subset_${ds.id}['X'], subset_${ds.id}['Y'], label='${ds.name}', color='${ds.color}', linewidth=2)\n`;
                if (isLogX.checked) pyCode += `axes[${i}].set_xscale('log')\n`;
                if (isLogY.checked) pyCode += `axes[${i}].set_yscale('log')\n`;
                if (showGrid === 'True') pyCode += `axes[${i}].grid(True, linestyle='--', alpha=0.6)\n`;
                pyCode += `axes[${i}].legend(loc='best')\n\n`;
            });
            pyCode += `axes[-1].set_xlabel('${xLab}')\n`;
            pyCode += `fig.supylabel('${yLab}')\n`;
        } else {
            pyCode += `fig, ax = plt.subplots(figsize=(${fW}, ${fH}))\n\n`;
            activeDatasets.forEach(ds => {
                pyCode += `subset_${ds.id} = df[df['Dataset'] == '${ds.name}']\n`;
                pyCode += `ax.plot(subset_${ds.id}['X'], subset_${ds.id}['Y'], label='${ds.name}', color='${ds.color}', linewidth=2)\n`;
            });
            pyCode += `\nax.set_xlabel('${xLab}')\nax.set_ylabel('${yLab}')\n`;
            if (isLogX.checked) pyCode += `ax.set_xscale('log')\n`;
            if (isLogY.checked) pyCode += `ax.set_yscale('log')\n`;
            if (showGrid === 'True') pyCode += `ax.grid(True, linestyle='--', alpha=0.6)\n`;
            pyCode += `ax.legend(loc='best')\n`;
        }

        pyCode += `\n# --- 4. Output ---
${bgTrans === 'True' ? "fig.patch.set_alpha(0.0)\nfor ax_obj in fig.axes: ax_obj.patch.set_alpha(0.0)\n" : ""}
plt.tight_layout()
plt.savefig('reconstructed_plot.png', dpi=300, transparent=${bgTrans})
plt.show()`;

        pythonCodeBlock.textContent = pyCode;
        pythonModal.classList.remove('hidden');
        pythonModal.classList.add('flex');
    });

    closePythonModal.addEventListener('click', () => {
        pythonModal.classList.add('hidden');
        pythonModal.classList.remove('flex');
    });

    copyPythonBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(pythonCodeBlock.textContent);
        copyPythonBtn.textContent = 'Copied!';
        setTimeout(() => copyPythonBtn.textContent = 'Copy code', 2000);
    });

    btnPreviewPlot.addEventListener('click', () => {
        const xLab = document.getElementById('pyXLabel').value;
        const yLab = document.getElementById('pyYLabel').value;
        const fW = document.getElementById('pyFigWidth').value || 8;
        const fH = document.getElementById('pyFigHeight').value || 6;
        const layoutMode = document.getElementById('pyPlotLayout').value;
        const showGrid = document.getElementById('pyShowGrid').checked;
        const isDark = document.documentElement.classList.contains('dark');
        
        const pxW = fW * 100;
        const pxH = fH * 100;
        
        const activeDatasets = state.datasets.filter(ds => ds.points.length > 0);
        
        let htmlTemplate = `<!DOCTYPE html>
<html class="${isDark ? 'dark' : ''}">
<head>
    <title>Plot Preview | PDFKing</title>
    <script src="https://cdn.plot.ly/plotly-2.24.1.min.js"><\/script>
    <style>
        body { margin:0; padding:20px; font-family:sans-serif; background-color: ${isDark ? '#0f172a' : '#f8fafc'}; color: ${isDark ? '#f1f5f9' : '#0f172a'}; }
        .container { max-width: ${pxW + 40}px; margin: 0 auto; background: ${isDark ? '#1e293b' : '#fff'}; padding: 20px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); border: 1px solid ${isDark ? '#334155' : '#e2e8f0'}; }
    </style>
</head>
<body>
    <div class="container">
        <h2 style="margin-top:0;">Interactive Render Preview</h2>
        <div id="plotsContainer"></div>
    </div>
    <script>
        const isDark = ${isDark};
        const commonLayout = {
            plot_bgcolor: isDark ? '#1e293b' : '${document.getElementById('pyBgTrans').checked ? 'transparent' : '#ffffff'}',
            paper_bgcolor: 'transparent',
            font: { color: isDark ? '#cbd5e1' : '#334155' },
            xaxis: { title: '${xLab}', type: '${isLogX.checked ? 'log' : 'linear'}', showgrid: ${showGrid}, gridcolor: isDark ? '#334155' : '#e2e8f0' },
            yaxis: { title: '${yLab}', type: '${isLogY.checked ? 'log' : 'linear'}', showgrid: ${showGrid}, gridcolor: isDark ? '#334155' : '#e2e8f0' },
            margin: { t: 40, r: 40, b: 60, l: 60 },
            showlegend: true
        };
        const datasets = ${JSON.stringify(activeDatasets.map(ds => ({
            name: ds.name, color: ds.color, x: ds.points.map(p => p.logicalX), y: ds.points.map(p => p.logicalY)
        })))};
        
        const container = document.getElementById('plotsContainer');
        `;

        if (layoutMode === 'subplots') {
            htmlTemplate += `
            datasets.forEach((ds, index) => {
                const div = document.createElement('div');
                div.id = 'plot_' + index;
                div.style.width = '100%';
                div.style.height = '${pxH / activeDatasets.length}px';
                container.appendChild(div);
                
                const layout = Object.assign({}, commonLayout);
                if(index < datasets.length - 1) layout.xaxis = Object.assign({}, layout.xaxis, {title: ''});
                
                Plotly.newPlot(div.id, [{ x: ds.x, y: ds.y, mode: 'lines+markers', name: ds.name, line: { color: ds.color, width: 2 }, marker: { size: 4 } }], layout, {responsive: true});
            });
            `;
        } else {
            htmlTemplate += `
            const div = document.createElement('div');
            div.id = 'mainPlot';
            div.style.width = '100%';
            div.style.height = '${pxH}px';
            container.appendChild(div);
            
            const traces = datasets.map(ds => ({ x: ds.x, y: ds.y, mode: 'lines+markers', name: ds.name, line: { color: ds.color, width: 2 }, marker: { size: 4 } }));
            Plotly.newPlot('mainPlot', traces, commonLayout, {responsive: true});
            `;
        }

        htmlTemplate += `
    <\/script>
</body>
</html>`;

        const blob = new Blob([htmlTemplate], { type: 'text/html' });
        window.open(URL.createObjectURL(blob), '_blank');
    });
});