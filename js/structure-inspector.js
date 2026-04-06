    document.addEventListener("DOMContentLoaded", () => {

    // ═══════════════════════════════════════════
    // 1. STATE
    // ═══════════════════════════════════════════
    let viewer = null, surfaceID = null, currentModelData = null, currentExtension = null;
    let axisShapes = [], isoShapes = [], measureShapes = [], measureLabels = [];
    let measureMode = false, measureAtoms = [], trajPlaying = false, trajInterval = null;
    let customElementColors = {};
    let totalAtomCount = 0;
    let systemBounds = { xMin:0, xMax:0, yMin:0, yMax:0, zMin:0, zMax:0 };

    const PERF_LABEL_WARN = 5000;   // show "(slow)" warning
    const PERF_LABEL_BLOCK = 50000; // refuse labels entirely

    const T = { atomLabels:false, resLabels:false, hydrogens:true, axis:false, spin:false, clickInspect:true, outline:false };

    const ElementColors = {
        H:'#FFFFFF',C:'#909090',O:'#FF0D0D',N:'#3050F8',S:'#FFFF30',P:'#FF8000',
        F:'#90E050',Cl:'#1FF01F',Br:'#A62929',I:'#940094',Fe:'#E06633',Ca:'#3DFF00',
        Na:'#AB5CF2',K:'#8F40D4',Mg:'#8AFF00',Zn:'#7D80B0',Cu:'#C88033',Mn:'#3DFF00'
    };
    const defaultAtomColor = '#cccccc';

    // ═══════════════════════════════════════════
    // 2. ELEMENT REFS
    // ═══════════════════════════════════════════
    const $ = id => document.getElementById(id);
    const uploadZone=$('uploadZone'), fileInput=$('fileInput'), workspace=$('workspace');
    const styleSelect=$('styleSelect'), colorSelect=$('colorSelect');
    const perElementColorContainer=$('perElementColorContainer');
    const selQuery=$('selQuery'), selStyle=$('selStyle'), applySelStyleBtn=$('applySelStyle'), clearSelStylesBtn=$('clearSelStyles');
    const centerBtn=$('centerBtn'), surfaceBtn=$('surfaceBtn'), surfaceType=$('surfaceType');
    const surfaceOpacity=$('surfaceOpacity'), surfaceOpacityVal=$('surfaceOpacityVal');
    const surfaceColorScheme=$('surfaceColorScheme'), surfaceCustomColor=$('surfaceCustomColor');
    const slabNear=$('slabNear'), slabFar=$('slabFar'), slabNearVal=$('slabNearVal'), slabFarVal=$('slabFarVal'), resetSlab=$('resetSlab');
    const bgSelect=$('bgSelect'), resetBtn=$('resetBtn');
    const downloadBtn=$('downloadBtn'), exportQuality=$('exportQuality');
    const axisBtns=document.querySelectorAll('.axis-btn'), viewerCanvas=$('viewerCanvas');
    const atomInfoEl=$('atomInfo'), measureInfo=$('measureInfo'), modeBadge=$('modeBadge');
    const isoPanel=$('isoPanel'), isoPosVal=$('isoPosVal'), isoNegVal=$('isoNegVal'), isoOpacity=$('isoOpacity');
    const isoPosDisplay=$('isoPosDisplay'), isoNegDisplay=$('isoNegDisplay'), isoOpacityDisplay=$('isoOpacityDisplay');
    const applyIsoBtn=$('applyIso'), clearIsoBtn=$('clearIso');
    const measureModeBtn=$('measureModeBtn'), clearMeasuresBtn=$('clearMeasures');
    const focusQuery=$('focusQuery'), focusBtn=$('focusBtn'), isolateBtn=$('isolateBtn');
    const trajectoryPanel=$('trajectoryPanel'), trajSlider=$('trajSlider'), trajFrame=$('trajFrame');
    const trajPrev=$('trajPrev'), trajPlay=$('trajPlay'), trajNext=$('trajNext'), trajSpeed=$('trajSpeed');
    const pdbIdInput=$('pdbIdInput'), fetchPdbBtn=$('fetchPdbBtn');
    const perfWarning=$('perfWarning'), perfWarningText=$('perfWarningText');

    const toggleEls = {
        atomLabels:$('toggleAtomLabels'), resLabels:$('toggleResLabels'), hydrogens:$('toggleHydrogens'),
        axis:$('toggleAxis'), spin:$('toggleSpin'), clickInspect:$('toggleClickInspect'), outline:$('toggleOutline')
    };

    // Spatial controls
    const spatialMode=$('spatialMode'), spatialAxis=$('spatialAxis');
    const spatialControls=$('spatialControls');
    const spatialRangeControls=$('spatialRangeControls'), spatialCenterControls=$('spatialCenterControls'), spatialSurfaceControls=$('spatialSurfaceControls');
    const spatialFrom=$('spatialFrom'), spatialTo=$('spatialTo');
    const spatialFromVal=$('spatialFromVal'), spatialToVal=$('spatialToVal');
    const spatialCenter=$('spatialCenter'), spatialWidth=$('spatialWidth');
    const spatialCenterVal=$('spatialCenterVal'), spatialWidthVal=$('spatialWidthVal');
    const spatialDepth=$('spatialDepth'), spatialDepthVal=$('spatialDepthVal');
    const spatialUnit=$('spatialUnit');

    // Cross-axis width clamp refs
    const enableCrossAxis=$('enableCrossAxis'), crossAxisControls=$('crossAxisControls');
    const crossA_from=$('crossA_from'), crossA_to=$('crossA_to');
    const crossA_fromVal=$('crossA_fromVal'), crossA_toVal=$('crossA_toVal');
    const crossA_label=$('crossA_label'), crossA_toLabel=$('crossA_toLabel');
    const crossB_from=$('crossB_from'), crossB_to=$('crossB_to');
    const crossB_fromVal=$('crossB_fromVal'), crossB_toVal=$('crossB_toVal');
    const crossB_label=$('crossB_label'), crossB_toLabel=$('crossB_toLabel');
    const crossAxisLabel=$('crossAxisLabel');

    // ═══════════════════════════════════════════
    // 3. FORMAT MAP
    // ═══════════════════════════════════════════
    const FM = {
        '.pdb':{f:'pdb',l:'PDB',b:false},'.ent':{f:'pdb',l:'PDB (ENT)',b:false},
        '.sdf':{f:'sdf',l:'SDF',b:false},'.mol':{f:'sdf',l:'MOL',b:false},
        '.mol2':{f:'mol2',l:'MOL2',b:false},'.xyz':{f:'xyz',l:'XYZ',b:false},
        '.cif':{f:'cif',l:'CIF',b:false},'.mcif':{f:'cif',l:'mmCIF',b:false},
        '.cdjson':{f:'cdjson',l:'CDJSON',b:false},'.json':{f:'cdjson',l:'CDJSON',b:false},
        '.mmtf':{f:'mmtf',l:'MMTF',b:true},'.prmtop':{f:'prmtop',l:'PRMTOP',b:false},
        '.gro':{f:'gro',l:'GRO',b:false},'.pqr':{f:'pqr',l:'PQR',b:false},
        '.cube':{f:'cube',l:'CUBE',b:false},'.vasp':{f:'vasp',l:'VASP',b:false},
        '.poscar':{f:'vasp',l:'POSCAR',b:false},'.contcar':{f:'vasp',l:'CONTCAR',b:false}
    };

    // ═══════════════════════════════════════════
    // 4. HELPERS
    // ═══════════════════════════════════════════
    function setupToggle(el, key, fn) {
        if (!el) return;
        el.addEventListener('click', () => {
            T[key]=!T[key]; el.classList.toggle('active',T[key]);
            el.setAttribute('aria-checked',T[key]); if(fn) fn(T[key]);
        });
        el.addEventListener('keydown', e => { if(e.key===' '||e.key==='Enter'){e.preventDefault();el.click()} });
    }

    function showToast(msg,type='info') {
        const c=$('toastContainer'), t=document.createElement('div');
        const cls = type==='success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800'
                  : type==='error'   ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800'
                  : 'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800';
        const ico = type==='success' ? 'fa-check-circle' : type==='error' ? 'fa-triangle-exclamation' : 'fa-info-circle';
        t.className = `px-4 py-3 rounded-xl border shadow-lg text-sm font-medium ${cls}`;
        t.style.animation = 'slideIn .3s forwards';
        t.innerHTML = `<i class="fa-solid ${ico} mr-2"></i>${msg}`;
        c.appendChild(t);
        setTimeout(() => { t.style.opacity='0'; setTimeout(() => t.remove(), 300) }, 3000);
    }

    function getBackgroundColor() {
        const v = bgSelect.value;
        if(v==='black') return '#000'; if(v==='white') return '#fff'; if(v==='grey') return '#64748b';
        return document.documentElement.classList.contains('dark') ? '#020617' : '#f8fafc';
    }

    function applyBackground() { if(viewer){ viewer.setBackgroundColor(getBackgroundColor()); viewer.render() } }
    function baseName() { return ($('fileName').innerText||'structure').replace(/\.[^.]+$/,'') }

    function populateDropdown(selectEl, items, defaultText) {
        if (!selectEl) return;
        selectEl.innerHTML = `<option value="">${defaultText}</option>`;
        items.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item; opt.innerText = item;
            selectEl.appendChild(opt);
        });
    }

    function formatNum(n) { return n.toLocaleString(); }

    function getUnitMultiplier() {
        return spatialUnit.value === 'nm' ? 10.0 : 1.0;
    }

    function getAxisBounds(axis) {
        if (axis === 'x') return { min: systemBounds.xMin, max: systemBounds.xMax };
        if (axis === 'y') return { min: systemBounds.yMin, max: systemBounds.yMax };
        return { min: systemBounds.zMin, max: systemBounds.zMax };
    }

    // ═══════════════════════════════════════════
    // 5. PERFORMANCE WARNINGS
    // ═══════════════════════════════════════════
    function updatePerfWarnings() {
        const atomWarn = $('atomLabelWarn');
        const resWarn = $('resLabelWarn');
        const labelLimitRow = $('labelLimitRow');

        if (totalAtomCount > PERF_LABEL_BLOCK) {
            perfWarning.classList.remove('hidden');
            perfWarningText.textContent = `${formatNum(totalAtomCount)} atoms — labels disabled to prevent browser freeze.`;
            if(atomWarn) atomWarn.classList.remove('hidden');
            if(resWarn) resWarn.classList.remove('hidden');
            if(atomWarn) atomWarn.textContent = '(disabled)';
            if(resWarn) resWarn.textContent = '(disabled)';
        } else if (totalAtomCount > PERF_LABEL_WARN) {
            perfWarning.classList.remove('hidden');
            perfWarningText.textContent = `${formatNum(totalAtomCount)} atoms — labels may cause lag. Limit adjustable below.`;
            if(atomWarn) { atomWarn.classList.remove('hidden'); atomWarn.textContent = '(may lag)'; }
            if(resWarn) { resWarn.classList.remove('hidden'); resWarn.textContent = '(may lag)'; }
            if(labelLimitRow) labelLimitRow.classList.remove('hidden');
        } else {
            perfWarning.classList.add('hidden');
            if(atomWarn) atomWarn.classList.add('hidden');
            if(resWarn) resWarn.classList.add('hidden');
            if(labelLimitRow) labelLimitRow.classList.add('hidden');
        }
    }

    const labelLimit = $('labelLimit');
    const labelLimitVal = $('labelLimitVal');
    if (labelLimit) {
        labelLimit.addEventListener('input', () => {
            labelLimitVal.textContent = formatNum(parseInt(labelLimit.value));
            if (T.atomLabels || T.resLabels) updateLabels();
        });
    }

    // ═══════════════════════════════════════════
    // 6. SPATIAL MODE CONTROLS
    // ═══════════════════════════════════════════
    function getCrossAxes(primaryAxis) {
        if (primaryAxis === 'x') return ['y', 'z'];
        if (primaryAxis === 'y') return ['x', 'z'];
        return ['x', 'y']; // z is primary
    }

    function updateCrossAxisSliders() {
        const axis = spatialAxis.value;
        const [axA, axB] = getCrossAxes(axis);
        const mult = getUnitMultiplier();
        const unit = spatialUnit.value === 'nm' ? 'nm' : 'Å';

        const boundsA = getAxisBounds(axA);
        const boundsB = getAxisBounds(axB);
        const minA = boundsA.min / mult, maxA = boundsA.max / mult;
        const minB = boundsB.min / mult, maxB = boundsB.max / mult;
        const rangeA = maxA - minA, rangeB = maxB - minB;
        const stepA = rangeA > 100 ? 1 : rangeA > 10 ? 0.1 : 0.01;
        const stepB = rangeB > 100 ? 1 : rangeB > 10 ? 0.1 : 0.01;

        // Labels
        crossA_label.textContent = axA.toUpperCase() + ' from';
        crossA_toLabel.textContent = axA.toUpperCase() + ' to';
        crossB_label.textContent = axB.toUpperCase() + ' from';
        crossB_toLabel.textContent = axB.toUpperCase() + ' to';
        crossAxisLabel.textContent = `${axA.toUpperCase()} & ${axB.toUpperCase()} width clamp`;

        // Axis A sliders
        crossA_from.min = minA; crossA_from.max = maxA; crossA_from.step = stepA;
        crossA_to.min = minA; crossA_to.max = maxA; crossA_to.step = stepA;
        crossA_from.value = minA; crossA_to.value = maxA;
        crossA_fromVal.textContent = minA.toFixed(1) + ' ' + unit;
        crossA_toVal.textContent = maxA.toFixed(1) + ' ' + unit;

        // Axis B sliders
        crossB_from.min = minB; crossB_from.max = maxB; crossB_from.step = stepB;
        crossB_to.min = minB; crossB_to.max = maxB; crossB_to.step = stepB;
        crossB_from.value = minB; crossB_to.value = maxB;
        crossB_fromVal.textContent = minB.toFixed(1) + ' ' + unit;
        crossB_toVal.textContent = maxB.toFixed(1) + ' ' + unit;
    }

    function updateSpatialSliders() {
        const axis = spatialAxis.value;
        const bounds = getAxisBounds(axis);
        const mult = getUnitMultiplier();
        const min = bounds.min / mult;
        const max = bounds.max / mult;
        const range = max - min;
        const step = range > 100 ? 1 : range > 10 ? 0.1 : 0.01;
        const unit = spatialUnit.value === 'nm' ? 'nm' : 'Å';

        // Range sliders
        spatialFrom.min = min; spatialFrom.max = max; spatialFrom.step = step;
        spatialTo.min = min; spatialTo.max = max; spatialTo.step = step;
        spatialFrom.value = min; spatialTo.value = max;
        spatialFromVal.textContent = min.toFixed(1) + ' ' + unit;
        spatialToVal.textContent = max.toFixed(1) + ' ' + unit;

        // Center slider
        spatialCenter.min = min; spatialCenter.max = max; spatialCenter.step = step;
        spatialCenter.value = ((min + max) / 2).toFixed(1);
        spatialCenterVal.textContent = spatialCenter.value + ' ' + unit;
        spatialWidth.min = step; spatialWidth.max = (range / 2).toFixed(1); spatialWidth.step = step;
        spatialWidth.value = Math.min(5 / mult, range / 4).toFixed(1);
        spatialWidthVal.textContent = spatialWidth.value + ' ' + unit;

        // Surface depth
        spatialDepth.min = step; spatialDepth.max = (range / 2).toFixed(1); spatialDepth.step = step;
        spatialDepth.value = Math.min(5 / mult, range / 4).toFixed(1);
        spatialDepthVal.textContent = spatialDepth.value + ' ' + unit;

        // Cross-axis sliders
        updateCrossAxisSliders();
    }

    spatialMode.addEventListener('change', () => {
        const mode = spatialMode.value;
        spatialControls.classList.toggle('hidden', !mode);
        spatialRangeControls.classList.add('hidden');
        spatialCenterControls.classList.add('hidden');
        spatialSurfaceControls.classList.add('hidden');

        if (mode === 'range') spatialRangeControls.classList.remove('hidden');
        else if (mode === 'center') spatialCenterControls.classList.remove('hidden');
        else if (mode === 'top' || mode === 'bottom') spatialSurfaceControls.classList.remove('hidden');

        if (mode) updateSpatialSliders();
        autoIsolateIfNeeded();
    });

    spatialAxis.addEventListener('change', () => {
        if (spatialMode.value) updateSpatialSliders();
        autoIsolateIfNeeded();
    });

    spatialUnit.addEventListener('change', () => {
        if (spatialMode.value) updateSpatialSliders();
    });

    // Slider real-time updates
    [spatialFrom, spatialTo].forEach(el => el.addEventListener('input', () => {
        const unit = spatialUnit.value === 'nm' ? 'nm' : 'Å';
        spatialFromVal.textContent = parseFloat(spatialFrom.value).toFixed(1) + ' ' + unit;
        spatialToVal.textContent = parseFloat(spatialTo.value).toFixed(1) + ' ' + unit;
        autoIsolateIfNeeded();
    }));

    [spatialCenter, spatialWidth].forEach(el => el.addEventListener('input', () => {
        const unit = spatialUnit.value === 'nm' ? 'nm' : 'Å';
        spatialCenterVal.textContent = parseFloat(spatialCenter.value).toFixed(1) + ' ' + unit;
        spatialWidthVal.textContent = parseFloat(spatialWidth.value).toFixed(1) + ' ' + unit;
        autoIsolateIfNeeded();
    }));

    spatialDepth.addEventListener('input', () => {
        const unit = spatialUnit.value === 'nm' ? 'nm' : 'Å';
        spatialDepthVal.textContent = parseFloat(spatialDepth.value).toFixed(1) + ' ' + unit;
        autoIsolateIfNeeded();
    });

    // Cross-axis toggle
    enableCrossAxis.addEventListener('change', () => {
        crossAxisControls.classList.toggle('hidden', !enableCrossAxis.checked);
        if (enableCrossAxis.checked) updateCrossAxisSliders();
        autoIsolateIfNeeded();
    });

    // Cross-axis slider real-time updates
    [crossA_from, crossA_to, crossB_from, crossB_to].forEach(el => el.addEventListener('input', () => {
        const unit = spatialUnit.value === 'nm' ? 'nm' : 'Å';
        crossA_fromVal.textContent = parseFloat(crossA_from.value).toFixed(1) + ' ' + unit;
        crossA_toVal.textContent = parseFloat(crossA_to.value).toFixed(1) + ' ' + unit;
        crossB_fromVal.textContent = parseFloat(crossB_from.value).toFixed(1) + ' ' + unit;
        crossB_toVal.textContent = parseFloat(crossB_to.value).toFixed(1) + ' ' + unit;
        autoIsolateIfNeeded();
    }));

    function autoIsolateIfNeeded() {
        const autoUpdate = $('autoUpdateView');
        if (autoUpdate && autoUpdate.checked) {
            executeGuiSelection('isolate');
        }
    }

    // ═══════════════════════════════════════════
    // 7. SELECTION PARSING
    // ═══════════════════════════════════════════
    function parseSelString(s) {
        const sel = {};
        if(!s.trim()) return sel;

        const spatialConditions = [];
        const queryUnit = $('queryUnit');
        const unitMult = queryUnit && queryUnit.value === 'nm' ? 10.0 : 1.0;

        s.trim().split(/\s+/).forEach(tok => {
            const idx = tok.indexOf(':');
            if(idx === -1) return;
            const k = tok.substring(0, idx);
            const v = tok.substring(idx + 1);

            if(k === 'chain') sel.chain = v;
            else if(k === 'resn') sel.resn = v;
            else if(k === 'resi') {
                const m = v.match(/^(\d+)-(\d+)$/);
                if(m) sel.resi = [parseInt(m[1]), parseInt(m[2])];
                else sel.resi = isNaN(v) ? v : parseInt(v);
            }
            else if(k === 'elem') sel.elem = v;
            else if(k === 'atom') sel.atom = v;
            else if(k === 'ss') sel.ss = v;
            else if(k === 'x' || k === 'y' || k === 'z') {
                let op = '', rawVal = 0;
                if (v.startsWith('>='))      { op = '>='; rawVal = parseFloat(v.slice(2)); }
                else if (v.startsWith('<=')) { op = '<='; rawVal = parseFloat(v.slice(2)); }
                else if (v.startsWith('>'))  { op = '>'; rawVal = parseFloat(v.slice(1)); }
                else if (v.startsWith('<'))  { op = '<'; rawVal = parseFloat(v.slice(1)); }
                else                         { op = '==='; rawVal = parseFloat(v); }
                spatialConditions.push({ axis: k, op, val: rawVal * unitMult });
            }
            else sel[k] = v;
        });

        if (spatialConditions.length > 0) {
            sel.predicate = function(atom) {
                return spatialConditions.every(cond => {
                    if (cond.op === '>=') return atom[cond.axis] >= cond.val;
                    if (cond.op === '<=') return atom[cond.axis] <= cond.val;
                    if (cond.op === '>') return atom[cond.axis] > cond.val;
                    if (cond.op === '<') return atom[cond.axis] < cond.val;
                    return Math.abs(atom[cond.axis] - cond.val) < 0.001;
                });
            };
        }
        return sel;
    }

    // ═══════════════════════════════════════════
    // 8. INTERACTIVE SELECTION BUILDER
    // ═══════════════════════════════════════════
    function buildSpatialPredicate() {
        const mode = spatialMode.value;
        if (!mode) return null;

        const axis = spatialAxis.value;
        const mult = getUnitMultiplier();
        const bounds = getAxisBounds(axis);

        let lo, hi;

        if (mode === 'range') {
            lo = parseFloat(spatialFrom.value) * mult;
            hi = parseFloat(spatialTo.value) * mult;
            if (lo > hi) { const tmp = lo; lo = hi; hi = tmp; }
        } else if (mode === 'center') {
            const c = parseFloat(spatialCenter.value) * mult;
            const w = parseFloat(spatialWidth.value) * mult;
            lo = c - w; hi = c + w;
        } else if (mode === 'top') {
            const depth = parseFloat(spatialDepth.value) * mult;
            lo = bounds.max - depth; hi = bounds.max + 1;
        } else if (mode === 'bottom') {
            const depth = parseFloat(spatialDepth.value) * mult;
            lo = bounds.min - 1; hi = bounds.min + depth;
        }

        // Cross-axis width clamp
        const useCross = enableCrossAxis.checked;
        let crossALo, crossAHi, crossBLo, crossBHi, axA, axB;
        if (useCross) {
            [axA, axB] = getCrossAxes(axis);
            crossALo = parseFloat(crossA_from.value) * mult;
            crossAHi = parseFloat(crossA_to.value) * mult;
            if (crossALo > crossAHi) { const t = crossALo; crossALo = crossAHi; crossAHi = t; }
            crossBLo = parseFloat(crossB_from.value) * mult;
            crossBHi = parseFloat(crossB_to.value) * mult;
            if (crossBLo > crossBHi) { const t = crossBLo; crossBLo = crossBHi; crossBHi = t; }
        }

        return function(atom) {
            const primaryOk = atom[axis] >= lo && atom[axis] <= hi;
            if (!primaryOk) return false;
            if (!useCross) return true;
            return atom[axA] >= crossALo && atom[axA] <= crossAHi
                && atom[axB] >= crossBLo && atom[axB] <= crossBHi;
        };
    }

    function executeGuiSelection(action) {
        if (!viewer) return;

        const resn = $('buildResn') ? $('buildResn').value : '';
        const elem = $('buildElem') ? $('buildElem').value : '';
        const chain = $('buildChain') ? $('buildChain').value : '';

        let selObj = {};
        if (resn) selObj.resn = resn;
        if (elem) selObj.elem = elem;
        if (chain) selObj.chain = chain;

        const spatialPred = buildSpatialPredicate();

        if (spatialPred) {
            const baseKeys = Object.keys(selObj);
            if (baseKeys.length > 0) {
                // Combine spatial with attribute filters
                selObj.predicate = function(atom) {
                    return spatialPred(atom);
                };
            } else {
                selObj.predicate = spatialPred;
            }
        }

        // Count matching atoms
        const matchedAtoms = viewer.getModel().selectedAtoms(selObj);
        const countEl = $('selectionCount');
        const countText = $('selCountText');
        if (countEl && countText) {
            countEl.classList.remove('hidden');
            countText.textContent = `${formatNum(matchedAtoms.length)} atom${matchedAtoms.length !== 1 ? 's' : ''} selected`;
        }

        if (action === 'isolate') {
            viewer.setStyle({}, { hidden: true });
            viewer.setStyle(selObj, buildStyleObj(styleSelect.value, getColorObj()));
        }

        if (action === 'zoom' || action === 'isolate') {
            viewer.zoomTo(selObj);
        }

        viewer.render();
    }

    // ═══════════════════════════════════════════
    // 9. TABS & THEME
    // ═══════════════════════════════════════════
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
            btn.classList.add('active');
            const panel = $(btn.dataset.tab);
            if(panel) panel.classList.remove('hidden');
        });
    });

    document.querySelectorAll('.themeToggle').forEach(b => b.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        if(bgSelect.value === 'theme') applyBackground();
    }));

    // Mobile menu
    const mmb = $('mobile-menu-btn'), mm = $('mobile-menu'), mi = $('menu-icon');
    if(mmb) {
        mmb.addEventListener('click', () => {
            mm.classList.toggle('hidden');
            mi.classList.toggle('fa-bars');
            mi.classList.toggle('fa-xmark');
        });
        document.querySelectorAll('.mobile-link').forEach(l => l.addEventListener('click', () => {
            mm.classList.add('hidden'); mi.classList.add('fa-bars'); mi.classList.remove('fa-xmark');
        }));
    }

    // ═══════════════════════════════════════════
    // 10. FILE UPLOAD
    // ═══════════════════════════════════════════
    ['dragenter','dragover','dragleave','drop'].forEach(e =>
        uploadZone.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation() }, false));
    uploadZone.addEventListener('dragover', () => uploadZone.classList.add('border-indigo-500'));
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('border-indigo-500'));
    uploadZone.addEventListener('drop', e => { uploadZone.classList.remove('border-indigo-500'); handleFile(e.dataTransfer.files[0]) });
    uploadZone.addEventListener('click', e => {
        if(e.target.closest('#pdbIdInput') || e.target.closest('#fetchPdbBtn')) return;
        fileInput.click();
    });
    fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

    function handleFile(file) {
        if(!file) return;
        const fn = file.name.toLowerCase();
        const m = Object.entries(FM).find(([ext]) => fn.endsWith(ext));
        if(!m) { showToast('Format not supported.', 'error'); return; }

        const [, info] = m;
        currentExtension = info.f;
        $('fileName').innerText = file.name;
        $('formatBadge').innerText = info.l;
        showToast('Loading...', 'info');

        const r = new FileReader();
        if(info.b) {
            r.onload = e => { currentModelData = new Uint8Array(e.target.result); initViewer(); };
            r.readAsArrayBuffer(file);
        } else {
            r.onload = e => { currentModelData = e.target.result; initViewer(); };
            r.readAsText(file);
        }
    }

    fetchPdbBtn.addEventListener('click', async () => {
        const id = pdbIdInput.value.trim().toUpperCase();
        if(!id || id.length < 4) { showToast('Enter a valid 4-character PDB ID.', 'error'); return; }

        showToast(`Fetching ${id} from RCSB...`, 'info');
        currentExtension = 'pdb';
        $('fileName').innerText = id + '.pdb';
        $('formatBadge').innerText = 'PDB — RCSB Fetch';

        uploadZone.classList.add('hidden');
        workspace.classList.remove('hidden');
        workspace.classList.add('flex');

        if(viewer) { viewer.clear(); }
        else { viewer = $3Dmol.createViewer(viewerCanvas, { backgroundColor: getBackgroundColor() }); }

        try {
            const res = await fetch(`https://files.rcsb.org/download/${id}.pdb`);
            if(!res.ok) throw new Error('Not found');
            currentModelData = await res.text();
            initViewer();
        } catch(e) {
            console.error(e);
            showToast(`Failed to fetch ${id}. Check the ID and try again.`, 'error');
        }
    });

    // ═══════════════════════════════════════════
    // 11. VIEWER INIT
    // ═══════════════════════════════════════════
    function initViewer() {
        uploadZone.classList.add('hidden');
        workspace.classList.remove('hidden');
        workspace.classList.add('flex');

        if(viewer) { viewer.clear() }
        else { viewer = $3Dmol.createViewer(viewerCanvas, { backgroundColor: getBackgroundColor() }); }

        try {
            viewer.addModel(currentModelData, currentExtension, { multimodel: true, frames: true, keepH: true });
            afterModelLoaded();
            showToast('Structure rendered.', 'success');
        } catch(e) {
            console.error(e);
            showToast('Error parsing file.', 'error');
        }
    }

    function afterModelLoaded() {
        const atoms = viewer.getModel().selectedAtoms({});
        totalAtomCount = atoms.length;

        const elems = new Set(), chains = new Set(), residues = new Set();
        let xMin=Infinity, xMax=-Infinity, yMin=Infinity, yMax=-Infinity, zMin=Infinity, zMax=-Infinity;

        for (const a of atoms) {
            if(a.elem) elems.add(a.elem);
            if(a.chain) chains.add(a.chain);
            if(a.resn) residues.add(a.resn);
            if(a.x < xMin) xMin = a.x; if(a.x > xMax) xMax = a.x;
            if(a.y < yMin) yMin = a.y; if(a.y > yMax) yMax = a.y;
            if(a.z < zMin) zMin = a.z; if(a.z > zMax) zMax = a.z;
        }

        systemBounds = { xMin, xMax, yMin, yMax, zMin, zMax };

        let meta = `${formatNum(atoms.length)} Atoms`;
        if (elems.size > 0) meta += ` · ${elems.size} Elem`;
        if (chains.size > 1) meta += ` · ${chains.size} Chains`;
        if (residues.size > 0) meta += ` · ${residues.size} Res types`;
        $('structureMeta').innerText = meta;

        populateDropdown($('buildResn'), Array.from(residues).sort(), "All Residues");
        populateDropdown($('buildElem'), Array.from(elems).sort(), "All Elements");
        populateDropdown($('buildChain'), Array.from(chains).sort(), "All Chains");

        // Also populate the selection styling dropdowns
        populateDropdown($('selChain'), Array.from(chains).sort(), "All Chains");
        populateDropdown($('selElem'), Array.from(elems).sort(), "All Elements");
        populateDropdown($('selResn'), Array.from(residues).sort(), "All Residues");

        buildPerElementColorUI(Array.from(elems).sort());
        updatePerfWarnings();

        isoPanel.classList.toggle('hidden', currentExtension !== 'cube');

        const nFrames = viewer.getModel().getNumFrames();
        if (nFrames > 1) {
            trajectoryPanel.classList.remove('hidden');
            trajSlider.max = nFrames - 1;
            trajSlider.value = 0;
            trajFrame.textContent = `1/${nFrames}`;
        } else {
            trajectoryPanel.classList.add('hidden');
        }

        // Reset spatial controls
        spatialMode.value = '';
        spatialControls.classList.add('hidden');
        enableCrossAxis.checked = false;
        crossAxisControls.classList.add('hidden');

        // Reset selection count
        const countEl = $('selectionCount');
        if(countEl) countEl.classList.add('hidden');

        applyStyles();
        applyBackground();
        setupClickInspect();
        viewer.zoomTo();
        viewer.render();
    }

    // ═══════════════════════════════════════════
    // 12. STYLES & COLORS
    // ═══════════════════════════════════════════
    function buildPerElementColorUI(elements) {
        perElementColorContainer.innerHTML = '<div class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 sticky top-0 bg-slate-50 dark:bg-slate-900/50 z-10 pb-1">Per-Element Colors</div>';
        customElementColors = {};

        elements.forEach(el => {
            const defCol = ElementColors[el] || defaultAtomColor;
            customElementColors[el] = defCol;

            const row = document.createElement('div');
            row.className = 'flex items-center justify-between gap-2';

            const label = document.createElement('span');
            label.className = 'text-[11px] font-mono font-bold text-slate-700 dark:text-slate-300 w-8';
            label.innerText = el;

            const picker = document.createElement('input');
            picker.type = 'color'; picker.value = defCol;
            picker.className = 'w-6 h-6 rounded cursor-pointer border-0 p-0 flex-grow bg-transparent';

            const defBtn = document.createElement('button');
            defBtn.className = 'sidebar-btn px-2 py-1 text-[9px] font-bold';
            defBtn.innerText = 'Reset';

            picker.addEventListener('input', e => { customElementColors[el] = e.target.value; applyStyles(); });
            defBtn.addEventListener('click', () => { picker.value = defCol; customElementColors[el] = defCol; applyStyles(); });

            row.appendChild(label); row.appendChild(picker); row.appendChild(defBtn);
            perElementColorContainer.appendChild(row);
        });
    }

    function getColorObj() {
        const c = colorSelect.value;
        if(c==='element') return {colorscheme:'Jmol'};
        if(c==='chain') return {colorscheme:'chain'};
        if(c==='residue') return {colorscheme:'amino'};
        if(c==='bFactor') return {colorscheme:'bFactor'};
        if(c==='spectrum') return {color:'spectrum'};
        if(c==='ss') return {colorscheme:'ssJmol'};
        return {};
    }

    function buildStyleObj(type, colObj) {
        if(type==='stick') return {stick:{radius:.15,...colObj}};
        if(type==='ballstick') return {stick:{radius:.12,...colObj},sphere:{scale:.25,...colObj}};
        if(type==='sphere') return {sphere:{...colObj}};
        if(type==='cross') return {cross:{linewidth:2,...colObj}};
        if(type==='line') return {line:{...colObj}};
        if(type==='cartoon') return {cartoon:{...colObj},stick:{radius:.08,...colObj}};
        if(type==='hidden') return {};
        return {stick:{radius:.15,...colObj}};
    }

    function applyStyles() {
        if(!viewer) return;
        const styleType = styleSelect.value;
        const colorMode = colorSelect.value;

        if (colorMode === 'custom') {
            viewer.setStyle({}, { hidden: true });
            for (const [el, col] of Object.entries(customElementColors)) {
                viewer.addStyle({elem: el}, buildStyleObj(styleType, {color: col}));
            }
        } else {
            viewer.setStyle({}, buildStyleObj(styleType, getColorObj()));
        }

        if(!T.hydrogens) viewer.setStyle({elem:'H'}, {hidden:true});
        viewer.render();
    }

    colorSelect.addEventListener('change', () => {
        perElementColorContainer.classList.toggle('hidden', colorSelect.value !== 'custom');
        applyStyles();
    });
    styleSelect.addEventListener('change', applyStyles);
    bgSelect.addEventListener('change', applyBackground);

    // Selection styling advanced toggle
    const selAdvancedToggle = $('selAdvancedToggle');
    const selAdvancedPanel = $('selAdvancedPanel');
    const selAdvancedIcon = $('selAdvancedIcon');
    if (selAdvancedToggle) {
        selAdvancedToggle.addEventListener('click', () => {
            selAdvancedPanel.classList.toggle('hidden');
            selAdvancedIcon.style.transform = selAdvancedPanel.classList.contains('hidden') ? '' : 'rotate(180deg)';
        });
    }

    // Build selection object from dropdowns or text query
    function buildSelStyleSelection() {
        // If advanced text query has content, use it (override)
        const textQuery = selQuery.value.trim();
        if (textQuery) return parseSelString(textQuery);

        // Otherwise build from dropdowns
        const sel = {};
        const chain = $('selChain') ? $('selChain').value : '';
        const elem = $('selElem') ? $('selElem').value : '';
        const resn = $('selResn') ? $('selResn').value : '';
        if (chain) sel.chain = chain;
        if (elem) sel.elem = elem;
        if (resn) sel.resn = resn;
        return sel;
    }

    applySelStyleBtn.addEventListener('click', () => {
        if(!viewer) return;
        const sel = buildSelStyleSelection();
        const sType = selStyle.value;

        if (sType === 'hidden') {
            viewer.addStyle(sel, {hidden: true});
        } else if (colorSelect.value === 'custom') {
            for (const [el, col] of Object.entries(customElementColors)) {
                viewer.addStyle({...sel, elem: el}, buildStyleObj(sType, {color: col}));
            }
        } else {
            viewer.addStyle(sel, buildStyleObj(sType, getColorObj()));
        }
        viewer.render();
        showToast('Selection style applied.', 'success');
    });

    clearSelStylesBtn.addEventListener('click', () => { applyStyles(); showToast('Selection styles cleared.') });

    // ═══════════════════════════════════════════
    // 13. LABELS
    // ═══════════════════════════════════════════
    function updateLabels() {
        if(!viewer) return;
        viewer.removeAllLabels();

        // Re-add measurement labels
        measureLabels.forEach(lbl => viewer.addLabel(lbl.text, lbl.options));

        const maxLabels = parseInt(labelLimit ? labelLimit.value : 2000);

        if (T.atomLabels && totalAtomCount <= PERF_LABEL_BLOCK) {
            const atoms = viewer.getModel().selectedAtoms({});
            const cap = Math.min(atoms.length, maxLabels);
            for(let i = 0; i < cap; i++) {
                const a = atoms[i];
                if(!T.hydrogens && a.elem === 'H') continue;
                viewer.addLabel(a.elem, {
                    position:{x:a.x,y:a.y,z:a.z}, fontSize:10, fontColor:'white',
                    backgroundColor:'rgba(30,41,59,.7)', backgroundOpacity:.7,
                    borderRadius:4, padding:1, showBackground:true, inFront:true
                });
            }
            if(atoms.length > cap) showToast(`Labels capped at ${formatNum(cap)}/${formatNum(atoms.length)}.`);
        } else if (T.atomLabels && totalAtomCount > PERF_LABEL_BLOCK) {
            showToast(`${formatNum(totalAtomCount)} atoms — atom labels disabled to protect performance.`, 'error');
        }

        if (T.resLabels && totalAtomCount <= PERF_LABEL_BLOCK) {
            const atoms = viewer.getModel().selectedAtoms({});
            const rm = new Map();
            atoms.forEach(a => {
                const k = `${a.chain||''}_${a.resn||''}_${a.resi||''}`;
                if(!rm.has(k)) rm.set(k, a);
                if(a.atom === 'CA') rm.set(k, a);
            });
            let count = 0;
            rm.forEach(a => {
                if(count >= maxLabels) return;
                viewer.addLabel(`${a.resn||'?'}${a.resi||''}`, {
                    position:{x:a.x,y:a.y,z:a.z}, fontSize:9, fontColor:'#c7d2fe',
                    backgroundColor:'rgba(67,56,202,.75)', backgroundOpacity:.75,
                    borderRadius:4, padding:2, showBackground:true, inFront:true
                });
                count++;
            });
            if(rm.size > maxLabels) showToast(`Residue labels capped at ${formatNum(maxLabels)}/${formatNum(rm.size)}.`);
        } else if (T.resLabels && totalAtomCount > PERF_LABEL_BLOCK) {
            showToast(`${formatNum(totalAtomCount)} atoms — residue labels disabled to protect performance.`, 'error');
        }

        viewer.render();
    }

    // ═══════════════════════════════════════════
    // 14. AXIS INDICATOR
    // ═══════════════════════════════════════════
    function drawAxisIndicator() {
        removeAxisIndicator(); if(!viewer || !T.axis) return;
        const atoms = viewer.getModel().selectedAtoms({}); if(!atoms.length) return;
        let mx=Infinity, my=Infinity, mz=Infinity;
        atoms.forEach(a => { mx=Math.min(mx,a.x); my=Math.min(my,a.y); mz=Math.min(mz,a.z) });
        const ox=mx-6, oy=my-6, oz=mz-6, len=4;
        [{d:{x:len,y:0,z:0},c:'#ef4444',l:'X'},{d:{x:0,y:len,z:0},c:'#22c55e',l:'Y'},{d:{x:0,y:0,z:len},c:'#3b82f6',l:'Z'}].forEach(({d,c,l}) => {
            axisShapes.push(viewer.addArrow({start:{x:ox,y:oy,z:oz},end:{x:ox+d.x,y:oy+d.y,z:oz+d.z},radius:.15,color:c,radiusRatio:2.5,mid:.75}));
            viewer.addLabel(l,{position:{x:ox+d.x*1.2,y:oy+d.y*1.2,z:oz+d.z*1.2},fontSize:12,fontColor:c,backgroundColor:'transparent',showBackground:false,inFront:true});
        });
        viewer.render();
    }

    function removeAxisIndicator() { axisShapes.forEach(s => { try{viewer.removeShape(s)}catch(e){} }); axisShapes=[]; }

    // ═══════════════════════════════════════════
    // 15. SURFACE
    // ═══════════════════════════════════════════
    function getSurfType() {
        const v = surfaceType.value;
        if(v==='SAS') return $3Dmol.SurfaceType.SAS;
        if(v==='SES') return $3Dmol.SurfaceType.SES;
        if(v==='MS') return $3Dmol.SurfaceType.MS;
        return $3Dmol.SurfaceType.VDW;
    }

    function getSurfColorSpec() {
        const s = surfaceColorScheme.value;
        if(s==='white') return {color:'white'};
        if(s==='element') return {colorscheme:'Jmol'};
        if(s==='chain') return {colorscheme:'chain'};
        if(s==='bFactor') return {colorscheme:'bFactor'};
        if(s==='spectrum') return {color:'spectrum'};
        if(s==='custom') return {color:surfaceCustomColor.value};
        return {color:'white'};
    }

    function addSurface() { if(!viewer)return; surfaceID=viewer.addSurface(getSurfType(),{opacity:parseFloat(surfaceOpacity.value),...getSurfColorSpec()}); viewer.render() }
    function removeSurface() { if(!viewer||surfaceID===null)return; viewer.removeSurface(surfaceID); surfaceID=null }

    surfaceBtn.addEventListener('click', () => { if(!viewer)return; surfaceID!==null ? removeSurface() : addSurface(); viewer.render() });
    surfaceOpacity.addEventListener('input', () => { surfaceOpacityVal.textContent=parseFloat(surfaceOpacity.value).toFixed(2); if(surfaceID!==null){removeSurface();addSurface()} });
    surfaceColorScheme.addEventListener('change', () => { surfaceCustomColor.classList.toggle('hidden',surfaceColorScheme.value!=='custom'); if(surfaceID!==null){removeSurface();addSurface()} });
    surfaceCustomColor.addEventListener('input', () => { if(surfaceID!==null){removeSurface();addSurface()} });

    // ═══════════════════════════════════════════
    // 16. SLAB & CLIPPING
    // ═══════════════════════════════════════════
    function applySlab() {
        if(!viewer) return;
        const n=parseInt(slabNear.value), f=parseInt(slabFar.value);
        slabNearVal.textContent = n===-100 ? 'Off' : n;
        slabFarVal.textContent = f===100 ? 'Off' : f;
        viewer.setSlab(n,f); viewer.render();
    }
    slabNear.addEventListener('input', applySlab);
    slabFar.addEventListener('input', applySlab);
    resetSlab.addEventListener('click', () => { slabNear.value=-100; slabFar.value=100; applySlab() });

    // ═══════════════════════════════════════════
    // 17. OUTLINE
    // ═══════════════════════════════════════════
    function applyOutline() {
        if(!viewer) return;
        if(T.outline) viewer.setViewStyle({style:'outline',color:'black',width:.02});
        else viewer.setViewStyle({});
        viewer.render();
    }

    // ═══════════════════════════════════════════
    // 18. CLICK TO INSPECT
    // ═══════════════════════════════════════════
    function setupClickInspect() {
        if(!viewer) return;
        viewer.setClickable({}, true, atom => {
            if(measureMode) { handleMeasureClick(atom); return; }
            if(!T.clickInspect) return;
            let info = `<b>${atom.elem}</b>`;
            if(atom.atom) info += ` — ${atom.atom}`;
            if(atom.resn) info += `<br>Res: ${atom.resn} ${atom.resi||''}`;
            if(atom.chain) info += `<br>Chain: ${atom.chain}`;
            info += `<br>Pos: (${atom.x.toFixed(2)}, ${atom.y.toFixed(2)}, ${atom.z.toFixed(2)})`;
            if(atom.b) info += `<br>B: ${atom.b.toFixed(2)}`;
            if(atom.serial !== undefined) info += `<br>Serial: ${atom.serial}`;
            atomInfoEl.innerHTML = info;
            atomInfoEl.classList.add('visible');
            setTimeout(() => atomInfoEl.classList.remove('visible'), 4000);
        });
    }

    // ═══════════════════════════════════════════
    // 19. DISTANCE MEASUREMENT
    // ═══════════════════════════════════════════
    measureModeBtn.addEventListener('click', () => {
        measureMode = !measureMode; measureAtoms = [];
        measureModeBtn.style.background = measureMode ? '#f59e0b' : '';
        measureModeBtn.style.color = measureMode ? '#fff' : '';
        modeBadge.classList.toggle('hidden', !measureMode);
        modeBadge.classList.toggle('measure', measureMode);
        modeBadge.textContent = measureMode ? 'Measure Mode' : '';
    });

    function handleMeasureClick(atom) {
        measureAtoms.push(atom);
        measureShapes.push(viewer.addSphere({center:{x:atom.x,y:atom.y,z:atom.z},radius:.4,color:'#facc15',opacity:.7}));
        viewer.render();

        if(measureAtoms.length === 2) {
            const [a,b] = measureAtoms;
            const dx=a.x-b.x, dy=a.y-b.y, dz=a.z-b.z;
            const dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
            const mid = {x:(a.x+b.x)/2, y:(a.y+b.y)/2, z:(a.z+b.z)/2};

            measureShapes.push(viewer.addCylinder({start:{x:a.x,y:a.y,z:a.z},end:{x:b.x,y:b.y,z:b.z},radius:.04,color:'#facc15',dashed:true,fromCap:true,toCap:true}));

            const labelText = `${dist.toFixed(2)} Å`;
            const labelOpts = {position:mid,fontSize:11,fontColor:'#fef08a',backgroundColor:'rgba(120,53,15,.8)',backgroundOpacity:.8,borderRadius:4,padding:2,showBackground:true,inFront:true};

            viewer.addLabel(labelText, labelOpts);
            measureLabels.push({ text: labelText, options: labelOpts });

            viewer.render();
            measureInfo.innerHTML += `<div>${a.elem}${a.serial||''} ↔ ${b.elem}${b.serial||''}: <b>${dist.toFixed(2)} Å</b></div>`;
            measureAtoms = [];
        }
    }

    clearMeasuresBtn.addEventListener('click', () => {
        if(!viewer) return;
        measureShapes.forEach(s => { try{viewer.removeShape(s)}catch(e){} });
        measureShapes = []; measureLabels = []; measureAtoms = [];
        measureInfo.innerHTML = '';
        viewer.removeAllLabels(); updateLabels();
        if(T.axis) drawAxisIndicator();
        viewer.render();
    });

    // ═══════════════════════════════════════════
    // 20. SELECTION HANDLERS
    // ═══════════════════════════════════════════
    const guiIsolateBtn = $('guiIsolateBtn');
    const guiZoomBtn = $('guiZoomBtn');
    if(guiIsolateBtn) guiIsolateBtn.addEventListener('click', () => executeGuiSelection('isolate'));
    if(guiZoomBtn) guiZoomBtn.addEventListener('click', () => executeGuiSelection('zoom'));

    document.querySelectorAll('.interactive-select').forEach(select => {
        select.addEventListener('change', () => autoIsolateIfNeeded());
    });

    document.querySelectorAll('.reset-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            applyStyles();
            const countEl = $('selectionCount');
            if(countEl) countEl.classList.add('hidden');
            if(viewer) { viewer.zoomTo(); viewer.render(); }
        });
    });

    if(focusBtn) focusBtn.addEventListener('click', () => {
        if(!viewer) return;
        const sel = parseSelString($('focusQuery').value);
        viewer.zoomTo(sel); viewer.render();
    });

    if(isolateBtn) isolateBtn.addEventListener('click', () => {
        if(!viewer) return;
        const sel = parseSelString($('focusQuery').value);
        viewer.setStyle({}, {hidden:true});
        viewer.setStyle(sel, buildStyleObj(styleSelect.value, getColorObj()));
        viewer.zoomTo(sel); viewer.render();
    });

    document.querySelectorAll('.sel-guide-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const content = btn.nextElementSibling;
            const icon = btn.querySelector('i');
            content.classList.toggle('hidden');
            icon.style.transform = content.classList.contains('hidden') ? '' : 'rotate(180deg)';
        });
    });

    // ═══════════════════════════════════════════
    // 21. TRAJECTORY
    // ═══════════════════════════════════════════
    trajSlider.addEventListener('input', () => {
        if(!viewer) return;
        const f = parseInt(trajSlider.value);
        viewer.setFrame(f); viewer.render();
        trajFrame.textContent = `${f+1}/${parseInt(trajSlider.max)+1}`;
    });

    trajPrev.addEventListener('click', () => { if(parseInt(trajSlider.value) > 0) { trajSlider.value = parseInt(trajSlider.value)-1; trajSlider.dispatchEvent(new Event('input')) } });
    trajNext.addEventListener('click', () => { if(parseInt(trajSlider.value) < parseInt(trajSlider.max)) { trajSlider.value = parseInt(trajSlider.value)+1; trajSlider.dispatchEvent(new Event('input')) } });

    trajPlay.addEventListener('click', () => {
        if(trajPlaying) { clearInterval(trajInterval); trajPlaying=false; trajPlay.innerHTML='<i class="fa-solid fa-play mr-1"></i>Play'; return; }
        trajPlaying = true; trajPlay.innerHTML = '<i class="fa-solid fa-pause mr-1"></i>Pause';
        const speed = parseInt(trajSpeed.value) || 100;
        trajInterval = setInterval(() => {
            let f = parseInt(trajSlider.value) + 1;
            if(f > parseInt(trajSlider.max)) f = 0;
            trajSlider.value = f; trajSlider.dispatchEvent(new Event('input'));
        }, speed);
    });

    // ═══════════════════════════════════════════
    // 22. ISOSURFACE (CUBE)
    // ═══════════════════════════════════════════
    isoPosVal.addEventListener('input', () => isoPosDisplay.textContent=parseFloat(isoPosVal.value).toFixed(3));
    isoNegVal.addEventListener('input', () => isoNegDisplay.textContent=parseFloat(isoNegVal.value).toFixed(3));
    isoOpacity.addEventListener('input', () => isoOpacityDisplay.textContent=parseFloat(isoOpacity.value).toFixed(2));

    applyIsoBtn.addEventListener('click', () => {
        if(!viewer || !currentModelData || currentExtension !== 'cube') return;
        clearIsoSurfaces();
        try {
            const voldata = new $3Dmol.VolumeData(currentModelData, 'cube');
            const op = parseFloat(isoOpacity.value);
            isoShapes.push(viewer.addIsosurface(voldata,{isoval:parseFloat(isoPosVal.value),color:'#3b82f6',opacity:op}));
            isoShapes.push(viewer.addIsosurface(voldata,{isoval:parseFloat(isoNegVal.value),color:'#ef4444',opacity:op}));
            viewer.render(); showToast('Isosurface rendered.', 'success');
        } catch(e) { console.error(e); showToast('Error rendering isosurface.', 'error') }
    });

    clearIsoBtn.addEventListener('click', () => { clearIsoSurfaces(); if(viewer) viewer.render() });
    function clearIsoSurfaces() { isoShapes.forEach(s => { try{viewer.removeShape(s)}catch(e){} }); isoShapes=[]; }

    // ═══════════════════════════════════════════
    // 23. TOGGLE BINDINGS
    // ═══════════════════════════════════════════
    setupToggle(toggleEls.atomLabels, 'atomLabels', () => { updateLabels(); if(T.axis) drawAxisIndicator() });
    setupToggle(toggleEls.resLabels, 'resLabels', () => { updateLabels(); if(T.axis) drawAxisIndicator() });
    setupToggle(toggleEls.hydrogens, 'hydrogens', () => { applyStyles(); updateLabels(); if(T.axis) drawAxisIndicator() });
    setupToggle(toggleEls.axis, 'axis', () => { updateLabels(); drawAxisIndicator() });
    setupToggle(toggleEls.spin, 'spin', () => { if(!viewer)return; T.spin ? viewer.spin('y',1) : viewer.spin(false) });
    setupToggle(toggleEls.clickInspect, 'clickInspect', v => { if(!v) atomInfoEl.classList.remove('visible') });
    setupToggle(toggleEls.outline, 'outline', () => applyOutline());

    // ═══════════════════════════════════════════
    // 24. CAMERA PRESETS
    // ═══════════════════════════════════════════
    const AQ = {
        'xy-pos':{x:0,y:0,z:0,w:1},'xy-neg':{x:0,y:1,z:0,w:0},
        'xz-pos':{x:-Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2},'xz-neg':{x:Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2},
        'yz-pos':{x:0,y:Math.SQRT1_2,z:0,w:Math.SQRT1_2},'yz-neg':{x:0,y:-Math.SQRT1_2,z:0,w:Math.SQRT1_2}
    };
    axisBtns.forEach(b => b.addEventListener('click', () => {
        if(!viewer) return;
        const q = AQ[b.dataset.axis];
        if(q) { viewer.setView([0,0,0,0,q.x,q.y,q.z,q.w]); viewer.zoomTo(); viewer.render() }
    }));
    centerBtn.addEventListener('click', () => { if(viewer){ viewer.zoomTo(); viewer.render() } });

    // ═══════════════════════════════════════════
    // 25. EXPORT
    // ═══════════════════════════════════════════
    function captureCanvas(mult) {
        const c = viewerCanvas.querySelector('canvas'); if(!c) throw new Error('No canvas');
        if(mult <= 1) return c;
        const ow=c.width, oh=c.height;
        c.width = ow*mult; c.height = oh*mult;
        viewer.resize(); viewer.render();
        const tc = document.createElement('canvas');
        tc.width = c.width; tc.height = c.height;
        tc.getContext('2d').drawImage(c, 0, 0);
        c.width = ow; c.height = oh;
        viewer.resize(); viewer.render();
        return tc;
    }

    downloadBtn.addEventListener('click', () => {
        if(!viewer) return;
        const m = parseInt(exportQuality.value) || 2;
        showToast(`Generating ${m}x PNG...`, 'info');
        setTimeout(() => {
            try {
                const c = captureCanvas(m);
                const a = document.createElement('a');
                a.download = `${baseName()}_${m}x.png`;
                a.href = c.toDataURL('image/png');
                a.click();
                showToast(`PNG ${m}x saved.`, 'success');
            } catch(e) {
                console.error(e);
                showToast('Export failed. Canvas may be too large.', 'error');
            }
        }, 50);
    });

    // ═══════════════════════════════════════════
    // 26. RESET
    // ═══════════════════════════════════════════
    resetBtn.addEventListener('click', () => {
        if(viewer) { viewer.spin(false); viewer.removeAllLabels(); viewer.removeAllShapes(); removeSurface(); viewer.clear() }
        clearInterval(trajInterval); trajPlaying = false;
        systemBounds = { xMin:0, xMax:0, yMin:0, yMax:0, zMin:0, zMax:0 };
        surfaceID = null; currentModelData = null; currentExtension = null;
        axisShapes = []; isoShapes = []; measureShapes = []; measureLabels = [];
        totalAtomCount = 0;
        $('formatBadge').innerText = '';
        atomInfoEl.classList.remove('visible'); atomInfoEl.innerHTML = '';
        perfWarning.classList.add('hidden');
        enableCrossAxis.checked = false;
        crossAxisControls.classList.add('hidden');
        spatialMode.value = '';
        spatialControls.classList.add('hidden');
        uploadZone.classList.remove('hidden');
        workspace.classList.add('hidden'); workspace.classList.remove('flex');
        fileInput.value = '';
    });

    // ═══════════════════════════════════════════
    // 27. INIT THEME FROM STORAGE
    // ═══════════════════════════════════════════
    if(localStorage.theme === 'dark') {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }

    }); // end DOMContentLoaded
