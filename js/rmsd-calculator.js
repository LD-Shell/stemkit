document.addEventListener("DOMContentLoaded", () => {
    
    // --- 1. State initialization ---
    let frames = [];
    let atomNames = [];
    let rmsdArray = [];
    let rmsfArray = [];

    // --- 2. Interface bindings ---
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    const workspace = document.getElementById('workspace');
    const atomSelection = document.getElementById('atomSelection');
    
    const calculateBtn = document.getElementById('calculateBtn');
    const exportCsvBtn = document.getElementById('exportCsvBtn');
    const resetBtn = document.getElementById('resetBtn');
    
    const rmsdCanvas = document.getElementById('rmsdCanvas');
    const rmsfCanvas = document.getElementById('rmsfCanvas');

    document.getElementById('themeToggle').addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        if (rmsdArray.length > 0) renderPlots();
    });

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
        Plotly.purge(rmsdCanvas);
        Plotly.purge(rmsfCanvas);
    });

    // --- 3. Topology parsing ---
    function handleFile(file) {
        if (!file || !file.name.endsWith('.pdb')) {
            showToast('Validation failed. Requires a standard .pdb trajectory format.', 'error');
            return;
        }

        document.getElementById('fileName').innerText = file.name;
        showToast('Loading data into browser memory. This may take a moment for large trajectories.', 'info');
        
        const reader = new FileReader();
        reader.onload = (event) => {
            parsePDB(event.target.result);
        };
        reader.readAsText(file);
    }

    function parsePDB(text) {
        const lines = text.split('\n');
        frames = [];
        atomNames = [];
        let currentFrame = [];
        let isFirstFrame = true;

        // Reading line by line to extract coordinates based on fixed-width PDB specification
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
                const name = line.substring(12, 16).trim();
                const x = parseFloat(line.substring(30, 38));
                const y = parseFloat(line.substring(38, 46));
                const z = parseFloat(line.substring(46, 54));
                
                currentFrame.push({ name, x, y, z });
                
                if (isFirstFrame) {
                    atomNames.push(name);
                }
            } else if (line.startsWith('ENDMDL') || line.startsWith('END')) {
                if (currentFrame.length > 0) {
                    frames.push(currentFrame);
                    currentFrame = [];
                    isFirstFrame = false;
                }
            }
        }
        
        // Catching the final frame if ENDMDL is missing
        if (currentFrame.length > 0) {
            frames.push(currentFrame);
        }

        if (frames.length < 2) {
            showToast('The provided PDB does not contain a valid multi-model trajectory sequence.', 'error');
            resetBtn.click();
            return;
        }

        document.getElementById('trajectoryMeta').innerText = `${frames.length} Frames • ${frames[0].length} Atoms/Frame`;
        uploadZone.classList.add('hidden');
        workspace.classList.remove('hidden');
        showToast('Trajectory successfully parsed.', 'success');
    }

    // --- 4. Matrix computations ---
    calculateBtn.addEventListener('click', () => {
        const selectionFilter = atomSelection.value;
        const refFrame = frames[0];
        
        rmsdArray = [];
        rmsfArray = [];

        // Identifying target atom indices based on filter criteria
        const validIndices = [];
        for (let i = 0; i < refFrame.length; i++) {
            const name = refFrame[i].name;
            if (selectionFilter === 'all') {
                validIndices.push(i);
            } else if (selectionFilter === 'heavy' && !name.startsWith('H')) {
                validIndices.push(i);
            } else if (selectionFilter === 'backbone' && (name === 'CA' || name === 'C' || name === 'N' || name === 'O')) {
                validIndices.push(i);
            }
        }

        if (validIndices.length === 0) {
            showToast('Atom selection filter yielded zero valid targets.', 'error');
            return;
        }

        const N = validIndices.length;

        // I am calculating the RMSD over time relative to the starting topology
        for (let t = 0; t < frames.length; t++) {
            let sumSqDist = 0;
            const current = frames[t];
            
            for (let idx of validIndices) {
                const dx = current[idx].x - refFrame[idx].x;
                const dy = current[idx].y - refFrame[idx].y;
                const dz = current[idx].z - refFrame[idx].z;
                sumSqDist += (dx*dx + dy*dy + dz*dz);
            }
            rmsdArray.push(Math.sqrt(sumSqDist / N));
        }

        // I am extracting the time-averaged positional vector for RMSF computation
        const avgPositions = [];
        for (let idx of validIndices) {
            let sumX = 0, sumY = 0, sumZ = 0;
            for (let t = 0; t < frames.length; t++) {
                sumX += frames[t][idx].x;
                sumY += frames[t][idx].y;
                sumZ += frames[t][idx].z;
            }
            avgPositions.push({
                x: sumX / frames.length,
                y: sumY / frames.length,
                z: sumZ / frames.length
            });
        }

        // I am calculating the positional fluctuation for each selected atom
        for (let i = 0; i < validIndices.length; i++) {
            const atomIdx = validIndices[i];
            const avg = avgPositions[i];
            let sumFluct = 0;
            
            for (let t = 0; t < frames.length; t++) {
                const dx = frames[t][atomIdx].x - avg.x;
                const dy = frames[t][atomIdx].y - avg.y;
                const dz = frames[t][atomIdx].z - avg.z;
                sumFluct += (dx*dx + dy*dy + dz*dz);
            }
            rmsfArray.push({
                index: atomIdx,
                name: refFrame[atomIdx].name,
                value: Math.sqrt(sumFluct / frames.length)
            });
        }

        renderPlots();
        exportCsvBtn.disabled = false;
        showToast('Deviations and fluctuations computed successfully.', 'success');
    });

    // --- 5. Graphical rendering ---
    function renderPlots() {
        const isDark = document.documentElement.classList.contains('dark');
        const textColor = isDark ? '#cbd5e1' : '#475569';
        const gridColor = isDark ? '#334155' : '#e2e8f0';

        const baseLayout = {
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            margin: { t: 30, l: 50, r: 20, b: 40 },
            xaxis: { gridcolor: gridColor, tickfont: { color: textColor }, titlefont: { color: textColor } },
            yaxis: { gridcolor: gridColor, tickfont: { color: textColor }, titlefont: { color: textColor } }
        };

        const rmsdTrace = {
            x: Array.from({length: rmsdArray.length}, (_, i) => i),
            y: rmsdArray,
            mode: 'lines',
            line: { color: '#4f46e5', width: 2 },
            name: 'RMSD'
        };

        Plotly.newPlot(rmsdCanvas, [rmsdTrace], {
            ...baseLayout,
            xaxis: { ...baseLayout.xaxis, title: 'Frame' },
            yaxis: { ...baseLayout.yaxis, title: 'RMSD (Å)' }
        }, { displayModeBar: false, responsive: true });

        const rmsfTrace = {
            x: rmsfArray.map(a => a.index),
            y: rmsfArray.map(a => a.value),
            text: rmsfArray.map(a => a.name),
            mode: 'lines',
            line: { color: '#ef4444', width: 2 },
            name: 'RMSF'
        };

        Plotly.newPlot(rmsfCanvas, [rmsfTrace], {
            ...baseLayout,
            xaxis: { ...baseLayout.xaxis, title: 'Atom Index' },
            yaxis: { ...baseLayout.yaxis, title: 'RMSF (Å)' }
        }, { displayModeBar: false, responsive: true });
    }

    // --- 6. Array exportation ---
    exportCsvBtn.addEventListener('click', () => {
        let csvContent = "Time_Frame,RMSD_Angstroms\n";
        for (let t = 0; t < rmsdArray.length; t++) {
            csvContent += `${t},${rmsdArray[t].toFixed(4)}\n`;
        }
        
        csvContent += "\nAtom_Index,Atom_Name,RMSF_Angstroms\n";
        for (let i = 0; i < rmsfArray.length; i++) {
            csvContent += `${rmsfArray[i].index},${rmsfArray[i].name},${rmsfArray[i].value.toFixed(4)}\n`;
        }

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", "trajectory_analysis.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        showToast("Extracted trajectory arrays to disk.", "success");
    });

    // --- 7. Status utility ---
    function showToast(msg, type) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 
                       type === 'error' ? 'bg-red-50 text-red-800 border-red-200' : 
                       'bg-indigo-50 text-indigo-800 border-indigo-200';
        
        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        
        let icon = 'fa-info-circle';
        if (type === 'success') icon = 'fa-check-circle';
        if (type === 'error') icon = 'fa-triangle-exclamation';
        
        toast.innerHTML = `<i class="fa-solid ${icon} mr-2"></i> ${msg}`;
        
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
});