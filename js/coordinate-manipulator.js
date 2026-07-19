/*
 * STEMKit — Coordinate Manipulator
 * Author: Olanrewaju M. Daramola
 *
 * Parses PDB / GRO / XYZ molecular structures and applies rigid-body operations
 * (translation, centring) entirely in the browser.
 *
 * UNIT HANDLING (important):
 *   - PDB and XYZ coordinates are in Ångström (Å).
 *   - GROMACS .gro coordinates are in nanometres (nm), where 1 nm = 10 Å.
 * The tool keeps atoms in the unit of the source file and CONVERTS on export so
 * that, e.g., a .gro loaded in nm is written out as a valid .pdb in Å. Statistics
 * and the translation vector use the source unit (shown in the UI).
 *
 * References:
 *   PDB legacy format ...... https://www.wwpdb.org/documentation/file-format
 *   GROMACS .gro format ..... https://manual.gromacs.org/current/reference-manual/file-formats.html
 */
document.addEventListener('DOMContentLoaded', () => {

    // --- 1. State ---
    const state = {
        atoms: [],
        unitType: 'Å',     // 'Å' (pdb/xyz) or 'nm' (gro)
        sourceFormat: '',
        boxData: []        // trailing simulation box vectors (nm) if parsed from .gro
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
    const exportUnitNote = document.getElementById('exportUnitNote'); // optional

    // Accordion init
    document.querySelectorAll('.accordion-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const isExpanded = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', !isExpanded);
            document.getElementById(btn.getAttribute('data-target')).classList.toggle('expanded');
        });
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

    // --- 4. Parsing ---
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
            else { showToast("Unsupported file type."); return; }

            if (state.atoms.length > 0) {
                state.sourceFormat = ext;
                systemFormatLabel.innerText = `Loaded ${ext.toUpperCase()} Structure (${state.unitType})`;

                // Default the export format to match the source so no conversion
                // surprises the user; they can still change it.
                if (exportFormat) {
                    const wanted = ext === 'gro' ? 'gro' : (ext === 'pdb' ? 'pdb' : 'xyz');
                    if ([...exportFormat.options].some(o => o.value === wanted)) exportFormat.value = wanted;
                }

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

    function safeFloat(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; }

    function parsePDB(lines) {
        state.unitType = 'Å';
        lines.forEach(line => {
            if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
                const x = safeFloat(line.substring(30, 38));
                const y = safeFloat(line.substring(38, 46));
                const z = safeFloat(line.substring(46, 54));
                if ([x, y, z].some(Number.isNaN)) return;
                state.atoms.push({
                    type: line.substring(0, 6).trim(),
                    serial: parseInt(line.substring(6, 11)) || state.atoms.length + 1,
                    atomName: line.substring(12, 16).trim(),
                    resName: line.substring(17, 20).trim(),
                    chain: line.substring(21, 22).trim(),
                    resSeq: parseInt(line.substring(22, 26)) || 1,
                    x, y, z,
                    occupancy: line.substring(54, 60).trim() || "1.00",
                    tempFactor: line.substring(60, 66).trim() || "0.00",
                    element: line.substring(76, 78).trim() || ""
                });
            }
        });
    }

    function parseGRO(lines) {
        state.unitType = 'nm';
        const cleanLines = lines.filter(l => l.trim().length > 0);
        if (cleanLines.length < 3) return;

        const atomCount = parseInt(cleanLines[1].trim());
        for (let i = 2; i < 2 + atomCount && i < cleanLines.length; i++) {
            const line = cleanLines[i];
            if (!line || line.length < 44) continue;
            const x = safeFloat(line.substring(20, 28));
            const y = safeFloat(line.substring(28, 36));
            const z = safeFloat(line.substring(36, 44));
            if ([x, y, z].some(Number.isNaN)) continue;
            state.atoms.push({
                resSeq: parseInt(line.substring(0, 5)) || 1,
                resName: line.substring(5, 10).trim(),
                atomName: line.substring(10, 15).trim(),
                serial: parseInt(line.substring(15, 20)) || (i - 1),
                x, y, z,
                occupancy: "1.00",
                tempFactor: "0.00",
                element: ""
            });
        }

        const lastLine = cleanLines[cleanLines.length - 1].trim().split(/\s+/);
        if (lastLine.length >= 3 && lastLine.every(v => Number.isFinite(parseFloat(v)))) {
            state.boxData = lastLine.map(parseFloat); // nm
        }
    }

    function parseXYZ(lines) {
        state.unitType = 'Å';
        const cleanLines = lines.filter(l => l.trim().length > 0);
        if (cleanLines.length < 3) return;

        const atomCount = parseInt(cleanLines[0].trim());
        for (let i = 2; i < 2 + atomCount && i < cleanLines.length; i++) {
            const tokens = cleanLines[i].trim().split(/\s+/);
            if (tokens.length >= 4) {
                const x = safeFloat(tokens[1]);
                const y = safeFloat(tokens[2]);
                const z = safeFloat(tokens[3]);
                if ([x, y, z].some(Number.isNaN)) continue;
                state.atoms.push({
                    atomName: tokens[0],
                    resName: 'UNK',
                    resSeq: 1,
                    serial: i - 1,
                    x, y, z,
                    occupancy: "1.00",
                    tempFactor: "0.00",
                    element: /^[A-Za-z]{1,2}$/.test(tokens[0]) ? tokens[0] : ""
                });
            }
        }
    }

    // --- 5. Statistics & transforms ---
    function updateSystemStats() {
        if (state.atoms.length === 0) return;

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        let sumX = 0, sumY = 0, sumZ = 0;

        state.atoms.forEach(a => {
            if (a.x < minX) minX = a.x; if (a.x > maxX) maxX = a.x;
            if (a.y < minY) minY = a.y; if (a.y > maxY) maxY = a.y;
            if (a.z < minZ) minZ = a.z; if (a.z > maxZ) maxZ = a.z;
            sumX += a.x; sumY += a.y; sumZ += a.z;
        });

        const n = state.atoms.length;
        statAtomCount.innerText = n.toLocaleString();
        statGeoCenter.innerText = `${(sumX / n).toFixed(3)}, ${(sumY / n).toFixed(3)}, ${(sumZ / n).toFixed(3)} ${state.unitType}`;
        statBoundingBox.innerText = `${Math.abs(maxX - minX).toFixed(2)} × ${Math.abs(maxY - minY).toFixed(2)} × ${Math.abs(maxZ - minZ).toFixed(2)} ${state.unitType}`;

        updateExportUnitNote();
    }

    function updateExportUnitNote() {
        if (!exportUnitNote || !exportFormat) return;
        const target = targetUnit(exportFormat.value);
        if (target === state.unitType) {
            exportUnitNote.textContent = `No unit conversion needed (${state.unitType} → ${target}).`;
        } else {
            exportUnitNote.textContent = `Coordinates will be converted ${state.unitType} → ${target} on export.`;
        }
    }

    btnApplyTrans.addEventListener('click', () => {
        if (state.atoms.length === 0) return;
        const dx = safeFloat(transX.value) || 0;
        const dy = safeFloat(transY.value) || 0;
        const dz = safeFloat(transZ.value) || 0;

        state.atoms.forEach(a => { a.x += dx; a.y += dy; a.z += dz; });

        transX.value = "0.000"; transY.value = "0.000"; transZ.value = "0.000";
        updateSystemStats();
        renderOutputBuffer();
        showToast("Translation vector applied.");
    });

    btnCenterSys.addEventListener('click', () => {
        if (state.atoms.length === 0) return;
        let sumX = 0, sumY = 0, sumZ = 0;
        state.atoms.forEach(a => { sumX += a.x; sumY += a.y; sumZ += a.z; });
        const cx = sumX / state.atoms.length, cy = sumY / state.atoms.length, cz = sumZ / state.atoms.length;
        state.atoms.forEach(a => { a.x -= cx; a.y -= cy; a.z -= cz; });

        updateSystemStats();
        renderOutputBuffer();
        showToast("System centred on the origin (0, 0, 0).");
    });

    // --- 6. Formatting & export ---
    function padStr(str, len, leftAlign = false) {
        str = str.toString();
        if (str.length >= len) return str.substring(0, len);
        return leftAlign ? str + " ".repeat(len - str.length) : " ".repeat(len - str.length) + str;
    }

    function targetUnit(format) {
        return format === 'gro' ? 'nm' : 'Å'; // pdb, xyz => Å
    }

    // Conversion factor from the source unit to the export target unit.
    function unitFactor(format) {
        const target = targetUnit(format);
        if (state.unitType === target) return 1;
        if (state.unitType === 'nm' && target === 'Å') return 10;
        if (state.unitType === 'Å' && target === 'nm') return 0.1;
        return 1;
    }

    // Best-effort element symbol. Uses the PDB element column when present;
    // otherwise infers from the atom name. A two-letter token whose second
    // character is uppercase (e.g. "CA" = alpha carbon) is treated as a
    // one-letter element ("C"); "Cl", "Na", "Fe" keep both letters.
    function elementSymbol(a) {
        if (a.element) return a.element;
        const m = (a.atomName || '').match(/^([A-Za-z]{1,2})/);
        if (!m) return 'X';
        const s = m[1];
        if (s.length === 2 && s[1] === s[1].toUpperCase()) return s[0].toUpperCase();
        return s[0].toUpperCase() + (s[1] ? s[1].toLowerCase() : '');
    }

    function generateOutputString() {
        const format = exportFormat.value;
        const f = unitFactor(format);
        let out = "";

        if (format === 'xyz') {
            out += `${state.atoms.length}\n`;
            out += `Generated by STEMKit Coordinate Manipulator (units: Å)\n`;
            state.atoms.forEach(a => {
                const elem = elementSymbol(a);
                out += `${padStr(elem, 4, true)} ${padStr((a.x * f).toFixed(4), 12)} ${padStr((a.y * f).toFixed(4), 12)} ${padStr((a.z * f).toFixed(4), 12)}\n`;
            });
        }
        else if (format === 'pdb') {
            out += `REMARK   Generated by STEMKit Coordinate Manipulator (units: Angstrom)\n`;
            state.atoms.forEach((a, i) => {
                const serial = padStr((i + 1) % 100000, 5);
                const elem = elementSymbol(a);

                // PDB atom-name justification: names of 1–3 chars with a
                // one-letter element get a leading space (start at column 14).
                let nm = (a.atomName || '').substring(0, 4);
                let nameField;
                if (nm.length >= 4) nameField = nm;
                else if (elem.length === 1) nameField = padStr(' ' + nm, 4, true);
                else nameField = padStr(nm, 4, true);

                const rName = padStr(a.resName || 'UNK', 3);
                const chain = (a.chain && a.chain.length) ? a.chain[0] : 'A';
                const rSeq = padStr((a.resSeq || 1) % 10000, 4);
                const x = padStr((a.x * f).toFixed(3), 8);
                const y = padStr((a.y * f).toFixed(3), 8);
                const z = padStr((a.z * f).toFixed(3), 8);
                const occ = padStr((a.occupancy || '1.00'), 6);
                const temp = padStr((a.tempFactor || '0.00'), 6);
                const el = padStr(elem.toUpperCase(), 2);

                // Columns: record(6) serial(5) sp name(4) altLoc(1) resName(3) sp
                // chain(1) resSeq(4) iCode+blank(4) x(8)y(8)z(8) occ(6) temp(6)
                // blank(10) element(2)
                out += `ATOM  ${serial} ${nameField} ${rName} ${chain}${rSeq}    ${x}${y}${z}${occ}${temp}          ${el}\n`;
            });
            out += `END\n`;
        }
        else if (format === 'gro') {
            // GROMACS Gromos87 fixed format: %5i%5s%5s%5i%8.3f%8.3f%8.3f  (nm)
            out += `Generated by STEMKit Coordinate Manipulator\n`;
            out += `${state.atoms.length}\n`;
            state.atoms.forEach((a, i) => {
                const resSeq = padStr((a.resSeq || 1) % 100000, 5);
                const resName = padStr((a.resName || 'UNK').substring(0, 5), 5, true);
                const atomName = padStr((a.atomName || 'X').substring(0, 5), 5);
                const serial = padStr((i + 1) % 100000, 5);
                const x = padStr((a.x * f).toFixed(3), 8);
                const y = padStr((a.y * f).toFixed(3), 8);
                const z = padStr((a.z * f).toFixed(3), 8);
                out += `${resSeq}${resName}${atomName}${serial}${x}${y}${z}\n`;
            });

            // Box vectors (nm). Reuse the parsed box when available (already nm),
            // otherwise use the bounding box plus a small padding as a fallback.
            let bx, by, bz;
            if (state.sourceFormat === 'gro' && state.boxData.length >= 3) {
                [bx, by, bz] = state.boxData;
            } else {
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
                state.atoms.forEach(a => {
                    minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x);
                    minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y);
                    minZ = Math.min(minZ, a.z); maxZ = Math.max(maxZ, a.z);
                });
                const pad = 0.1; // fractional padding
                bx = (maxX - minX) * f * (1 + pad);
                by = (maxY - minY) * f * (1 + pad);
                bz = (maxZ - minZ) * f * (1 + pad);
            }
            out += `${padStr(bx.toFixed(5), 10)}${padStr(by.toFixed(5), 10)}${padStr(bz.toFixed(5), 10)}\n`;
        }

        return out;
    }

    function renderOutputBuffer() {
        coordOutput.textContent = generateOutputString();
    }

    exportFormat.addEventListener('change', () => { renderOutputBuffer(); updateExportUnitNote(); });

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
        showToast(`Downloaded ${filename}`);
    });

    // --- 7. Utilities ---
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
        if (code === "Awaiting structure array..." || !code.trim()) return;
        navigator.clipboard.writeText(code).then(() => {
            showToast('Coordinate array copied to clipboard!');
            const icon = btnCopyBuffer.querySelector('i');
            icon.className = 'fa-solid fa-check text-emerald-400';
            setTimeout(() => { icon.className = 'fa-regular fa-copy text-white'; }, 2000);
        });
    });
});
