/* ============================================================================
 * STEMKit | 3D Structure Inspector
 * WebGL molecular viewer built on 3Dmol.js
 *
 * Architecture: single StructureInspector class exposed as window.app so the
 * live viewer and state can be inspected from the browser console.
 *
 *   window.app.viewer      → the raw $3Dmol viewer
 *   window.app.state       → atom counts, bounds, toggles, overrides
 *   window.app.select('chain:A within:5,resn:HEM')  → returns matching atoms
 * ========================================================================== */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════
    const PERF_LABEL_WARN = 5000;      // show "(may lag)" hint
    const PERF_LABEL_BLOCK = 50000;    // refuse labels entirely
    const MAX_EXPORT_PX = 8192;        // hard ceiling; GPUs vary (4096–16384)
    const SAFE_EXPORT_PX = 4096;       // fallback when GPU limit unknown

    // Labels are built in slices of this many per animation frame. Small
    // enough that each slice fits comfortably inside a 16 ms budget, so the
    // browser keeps painting and the UI stays responsive throughout.
    const LABEL_CHUNK = 150;
    const LABEL_FRAME_BUDGET_MS = 10;  // stop a chunk early if it overruns

    const ELEMENT_COLORS = {
        H: '#FFFFFF', C: '#909090', O: '#FF0D0D', N: '#3050F8', S: '#FFFF30',
        P: '#FF8000', F: '#90E050', Cl: '#1FF01F', Br: '#A62929', I: '#940094',
        Fe: '#E06633', Ca: '#3DFF00', Na: '#AB5CF2', K: '#8F40D4', Mg: '#8AFF00',
        Zn: '#7D80B0', Cu: '#C88033', Mn: '#3DFF00', Se: '#FFA100', B: '#FFB5B5',
        Si: '#F0C8A0', Ni: '#50D050', Co: '#F090A0', Cd: '#FFD98F', Hg: '#B8B8D0'
    };
    const DEFAULT_ATOM_COLOR = '#cccccc';

    // Common solvent / ion residue names, used by the `solvent:` shorthand.
    const SOLVENT_RESN = ['HOH', 'WAT', 'SOL', 'TIP3', 'TIP4', 'H2O', 'DOD'];
    const ION_RESN = ['NA', 'CL', 'K', 'MG', 'CA', 'ZN', 'SOD', 'CLA', 'POT', 'ION'];

    const FORMAT_MAP = {
        '.pdb':   { f: 'pdb',    l: 'PDB',        b: false },
        '.ent':   { f: 'pdb',    l: 'PDB (ENT)',  b: false },
        '.sdf':   { f: 'sdf',    l: 'SDF',        b: false },
        '.mol':   { f: 'sdf',    l: 'MOL',        b: false },
        '.mol2':  { f: 'mol2',   l: 'MOL2',       b: false },
        '.xyz':   { f: 'xyz',    l: 'XYZ',        b: false },
        '.cif':   { f: 'cif',    l: 'CIF',        b: false },
        '.mcif':  { f: 'cif',    l: 'mmCIF',      b: false },
        '.cdjson':{ f: 'cdjson', l: 'CDJSON',     b: false },
        '.json':  { f: 'cdjson', l: 'CDJSON',     b: false },
        '.mmtf':  { f: 'mmtf',   l: 'MMTF',       b: true  },
        '.prmtop':{ f: 'prmtop', l: 'PRMTOP',     b: false },
        '.gro':   { f: 'gro',    l: 'GRO',        b: false },
        '.pqr':   { f: 'pqr',    l: 'PQR',        b: false },
        '.cube':  { f: 'cube',   l: 'CUBE',       b: false },
        '.vasp':  { f: 'vasp',   l: 'VASP',       b: false },
        '.poscar':{ f: 'vasp',   l: 'POSCAR',     b: false },
        '.contcar':{ f: 'vasp',  l: 'CONTCAR',    b: false }
    };

    // Camera orientation quaternions
    const AXIS_QUATERNIONS = {
        'xy-pos': { x: 0, y: 0, z: 0, w: 1 },
        'xy-neg': { x: 0, y: 1, z: 0, w: 0 },
        'xz-pos': { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 },
        'xz-neg': { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 },
        'yz-pos': { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
        'yz-neg': { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
    };

    // ═══════════════════════════════════════════════════════════════
    // PURE HELPERS
    // ═══════════════════════════════════════════════════════════════

    /** Escape a value for safe interpolation into innerHTML. */
    const escapeHTML = str => String(str ?? '').replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag] || tag));

    const $ = id => document.getElementById(id);
    const formatNum = n => Number(n).toLocaleString();

    /**
     * Throttle to one call per animation frame. Used for slider drags so the
     * WebGL re-render happens at most once per painted frame instead of once
     * per input event (which fires far faster than the display refreshes).
     */
    function rafThrottle(fn) {
        let queued = false, lastArgs = null;
        return function (...args) {
            lastArgs = args;
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                fn.apply(this, lastArgs);
            });
        };
    }

    /** Trailing-edge debounce, for genuinely expensive work. */
    function debounce(fn, ms) {
        let t = null;
        return function (...args) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), ms);
        };
    }

    /** Squared distance, avoids a sqrt in hot loops. */
    const dist2 = (a, b) => {
        const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        return dx * dx + dy * dy + dz * dz;
    };

    /**
     * Uniform grid for neighbour queries. Building this once and reusing it
     * turns `within:` from an O(n×m) scan into something closer to O(n).
     */
    class SpatialGrid {
        constructor(atoms, cellSize) {
            this.cell = cellSize;
            this.map = new Map();
            for (const a of atoms) {
                const k = this._key(a.x, a.y, a.z);
                let bucket = this.map.get(k);
                if (!bucket) { bucket = []; this.map.set(k, bucket); }
                bucket.push(a);
            }
        }
        _key(x, y, z) {
            return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)},${Math.floor(z / this.cell)}`;
        }
        /** True if any indexed atom lies within `radius` of the point. */
        hasNeighbourWithin(x, y, z, radius) {
            const r2 = radius * radius;
            const cx = Math.floor(x / this.cell),
                  cy = Math.floor(y / this.cell),
                  cz = Math.floor(z / this.cell);
            const span = Math.ceil(radius / this.cell);
            for (let i = -span; i <= span; i++) {
                for (let j = -span; j <= span; j++) {
                    for (let k = -span; k <= span; k++) {
                        const bucket = this.map.get(`${cx + i},${cy + j},${cz + k}`);
                        if (!bucket) continue;
                        for (const b of bucket) {
                            const dx = b.x - x, dy = b.y - y, dz = b.z - z;
                            if (dx * dx + dy * dy + dz * dz <= r2) return true;
                        }
                    }
                }
            }
            return false;
        }
    }

    /**
     * Runs a long job in slices across animation frames so the browser can
     * paint between them. A single instance is reused per job "channel", so
     * starting a new job automatically cancels the previous one, this is what
     * stops rapid toggling from stacking up thousands of queued labels.
     */
    class ChunkedJob {
        constructor() { this._token = 0; this._running = false; }

        get running() { return this._running; }

        cancel() { this._token++; this._running = false; }

        /**
         * @param {Array}    items    things to process
         * @param {Function} step     (item, index) => void
         * @param {Object}   opts     { chunk, onProgress, onDone, budgetMs }
         */
        run(items, step, opts = {}) {
            const token = ++this._token;
            const chunk = opts.chunk || LABEL_CHUNK;
            const budget = opts.budgetMs ?? LABEL_FRAME_BUDGET_MS;
            const total = items.length;
            let i = 0;
            this._running = true;

            const tick = () => {
                if (token !== this._token) return;      // superseded | abandon
                const frameStart = performance.now();
                let processed = 0;
                while (i < total && processed < chunk) {
                    step(items[i], i);
                    i++; processed++;
                    // Bail out of this slice if we have blown the frame budget,
                    // even mid-chunk, so a slow step can't stall a frame.
                    if (processed % 25 === 0 && performance.now() - frameStart > budget) break;
                }
                if (opts.onProgress) opts.onProgress(i, total);
                if (i < total) {
                    requestAnimationFrame(tick);
                } else {
                    this._running = false;
                    if (opts.onDone) opts.onDone();
                }
            };
            if (total === 0) {
                this._running = false;
                if (opts.onDone) opts.onDone();
                return;
            }
            requestAnimationFrame(tick);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // MAIN CLASS
    // ═══════════════════════════════════════════════════════════════
    class StructureInspector {

        constructor() {
            this.viewer = null;
            this.surfaceID = null;
            this.currentModelData = null;
            this.currentExtension = null;

            this.state = {
                totalAtoms: 0,
                bounds: { xMin: 0, xMax: 0, yMin: 0, yMax: 0, zMin: 0, zMax: 0 },
                measureMode: false,
                measureAtoms: [],
                trajPlaying: false,
                selectionOverrides: [],
                customElementColors: {},
                lastSelection: null,
                toggles: {
                    atomLabels: false, resLabels: false, hydrogens: true,
                    axis: false, spin: false, clickInspect: true, outline: false
                }
            };

            this._shapes = { axis: [], iso: [], measure: [] };
            this._measureLabels = [];
            this._trajInterval = null;
            this._labelJob = new ChunkedJob();

            // Measurement records, kept so the overlay can be rebuilt whenever
            // styles change or the user edits the appearance controls.
            this.state.measurements = [];
            this.state.measureFocus = false;   // dim everything but the picks
            this.state.measureStyle = {
                lineColor: '#facc15', lineWidth: 0.04, dashed: true,
                labelSize: 11, labelColor: '#fef08a', labelBg: 'rgba(120,53,15,.85)',
                showBg: true, markerSize: 0.4, markerColor: '#facc15',
                contextStyle: 'wire', contextOpacity: 0.15, decimals: 2, showUnit: true
            };

            this.cacheElements();
            this.bindEvents();
            this.initTheme();
        }

        // Convenience alias
        get T() { return this.state.toggles; }

        // ───────────────────────────────────────────────────────────
        // ELEMENT REFERENCES
        // ───────────────────────────────────────────────────────────
        cacheElements() {
            this.el = {
                uploadZone: $('uploadZone'), fileInput: $('fileInput'), workspace: $('workspace'),
                styleSelect: $('styleSelect'), colorSelect: $('colorSelect'),
                perElementColorContainer: $('perElementColorContainer'),
                selQuery: $('selQuery'), selStyle: $('selStyle'),
                applySelStyle: $('applySelStyle'), clearSelStyles: $('clearSelStyles'),
                centerBtn: $('centerBtn'), surfaceBtn: $('surfaceBtn'), surfaceType: $('surfaceType'),
                surfaceOpacity: $('surfaceOpacity'), surfaceOpacityVal: $('surfaceOpacityVal'),
                surfaceColorScheme: $('surfaceColorScheme'), surfaceCustomColor: $('surfaceCustomColor'),
                surfaceSelOnly: $('surfaceSelOnly'),
                slabNear: $('slabNear'), slabFar: $('slabFar'),
                slabNearVal: $('slabNearVal'), slabFarVal: $('slabFarVal'), resetSlab: $('resetSlab'),
                bgSelect: $('bgSelect'), resetBtn: $('resetBtn'),
                downloadBtn: $('downloadBtn'), exportQuality: $('exportQuality'),
                exportNote: $('exportNote'),
                viewerCanvas: $('viewerCanvas'), atomInfo: $('atomInfo'),
                measureInfo: $('measureInfo'), modeBadge: $('modeBadge'),
                isoPanel: $('isoPanel'), isoPosVal: $('isoPosVal'), isoNegVal: $('isoNegVal'),
                isoOpacity: $('isoOpacity'), isoPosDisplay: $('isoPosDisplay'),
                isoNegDisplay: $('isoNegDisplay'), isoOpacityDisplay: $('isoOpacityDisplay'),
                applyIso: $('applyIso'), clearIso: $('clearIso'),
                measureModeBtn: $('measureModeBtn'), clearMeasures: $('clearMeasures'),
                measureMode3: $('measureMode3'),
                measureFocusToggle: $('measureFocusToggle'), measureFocusPanel: $('measureFocusPanel'),
                measureFocusRes: $('measureFocusRes'), measureContextStyle: $('measureContextStyle'),
                measureContextOpacity: $('measureContextOpacity'), measureContextOpacityVal: $('measureContextOpacityVal'),
                measureContextColor: $('measureContextColor'),
                measureLineColor: $('measureLineColor'), measureLineWidth: $('measureLineWidth'),
                measureLineWidthVal: $('measureLineWidthVal'), measureDashed: $('measureDashed'),
                measureMarkerSize: $('measureMarkerSize'), measureMarkerSizeVal: $('measureMarkerSizeVal'),
                measureLabelSize: $('measureLabelSize'), measureLabelSizeVal: $('measureLabelSizeVal'),
                measureLabelColor: $('measureLabelColor'), measureLabelBg: $('measureLabelBg'),
                measureDecimals: $('measureDecimals'), measureShowUnit: $('measureShowUnit'),
                measureZoomBtn: $('measureZoomBtn'), measureCopyBtn: $('measureCopyBtn'),
                labelScope: $('labelScope'), labelForce: $('labelForce'),
                labelProgress: $('labelProgress'),
                busyOverlay: $('busyOverlay'), busyText: $('busyText'),
                focusQuery: $('focusQuery'), focusBtn: $('focusBtn'), isolateBtn: $('isolateBtn'),
                trajectoryPanel: $('trajectoryPanel'), trajSlider: $('trajSlider'),
                trajFrame: $('trajFrame'), trajPrev: $('trajPrev'), trajPlay: $('trajPlay'),
                trajNext: $('trajNext'), trajSpeed: $('trajSpeed'),
                pdbIdInput: $('pdbIdInput'), fetchPdbBtn: $('fetchPdbBtn'),
                perfWarning: $('perfWarning'), perfWarningText: $('perfWarningText'),
                labelLimit: $('labelLimit'), labelLimitVal: $('labelLimitVal'),
                fileName: $('fileName'), structureMeta: $('structureMeta'), formatBadge: $('formatBadge'),
                // Selection builder
                buildResn: $('buildResn'), buildElem: $('buildElem'), buildChain: $('buildChain'),
                buildResi: $('buildResi'), buildNot: $('buildNot'), buildByres: $('buildByres'),
                buildWithin: $('buildWithin'), buildWithinVal: $('buildWithinVal'),
                buildWithinRow: $('buildWithinRow'),
                autoUpdateView: $('autoUpdateView'),
                guiIsolateBtn: $('guiIsolateBtn'), guiZoomBtn: $('guiZoomBtn'),
                guiHighlightBtn: $('guiHighlightBtn'),
                selectionCount: $('selectionCount'), selCountText: $('selCountText'),
                // Spatial
                spatialMode: $('spatialMode'), spatialAxis: $('spatialAxis'),
                spatialControls: $('spatialControls'),
                spatialRangeControls: $('spatialRangeControls'),
                spatialCenterControls: $('spatialCenterControls'),
                spatialSurfaceControls: $('spatialSurfaceControls'),
                spatialFrom: $('spatialFrom'), spatialTo: $('spatialTo'),
                spatialFromVal: $('spatialFromVal'), spatialToVal: $('spatialToVal'),
                spatialCenter: $('spatialCenter'), spatialWidth: $('spatialWidth'),
                spatialCenterVal: $('spatialCenterVal'), spatialWidthVal: $('spatialWidthVal'),
                spatialDepth: $('spatialDepth'), spatialDepthVal: $('spatialDepthVal'),
                spatialUnit: $('spatialUnit'), queryUnit: $('queryUnit'),
                enableCrossAxis: $('enableCrossAxis'), crossAxisControls: $('crossAxisControls'),
                crossA_from: $('crossA_from'), crossA_to: $('crossA_to'),
                crossA_fromVal: $('crossA_fromVal'), crossA_toVal: $('crossA_toVal'),
                crossA_label: $('crossA_label'), crossA_toLabel: $('crossA_toLabel'),
                crossB_from: $('crossB_from'), crossB_to: $('crossB_to'),
                crossB_fromVal: $('crossB_fromVal'), crossB_toVal: $('crossB_toVal'),
                crossB_label: $('crossB_label'), crossB_toLabel: $('crossB_toLabel'),
                crossAxisLabel: $('crossAxisLabel'),
                // Toggles
                toggleAtomLabels: $('toggleAtomLabels'), toggleResLabels: $('toggleResLabels'),
                toggleHydrogens: $('toggleHydrogens'), toggleAxis: $('toggleAxis'),
                toggleSpin: $('toggleSpin'), toggleClickInspect: $('toggleClickInspect'),
                toggleOutline: $('toggleOutline')
            };
        }

        // ───────────────────────────────────────────────────────────
        // UI UTILITIES
        // ───────────────────────────────────────────────────────────
        toast(msg, type = 'info') {
            const container = $('toastContainer');
            if (!container) return;
            const t = document.createElement('div');
            const cls = type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800'
                : type === 'error'
                ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800'
                : 'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800';
            const ico = type === 'success' ? 'fa-check-circle'
                      : type === 'error' ? 'fa-triangle-exclamation' : 'fa-info-circle';
            t.className = `px-4 py-3 rounded-xl border shadow-lg text-sm font-medium ${cls}`;
            t.style.animation = 'slideIn .3s forwards';
            // Icon is trusted; message is escaped.
            t.innerHTML = `<i class="fa-solid ${ico} mr-2"></i>${escapeHTML(msg)}`;
            container.appendChild(t);
            setTimeout(() => {
                t.style.opacity = '0';
                setTimeout(() => t.remove(), 300);
            }, 3000);
        }

        populateDropdown(selectEl, items, defaultText) {
            if (!selectEl) return;
            selectEl.textContent = '';
            const def = document.createElement('option');
            def.value = ''; def.textContent = defaultText;
            selectEl.appendChild(def);
            for (const item of items) {
                const opt = document.createElement('option');
                opt.value = item;
                opt.textContent = item;   // textContent | never innerHTML
                selectEl.appendChild(opt);
            }
        }

        baseName() {
            return (this.el.fileName?.textContent || 'structure').replace(/\.[^.]+$/, '');
        }

        getBackgroundColor() {
            const v = this.el.bgSelect.value;
            if (v === 'black') return '#000';
            if (v === 'white') return '#fff';
            if (v === 'grey') return '#64748b';
            return document.documentElement.classList.contains('dark') ? '#020617' : '#f8fafc';
        }

        applyBackground() {
            if (!this.viewer) return;
            this.viewer.setBackgroundColor(this.getBackgroundColor());
            this.viewer.render();
        }

        unitMultiplier() { return this.el.spatialUnit.value === 'nm' ? 10.0 : 1.0; }
        unitLabel() { return this.el.spatialUnit.value === 'nm' ? 'nm' : 'Å'; }

        axisBounds(axis) {
            const b = this.state.bounds;
            if (axis === 'x') return { min: b.xMin, max: b.xMax };
            if (axis === 'y') return { min: b.yMin, max: b.yMax };
            return { min: b.zMin, max: b.zMax };
        }

        crossAxesOf(primary) {
            if (primary === 'x') return ['y', 'z'];
            if (primary === 'y') return ['x', 'z'];
            return ['x', 'y'];
        }

        /** All atoms in the current model (empty array when nothing loaded). */
        allAtoms() {
            if (!this.viewer) return [];
            const m = this.viewer.getModel();
            return m ? m.selectedAtoms({}) : [];
        }

        // ───────────────────────────────────────────────────────────
        // SELECTION LANGUAGE
        //
        // Supported tokens (space separated, all ANDed together):
        //   chain:A          resn:HOH        resi:1-50 | resi:12
        //   elem:Fe          atom:CA         ss:h
        //   b:>30            serial:1-100
        //   x:>4.8  y:<10  z:>=2            (units follow the unit selector)
        //   within:5,chain:A                (5 Å of anything matching chain A)
        //   not:resn:HOH                    (invert the rest of the token)
        //   byres:1                         (expand to whole residues)
        //   protein:1  nucleic:1  solvent:1  ion:1  backbone:1  sidechain:1
        //   or:chain:A|chain:B              (union of pipe-separated clauses)
        // ───────────────────────────────────────────────────────────
        parseSelString(str, opts = {}) {
            const sel = {};
            if (!str || !str.trim()) return sel;

            const unitMult = (opts.unit || this.el.queryUnit?.value) === 'nm' ? 10.0 : 1.0;
            const spatial = [];
            const predicates = [];
            const tokens = str.trim().split(/\s+/);

            for (let raw of tokens) {
                let negate = false;
                if (raw.startsWith('!')) { negate = true; raw = raw.slice(1); }
                if (raw.startsWith('not:')) { negate = true; raw = raw.slice(4); }

                const idx = raw.indexOf(':');
                if (idx === -1) continue;
                const key = raw.slice(0, idx).toLowerCase();
                const val = raw.slice(idx + 1);
                if (!val) continue;

                // ---- OR clauses: or:chain:A|chain:B ----
                if (key === 'or') {
                    const clauses = val.split('|').map(c => this.parseSelString(c, opts));
                    const model = this.viewer?.getModel();
                    if (model) {
                        const sets = clauses.map(c => new Set(model.selectedAtoms(c).map(a => a.index)));
                        predicates.push(a => sets.some(s => s.has(a.index)));
                    }
                    continue;
                }

                // ---- Distance: within:5,chain:A ----
                if (key === 'within') {
                    const comma = val.indexOf(',');
                    if (comma === -1) continue;
                    const radius = parseFloat(val.slice(0, comma)) * unitMult;
                    const innerSel = this.parseSelString(val.slice(comma + 1), opts);
                    const model = this.viewer?.getModel();
                    if (model && isFinite(radius)) {
                        const targets = model.selectedAtoms(innerSel);
                        if (targets.length) {
                            const grid = new SpatialGrid(targets, Math.max(radius, 1));
                            const p = a => grid.hasNeighbourWithin(a.x, a.y, a.z, radius);
                            predicates.push(negate ? (a => !p(a)) : p);
                        } else if (!negate) {
                            predicates.push(() => false);
                        }
                    }
                    continue;
                }

                // ---- Named groups ----
                if (['protein', 'nucleic', 'solvent', 'ion', 'backbone', 'sidechain', 'hetero'].includes(key)) {
                    const p = this._namedGroupPredicate(key);
                    if (p) predicates.push(negate ? (a => !p(a)) : p);
                    continue;
                }

                if (key === 'byres') { sel.byres = true; continue; }
                if (key === 'expand') { sel.expand = parseFloat(val) * unitMult; continue; }

                // ---- Numeric comparisons on coordinates / b / serial ----
                if (['x', 'y', 'z', 'b', 'serial', 'charge'].includes(key)) {
                    const cmp = this._parseComparison(val);
                    if (!cmp) continue;
                    const scale = ['x', 'y', 'z'].includes(key) ? unitMult : 1;
                    if (cmp.kind === 'range') {
                        spatial.push({ field: key, op: '>=', val: cmp.lo * scale, negate });
                        spatial.push({ field: key, op: '<=', val: cmp.hi * scale, negate });
                    } else {
                        spatial.push({ field: key, op: cmp.op, val: cmp.val * scale, negate });
                    }
                    continue;
                }

                // ---- Plain attribute selectors ----
                let parsed;
                if (key === 'resi') {
                    const m = val.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
                    if (m) parsed = [{ start: parseInt(m[1], 10), end: parseInt(m[2], 10) }];
                    else if (val.includes(',')) parsed = val.split(',').map(v => isNaN(v) ? v : parseInt(v, 10));
                    else parsed = isNaN(val) ? val : parseInt(val, 10);
                } else if (val.includes(',')) {
                    parsed = val.split(',');
                } else {
                    parsed = val;
                }

                if (negate) {
                    // Build a NOT for just this attribute.
                    const single = {}; single[key] = parsed;
                    const model = this.viewer?.getModel();
                    if (model) {
                        const excluded = new Set(model.selectedAtoms(single).map(a => a.index));
                        predicates.push(a => !excluded.has(a.index));
                    }
                } else {
                    sel[key] = parsed;
                }
            }

            // Fold coordinate/numeric conditions into a predicate.
            if (spatial.length) {
                predicates.push(atom => spatial.every(c => {
                    const v = atom[c.field];
                    if (v === undefined || v === null) return false;
                    let ok;
                    switch (c.op) {
                        case '>=': ok = v >= c.val; break;
                        case '<=': ok = v <= c.val; break;
                        case '>':  ok = v > c.val;  break;
                        case '<':  ok = v < c.val;  break;
                        default:   ok = Math.abs(v - c.val) < 0.001;
                    }
                    return c.negate ? !ok : ok;
                }));
            }

            if (predicates.length) {
                sel.predicate = atom => predicates.every(p => p(atom));
            }
            return sel;
        }

        _parseComparison(v) {
            const range = v.match(/^(-?[\d.]+)\s*-{1,2}\s*(-?[\d.]+)$/);
            if (range && !v.startsWith('>') && !v.startsWith('<')) {
                const lo = parseFloat(range[1]), hi = parseFloat(range[2]);
                if (isFinite(lo) && isFinite(hi)) return { kind: 'range', lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
            }
            let op = '===', num = v;
            if (v.startsWith('>=')) { op = '>='; num = v.slice(2); }
            else if (v.startsWith('<=')) { op = '<='; num = v.slice(2); }
            else if (v.startsWith('>')) { op = '>'; num = v.slice(1); }
            else if (v.startsWith('<')) { op = '<'; num = v.slice(1); }
            const parsedNum = parseFloat(num);
            if (!isFinite(parsedNum)) return null;
            return { kind: 'cmp', op, val: parsedNum };
        }

        _namedGroupPredicate(kind) {
            const AA = new Set(['ALA','ARG','ASN','ASP','CYS','GLN','GLU','GLY','HIS','ILE','LEU',
                'LYS','MET','PHE','PRO','SER','THR','TRP','TYR','VAL','HSD','HSE','HSP','SEC','PYL','MSE']);
            const NUC = new Set(['A','T','G','C','U','DA','DT','DG','DC','DU','RA','RU','RG','RC']);
            const BACKBONE = new Set(['N','CA','C','O','OXT','P',"O5'","C5'","C4'","C3'","O3'"]);
            const up = a => (a.resn || '').toUpperCase().trim();

            switch (kind) {
                case 'protein':  return a => AA.has(up(a));
                case 'nucleic':  return a => NUC.has(up(a));
                case 'solvent':  return a => SOLVENT_RESN.includes(up(a));
                case 'ion':      return a => ION_RESN.includes(up(a));
                case 'hetero':   return a => !!a.hetflag;
                case 'backbone': return a => AA.has(up(a)) && BACKBONE.has((a.atom || '').toUpperCase().trim());
                case 'sidechain':return a => AA.has(up(a)) && !BACKBONE.has((a.atom || '').toUpperCase().trim());
                default: return null;
            }
        }

        /** Public console helper: app.select('chain:A within:5,resn:HEM') */
        select(query) {
            const model = this.viewer?.getModel();
            if (!model) return [];
            return model.selectedAtoms(this.parseSelString(query));
        }

        countSelection(sel) {
            const model = this.viewer?.getModel();
            if (!model) return 0;
            try { return model.selectedAtoms(sel).length; } catch (e) { return 0; }
        }

        // ───────────────────────────────────────────────────────────
        // STYLES
        // ───────────────────────────────────────────────────────────
        getColorObj() {
            const c = this.el.colorSelect.value;
            if (c === 'element') return { colorscheme: 'Jmol' };
            if (c === 'chain') return { colorscheme: 'chain' };
            if (c === 'residue') return { colorscheme: 'amino' };
            if (c === 'bFactor') return { colorscheme: 'bFactor' };
            if (c === 'spectrum') return { color: 'spectrum' };
            if (c === 'ss') return { colorscheme: 'ssJmol' };
            return {};
        }

        buildStyleObj(type, colObj) {
            switch (type) {
                case 'stick':     return { stick: { radius: 0.15, ...colObj } };
                case 'ballstick': return { stick: { radius: 0.12, ...colObj }, sphere: { scale: 0.25, ...colObj } };
                case 'sphere':    return { sphere: { ...colObj } };
                case 'cross':     return { cross: { linewidth: 2, ...colObj } };
                case 'line':      return { line: { ...colObj } };
                case 'cartoon':   return { cartoon: { ...colObj }, stick: { radius: 0.08, ...colObj } };
                case 'cartoontube': return { cartoon: { style: 'trace', thickness: 0.4, ...colObj } };
                case 'hidden':    return {};
                default:          return { stick: { radius: 0.15, ...colObj } };
            }
        }

        applyStyledSelection(sel, styleType, method) {
            const custom = this.el.colorSelect.value === 'custom';
            const call = method === 'set' ? 'setStyle' : 'addStyle';
            if (custom) {
                for (const [elName, col] of Object.entries(this.state.customElementColors)) {
                    const combined = Object.assign({}, sel, { elem: elName });
                    this.viewer[call](combined, this.buildStyleObj(styleType, { color: col }));
                }
            } else {
                this.viewer[call](sel, this.buildStyleObj(styleType, this.getColorObj()));
            }
        }

        applyStyles() {
            if (!this.viewer) return;
            const styleType = this.el.styleSelect.value;
            const colorMode = this.el.colorSelect.value;

            if (colorMode === 'custom') {
                this.viewer.setStyle({}, { hidden: true });
                for (const [elName, col] of Object.entries(this.state.customElementColors)) {
                    this.viewer.setStyle({ elem: elName }, this.buildStyleObj(styleType, { color: col }));
                }
            } else {
                this.viewer.setStyle({}, this.buildStyleObj(styleType, this.getColorObj()));
            }

            if (!this.T.hydrogens) this.viewer.setStyle({ elem: 'H' }, { hidden: true });

            // Re-apply stored per-selection overrides on top of the base style.
            for (const ov of this.state.selectionOverrides) {
                if (ov.styleType === 'hidden') {
                    this.viewer.addStyle(ov.sel, { hidden: true });
                } else if (ov.color) {
                    this.viewer.addStyle(ov.sel, this.buildStyleObj(ov.styleType, { color: ov.color }));
                } else {
                    this.applyStyledSelection(ov.sel, ov.styleType, 'add');
                }
            }

            this.viewer.render();
        }

        buildPerElementColorUI(elements) {
            const container = this.el.perElementColorContainer;
            container.textContent = '';
            this.state.customElementColors = {};

            const header = document.createElement('div');
            header.className = 'text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 sticky top-0 bg-slate-50 dark:bg-slate-900/50 z-10 pb-1';
            header.textContent = 'Per-Element Colors';
            container.appendChild(header);

            for (const elName of elements) {
                const defCol = ELEMENT_COLORS[elName] || DEFAULT_ATOM_COLOR;
                this.state.customElementColors[elName] = defCol;

                const row = document.createElement('div');
                row.className = 'flex items-center justify-between gap-2';

                const label = document.createElement('span');
                label.className = 'text-[11px] font-mono font-bold text-slate-700 dark:text-slate-300 w-8';
                label.textContent = elName;     // safe

                const picker = document.createElement('input');
                picker.type = 'color';
                picker.value = defCol;
                picker.className = 'w-6 h-6 rounded cursor-pointer border-0 p-0 flex-grow bg-transparent';

                const resetBtn = document.createElement('button');
                resetBtn.className = 'sidebar-btn px-2 py-1 text-[9px] font-bold';
                resetBtn.textContent = 'Reset';

                const onPick = rafThrottle(v => {
                    this.state.customElementColors[elName] = v;
                    this.applyStyles();
                });
                picker.addEventListener('input', e => onPick(e.target.value));
                resetBtn.addEventListener('click', () => {
                    picker.value = defCol;
                    this.state.customElementColors[elName] = defCol;
                    this.applyStyles();
                });

                row.append(label, picker, resetBtn);
                container.appendChild(row);
            }
        }

        // ───────────────────────────────────────────────────────────
        // PERFORMANCE WARNINGS
        // ───────────────────────────────────────────────────────────
        updatePerfWarnings() {
            const atomWarn = $('atomLabelWarn'), resWarn = $('resLabelWarn'),
                  limitRow = $('labelLimitRow'), n = this.state.totalAtoms;

            if (n > PERF_LABEL_BLOCK) {
                this.el.perfWarning.classList.remove('hidden');
                this.el.perfWarningText.textContent =
                    `${formatNum(n)} atoms, labels disabled to prevent browser freeze.`;
                [atomWarn, resWarn].forEach(w => {
                    if (w) { w.classList.remove('hidden'); w.textContent = '(disabled)'; }
                });
                limitRow?.classList.add('hidden');
            } else if (n > PERF_LABEL_WARN) {
                this.el.perfWarning.classList.remove('hidden');
                this.el.perfWarningText.textContent =
                    `${formatNum(n)} atoms, labels may cause lag. Limit adjustable below.`;
                [atomWarn, resWarn].forEach(w => {
                    if (w) { w.classList.remove('hidden'); w.textContent = '(may lag)'; }
                });
                limitRow?.classList.remove('hidden');
            } else {
                this.el.perfWarning.classList.add('hidden');
                atomWarn?.classList.add('hidden');
                resWarn?.classList.add('hidden');
                limitRow?.classList.add('hidden');
            }
        }

        // ───────────────────────────────────────────────────────────
        // SPATIAL SLIDERS
        // ───────────────────────────────────────────────────────────
        updateCrossAxisSliders() {
            const e = this.el;
            const [axA, axB] = this.crossAxesOf(e.spatialAxis.value);
            const mult = this.unitMultiplier(), unit = this.unitLabel();
            const bA = this.axisBounds(axA), bB = this.axisBounds(axB);
            const minA = bA.min / mult, maxA = bA.max / mult;
            const minB = bB.min / mult, maxB = bB.max / mult;
            const stepFor = r => (r > 100 ? 1 : r > 10 ? 0.1 : 0.01);

            e.crossA_label.textContent = axA.toUpperCase() + ' from';
            e.crossA_toLabel.textContent = axA.toUpperCase() + ' to';
            e.crossB_label.textContent = axB.toUpperCase() + ' from';
            e.crossB_toLabel.textContent = axB.toUpperCase() + ' to';
            e.crossAxisLabel.textContent = `${axA.toUpperCase()} & ${axB.toUpperCase()} width clamp`;

            const stepA = stepFor(maxA - minA), stepB = stepFor(maxB - minB);
            e.crossA_from.min = e.crossA_to.min = minA;
            e.crossA_from.max = e.crossA_to.max = maxA;
            e.crossA_from.step = e.crossA_to.step = stepA;
            e.crossA_from.value = minA; e.crossA_to.value = maxA;
            e.crossA_fromVal.textContent = minA.toFixed(1) + ' ' + unit;
            e.crossA_toVal.textContent = maxA.toFixed(1) + ' ' + unit;

            e.crossB_from.min = e.crossB_to.min = minB;
            e.crossB_from.max = e.crossB_to.max = maxB;
            e.crossB_from.step = e.crossB_to.step = stepB;
            e.crossB_from.value = minB; e.crossB_to.value = maxB;
            e.crossB_fromVal.textContent = minB.toFixed(1) + ' ' + unit;
            e.crossB_toVal.textContent = maxB.toFixed(1) + ' ' + unit;
        }

        updateSpatialSliders() {
            const e = this.el;
            const bounds = this.axisBounds(e.spatialAxis.value);
            const mult = this.unitMultiplier(), unit = this.unitLabel();
            const min = bounds.min / mult, max = bounds.max / mult;
            const range = max - min;
            const step = range > 100 ? 1 : range > 10 ? 0.1 : 0.01;

            e.spatialFrom.min = e.spatialTo.min = min;
            e.spatialFrom.max = e.spatialTo.max = max;
            e.spatialFrom.step = e.spatialTo.step = step;
            e.spatialFrom.value = min; e.spatialTo.value = max;
            e.spatialFromVal.textContent = min.toFixed(1) + ' ' + unit;
            e.spatialToVal.textContent = max.toFixed(1) + ' ' + unit;

            e.spatialCenter.min = min; e.spatialCenter.max = max; e.spatialCenter.step = step;
            e.spatialCenter.value = ((min + max) / 2).toFixed(2);
            e.spatialCenterVal.textContent = parseFloat(e.spatialCenter.value).toFixed(1) + ' ' + unit;

            e.spatialWidth.min = step;
            e.spatialWidth.max = Math.max(step, range / 2).toFixed(2);
            e.spatialWidth.step = step;
            e.spatialWidth.value = Math.min(5 / mult, range / 4).toFixed(2);
            e.spatialWidthVal.textContent = parseFloat(e.spatialWidth.value).toFixed(1) + ' ' + unit;

            e.spatialDepth.min = step;
            e.spatialDepth.max = Math.max(step, range / 2).toFixed(2);
            e.spatialDepth.step = step;
            e.spatialDepth.value = Math.min(5 / mult, range / 4).toFixed(2);
            e.spatialDepthVal.textContent = parseFloat(e.spatialDepth.value).toFixed(1) + ' ' + unit;

            this.updateCrossAxisSliders();
        }

        buildSpatialPredicate() {
            const e = this.el, mode = e.spatialMode.value;
            if (!mode) return null;

            const axis = e.spatialAxis.value;
            const mult = this.unitMultiplier();
            const bounds = this.axisBounds(axis);
            let lo, hi;

            if (mode === 'range') {
                lo = parseFloat(e.spatialFrom.value) * mult;
                hi = parseFloat(e.spatialTo.value) * mult;
                if (lo > hi) [lo, hi] = [hi, lo];
            } else if (mode === 'center') {
                const c = parseFloat(e.spatialCenter.value) * mult;
                const w = parseFloat(e.spatialWidth.value) * mult;
                lo = c - w; hi = c + w;
            } else if (mode === 'top') {
                const d = parseFloat(e.spatialDepth.value) * mult;
                lo = bounds.max - d; hi = Infinity;
            } else if (mode === 'bottom') {
                const d = parseFloat(e.spatialDepth.value) * mult;
                lo = -Infinity; hi = bounds.min + d;
            } else {
                return null;
            }

            const useCross = e.enableCrossAxis.checked;
            let axA, axB, aLo, aHi, bLo, bHi;
            if (useCross) {
                [axA, axB] = this.crossAxesOf(axis);
                aLo = parseFloat(e.crossA_from.value) * mult;
                aHi = parseFloat(e.crossA_to.value) * mult;
                if (aLo > aHi) [aLo, aHi] = [aHi, aLo];
                bLo = parseFloat(e.crossB_from.value) * mult;
                bHi = parseFloat(e.crossB_to.value) * mult;
                if (bLo > bHi) [bLo, bHi] = [bHi, bLo];
            }

            return atom => {
                if (!(atom[axis] >= lo && atom[axis] <= hi)) return false;
                if (!useCross) return true;
                return atom[axA] >= aLo && atom[axA] <= aHi
                    && atom[axB] >= bLo && atom[axB] <= bHi;
            };
        }

        /** Selection object from the Tools-tab builder controls. */
        buildGuiSelection() {
            const e = this.el;
            const sel = {};
            const resn = e.buildResn?.value, elem = e.buildElem?.value, chain = e.buildChain?.value;
            if (resn) sel.resn = resn;
            if (elem) sel.elem = elem;
            if (chain) sel.chain = chain;

            const resiRaw = e.buildResi?.value.trim();
            if (resiRaw) {
                const m = resiRaw.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
                if (m) sel.resi = [{ start: parseInt(m[1], 10), end: parseInt(m[2], 10) }];
                else if (resiRaw.includes(',')) sel.resi = resiRaw.split(',').map(v => parseInt(v, 10)).filter(isFinite);
                else if (!isNaN(resiRaw)) sel.resi = parseInt(resiRaw, 10);
            }

            const preds = [];
            const spatialPred = this.buildSpatialPredicate();
            if (spatialPred) preds.push(spatialPred);

            // Within-distance expansion around the attribute selection.
            const withinOn = e.buildWithin && parseFloat(e.buildWithin.value) > 0;
            if (withinOn) {
                const radius = parseFloat(e.buildWithin.value) * this.unitMultiplier();
                const model = this.viewer?.getModel();
                if (model) {
                    const coreSel = Object.assign({}, sel);
                    if (preds.length) coreSel.predicate = a => preds.every(p => p(a));
                    const targets = model.selectedAtoms(coreSel);
                    if (targets.length) {
                        const grid = new SpatialGrid(targets, Math.max(radius, 1));
                        // Reset to a pure proximity selection around the core.
                        for (const k of Object.keys(sel)) delete sel[k];
                        sel.predicate = a => grid.hasNeighbourWithin(a.x, a.y, a.z, radius);
                        if (e.buildByres?.checked) sel.byres = true;
                        return sel;
                    }
                }
            }

            if (preds.length) sel.predicate = a => preds.every(p => p(a));
            if (e.buildByres?.checked) sel.byres = true;

            // NOT wrapper, invert the whole builder selection.
            if (e.buildNot?.checked) {
                const model = this.viewer?.getModel();
                if (model) {
                    const inner = new Set(model.selectedAtoms(Object.assign({}, sel)).map(a => a.index));
                    const inverted = { predicate: a => !inner.has(a.index) };
                    if (sel.byres) inverted.byres = true;
                    return inverted;
                }
            }
            return sel;
        }

        executeGuiSelection(action) {
            if (!this.viewer) return;
            const sel = this.buildGuiSelection();
            this.state.lastSelection = sel;

            const count = this.countSelection(sel);
            if (this.el.selectionCount && this.el.selCountText) {
                this.el.selectionCount.classList.remove('hidden');
                this.el.selCountText.textContent =
                    `${formatNum(count)} atom${count !== 1 ? 's' : ''} selected`;
            }

            if (action === 'isolate') {
                this.viewer.setStyle({}, { hidden: true });
                this.applyStyledSelection(sel, this.el.styleSelect.value, 'set');
                if (!this.T.hydrogens) this.viewer.setStyle({ elem: 'H' }, { hidden: true });
            } else if (action === 'highlight') {
                // Keep everything visible, dim the rest, emphasise the selection.
                this.viewer.setStyle({}, this.buildStyleObj('line', { color: '#94a3b8' }));
                this.applyStyledSelection(sel, this.el.styleSelect.value, 'add');
                if (!this.T.hydrogens) this.viewer.setStyle({ elem: 'H' }, { hidden: true });
            }

            if (action === 'zoom' || action === 'isolate') {
                if (count > 0) this.viewer.zoomTo(sel);
                else this.toast('No atoms match that selection.', 'error');
            }
            this.viewer.render();
        }

        autoIsolateIfNeeded() {
            if (this.el.autoUpdateView?.checked) this.executeGuiSelection('isolate');
        }

        // ───────────────────────────────────────────────────────────
        // FILE LOADING
        // ───────────────────────────────────────────────────────────
        handleFile(file) {
            if (!file) return;
            const fn = file.name.toLowerCase();
            const match = Object.entries(FORMAT_MAP).find(([ext]) => fn.endsWith(ext));
            if (!match) { this.toast('Format not supported.', 'error'); return; }

            const info = match[1];
            this.currentExtension = info.f;
            this.el.fileName.textContent = file.name;      // safe
            this.el.formatBadge.textContent = info.l;
            this.toast('Loading…');

            const reader = new FileReader();
            reader.onerror = () => this.toast('Could not read that file.', 'error');
            if (info.b) {
                reader.onload = ev => { this.currentModelData = new Uint8Array(ev.target.result); this.initViewer(); };
                reader.readAsArrayBuffer(file);
            } else {
                reader.onload = ev => { this.currentModelData = ev.target.result; this.initViewer(); };
                reader.readAsText(file);
            }
        }

        async fetchPdb() {
            const id = this.el.pdbIdInput.value.trim().toUpperCase();
            if (!/^[A-Z0-9]{4}$/.test(id)) {
                this.toast('Enter a valid 4-character PDB ID.', 'error');
                return;
            }
            this.toast(`Fetching ${id} from RCSB…`);
            try {
                const res = await fetch(`https://files.rcsb.org/download/${id}.pdb`);
                if (!res.ok) throw new Error('Not found');
                this.currentModelData = await res.text();
                this.currentExtension = 'pdb';
                this.el.fileName.textContent = id + '.pdb';
                this.el.formatBadge.textContent = 'PDB | RCSB Fetch';
                this.initViewer();
            } catch (err) {
                console.error(err);
                this.toast(`Failed to fetch ${id}. Check the ID and try again.`, 'error');
            }
        }

        /**
         * Whether the browser will give us a WebGL context.
         *
         * 3Dmol draws through WebGL, so this is a hard requirement, but the
         * requirement is WebGL, not a discrete GPU. Integrated graphics are
         * fine, and where no hardware path exists browsers fall back to a
         * software renderer, which is slower but correct. It genuinely fails
         * only where WebGL is switched off or absent: hardware acceleration
         * disabled, some virtual machines and remote desktop sessions,
         * locked-down enterprise policies, or a very old browser.
         *
         * Probed on a throwaway canvas and cached, so a refused context costs
         * one attempt rather than one per structure.
         */
        webglAvailable() {
            if (this._webgl !== undefined) return this._webgl;
            try {
                const c = document.createElement('canvas');
                this._webgl = Boolean(
                    c.getContext('webgl2') ||
                    c.getContext('webgl') ||
                    c.getContext('experimental-webgl')
                );
            } catch (e) {
                this._webgl = false;
            }
            return this._webgl;
        }

        initViewer() {
            // Checked before the workspace is revealed. Swapping the upload
            // screen for a viewer that cannot draw leaves an empty panel and
            // no explanation, which reads as the file having failed to load.
            if (!this.webglAvailable()) {
                this.toast(
                    'This viewer needs WebGL, which the browser is not providing. ' +
                    'Enabling hardware acceleration, or opening the page in a ' +
                    'different browser, usually restores it.',
                    'error'
                );
                return;
            }

            this.el.uploadZone.classList.add('hidden');
            this.el.workspace.classList.remove('hidden');
            this.el.workspace.classList.add('flex');

            if (this.viewer) {
                this.viewer.clear();
            } else {
                try {
                    this.viewer = $3Dmol.createViewer(this.el.viewerCanvas, {
                        backgroundColor: this.getBackgroundColor()
                    });
                } catch (err) {
                    console.error(err);
                }
                if (!this.viewer) {
                    // A context can still be refused after the probe passes,
                    // e.g. when too many WebGL contexts are already open.
                    this.el.workspace.classList.add('hidden');
                    this.el.workspace.classList.remove('flex');
                    this.el.uploadZone.classList.remove('hidden');
                    this.toast(
                        'Could not start the 3D viewer. Closing other tabs using ' +
                        '3D graphics and reloading usually frees enough resources.',
                        'error'
                    );
                    return;
                }
            }

            try {
                this.viewer.addModel(this.currentModelData, this.currentExtension, {
                    multimodel: true, frames: true, keepH: true
                });
                this.afterModelLoaded();
                this.toast('Structure rendered.', 'success');
            } catch (err) {
                console.error(err);
                this.toast('Error parsing file.', 'error');
            }
        }

        afterModelLoaded() {
            const atoms = this.allAtoms();
            this.state.totalAtoms = atoms.length;

            const elems = new Set(), chains = new Set(), residues = new Set();
            let xMin = Infinity, xMax = -Infinity, yMin = Infinity,
                yMax = -Infinity, zMin = Infinity, zMax = -Infinity;

            for (const a of atoms) {
                if (a.elem) elems.add(a.elem);
                if (a.chain) chains.add(a.chain);
                if (a.resn) residues.add(a.resn);
                if (a.x < xMin) xMin = a.x;
                if (a.x > xMax) xMax = a.x;
                if (a.y < yMin) yMin = a.y;
                if (a.y > yMax) yMax = a.y;
                if (a.z < zMin) zMin = a.z;
                if (a.z > zMax) zMax = a.z;
            }
            if (!atoms.length) { xMin = xMax = yMin = yMax = zMin = zMax = 0; }
            this.state.bounds = { xMin, xMax, yMin, yMax, zMin, zMax };

            let meta = `${formatNum(atoms.length)} Atoms`;
            if (elems.size) meta += ` · ${elems.size} Elem`;
            if (chains.size > 1) meta += ` · ${chains.size} Chains`;
            if (residues.size) meta += ` · ${residues.size} Res types`;
            const dims = `${(xMax - xMin).toFixed(1)} × ${(yMax - yMin).toFixed(1)} × ${(zMax - zMin).toFixed(1)} Å`;
            meta += ` · ${dims}`;
            this.el.structureMeta.textContent = meta;

            const sortedRes = Array.from(residues).sort();
            const sortedElem = Array.from(elems).sort();
            const sortedChain = Array.from(chains).sort();

            this.populateDropdown(this.el.buildResn, sortedRes, 'All Residues');
            this.populateDropdown(this.el.buildElem, sortedElem, 'All Elements');
            this.populateDropdown(this.el.buildChain, sortedChain, 'All Chains');
            this.populateDropdown($('selChain'), sortedChain, 'All Chains');
            this.populateDropdown($('selElem'), sortedElem, 'All Elements');
            this.populateDropdown($('selResn'), sortedRes, 'All Residues');

            this.buildPerElementColorUI(sortedElem);
            this.updatePerfWarnings();

            this.el.isoPanel.classList.toggle('hidden', this.currentExtension !== 'cube');

            const nFrames = this.viewer.getModel().getNumFrames();
            if (nFrames > 1) {
                this.el.trajectoryPanel.classList.remove('hidden');
                this.el.trajSlider.max = nFrames - 1;
                this.el.trajSlider.value = 0;
                this.el.trajFrame.textContent = `1/${nFrames}`;
            } else {
                this.el.trajectoryPanel.classList.add('hidden');
            }

            // Reset spatial + selection state for the new structure
            this.el.spatialMode.value = '';
            this.el.spatialControls.classList.add('hidden');
            this.el.enableCrossAxis.checked = false;
            this.el.crossAxisControls.classList.add('hidden');
            if (this.el.buildWithin) {
                this.el.buildWithin.value = 0;
                this.el.buildWithinVal.textContent = 'off';
            }
            if (this.el.buildResi) this.el.buildResi.value = '';
            if (this.el.buildNot) this.el.buildNot.checked = false;
            if (this.el.buildByres) this.el.buildByres.checked = false;
            this.el.selectionCount?.classList.add('hidden');
            this.state.selectionOverrides = [];
            this.state.measurements = [];
            this._labelJob.cancel();
            this.setLabelProgress(1, 1);
            this.renderMeasureList();
            this.updateExportNote();

            this.applyStyles();
            this.applyBackground();
            this.setupClickInspect();
            this.viewer.zoomTo();
            this.viewer.render();
        }

        // ───────────────────────────────────────────────────────────
        // LABELS
        // ───────────────────────────────────────────────────────────
        /**
         * Which atoms should carry labels.
         *
         * Labelling the first N atoms in file order is close to useless on a
         * big system, you get a dense clot over whatever happened to be
         * written first. Instead we scope to the current selection when there
         * is one, then, if still over budget, keep the atoms nearest the
         * camera target so the labels land on what the user is looking at.
         */
        pickLabelAtoms(kind, budget) {
            const scoped = this.el.labelScope?.value || 'selection';
            let atoms;

            if (scoped === 'selection' && this.state.lastSelection) {
                atoms = this.viewer.getModel().selectedAtoms(this.state.lastSelection);
            } else if (scoped === 'visible') {
                // Atoms that currently have a non-hidden style applied.
                atoms = this.allAtoms().filter(a => {
                    const s = a.style || {};
                    return Object.keys(s).length > 0 && !s.hidden;
                });
                if (!atoms.length) atoms = this.allAtoms();
            } else {
                atoms = this.allAtoms();
            }

            if (!this.T.hydrogens) atoms = atoms.filter(a => a.elem !== 'H');

            if (kind === 'residue') {
                // One representative atom per residue, preferring CA.
                const byRes = new Map();
                for (const a of atoms) {
                    const k = `${a.chain || ''}_${a.resn || ''}_${a.resi || ''}`;
                    if (!byRes.has(k) || a.atom === 'CA') byRes.set(k, a);
                }
                atoms = Array.from(byRes.values());
            }

            const total = atoms.length;
            if (total <= budget) return { atoms, total };

            // Over budget: keep those closest to the centre of the view.
            let cx = 0, cy = 0, cz = 0;
            try {
                const c = this.viewer.getView();       // [cx, cy, cz, zoom, ...]
                if (Array.isArray(c) && c.length >= 3) { cx = -c[0]; cy = -c[1]; cz = -c[2]; }
            } catch (e) {
                const b = this.state.bounds;
                cx = (b.xMin + b.xMax) / 2; cy = (b.yMin + b.yMax) / 2; cz = (b.zMin + b.zMax) / 2;
            }
            // Sorting the whole array costs O(n log n) and allocates a wrapper
            // per atom, noticeable at 100k+. Since we only need the nearest
            // `budget` items, take one pass to find a distance threshold by
            // sampling, then collect anything inside it. Falls back to a
            // partial sort only on the (much smaller) shortlist.
            const d2 = a => {
                const dx = a.x - cx, dy = a.y - cy, dz = a.z - cz;
                return dx * dx + dy * dy + dz * dz;
            };

            // Sample up to 3000 atoms to estimate the cut-off radius.
            const sampleStep = Math.max(1, Math.floor(total / 3000));
            const sample = [];
            for (let i = 0; i < total; i += sampleStep) sample.push(d2(atoms[i]));
            sample.sort((p, q) => p - q);
            const frac = Math.min(1, budget / total);
            // Generous cut so we do not undershoot the budget.
            let cut = sample[Math.min(sample.length - 1, Math.ceil(sample.length * frac * 1.6))] ?? Infinity;

            let shortlist = [];
            for (let i = 0; i < total; i++) {
                const a = atoms[i];
                if (d2(a) <= cut) shortlist.push(a);
            }
            // If the estimate undershot, fall back to the full set.
            if (shortlist.length < budget) shortlist = atoms;

            if (shortlist.length > budget) {
                shortlist.sort((p, q) => d2(p) - d2(q));
                shortlist = shortlist.slice(0, budget);
            }
            return { atoms: shortlist, total };
        }

        /** Progress pill shown while labels build. */
        setLabelProgress(done, total) {
            const el = this.el.labelProgress;
            if (!el) return;
            if (done >= total) { el.classList.add('hidden'); return; }
            el.classList.remove('hidden');
            const pct = total ? Math.round(done / total * 100) : 0;
            el.textContent = `Placing labels… ${formatNum(done)}/${formatNum(total)} (${pct}%)`;
        }

        /**
         * Rebuild all labels. The heavy part runs through ChunkedJob so the
         * browser keeps painting; calling this again mid-build cancels the
         * previous run rather than queueing a second one.
         */
        updateLabels() {
            if (!this.viewer) return;

            this._labelJob.cancel();
            this.viewer.removeAllLabels();
            for (const lbl of this._measureLabels) this.viewer.addLabel(lbl.text, lbl.options);
            if (this.T.axis) this.drawAxisLabels();

            const blocked = this.state.totalAtoms > PERF_LABEL_BLOCK;
            const wantAtom = this.T.atomLabels, wantRes = this.T.resLabels;

            if (!wantAtom && !wantRes) {
                this.setLabelProgress(1, 1);
                this.viewer.render();
                return;
            }

            if (blocked && !this.el.labelForce?.checked) {
                this.toast(`${formatNum(this.state.totalAtoms)} atoms, labels disabled. Isolate a region, or set scope to Selection.`, 'error');
                this.viewer.render();
                return;
            }

            const budget = parseInt(this.el.labelLimit?.value || 2000, 10);
            const queue = [];

            if (wantAtom) {
                const { atoms, total } = this.pickLabelAtoms('atom', budget);
                for (const a of atoms) {
                    queue.push({
                        text: a.elem || '?',
                        options: {
                            position: { x: a.x, y: a.y, z: a.z }, fontSize: 10, fontColor: 'white',
                            backgroundColor: 'rgba(30,41,59,.7)', backgroundOpacity: 0.7,
                            borderRadius: 4, padding: 1, showBackground: true, inFront: true
                        }
                    });
                }
                if (total > atoms.length) {
                    this.toast(`Showing ${formatNum(atoms.length)} of ${formatNum(total)} atom labels (nearest the view).`);
                }
            }

            if (wantRes) {
                const { atoms, total } = this.pickLabelAtoms('residue', budget);
                for (const a of atoms) {
                    queue.push({
                        text: `${a.resn || '?'}${a.resi ?? ''}`,
                        options: {
                            position: { x: a.x, y: a.y, z: a.z }, fontSize: 9, fontColor: '#c7d2fe',
                            backgroundColor: 'rgba(67,56,202,.75)', backgroundOpacity: 0.75,
                            borderRadius: 4, padding: 2, showBackground: true, inFront: true
                        }
                    });
                }
                if (total > atoms.length) {
                    this.toast(`Showing ${formatNum(atoms.length)} of ${formatNum(total)} residue labels (nearest the view).`);
                }
            }

            // Build in slices, repainting as we go.
            this._labelJob.run(queue,
                item => this.viewer.addLabel(item.text, item.options),
                {
                    chunk: LABEL_CHUNK,
                    onProgress: (done, total) => {
                        this.setLabelProgress(done, total);
                        this.viewer.render();          // incremental reveal
                    },
                    onDone: () => {
                        this.setLabelProgress(1, 1);
                        this.viewer.render();
                    }
                });
        }

        /** Axis letters, re-added separately since removeAllLabels clears them. */
        drawAxisLabels() {
            const b = this.state.bounds;
            const ox = b.xMin - 6, oy = b.yMin - 6, oz = b.zMin - 6, len = 4;
            const axes = [
                { d: { x: len, y: 0, z: 0 }, c: '#ef4444', l: 'X' },
                { d: { x: 0, y: len, z: 0 }, c: '#22c55e', l: 'Y' },
                { d: { x: 0, y: 0, z: len }, c: '#3b82f6', l: 'Z' }
            ];
            for (const { d, c, l } of axes) {
                this.viewer.addLabel(l, {
                    position: { x: ox + d.x * 1.2, y: oy + d.y * 1.2, z: oz + d.z * 1.2 },
                    fontSize: 12, fontColor: c, backgroundColor: 'transparent',
                    showBackground: false, inFront: true
                });
            }
        }

        // ───────────────────────────────────────────────────────────
        // AXIS INDICATOR
        // ───────────────────────────────────────────────────────────
        drawAxisIndicator() {
            this.removeAxisIndicator();
            if (!this.viewer || !this.T.axis) return;
            const b = this.state.bounds;
            const ox = b.xMin - 6, oy = b.yMin - 6, oz = b.zMin - 6, len = 4;
            const axes = [
                { d: { x: len, y: 0, z: 0 }, c: '#ef4444', l: 'X' },
                { d: { x: 0, y: len, z: 0 }, c: '#22c55e', l: 'Y' },
                { d: { x: 0, y: 0, z: len }, c: '#3b82f6', l: 'Z' }
            ];
            for (const { d, c, l } of axes) {
                this._shapes.axis.push(this.viewer.addArrow({
                    start: { x: ox, y: oy, z: oz },
                    end: { x: ox + d.x, y: oy + d.y, z: oz + d.z },
                    radius: 0.15, color: c, radiusRatio: 2.5, mid: 0.75
                }));
            }
            this.drawAxisLabels();
            this.viewer.render();
        }

        removeAxisIndicator() {
            for (const s of this._shapes.axis) {
                try { this.viewer.removeShape(s); } catch (e) { /* already gone */ }
            }
            this._shapes.axis = [];
        }

        // ───────────────────────────────────────────────────────────
        // SURFACE
        // ───────────────────────────────────────────────────────────
        surfType() {
            const v = this.el.surfaceType.value;
            if (v === 'SAS') return $3Dmol.SurfaceType.SAS;
            if (v === 'SES') return $3Dmol.SurfaceType.SES;
            if (v === 'MS') return $3Dmol.SurfaceType.MS;
            return $3Dmol.SurfaceType.VDW;
        }

        surfColorSpec() {
            const s = this.el.surfaceColorScheme.value;
            if (s === 'element') return { colorscheme: 'Jmol' };
            if (s === 'chain') return { colorscheme: 'chain' };
            if (s === 'bFactor') return { colorscheme: 'bFactor' };
            if (s === 'spectrum') return { color: 'spectrum' };
            if (s === 'custom') return { color: this.el.surfaceCustomColor.value };
            return { color: 'white' };
        }

        addSurface() {
            if (!this.viewer) return;
            // Surfaces are expensive; warn and scope to the selection when huge.
            const useSel = this.el.surfaceSelOnly?.checked && this.state.lastSelection;
            const target = useSel ? this.state.lastSelection : {};
            const n = this.countSelection(target);
            if (n > 100000) {
                this.toast('Too many atoms for a surface. Isolate a selection first.', 'error');
                return;
            }
            const build = () => {
                try {
                    this.surfaceID = this.viewer.addSurface(this.surfType(), {
                        opacity: parseFloat(this.el.surfaceOpacity.value),
                        ...this.surfColorSpec()
                    }, target);
                    this.viewer.render();
                } catch (err) {
                    console.error(err);
                    this.toast('Surface generation failed, try a smaller selection.', 'error');
                } finally {
                    this.setBusy(false);
                }
            };

            if (n > 15000) {
                // Surface meshing is a single synchronous call inside 3Dmol, so
                // it cannot be chunked. What we can do is paint a busy state
                // first, then start the work on the next frame, the user sees
                // feedback instead of a dead tab.
                this.setBusy(true, 'Building surface, this can take a few seconds…');
                requestAnimationFrame(() => requestAnimationFrame(build));
            } else {
                build();
            }
        }

        /** Full-viewport busy overlay for unavoidable synchronous work. */
        setBusy(on, msg) {
            const el = this.el.busyOverlay;
            if (!el) return;
            el.classList.toggle('hidden', !on);
            if (on && msg) {
                const t = this.el.busyText;
                if (t) t.textContent = msg;
            }
        }

        removeSurface() {
            if (!this.viewer || this.surfaceID === null) return;
            try { this.viewer.removeSurface(this.surfaceID); } catch (e) { /* noop */ }
            this.surfaceID = null;
        }

        refreshSurface() {
            if (this.surfaceID === null) return;
            this.removeSurface();
            this.addSurface();
        }

        // ───────────────────────────────────────────────────────────
        // SLAB / OUTLINE
        // ───────────────────────────────────────────────────────────
        applySlab() {
            if (!this.viewer) return;
            const n = parseInt(this.el.slabNear.value, 10), f = parseInt(this.el.slabFar.value, 10);
            this.el.slabNearVal.textContent = n === -100 ? 'Off' : n;
            this.el.slabFarVal.textContent = f === 100 ? 'Off' : f;
            this.viewer.setSlab(n, f);
            this.viewer.render();
        }

        applyOutline() {
            if (!this.viewer) return;
            if (this.T.outline) this.viewer.setViewStyle({ style: 'outline', color: 'black', width: 0.02 });
            else this.viewer.setViewStyle({});
            this.viewer.render();
        }

        // ───────────────────────────────────────────────────────────
        // CLICK INSPECT + MEASUREMENT
        // ───────────────────────────────────────────────────────────
        setupClickInspect() {
            if (!this.viewer) return;
            this.viewer.setClickable({}, true, atom => {
                if (this.state.measureMode) { this.handleMeasureClick(atom); return; }
                if (!this.T.clickInspect) return;
                this.showAtomInfo(atom);
            });
        }

        showAtomInfo(atom) {
            // Every field below originates in a user-supplied file, so all of it
            // is escaped before it reaches innerHTML.
            const parts = [`<b>${escapeHTML(atom.elem)}</b>`];
            if (atom.atom) parts.push(`, ${escapeHTML(atom.atom)}`);
            const rows = [];
            if (atom.resn) rows.push(`Res: ${escapeHTML(atom.resn)} ${escapeHTML(atom.resi ?? '')}`);
            if (atom.chain) rows.push(`Chain: ${escapeHTML(atom.chain)}`);
            rows.push(`Pos: (${atom.x.toFixed(2)}, ${atom.y.toFixed(2)}, ${atom.z.toFixed(2)})`);
            if (typeof atom.b === 'number' && atom.b) rows.push(`B: ${atom.b.toFixed(2)}`);
            if (atom.serial !== undefined) rows.push(`Serial: ${escapeHTML(atom.serial)}`);
            if (atom.ss) rows.push(`SS: ${escapeHTML(atom.ss)}`);

            this.el.atomInfo.innerHTML = parts.join('') + '<br>' + rows.join('<br>');
            this.el.atomInfo.classList.add('visible');
            clearTimeout(this._atomInfoTimer);
            this._atomInfoTimer = setTimeout(() => this.el.atomInfo.classList.remove('visible'), 5000);
        }

        setMeasureMode(on) {
            this.state.measureMode = on;
            this.state.measureAtoms = [];
            const btn = this.el.measureModeBtn;
            btn.style.background = on ? '#f59e0b' : '';
            btn.style.color = on ? '#fff' : '';
            this.el.modeBadge.classList.toggle('hidden', !on);
            this.el.modeBadge.classList.toggle('measure', on);
            this.el.modeBadge.textContent = on
                ? (this.el.measureMode3?.checked ? 'Measure Mode (Angle (3 atoms)' : 'Measure Mode) Distance (2 atoms)')
                : '';
        }

        handleMeasureClick(atom) {
            const wantAngle = !!this.el.measureMode3?.checked;
            const need = wantAngle ? 3 : 2;
            this.state.measureAtoms.push(atom);

            // Provisional marker for the atom just picked.
            const ms = this.state.measureStyle;
            this._shapes.measure.push(this.viewer.addSphere({
                center: { x: atom.x, y: atom.y, z: atom.z },
                radius: ms.markerSize, color: ms.markerColor, opacity: 0.85
            }));
            this.viewer.render();

            if (this.state.measureAtoms.length < need) return;

            const picks = this.state.measureAtoms.slice();
            const record = { atoms: picks, kind: wantAngle ? 'angle' : 'distance' };

            if (wantAngle) {
                const [a, b, c] = picks;
                const v1 = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
                const v2 = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
                const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
                const m1 = Math.hypot(v1.x, v1.y, v1.z), m2 = Math.hypot(v2.x, v2.y, v2.z);
                record.value = Math.acos(Math.max(-1, Math.min(1, dot / (m1 * m2)))) * 180 / Math.PI;
            } else {
                record.value = Math.sqrt(dist2(picks[0], picks[1]));
            }

            this.state.measurements.push(record);
            this.state.measureAtoms = [];
            this.redrawMeasurements();
            if (this.state.measureFocus) this.applyMeasureFocus();
        }

        /** Format a measurement's value using the current display settings. */
        measureText(rec) {
            const ms = this.state.measureStyle;
            if (rec.kind === 'angle') {
                return `${rec.value.toFixed(ms.decimals)}${ms.showUnit ? '°' : ''}`;
            }
            const nm = this.el.spatialUnit.value === 'nm';
            const v = nm ? rec.value / 10 : rec.value;
            return `${v.toFixed(ms.decimals)}${ms.showUnit ? (nm ? ' nm' : ' Å') : ''}`;
        }

        /**
         * Rebuild every measurement shape and label from the stored records.
         * Driving the overlay from data (rather than mutating it in place)
         * means appearance changes re-render instantly and correctly.
         */
        redrawMeasurements() {
            if (!this.viewer) return;
            const ms = this.state.measureStyle;

            for (const s of this._shapes.measure) {
                try { this.viewer.removeShape(s); } catch (e) { /* noop */ }
            }
            this._shapes.measure = [];
            this._measureLabels = [];

            for (const rec of this.state.measurements) {
                const pts = rec.atoms;

                for (const p of pts) {
                    this._shapes.measure.push(this.viewer.addSphere({
                        center: { x: p.x, y: p.y, z: p.z },
                        radius: ms.markerSize, color: ms.markerColor, opacity: 0.85
                    }));
                }

                const segs = rec.kind === 'angle'
                    ? [[pts[0], pts[1]], [pts[1], pts[2]]]
                    : [[pts[0], pts[1]]];
                for (const [p, q] of segs) {
                    this._shapes.measure.push(this.viewer.addCylinder({
                        start: { x: p.x, y: p.y, z: p.z },
                        end: { x: q.x, y: q.y, z: q.z },
                        radius: ms.lineWidth, color: ms.lineColor,
                        dashed: ms.dashed, fromCap: true, toCap: true
                    }));
                }

                const anchor = rec.kind === 'angle'
                    ? pts[1]
                    : { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2, z: (pts[0].z + pts[1].z) / 2 };

                const options = {
                    position: { x: anchor.x, y: anchor.y, z: anchor.z },
                    fontSize: ms.labelSize, fontColor: ms.labelColor,
                    backgroundColor: ms.labelBg, backgroundOpacity: ms.showBg ? 0.85 : 0,
                    showBackground: ms.showBg, borderRadius: 4, padding: 2, inFront: true
                };
                const text = this.measureText(rec);
                // Recorded as data only. `updateLabels` clears the viewer's
                // labels before re-adding these, so adding here as well would
                // leave the previous copy in place, every change of decimals,
                // units or zoom then stacked another label on the last one.
                this._measureLabels.push({ text, options });
            }

            this.renderMeasureList();
            this.updateLabels();
        }

        atomTag(a) {
            // e.g. "CA ALA1/A", atom name, residue, then chain after a slash.
            const head = a.atom || a.elem || '?';
            let tag = head;
            if (a.resn) tag += ` ${a.resn}${a.resi ?? ''}`;
            else if (a.serial !== undefined) tag += ` #${a.serial}`;
            if (a.chain) tag += `/${a.chain}`;
            return tag;
        }

        /** Readout panel, rebuilt from records with DOM nodes (no innerHTML). */
        renderMeasureList() {
            const box = this.el.measureInfo;
            if (!box) return;
            box.textContent = '';
            this.state.measurements.forEach((rec, i) => {
                const row = document.createElement('div');
                row.className = 'measure-row';

                const label = rec.kind === 'angle'
                    ? rec.atoms.map(a => this.atomTag(a)).join(' – ')
                    : `${this.atomTag(rec.atoms[0])} ↔ ${this.atomTag(rec.atoms[1])}`;

                const txt = document.createElement('span');
                txt.appendChild(document.createTextNode(label + ': '));
                const strong = document.createElement('b');
                strong.textContent = this.measureText(rec);
                txt.appendChild(strong);

                const del = document.createElement('button');
                del.className = 'measure-del';
                del.textContent = '×';
                del.title = 'Remove this measurement';
                del.addEventListener('click', () => {
                    this.state.measurements.splice(i, 1);
                    this.redrawMeasurements();
                    if (this.state.measureFocus) this.applyMeasureFocus();
                });

                row.append(txt, del);
                box.appendChild(row);
            });
        }

        /**
         * Focus mode: draw everything except the measured atoms in a muted
         * context style, so the measurement reads clearly in a figure.
         */
        applyMeasureFocus() {
            if (!this.viewer) return;
            const ms = this.state.measureStyle;

            if (!this.state.measureFocus) { this.applyStyles(); return; }

            const picked = this.state.measurements.flatMap(r => r.atoms);
            if (!picked.length) { this.applyStyles(); return; }

            const idx = new Set(picked.map(a => a.index));
            const resKeys = new Set(picked.map(a => `${a.chain || ''}_${a.resi ?? ''}`));
            const wholeRes = !!this.el.measureFocusRes?.checked;

            const inFocus = a => idx.has(a.index) ||
                (wholeRes && resKeys.has(`${a.chain || ''}_${a.resi ?? ''}`));

            // Muted context
            const ctxColor = this.el.measureContextColor?.value || '#94a3b8';
            const op = parseFloat(ms.contextOpacity);
            let ctxStyle;
            if (ms.contextStyle === 'hide') ctxStyle = { hidden: true };
            else if (ms.contextStyle === 'wire') ctxStyle = { line: { color: ctxColor, opacity: op } };
            else if (ms.contextStyle === 'cartoon') ctxStyle = { cartoon: { color: ctxColor, opacity: op } };
            else ctxStyle = { stick: { radius: 0.06, color: ctxColor, opacity: op } };

            this.viewer.setStyle({}, ctxStyle);

            // The measured atoms keep the main representation, at full strength.
            const focusSel = { predicate: inFocus };
            this.applyStyledSelection(focusSel, this.el.styleSelect.value, 'add');

            if (!this.T.hydrogens) this.viewer.addStyle({ elem: 'H' }, { hidden: true });
            this.redrawMeasurements();
        }

        setMeasureFocus(on) {
            this.state.measureFocus = on;
            this.el.measureFocusPanel?.classList.toggle('hidden', !on);
            this.applyMeasureFocus();
        }

        /** Zoom to fit just the measured atoms. */
        zoomToMeasurements() {
            const picked = this.state.measurements.flatMap(r => r.atoms);
            if (!picked.length) { this.toast('No measurements to zoom to.', 'error'); return; }
            const idx = new Set(picked.map(a => a.index));
            this.viewer.zoomTo({ predicate: a => idx.has(a.index) });
            this.viewer.render();
        }

        /** Copy all measurements as tab-separated text for a paper or notebook. */
        copyMeasurements() {
            if (!this.state.measurements.length) { this.toast('No measurements yet.', 'error'); return; }
            const unit = this.el.spatialUnit.value === 'nm' ? 'nm' : 'Angstrom';
            const lines = ['type\tatoms\tvalue\tunit'];
            for (const rec of this.state.measurements) {
                const tag = rec.atoms.map(a => this.atomTag(a)).join(' | ');
                const nm = this.el.spatialUnit.value === 'nm';
                const val = rec.kind === 'angle' ? rec.value : (nm ? rec.value / 10 : rec.value);
                lines.push(`${rec.kind}\t${tag}\t${val.toFixed(this.state.measureStyle.decimals)}\t${rec.kind === 'angle' ? 'degrees' : unit}`);
            }
            const text = lines.join('\n');
            const done = () => this.toast(`Copied ${this.state.measurements.length} measurement(s).`, 'success');
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(done).catch(() => this.fallbackCopy(text, done));
            } else {
                this.fallbackCopy(text, done);
            }
        }

        fallbackCopy(text, done) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); done(); }
            catch (e) { this.toast('Could not copy.', 'error'); }
            ta.remove();
        }

        clearMeasurements() {
            if (!this.viewer) return;
            for (const s of this._shapes.measure) {
                try { this.viewer.removeShape(s); } catch (e) { /* noop */ }
            }
            this._shapes.measure = [];
            this._measureLabels = [];
            this.state.measureAtoms = [];
            this.state.measurements = [];
            this.renderMeasureList();
            this.viewer.removeAllLabels();
            this.updateLabels();
            if (this.T.axis) this.drawAxisIndicator();
            if (this.state.measureFocus) this.applyMeasureFocus();
            this.viewer.render();
        }

        // ───────────────────────────────────────────────────────────
        // EXPORT
        // ───────────────────────────────────────────────────────────

        /** Largest texture the GPU will accept, cached after first query. */
        maxTextureSize() {
            if (this._maxTex) return this._maxTex;
            try {
                const c = document.createElement('canvas');
                const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
                this._maxTex = gl ? Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), MAX_EXPORT_PX) : SAFE_EXPORT_PX;
            } catch (e) {
                this._maxTex = SAFE_EXPORT_PX;
            }
            return this._maxTex;
        }

        /** Highest multiplier that keeps both canvas dimensions within GPU limits. */
        safeMultiplier(requested) {
            const canvas = this.el.viewerCanvas.querySelector('canvas');
            if (!canvas) return 1;
            const limit = this.maxTextureSize();
            const maxByWidth = Math.floor(limit / canvas.width);
            const maxBySide = Math.floor(limit / canvas.height);
            return Math.max(1, Math.min(requested, maxByWidth, maxBySide));
        }

        updateExportNote() {
            if (!this.el.exportNote) return;
            const canvas = this.el.viewerCanvas.querySelector('canvas');
            if (!canvas) { this.el.exportNote.textContent = ''; return; }
            const requested = parseInt(this.el.exportQuality.value, 10) || 2;
            const safe = this.safeMultiplier(requested);
            const w = canvas.width * safe, h = canvas.height * safe;
            this.el.exportNote.textContent = safe < requested
                ? `Clamped to ${safe}× (${w}×${h} px), your GPU limit is ${this.maxTextureSize()} px.`
                : `Output: ${w} × ${h} px`;
        }

        /**
         * Render the scene at a higher resolution and return it as a canvas.
         *
         * 3Dmol sizes its WebGL canvas from the *container*, so setting
         * `canvas.width` directly does nothing useful: the very next
         * `viewer.resize()` recomputes it from the container and the requested
         * multiplier is silently thrown away. The container is what has to
         * grow.
         *
         * Device pixel ratio matters too. On a HiDPI screen the on-screen
         * canvas is already dpr times its CSS size, so exporting at the CSS
         * size alone produces a file visibly softer than what is on screen , 
         * which is exactly the complaint this addresses. The multiplier is
         * applied on top of dpr.
         *
         * The container is parked off-screen while it is oversized, so the
         * page does not visibly jump or grow scrollbars mid-export.
         */
        captureCanvas(mult) {
            const host = this.el.viewerCanvas;
            const canvas = host && host.querySelector('canvas');
            if (!canvas) throw new Error('No canvas');

            const scale = Math.max(1, mult);
            // 3Dmol multiplies the container size by the device pixel ratio
            // when it sizes the drawing buffer, so the exported file ends up
            // at scale × dpr, matching, then exceeding, on-screen sharpness.
            if (scale <= 1) return canvas;

            const rect = host.getBoundingClientRect();
            const cssW = Math.max(1, Math.round(rect.width));
            const cssH = Math.max(1, Math.round(rect.height));

            const prev = {
                width: host.style.width,
                height: host.style.height,
                position: host.style.position,
                left: host.style.left,
                top: host.style.top,
                zIndex: host.style.zIndex
            };

            host.style.position = 'fixed';
            host.style.left = '-100000px';
            host.style.top = '0';
            host.style.zIndex = '-1';
            host.style.width = `${cssW * scale}px`;
            host.style.height = `${cssH * scale}px`;

            let out;
            try {
                this.viewer.resize();
                this.viewer.render();

                out = document.createElement('canvas');
                out.width = canvas.width;
                out.height = canvas.height;
                out.getContext('2d').drawImage(canvas, 0, 0);
            } finally {
                // Restore in a finally block: leaving the viewer parked
                // off-screen because an export failed would take the tool down
                // with it.
                Object.assign(host.style, prev);
                this.viewer.resize();
                this.viewer.render();
            }
            return out;
        }

        exportPNG() {
            if (!this.viewer) return;
            const requested = parseInt(this.el.exportQuality.value, 10) || 2;
            const mult = this.safeMultiplier(requested);
            if (mult < requested) {
                this.toast(`Clamped to ${mult}×, ${requested}× exceeds this GPU's texture limit.`);
            } else {
                this.toast(`Generating ${mult}× PNG…`);
            }

            setTimeout(() => {
                let dataURL = null;
                try {
                    dataURL = this.captureCanvas(mult).toDataURL('image/png');
                } catch (err) {
                    console.warn('Manual capture failed, falling back to pngURI():', err);
                    try { dataURL = this.viewer.pngURI(); } catch (e2) { console.error(e2); }
                }
                if (!dataURL) { this.toast('Export failed.', 'error'); return; }
                const a = document.createElement('a');
                a.download = `${this.baseName()}_${mult}x.png`;
                a.href = dataURL;
                a.click();
                this.toast(`PNG ${mult}× saved.`, 'success');
            }, 50);
        }

        /** Write the current selection out as a PDB fragment. */
        exportSelectionPDB() {
            if (!this.viewer) return;
            const sel = this.state.lastSelection || {};
            const atoms = this.viewer.getModel().selectedAtoms(sel);
            if (!atoms.length) { this.toast('Nothing selected to export.', 'error'); return; }

            const lines = atoms.map((a, i) => {
                const serial = String(i + 1).padStart(5);
                const name = String(a.atom || a.elem || 'X').padEnd(4).slice(0, 4);
                const resn = String(a.resn || 'UNK').padStart(3).slice(0, 3);
                const chain = String(a.chain || 'A').slice(0, 1);
                const resi = String(a.resi ?? 1).padStart(4);
                const x = a.x.toFixed(3).padStart(8);
                const y = a.y.toFixed(3).padStart(8);
                const z = a.z.toFixed(3).padStart(8);
                const b = (a.b ?? 0).toFixed(2).padStart(6);
                const el = String(a.elem || '').padStart(2);
                return `ATOM  ${serial} ${name} ${resn} ${chain}${resi}    ${x}${y}${z}  1.00${b}          ${el}`;
            });
            lines.push('END');

            const blob = new Blob([lines.join('\n')], { type: 'chemical/x-pdb' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.download = `${this.baseName()}_selection.pdb`;
            a.href = url;
            a.click();
            URL.revokeObjectURL(url);
            this.toast(`Exported ${formatNum(atoms.length)} atoms.`, 'success');
        }

        // ───────────────────────────────────────────────────────────
        // TRAJECTORY
        // ───────────────────────────────────────────────────────────
        setFrame(f) {
            if (!this.viewer) return;
            this.viewer.setFrame(f);
            this.viewer.render();
            this.el.trajFrame.textContent = `${f + 1}/${parseInt(this.el.trajSlider.max, 10) + 1}`;
        }

        toggleTrajectoryPlay() {
            if (this.state.trajPlaying) {
                clearInterval(this._trajInterval);
                this.state.trajPlaying = false;
                this.el.trajPlay.innerHTML = '<i class="fa-solid fa-play mr-1"></i>Play';
                return;
            }
            this.state.trajPlaying = true;
            this.el.trajPlay.innerHTML = '<i class="fa-solid fa-pause mr-1"></i>Pause';
            const speed = parseInt(this.el.trajSpeed.value, 10) || 100;
            this._trajInterval = setInterval(() => {
                let f = parseInt(this.el.trajSlider.value, 10) + 1;
                if (f > parseInt(this.el.trajSlider.max, 10)) f = 0;
                this.el.trajSlider.value = f;
                this.setFrame(f);
            }, speed);
        }

        // ───────────────────────────────────────────────────────────
        // ISOSURFACE
        // ───────────────────────────────────────────────────────────
        renderIsosurface() {
            if (!this.viewer || !this.currentModelData || this.currentExtension !== 'cube') return;
            this.clearIsosurfaces();
            try {
                const vol = new $3Dmol.VolumeData(this.currentModelData, 'cube');
                const op = parseFloat(this.el.isoOpacity.value);
                this._shapes.iso.push(this.viewer.addIsosurface(vol, {
                    isoval: parseFloat(this.el.isoPosVal.value), color: '#3b82f6', opacity: op
                }));
                this._shapes.iso.push(this.viewer.addIsosurface(vol, {
                    isoval: parseFloat(this.el.isoNegVal.value), color: '#ef4444', opacity: op
                }));
                this.viewer.render();
                this.toast('Isosurface rendered.', 'success');
            } catch (err) {
                console.error(err);
                this.toast('Error rendering isosurface.', 'error');
            }
        }

        clearIsosurfaces() {
            for (const s of this._shapes.iso) {
                try { this.viewer.removeShape(s); } catch (e) { /* noop */ }
            }
            this._shapes.iso = [];
        }

        // ───────────────────────────────────────────────────────────
        // RESET
        // ───────────────────────────────────────────────────────────
        reset() {
            if (this.viewer) {
                this.viewer.spin(false);
                this.viewer.removeAllLabels();
                this.viewer.removeAllShapes();
                this.removeSurface();
                this.viewer.clear();
            }
            clearInterval(this._trajInterval);
            this.state.trajPlaying = false;
            this.state.bounds = { xMin: 0, xMax: 0, yMin: 0, yMax: 0, zMin: 0, zMax: 0 };
            this.state.totalAtoms = 0;
            this.state.selectionOverrides = [];
            this.state.lastSelection = null;
            this.state.measureAtoms = [];
            this.surfaceID = null;
            this.currentModelData = null;
            this.currentExtension = null;
            this._shapes = { axis: [], iso: [], measure: [] };
            this._measureLabels = [];
            this.state.measurements = [];
            this._labelJob.cancel();
            this.setBusy(false);
            this.setLabelProgress(1, 1);
            if (this.state.measureFocus && this.el.measureFocusToggle) {
                this.el.measureFocusToggle.checked = false;
                this.state.measureFocus = false;
                this.el.measureFocusPanel?.classList.add('hidden');
            }

            this.el.formatBadge.textContent = '';
            this.el.atomInfo.classList.remove('visible');
            this.el.atomInfo.textContent = '';
            this.el.measureInfo.textContent = '';
            this.el.perfWarning.classList.add('hidden');
            this.el.enableCrossAxis.checked = false;
            this.el.crossAxisControls.classList.add('hidden');
            this.el.spatialMode.value = '';
            this.el.spatialControls.classList.add('hidden');
            this.el.uploadZone.classList.remove('hidden');
            this.el.workspace.classList.add('hidden');
            this.el.workspace.classList.remove('flex');
            this.el.fileInput.value = '';
            if (this.state.measureMode) this.setMeasureMode(false);
        }

        // ───────────────────────────────────────────────────────────
        // THEME
        // ───────────────────────────────────────────────────────────
        initTheme() {
            let stored = null;
            try { stored = localStorage.getItem('theme'); } catch (e) { /* private mode */ }
            document.documentElement.classList.toggle('dark', stored === 'dark');
        }

        // ───────────────────────────────────────────────────────────
        // TOGGLE HELPER
        // ───────────────────────────────────────────────────────────
        setupToggle(el, key, fn) {
            if (!el) return;
            const flip = () => {
                this.T[key] = !this.T[key];
                el.classList.toggle('active', this.T[key]);
                el.setAttribute('aria-checked', String(this.T[key]));
                if (fn) fn(this.T[key]);
            };
            el.addEventListener('click', flip);
            el.addEventListener('keydown', e => {
                if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
            });
        }

        // ───────────────────────────────────────────────────────────
        // EVENT WIRING
        // ───────────────────────────────────────────────────────────
        bindEvents() {
            const e = this.el;

            // ---- Upload ----
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt =>
                e.uploadZone.addEventListener(evt, ev => { ev.preventDefault(); ev.stopPropagation(); }));
            e.uploadZone.addEventListener('dragover', () => e.uploadZone.classList.add('border-indigo-500'));
            e.uploadZone.addEventListener('dragleave', () => e.uploadZone.classList.remove('border-indigo-500'));
            e.uploadZone.addEventListener('drop', ev => {
                e.uploadZone.classList.remove('border-indigo-500');
                this.handleFile(ev.dataTransfer.files[0]);
            });
            e.uploadZone.addEventListener('click', ev => {
                if (ev.target.closest('#pdbIdInput') || ev.target.closest('#fetchPdbBtn')) return;
                e.fileInput.click();
            });
            e.fileInput.addEventListener('change', ev => this.handleFile(ev.target.files[0]));
            e.fetchPdbBtn.addEventListener('click', () => this.fetchPdb());
            e.pdbIdInput.addEventListener('keydown', ev => {
                if (ev.key === 'Enter') { ev.preventDefault(); this.fetchPdb(); }
            });

            // ---- Tabs ----
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
                    btn.classList.add('active');
                    $(btn.dataset.tab)?.classList.remove('hidden');
                });
            });

            // ---- Theme ----
            document.querySelectorAll('.themeToggle').forEach(b => b.addEventListener('click', () => {
                document.documentElement.classList.toggle('dark');
                try {
                    localStorage.setItem('theme',
                        document.documentElement.classList.contains('dark') ? 'dark' : 'light');
                } catch (err) { /* private mode */ }
                if (e.bgSelect.value === 'theme') this.applyBackground();
            }));

            // ---- Mobile menu ----
            const mmb = $('mobile-menu-btn'), mm = $('mobile-menu'), mi = $('menu-icon');
            if (mmb) {
                mmb.addEventListener('click', () => {
                    mm.classList.toggle('hidden');
                    mi.classList.toggle('fa-bars');
                    mi.classList.toggle('fa-xmark');
                });
                document.querySelectorAll('.mobile-link').forEach(l => l.addEventListener('click', () => {
                    mm.classList.add('hidden');
                    mi.classList.add('fa-bars');
                    mi.classList.remove('fa-xmark');
                }));
            }

            // ---- Style / colour ----
            e.colorSelect.addEventListener('change', () => {
                e.perElementColorContainer.classList.toggle('hidden', e.colorSelect.value !== 'custom');
                this.applyStyles();
            });
            e.styleSelect.addEventListener('change', () => this.applyStyles());
            e.bgSelect.addEventListener('change', () => this.applyBackground());

            // ---- Selection styling (Style tab) ----
            const selAdvToggle = $('selAdvancedToggle'), selAdvPanel = $('selAdvancedPanel'),
                  selAdvIcon = $('selAdvancedIcon');
            selAdvToggle?.addEventListener('click', () => {
                selAdvPanel.classList.toggle('hidden');
                selAdvIcon.style.transform = selAdvPanel.classList.contains('hidden') ? '' : 'rotate(180deg)';
            });

            e.applySelStyle.addEventListener('click', () => {
                if (!this.viewer) return;
                const sel = this.buildSelStyleSelection();
                const styleType = e.selStyle.value;
                const colorEl = $('selStyleColor');
                const useCustom = $('selStyleUseColor')?.checked;
                const override = { sel, styleType };
                if (useCustom && colorEl) override.color = colorEl.value;

                const n = this.countSelection(sel);
                if (!n) { this.toast('That selection matches no atoms.', 'error'); return; }

                this.state.selectionOverrides.push(override);
                if (styleType === 'hidden') this.viewer.addStyle(sel, { hidden: true });
                else if (override.color) this.viewer.addStyle(sel, this.buildStyleObj(styleType, { color: override.color }));
                else this.applyStyledSelection(sel, styleType, 'add');

                if (!this.T.hydrogens) this.viewer.setStyle({ elem: 'H' }, { hidden: true });
                this.viewer.render();
                this.toast(`Style applied to ${formatNum(n)} atoms.`, 'success');
            });

            e.clearSelStyles.addEventListener('click', () => {
                this.state.selectionOverrides = [];
                this.applyStyles();
                this.toast('Selection styles cleared.');
            });

            $('selStyleUseColor')?.addEventListener('change', ev => {
                $('selStyleColor')?.classList.toggle('hidden', !ev.target.checked);
            });

            // ---- Spatial controls ----
            e.spatialMode.addEventListener('change', () => {
                const mode = e.spatialMode.value;
                e.spatialControls.classList.toggle('hidden', !mode);
                e.spatialRangeControls.classList.add('hidden');
                e.spatialCenterControls.classList.add('hidden');
                e.spatialSurfaceControls.classList.add('hidden');
                if (mode === 'range') e.spatialRangeControls.classList.remove('hidden');
                else if (mode === 'center') e.spatialCenterControls.classList.remove('hidden');
                else if (mode === 'top' || mode === 'bottom') e.spatialSurfaceControls.classList.remove('hidden');
                if (mode) this.updateSpatialSliders();
                this.autoIsolateIfNeeded();
            });

            e.spatialAxis.addEventListener('change', () => {
                if (e.spatialMode.value) this.updateSpatialSliders();
                this.autoIsolateIfNeeded();
            });

            e.spatialUnit.addEventListener('change', () => {
                if (e.spatialMode.value) this.updateSpatialSliders();
            });

            // Slider handling: labels update on every `input` event (cheap DOM
            // writes), the WebGL re-render is throttled to one per frame, and a
            // final settle pass runs on `change` (mouse release).
            const heavyUpdate = rafThrottle(() => this.autoIsolateIfNeeded());

            const bindRange = (els, labelFn) => {
                els.filter(Boolean).forEach(el => {
                    el.addEventListener('input', () => { labelFn(); heavyUpdate(); });
                    el.addEventListener('change', () => { labelFn(); this.autoIsolateIfNeeded(); });
                });
            };

            bindRange([e.spatialFrom, e.spatialTo], () => {
                const u = this.unitLabel();
                e.spatialFromVal.textContent = parseFloat(e.spatialFrom.value).toFixed(1) + ' ' + u;
                e.spatialToVal.textContent = parseFloat(e.spatialTo.value).toFixed(1) + ' ' + u;
            });

            bindRange([e.spatialCenter, e.spatialWidth], () => {
                const u = this.unitLabel();
                e.spatialCenterVal.textContent = parseFloat(e.spatialCenter.value).toFixed(1) + ' ' + u;
                e.spatialWidthVal.textContent = parseFloat(e.spatialWidth.value).toFixed(1) + ' ' + u;
            });

            bindRange([e.spatialDepth], () => {
                e.spatialDepthVal.textContent =
                    parseFloat(e.spatialDepth.value).toFixed(1) + ' ' + this.unitLabel();
            });

            bindRange([e.crossA_from, e.crossA_to, e.crossB_from, e.crossB_to], () => {
                const u = this.unitLabel();
                e.crossA_fromVal.textContent = parseFloat(e.crossA_from.value).toFixed(1) + ' ' + u;
                e.crossA_toVal.textContent = parseFloat(e.crossA_to.value).toFixed(1) + ' ' + u;
                e.crossB_fromVal.textContent = parseFloat(e.crossB_from.value).toFixed(1) + ' ' + u;
                e.crossB_toVal.textContent = parseFloat(e.crossB_to.value).toFixed(1) + ' ' + u;
            });

            e.enableCrossAxis.addEventListener('change', () => {
                e.crossAxisControls.classList.toggle('hidden', !e.enableCrossAxis.checked);
                if (e.enableCrossAxis.checked) this.updateCrossAxisSliders();
                this.autoIsolateIfNeeded();
            });

            // Within-distance slider
            if (e.buildWithin) {
                bindRange([e.buildWithin], () => {
                    const v = parseFloat(e.buildWithin.value);
                    e.buildWithinVal.textContent = v > 0 ? v.toFixed(1) + ' ' + this.unitLabel() : 'off';
                });
            }

            // ---- Selection builder ----
            e.guiIsolateBtn?.addEventListener('click', () => this.executeGuiSelection('isolate'));
            e.guiZoomBtn?.addEventListener('click', () => this.executeGuiSelection('zoom'));
            e.guiHighlightBtn?.addEventListener('click', () => this.executeGuiSelection('highlight'));
            document.querySelectorAll('.interactive-select').forEach(sel =>
                sel.addEventListener('change', () => this.autoIsolateIfNeeded()));
            e.buildResi?.addEventListener('change', () => this.autoIsolateIfNeeded());
            e.buildNot?.addEventListener('change', () => this.autoIsolateIfNeeded());
            e.buildByres?.addEventListener('change', () => this.autoIsolateIfNeeded());

            document.querySelectorAll('.reset-view-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.state.selectionOverrides = [];
                    this.state.lastSelection = null;
                    this.applyStyles();
                    e.selectionCount?.classList.add('hidden');
                    if (this.viewer) { this.viewer.zoomTo(); this.viewer.render(); }
                });
            });

            // ---- Advanced query ----
            e.focusBtn?.addEventListener('click', () => this.runQuery('zoom'));
            e.isolateBtn?.addEventListener('click', () => this.runQuery('isolate'));
            e.focusQuery?.addEventListener('keydown', ev => {
                if (ev.key === 'Enter') { ev.preventDefault(); this.runQuery('isolate'); }
            });
            $('exportSelBtn')?.addEventListener('click', () => this.exportSelectionPDB());

            document.querySelectorAll('.sel-guide-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const content = btn.nextElementSibling;
                    const icon = btn.querySelector('i');
                    content.classList.toggle('hidden');
                    if (icon) icon.style.transform = content.classList.contains('hidden') ? '' : 'rotate(180deg)';
                });
            });

            // Clickable example chips in the syntax guide
            document.querySelectorAll('.query-example').forEach(chip => {
                chip.addEventListener('click', () => {
                    if (!e.focusQuery) return;
                    e.focusQuery.value = chip.dataset.query || chip.textContent.trim();
                    e.focusQuery.focus();
                });
            });

            // ---- Labels ----
            if (e.labelLimit) {
                const relabel = debounce(() => {
                    if (this.T.atomLabels || this.T.resLabels) this.updateLabels();
                }, 200);
                e.labelLimit.addEventListener('input', () => {
                    e.labelLimitVal.textContent = formatNum(parseInt(e.labelLimit.value, 10));
                    relabel();
                });
            }

            // ---- Surface ----
            e.surfaceBtn.addEventListener('click', () => {
                if (!this.viewer) return;
                if (this.surfaceID !== null) { this.removeSurface(); this.viewer.render(); }
                else this.addSurface();
            });
            e.surfaceType.addEventListener('change', () => this.refreshSurface());
            const surfOpacity = rafThrottle(() => this.refreshSurface());
            e.surfaceOpacity.addEventListener('input', () => {
                e.surfaceOpacityVal.textContent = parseFloat(e.surfaceOpacity.value).toFixed(2);
            });
            e.surfaceOpacity.addEventListener('change', surfOpacity);
            e.surfaceColorScheme.addEventListener('change', () => {
                e.surfaceCustomColor.classList.toggle('hidden', e.surfaceColorScheme.value !== 'custom');
                this.refreshSurface();
            });
            e.surfaceCustomColor.addEventListener('change', () => this.refreshSurface());
            e.surfaceSelOnly?.addEventListener('change', () => this.refreshSurface());

            // ---- Slab ----
            const slabThrottled = rafThrottle(() => this.applySlab());
            e.slabNear.addEventListener('input', slabThrottled);
            e.slabFar.addEventListener('input', slabThrottled);
            e.resetSlab.addEventListener('click', () => {
                e.slabNear.value = -100; e.slabFar.value = 100; this.applySlab();
            });

            // ---- Measurement ----
            e.measureModeBtn.addEventListener('click', () => this.setMeasureMode(!this.state.measureMode));
            e.clearMeasures.addEventListener('click', () => this.clearMeasurements());
            e.measureMode3?.addEventListener('change', () => {
                this.state.measureAtoms = [];
                if (this.state.measureMode) this.setMeasureMode(true);
            });

            // ---- Trajectory ----
            e.trajSlider.addEventListener('input', () => this.setFrame(parseInt(e.trajSlider.value, 10)));
            e.trajPrev.addEventListener('click', () => {
                const v = parseInt(e.trajSlider.value, 10);
                if (v > 0) { e.trajSlider.value = v - 1; this.setFrame(v - 1); }
            });
            e.trajNext.addEventListener('click', () => {
                const v = parseInt(e.trajSlider.value, 10);
                if (v < parseInt(e.trajSlider.max, 10)) { e.trajSlider.value = v + 1; this.setFrame(v + 1); }
            });
            e.trajPlay.addEventListener('click', () => this.toggleTrajectoryPlay());
            e.trajSpeed.addEventListener('change', () => {
                if (this.state.trajPlaying) { this.toggleTrajectoryPlay(); this.toggleTrajectoryPlay(); }
            });

            // ---- Isosurface ----
            e.isoPosVal.addEventListener('input', () =>
                e.isoPosDisplay.textContent = parseFloat(e.isoPosVal.value).toFixed(3));
            e.isoNegVal.addEventListener('input', () =>
                e.isoNegDisplay.textContent = parseFloat(e.isoNegVal.value).toFixed(3));
            e.isoOpacity.addEventListener('input', () =>
                e.isoOpacityDisplay.textContent = parseFloat(e.isoOpacity.value).toFixed(2));
            e.applyIso.addEventListener('click', () => this.renderIsosurface());
            e.clearIso.addEventListener('click', () => {
                this.clearIsosurfaces();
                this.viewer?.render();
            });

            // ---- Toggles ----
            this.setupToggle(e.toggleAtomLabels, 'atomLabels', () => {
                this.updateLabels();
                if (this.T.axis) this.drawAxisIndicator();
            });
            this.setupToggle(e.toggleResLabels, 'resLabels', () => {
                this.updateLabels();
                if (this.T.axis) this.drawAxisIndicator();
            });
            this.setupToggle(e.toggleHydrogens, 'hydrogens', () => {
                this.applyStyles();
                this.updateLabels();
                if (this.T.axis) this.drawAxisIndicator();
            });
            this.setupToggle(e.toggleAxis, 'axis', () => {
                this.updateLabels();
                this.drawAxisIndicator();
            });
            this.setupToggle(e.toggleSpin, 'spin', on => {
                if (!this.viewer) return;
                on ? this.viewer.spin('y', 1) : this.viewer.spin(false);
            });
            this.setupToggle(e.toggleClickInspect, 'clickInspect', on => {
                if (!on) e.atomInfo.classList.remove('visible');
            });
            this.setupToggle(e.toggleOutline, 'outline', () => this.applyOutline());

            // ---- Camera ----
            document.querySelectorAll('.axis-btn').forEach(b => b.addEventListener('click', () => {
                if (!this.viewer) return;
                const q = AXIS_QUATERNIONS[b.dataset.axis];
                if (!q) return;
                this.viewer.setView([0, 0, 0, 0, q.x, q.y, q.z, q.w]);
                this.viewer.zoomTo();
                this.viewer.render();
            }));
            e.centerBtn.addEventListener('click', () => {
                if (!this.viewer) return;
                this.viewer.zoomTo();
                this.viewer.render();
            });

            // ---- Export ----
            e.downloadBtn.addEventListener('click', () => this.exportPNG());
            e.exportQuality.addEventListener('change', () => this.updateExportNote());

            // ---- Reset ----
            e.resetBtn.addEventListener('click', () => this.reset());

            // ---- Label scope / force ----
            e.labelScope?.addEventListener('change', () => {
                if (this.T.atomLabels || this.T.resLabels) this.updateLabels();
            });
            e.labelForce?.addEventListener('change', () => {
                if (this.T.atomLabels || this.T.resLabels) this.updateLabels();
            });

            // ---- Measurement appearance ----
            const ms = this.state.measureStyle;
            const redraw = () => this.redrawMeasurements();

            e.measureFocusToggle?.addEventListener('change', ev => this.setMeasureFocus(ev.target.checked));
            e.measureFocusRes?.addEventListener('change', () => this.applyMeasureFocus());
            e.measureContextStyle?.addEventListener('change', ev => {
                ms.contextStyle = ev.target.value;
                this.applyMeasureFocus();
            });
            e.measureContextOpacity?.addEventListener('input', ev => {
                ms.contextOpacity = parseFloat(ev.target.value);
                e.measureContextOpacityVal.textContent = ms.contextOpacity.toFixed(2);
            });
            e.measureContextOpacity?.addEventListener('change', () => this.applyMeasureFocus());
            e.measureContextColor?.addEventListener('change', () => this.applyMeasureFocus());

            e.measureLineColor?.addEventListener('change', ev => { ms.lineColor = ev.target.value; redraw(); });
            e.measureLineWidth?.addEventListener('input', ev => {
                ms.lineWidth = parseFloat(ev.target.value);
                e.measureLineWidthVal.textContent = ms.lineWidth.toFixed(2);
            });
            e.measureLineWidth?.addEventListener('change', redraw);
            e.measureDashed?.addEventListener('change', ev => { ms.dashed = ev.target.checked; redraw(); });

            e.measureMarkerSize?.addEventListener('input', ev => {
                ms.markerSize = parseFloat(ev.target.value);
                e.measureMarkerSizeVal.textContent = ms.markerSize.toFixed(2);
            });
            e.measureMarkerSize?.addEventListener('change', redraw);

            e.measureLabelSize?.addEventListener('input', ev => {
                ms.labelSize = parseInt(ev.target.value, 10);
                e.measureLabelSizeVal.textContent = ms.labelSize;
            });
            e.measureLabelSize?.addEventListener('change', redraw);
            e.measureLabelColor?.addEventListener('change', ev => { ms.labelColor = ev.target.value; redraw(); });
            e.measureLabelBg?.addEventListener('change', ev => {
                ms.showBg = ev.target.checked;
                redraw();
            });
            e.measureDecimals?.addEventListener('change', ev => {
                ms.decimals = parseInt(ev.target.value, 10);
                redraw();
            });
            e.measureShowUnit?.addEventListener('change', ev => { ms.showUnit = ev.target.checked; redraw(); });
            e.measureZoomBtn?.addEventListener('click', () => this.zoomToMeasurements());
            e.measureCopyBtn?.addEventListener('click', () => this.copyMeasurements());

            // ---- Keyboard shortcuts ----
            document.addEventListener('keydown', ev => {
                const tag = (ev.target.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
                if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
                if (!this.viewer) return;
                switch (ev.key.toLowerCase()) {
                    case 'r': this.viewer.zoomTo(); this.viewer.render(); break;
                    case 'm': this.setMeasureMode(!this.state.measureMode); break;
                    case 'h': e.toggleHydrogens?.click(); break;
                    case 's': e.toggleSpin?.click(); break;
                    case 'l': e.toggleAtomLabels?.click(); break;
                    case 'escape':
                        if (this.state.measureMode) this.setMeasureMode(false);
                        e.atomInfo.classList.remove('visible');
                        break;
                }
            });

            // Keep the export estimate accurate when the viewport changes.
            window.addEventListener('resize', debounce(() => this.updateExportNote(), 250));
        }

        buildSelStyleSelection() {
            const textQuery = this.el.selQuery.value.trim();
            if (textQuery) return this.parseSelString(textQuery);
            const sel = {};
            const chain = $('selChain')?.value, elem = $('selElem')?.value, resn = $('selResn')?.value;
            if (chain) sel.chain = chain;
            if (elem) sel.elem = elem;
            if (resn) sel.resn = resn;
            return sel;
        }

        runQuery(action) {
            if (!this.viewer) return;
            const raw = this.el.focusQuery.value.trim();
            if (!raw) { this.toast('Enter a query first.', 'error'); return; }

            let sel;
            try {
                sel = this.parseSelString(raw);
            } catch (err) {
                console.error(err);
                this.toast('Could not parse that query.', 'error');
                return;
            }

            const n = this.countSelection(sel);
            if (!n) { this.toast('No atoms match that query.', 'error'); return; }

            this.state.lastSelection = sel;
            if (this.el.selectionCount && this.el.selCountText) {
                this.el.selectionCount.classList.remove('hidden');
                this.el.selCountText.textContent = `${formatNum(n)} atom${n !== 1 ? 's' : ''} selected`;
            }

            if (action === 'isolate') {
                this.viewer.setStyle({}, { hidden: true });
                this.applyStyledSelection(sel, this.el.styleSelect.value, 'set');
                if (!this.T.hydrogens) this.viewer.setStyle({ elem: 'H' }, { hidden: true });
            }
            this.viewer.zoomTo(sel);
            this.viewer.render();
            this.toast(`${formatNum(n)} atoms matched.`, 'success');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // BOOT
    // ═══════════════════════════════════════════════════════════════
    document.addEventListener('DOMContentLoaded', () => {
        window.app = new StructureInspector();
        // Expose helpers for console debugging.
        window.app.escapeHTML = escapeHTML;
        window.app.SpatialGrid = SpatialGrid;
    });

})();