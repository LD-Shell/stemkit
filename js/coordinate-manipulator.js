document.addEventListener('DOMContentLoaded', () => {

    // --- 1. Spatial definition state ---
    const state = {
        atoms: [], 
        unitType: 'Å', // PDB defaults to Å, GRO defaults to nm
        sourceFormat: '',
        boxData: [] // Stores trailing simulation box dimensions if parsed
    };

    // --- 2. Interface bindings ---
    const uploadZone = document.getElementById('uploadZone');
    const dropArea = document.getElementById('dropArea');
    const fileInput = document.getElementById('fileInput');
    const workspace = document.getElementById('workspace');
    const btnCloseWorkspace = document.getElementById('btnCloseWorkspace');
    
    const systemFormatLabel = document.getElementById('systemFormatLabel');
    const statAtomCount = document.getElementById('statAtomCount');
    const statGeoCenter = document.getElementById('statGeoCenter');
    const statBoundingBox = document.getElementById('statBoundingBox');
    
    const transX = document.getElementById('transX');
    const transY = document.getElementById('transY');
    const transZ = document.getElementById('transZ');
    
    const btnApplyTrans = document.getElementById('btnApplyTrans');
    const btnCenterSys = document.getElementById('btnCenterSys');
    
    const exportFormat = document.getElementById('exportFormat');
    const exportName = document.getElementById('exportName');
    const btnDownload = document.getElementById('btnDownload');
    
    const coordOutput = document.getElementById('coordOutput');
    const btnCopyBuffer = document.getElementById('btnCopyBuffer');
    const toastContainer = document.getElementById('toastContainer');
    const themeToggleBtn = document.getElementById('themeToggle');

    // UI accordion initialization
    document.querySelectorAll('.accordion-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const isExpanded = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', !isExpanded);
            document.getElementById(btn.getAttribute('data-target')).classList.toggle('expanded');
        });
    });

    themeToggleBtn.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    });

    // --- 3. I/O handling ---
    dropArea.addEventListener('click', () => fileInput.click());

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); });
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => dropArea.classList.add('bg-purple-100', 'dark:bg-purple-900/30', 'border-purple-400'));
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => dropArea.classList.remove('bg-purple-100', 'dark:bg-purple-900/30', 'border-purple-400'));
    });

    dropArea.addEventListener('drop', (e) => { if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) handleFile(e.target.files[0]); });

    btnCloseWorkspace.addEventListener('click', () => {
        workspace.classList.add('hidden');
        uploadZone.classList.remove('opacity-0', 'pointer-events-none');
        fileInput.value = '';
        state.atoms = [];
    });

    // --- 4. File parsing engine ---
    function handleFile(file) {
        const reader = new FileReader();
        const ext = file.name.split('.').pop().toLowerCase();
        
        reader.onload = (e) => {
            const lines = e.target.result.split('\n');
            state.atoms = [];
            state.boxData = [];
            
            if (ext === 'pdb') parsePDB(lines);
            else if (ext === 'gro') parseGRO(lines);
            else if (ext === 'xyz') parseXYZ(lines);
            else {
                showToast("Unsupported file architecture.");
                return;
            }

            if (state.atoms.length > 0) {
                state.sourceFormat = ext;
                systemFormatLabel.innerText = `Loaded ${ext.toUpperCase()} Structure (${state.unitType})`;
                
                uploadZone.classList.add('opacity-0', 'pointer-events-none');
                workspace.classList.remove('hidden');
                
                updateSystemStats();
                renderOutputBuffer();
            } else {
                showToast("Failed to extract valid coordinates.");
            }
        };
        reader.readAsText(file);
    }

    // Extracting rigid coordinate data while preserving basic molecular taxonomy
    function parsePDB(lines) {
        state.unitType = 'Å';
        lines.forEach(line => {
            if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
                state.atoms.push({
                    type: line.substring(0, 6).trim(),
                    serial: parseInt(line.substring(6, 11)),
                    atomName: line.substring(12, 16).trim(),
                    resName: line.substring(17, 20).trim(),
                    chain: line.substring(21, 22).trim(),
                    resSeq: parseInt(line.substring(22, 26)),
                    x: parseFloat(line.substring(30, 38)),
                    y: parseFloat(line.substring(38, 46)),
                    z: parseFloat(line.substring(46, 54)),
                    occupancy: line.substring(54, 60).trim() || "1.00",
                    tempFactor: line.substring(60, 66).trim() || "0.00",
                    element: line.substring(76, 78).trim() || ""
                });
            }
        });
    }

    // Parsing strictly formatted GROMACS matrices
    function parseGRO(lines) {
        state.unitType = 'nm';
        const cleanLines = lines.filter(l => l.trim().length > 0);
        if (cleanLines.length < 3) return;
        
        const atomCount = parseInt(cleanLines[1].trim());
        
        // Iterating across the strict fixed-width structure of standard .gro output
        for (let i = 2; i < 2 + atomCount; i++) {
            const line = cleanLines[i];
            if (!line || line.length < 44) continue;
            
            state.atoms.push({
                resSeq: parseInt(line.substring(0, 5)),
                resName: line.substring(5, 10).trim(),
                atomName: line.substring(10, 15).trim(),
                serial: parseInt(line.substring(15, 20)),
                x: parseFloat(line.substring(20, 28)),
                y: parseFloat(line.substring(28, 36)),
                z: parseFloat(line.substring(36, 44))
            });
        }
        
        // Caching simulation box vectors if present
        const lastLine = cleanLines[cleanLines.length - 1].trim().split(/\s+/);
        if (lastLine.length >= 3) state.boxData = lastLine;
    }

    function parseXYZ(lines) {
        state.unitType = 'Å';
        const cleanLines = lines.filter(l => l.trim().length > 0);
        if (cleanLines.length < 3) return;
        
        const atomCount = parseInt(cleanLines[0].trim());
        for (let i = 2; i < 2 + atomCount; i++) {
            const tokens = cleanLines[i].trim().split(/\s+/);
            if (tokens.length >= 4) {
                state.atoms.push({
                    atomName: tokens[0],
                    resName: 'UNK',
                    resSeq: 1,
                    serial: i - 1,
                    x: parseFloat(tokens[1]),
                    y: parseFloat(tokens[2]),
                    z: parseFloat(tokens[3])
                });
            }
        }
    }

    // --- 5. Mathematical transformations ---
    function updateSystemStats() {
        if (state.atoms.length === 0) return;

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        let sumX = 0, sumY = 0, sumZ = 0;

        state.atoms.forEach(a => {
            if (a.x < minX) minX = a.x; if (a.x > maxX) maxX = a.x;
            if (a.y < minY) minY = a.y; if (a.y > maxY) maxY = a.y;
            if (a.z < minZ) minZ = a.z; if (a.z > maxZ) maxZ = a.z;
            
            sumX += a.x;
            sumY += a.y;
            sumZ += a.z;
        });

        const numAtoms = state.atoms.length;
        const cx = sumX / numAtoms;
        const cy = sumY / numAtoms;
        const cz = sumZ / numAtoms;

        statAtomCount.innerText = numAtoms.toLocaleString();
        statGeoCenter.innerText = `${cx.toFixed(3)}, ${cy.toFixed(3)}, ${cz.toFixed(3)} ${state.unitType}`;
        
        const dx = Math.abs(maxX - minX);
        const dy = Math.abs(maxY - minY);
        const dz = Math.abs(maxZ - minZ);
        statBoundingBox.innerText = `${dx.toFixed(2)} × ${dy.toFixed(2)} × ${dz.toFixed(2)} ${state.unitType}`;
    }

    btnApplyTrans.addEventListener('click', () => {
        if (state.atoms.length === 0) return;
        
        const dx = parseFloat(transX.value) || 0;
        const dy = parseFloat(transY.value) || 0;
        const dz = parseFloat(transZ.value) || 0;

        state.atoms.forEach(a => {
            a.x += dx;
            a.y += dy;
            a.z += dz;
        });

        // Resetting inputs to prevent sequential compounding by accident
        transX.value = "0.000";
        transY.value = "0.000";
        transZ.value = "0.000";

        updateSystemStats();
        renderOutputBuffer();
        showToast("Translation vector applied.");
    });

    btnCenterSys.addEventListener('click', () => {
        if (state.atoms.length === 0) return;

        let sumX = 0, sumY = 0, sumZ = 0;
        state.atoms.forEach(a => { sumX += a.x; sumY += a.y; sumZ += a.z; });
        
        const cx = sumX / state.atoms.length;
        const cy = sumY / state.atoms.length;
        const cz = sumZ / state.atoms.length;

        state.atoms.forEach(a => {
            a.x -= cx;
            a.y -= cy;
            a.z -= cz;
        });

        updateSystemStats();
        renderOutputBuffer();
        showToast("System aligned to absolute origin (0,0,0).");
    });

    // --- 6. Formatting and export engines ---
    // Enforcing strict coordinate padding to prevent molecular visualizer rendering errors
    function padStr(str, len, leftAlign = false) {
        str = str.toString();
        if (str.length >= len) return str.substring(0, len);
        if (leftAlign) return str + " ".repeat(len - str.length);
        return " ".repeat(len - str.length) + str;
    }

    function generateOutputString() {
        const format = exportFormat.value;
        let out = "";

        if (format === 'xyz') {
            out += `${state.atoms.length}\n`;
            out += `Generated by STEMKit Coordinate Manipulator\n`;
            state.atoms.forEach(a => {
                // Handling element extraction fallback for standard XYZ requirements
                const elem = a.element || a.atomName.replace(/[0-9]/g, '').substring(0,1);
                out += `${padStr(elem, 4, true)} ${padStr(a.x.toFixed(4), 10)} ${padStr(a.y.toFixed(4), 10)} ${padStr(a.z.toFixed(4), 10)}\n`;
            });
        } 
        else if (format === 'pdb') {
            out += `REMARK   Generated by STEMKit Coordinate Manipulator\n`;
            state.atoms.forEach((a, i) => {
                const serial = padStr((i + 1) % 100000, 5);
                const aName = padStr(a.atomName, 4, true);
                const rName = padStr(a.resName, 3);
                const rSeq = padStr(a.resSeq % 10000, 4);
                const x = padStr(a.x.toFixed(3), 8);
                const y = padStr(a.y.toFixed(3), 8);
                const z = padStr(a.z.toFixed(3), 8);
                
                // Constructing the strict fixed-width PDB ATOM entry
                out += `ATOM  ${serial} ${aName} ${rName} A${rSeq}    ${x}${y}${z}  1.00  0.00\n`;
            });
            out += `END\n`;
        }
        
        return out;
    }

    function renderOutputBuffer() {
        coordOutput.textContent = generateOutputString();
    }

    exportFormat.addEventListener('change', renderOutputBuffer);

    btnDownload.addEventListener('click', () => {
        if (state.atoms.length === 0) return;
        
        const ext = exportFormat.value;
        let filename = exportName.value.trim() || 'translated_sys';
        if (!filename.endsWith(`.${ext}`)) filename += `.${ext}`;

        const blob = new Blob([generateOutputString()], { type: 'text/plain' });
        const a = document.createElement('a'); 
        a.href = URL.createObjectURL(blob);
        a.download = filename; 
        a.click(); 
        URL.revokeObjectURL(a.href);
    });

    // --- 7. Utility components ---
    function showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'bg-slate-800 text-white text-xs font-bold px-4 py-2 rounded-lg shadow-xl transform transition-all duration-300 translate-y-[-20px] opacity-0';
        toast.innerText = message;
        
        toastContainer.appendChild(toast);
        
        requestAnimationFrame(() => {
            toast.classList.remove('translate-y-[-20px]', 'opacity-0');
            toast.classList.add('translate-y-0', 'opacity-100');
        });

        setTimeout(() => {
            toast.classList.remove('translate-y-0', 'opacity-100');
            toast.classList.add('translate-y-[-20px]', 'opacity-0');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    btnCopyBuffer.addEventListener('click', () => {
        const code = coordOutput.textContent;
        if (code === "Awaiting structure array...") return;

        navigator.clipboard.writeText(code).then(() => {
            showToast('Coordinate array copied to clipboard!');
            const icon = btnCopyBuffer.querySelector('i');
            icon.className = 'fa-solid fa-check text-emerald-400';
            setTimeout(() => { icon.className = 'fa-regular fa-copy text-white'; }, 2000);
        });
    });

});