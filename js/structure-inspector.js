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

    // Above this, an export is warned about even when the GPU accepts it:
    // image viewers and editors commonly choke on more than 8k px a side.
    const LARGE_EXPORT_PX = 8000;
    // Files above this size get a progress overlay while they are read.
    const LARGE_FILE_BYTES = 5 * 1024 * 1024;

    const SIDEBAR_MIN = 280, SIDEBAR_MAX = 480, SIDEBAR_DEFAULT = 320;
    const SIDEBAR_WIDTH_KEY = 'stemkit-inspector-sidebar-width';
    const SIDEBAR_COLLAPSED_KEY = 'stemkit-inspector-sidebar-collapsed';
    const TAB_KEY = 'stemkit-inspector-tab';

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

    // Residue classes for the "In this structure" list and the class words
    // that Find understands (water, ions, lipids, protein ...). Wider than the
    // two lists above, which keep their meaning for the query language.
    const AA_RESN = new Set(['ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE', 'LEU',
        'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL', 'HSD', 'HSE', 'HSP', 'HID', 'HIE',
        'HIP', 'CYX', 'ASH', 'GLH', 'LYN', 'SEC', 'PYL', 'MSE', 'ACE', 'NME', 'NH2']);
    const NUC_RESN = new Set(['A', 'T', 'G', 'C', 'U', 'DA', 'DT', 'DG', 'DC', 'DU', 'RA', 'RU', 'RG', 'RC',
        'DA5', 'DA3', 'DT5', 'DT3', 'DG5', 'DG3', 'DC5', 'DC3', 'A5', 'A3', 'U5', 'U3', 'G5', 'G3', 'C5', 'C3']);
    const WATER_RESN = new Set([...SOLVENT_RESN, 'SPC', 'SPCE', 'T3P', 'T4P', 'T5P', 'TP3', 'TIP5', 'TIP3P', 'TIP4P', 'SWM4', 'OPC', 'W']);
    const ION_NAMES = new Set([...ION_RESN, 'NA+', 'CL-', 'K+', 'LI', 'CS', 'RB', 'BR', 'IOD', 'CAL', 'MN',
        'FE', 'FE2', 'CU', 'CU1', 'CO', 'NI', 'CD', 'HG', 'CES', 'LIT', 'RUB', 'F', 'I', 'SR', 'BA', 'NIO', 'CIO']);
    const LIPID_RESN = new Set(['POPC', 'POPE', 'POPG', 'POPS', 'POPA', 'POPI', 'DPPC', 'DOPC', 'DMPC', 'DLPC',
        'DSPC', 'DOPE', 'DOPS', 'DOPG', 'DPPE', 'DPPG', 'DMPE', 'DMPG', 'DLPE', 'SDPC', 'PLPC', 'PAPC', 'DAPC',
        'DUPC', 'DIPC', 'DYPC', 'PSM', 'SSM', 'CHOL', 'CHL1', 'CHL', 'ERG', 'PA', 'PC', 'PE', 'PS', 'PGR', 'OL',
        'MY', 'ST', 'AR', 'DHA', 'LA']);
    const KIND_LABEL = {
        protein: 'Protein', nucleic: 'Nucleic acid', ligand: 'Ligand or other', lipid: 'Lipid',
        water: 'Water', ion: 'Ion', element: 'Element'
    };
    const KIND_ORDER = ['protein', 'nucleic', 'ligand', 'lipid', 'water', 'ion', 'element'];
    // Words Find reads as a whole class rather than a name.
    const CLASS_WORDS = {
        water: 'water', waters: 'water', solvent: 'water',
        ion: 'ion', ions: 'ion', salt: 'ion',
        lipid: 'lipid', lipids: 'lipid', membrane: 'lipid',
        ligand: 'ligand', ligands: 'ligand',
        protein: 'protein', proteins: 'protein', peptide: 'protein',
        nucleic: 'nucleic', dna: 'nucleic', rna: 'nucleic',
        backbone: 'backbone', sidechain: 'sidechain', sidechains: 'sidechain',
        hydrogen: 'hydrogen', hydrogens: 'hydrogen'
    };

    // Highlight for Find: carbons and halos take this colour. Magenta is the
    // one hue no common element uses, so matches stand out from every scheme.
    const HL_COLOR = '#e0359a';
    const HL_LABEL_BG = '#9d174d';

    // Zoom rail: log2 of the magnification relative to "fit everything".
    const ZOOM_MIN = -2, ZOOM_MAX = 5;

    const HINT_KEY = 'stemkit-inspector-hint-seen';
    const NAV_KEY = 'stemkit-inspector-nav-collapsed';
    const SPIN_KEY = 'stemkit-inspector-spin-speed';

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

    const plural = (n, one, many) => `${formatNum(n)} ${n === 1 ? one : (many || one + 's')}`;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    /** "FE" or "fe" to "Fe", the way element symbols are stored. */
    const elemCase = s => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;

    // Quaternions as {x, y, z, w}. The viewer's rotation is premultiplied by
    // a rotation about a screen axis to turn the structure the way the screen
    // shows it: +y turns the front to the right, like dragging right, and +x
    // turns it down, like dragging down (both checked against 3Dmol's drag).
    const qmul = (a, b) => ({
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
    });
    const qnorm = q => {
        const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
        return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
    };
    const qaxis = (axis, deg) => {
        const h = deg * Math.PI / 360, s = Math.sin(h);
        return { x: axis === 'x' ? s : 0, y: axis === 'y' ? s : 0, z: axis === 'z' ? s : 0, w: Math.cos(h) };
    };
    function qslerp(a, b, t) {
        let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
        if (d < 0) { b = { x: -b.x, y: -b.y, z: -b.z, w: -b.w }; d = -d; }
        if (d > 0.9995) {
            return qnorm({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), z: a.z + t * (b.z - a.z), w: a.w + t * (b.w - a.w) });
        }
        const th = Math.acos(d), s = Math.sin(th);
        const k0 = Math.sin((1 - t) * th) / s, k1 = Math.sin(t * th) / s;
        return { x: a.x * k0 + b.x * k1, y: a.y * k0 + b.y * k1, z: a.z * k0 + b.z * k1, w: a.w * k0 + b.w * k1 };
    }

    /** Motion runs only for visitors who have not asked for less of it. */
    const motionOK = () => {
        try { return window.matchMedia('(prefers-reduced-motion: no-preference)').matches; } catch (e) { return false; }
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
                    axis: false, spin: false, clickInspect: true, outline: false,
                    clickCentre: true
                },
                // Species keys ("res:SOL", "protein", "el:C") the list has hidden.
                hiddenSpecies: new Set()
            };

            // Quick find. `set` holds the matching atom indices, `residues`
            // the matching residues in file order for stepping through.
            this.find = this.emptyFind();

            // What the structure is made of; filled on load.
            this.species = [];
            this._speciesByKey = new Map();
            this._spKey = [];                  // atom index -> species key
            this._lookup = null;               // names present, for Find

            this._fitDist = null;              // camera distance at "fit everything"
            this._tween = null;
            this._lastAxis = null;
            this._lastAtomClick = { t: 0, atom: null };
            this._suppressClickUntil = 0;

            this._shapes = { axis: [], iso: [], measure: [], find: [] };
            this._findLabels = [];
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
                exportDims: $('exportDims'), exportWarn: $('exportWarn'),
                exportWarnText: $('exportWarnText'), exportTransparent: $('exportTransparent'),
                viewerCanvas: $('viewerCanvas'), viewerColumn: $('viewerColumn'),
                atomInfo: $('atomInfo'), measureInfo: $('measureInfo'), modeBadge: $('modeBadge'),
                // Shell, toolbar, sheets
                sidebar: $('sidebar'), sidebarHandle: $('sidebarHandle'),
                collapseSidebarBtn: $('collapseSidebarBtn'), chooseFileBtn: $('chooseFileBtn'),
                tbReset: $('tbReset'), tbSpin: $('tbSpin'), tbMeasure: $('tbMeasure'),
                tbHydrogens: $('tbHydrogens'), tbLabels: $('tbLabels'), tbScreenshot: $('tbScreenshot'),
                tbFullscreen: $('tbFullscreen'), tbPanel: $('tbPanel'), tbHelp: $('tbHelp'),
                shortcutSheet: $('shortcutSheet'), shortcutClose: $('shortcutClose'),
                dropIndicator: $('dropIndicator'),
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
                toggleOutline: $('toggleOutline'), toggleClickCentre: $('toggleClickCentre'),
                // Page head
                pageHead: $('pageHead'), headActions: $('headActions'),
                openAnotherBtn: $('openAnotherBtn'), headKeysBtn: $('headKeysBtn'),
                structureDims: $('structureDims'),
                // Species list
                speciesList: $('speciesList'), speciesMore: $('speciesMore'),
                hideWaterBtn: $('hideWaterBtn'), hideIonsBtn: $('hideIonsBtn'),
                // Find
                findInput: $('findInput'), findClear: $('findClear'), findList: $('findList'),
                findNav: $('findNav'), findStatus: $('findStatus'), findPrev: $('findPrev'),
                findNext: $('findNext'), findOnly: $('findOnly'),
                // Stage overlays
                stage: $('stage'), atomTitle: $('atomTitle'), atomFacts: $('atomFacts'),
                atomClose: $('atomClose'), atomCentre: $('atomCentre'), atomZoom: $('atomZoom'),
                atomFind: $('atomFind'), viewHint: $('viewHint'), viewHintClose: $('viewHintClose'),
                // Navigator
                navDock: $('navDock'), navBody: $('navBody'), navToggle: $('navToggle'),
                navBall: $('navBall'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'),
                zoomRail: $('zoomRail'), zoomVal: $('zoomVal'), navFit: $('navFit'),
                navZoomSel: $('navZoomSel'), navReset: $('navReset'), navSpin: $('navSpin'),
                spinRow: $('spinRow'), spinSpeed: $('spinSpeed'),
                tbWater: $('tbWater')
            };
        }

        emptyFind() {
            return {
                active: false, text: '', label: '', sel: null, set: null, count: 0,
                residues: [], idx: -1, only: false, prevView: null, prevSelection: null, sig: ''
            };
        }

        // ───────────────────────────────────────────────────────────
        // UI UTILITIES
        // ───────────────────────────────────────────────────────────
        /**
         * @param {string} msg
         * @param {'info'|'success'|'error'|'warn'} [type]
         * @param {{title?:string}} [opts]  bold lead-in, e.g. the file name
         */
        toast(msg, type = 'info', opts = {}) {
            const container = $('toastContainer');
            if (!container) return;
            const t = document.createElement('div');
            const variant = type === 'success' ? ' stk-toast-ok'
                          : type === 'error' ? ' stk-toast-danger'
                          : type === 'warn' ? ' stk-toast-warn' : '';
            t.className = 'stk-toast' + variant;
            t.setAttribute('role', type === 'error' ? 'alert' : 'status');
            const icon = document.createElement('i');
            icon.className = 'fa-solid ' + (type === 'success' ? 'fa-circle-check'
                : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info');
            icon.setAttribute('aria-hidden', 'true');
            const body = document.createElement('span');
            if (opts.title) {
                const b = document.createElement('b');
                b.textContent = opts.title;
                body.append(b, document.createTextNode(' '));
            }
            body.appendChild(document.createTextNode(msg));
            t.append(icon, body);
            container.appendChild(t);
            // Errors carry a reason the user may want to read twice.
            setTimeout(() => {
                t.classList.add('is-leaving');
                setTimeout(() => t.remove(), 300);
            }, type === 'error' ? 6000 : 3000);
        }

        /** Swap a button's icon for a spinner while an async action runs. */
        setButtonBusy(btn, on) {
            if (!btn) return;
            const icon = btn.querySelector('i');
            if (icon) {
                if (on) {
                    icon.dataset.icon = icon.className;
                    icon.className = 'fa-solid fa-circle-notch fa-spin';
                } else if (icon.dataset.icon) {
                    icon.className = icon.dataset.icon;
                    delete icon.dataset.icon;
                }
            }
            btn.disabled = on;
            btn.setAttribute('aria-busy', String(on));
        }

        showWorkspace() {
            const wasHidden = this.el.workspace.classList.contains('hidden');
            this.el.uploadZone.classList.add('hidden');
            this.el.workspace.classList.remove('hidden');
            this.el.workspace.classList.add('flex');
            // With a structure open the page head shrinks to one line, so the
            // workspace keeps the height it had when the head was not there.
            this.el.pageHead?.classList.add('is-compact');
            if (this.el.headActions) this.el.headActions.hidden = false;
            if (wasHidden) this.scrollWorkspaceIntoView();
        }

        showUploadZone() {
            this.el.workspace.classList.add('hidden');
            this.el.workspace.classList.remove('flex');
            this.el.uploadZone.classList.remove('hidden');
            this.el.pageHead?.classList.remove('is-compact');
            if (this.el.headActions) this.el.headActions.hidden = true;
        }

        /**
         * The workspace is sized to the viewport under the sticky nav; after a
         * file opens, bring its top up to the nav so all of it is on screen.
         * Instant, and only ever downwards from the loader.
         */
        scrollWorkspaceIntoView() {
            const ws = this.el.workspace;
            const nav = document.querySelector('nav');
            const navH = nav ? nav.getBoundingClientRect().height : 0;
            const top = ws.getBoundingClientRect().top + window.scrollY - navH - 12;
            if (top > window.scrollY) window.scrollTo({ top, behavior: 'auto' });
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
            // The faded context picks its colour from the background.
            if (this.find.active) this.applyStyles();
            else this.viewer.render();
        }

        /** Whether the viewer is drawing on a dark background. */
        darkBackground() {
            const v = this.el.bgSelect.value;
            if (v === 'black' || v === 'grey') return true;
            if (v === 'white') return false;
            return document.documentElement.classList.contains('dark');
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

        /**
         * Restyle every atom from the current settings. With a search open the
         * matches are drawn over a faded copy of the rest; otherwise the base
         * representation, the selection overrides and the species the list
         * has hidden.
         */
        applyStyles() {
            if (!this.viewer) return;
            if (this.find.active) this.applyFindStyles();
            else this.applyBaseStyles();
            this.viewer.render();
        }

        applyBaseStyles() {
            const styleType = this.el.styleSelect.value;
            const colorMode = this.el.colorSelect.value;

            if (colorMode === 'custom') {
                this.viewer.setStyle({}, { hidden: true });
                for (const [elName, col] of Object.entries(this.state.customElementColors)) {
                    this.viewer.setStyle({ elem: elName }, this.buildStyleObj(styleType, { color: col }));
                }
            } else {
                this.viewer.setStyle({}, this.buildStyleObj(styleType, this.getColorObj()));
                // An atom with no bonds (an ion, a lone water oxygen) has no
                // stick or line to draw; give it a ball so it is not lost.
                if (['stick', 'line', 'cross', 'cartoon'].includes(styleType)) {
                    this.viewer.addStyle({ predicate: a => !(a.bonds && a.bonds.length) },
                        { sphere: { scale: 0.35, ...this.getColorObj() } });
                }
            }

            // Re-apply stored per-selection overrides on top of the base style.
            // "Hide" has to replace the style: 3Dmol merges an added style, so
            // adding {hidden: true} would leave the atoms drawn.
            for (const ov of this.state.selectionOverrides) {
                if (ov.styleType === 'hidden') {
                    this.viewer.setStyle(ov.sel, { hidden: true });
                } else if (ov.color) {
                    this.viewer.addStyle(ov.sel, this.buildStyleObj(ov.styleType, { color: ov.color }));
                } else {
                    this.applyStyledSelection(ov.sel, ov.styleType, 'add');
                }
            }

            // Last, so nothing above can bring them back.
            const hidden = this.hiddenSpeciesPredicate();
            if (hidden) this.viewer.setStyle({ predicate: hidden }, { hidden: true });
            if (!this.T.hydrogens) this.viewer.setStyle({ elem: 'H' }, { hidden: true });
        }

        /** Predicate for atoms whose species the list has hidden, or null. */
        hiddenSpeciesPredicate() {
            const hidden = this.state.hiddenSpecies;
            if (!hidden.size) return null;
            const keys = this._spKey;
            return a => hidden.has(keys[a.index]);
        }

        buildPerElementColorUI(elements) {
            const container = this.el.perElementColorContainer;
            container.textContent = '';
            this.state.customElementColors = {};

            const header = document.createElement('span');
            header.className = 'si-sub-t';
            header.textContent = 'Per-element colours';
            container.appendChild(header);

            for (const elName of elements) {
                const defCol = ELEMENT_COLORS[elName] || DEFAULT_ATOM_COLOR;
                this.state.customElementColors[elName] = defCol;

                const row = document.createElement('div');
                row.className = 'si-elem-row';

                const label = document.createElement('span');
                label.textContent = elName;     // safe

                const picker = document.createElement('input');
                picker.type = 'color';
                picker.value = defCol;
                picker.className = 'si-color';
                picker.setAttribute('aria-label', `${elName} colour`);

                const resetBtn = document.createElement('button');
                resetBtn.type = 'button';
                resetBtn.className = 'stk-btn stk-btn-sm stk-btn-ghost';
                resetBtn.textContent = 'Reset';
                resetBtn.setAttribute('aria-label', `Reset ${elName} colour`);

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
                    `${formatNum(n)} atoms: labels are disabled to keep the tab responsive.`;
                [atomWarn, resWarn].forEach(w => {
                    if (w) { w.classList.remove('hidden'); w.textContent = 'disabled'; }
                });
                limitRow?.classList.add('hidden');
            } else if (n > PERF_LABEL_WARN) {
                this.el.perfWarning.classList.remove('hidden');
                this.el.perfWarningText.textContent =
                    `${formatNum(n)} atoms: labels may lag. The limit is adjustable in the Display tab.`;
                [atomWarn, resWarn].forEach(w => {
                    if (w) { w.classList.remove('hidden'); w.textContent = 'may lag'; }
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
            // The builder takes over the display; a search open until now ends.
            if (this.find.active && action !== 'zoom') this.endFind({ restyle: false });
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

            this.viewer.render();
            if (action === 'zoom' || action === 'isolate') {
                if (count > 0) this.moveCamera(() => this.viewer.zoomTo(sel));
                else this.toast('No atoms match that selection.', 'error');
            }
            this.syncToolbar();
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
            if (!match) {
                this.toast('is not a supported format. Accepted: PDB, ENT, CIF, SDF, MOL, MOL2, XYZ, GRO, PQR, PRMTOP, MMTF, CDJSON, CUBE and VASP.', 'error', { title: file.name });
                return;
            }

            const info = match[1];
            this.currentExtension = info.f;
            this.el.fileName.textContent = file.name;      // safe
            this.el.formatBadge.textContent = info.l;

            // A large file takes long enough to read and parse that silence
            // reads as a hang, so the workspace opens at once with a progress
            // overlay. Smaller files go straight through.
            const big = file.size > LARGE_FILE_BYTES;
            const progress = pct => this.setBusy(true, `Reading ${file.name}: ${pct}%`);
            if (big) { this.showWorkspace(); progress(0); }

            const reader = new FileReader();
            reader.onprogress = ev => {
                if (big && ev.lengthComputable) progress(Math.round(ev.loaded / ev.total * 100));
            };
            reader.onerror = () => {
                this.setBusy(false);
                this.loadFailed(file.name, 'The browser could not read the file.');
            };
            reader.onload = ev => {
                this.currentModelData = info.b ? new Uint8Array(ev.target.result) : ev.target.result;
                if (!big) { this.initViewer(file.name); return; }
                // Parsing is one synchronous call; the overlay needs a painted
                // frame to show its new text before the tab locks up.
                this.setBusy(true, `Parsing ${file.name}`);
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    this.initViewer(file.name);
                    this.setBusy(false);
                }));
            };
            if (info.b) reader.readAsArrayBuffer(file);
            else reader.readAsText(file);
        }

        /** Load one of the bundled samples through the same path as a dropped file. */
        async loadSample(path, btn) {
            this.setButtonBusy(btn, true);
            try {
                if (path === 'solvated') {
                    this.handleFile(await this.buildSolvatedSample());
                    return;
                }
                const res = await fetch(path);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const text = await res.text();
                this.handleFile(new File([text], path.split('/').pop(), { type: 'text/plain' }));
            } catch (err) {
                console.error(err);
                this.toast('The sample could not be fetched. Samples need the page to be served over HTTP rather than opened from disk.', 'error');
            } finally {
                this.setButtonBusy(btn, false);
            }
        }

        /**
         * The "Helix in a water box" sample: the bundled poly-alanine helix,
         * centred in a 4 nm cubic box, surrounded by water on a jittered
         * lattice with four Na+ and four Cl- in place of waters, written out
         * as GRO. Built here rather than shipped, so it costs no download. It
         * is not an equilibrated system; it exists to show the box, the
         * species list and Find on something shaped like an MD run.
         */
        async buildSolvatedSample() {
            const res = await fetch('assets/samples/helix-ala15.pdb');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const L = 4.0;                                   // box edge, nm
            const solute = [];
            for (const line of (await res.text()).split(/\r?\n/)) {
                if (!/^(ATOM|HETATM)/.test(line)) continue;
                solute.push({
                    name: line.slice(12, 16).trim(), resn: line.slice(17, 20).trim(),
                    resi: parseInt(line.slice(22, 26), 10) || 1,
                    x: parseFloat(line.slice(30, 38)) / 10,
                    y: parseFloat(line.slice(38, 46)) / 10,
                    z: parseFloat(line.slice(46, 54)) / 10
                });
            }
            if (!solute.length) throw new Error('The helix sample has no atoms');
            const c = solute.reduce((s, a) => ({ x: s.x + a.x, y: s.y + a.y, z: s.z + a.z }), { x: 0, y: 0, z: 0 });
            for (const a of solute) {
                a.x += L / 2 - c.x / solute.length;
                a.y += L / 2 - c.y / solute.length;
                a.z += L / 2 - c.z / solute.length;
            }

            let seed = 20260924;
            const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
            const step = 0.31, n = Math.floor(L / step), sites = [];
            for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
                const p = {
                    x: (i + 0.5) * step + (rnd() - 0.5) * 0.04,
                    y: (j + 0.5) * step + (rnd() - 0.5) * 0.04,
                    z: (k + 0.5) * step + (rnd() - 0.5) * 0.04
                };
                if (!solute.some(a => dist2(a, p) < 0.09)) sites.push(p);
            }

            // Four of each ion, spread through the box.
            const ionAt = new Map();
            for (let q = 0; q < 8; q++) ionAt.set(Math.floor((q + 0.5) * sites.length / 8), q % 2 ? 'CL' : 'NA');
            const water = [], ions = { NA: [], CL: [] };
            const OH = 0.09572, half = 104.52 / 2 * Math.PI / 180;
            sites.forEach((p, s) => {
                const ion = ionAt.get(s);
                if (ion) { ions[ion].push({ name: ion, resn: ion, ...p }); return; }
                // Random bisector d and a unit vector e at right angles to it.
                const z = rnd() * 2 - 1, phi = rnd() * 2 * Math.PI, r = Math.sqrt(1 - z * z);
                const d = { x: r * Math.cos(phi), y: r * Math.sin(phi), z };
                const t = Math.abs(d.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
                let e = { x: d.y * t.z - d.z * t.y, y: d.z * t.x - d.x * t.z, z: d.x * t.y - d.y * t.x };
                const m = Math.hypot(e.x, e.y, e.z);
                e = { x: e.x / m, y: e.y / m, z: e.z / m };
                const h = sgn => ({
                    x: p.x + OH * (Math.cos(half) * d.x + sgn * Math.sin(half) * e.x),
                    y: p.y + OH * (Math.cos(half) * d.y + sgn * Math.sin(half) * e.y),
                    z: p.z + OH * (Math.cos(half) * d.z + sgn * Math.sin(half) * e.z)
                });
                water.push([{ name: 'OW', ...p }, { name: 'HW1', ...h(1) }, { name: 'HW2', ...h(-1) }]);
            });

            const rows = solute.map(a => a);
            let resi = Math.max(...solute.map(a => a.resi));
            for (const mol of water) { resi++; for (const a of mol) rows.push({ ...a, resn: 'SOL', resi }); }
            for (const a of [...ions.NA, ...ions.CL]) rows.push({ ...a, resi: ++resi });

            const f = v => v.toFixed(3).padStart(8);
            const lines = ['Poly-alanine helix in water with Na+ and Cl-, generated by STEMKit (not equilibrated)', String(rows.length)];
            rows.forEach((a, i) => lines.push(
                String(a.resi % 100000).padStart(5) + a.resn.padEnd(5).slice(0, 5) +
                a.name.padStart(5).slice(0, 5) + String((i + 1) % 100000).padStart(5) + f(a.x) + f(a.y) + f(a.z)));
            lines.push(L.toFixed(5).padStart(10).repeat(3));
            return new File([lines.join('\n') + '\n'], 'helix-in-water.gro', { type: 'text/plain' });
        }

        async fetchPdb() {
            const id = this.el.pdbIdInput.value.trim().toUpperCase();
            if (!/^[A-Z0-9]{4}$/.test(id)) {
                this.toast('Enter a four-character PDB identifier.', 'error');
                this.el.pdbIdInput.focus();
                return;
            }
            const btn = this.el.fetchPdbBtn;
            this.setButtonBusy(btn, true);
            try {
                let res;
                try {
                    res = await fetch(`https://files.rcsb.org/download/${id}.pdb`);
                } catch (err) {
                    // fetch rejects only when no response arrived at all:
                    // offline, DNS failure, or a blocked request.
                    this.toast('Could not reach RCSB. Check the network connection and try again.', 'error');
                    return;
                }
                if (res.status === 404) {
                    this.toast(`PDB ${id} was not found on RCSB. Check the identifier.`, 'error');
                    return;
                }
                if (!res.ok) {
                    this.toast(`RCSB answered HTTP ${res.status} for ${id}. Try again later.`, 'error');
                    return;
                }
                this.currentModelData = await res.text();
                this.currentExtension = 'pdb';
                this.el.fileName.textContent = `${id}.pdb`;
                this.el.formatBadge.textContent = 'PDB, RCSB';
                this.initViewer(`${id}.pdb`);
            } finally {
                this.setButtonBusy(btn, false);
            }
        }

        /**
         * A file that could not be turned into a model. The viewer has already
         * been cleared by then, so the honest state is the empty one: back to
         * the upload zone, with a toast that names the file and the reason.
         */
        loadFailed(name, reason) {
            this.reset();
            this.toast(`could not be loaded. ${reason}`, 'error', { title: name });
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

        initViewer(name) {
            // Checked before the workspace is revealed. Swapping the upload
            // screen for a viewer that cannot draw leaves an empty panel and
            // no explanation, which reads as the file having failed to load.
            if (!this.webglAvailable()) {
                this.setBusy(false);
                if (!this.viewer) this.showUploadZone();
                this.toast(
                    'This viewer needs WebGL, which the browser is not providing. ' +
                    'Enabling hardware acceleration, or opening the page in a ' +
                    'different browser, usually restores it.',
                    'error'
                );
                return;
            }

            this.showWorkspace();

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
                    this.showUploadZone();
                    this.toast(
                        'Could not start the 3D viewer. Closing other tabs using ' +
                        '3D graphics and reloading usually frees enough resources.',
                        'error'
                    );
                    return;
                }
                this.initViewerGestures();
                // Every redraw, whatever moved the camera (wheel, pinch, drag,
                // a button), keeps the zoom rail honest.
                this.viewer.setViewChangeCallback(rafThrottle(() => this.syncZoomRail()));
            }
            this.endFind({ restyle: false, restoreView: false });

            const label = (this.currentExtension || 'file').toUpperCase();
            try {
                this.viewer.addModel(this.currentModelData, this.currentExtension, {
                    multimodel: true, frames: true, keepH: true
                });
                // 3Dmol's parsers rarely throw. A file they cannot make sense
                // of yields an empty model, which would read as success here
                // and then fail inside the renderer, so it is caught first.
                if (!this.allAtoms().length) {
                    this.loadFailed(name, `The ${label} parser found no atoms in it.`);
                    return;
                }
                this.afterModelLoaded();
            } catch (err) {
                console.error(err);
                const detail = err && err.message
                    ? `The ${label} parser reported: ${err.message}`
                    : `The ${label} parser reported an error.`;
                this.loadFailed(name, detail);
                return;
            }
            this.toast('Structure rendered.', 'success');
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

            // Shapes and labels went with viewer.clear(); forget the handles.
            this._shapes = { axis: [], iso: [], measure: [], find: [] };
            this._findLabels = [];
            this.buildLookup(atoms);
            this.buildSpecies(atoms);

            const nRes = this._lookup.residueCount;
            const parts = [plural(atoms.length, 'atom')];
            if (nRes > 1 && nRes < atoms.length) parts.push(plural(nRes, 'residue'));
            if (chains.size > 1) parts.push(plural(chains.size, 'chain'));
            this.el.structureMeta.textContent = parts.join(', ');
            const dims = `Extent ${(xMax - xMin).toFixed(1)} × ${(yMax - yMin).toFixed(1)} × ${(zMax - zMin).toFixed(1)} Å`;
            this.el.structureDims.textContent = dims;

            const sortedRes = Array.from(residues).sort();
            const sortedElem = Array.from(elems).sort();
            const sortedChain = Array.from(chains).sort();

            this.populateDropdown(this.el.buildResn, sortedRes, 'All residues');
            this.populateDropdown(this.el.buildElem, sortedElem, 'All elements');
            this.populateDropdown(this.el.buildChain, sortedChain, 'All chains');
            this.populateDropdown($('selChain'), sortedChain, 'All chains');
            this.populateDropdown($('selElem'), sortedElem, 'All elements');
            this.populateDropdown($('selResn'), sortedRes, 'All residues');

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
            this.state.lastSelection = null;
            this.state.measurements = [];
            this._labelJob.cancel();
            this.setLabelProgress(1, 1);
            this.renderMeasureList();
            this.updateExportNote();

            this.state.hiddenSpecies.clear();
            this.renderSpecies();
            this.hideAtomInfo();

            this.applyStyles();
            this.viewer.setBackgroundColor(this.getBackgroundColor());
            this.setupClickInspect();
            if (this.T.axis) this.drawAxisIndicator();
            this.viewer.setView([0, 0, 0, 0, 0, 0, 0, 1]);
            this.viewer.zoomTo();
            this._fitDist = this.viewer.getPerceivedDistance();
            this._lastAxis = null;
            this.viewer.render();
            if (this.T.spin) this.startSpin();
            this.updateLabels();
            this.syncToolbar();
            this.syncZoomRail();
            this.maybeShowHint();
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
            for (const lbl of this._measureLabels) this.viewer.addLabel(lbl.text, lbl.options, undefined, true);
            if (this.T.axis) this.drawAxisLabels();
            // The Find label went with removeAllLabels; put it back.
            this._findLabels = [];
            this.drawFindLabel();

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
                            position: { x: a.x, y: a.y, z: a.z }, fontSize: 9, fontColor: '#c0d6ec',
                            backgroundColor: 'rgba(26, 75, 123,.75)', backgroundOpacity: 0.75,
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
            this.viewer.setClickable({}, true, atom => this.onAtomClick(atom));
        }

        /**
         * The compact card for a clicked atom: what and where it is, with the
         * three things one usually wants next. It stays until closed, Esc, or
         * the next click, so there is time to use the buttons.
         */
        showAtomInfo(atom) {
            // Every field originates in a user-supplied file; the card is built
            // from text nodes so none of it is interpreted as markup.
            const e = this.el;
            this._cardAtom = atom;
            const resn = (atom.resn || '').trim();
            let title = resn ? `${resn} ${atom.resi ?? ''}`.trim() : `${atom.elem || 'Atom'} ${atom.serial ?? atom.index + 1}`;
            if (atom.chain && atom.chain.trim()) title += `, chain ${atom.chain}`;
            e.atomTitle.textContent = title;

            const facts = e.atomFacts;
            facts.textContent = '';
            const row = (key, value) => {
                const dt = document.createElement('dt');
                dt.textContent = key;
                const dd = document.createElement('dd');
                dd.textContent = value;
                facts.append(dt, dd);
            };
            const name = atom.atom && atom.atom !== atom.elem ? `${atom.atom} (${atom.elem || '?'})` : (atom.elem || '?');
            row('Atom', atom.serial !== undefined ? `${name}, serial ${atom.serial}` : name);
            row('x, y, z', `${atom.x.toFixed(2)}, ${atom.y.toFixed(2)}, ${atom.z.toFixed(2)} Å`);
            if (typeof atom.b === 'number' && atom.b) row('B-factor', atom.b.toFixed(2));
            const ss = { h: 'Helix', s: 'Sheet', c: 'Coil' }[atom.ss];
            if (ss && resn && AA_RESN.has(resn.toUpperCase())) row('Structure', ss);

            const findLabel = e.atomFind.querySelector('span');
            if (findLabel) findLabel.textContent = resn ? `Find all ${resn}` : `Find all ${atom.elem || ''}`.trim();
            e.atomZoom.hidden = !resn && atom.resi === undefined;
            e.atomInfo.hidden = false;
        }

        hideAtomInfo() {
            this._cardAtom = null;
            if (this.el.atomInfo) this.el.atomInfo.hidden = true;
        }

        setMeasureMode(on) {
            this.state.measureMode = on;
            this.state.measureAtoms = [];
            this.el.measureModeBtn.setAttribute('aria-pressed', String(on));
            this.el.modeBadge.classList.toggle('hidden', !on);
            this.el.modeBadge.classList.toggle('measure', on);
            this.el.modeBadge.textContent = on
                ? (this.el.measureMode3?.checked ? 'Measure: angle, pick three atoms' : 'Measure: distance, pick two atoms')
                : '';
            this.syncToolbar();
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
            const recs = this.state.measurements;
            box.hidden = recs.length === 0;
            if (!recs.length) return;

            const head = document.createElement('div');
            head.className = 'si-measure-h';
            const title = document.createElement('span');
            title.className = 'si-measure-t';
            title.textContent = recs.length === 1 ? '1 measurement' : `${recs.length} measurements`;
            const clearAll = document.createElement('button');
            clearAll.type = 'button';
            clearAll.className = 'si-overlay-btn';
            clearAll.textContent = 'Clear all';
            clearAll.setAttribute('aria-label', 'Clear all measurements');
            clearAll.addEventListener('click', () => this.clearMeasurements());
            head.append(title, clearAll);

            const list = document.createElement('ol');
            list.className = 'si-measure-list';
            recs.forEach((rec, i) => {
                const row = document.createElement('li');
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
                del.type = 'button';
                del.className = 'si-overlay-btn measure-del';
                del.textContent = '×';
                del.title = 'Remove this measurement';
                del.setAttribute('aria-label', `Remove measurement ${i + 1}`);
                del.addEventListener('click', () => {
                    this.state.measurements.splice(i, 1);
                    this.redrawMeasurements();
                    if (this.state.measureFocus) this.applyMeasureFocus();
                });

                row.append(txt, del);
                list.appendChild(row);
            });
            box.append(head, list);
        }

        /**
         * Focus mode: draw everything except the measured atoms in a muted
         * context style, so the measurement reads clearly in a figure.
         */
        applyMeasureFocus() {
            if (!this.viewer) return;
            const ms = this.state.measureStyle;
            if (this.state.measureFocus && this.find.active) this.endFind({ restyle: false });

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
        // WHAT THE STRUCTURE IS MADE OF
        // ───────────────────────────────────────────────────────────
        /** Names present in the file, normalised once, for Find and the list. */
        buildLookup(atoms) {
            const resn = new Map(), resnResidues = new Map(), atomNames = new Set();
            const elems = new Set(), chains = new Set(), residues = new Set();
            const resnU = [], atomU = [];
            for (const a of atoms) {
                const rn = (a.resn || '').trim(), RN = rn.toUpperCase();
                const AN = (a.atom || '').trim().toUpperCase();
                resnU[a.index] = RN;
                atomU[a.index] = AN;
                if (RN && !resn.has(RN)) resn.set(RN, rn);
                if (AN) atomNames.add(AN);
                if (a.elem) elems.add(a.elem);
                if (a.chain && String(a.chain).trim()) chains.add(a.chain);
                if (a.resi !== undefined) {
                    const k = `${a.chain || ''}|${a.resi}|${RN}`;
                    if (!residues.has(k)) {
                        residues.add(k);
                        resnResidues.set(RN, (resnResidues.get(RN) || 0) + 1);
                    }
                }
            }
            this._lookup = { resn, resnResidues, atomNames, elems, chains, resnU, atomU, residueCount: residues.size };
        }

        /**
         * Group atoms into species: all amino acids as "Protein", all
         * nucleotides as "Nucleic acid", every other residue name on its own
         * (SOL, NA, POPC, a ligand), and, for files without residues, one
         * species per element. Each is classed as water, ion, lipid or other.
         */
        buildSpecies(atoms) {
            const L = this._lookup, map = new Map(), spKey = [];
            for (const a of atoms) {
                const RN = L.resnU[a.index];
                const key = !RN ? 'el:' + (a.elem || '?')
                    : AA_RESN.has(RN) ? 'protein'
                    : NUC_RESN.has(RN) ? 'nucleic'
                    : 'res:' + RN;
                spKey[a.index] = key;
                let s = map.get(key);
                if (!s) { s = { key, atoms: 0, residues: new Set(), names: new Set(), carbon: false }; map.set(key, s); }
                s.atoms++;
                s.residues.add(a.resi !== undefined ? `${a.chain || ''}|${a.resi}` : a.index);
                if (RN) s.names.add(RN);
                if (a.elem === 'C' || a.elem === 'H') s.carbon = true;
            }
            const species = [];
            for (const s of map.values()) {
                const nRes = s.residues.size;
                let kind, name, query;
                if (s.key === 'protein') { kind = 'protein'; name = 'Protein'; query = 'protein'; }
                else if (s.key === 'nucleic') { kind = 'nucleic'; name = 'Nucleic acid'; query = 'nucleic'; }
                else if (s.key.startsWith('el:')) { kind = 'element'; name = s.key.slice(3); query = `element ${name}`; }
                else {
                    const RN = s.key.slice(4);
                    name = L.resn.get(RN) || RN;
                    query = name;
                    if (WATER_RESN.has(RN)) kind = 'water';
                    else if (ION_NAMES.has(RN) || (nRes === s.atoms && !s.carbon)) kind = 'ion';
                    else if (LIPID_RESN.has(RN)) kind = 'lipid';
                    else kind = 'ligand';
                }
                species.push({ key: s.key, kind, name, query, atoms: s.atoms, residues: nRes, types: s.names.size });
            }
            species.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.atoms - a.atoms);
            this.species = species;
            this._speciesByKey = new Map(species.map(s => [s.key, s]));
            this._spKey = spKey;
            this._speciesShowAll = false;
        }

        speciesCount(sp) {
            return sp.residues > 1 && sp.residues < sp.atoms ? plural(sp.residues, 'residue') : plural(sp.atoms, 'atom');
        }

        speciesKindText(sp) {
            if (sp.kind === 'protein' || sp.kind === 'nucleic') return plural(sp.types, 'residue type');
            if (sp.kind === 'element') return 'Element';
            return KIND_LABEL[sp.kind];
        }

        renderSpecies() {
            const e = this.el, list = e.speciesList;
            if (!list) return;
            list.textContent = '';
            const all = this.species, LIMIT = 6;
            const folded = all.length > LIMIT + 1 && !this._speciesShowAll;
            for (const sp of folded ? all.slice(0, LIMIT) : all) {
                const li = document.createElement('li');
                li.className = 'si-sp';
                li.dataset.key = sp.key;
                li.dataset.kind = sp.kind;

                const eye = document.createElement('button');
                eye.type = 'button';
                eye.className = 'si-sp-eye';
                eye.setAttribute('aria-label', `Hide ${sp.name}`);
                eye.title = `Hide ${sp.name}`;
                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-eye';
                icon.setAttribute('aria-hidden', 'true');
                eye.appendChild(icon);
                eye.addEventListener('click', () => this.toggleSpecies(sp.key));

                const main = document.createElement('button');
                main.type = 'button';
                main.className = 'si-sp-main';
                main.title = `Find ${sp.name} in the viewer`;
                const nm = document.createElement('span');
                nm.className = 'si-sp-name' + (sp.key.startsWith('res:') || sp.kind === 'element' ? ' is-code' : '');
                nm.textContent = sp.name;
                const kind = document.createElement('span');
                kind.className = 'si-sp-kind';
                kind.textContent = this.speciesKindText(sp);
                main.append(nm, kind);
                main.addEventListener('click', () => { this.findText(sp.query); this.revealViewer(); });

                const count = document.createElement('span');
                count.className = 'si-sp-count stk-tnum';
                count.textContent = this.speciesCount(sp);
                if (sp.residues > 1 && sp.residues < sp.atoms) {
                    const sub = document.createElement('span');
                    sub.textContent = plural(sp.atoms, 'atom');
                    count.appendChild(sub);
                }

                li.append(eye, main, count);
                list.appendChild(li);
            }
            const more = e.speciesMore;
            if (more) {
                more.hidden = all.length <= LIMIT + 1;
                more.textContent = this._speciesShowAll ? 'Show fewer' : `Show all ${all.length}`;
                more.setAttribute('aria-expanded', String(!!this._speciesShowAll));
            }
            if (e.hideWaterBtn) e.hideWaterBtn.hidden = !all.some(s => s.kind === 'water');
            if (e.hideIonsBtn) e.hideIonsBtn.hidden = !all.some(s => s.kind === 'ion');
            this.syncSpeciesState();
        }

        /** Eye icons, row dimming and the quick buttons follow the hidden set. */
        syncSpeciesState() {
            const e = this.el, hidden = this.state.hiddenSpecies;
            e.speciesList?.querySelectorAll('.si-sp').forEach(li => {
                const off = hidden.has(li.dataset.key);
                li.classList.toggle('is-hidden', off);
                const eye = li.querySelector('.si-sp-eye');
                eye.setAttribute('aria-pressed', String(off));
                const icon = eye.querySelector('i');
                icon.className = off ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
            });
            const press = (btn, on) => btn?.setAttribute('aria-pressed', String(!!on));
            press(e.hideWaterBtn, this.kindHidden('water'));
            press(e.hideIonsBtn, this.kindHidden('ion'));
            const hasWater = this.species.some(s => s.kind === 'water');
            if (e.tbWater) {
                e.tbWater.setAttribute('aria-disabled', String(!hasWater));
                press(e.tbWater, hasWater && !this.kindHidden('water'));
                e.tbWater.title = hasWater ? 'Show water (W)' : 'This structure has no water';
            }
        }

        kindHidden(kind) {
            const keys = this.species.filter(s => s.kind === kind).map(s => s.key);
            return keys.length > 0 && keys.every(k => this.state.hiddenSpecies.has(k));
        }

        toggleSpecies(key) {
            const hidden = this.state.hiddenSpecies;
            const sp = this._speciesByKey.get(key);
            if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
            this.syncSpeciesState();
            this.applyStyles();
            if (sp) this.announce(`${sp.name} ${hidden.has(key) ? 'hidden' : 'shown'}.`);
        }

        /** Hide or show every species of a kind (water, ion); `on` = hidden. */
        setKindHidden(kind, on) {
            const keys = this.species.filter(s => s.kind === kind).map(s => s.key);
            if (!keys.length) {
                this.toast(kind === 'water' ? 'This structure has no water.' : 'This structure has no ions.');
                return;
            }
            for (const k of keys) { if (on) this.state.hiddenSpecies.add(k); else this.state.hiddenSpecies.delete(k); }
            this.syncSpeciesState();
            this.applyStyles();
            this.announce(`${kind === 'water' ? 'Water' : 'Ions'} ${on ? 'hidden' : 'shown'}.`);
        }

        // ───────────────────────────────────────────────────────────
        // FIND
        //
        // Plain words first: a residue or species name (SOL, NA, ALA), a name
        // with a number or range (ALA 12, SOL 10-20), a bare number or range,
        // "chain A", an element (Fe), an atom name (CA, OW), a class (water,
        // ions, lipids, protein, backbone), several of these separated by
        // commas. Anything that looks like the query language is handed to
        // parseSelString unchanged.
        // ───────────────────────────────────────────────────────────
        initFind() {
            const e = this.el, input = e.findInput;
            if (!input) return;
            this._optIdx = -1;

            input.addEventListener('input', () => {
                const v = input.value;
                e.findClear.hidden = !v;
                this.renderSuggestions(v);
                clearTimeout(this._findTimer);
                if (!v.trim()) {
                    if (this.find.active || this.find.prevView) this.endFind({ restoreView: true, keepUI: true });
                    e.findNav.hidden = true;
                    return;
                }
                this._findTimer = setTimeout(() => this.runFind(v), 220);
            });
            input.addEventListener('focus', () => this.renderSuggestions(input.value));
            input.addEventListener('blur', () => setTimeout(() => {
                if (document.activeElement !== input) this.closeSuggestions();
            }, 100));
            input.addEventListener('keydown', ev => {
                const open = !e.findList.hidden;
                const opts = Array.from(e.findList.children);
                if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                    ev.preventDefault();
                    if (!open) { this.renderSuggestions(input.value); return; }
                    if (!opts.length) return;
                    const n = opts.length;
                    this._optIdx = ev.key === 'ArrowDown'
                        ? (this._optIdx + 1) % n
                        : (this._optIdx <= 0 ? n - 1 : this._optIdx - 1);
                    this.highlightOption();
                    return;
                }
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    if (open && this._optIdx >= 0 && opts[this._optIdx]) {
                        this.findText(opts[this._optIdx].dataset.value);
                        return;
                    }
                    this.closeSuggestions();
                    clearTimeout(this._findTimer);
                    if (!input.value.trim()) return;
                    if (this.find.active && this.find.text === input.value) this.stepFind(ev.shiftKey ? -1 : 1);
                    else this.runFind(input.value);
                    return;
                }
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    if (open) { this.closeSuggestions(); return; }
                    if (input.value || this.find.active) { this.endFind({ restoreView: true }); return; }
                    this.el.viewerCanvas?.focus({ preventScroll: true });
                    return;
                }
                if (ev.key === 'Tab') this.closeSuggestions();
            });
            // Keep focus in the field while an option is pressed.
            e.findList.addEventListener('mousedown', ev => ev.preventDefault());
            e.findList.addEventListener('click', ev => {
                const li = ev.target.closest('[role="option"]');
                if (li) this.findText(li.dataset.value);
            });

            e.findClear.addEventListener('click', () => {
                this.endFind({ restoreView: true });
                input.focus();
            });
            e.findPrev.addEventListener('click', () => this.stepFind(-1));
            e.findNext.addEventListener('click', () => this.stepFind(1));
            e.findOnly.addEventListener('click', () => {
                this.find.only = !this.find.only;
                e.findOnly.setAttribute('aria-pressed', String(this.find.only));
                if (this.find.active) this.applyStyles();
            });
        }

        /**
         * On a phone the list sits under the viewer; after acting on the
         * structure from down there, bring the viewer back up to show it.
         */
        revealViewer() {
            const col = this.el.viewerColumn;
            if (!col) return;
            const r = col.getBoundingClientRect();
            const nav = document.querySelector('nav');
            const navH = nav ? nav.getBoundingClientRect().height : 0;
            if (r.top >= navH && r.bottom <= window.innerHeight) return;
            window.scrollTo({ top: r.top + window.scrollY - navH - 8, behavior: 'auto' });
        }

        /** Put text in the field and search for it now. */
        findText(text) {
            const e = this.el;
            if (!this.viewer || !e.findInput) return;
            clearTimeout(this._findTimer);
            e.findInput.value = text;
            e.findClear.hidden = !text;
            this.closeSuggestions();
            this.runFind(text);
        }

        /** One name: residue, then element, then atom name, then chain. */
        nameTerm(name, allowChain) {
            const L = this._lookup, N = name.toUpperCase();
            if (L.resn.has(N)) return { pred: a => L.resnU[a.index] === N, label: L.resn.get(N), kind: 'resn' };
            const el = elemCase(name);
            if (/^[A-Za-z]{1,2}$/.test(name) && L.elems.has(el)) return { pred: a => a.elem === el, label: `${el} atoms`, kind: 'elem', el };
            if (L.atomNames.has(N)) return { pred: a => L.atomU[a.index] === N, label: `Atom ${N}`, kind: 'atom' };
            if (allowChain && L.chains.has(name)) return { pred: a => a.chain === name, label: `Chain ${name}`, kind: 'chain' };
            return null;
        }

        resiTerm(name, lo, hi) {
            const a0 = parseInt(lo, 10), a1 = hi !== undefined ? parseInt(hi, 10) : a0;
            const min = Math.min(a0, a1), max = Math.max(a0, a1);
            const inRange = a => typeof a.resi === 'number' && a.resi >= min && a.resi <= max;
            const range = min === max ? String(min) : `${min}-${max}`;
            if (!name) return { pred: inRange, label: min === max ? `Residue ${range}` : `Residues ${range}` };
            const label = name.kind === 'resn' ? `${name.label} ${range}`
                : name.kind === 'atom' ? `${name.label} in residue ${range}`
                : `${name.el || name.label} in residue ${range}`;
            return { pred: a => inRange(a) && name.pred(a), label };
        }

        classTerm(kind) {
            const keys = this._spKey, byKey = this._speciesByKey;
            const labels = { water: 'Water', ion: 'Ions', lipid: 'Lipids', ligand: 'Ligands and others', protein: 'Protein', nucleic: 'Nucleic acid' };
            if (labels[kind]) return { pred: a => byKey.get(keys[a.index])?.kind === kind, label: labels[kind] };
            if (kind === 'hydrogen') return { pred: a => a.elem === 'H', label: 'Hydrogens' };
            const p = this._namedGroupPredicate(kind);
            return p ? { pred: p, label: kind === 'backbone' ? 'Backbone' : 'Side chains' } : null;
        }

        findTerm(term) {
            const L = this._lookup;
            const t = term.trim().replace(/\s+/g, ' ');
            if (!t) return null;
            let m;
            // A trailing "chain X" narrows whatever comes before it.
            if ((m = t.match(/^(.+?) (?:in )?chain (\S+)$/i))) {
                const head = this.findTerm(m[1]), ch = this.findTerm(`chain ${m[2]}`);
                return head && ch ? { pred: a => head.pred(a) && ch.pred(a), label: `${head.label}, ${ch.label.toLowerCase()}` } : null;
            }
            if ((m = t.match(/^chain (\S+)$/i))) {
                const want = L.chains.has(m[1]) ? m[1] : [...L.chains].find(c => String(c).toUpperCase() === m[1].toUpperCase());
                return want !== undefined ? { pred: a => a.chain === want, label: `Chain ${want}` } : null;
            }
            if ((m = t.match(/^(?:element|elem) (\S+)$/i))) {
                const el = elemCase(m[1]);
                return L.elems.has(el) ? { pred: a => a.elem === el, label: `${el} atoms` } : null;
            }
            if ((m = t.match(/^atom (\S+)$/i))) {
                const AN = m[1].toUpperCase();
                return L.atomNames.has(AN) ? { pred: a => L.atomU[a.index] === AN, label: `Atom ${AN}` } : null;
            }
            if ((m = t.match(/^(?:resname|resn) (\S+)$/i))) {
                const RN = m[1].toUpperCase();
                return L.resn.has(RN) ? { pred: a => L.resnU[a.index] === RN, label: L.resn.get(RN) } : null;
            }
            if ((m = t.match(/^(?:residues?|resid|resi|res) (-?\d+)(?: ?[-–] ?(-?\d+))?$/i))) return this.resiTerm(null, m[1], m[2]);
            const cls = CLASS_WORDS[t.toLowerCase()];
            if (cls) return this.classTerm(cls);
            if ((m = t.match(/^(-?\d+)(?: ?[-–] ?(-?\d+))?$/))) return this.resiTerm(null, m[1], m[2]);
            if (!t.includes(' ')) {
                const exact = this.nameTerm(t, true);
                if (exact) return exact;
            }
            // A name and a residue number or range: ALA 12, ALA12, SOL 10-20, CA 12.
            if ((m = t.match(/^([A-Za-z][A-Za-z0-9'*+]{0,4}?) ?(-?\d+)(?: ?[-–] ?(-?\d+))?$/))) {
                const name = this.nameTerm(m[1], false);
                if (name) return this.resiTerm(name, m[2], m[3]);
            }
            // The start of a residue name, while it is being typed: "PO" for POPC.
            if (!t.includes(' ') && t.length >= 2) {
                const T = t.toUpperCase();
                const names = [...L.resn.keys()].filter(n => n.startsWith(T));
                if (names.length) {
                    const set = new Set(names);
                    const shown = names.slice(0, 3).map(n => L.resn.get(n)).join(', ') + (names.length > 3 ? ' and more' : '');
                    return { pred: a => set.has(L.resnU[a.index]), label: shown };
                }
            }
            return null;
        }

        /** Resolve Find's text to the matching atoms, or null for none. */
        parseFind(raw) {
            const model = this.viewer?.getModel();
            if (!model || !this._lookup) return null;
            const text = raw.trim();
            if (!text) return null;
            const LANG = /(^|\s)!?(not:)?(chain|resn|resi|elem|atom|ss|b|serial|x|y|z|within|or|byres|expand|charge|protein|nucleic|solvent|ion|backbone|sidechain|hetero):/i;
            if (LANG.test(text)) {
                let hits = [];
                try { hits = model.selectedAtoms(this.parseSelString(text)); } catch (err) { hits = []; }
                return hits.length ? { hits, label: text } : null;
            }
            const atoms = model.selectedAtoms({});
            const set = new Set(), labels = [];
            for (const term of text.split(/\s*,\s*|\s+or\s+/i)) {
                const t = this.findTerm(term);
                if (!t) continue;
                for (const a of atoms) if (t.pred(a)) set.add(a.index);
                labels.push(t.label);
            }
            if (!set.size) return null;
            return { hits: atoms.filter(a => set.has(a.index)), set, label: labels.join(' and ') };
        }

        runFind(text) {
            const e = this.el;
            if (!this.viewer) return;
            const q = this.parseFind(text);
            e.findNav.hidden = false;
            if (!q) {
                // Typing through a word that matches nothing on the way must
                // not lose the view to go back to when the search is cleared.
                const keep = { prevView: this.find.prevView, prevSelection: this.find.prevSelection };
                const was = this.find.active;
                if (was) this.endFind({ restoreView: false, keepUI: true });
                if (was || keep.prevView) Object.assign(this.find, keep);
                this.find.text = text;
                e.findNav.classList.add('is-empty');
                e.findStatus.textContent = `Nothing matches “${text.trim()}”. Try a name from the list, a residue number, or chain A.`;
                this.syncToolbar();
                return;
            }
            e.findNav.classList.remove('is-empty');
            const hits = q.hits, f = this.find;
            const sig = `${hits.length}:${hits[0].index}:${hits[hits.length - 1].index}`;
            if (f.active && f.sig === sig) {
                f.text = text;
                f.label = q.label;
                this.updateFindStatus();
                return;
            }
            if (!f.active && !f.prevView) {
                f.prevView = this.viewer.getView();
                f.prevSelection = this.state.lastSelection;
            }
            // Figure mode restyles over everything; a search takes the display.
            if (this.state.measureFocus) {
                this.state.measureFocus = false;
                if (e.measureFocusToggle) e.measureFocusToggle.checked = false;
                e.measureFocusPanel?.classList.add('hidden');
            }
            const set = q.set || new Set(hits.map(a => a.index));
            const byRes = new Map(), RU = this._lookup.resnU;
            for (const a of hits) {
                const k = a.resi !== undefined ? `${a.chain || ''}|${a.resi}|${RU[a.index]}` : `#${a.index}`;
                let r = byRes.get(k);
                if (!r) { r = { atoms: [], objs: [] }; byRes.set(k, r); }
                r.atoms.push(a.index);
                r.objs.push(a);
            }
            Object.assign(f, {
                active: true, text, label: q.label, set, count: hits.length, sig, idx: -1,
                sel: { predicate: a => set.has(a.index) }, residues: Array.from(byRes.values())
            });
            this.state.lastSelection = f.sel;
            this.clearFindMarks();
            this.applyStyles();
            this.moveCamera(() => this.zoomToAtoms(f.sel, 6), 380);
            this.updateFindStatus();
            this.syncToolbar();
        }

        residueName(atom) {
            const rn = (atom.resn || '').trim();
            let s = rn ? `${rn} ${atom.resi ?? ''}`.trim() : `${atom.elem || 'Atom'} ${atom.serial ?? atom.index + 1}`;
            if (atom.chain && String(atom.chain).trim()) s += `, chain ${atom.chain}`;
            return s;
        }

        updateFindStatus() {
            const f = this.find, e = this.el;
            if (!f.active) return;
            const n = f.count, r = f.residues.length;
            let s;
            if (f.idx >= 0) {
                s = `${this.residueName(f.residues[f.idx].objs[0])}: ${formatNum(f.idx + 1)} of ${plural(r, r < n ? 'residue' : 'match', r < n ? 'residues' : 'matches')}`;
            } else {
                s = `${f.label}: ${plural(n, 'atom')}`;
                if (r > 1 && r < n) s += ` in ${plural(r, 'residue')}`;
            }
            e.findStatus.textContent = s;
            e.findOnly.setAttribute('aria-pressed', String(f.only));
        }

        stepFind(dir) {
            const f = this.find;
            if (!this.viewer) return;
            if (!f.active || !f.residues.length) {
                this.toast('Type a name in Find first; N and the arrows then step through what it matches.');
                return;
            }
            const n = f.residues.length;
            f.idx = f.idx < 0 ? (dir > 0 ? 0 : n - 1) : (f.idx + dir + n) % n;
            const res = f.residues[f.idx];
            const set = new Set(res.atoms);
            this.clearFindMarks();
            this.applyStyles();
            this.drawFindMarks();
            this.moveCamera(() => this.zoomToAtoms({ predicate: a => set.has(a.index) }), 380);
            this.updateFindStatus();
        }

        /** A soft halo on each atom of the residue being visited, and its name. */
        drawFindMarks() {
            const f = this.find;
            if (!this.viewer || !f.active || f.idx < 0) return;
            const objs = f.residues[f.idx].objs;
            if (objs.length <= 80) {
                for (const a of objs) {
                    if (a.elem === 'H' && !this.T.hydrogens) continue;
                    this._shapes.find.push(this.viewer.addSphere({
                        center: { x: a.x, y: a.y, z: a.z }, radius: a.elem === 'H' ? 0.95 : 1.45,
                        color: HL_COLOR, opacity: 0.32
                    }));
                }
            }
            this.drawFindLabel();
            this.viewer.render();
        }

        drawFindLabel() {
            const f = this.find;
            if (!this.viewer || !f.active || f.idx < 0) return;
            const objs = f.residues[f.idx].objs;
            let x = 0, y = 0, z = 0;
            for (const a of objs) { x += a.x; y += a.y; z += a.z; }
            this._findLabels.push(this.viewer.addLabel(this.residueName(objs[0]), {
                position: { x: x / objs.length, y: y / objs.length + 1.6, z: z / objs.length },
                fontSize: 13, fontColor: '#ffffff', backgroundColor: HL_LABEL_BG, backgroundOpacity: 0.92,
                borderRadius: 4, padding: 3, inFront: true, alignment: 'bottomCenter'
            }, undefined, true));
        }

        clearFindMarks() {
            if (!this.viewer) return;
            for (const s of this._shapes.find) {
                try { this.viewer.removeShape(s); } catch (e) { /* already gone */ }
            }
            this._shapes.find = [];
            for (const l of this._findLabels) {
                try { this.viewer.removeLabel(l); } catch (e) { /* already gone */ }
            }
            this._findLabels = [];
        }

        /**
         * Matches as ball-and-stick with magenta carbons, lone atoms such as
         * ions as larger balls, everything else as faint lines (or hidden with
         * Only matches). Hidden species stay hidden unless they match.
         */
        applyFindStyles() {
            const f = this.find, v = this.viewer;
            const match = a => f.set.has(a.index);
            if (f.only) {
                v.setStyle({}, { hidden: true });
            } else {
                const grey = this.darkBackground() ? '#64748b' : '#94a3b8';
                const ctx = { line: { color: grey, opacity: 0.55 } };
                if (this.el.styleSelect.value === 'cartoon') ctx.cartoon = { color: grey, opacity: 0.35 };
                v.setStyle({}, ctx);
                const hidden = this.hiddenSpeciesPredicate();
                if (hidden) v.setStyle({ predicate: a => hidden(a) && !match(a) }, { hidden: true });
            }
            const map = {};
            for (const el of this._lookup.elems) map[el] = ELEMENT_COLORS[el] || DEFAULT_ATOM_COLOR;
            map.C = HL_COLOR;
            const cs = { prop: 'elem', map };
            const lone = a => !(a.bonds && a.bonds.length);
            if (f.idx < 0) {
                v.setStyle(f.sel, { stick: { radius: 0.17, colorscheme: cs }, sphere: { scale: 0.3, colorscheme: cs } });
                v.setStyle({ predicate: a => match(a) && lone(a) }, { sphere: { scale: 0.6, colorscheme: cs } });
            } else {
                // Visiting one residue: the other matches step back to thin
                // sticks so the one in hand is the only ball-and-stick.
                const cur = new Set(f.residues[f.idx].atoms);
                const inCur = a => cur.has(a.index);
                v.setStyle({ predicate: a => match(a) && !inCur(a) }, { stick: { radius: 0.09, colorscheme: cs }, sphere: { scale: 0.12, colorscheme: cs } });
                v.setStyle({ predicate: a => match(a) && !inCur(a) && lone(a) }, { sphere: { scale: 0.3, colorscheme: cs } });
                v.setStyle({ predicate: inCur }, { stick: { radius: 0.2, colorscheme: cs }, sphere: { scale: 0.34, colorscheme: cs } });
                v.setStyle({ predicate: a => inCur(a) && lone(a) }, { sphere: { scale: 0.7, colorscheme: cs } });
            }
            if (!this.T.hydrogens) v.setStyle({ elem: 'H' }, { hidden: true });
        }

        /**
         * Leave Find. `restoreView` glides back to the view from before the
         * search; `keepUI` leaves the field as it is (for "no match yet").
         */
        endFind(opts = {}) {
            const f = this.find, e = this.el;
            const was = f.active;
            this.clearFindMarks();
            const prevView = f.prevView, prevSel = f.prevSelection, only = f.only;
            this.find = this.emptyFind();
            this.find.only = only;
            if (was) this.state.lastSelection = prevSel;
            if (!opts.keepUI && e.findInput) {
                clearTimeout(this._findTimer);
                e.findInput.value = '';
                e.findClear.hidden = true;
                e.findNav.hidden = true;
                this.closeSuggestions();
            }
            if (was && opts.restyle !== false && this.viewer) this.applyStyles();
            if (opts.restoreView && prevView && this.viewer) {
                this.moveCamera(() => this.viewer.setView(prevView), 380);
            }
            this.syncToolbar();
        }

        suggestionsFor(text) {
            const L = this._lookup;
            if (!L) return [];
            const q = text.trim().toUpperCase();
            const out = [];
            const push = (value, name, kind, count) => {
                if (out.length < 8 && !out.some(o => o.value === value)) out.push({ value, name, kind, count });
            };
            for (const sp of this.species) {
                const hit = !q || sp.name.toUpperCase().startsWith(q) ||
                    (sp.kind !== 'element' && KIND_LABEL[sp.kind].toUpperCase().startsWith(q));
                if (hit) push(sp.query, sp.name, sp.kind === 'element' ? 'Element' : KIND_LABEL[sp.kind], this.speciesCount(sp));
            }
            if (q) {
                for (const [RN, rn] of L.resn) {
                    if (RN.startsWith(q.split(' ')[0]) && (AA_RESN.has(RN) || NUC_RESN.has(RN))) {
                        push(rn, rn, 'Residue', plural(L.resnResidues.get(RN) || 0, 'residue'));
                    }
                }
                for (const [w, kind] of Object.entries(CLASS_WORDS)) {
                    if (q.length >= 2 && w.toUpperCase().startsWith(q) && this.species.some(s => s.kind === kind)) push(w, w, 'Class', '');
                }
            }
            if (L.chains.size > 1) {
                for (const c of L.chains) {
                    const v = `chain ${c}`;
                    if (!q || v.toUpperCase().startsWith(q)) push(v, v, 'Chain', '');
                }
            }
            return out;
        }

        renderSuggestions(text) {
            const e = this.el, list = e.findList;
            if (!list || !this.viewer || document.activeElement !== e.findInput) { this.closeSuggestions(); return; }
            const items = this.suggestionsFor(text || '');
            list.textContent = '';
            this._optIdx = -1;
            e.findInput.removeAttribute('aria-activedescendant');
            if (!items.length) { this.closeSuggestions(); return; }
            items.forEach((it, i) => {
                const li = document.createElement('li');
                li.id = `findOpt${i}`;
                li.setAttribute('role', 'option');
                li.setAttribute('aria-selected', 'false');
                li.dataset.value = it.value;
                const name = document.createElement('span');
                name.className = 'si-opt-name';
                name.textContent = it.name;
                const kind = document.createElement('span');
                kind.className = 'si-opt-kind';
                kind.textContent = it.kind;
                const count = document.createElement('span');
                count.className = 'si-opt-count stk-tnum';
                count.textContent = it.count;
                li.append(name, kind, count);
                list.appendChild(li);
            });
            list.hidden = false;
            e.findInput.setAttribute('aria-expanded', 'true');
        }

        highlightOption() {
            const e = this.el;
            Array.from(e.findList.children).forEach((li, i) => {
                const on = i === this._optIdx;
                li.setAttribute('aria-selected', String(on));
                if (on) {
                    e.findInput.setAttribute('aria-activedescendant', li.id);
                    li.scrollIntoView({ block: 'nearest' });
                }
            });
        }

        closeSuggestions() {
            const e = this.el;
            if (!e.findList) return;
            e.findList.hidden = true;
            this._optIdx = -1;
            e.findInput?.setAttribute('aria-expanded', 'false');
            e.findInput?.removeAttribute('aria-activedescendant');
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

        /**
         * Output size beside the scale select, and a warning when the request
         * is beyond what the GPU will draw (clamped, as `safeMultiplier` has
         * always done) or merely very large. The warning never blocks.
         */
        updateExportNote() {
            const dims = this.el.exportDims, warn = this.el.exportWarn;
            if (!dims) return;
            const canvas = this.el.viewerCanvas.querySelector('canvas');
            if (!canvas || !canvas.width) {
                dims.textContent = '';
                if (warn) warn.hidden = true;
                return;
            }
            const requested = parseInt(this.el.exportQuality.value, 10) || 2;
            const safe = this.safeMultiplier(requested);
            const w = canvas.width * safe, h = canvas.height * safe;
            dims.textContent = `${w} × ${h} px`;
            if (!warn) return;

            let text = '';
            if (safe < requested) {
                const reqW = canvas.width * requested, reqH = canvas.height * requested;
                text = `${requested}× would be ${reqW} × ${reqH} px, beyond this GPU's ${this.maxTextureSize()} px texture limit. The export is clamped to ${safe}× (${w} × ${h} px).`;
            } else if (Math.max(w, h) > LARGE_EXPORT_PX) {
                text = `${w} × ${h} px is a very large image; some viewers and editors struggle above ${LARGE_EXPORT_PX} px on a side.`;
            }
            this.el.exportWarnText.textContent = text;
            warn.hidden = !text;
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
         * size alone produces a file visibly softer than what is on screen,
         * which is exactly the complaint this addresses. The multiplier is
         * applied on top of dpr.
         *
         * The container is parked off-screen while it is oversized, so the
         * page does not visibly jump or grow scrollbars mid-export.
         *
         * A transparent export clears the drawing buffer to the background
         * colour at alpha 0 for the one render that is copied out. 3Dmol
         * creates its context with alpha enabled and keeps the drawing buffer,
         * so the copy carries the alpha channel; the on-screen background is
         * restored before anyone sees it.
         */
        captureCanvas(mult, transparent = false) {
            const host = this.el.viewerCanvas;
            const canvas = host && host.querySelector('canvas');
            if (!canvas) throw new Error('No canvas');

            // 3Dmol multiplies the container size by the device pixel ratio
            // when it sizes the drawing buffer, so the exported file ends up
            // at scale × dpr, matching, then exceeding, on-screen sharpness.
            const scale = Math.max(1, mult);
            const oversized = scale > 1;

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

            if (oversized) {
                host.style.position = 'fixed';
                host.style.left = '-100000px';
                host.style.top = '0';
                host.style.zIndex = '-1';
                host.style.width = `${cssW * scale}px`;
                host.style.height = `${cssH * scale}px`;
            }

            let out;
            try {
                if (transparent) this.viewer.setBackgroundColor(this.getBackgroundColor(), 0);
                if (oversized) this.viewer.resize();
                this.viewer.render();

                out = document.createElement('canvas');
                out.width = canvas.width;
                out.height = canvas.height;
                out.getContext('2d').drawImage(canvas, 0, 0);
            } finally {
                // Restore in a finally block: leaving the viewer parked
                // off-screen because an export failed would take the tool down
                // with it.
                if (transparent) this.viewer.setBackgroundColor(this.getBackgroundColor());
                if (oversized) {
                    Object.assign(host.style, prev);
                    this.viewer.resize();
                }
                this.viewer.render();
            }
            return out;
        }

        exportPNG() {
            if (!this.viewer) return;
            const requested = parseInt(this.el.exportQuality.value, 10) || 2;
            const mult = this.safeMultiplier(requested);
            const transparent = !!this.el.exportTransparent?.checked;
            if (mult < requested) {
                this.toast(`Clamped to ${mult}×, ${requested}× exceeds this GPU's texture limit.`);
            } else {
                this.toast(`Generating ${mult}× PNG…`);
            }

            setTimeout(() => {
                let dataURL = null;
                try {
                    dataURL = this.captureCanvas(mult, transparent).toDataURL('image/png');
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
                this.el.trajPlay.innerHTML = '<i class="fa-solid fa-play"></i>Play';
                return;
            }
            this.state.trajPlaying = true;
            this.el.trajPlay.innerHTML = '<i class="fa-solid fa-pause"></i>Pause';
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
            this.cancelTween();
            this.endFind({ restyle: false });
            this.state.hiddenSpecies.clear();
            this.species = [];
            this._speciesByKey = new Map();
            this._spKey = [];
            this._lookup = null;
            this._fitDist = null;
            this._findLabels = [];
            this.state.trajPlaying = false;
            this.state.bounds = { xMin: 0, xMax: 0, yMin: 0, yMax: 0, zMin: 0, zMax: 0 };
            this.state.totalAtoms = 0;
            this.state.selectionOverrides = [];
            this.state.lastSelection = null;
            this.state.measureAtoms = [];
            this.surfaceID = null;
            this.currentModelData = null;
            this.currentExtension = null;
            this._shapes = { axis: [], iso: [], measure: [], find: [] };
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
            this.hideAtomInfo();
            if (this.el.viewHint) this.el.viewHint.hidden = true;
            if (this.el.speciesList) this.el.speciesList.textContent = '';
            this.el.measureInfo.textContent = '';
            this.el.measureInfo.hidden = true;
            this.el.perfWarning.classList.add('hidden');
            this.el.enableCrossAxis.checked = false;
            this.el.crossAxisControls.classList.add('hidden');
            this.el.spatialMode.value = '';
            this.el.spatialControls.classList.add('hidden');
            if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
            this.showUploadZone();
            this.el.fileInput.value = '';
            if (this.state.measureMode) this.setMeasureMode(false);
            this.syncToolbar();
        }

        // ───────────────────────────────────────────────────────────
        // TOGGLE HELPER
        // ───────────────────────────────────────────────────────────
        /**
         * The switches are real buttons, so Space and Enter already produce a
         * click; a separate keydown handler would flip them twice.
         */
        setupToggle(el, key, fn) {
            if (!el) return;
            el.addEventListener('click', () => {
                this.T[key] = !this.T[key];
                el.setAttribute('aria-checked', String(this.T[key]));
                this.syncToolbar();
                if (fn) fn(this.T[key]);
            });
        }

        // ───────────────────────────────────────────────────────────
        // CAMERA
        //
        // Every camera move goes through moveCamera: the move is made at once
        // with 3Dmol's own calls, the view it lands on becomes the target, and
        // when motion is welcome the camera glides there from where it was.
        // All of it happens inside one task, so the jump is never painted.
        // ───────────────────────────────────────────────────────────
        cancelTween() {
            if (this._tween) cancelAnimationFrame(this._tween);
            this._tween = null;
        }

        moveCamera(op, ms = 320) {
            if (!this.viewer) return;
            // A move made while another is still gliding builds on where that
            // one was going, so quick presses add up rather than cut short.
            const shown = this.viewer.getView();
            const pending = this._tween ? this._tweenTarget : null;
            this.cancelTween();
            if (pending) this.viewer.setView(pending);
            op();
            const to = this.viewer.getView();
            const moved = shown.some((v, i) => Math.abs(v - to[i]) > 1e-4);
            if (!moved || ms <= 0 || !motionOK()) return;
            this.viewer.setView(shown);
            this.tweenView(shown, to, ms);
        }

        tweenView(from, to, ms) {
            // Zoom is interpolated on the camera distance, logarithmically, so
            // a long zoom does not rush its last stretch.
            const cz = this.viewer.getPerceivedDistance() + from[3];
            const d0 = Math.max(1e-3, cz - from[3]), d1 = Math.max(1e-3, cz - to[3]);
            const q0 = { x: from[4], y: from[5], z: from[6], w: from[7] };
            const q1 = { x: to[4], y: to[5], z: to[6], w: to[7] };
            this._tweenTarget = to.slice();
            const start = performance.now();
            const frame = now => {
                const t = Math.min(1, (now - start) / ms);
                if (t >= 1) {
                    this._tween = null;
                    this.viewer.setView(to);
                    return;
                }
                const e = 1 - Math.pow(1 - t, 3);
                const q = qslerp(q0, q1, e);
                const d = d0 * Math.pow(d1 / d0, e);
                this.viewer.setView([
                    from[0] + (to[0] - from[0]) * e,
                    from[1] + (to[1] - from[1]) * e,
                    from[2] + (to[2] - from[2]) * e,
                    cz - d, q.x, q.y, q.z, q.w
                ]);
                this._tween = requestAnimationFrame(frame);
            };
            this._tween = requestAnimationFrame(frame);
        }

        /** Turn about an axis of the screen: x right, y up, z towards you. */
        rotateScreen(axis, deg) {
            if (!this.viewer || !deg) return;
            const v = this.viewer.getView();
            const q = qnorm(qmul(qaxis(axis, deg), { x: v[4], y: v[5], z: v[6], w: v[7] }));
            this.viewer.setView([v[0], v[1], v[2], v[3], q.x, q.y, q.z, q.w]);
        }

        /** Trackball turn from a pointer movement in pixels. */
        rotateByDrag(dx, dy, degPerPx) {
            if (!this.viewer) return;
            const v = this.viewer.getView();
            let q = { x: v[4], y: v[5], z: v[6], w: v[7] };
            q = qmul(qaxis('y', dx * degPerPx), q);
            q = qnorm(qmul(qaxis('x', dy * degPerPx), q));
            this.viewer.setView([v[0], v[1], v[2], v[3], q.x, q.y, q.z, q.w]);
        }

        zoomBy(factor, ms = 0) {
            if (!this.viewer) return;
            this.moveCamera(() => this.viewer.zoom(factor), ms);
        }

        panBy(dx, dy) {
            if (!this.viewer) return;
            this.viewer.translateScene(dx, dy);
        }

        /** Distance at which everything fits; the zoom rail's 1x mark. */
        fitDistance() {
            if (!this._fitDist) {
                const keep = this.viewer.getView();
                this.viewer.zoomTo();
                this._fitDist = this.viewer.getPerceivedDistance();
                this.viewer.setView(keep);
            }
            return this._fitDist;
        }

        /** Zoom level on the rail: log2 of the magnification over "fit". */
        zoomLevel() {
            if (!this.viewer) return 0;
            return Math.log2(this.fitDistance() / Math.max(1e-3, this.viewer.getPerceivedDistance()));
        }

        setZoomLevel(s) {
            if (!this.viewer) return;
            s = clamp(s, ZOOM_MIN, ZOOM_MAX);
            const v = this.viewer.getView();
            const cz = this.viewer.getPerceivedDistance() + v[3];
            v[3] = cz - this.fitDistance() / Math.pow(2, s);
            this.viewer.setView(v);
        }

        /** Initial orientation, everything in view. */
        resetView() {
            if (!this.viewer) return;
            this._lastAxis = null;
            this.moveCamera(() => {
                this.viewer.setView([0, 0, 0, 0, 0, 0, 0, 1]);
                this.viewer.zoomTo();
                this._fitDist = this.viewer.getPerceivedDistance();
            }, 420);
        }

        /** Everything in view, keeping the orientation. */
        fitAll() {
            if (!this.viewer) return;
            this.moveCamera(() => {
                this.viewer.zoomTo();
                this._fitDist = this.viewer.getPerceivedDistance();
            });
        }

        /** The selection the "zoom to selection" button and F use. */
        focusSelection() {
            if (this.find.active) {
                const f = this.find;
                if (f.idx >= 0 && f.residues[f.idx]) {
                    const set = new Set(f.residues[f.idx].atoms);
                    return { predicate: a => set.has(a.index) };
                }
                return f.sel;
            }
            return this.state.lastSelection;
        }

        zoomToSelection() {
            const sel = this.focusSelection();
            if (!sel || !this.countSelection(sel)) {
                this.toast('Find or select something first; this zooms to it.');
                return;
            }
            this.moveCamera(() => this.zoomToAtoms(sel));
        }

        /** F: the matches when a search is open, otherwise everything. */
        fitSmart() {
            if (this.focusSelection() && this.find.active) this.zoomToSelection();
            else this.fitAll();
        }

        /**
         * zoomTo, but never closer than a view about 18 Å across, so one small
         * residue or a single ion keeps some of its surroundings in view.
         */
        zoomToAtoms(sel, minRadius = 9) {
            const atoms = this.viewer.getModel().selectedAtoms(sel);
            if (!atoms.length) return;
            this.viewer.zoomTo(sel);
            let cx = 0, cy = 0, cz = 0;
            for (const a of atoms) { cx += a.x; cy += a.y; cz += a.z; }
            const c = { x: cx / atoms.length, y: cy / atoms.length, z: cz / atoms.length };
            let r2 = 25;                                    // 3Dmol's own floor, 5 Å
            for (const a of atoms) r2 = Math.max(r2, dist2(a, c));
            const r = Math.sqrt(r2);
            if (r < minRadius) this.viewer.zoom(r / minRadius);
        }

        /**
         * Look straight down an axis, keeping the centre and the zoom. The
         * same key or button again looks from the other side.
         */
        viewAlong(axis) {
            if (!this.viewer) return;
            // Where the camera is headed, if it is still gliding from a press.
            const cur = (this._tween && this._tweenTarget) ? this._tweenTarget.slice() : this.viewer.getView();
            const last = this._lastAxis;
            const dot = last ? cur.slice(4).reduce((s, v, i) => s + v * last.q[i], 0) : 0;
            const same = last && last.axis === axis && Math.abs(dot) > 0.9999;
            const flip = same ? !last.flip : false;
            const key = { x: flip ? 'yz-neg' : 'yz-pos', y: flip ? 'xz-neg' : 'xz-pos', z: flip ? 'xy-neg' : 'xy-pos' }[axis];
            const q = AXIS_QUATERNIONS[key];
            this.moveCamera(() => this.viewer.setView([cur[0], cur[1], cur[2], cur[3], q.x, q.y, q.z, q.w]), 380);
            this._lastAxis = { axis, flip, q: [q.x, q.y, q.z, q.w] };
            const sideLabel = flip ? '−' : '+';
            this.announce(`Looking along ${axis.toUpperCase()}, from the ${sideLabel}${axis.toUpperCase()} side.`);
        }

        centreOnAtom(atom) {
            if (!this.viewer || !atom) return;
            this.moveCamera(() => this.viewer.center({ index: atom.index }), 360);
        }

        residueSelection(atom) {
            if (atom.resi === undefined && !atom.resn) return { index: atom.index };
            const chain = atom.chain, resi = atom.resi, resn = atom.resn;
            return { predicate: a => a.resi === resi && a.chain === chain && a.resn === resn };
        }

        zoomToResidue(atom) {
            if (!this.viewer || !atom) return;
            this.moveCamera(() => this.zoomToAtoms(this.residueSelection(atom)), 420);
        }

        startSpin() {
            if (!this.viewer) return;
            const speed = parseFloat(this.el.spinSpeed?.value) || 1;
            this.viewer.spin('y', speed);
        }

        /** Tell a screen reader about a change that shows only in the canvas. */
        announce(msg) {
            const live = $('viewerLive');
            if (live) live.textContent = msg;
        }

        // ───────────────────────────────────────────────────────────
        // VIEW CONTROLS ON THE CANVAS
        // ───────────────────────────────────────────────────────────
        initNavigator() {
            const e = this.el;
            if (!e.navDock) return;

            /**
             * Tap for one step, hold to keep going. A pointer press nudges at
             * once, then after a short pause runs `rate(dt, held)` every frame
             * until release; a keyboard click (detail 0) takes one bigger,
             * animated step.
             */
            const hold = (btn, nudge, rate, keyStep) => {
                let raf = null, timer = null, last = 0, t0 = 0;
                const loop = now => {
                    rate((now - last) / 1000, (now - t0) / 1000);
                    last = now;
                    raf = requestAnimationFrame(loop);
                };
                const stop = () => {
                    clearTimeout(timer);
                    if (raf) cancelAnimationFrame(raf);
                    raf = timer = null;
                    btn.classList.remove('is-held');
                };
                btn.addEventListener('pointerdown', ev => {
                    if (!this.viewer || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
                    ev.preventDefault();
                    try { btn.setPointerCapture(ev.pointerId); } catch (err) { /* not capturable */ }
                    this.cancelTween();
                    btn.classList.add('is-held');
                    nudge();
                    timer = setTimeout(() => {
                        t0 = last = performance.now();
                        raf = requestAnimationFrame(loop);
                    }, 300);
                });
                ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => btn.addEventListener(t, stop));
                btn.addEventListener('click', ev => { if (ev.detail === 0 && this.viewer) keyStep(); });
                btn.addEventListener('contextmenu', ev => ev.preventDefault());
            };

            // Rotation: 60 degrees a second at first, 150 after a second and a half.
            const ROT = {
                up: ['x', -1], down: ['x', 1], left: ['y', -1], right: ['y', 1], ccw: ['z', 1], cw: ['z', -1]
            };
            e.navDock.querySelectorAll('[data-rot]').forEach(btn => {
                const [axis, sign] = ROT[btn.dataset.rot];
                hold(btn,
                    () => this.rotateScreen(axis, sign * 6),
                    (dt, held) => this.rotateScreen(axis, sign * dt * (60 + 90 * Math.min(1, held / 1.5))),
                    () => this.moveCamera(() => this.rotateScreen(axis, sign * 15), 180));
            });

            // Zoom: about 2.3 times a second while held.
            hold(e.zoomIn, () => this.zoomBy(1.12), dt => this.zoomBy(Math.pow(2, 1.2 * dt)), () => this.zoomBy(1.25, 160));
            hold(e.zoomOut, () => this.zoomBy(1 / 1.12), dt => this.zoomBy(Math.pow(2, -1.2 * dt)), () => this.zoomBy(0.8, 160));

            // Trackball: drag the centre of the pad. The knob follows the
            // pointer a little and springs back on release.
            const ball = e.navBall, knob = ball?.querySelector('.si-pad-knob');
            if (ball) {
                let drag = null;
                ball.addEventListener('pointerdown', ev => {
                    if (!this.viewer || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
                    ev.preventDefault();
                    try { ball.setPointerCapture(ev.pointerId); } catch (err) { /* not capturable */ }
                    this.cancelTween();
                    drag = { x: ev.clientX, y: ev.clientY, lx: ev.clientX, ly: ev.clientY };
                    ball.classList.add('is-dragging');
                });
                ball.addEventListener('pointermove', ev => {
                    if (!drag) return;
                    this.rotateByDrag(ev.clientX - drag.lx, ev.clientY - drag.ly, 0.7);
                    drag.lx = ev.clientX; drag.ly = ev.clientY;
                    const ox = clamp(ev.clientX - drag.x, -12, 12), oy = clamp(ev.clientY - drag.y, -12, 12);
                    if (knob) knob.style.transform = `translate(${ox}px, ${oy}px)`;
                });
                const end = () => {
                    if (!drag) return;
                    drag = null;
                    ball.classList.remove('is-dragging');
                    if (knob) knob.style.transform = '';
                };
                ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => ball.addEventListener(t, end));
            }

            this.initZoomRail();

            e.navFit?.addEventListener('click', () => this.fitAll());
            e.navZoomSel?.addEventListener('click', () => this.zoomToSelection());
            e.navReset?.addEventListener('click', () => this.resetView());
            e.navSpin?.addEventListener('click', () => e.toggleSpin?.click());
            e.navDock.querySelectorAll('[data-view]').forEach(btn =>
                btn.addEventListener('click', () => this.viewAlong(btn.dataset.view)));

            if (e.spinSpeed) {
                try {
                    const saved = parseFloat(localStorage.getItem(SPIN_KEY));
                    if (Number.isFinite(saved)) e.spinSpeed.value = saved;
                } catch (err) { /* no persistence */ }
                e.spinSpeed.addEventListener('input', () => {
                    if (this.T.spin) this.startSpin();
                    try { localStorage.setItem(SPIN_KEY, e.spinSpeed.value); } catch (err) { /* no persistence */ }
                });
            }

            // Fold the controls to one button, and remember it. On a phone
            // they start folded: touch already turns, pinches and pans, and
            // the canvas is small.
            let collapsed = null;
            try {
                const saved = localStorage.getItem(NAV_KEY);
                if (saved !== null) collapsed = saved === '1';
            } catch (err) { /* no persistence */ }
            if (collapsed === null) collapsed = window.matchMedia('(max-width: 639px)').matches;
            this.setNavCollapsed(collapsed, false);
            e.navToggle?.addEventListener('click', () => this.setNavCollapsed(!e.navDock.classList.contains('is-collapsed')));
        }

        setNavCollapsed(on, persist = true) {
            const e = this.el;
            e.navDock.classList.toggle('is-collapsed', on);
            e.navBody.hidden = on;
            e.navToggle.setAttribute('aria-expanded', String(!on));
            e.navToggle.title = on ? 'Show the view controls' : 'Hide the view controls';
            const icon = e.navToggle.querySelector('i');
            if (icon) icon.className = on ? 'fa-solid fa-compass' : 'fa-solid fa-minus';
            if (persist) {
                try { localStorage.setItem(NAV_KEY, on ? '1' : '0'); } catch (err) { /* no persistence */ }
            }
        }

        /**
         * The zoom rail is a vertical slider on the log of the magnification,
         * from a quarter of "fit" to 32 times it, with a notch at fit. It
         * follows the camera however it was moved (see setViewChangeCallback).
         */
        initZoomRail() {
            const rail = this.el.zoomRail;
            if (!rail) return;
            const fromPointer = ev => {
                const r = rail.getBoundingClientRect();
                const t = clamp((r.bottom - 6 - ev.clientY) / Math.max(1, r.height - 12), 0, 1);
                this.setZoomLevel(ZOOM_MIN + t * (ZOOM_MAX - ZOOM_MIN));
            };
            let dragging = false;
            rail.addEventListener('pointerdown', ev => {
                if (!this.viewer || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
                ev.preventDefault();
                rail.focus({ preventScroll: true });
                try { rail.setPointerCapture(ev.pointerId); } catch (err) { /* not capturable */ }
                this.cancelTween();
                dragging = true;
                rail.classList.add('is-dragging');
                fromPointer(ev);
            });
            rail.addEventListener('pointermove', ev => { if (dragging) fromPointer(ev); });
            const end = () => { dragging = false; rail.classList.remove('is-dragging'); };
            ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => rail.addEventListener(t, end));
            rail.addEventListener('keydown', ev => {
                if (!this.viewer) return;
                const s = this.zoomLevel();
                let to = null;
                if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') to = s + 0.25;
                else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') to = s - 0.25;
                else if (ev.key === 'PageUp') to = s + 1;
                else if (ev.key === 'PageDown') to = s - 1;
                else if (ev.key === 'Home') to = ZOOM_MIN;
                else if (ev.key === 'End') to = ZOOM_MAX;
                if (to === null) return;
                ev.preventDefault();
                ev.stopPropagation();
                this.setZoomLevel(to);
            });
        }

        syncZoomRail() {
            const rail = this.el.zoomRail;
            if (!rail || !this.viewer || !this._fitDist) return;
            const s = this.zoomLevel();
            const t = clamp((s - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN), 0, 1);
            rail.style.setProperty('--si-zoom', t.toFixed(4));
            const mag = Math.pow(2, s);
            const txt = mag >= 10 ? mag.toFixed(0) : mag.toFixed(1);
            if (this.el.zoomVal) this.el.zoomVal.textContent = `${txt}×`;
            rail.setAttribute('aria-valuenow', s.toFixed(2));
            rail.setAttribute('aria-valuetext', Math.abs(s) < 0.05 ? `${txt} times, fits everything` : `${txt} times`);
        }

        // ───────────────────────────────────────────────────────────
        // POINTER GESTURES THE LIBRARY DOES NOT MAKE
        //
        // 3Dmol turns on a left drag, zooms on a right drag and pinch, and
        // pans on a middle drag or three fingers. Here a right drag and a
        // two-finger drag pan (with the pinch still zooming), a click on an
        // atom can centre the view on it, and a double click or double tap
        // zooms to the residue. Listeners sit on the canvas's container in
        // the capture phase, so a gesture handled here never reaches 3Dmol.
        // ───────────────────────────────────────────────────────────
        initViewerGestures() {
            const host = this.el.viewerCanvas;
            if (!host || host.dataset.gestures) return;
            host.dataset.gestures = '1';

            // Focus follows a press, so the arrow keys work after a click;
            // 3Dmol cancels the mousedown, which would otherwise do this.
            host.addEventListener('pointerdown', () => {
                this.cancelTween();
                if (document.activeElement !== host) host.focus({ preventScroll: true });
            }, true);
            host.addEventListener('wheel', () => this.cancelTween(), { capture: true, passive: true });

            // Right drag pans. Ctrl+right drag still reaches 3Dmol (the slab).
            host.addEventListener('mousedown', ev => {
                if (ev.button !== 2 || ev.ctrlKey || !this.viewer) return;
                ev.stopPropagation();
                ev.preventDefault();
                let lx = ev.clientX, ly = ev.clientY;
                host.classList.add('is-panning');
                const move = m => { this.panBy(m.clientX - lx, m.clientY - ly); lx = m.clientX; ly = m.clientY; };
                const up = () => {
                    host.classList.remove('is-panning');
                    window.removeEventListener('mousemove', move, true);
                    window.removeEventListener('mouseup', up, true);
                };
                window.addEventListener('mousemove', move, true);
                window.addEventListener('mouseup', up, true);
            }, true);

            // Two fingers: pan with the midpoint, zoom with the spread. After
            // a two-finger gesture the remaining finger is ignored until all
            // are lifted, so 3Dmol does not turn the structure on the way out.
            let pinch = null, latched = false;
            const mid = t => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
            const spread = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
            host.addEventListener('touchstart', ev => {
                if (ev.touches.length < 2) { if (latched) { ev.stopPropagation(); ev.preventDefault(); } return; }
                ev.stopPropagation();
                ev.preventDefault();
                this.cancelTween();
                latched = true;
                pinch = { c: mid(ev.touches), d: spread(ev.touches) };
            }, { capture: true, passive: false });
            host.addEventListener('touchmove', ev => {
                if (!latched) return;
                ev.stopPropagation();
                ev.preventDefault();
                if (!pinch || ev.touches.length < 2 || !this.viewer) return;
                const c = mid(ev.touches), d = spread(ev.touches);
                this.panBy(c.x - pinch.c.x, c.y - pinch.c.y);
                if (pinch.d > 10 && d > 10) this.viewer.zoom(d / pinch.d);
                pinch = { c, d };
            }, { capture: true, passive: false });
            const release = ev => {
                if (!latched) return;
                if (ev.touches.length < 2) pinch = null;
                if (ev.touches.length === 0) latched = false;
                else ev.stopPropagation();
            };
            host.addEventListener('touchend', release, true);
            host.addEventListener('touchcancel', release, true);

            // Double click or double tap, told apart from a drag by distance.
            let down = null, lastTap = null;
            host.addEventListener('pointerdown', ev => { down = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp }; }, true);
            host.addEventListener('pointerup', ev => {
                if (!down || ev.button > 0) return;
                const tap = Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 6 && ev.timeStamp - down.t < 400;
                down = null;
                if (!tap) { lastTap = null; return; }
                if (lastTap && ev.timeStamp - lastTap.t < 380 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 24) {
                    lastTap = null;
                    this.onDoubleTap();
                } else {
                    lastTap = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp };
                }
            }, true);
        }

        /** A click on an atom, from 3Dmol. */
        onAtomClick(atom) {
            if (this.state.measureMode) { this.handleMeasureClick(atom); return; }
            // The second click of a double click lands after the first one
            // has started to move the view; it belongs to the double click.
            if (performance.now() < this._suppressClickUntil) return;
            this._lastAtomClick = { t: performance.now(), atom };
            this.dismissHint();
            if (this.T.clickInspect) this.showAtomInfo(atom);
            if (this.T.clickCentre) this.centreOnAtom(atom);
        }

        onDoubleTap() {
            if (!this.viewer || this.state.measureMode) return;
            this._suppressClickUntil = performance.now() + 150;
            const last = this._lastAtomClick;
            if (last.atom && performance.now() - last.t < 700) this.zoomToResidue(last.atom);
            else this.fitAll();
        }

        // ───────────────────────────────────────────────────────────
        // FIRST-USE HINT
        // ───────────────────────────────────────────────────────────
        maybeShowHint() {
            const hint = this.el.viewHint;
            if (!hint) return;
            let seen = false;
            try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch (err) { /* show it */ }
            hint.hidden = seen;
        }

        dismissHint() {
            const hint = this.el.viewHint;
            if (!hint || hint.hidden) return;
            hint.hidden = true;
            try { localStorage.setItem(HINT_KEY, '1'); } catch (err) { /* shown again next time */ }
        }

        // ───────────────────────────────────────────────────────────
        // SHELL: SIDEBAR, TABS, TOOLBAR, SHEETS
        // ───────────────────────────────────────────────────────────

        /** The WebGL canvas is sized from its container, so it has to be told. */
        syncViewer() {
            if (!this.viewer) return;
            this.viewer.resize();
            this.viewer.render();
            this.updateExportNote();
        }

        /** Toolbar buttons mirror state they do not own; refresh them from it. */
        syncToolbar() {
            const e = this.el;
            const press = (btn, on) => { if (btn) btn.setAttribute('aria-pressed', String(!!on)); };
            press(e.tbMeasure, this.state.measureMode);
            press(e.tbHydrogens, this.T.hydrogens);
            press(e.tbLabels, this.T.atomLabels);
            press(e.navSpin, this.T.spin);
            if (e.spinRow) e.spinRow.hidden = !this.T.spin;
            e.navZoomSel?.setAttribute('aria-disabled', String(!this.focusSelection()));
            this.syncSpeciesState();
            const fs = !!document.fullscreenElement;
            press(e.tbFullscreen, fs);
            if (e.tbFullscreen) {
                e.tbFullscreen.setAttribute('aria-label', fs ? 'Exit fullscreen' : 'Fullscreen');
                e.tbFullscreen.title = fs ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
                const icon = e.tbFullscreen.querySelector('i');
                if (icon) icon.className = fs ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
            }
        }

        setSidebarCollapsed(on, persist = true) {
            this.el.workspace.classList.toggle('is-collapsed', on);
            const btn = this.el.tbPanel;
            if (btn) {
                btn.setAttribute('aria-pressed', String(!on));
                btn.setAttribute('aria-label', on ? 'Show panel' : 'Hide panel');
            }
            // Focus must not vanish with the panel.
            if (on && btn && this.el.sidebar.contains(document.activeElement)) btn.focus();
            if (persist) {
                try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, on ? '1' : '0'); } catch (e) { /* no persistence */ }
            }
        }

        /** Resizable, collapsible sidebar; width and state survive a reload. */
        initLayout() {
            const e = this.el, ws = e.workspace, handle = e.sidebarHandle;
            if (!ws || !handle) return;
            const clamp = w => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
            let width = SIDEBAR_DEFAULT, collapsed = false;
            try {
                const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
                if (Number.isFinite(saved) && saved > 0) width = clamp(saved);
                collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
            } catch (err) { /* no persistence */ }

            const apply = () => {
                ws.style.setProperty('--si-sidebar-w', `${width}px`);
                handle.setAttribute('aria-valuenow', String(width));
            };
            const remember = () => {
                try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch (err) { /* no persistence */ }
            };
            const setWidth = w => { width = clamp(w); apply(); };
            apply();
            this.setSidebarCollapsed(collapsed, false);

            let dragging = false, startX = 0, startW = 0;
            handle.addEventListener('pointerdown', ev => {
                if (ev.button !== 0) return;
                dragging = true;
                startX = ev.clientX;
                startW = width;
                handle.setPointerCapture(ev.pointerId);
                handle.classList.add('is-dragging');
                // Suppressed during the drag so the pointer does not select
                // the surrounding text as it moves.
                document.body.style.userSelect = 'none';
                ev.preventDefault();
            });
            handle.addEventListener('pointermove', ev => {
                if (dragging) setWidth(startW + ev.clientX - startX);
            });
            const stop = () => {
                if (!dragging) return;
                dragging = false;
                handle.classList.remove('is-dragging');
                document.body.style.userSelect = '';
                remember();
            };
            handle.addEventListener('pointerup', stop);
            handle.addEventListener('pointercancel', stop);
            // Double-click returns to the default rather than leaving the user
            // to drag back to a size they cannot see a number for.
            handle.addEventListener('dblclick', () => { setWidth(SIDEBAR_DEFAULT); remember(); });
            handle.addEventListener('keydown', ev => {
                const step = ev.shiftKey ? 48 : 16;
                if (ev.key === 'ArrowRight') setWidth(width + step);
                else if (ev.key === 'ArrowLeft') setWidth(width - step);
                else if (ev.key === 'Home') setWidth(SIDEBAR_MIN);
                else if (ev.key === 'End') setWidth(SIDEBAR_MAX);
                else return;
                ev.preventDefault();
                remember();
            });

            e.collapseSidebarBtn?.addEventListener('click', () => this.setSidebarCollapsed(true));
            e.tbPanel?.addEventListener('click', () => this.setSidebarCollapsed(!ws.classList.contains('is-collapsed')));

            // Any change to the canvas box (drag, collapse, fullscreen, phone
            // rotation) has to reach the renderer, and the export size with it.
            if ('ResizeObserver' in window) {
                new ResizeObserver(rafThrottle(() => this.syncViewer())).observe(e.viewerCanvas);
            } else {
                window.addEventListener('resize', debounce(() => this.syncViewer(), 60));
            }
        }

        /** ARIA tab strip with arrow-key movement; the open tab is remembered. */
        initTabs() {
            const tabs = Array.from(document.querySelectorAll('.si-tabs-wrap [role="tab"]'));
            if (!tabs.length) return;
            const select = (btn, focus) => {
                for (const t of tabs) {
                    const on = t === btn;
                    t.setAttribute('aria-selected', String(on));
                    t.tabIndex = on ? 0 : -1;
                    const panel = $(t.dataset.tab);
                    if (panel) panel.hidden = !on;
                }
                if (focus) btn.focus();
                // The export size depends on the canvas, which may have changed
                // while the tab was out of sight.
                if (btn.dataset.tab === 'tabExport') this.updateExportNote();
                try { localStorage.setItem(TAB_KEY, btn.dataset.tab); } catch (err) { /* no persistence */ }
            };
            tabs.forEach((btn, i) => {
                btn.addEventListener('click', () => select(btn, false));
                btn.addEventListener('keydown', ev => {
                    let j = null;
                    if (ev.key === 'ArrowRight') j = (i + 1) % tabs.length;
                    else if (ev.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
                    else if (ev.key === 'Home') j = 0;
                    else if (ev.key === 'End') j = tabs.length - 1;
                    if (j === null) return;
                    ev.preventDefault();
                    select(tabs[j], true);
                });
            });
            let saved = null;
            try { saved = localStorage.getItem(TAB_KEY); } catch (err) { /* no persistence */ }
            select(tabs.find(t => t.dataset.tab === saved) || tabs[0], false);
        }

        initToolbar() {
            const e = this.el;
            e.tbReset?.addEventListener('click', () => this.resetView());
            e.tbSpin?.addEventListener('click', () => e.toggleSpin?.click());
            e.tbMeasure?.addEventListener('click', () => this.setMeasureMode(!this.state.measureMode));
            e.tbHydrogens?.addEventListener('click', () => e.toggleHydrogens?.click());
            e.tbLabels?.addEventListener('click', () => e.toggleAtomLabels?.click());
            e.tbScreenshot?.addEventListener('click', () => this.exportPNG());
            e.tbFullscreen?.addEventListener('click', () => this.toggleFullscreen());
            e.tbHelp?.addEventListener('click', () => this.openShortcuts());
            e.tbWater?.addEventListener('click', () => this.setKindHidden('water', !this.kindHidden('water')));
            document.addEventListener('fullscreenchange', () => this.syncToolbar());

            // Page head, shown once a structure is open.
            e.openAnotherBtn?.addEventListener('click', () => e.fileInput.click());
            e.headKeysBtn?.addEventListener('click', () => this.openShortcuts());

            // Species list.
            e.hideWaterBtn?.addEventListener('click', () => this.setKindHidden('water', !this.kindHidden('water')));
            e.hideIonsBtn?.addEventListener('click', () => this.setKindHidden('ion', !this.kindHidden('ion')));
            e.speciesMore?.addEventListener('click', () => {
                this._speciesShowAll = !this._speciesShowAll;
                this.renderSpecies();
            });

            // Atom card and first-use hint.
            e.atomClose?.addEventListener('click', () => this.hideAtomInfo());
            e.atomCentre?.addEventListener('click', () => this.centreOnAtom(this._cardAtom));
            e.atomZoom?.addEventListener('click', () => this.zoomToResidue(this._cardAtom));
            e.atomFind?.addEventListener('click', () => {
                const a = this._cardAtom;
                if (!a) return;
                const rn = (a.resn || '').trim();
                this.findText(rn || `element ${a.elem}`);
            });
            e.viewHintClose?.addEventListener('click', () => {
                this.dismissHint();
                e.viewerCanvas?.focus({ preventScroll: true });
            });

            this.syncToolbar();
        }

        toggleFullscreen() {
            if (document.fullscreenElement) {
                if (document.exitFullscreen) document.exitFullscreen();
                return;
            }
            const col = this.el.viewerColumn;
            if (!col || !document.fullscreenEnabled || typeof col.requestFullscreen !== 'function') {
                this.toast('Fullscreen is not available in this browser.', 'error');
                return;
            }
            col.requestFullscreen().catch(() => this.toast('The browser refused fullscreen.', 'error'));
        }

        openShortcuts() {
            const sheet = this.el.shortcutSheet;
            if (!sheet || !sheet.hidden) return;
            this._sheetReturnFocus = document.activeElement;
            sheet.hidden = false;
            this.el.shortcutClose?.focus();
        }

        closeShortcuts() {
            const sheet = this.el.shortcutSheet;
            if (!sheet || sheet.hidden) return;
            sheet.hidden = true;
            const back = this._sheetReturnFocus;
            this._sheetReturnFocus = null;
            if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
        }

        initShortcutSheet() {
            const sheet = this.el.shortcutSheet;
            if (!sheet) return;
            this.el.shortcutClose?.addEventListener('click', () => this.closeShortcuts());
            sheet.addEventListener('click', ev => { if (ev.target === sheet) this.closeShortcuts(); });
            // Keep Tab inside the dialog while it is open.
            sheet.addEventListener('keydown', ev => {
                if (ev.key !== 'Tab') return;
                const focusable = Array.from(sheet.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'));
                if (!focusable.length) return;
                const first = focusable[0], last = focusable[focusable.length - 1];
                if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
                else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
            });
        }

        /** Files dropped anywhere on the page load, with a full-page target while dragging. */
        initDrop() {
            const ind = this.el.dropIndicator;
            const hasFiles = ev => Array.from((ev.dataTransfer && ev.dataTransfer.types) || []).includes('Files');
            // dragenter and dragleave fire for every element boundary crossed;
            // a depth counter turns them into one enter and one leave.
            let depth = 0;
            const show = on => {
                if (ind) ind.hidden = !on;
                this.el.uploadZone.classList.toggle('is-over', on);
            };
            document.addEventListener('dragenter', ev => {
                if (!hasFiles(ev)) return;
                ev.preventDefault();
                depth++;
                show(true);
            });
            document.addEventListener('dragover', ev => {
                if (!hasFiles(ev)) return;
                ev.preventDefault();
                ev.dataTransfer.dropEffect = 'copy';
            });
            document.addEventListener('dragleave', ev => {
                if (!hasFiles(ev)) return;
                depth = Math.max(0, depth - 1);
                if (depth === 0) show(false);
            });
            document.addEventListener('drop', ev => {
                if (!hasFiles(ev)) return;
                ev.preventDefault();
                depth = 0;
                show(false);
                const file = ev.dataTransfer.files && ev.dataTransfer.files[0];
                if (file) this.handleFile(file);
            });
            // A drag abandoned outside the window sends no final dragleave.
            window.addEventListener('dragend', () => { depth = 0; show(false); });
        }

        // ───────────────────────────────────────────────────────────
        // EVENT WIRING
        // ───────────────────────────────────────────────────────────
        bindEvents() {
            const e = this.el;

            // ---- Upload ----
            e.uploadZone.addEventListener('click', ev => {
                // The zone itself is the big target; its own controls keep
                // their own jobs.
                if (ev.target.closest('button, input, select, a, label')) return;
                e.fileInput.click();
            });
            e.chooseFileBtn?.addEventListener('click', () => e.fileInput.click());
            e.fileInput.addEventListener('change', ev => this.handleFile(ev.target.files[0]));
            e.fetchPdbBtn.addEventListener('click', () => this.fetchPdb());
            e.pdbIdInput.addEventListener('keydown', ev => {
                if (ev.key === 'Enter') { ev.preventDefault(); this.fetchPdb(); }
            });
            document.querySelectorAll('.si-sample').forEach(btn =>
                btn.addEventListener('click', () => this.loadSample(btn.dataset.sample, btn)));
            this.initDrop();

            // ---- Shell ----
            this.initTabs();
            this.initLayout();
            this.initNavigator();
            this.initFind();
            this.initToolbar();
            this.initShortcutSheet();
            e.busyOverlay?.addEventListener('click', () => this.setBusy(false));

            // ---- Theme ----
            // js/site.js flips the class and saves the choice; this listener
            // runs after it and only repaints a background that follows it.
            document.querySelectorAll('.themeToggle').forEach(b => b.addEventListener('click', () => {
                if (e.bgSelect.value === 'theme') this.applyBackground();
            }));

            // ---- Style / colour ----
            e.colorSelect.addEventListener('change', () => {
                e.perElementColorContainer.classList.toggle('hidden', e.colorSelect.value !== 'custom');
                this.applyStyles();
            });
            e.styleSelect.addEventListener('change', () => this.applyStyles());
            e.bgSelect.addEventListener('change', () => this.applyBackground());

            // ---- Selection styling (Style tab) ----
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
                if (this.find.active) { this.endFind({ restyle: false }); this.applyBaseStyles(); }
                if (styleType === 'hidden') this.viewer.setStyle(sel, { hidden: true });
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
                    this.resetView();
                });
            });

            // ---- Advanced query ----
            e.focusBtn?.addEventListener('click', () => this.runQuery('zoom'));
            e.isolateBtn?.addEventListener('click', () => this.runQuery('isolate'));
            e.focusQuery?.addEventListener('keydown', ev => {
                if (ev.key === 'Enter') { ev.preventDefault(); this.runQuery('isolate'); }
            });
            $('exportSelBtn')?.addEventListener('click', () => this.exportSelectionPDB());

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
                if (on) this.startSpin(); else this.viewer.spin(false);
                this.announce(on ? 'Spinning.' : 'Spin stopped.');
            });
            this.setupToggle(e.toggleClickInspect, 'clickInspect', on => {
                if (!on) this.hideAtomInfo();
            });
            this.setupToggle(e.toggleClickCentre, 'clickCentre');
            this.setupToggle(e.toggleOutline, 'outline', () => this.applyOutline());

            // ---- Camera ----
            document.querySelectorAll('.axis-btn').forEach(b => b.addEventListener('click', () => {
                if (!this.viewer) return;
                const q = AXIS_QUATERNIONS[b.dataset.axis];
                if (!q) return;
                this._lastAxis = null;
                this.moveCamera(() => {
                    this.viewer.setView([0, 0, 0, 0, q.x, q.y, q.z, q.w]);
                    this.viewer.zoomTo();
                }, 380);
            }));
            e.centerBtn.addEventListener('click', () => this.resetView());

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
            // Arrow keys belong to the viewer only while it has focus, so the
            // page still scrolls with them everywhere else.
            e.viewerCanvas?.addEventListener('keydown', ev => {
                if (!this.viewer || ev.metaKey || ev.ctrlKey || ev.altKey) return;
                const step = (ev.shiftKey ? 3 : 1) * (ev.repeat ? 4 : 10);
                const turn = { ArrowLeft: ['y', -1], ArrowRight: ['y', 1], ArrowUp: ['x', -1], ArrowDown: ['x', 1] }[ev.key];
                if (!turn) return;
                ev.preventDefault();
                this.cancelTween();
                this.rotateScreen(turn[0], turn[1] * step);
            });

            document.addEventListener('keydown', ev => {
                const tag = (ev.target.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || tag === 'select' || ev.target.isContentEditable) return;
                if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
                // Keys typed on a focused control (a slider, a tab) are its own.
                if (ev.target.getAttribute && ev.target.getAttribute('role') === 'slider') return;
                const sheetOpen = e.shortcutSheet && !e.shortcutSheet.hidden;
                if (ev.key === 'Escape') {
                    if (sheetOpen) { this.closeShortcuts(); return; }
                    if (e.busyOverlay && !e.busyOverlay.classList.contains('hidden')) { this.setBusy(false); return; }
                    if (this.state.measureMode) { this.setMeasureMode(false); return; }
                    if (this.el.atomInfo && !this.el.atomInfo.hidden) { this.hideAtomInfo(); return; }
                    if (this.find.active) { this.endFind({ restoreView: true }); return; }
                    this.dismissHint();
                    return;
                }
                if (ev.key === '?') {
                    ev.preventDefault();
                    if (sheetOpen) this.closeShortcuts(); else this.openShortcuts();
                    return;
                }
                if (sheetOpen || !this.viewer) return;
                const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
                const act = {
                    r: () => this.resetView(),
                    0: () => this.resetView(),
                    f: () => (ev.shiftKey ? this.toggleFullscreen() : this.fitSmart()),
                    m: () => this.setMeasureMode(!this.state.measureMode),
                    h: () => e.toggleHydrogens?.click(),
                    s: () => e.toggleSpin?.click(),
                    l: () => e.toggleAtomLabels?.click(),
                    w: () => this.setKindHidden('water', !this.kindHidden('water')),
                    i: () => this.setKindHidden('ion', !this.kindHidden('ion')),
                    n: () => this.stepFind(ev.shiftKey ? -1 : 1),
                    x: () => this.viewAlong('x'),
                    y: () => this.viewAlong('y'),
                    z: () => this.viewAlong('z'),
                    q: () => this.moveCamera(() => this.rotateScreen('z', ev.shiftKey ? 45 : 15), 160),
                    e: () => this.moveCamera(() => this.rotateScreen('z', ev.shiftKey ? -45 : -15), 160),
                    '+': () => this.zoomBy(ev.repeat ? 1.08 : 1.25, ev.repeat ? 0 : 140),
                    '=': () => this.zoomBy(ev.repeat ? 1.08 : 1.25, ev.repeat ? 0 : 140),
                    '-': () => this.zoomBy(ev.repeat ? 1 / 1.08 : 0.8, ev.repeat ? 0 : 140),
                    '_': () => this.zoomBy(ev.repeat ? 1 / 1.08 : 0.8, ev.repeat ? 0 : 140)
                }[k];
                if (!act) return;
                // Space and Enter on a focused button are that button's.
                ev.preventDefault();
                act();
            });
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

            if (this.find.active && action === 'isolate') this.endFind({ restyle: false });
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
            this.viewer.render();
            this.moveCamera(() => this.viewer.zoomTo(sel));
            this.syncToolbar();
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