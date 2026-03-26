document.addEventListener("DOMContentLoaded", () => {
    
    // --- 1. State Configuration ---
    let frames = [];
    let computedR = [];
    let computedGr = [];

    // --- 2. Interface Mapping ---
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    const workspace = document.getElementById('workspace');
    
    const atomName1 = document.getElementById('atomName1');
    const atomName2 = document.getElementById('atomName2');
    const boxX = document.getElementById('boxX');
    const boxY = document.getElementById('boxY');
    const boxZ = document.getElementById('boxZ');
    const binWidthInput = document.getElementById('binWidth');
    
    const calculateBtn = document.getElementById('calculateBtn');
    const exportCsvBtn = document.getElementById('exportCsvBtn');
    const resetBtn = document.getElementById('resetBtn');
    
    const rdfCanvas = document.getElementById('rdfCanvas');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const emptyPlotState = document.getElementById('emptyPlotState');

    // Theme logic
    document.querySelectorAll('.themeToggle').forEach(btn => btn.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        if (computedGr.length > 0) renderPlot();
    });

    // Drag and Drop
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
    });

    uploadZone.addEventListener('dragover', () => uploadZone.classList.add('border-indigo-500'));
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('border-indigo-500'));
    uploadZone.addEventListener('drop', (e) => {
        uploadZone.classList.remove('border-indigo-500');
        handleFile(e.dataTransfer.files[0]);
    });

    uploadZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

    resetBtn.addEventListener('click', () => {
        frames = [];
        uploadZone.classList.remove('hidden');
        workspace.classList.add('hidden');
        emptyPlotState.classList.remove('hidden');
        exportCsvBtn.disabled = true;
        Plotly.purge(rdfCanvas);
    });

    // --- 3. Fixed-Width PDB Parsing ---
    function handleFile(file) {
        if (!file || !file.name.endsWith('.pdb')) {
            showToast('Validation failed. Please select a .pdb trajectory.', 'error');
            return;
        }

        document.getElementById('fileName').innerText = file.name;
        showToast('Parsing trajectory topology...', 'info');
        
        const reader = new FileReader();
        reader.onload = (event) => {
            parsePDB(event.target.result);
        };
        reader.readAsText(file);
    }

    function parsePDB(text) {
        const lines = text.split('\n');
        frames = [];
        let currentFrame = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
                // Parsing fixed-width columns per PDB spec
                const name = line.substring(12, 16).trim();
                const x = parseFloat(line.substring(30, 38));
                const y = parseFloat(line.substring(38, 46));
                const z = parseFloat(line.substring(46, 54));
                
                currentFrame.push({ name, x, y, z });
            } else if (line.startsWith('ENDMDL') || line.startsWith('END')) {
                if (currentFrame.length > 0) {
                    frames.push(currentFrame);
                    currentFrame = [];
                }
            }
        }
        
        if (currentFrame.length > 0) frames.push(currentFrame);

        document.getElementById('trajectoryMeta').innerText = `${frames.length} Frames • ${frames[0]?.length || 0} Atoms/Frame`;
        uploadZone.classList.add('hidden');
        workspace.classList.remove('hidden');
        showToast('Topology initialized in memory.', 'success');
    }

    // --- 4. Minimum Image Convention & RDF Algorithm ---
    calculateBtn.addEventListener('click', () => {
        const name1 = atomName1.value.trim().toUpperCase();
        const name2 = atomName2.value.trim().toUpperCase();
        const L = {
            x: parseFloat(boxX.value),
            y: parseFloat(boxY.value),
            z: parseFloat(boxZ.value)
        };
        const dr = parseFloat(binWidthInput.value);

        if (!name1 || !name2) {
            showToast('Please specify both atom names (e.g., OW, HW).', 'error');
            return;
        }

        // The maximum computable radius is half the smallest box dimension to prevent artifacting
        const rMax = Math.min(L.x, L.y, L.z) / 2.0;
        const nBins = Math.floor(rMax / dr);
        
        // Using setTimeout to allow the browser to paint the loading overlay before locking the thread
        loadingOverlay.classList.remove('hidden');
        
        setTimeout(() => {
            try {
                computeRDF(name1, name2, L, dr, rMax, nBins);
            } catch (err) {
                console.error(err);
                showToast("Fatal error during computation.", "error");
                loadingOverlay.classList.add('hidden');
            }
        }, 50);
    });

    function computeRDF(name1, name2, L, dr, rMax, nBins) {
        const histogram = new Array(nBins).fill(0);
        let count1 = 0;
        let count2 = 0;

        // Iterate through all frames
        for (let f = 0; f < frames.length; f++) {
            const frame = frames[f];
            
            // Isolate atom subsets
            const sel1 = [];
            const sel2 = [];
            
            for (let i = 0; i < frame.length; i++) {
                if (frame[i].name === name1) sel1.push(frame[i]);
                if (frame[i].name === name2) sel2.push(frame[i]);
            }

            if (f === 0) {
                count1 = sel1.length;
                count2 = sel2.length;
                if (count1 === 0 || count2 === 0) {
                    showToast("Atom selection not found in trajectory.", "error");
                    loadingOverlay.classList.add('hidden');
                    return;
                }
            }

            const isSameSelection = (name1 === name2);

            // Double loop for spatial distances
            for (let i = 0; i < sel1.length; i++) {
                // If same selection, only compute upper triangle to prevent double counting
                let jStart = isSameSelection ? i + 1 : 0;
                
                for (let j = jStart; j < sel2.length; j++) {
                    // Periodic Boundary Conditions (Minimum Image Convention)
                    let dx = sel1[i].x - sel2[j].x;
                    let dy = sel1[i].y - sel2[j].y;
                    let dz = sel1[i].z - sel2[j].z;

                    dx -= L.x * Math.round(dx / L.x);
                    dy -= L.y * Math.round(dy / L.y);
                    dz -= L.z * Math.round(dz / L.z);

                    const r = Math.sqrt(dx*dx + dy*dy + dz*dz);

                    if (r < rMax) {
                        const bin = Math.floor(r / dr);
                        if (bin < nBins) {
                            // If same selection, add 2 because we only computed half the matrix
                            histogram[bin] += isSameSelection ? 2 : 1;
                        }
                    }
                }
            }
        }

        // Normalization protocol
        const volume = L.x * L.y * L.z;
        const numFrames = frames.length;
        
        // Global density calculation
        let density;
        if (name1 === name2) {
            density = (count2 - 1) / volume;
        } else {
            density = count2 / volume;
        }

        computedR = [];
        computedGr = [];

        for (let i = 0; i < nBins; i++) {
            const rInner = i * dr;
            const rOuter = (i + 1) * dr;
            const rMid = rInner + (dr / 2.0);
            
            // Volume of the spherical shell
            const shellVolume = (4.0 / 3.0) * Math.PI * (Math.pow(rOuter, 3) - Math.pow(rInner, 3));
            
            const idealCount = shellVolume * density;
            const actualCount = histogram[i] / (numFrames * count1);
            
            computedR.push(rMid);
            computedGr.push(actualCount / idealCount);
        }

        loadingOverlay.classList.add('hidden');
        emptyPlotState.classList.add('hidden');
        renderPlot();
        exportCsvBtn.disabled = false;
        showToast("Radial Distribution Function computed successfully.", "success");
    }

    // --- 5. Graphical Rendering ---
    function renderPlot() {
        const isDark = document.documentElement.classList.contains('dark');
        const textColor = isDark ? '#cbd5e1' : '#475569';
        const gridColor = isDark ? '#334155' : '#e2e8f0';

        const trace = {
            x: computedR,
            y: computedGr,
            mode: 'lines',
            line: { color: '#4f46e5', width: 2.5, shape: 'spline' },
            fill: 'tozeroy',
            fillcolor: isDark ? 'rgba(79, 70, 229, 0.2)' : 'rgba(79, 70, 229, 0.1)',
            name: 'g(r)'
        };

        const layout = {
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            margin: { t: 30, l: 60, r: 30, b: 50 },
            xaxis: { 
                title: { text: 'Distance r (Å)', font: { color: textColor } },
                gridcolor: gridColor, 
                tickfont: { color: textColor } 
            },
            yaxis: { 
                title: { text: 'g(r)', font: { color: textColor } },
                gridcolor: gridColor, 
                tickfont: { color: textColor } 
            }
        };

        Plotly.newPlot(rdfCanvas, [trace], layout, { displayModeBar: false, responsive: true });
    }

    // --- 6. Array Export ---
    exportCsvBtn.addEventListener('click', () => {
        let csvContent = "r_Angstroms,g_r\n";
        for (let i = 0; i < computedR.length; i++) {
            csvContent += `${computedR[i].toFixed(4)},${computedGr[i].toFixed(4)}\n`;
        }

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `rdf_${atomName1.value}_${atomName2.value}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        showToast("g(r) array exported to disk.", "success");
    });

    // --- 7. Utility ---
    function showToast(msg, type) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30' : 
                       type === 'error' ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30' : 
                       'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30';
        
        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        toast.innerHTML = `<i class="fa-solid ${type==='success'?'fa-check-circle':type==='error'?'fa-triangle-exclamation':'fa-info-circle'} mr-2"></i> ${msg}`;
        
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
});