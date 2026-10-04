/**
 * Coordinate Manipulator | UI layer.
 *
 * Structure parsing, geometry, rotations, unit handling, box calculation, and
 * output formatting live in stemkit-core, with the record of the steps as
 * equations and as Python; this file handles DOM wiring and the view.
 *
 * The element-inference correction in the core changes results here: heme iron
 * (`FE` in `HEM`), selenomethionine selenium, and numeric-prefixed hydrogens
 * (`1HB`, `2HG1`) were previously misassigned or dropped, so molecular weights
 * and centres of mass for metalloproteins were wrong.
 */
import {
  parseStructure,
  massBreakdown,
  isTriclinic,
  anglesFromBoxVectors,
  structureStats,
  geometricCentre,
  centreOfMass,
  boundingBox,
  radiusOfGyration,
  rotateAtoms,
  rotationMatrix,
  IDENTITY_ROTATION,
  multiplyRotations,
  transposeRotation,
  rotateVector,
  eulerFromMatrix,
  quaternionFromMatrix,
  matrixFromQuaternion,
  axisAngleFromMatrix,
  rotationBetween,
  shapeAxis,
  axisTilt,
  netTransform,
  describeStep,
  transformScript,
  transformLatex,
  translateAtoms,
  centreAtoms,
  formatStructure,
  computeBoxFromBounds,
  boxFitsStructure,
  targetUnit,
  unitFactor,
  MIN_BOX_NM
} from '../src/core/structure.js';
import { createPythonPanel } from './python-panel.js';

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. State ---
  const state = {
    atoms: [],
    box: null,
    unit: 'A',
    format: null,
    title: '',
    unknownElements: [],
    boxEdited: false,
    // What has been applied, in the source unit, so the equivalent
    // `gmx editconf` command can be written out. Tracked as a net effect
    // rather than a history: editconf takes one -translate and one -rotate.
    applied: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, centre: null, order: [], pivots: [] },
    // Every step that changed the coordinates, in order, as stemkit-core
    // describes one (see netTransform): the source of the equations, the
    // Python script and the one rotation of the editconf command.
    steps: [],
    // Bumped whenever the coordinates change, so the preview cache knows to
    // rebuild without having to compare the atom list itself.
    revision: 0
  };

  const resetApplied = () => {
    state.applied = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, centre: null, order: [], pivots: [] };
    state.steps = [];
  };

  // --- 2. Bindings ---
  const $ = (id) => document.getElementById(id);

  const uploadZone = $('uploadZone');
  const fileInput = $('fileInput');
  const chooseFileBtn = $('chooseFileBtn');
  const dropStatus = $('dropStatus');
  const dropStatusText = $('dropStatusText');
  const dropIndicator = $('dropIndicator');
  const workspace = $('workspace');
  const outputArea = $('coordOutput');
  const exportFormat = $('exportFormat');
  const boxNote = $('boxSource');
  const boxNoteIcon = $('boxSourceIcon');
  const boxNoteText = $('boxSourceText');

  const btnShowAll = $('btnShowAll');
  const btnUndo = $('btnUndo');
  const btnRedo = $('btnRedo');
  const btnCloseWorkspace = $('btnCloseWorkspace');
  const massDetail = $('massDetail');
  const massTable = $('massTable');
  const massAssumptions = $('massAssumptions');
  const btnMassDownload = $('btnMassDownload');
  const btnMassDetail = $('btnMassDetail');
  const showBox = $('showBox');
  const editconfOut = $('editconfOut');
  const editconfNotes = $('editconfNotes');
  const editconfNotesList = $('editconfNotesList');
  const btnCopyEditconf = $('btnCopyEditconf');
  const fileNameInput = $('exportName');
  const exportFileName = $('exportFileName');
  const exportUnitNote = $('exportUnitNote');
  const viewerCanvas = $('viewerCanvas');
  const viewerStyle = $('viewerStyle');
  const viewerNote = $('viewerNote');
  const viewerFallback = $('viewerFallback');
  const btnViewerReset = $('btnViewerReset');
  const previewPanel = $('previewPanel');
  const previewFormat = $('previewFormat');
  const previewCount = $('previewCount');
  const previewWarn = $('previewWarn');
  const previewBusy = $('previewBusy');
  const previewBusyText = $('previewBusyText');

  // The statistics panel is a set of individual fields rather than one block,
  // so each is written separately.
  const statAtomCount = $('statAtomCount');
  const statGeoCenter = $('statGeoCenter');
  const statMassCenter = $('statMassCenter');
  const statMolWeight = $('statMolWeight');
  const statBoundingBox = $('statBoundingBox');
  const fileLabel = $('fileLabel');
  const formatBadge = $('formatBadge');
  const unitBadge = $('unitBadge');
  const sourceUnitLabels = document.querySelectorAll('.cm-src-unit');

  const rotX = $('rotX');
  const rotY = $('rotY');
  const rotZ = $('rotZ');
  const rotPivot = $('rotPivot');
  const transX = $('transX');
  const transY = $('transY');
  const transZ = $('transZ');

  const boxLx = $('boxLx');
  const boxLy = $('boxLy');
  const boxLz = $('boxLz');
  const boxPad = $('boxPad');

  const btnRotate = $('btnApplyRot');
  const btnResetRot = $('btnResetRot');
  const btnCopyMatrix = $('btnCopyMatrix');
  const rotAlign = $('rotAlign');
  const rotAlignLabel = $('rotAlignLabel');
  const rotMatrix = $('rotMatrix');
  const rotTurn = $('rotTurn');
  const rotTilt = $('rotTilt');
  const rotTiltLabel = $('rotTiltLabel');
  const tiltNowX = $('tiltNowX');
  const tiltNowY = $('tiltNowY');
  const tiltNowZ = $('tiltNowZ');
  const tiltAfterRow = $('tiltAfterRow');
  const tiltAfterX = $('tiltAfterX');
  const tiltAfterY = $('tiltAfterY');
  const tiltAfterZ = $('tiltAfterZ');
  const viewerOverlay = $('viewerOverlay');
  const viewerHud = $('viewerHud');
  const hudPending = $('hudPending');
  const hudPendingText = $('hudPendingText');
  const hudTilt = $('hudTilt');
  const hudTiltLabel = $('hudTiltLabel');
  const hudTiltText = $('hudTiltText');
  const dragView = $('dragView');
  const dragMolecule = $('dragMolecule');
  const recordSection = $('cmRecord');
  const recordCount = $('cmStepCount');
  const recordEmpty = $('cmStepsEmpty');
  const recordList = $('cmStepList');
  const mathsBody = $('cmMathsBody');
  const btnCopyLatex = $('btnCopyLatex');
  const recordPython = $('cmPython');
  const btnShowMaths = $('btnShowMaths');
  const btnShowPython = $('btnShowPython');
  const btnTranslate = $('btnApplyTrans');
  const btnCentre = $('btnCenterSys');
  const centerMode = $('centerMode');
  const btnRestore = $('btnRestore');
  const btnBoxFromBounds = $('btnBoxFromBounds');
  const btnDownload = $('btnDownload');
  const btnCopy = $('btnCopyBuffer');

  // Everything that acts on coordinates is disabled until there are some.
  const needsStructure = document.querySelectorAll('[data-needs-structure]');
  function setStructureLoaded(on) {
    needsStructure.forEach(el => { el.disabled = !on; });
  }

  let originalAtoms = [];

  // --- 3. File intake ---
  // The whole empty state is the click target; its own controls keep their
  // jobs, and the synthetic click from `fileInput.click()` bubbles back here
  // and is ignored for the same reason.
  if (uploadZone) uploadZone.addEventListener('click', (e) => {
    if (e.target.closest('button, input, a, label')) return;
    if (fileInput) fileInput.click();
  });
  if (chooseFileBtn) chooseFileBtn.addEventListener('click', () => {
    if (fileInput) fileInput.click();
  });
  if (fileInput) fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });

  // Files dropped anywhere on the page load, with a full-page target while
  // dragging. dragenter and dragleave fire for every element boundary
  // crossed; a depth counter turns them into one enter and one leave.
  const hasFiles = (e) =>
    Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  let dragDepth = 0;
  const showDropTarget = (on) => {
    if (dropIndicator) dropIndicator.hidden = !on;
    if (uploadZone) uploadZone.classList.toggle('is-over', on);
  };
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    showDropTarget(true);
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDropTarget(false);
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    showDropTarget(false);
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  // A drag abandoned outside the window sends no final dragleave.
  window.addEventListener('dragend', () => { dragDepth = 0; showDropTarget(false); });

  /** Swap a button's icon for a spinner while an async action runs. */
  function setButtonBusy(btn, on) {
    const icon = btn && btn.querySelector('i');
    if (!icon) return;
    if (on) {
      icon.dataset.icon = icon.className;
      icon.className = 'fa-solid fa-circle-notch fa-spin';
    } else if (icon.dataset.icon) {
      icon.className = icon.dataset.icon;
      delete icon.dataset.icon;
    }
  }

  /** Load a bundled sample through the same path as a dropped file. */
  async function loadSample(path, btn) {
    setButtonBusy(btn, true);
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      handleFile(new File([text], path.split('/').pop(), { type: 'text/plain' }));
    } catch (err) {
      console.error(err);
      showToast('The sample could not be fetched. Samples need the page to be ' +
                'served over HTTP rather than opened from disk.', 'error');
    } finally {
      setButtonBusy(btn, false);
    }
  }
  document.querySelectorAll('.cm-sample').forEach(btn =>
    btn.addEventListener('click', () => loadSample(btn.dataset.sample, btn)));

  /**
   * Busy indicator for work that blocks the thread: reading and parsing a
   * file, or formatting a very large buffer. Each has its own slot so one
   * finishing cannot clear the other. Shown on the empty state while that is
   * visible and in the buffer header once a structure is loaded.
   */
  const busy = { load: null, format: null };
  function setBusy(kind, label) {
    busy[kind] = label || null;
    const current = busy.load || busy.format;
    if (uploadZone) uploadZone.setAttribute('aria-busy', String(Boolean(busy.load)));
    if (dropStatus) {
      dropStatus.hidden = !busy.load;
      dropStatusText.textContent = busy.load || '';
    }
    if (previewPanel) previewPanel.setAttribute('aria-busy', String(Boolean(current)));
    if (previewBusy) {
      previewBusy.hidden = !current;
      previewBusyText.textContent = current || '';
    }
  }

  function handleFile(file) {
    const name = (file && file.name) || '';
    const ext = name.split('.').pop().toLowerCase();

    if (!['pdb', 'gro', 'xyz', 'ent'].includes(ext)) {
      showToast(`${name || 'That file'} is not a PDB, GRO or XYZ file.`, 'error');
      return;
    }

    setBusy('load', `Reading ${name}`);
    const reader = new FileReader();
    reader.onerror = () => {
      setBusy('load', null);
      showToast(`${name} could not be read.`, 'error');
    };
    reader.onload = (e) => {
      // Deferred a tick so the busy state paints before the parse, which is
      // synchronous, holds the thread.
      setTimeout(() => {
        try {
          loadStructure(e.target.result, name);
        } catch (err) {
          console.error(err);
          showToast(`${name} could not be parsed.`, 'error');
        } finally {
          setBusy('load', null);
        }
      }, 0);
    };
    reader.readAsText(file);
    if (fileInput) fileInput.value = '';
  }

  function loadStructure(text, name) {
    const result = parseStructure(text, name);

    if (!result || result.atoms.length === 0) {
      showToast(`No atoms could be parsed from ${name}.`, 'error');
      return;
    }

    state.atoms = result.atoms;
    originalAtoms = result.atoms.map(a => ({ ...a }));
    state.box = result.box;
    // Off-diagonal cell components, present only for a triclinic box.
    state.boxVectors = result.boxVectors || null;
    state.fileName = name || null;
    state.revision++;
    undoStack.length = 0;
    redoStack.length = 0;
    updateUndoButton();
    resetApplied();
    state.unit = result.unit;
    state.format = result.format;
    state.title = result.title || name;
    state.unknownElements = result.unknownElements || [];
    state.boxEdited = false;

    if (fileLabel) fileLabel.textContent = name;
    if (formatBadge) formatBadge.textContent = (result.format || '').toUpperCase();
    if (unitBadge) unitBadge.textContent = result.unit === 'nm' ? 'nm' : 'Å';

    // Shown before the viewer is built so the canvas has a size to fit to.
    if (uploadZone) uploadZone.hidden = true;
    if (workspace) {
      workspace.hidden = false;
      workspace.focus({ preventScroll: true });
      // The page head sits above the workspace; bring the whole workspace
      // (it is one viewport tall on a desktop) up under the navigation bar.
      workspace.scrollIntoView({ block: 'start' });
    }
    setStructureLoaded(true);
    resetTurn();

    seedBoxInputs();
    updateSystemStats();
    updateExportInfo();
    renderOutput();
    renderEditconf();
    renderViewer();
    updateTurnReadout();
    renderRecord();

    if (state.unknownElements.length) {
      showToast(
        `Unrecognised element symbol(s): ${state.unknownElements.join(', ')}. ` +
        `Those atoms contribute no mass to the centre of mass or molecular weight.`,
        'warn'
      );
    }
    // What the reader passed over, such as the models after the first of a
    // multi-model PDB (GROMACS reads only the first, and so does this page).
    for (const w of result.warnings || []) showToast(w, 'warn');
  }

  // --- 4. Statistics ---
  function updateSystemStats() {
    if (!statAtomCount) return;

    const s = structureStats(state.atoms);
    const bb = s.boundingBox;
    const com = centreOfMass(state.atoms);
    const u = state.unit === 'nm' ? 'nm' : 'Å';
    // A centred structure sits at a few 1e-16 either side of zero; that is
    // 0.000, not -0.000.
    const f = (n) => {
      const t = Number.isFinite(n) ? n.toFixed(3) : '0.000';
      return t === '-0.000' ? '0.000' : t;
    };
    const triple = (x, y, z) => `${f(x)}, ${f(y)}, ${f(z)}`;

    statAtomCount.textContent = s.nAtoms;

    // The mean of the coordinates, the same centre "Centre on origin" and the
    // rotation pivot use, so centring reads 0, 0, 0 here. (It showed the
    // bounding-box midpoint, which is a different point.)
    if (statGeoCenter) {
      const g = s.geometricCentre;
      statGeoCenter.textContent = s.nAtoms ? triple(g.x, g.y, g.z) : '0.0, 0.0, 0.0';
    }

    if (statMassCenter) {
      statMassCenter.textContent = (com && com.mass)
        ? triple(com.x, com.y, com.z)
        : '0.0, 0.0, 0.0';
    }

    if (statMolWeight) {
      statMolWeight.textContent = s.totalMass ? `${s.totalMass.toFixed(2)} Da` : '—';
      if (massDetail && massDetail.open) renderMassDetail();
    }

    if (statBoundingBox) {
      statBoundingBox.textContent = s.nAtoms
        ? `${(bb.maxX - bb.minX).toFixed(1)} × ${(bb.maxY - bb.minY).toFixed(1)} × ` +
          `${(bb.maxZ - bb.minZ).toFixed(1)} ${u}`
        : '0.0 × 0.0 × 0.0';
    }

    sourceUnitLabels.forEach(el => { el.textContent = u; });
  }

  /** The base name the download and the editconf command share. */
  function exportBaseName() {
    return (fileNameInput && fileNameInput.value.trim()) || 'output';
  }

  /** File name and unit conversion for the chosen format, kept current as
   *  either changes. */
  function updateExportInfo() {
    const format = exportFormat ? exportFormat.value : 'pdb';
    if (exportFileName) exportFileName.textContent = `${exportBaseName()}.${format}`;
    if (previewFormat) previewFormat.textContent = format.toUpperCase();
    if (exportUnitNote) {
      const src = state.unit === 'nm' ? 'nm' : 'Å';
      const dst = targetUnit(format) === 'nm' ? 'nm' : 'Å';
      exportUnitNote.textContent = src === dst
        ? `Coordinates stay in ${src}.`
        : `Coordinates are converted from ${src} to ${dst}.`;
    }
  }

  // --- 5. Box ---
  function seedBoxInputs() {
    if (!boxLx) return;
    const pad = boxPad ? Number(boxPad.value) || 10 : 10;
    const box = state.box && state.box.length >= 3
      ? state.box
      : computeBoxFromBounds(state.atoms, state.unit, pad);

    boxLx.value = box[0].toFixed(4);
    boxLy.value = box[1].toFixed(4);
    boxLz.value = box[2].toFixed(4);
    updateBoxNote(box);
  }

  function currentBox() {
    if (state.boxEdited && boxLx) {
      const pad = boxPad ? Number(boxPad.value) || 10 : 10;
      const fallback = computeBoxFromBounds(state.atoms, state.unit, pad);
      const pick = (raw, fb) => {
        const v = Number(raw);
        return Number.isFinite(v) && v > 0 ? v : fb;
      };
      return [
        pick(boxLx.value, fallback[0]),
        pick(boxLy.value, fallback[1]),
        pick(boxLz.value, fallback[2])
      ];
    }
    if (state.box && state.box.length >= 3) return state.box.slice(0, 3);
    const pad = boxPad ? Number(boxPad.value) || 10 : 10;
    return computeBoxFromBounds(state.atoms, state.unit, pad);
  }

  /**
   * Describe where the current box dimensions came from.
   *
   * Whether a box was read from the file or inferred from a padded bounding
   * box changes what the export means, so it is stated rather than implied.
   */
  function boxSourceText() {
    if (state.boxEdited) return 'Box entered manually.';
    if (state.box && state.box.length >= 3) {
      return state.format === 'pdb'
        ? 'Box derived from the PDB CRYST1 record.'
        : 'Box read from the source .gro file.';
    }
    return 'Box set from the padded bounding box.';
  }

  function updateBoxNote(box, fit = boxFitsStructure(state.atoms, state.unit, box)) {
    if (!boxNote) return;
    const source = boxSourceText();
    boxNoteText.textContent = fit.fits
      ? `Box (nm): ${box.map(v => v.toFixed(3)).join(' × ')}, ${source}`
      : `${source} The structure overflows the box along ${fit.overflow.join(', ')}. ` +
        `Increase those dimensions or the system will be clipped.`;
    boxNote.classList.toggle('stk-callout-warn', !fit.fits);
    if (boxNoteIcon) {
      boxNoteIcon.className = fit.fits ? 'fa-solid fa-circle-info' : 'fa-solid fa-triangle-exclamation';
    }
  }

  [boxLx, boxLy, boxLz].filter(Boolean).forEach(el =>
    el.addEventListener('input', () => {
      state.boxEdited = true;
      // Typing lengths describes a rectangular cell, so any triclinic
      // components read from the source no longer apply.
      state.boxVectors = null;
      renderOutput();
      renderEditconf();
      refreshBox();
    }));

  if (boxPad) boxPad.addEventListener('input', () => {
    if (!state.boxEdited) seedBoxInputs();
    renderOutput();
    renderEditconf();
    refreshBox();
  });

  // Fitting discards whatever box the file carried and lets the padded
  // bounding box drive the cell from here on, so a later transform keeps the
  // fit rather than reviving the old lengths.
  if (btnBoxFromBounds) btnBoxFromBounds.addEventListener('click', () => {
    if (!requireStructure()) return;
    state.box = null;
    state.boxVectors = null;
    state.boxEdited = false;
    seedBoxInputs();
    renderOutput();
    renderEditconf();
    refreshBox();
  });

  // --- 6. Transforms (delegated to the core) ---
  function requireStructure() {
    if (state.atoms.length === 0) {
      showToast('Load a structure first.', 'error');
      return false;
    }
    return true;
  }

  if (btnRotate) btnRotate.addEventListener('click', () => {
    if (!requireStructure()) return;
    const { x: dx, y: dy, z: dz } = fieldAngles();
    if (!dx && !dy && !dz) {
      showToast('No rotation to apply yet. Type an angle, or choose Turn molecule and drag it.', 'info');
      return;
    }

    // Rotate about the pivot chosen under "Rotate about": the geometric
    // centre (the default, so the structure does not swing away), the centre
    // of mass, or the origin. Velocities rotate with the frame but are not
    // translated.
    const pivotName = pivotMode();
    const pivot = pivotPoint(pivotName);
    pushUndo('rotation');
    state.atoms = rotateAtoms(state.atoms, dx, dy, dz, pivot);
    state.revision++;
    state.applied.rx += dx; state.applied.ry += dy; state.applied.rz += dz;
    state.applied.order.push('rotate');
    if (!state.applied.pivots) state.applied.pivots = [];
    state.applied.pivots.push(pivotName);
    state.steps.push({ type: 'rotate', angles: { x: dx, y: dy, z: dz }, pivot: pivotName, centre: pivot });
    // The rotation is in the coordinates now, so nothing is left waiting. A
    // turn about a centre leaves the structure where it was, so the view
    // keeps its place and zoom.
    resetTurn();
    afterTransform(`Rotated by (${dx}°, ${dy}°, ${dz}°).`, { keepView: pivotName !== 'origin' });

    // The cell is not rotated with the contents, and it defines the lattice.
    // For an isolated molecule that is harmless; for a periodic system it
    // means the images no longer tile as they did, so the rotated coordinates
    // are only safe as a starting geometry to re-solvate, not as a drop-in
    // replacement for the original frame.
    if (state.box && state.box.length >= 3) {
      showToast(
        'The cell was not rotated with the contents. For a periodic system, ' +
        're-solvate or rebuild the box before running from these coordinates.',
        'warn'
      );
    }
  });

  if (btnTranslate) btnTranslate.addEventListener('click', () => {
    if (!requireStructure()) return;
    const dx = Number(transX.value) || 0;
    const dy = Number(transY.value) || 0;
    const dz = Number(transZ.value) || 0;
    if (!dx && !dy && !dz) {
      showToast('No distance to move by yet. Type one first.', 'info');
      return;
    }
    pushUndo('translation');
    state.atoms = translateAtoms(state.atoms, dx, dy, dz);
    state.revision++;
    state.applied.tx += dx; state.applied.ty += dy; state.applied.tz += dz;
    state.applied.order.push('translate');
    state.steps.push({ type: 'translate', vector: { x: dx, y: dy, z: dz } });
    afterTransform(`Translated by (${dx}, ${dy}, ${dz}).`);
  });

  // The page offers one "Centre on origin" button plus a mode select, rather than
  // a separate button per centring method.
  if (btnCentre) btnCentre.addEventListener('click', () => {
    if (!requireStructure()) return;
    const mode = centerMode && centerMode.value === 'mass' ? 'mass' : 'geometric';
    const was = mode === 'mass' ? centreOfMass(state.atoms) : geometricCentre(state.atoms);
    pushUndo('centring');
    state.atoms = centreAtoms(state.atoms, mode);
    state.revision++;
    state.applied.centre = mode;
    state.applied.order.push('centre');
    state.steps.push({ type: 'centre', mode, centre: { x: was.x, y: was.y, z: was.z } });
    afterTransform(mode === 'mass'
      ? 'Centred on the centre of mass.'
      : 'Centred on the geometric centroid.');
  });

  if (btnRestore) btnRestore.addEventListener('click', () => {
    if (originalAtoms.length === 0) return;
    pushUndo('restore to original');
    state.atoms = originalAtoms.map(a => ({ ...a }));
    state.revision++;
    resetApplied();
    afterTransform('Restored the original coordinates.');
  });

  function afterTransform(message, { keepView = false } = {}) {
    updateSystemStats();
    renderEditconf();
    if (!state.boxEdited) seedBoxInputs();
    renderOutput();
    renderViewer({ keepView });
    updateTurnReadout();
    renderRecord();
    showToast(message, 'success');
  }

  // --- 7. Output ---
  let previewCache = { signature: null, text: '' };
  let previewToken = 0;

  // Capped by default so a large system stays responsive, with the button
  // lifting it. The cap is generous enough that most structures are shown
  // whole and the button never appears.
  const PREVIEW_LIMIT = 5000;

  function lineCount(text) {
    if (!text) return 0;
    let n = 0;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
    return text.endsWith('\n') ? n : n + 1;
  }

  /** Badges in the buffer header: how much text there is and whether the
   *  cell holds the structure. */
  function updatePreviewMeta(text, limited, fit) {
    if (previewCount) {
      previewCount.textContent = limited
        ? `first ${PREVIEW_LIMIT.toLocaleString()} of ${state.atoms.length.toLocaleString()} atoms`
        : `${lineCount(text).toLocaleString()} lines`;
    }
    if (previewWarn) {
      previewWarn.hidden = fit.fits;
      previewWarn.textContent = fit.fits ? '' : `Overflows box: ${fit.overflow.join(', ')}`;
    }
  }

  if (exportFormat) exportFormat.addEventListener('change', () => {
    updateExportInfo();
    renderOutput();
    renderEditconf();
    renderPython();
  });

  function renderOutput() {
    if (!outputArea || state.atoms.length === 0) return;

    const format = exportFormat ? exportFormat.value : 'pdb';
    const box = currentBox();
    const fit = boxFitsStructure(state.atoms, state.unit, box);
    updateBoxNote(box, fit);

    // Above PREVIEW_LIMIT atoms only the first PREVIEW_LIMIT are shown until
    // Show all is pressed; then the whole buffer is shown, however large, so
    // it can be scrolled to the end. Two things keep that affordable.
    //
    // First, the result is cached against a signature of what it was built
    // from, so the common case, a redraw where nothing relevant changed,
    // costs nothing. Formatting is only repeated when the coordinates, the
    // format or the cell actually change.
    //
    // Second, for a large system the work is handed to a later task rather
    // than done inside the click handler. Formatting a million atoms takes
    // seconds; doing that synchronously would freeze the page with no
    // indication why, so the row count and a busy badge are painted first
    // and the text arrives when it is ready.
    const limited = !state.showAllRows && state.atoms.length > PREVIEW_LIMIT;
    const rows = limited ? state.atoms.slice(0, PREVIEW_LIMIT) : state.atoms;

    if (btnShowAll) {
      btnShowAll.hidden = state.atoms.length <= PREVIEW_LIMIT;
      btnShowAll.textContent = state.showAllRows
        ? `Show first ${PREVIEW_LIMIT.toLocaleString()}`
        : `Show all ${state.atoms.length.toLocaleString()}`;
    }

    const signature = [
      state.revision, format, state.unit, limited,
      (box || []).join(','), (state.boxVectors || []).join(',')
    ].join('|');

    // Every path takes a fresh token so a deferred build that is still in
    // flight cannot land on top of newer text.
    const token = ++previewToken;

    if (previewCache.signature === signature) {
      outputArea.textContent = previewCache.text;
      updatePreviewMeta(previewCache.text, limited, fit);
      setBusy('format', null);
      return;
    }

    const build = () => formatStructure(rows, format, {
      sourceUnit: state.unit,
      box,
      boxVectors: state.boxVectors,
      title: state.title
    });

    const ASYNC_ABOVE = 20000;
    if (rows.length <= ASYNC_ABOVE) {
      previewCache = { signature, text: build() };
      outputArea.textContent = previewCache.text;
      updatePreviewMeta(previewCache.text, limited, fit);
      setBusy('format', null);
      return;
    }

    outputArea.textContent =
      `Formatting ${state.atoms.length.toLocaleString()} atoms…`;
    if (previewCount) previewCount.textContent = `${state.atoms.length.toLocaleString()} atoms`;
    setBusy('format', 'Formatting');

    setTimeout(() => {
      if (token !== previewToken) return;
      previewCache = { signature, text: build() };
      outputArea.textContent = previewCache.text;
      updatePreviewMeta(previewCache.text, limited, fit);
      setBusy('format', null);
    }, 0);
  }

  function fullOutput() {
    const format = exportFormat ? exportFormat.value : 'pdb';
    return formatStructure(state.atoms, format, {
      boxVectors: state.boxVectors,
      sourceUnit: state.unit,
      box: currentBox(),
      title: state.title
    });
  }

  if (btnDownload) btnDownload.addEventListener('click', () => {
    if (!requireStructure()) return;
    warnIfTurnWaiting();
    const format = exportFormat ? exportFormat.value : 'pdb';
    const fileName = `${exportBaseName()}.${format}`;
    const blob = new Blob([fullOutput()], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast(`Downloaded ${fileName}.`, 'success');
  });

  /**
   * Copy-to-clipboard buttons confirm in place, swapping their label for a
   * tick for two seconds, so a copy does not need a toast.
   */
  function copyButton(btn, getText, failMessage) {
    if (!btn) return;
    const idle = btn.innerHTML;
    let timer = null;
    btn.addEventListener('click', () => {
      const text = getText();
      if (text === null) return;
      const done = () => {
        btn.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>Copied';
        clearTimeout(timer);
        timer = setTimeout(() => { btn.innerHTML = idle; }, 2000);
      };
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        showToast(failMessage, 'error');
        return;
      }
      navigator.clipboard.writeText(text).then(done, () => showToast(failMessage, 'error'));
    });
  }

  copyButton(btnCopy, () => {
    if (!requireStructure()) return null;
    warnIfTurnWaiting();
    return fullOutput();
  },
    'Clipboard access denied. Select the text and copy it by hand.');

  // --- 8. Utilities ---
  /**
   * @param {string} msg
   * @param {'info'|'success'|'error'|'warn'} [type]
   */
  function showToast(msg, type = 'info') {
    const container = $('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    const variant = type === 'success' ? ' stk-toast-ok'
      : type === 'error' ? ' stk-toast-danger'
        : type === 'warn' ? ' stk-toast-warn' : '';
    toast.className = 'stk-toast' + variant;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const icon = document.createElement('i');
    icon.className = 'fa-solid ' + (type === 'success' ? 'fa-circle-check'
      : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info');
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    body.textContent = msg;
    toast.append(icon, body);
    container.appendChild(toast);
    // Errors carry a reason the user may want to read twice.
    setTimeout(() => {
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 300);
    }, type === 'error' ? 6000 : 3000);
  }

  /* --- 3D viewer -----------------------------------------------------------
   * Rendered with 3Dmol, the same library the Structure Inspector uses. The
   * model is rebuilt from `state.atoms` after every transformation, so the
   * view always shows the coordinates that would be exported rather than the
   * ones that were loaded.
   */

  let viewer = null;
  let viewerFailed = false;

  // Above this, rebuilding the model on every rotation costs more than the
  // view is worth; the export is unaffected.
  const VIEW_LIMIT = 20000;

  /**
   * Whether the browser will grant a WebGL context.
   *
   * The requirement is WebGL, not a discrete GPU: integrated graphics are
   * fine, and browsers fall back to software rendering where no hardware path
   * exists. Probed once and cached.
   */
  let webglChecked;
  function webglAvailable() {
    if (webglChecked !== undefined) return webglChecked;
    try {
      const c = document.createElement('canvas');
      webglChecked = Boolean(
        c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')
      );
    } catch (e) {
      webglChecked = false;
    }
    return webglChecked;
  }

  function showViewerFallback(message) {
    if (!viewerFallback) return;
    viewerFallback.textContent = message;
    viewerFallback.hidden = false;
    if (viewerCanvas) viewerCanvas.style.display = 'none';
  }

  function styleSpec() {
    switch (viewerStyle ? viewerStyle.value : 'ballstick') {
      case 'sphere': return { sphere: {} };
      case 'line': return { line: {} };
      case 'stick': return { stick: {} };
      default: return { stick: { radius: 0.12 }, sphere: { scale: 0.25 } };
    }
  }

  const isDark = () => document.documentElement.classList.contains('dark');
  const viewerBackground = () => (isDark() ? '#0f172a' : '#f1f5f9');

  /**
   * Rebuild the model from the current coordinates.
   *
   * The view is refitted to the structure unless `keepView` asks for the
   * place and zoom it has. Either way it keeps its orientation, and shows
   * whatever rotation is waiting.
   */
  function renderViewer({ keepView = false } = {}) {
    if (!viewerCanvas || viewerFailed || !state.atoms.length) return;

    if (!window.$3Dmol) {
      viewerFailed = true;
      showViewerFallback('The 3D viewer library did not load, so the structure ' +
                         'cannot be drawn. Transformations and export still work.');
      return;
    }
    if (!webglAvailable()) {
      viewerFailed = true;
      showViewerFallback('This view needs WebGL, which the browser is not providing. ' +
                         'Enabling hardware acceleration usually restores it. ' +
                         'Transformations and export still work without it.');
      return;
    }

    try {
      if (!viewer) {
        viewer = window.$3Dmol.createViewer(viewerCanvas, {
          backgroundColor: viewerBackground()
        });
        if (viewer) viewer.setViewChangeCallback(onViewChange);
      }
      if (!viewer) throw new Error('viewer unavailable');

      const shown = state.atoms.length > VIEW_LIMIT
        ? state.atoms.slice(0, VIEW_LIMIT)
        : state.atoms;

      // 3Dmol reads PDB in Angstrom, so the source unit is converted here
      // rather than assumed.
      const pdb = formatStructure(shown, 'pdb', {
        sourceUnit: state.unit,
        box: currentBox(),
        boxVectors: state.boxVectors,
        title: state.title
      });

      const kept = keepView ? viewer.getView() : null;
      settle(() => {
        viewer.clear();
        viewer.addModel(pdb, 'pdb');
        viewer.setStyle({}, styleSpec());
        if (kept) viewer.setView(kept); else viewer.zoomTo();
      });
      if (!kept) centreViewOnPivot();
      showTurnInView();

      if (viewerNote) {
        viewerNote.textContent = state.atoms.length > VIEW_LIMIT
          ? `Showing the first ${VIEW_LIMIT.toLocaleString()} of ` +
            `${state.atoms.length.toLocaleString()} atoms; the export is complete`
          : '';
      }
    } catch (err) {
      console.error(err);
      viewerFailed = true;
      showViewerFallback('The 3D view could not be started. Transformations and ' +
                         'export still work.');
    }
  }

  /** The cell changed: redraw its outline, and the script that writes it. */
  function refreshBox() {
    paintOverlay();
    renderPython();
  }

  if (viewerStyle) viewerStyle.addEventListener('change', () => {
    if (!viewer || viewerFailed) return;
    viewer.setStyle({}, styleSpec());
    viewer.render();
  });

  if (btnViewerReset) btnViewerReset.addEventListener('click', () => {
    if (!viewer || viewerFailed) return;
    viewer.zoomTo();
    centreViewOnPivot();
    viewer.render();
  });

  // The nav's own handler toggles the class; this runs after it and repaints
  // the canvas, whose background and cell outline follow the theme.
  document.querySelectorAll('.themeToggle').forEach(btn => btn.addEventListener('click', () => {
    if (!viewer || viewerFailed) return;
    viewer.setBackgroundColor(viewerBackground());
    renderViewer();
  }));

  /* --- Resizable split between the view and the preview --------------------
   * The useful proportion depends on the structure and on what the user is
   * doing, so it is left adjustable rather than fixed. The preview keeps a
   * concrete height and the view takes whatever is left, which is what lets
   * the preview scroll internally instead of pushing the page taller.
   *
   * The height travels as a custom property rather than an inline height so
   * the stacked layout under 1024 px can ignore it and keep its own share of
   * the viewport.
   */
  const viewSplit = $('viewSplit');

  if (viewSplit && previewPanel) {
    const MIN_PREVIEW = 100;   // still shows a few rows
    const MIN_VIEW = 160;      // still recognisably a structure

    let dragging = false;

    const setPreviewHeight = (px) => {
      const shell = previewPanel.parentElement;
      const available = shell
        ? shell.clientHeight - viewSplit.offsetHeight
        : window.innerHeight;
      const max = Math.max(MIN_PREVIEW, available - MIN_VIEW);
      const height = Math.round(Math.min(Math.max(px, MIN_PREVIEW), max));
      previewPanel.style.setProperty('--cm-preview-h', `${height}px`);
      viewSplit.setAttribute('aria-valuenow', String(height));
    };

    const SPLIT_KEY = 'stemkit-coord-split';
    const DEFAULT_PREVIEW = 240;

    // Restore the previous choice. Storage may be unavailable, in which case
    // the split simply starts at its default each visit.
    try {
      const saved = Number(localStorage.getItem(SPLIT_KEY));
      if (Number.isFinite(saved) && saved > 0) {
        previewPanel.style.setProperty('--cm-preview-h', `${saved}px`);
      }
    } catch (e) { /* no persistence */ }

    const remember = () => {
      try {
        localStorage.setItem(SPLIT_KEY, String(Math.round(previewPanel.getBoundingClientRect().height)));
      } catch (e) { /* no persistence */ }
    };

    // The WebGL canvas is sized from its container, so it has to be told.
    let resizeTimer = null;
    const syncViewer = () => {
      if (!viewer || viewerFailed) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { viewer.resize(); viewer.render(); }, 60);
    };

    const stop = () => {
      if (!dragging) return;
      dragging = false;
      viewSplit.classList.remove('is-dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      remember();
      syncViewer();
    };

    // Pointer events cover mouse, pen and touch alike; capturing the pointer
    // keeps the drag alive when it leaves the handle, as it does at once.
    viewSplit.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true;
      viewSplit.classList.add('is-dragging');
      viewSplit.setPointerCapture(e.pointerId);
      // Suppressed during the drag so the pointer does not select the
      // surrounding text as it moves.
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'row-resize';
      e.preventDefault();
    });
    viewSplit.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      e.preventDefault();
      // Distance from the pointer to the bottom of the panel is the height
      // the preview should take.
      setPreviewHeight(previewPanel.getBoundingClientRect().bottom - e.clientY);
    });
    viewSplit.addEventListener('pointerup', stop);
    viewSplit.addEventListener('pointercancel', stop);

    // Double-click returns to the default rather than leaving the user to
    // drag back to a size they cannot see a number for.
    viewSplit.addEventListener('dblclick', () => {
      setPreviewHeight(DEFAULT_PREVIEW);
      remember();
      syncViewer();
    });

    // Keyboard equivalent, so the split is not pointer-only.
    viewSplit.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 48 : 16;
      const current = previewPanel.getBoundingClientRect().height;
      if (e.key === 'ArrowUp') { setPreviewHeight(current + step); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { setPreviewHeight(current - step); e.preventDefault(); }
      else return;
      remember();
      syncViewer();
    });

    window.addEventListener('resize', syncViewer);
  }

  /* --- Turning the molecule --------------------------------------------------
   * The three angle fields hold one rotation that is waiting, R. The view
   * shows it at once; the coordinates take it when Rotate is pressed.
   *
   * The scene holds the atoms where the file has them. How it sits on screen
   * is the product lab·R: `lab` is how the fixed frame (the box, the axes)
   * sits on screen, R how the molecule is turned within that frame. The frame
   * itself is drawn turned back by R about the pivot, so it keeps its place
   * while the molecule turns. Dragging changes the product, and the choice on
   * the toolbar says which factor takes the change: the frame (Turn view) or
   * the rotation (Turn molecule).
   */
  const turn = { lab: IDENTITY_ROTATION.slice(), pending: IDENTITY_ROTATION.slice(), mode: 'view', settling: false };

  const pivotMode = () => (rotPivot && ['mass', 'origin'].includes(rotPivot.value) ? rotPivot.value : 'geometric');

  // The pivot and the shape axis are asked for on every frame of a drag, so
  // each is worked out once per set of coordinates.
  let pivotCache = { key: null, point: null };
  function pivotPoint(mode = pivotMode()) {
    const key = `${state.revision}:${mode}`;
    if (pivotCache.key !== key) {
      const c = mode === 'origin' ? { x: 0, y: 0, z: 0 }
        : mode === 'mass' ? centreOfMass(state.atoms) : geometricCentre(state.atoms);
      pivotCache = { key, point: { x: c.x, y: c.y, z: c.z } };
    }
    return pivotCache.point;
  }

  let shapeCache = { revision: -1, shape: null };
  function currentShape() {
    if (shapeCache.revision !== state.revision) {
      shapeCache = { revision: state.revision, shape: state.atoms.length ? shapeAxis(state.atoms) : null };
    }
    return shapeCache.shape;
  }

  const fieldAngles = () => ({
    x: rotX ? Number(rotX.value) || 0 : 0,
    y: rotY ? Number(rotY.value) || 0 : 0,
    z: rotZ ? Number(rotZ.value) || 0 : 0
  });
  const turnWaiting = () => { const a = fieldAngles(); return Boolean(a.x || a.y || a.z); };
  const sameRotation = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

  function setAngleFields(angles, decimals) {
    const show = v => {
      const s = (Number(v) || 0).toFixed(decimals);
      return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
    };
    if (rotX) rotX.value = show(angles.x);
    if (rotY) rotY.value = show(angles.y);
    if (rotZ) rotZ.value = show(angles.z);
  }

  /** The fields changed: take the rotation from them and show it. */
  function turnChanged() {
    const a = fieldAngles();
    turn.pending = rotationMatrix(a.x, a.y, a.z);
    showTurnInView();
    updateTurnReadout();
  }

  /** Point the scene so the frame stays put and the molecule shows the turn. */
  function showTurnInView() {
    if (!viewer || viewerFailed) { paintOverlay(); return; }
    const q = quaternionFromMatrix(multiplyRotations(turn.lab, turn.pending));
    const v = viewer.getView();
    settle(() => {
      viewer.setView([v[0], v[1], v[2], v[3], q[0], q[1], q[2], q[3]]);
      viewer.render();
    });
    paintOverlay();
  }

  /**
   * Put the centre of the view on the pivot, so the scene turns on screen
   * about the point the coordinates will turn about: the picture of a waiting
   * rotation is then the picture after it is applied, and the frame does not
   * move. The origin is the exception: it may be far from the structure, so
   * the view stays on the structure and the frame is seen to swing instead.
   */
  function centreViewOnPivot() {
    if (!viewer || viewerFailed || !state.atoms.length) return;
    const mode = pivotMode();
    if (mode === 'origin') return;
    const c = pivotPoint(mode);
    const k = unitFactor(state.unit, 'A');
    const v = viewer.getView();
    settle(() => {
      viewer.setView([-c.x * k, -c.y * k, -c.z * k, v[3], v[4], v[5], v[6], v[7]]);
      viewer.render();
    });
    paintOverlay();
  }

  /** Run changes the page makes to the scene itself, which are not drags. */
  function settle(change) {
    turn.settling = true;
    try { change(); } finally { turn.settling = false; }
  }

  /**
   * Called by 3Dmol whenever the scene is redrawn. If the scene has been
   * turned by hand, the change goes to the frame or to the rotation.
   *
   * A dragged rotation is kept to a tenth of a degree, so that the angles on
   * show are the rotation that is applied, recorded and written to the
   * script, not a rounding of it.
   */
  function onViewChange(v) {
    if (!turn.settling && v && v.length >= 8 && state.atoms.length) {
      const seen = matrixFromQuaternion([v[4], v[5], v[6], v[7]]);
      if (!sameRotation(seen, multiplyRotations(turn.lab, turn.pending))) {
        if (turn.mode === 'molecule') {
          setAngleFields(eulerFromMatrix(multiplyRotations(transposeRotation(turn.lab), seen)), 1);
          const a = fieldAngles();
          turn.pending = rotationMatrix(a.x, a.y, a.z);
          updateTurnReadout();
        } else {
          turn.lab = multiplyRotations(seen, transposeRotation(turn.pending));
        }
      }
    }
    paintOverlay();
  }

  function setDragMode(mode) {
    turn.mode = mode === 'molecule' ? 'molecule' : 'view';
    if (dragView) dragView.setAttribute('aria-pressed', String(turn.mode === 'view'));
    if (dragMolecule) dragMolecule.setAttribute('aria-pressed', String(turn.mode === 'molecule'));
    if (viewerCanvas && viewerCanvas.parentElement) {
      viewerCanvas.parentElement.classList.toggle('is-turning', turn.mode === 'molecule');
    }
    paintOverlay();
  }
  if (dragView) dragView.addEventListener('click', () => setDragMode('view'));
  if (dragMolecule) dragMolecule.addEventListener('click', () => setDragMode('molecule'));

  function resetTurn() {
    setAngleFields({ x: 0, y: 0, z: 0 }, 0);
    turn.pending = IDENTITY_ROTATION.slice();
  }

  // Arrow keys step by 5 degrees, by 1 with Shift: coarse enough to get
  // somewhere, fine enough to finish. Typing takes any value.
  [rotX, rotY, rotZ].forEach(input => {
    if (!input) return;
    input.addEventListener('input', turnChanged);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const step = (e.shiftKey ? 1 : 5) * (e.key === 'ArrowUp' ? 1 : -1);
      const next = Math.max(-360, Math.min(360, (Number(input.value) || 0) + step));
      input.value = String(Number(next.toFixed(2)));
      turnChanged();
    });
  });
  if (rotPivot) rotPivot.addEventListener('change', () => centreViewOnPivot());
  if (btnResetRot) btnResetRot.addEventListener('click', () => { resetTurn(); turnChanged(); });

  /* The shape's own axis, laid along a coordinate axis: the smallest turn
   * that does it. A line has two ends, so the nearer end is taken. Kept to a
   * hundredth of a degree, which leaves the axis within that of the target. */
  const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  document.querySelectorAll('[data-align]').forEach(btn => btn.addEventListener('click', () => {
    const shape = currentShape();
    const e = AXES[btn.dataset.align];
    if (!shape || !e) return;
    const a = shape.axis;
    const towards = a[0] * e[0] + a[1] * e[1] + a[2] * e[2] >= 0 ? e : e.map(c => -c);
    setAngleFields(eulerFromMatrix(rotationBetween(a, towards)), 2);
    turnChanged();
  }));

  const SHAPE_LABEL = { long: 'Long axis', normal: 'Plane normal' };
  const minus = s => String(s).replace(/^-/, '−');
  const deg = (v, d = 1) => `${minus((Number(v) || 0).toFixed(d).replace(/^-0\.?0*$/, m => m.slice(1)))}°`;

  /** Everything that describes the waiting rotation, in the panel and over the view. */
  function updateTurnReadout() {
    const waiting = turnWaiting();
    const r = turn.pending;

    if (rotMatrix) {
      rotMatrix.replaceChildren(...r.map(v => {
        const cell = document.createElement('span');
        const s = v.toFixed(4);
        cell.textContent = minus(/^-0\.0+$/.test(s) ? s.slice(1) : s);
        return cell;
      }));
    }
    if (rotTurn) {
      const one = axisAngleFromMatrix(r);
      rotTurn.textContent = waiting && one.angle > 1e-9
        ? `One turn of ${deg(one.angle)} about the axis (${one.axis.map(c => minus(c.toFixed(3))).join(', ')}).`
        : 'No rotation waiting: R is the identity.';
    }
    if (btnResetRot) btnResetRot.disabled = !waiting || !state.atoms.length;

    const shape = currentShape();
    const label = shape ? SHAPE_LABEL[shape.kind] : '';
    if (rotAlign) rotAlign.hidden = !shape;
    if (rotAlignLabel && shape) rotAlignLabel.textContent = `Lay the ${label.toLowerCase()} along`;
    if (rotTilt) rotTilt.hidden = !shape;
    let after = null;
    if (shape) {
      const now = axisTilt(shape.axis);
      after = axisTilt(rotateVector(r, shape.axis));
      if (rotTiltLabel) rotTiltLabel.textContent = `${label}, angle to`;
      const put = (el, v) => { if (el) el.textContent = deg(v); };
      put(tiltNowX, now.x); put(tiltNowY, now.y); put(tiltNowZ, now.z);
      put(tiltAfterX, after.x); put(tiltAfterY, after.y); put(tiltAfterZ, after.z);
      if (tiltAfterRow) tiltAfterRow.hidden = !waiting;
    }

    if (viewerHud) {
      const a = fieldAngles();
      if (hudPending) hudPending.hidden = !waiting;
      if (hudPendingText) hudPendingText.textContent = `x ${deg(a.x)}  y ${deg(a.y)}  z ${deg(a.z)}`;
      if (hudTilt) hudTilt.hidden = !shape;
      if (shape && hudTiltLabel) hudTiltLabel.textContent = `${label} to`;
      if (shape && hudTiltText) hudTiltText.textContent = `x ${deg(after.x)}  y ${deg(after.y)}  z ${deg(after.z)}`;
      viewerHud.hidden = !state.atoms.length || (!waiting && !shape);
    }
  }

  copyButton(btnCopyMatrix, () => {
    const r = turn.pending;
    return [0, 1, 2].map(i => [0, 1, 2].map(j => r[i * 3 + j].toFixed(8)).join('  ')).join('\n');
  }, 'Could not copy the matrix. Select the numbers and copy them by hand.');

  /** A rotation shown but not applied is not in the file: say so once, at the point of taking the file. */
  function warnIfTurnWaiting() {
    if (!turnWaiting()) return;
    showToast('The rotation shown in the view has not been applied, so it is not in this file. Press Rotate to apply it.', 'warn');
  }

  /* --- The frame, drawn over the view -----------------------------------------
   * The cell, the coordinate axes and the shape's own axis are drawn in screen
   * space on a 2D canvas over the WebGL one and re-projected on every redraw,
   * as the Structure Inspector draws its box: lines of a constant width with a
   * halo in the background colour, so they read over atoms and on either
   * theme, and heavier towards the viewer, which tells front from back.
   *
   * The cell is drawn from its vectors rather than as a cuboid, because it may
   * be triclinic. GROMACS places its origin at (0, 0, 0), so that is where it
   * is drawn: a structure moved away from the origin sits outside it, which
   * is worth seeing rather than hiding.
   */
  const boxShown = () => !showBox || showBox.getAttribute('aria-pressed') !== 'false';

  /** The eight corners of the cell in ångström, or null without a usable one. */
  function boxCorners() {
    const box = currentBox();
    if (!box || box.length < 3 || !box.every(Number.isFinite)) return null;
    const S = 10;   // the cell is kept in nm, the scene is in ångström
    const v = state.boxVectors && state.boxVectors.length >= 9
      ? state.boxVectors
      : [box[0], box[1], box[2], 0, 0, 0, 0, 0, 0];
    // GROMACS order: v1x v2y v3z v1y v1z v2x v2z v3x v3y
    const a = [v[0] * S, v[3] * S, v[4] * S];
    const b = [v[5] * S, v[1] * S, v[6] * S];
    const c = [v[7] * S, v[8] * S, v[2] * S];
    const at = (i, j, k) => [i * a[0] + j * b[0] + k * c[0], i * a[1] + j * b[1] + k * c[1], i * a[2] + j * b[2] + k * c[2]];
    return [at(0, 0, 0), at(1, 0, 0), at(0, 1, 0), at(0, 0, 1), at(1, 1, 0), at(1, 0, 1), at(0, 1, 1), at(1, 1, 1)];
  }
  const BOX_EDGES = [[0, 1], [0, 2], [0, 3], [1, 4], [1, 5], [2, 4], [2, 6], [3, 5], [3, 6], [4, 7], [5, 7], [6, 7]];

  function paintOverlay() {
    const cv = viewerOverlay;
    if (!cv || !viewerCanvas) return;
    const w = viewerCanvas.clientWidth;
    const h = viewerCanvas.clientHeight;
    const pr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * pr) || cv.height !== Math.round(h * pr)) {
      cv.width = Math.round(w * pr);
      cv.height = Math.round(h * pr);
    }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!viewer || viewerFailed || !state.atoms.length) return;
    const gl = viewerCanvas.querySelector('canvas');
    if (!gl) return;

    const rect = gl.getBoundingClientRect();
    const ox = rect.left + window.pageXOffset;
    const oy = rect.top + window.pageYOffset;
    const project = points => viewer.modelToScreen(points.map(p => ({ x: p[0], y: p[1], z: p[2] })))
      .map(s => ({ x: (s.x - ox) * pr, y: (s.y - oy) * pr }));
    // Depth towards the camera, from the scene's world matrix.
    let m = null;
    try { m = viewer.modelGroup.matrixWorld.elements; } catch (e) { m = null; }
    const depth = p => (m ? m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] : 0);

    // The frame as the scene has to hold it: turned back by the waiting
    // rotation about the pivot.
    const toA = unitFactor(state.unit, 'A');
    const c = pivotPoint();
    const pivot = [c.x * toA, c.y * toA, c.z * toA];
    const back = transposeRotation(turn.pending);
    const frame = p => {
      const d = rotateVector(back, [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]]);
      return [pivot[0] + d[0], pivot[1] + d[1], pivot[2] + d[2]];
    };

    const dark = isDark();
    const halo = dark ? 'rgba(2, 6, 23, 0.8)' : 'rgba(255, 255, 255, 0.85)';
    const stroke = (x1, y1, x2, y2, colour, width, alpha = 1) => {
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = halo;
      ctx.lineWidth = width + 2.5 * pr;
      ctx.stroke();
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    const label = (text, x, y, colour, size = 11) => {
      ctx.font = `700 ${size * pr}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = halo;
      ctx.lineWidth = 3 * pr;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = colour;
      ctx.fillText(text, x, y);
    };
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // The cell: far edges first, so near ones are drawn over them.
    const corners = boxShown() ? boxCorners() : null;
    if (corners) {
      const P = corners.map(frame);
      const S = project(P);
      if (S.every(s => Number.isFinite(s.x) && Number.isFinite(s.y))) {
        const D = P.map(depth);
        const dMin = Math.min(...D);
        const dMax = Math.max(...D);
        const near = (i, j) => (dMax - dMin > 1e-6 ? ((D[i] + D[j]) / 2 - dMin) / (dMax - dMin) : 1);
        const colour = dark ? '#92b8dd' : '#1f5c96';
        BOX_EDGES.map(([i, j]) => ({ i, j, t: near(i, j) })).sort((p, q) => p.t - q.t).forEach(({ i, j, t }) => {
          stroke(S[i].x, S[i].y, S[j].x, S[j].y, colour, 2.5 * pr * (0.6 + 0.4 * t), 0.55 + 0.45 * t);
        });
      }
    }

    // The shape's own axis runs through the molecule and turns with it.
    const shape = currentShape();
    if (shape) {
      const g = [shape.centre.x * toA, shape.centre.y * toA, shape.centre.z * toA];
      const half = shape.halfLength * toA * 1.15;
      const ends = [-1, 1].map(s => [g[0] + s * half * shape.axis[0], g[1] + s * half * shape.axis[1], g[2] + s * half * shape.axis[2]]);
      const E = project(ends);
      if (E.every(s => Number.isFinite(s.x) && Number.isFinite(s.y))) {
        const colour = dark ? '#fbbf24' : '#b45309';
        ctx.setLineDash([6 * pr, 5 * pr]);
        stroke(E[0].x, E[0].y, E[1].x, E[1].y, colour, 1.75 * pr);
        ctx.setLineDash([]);
        const top = E[0].y < E[1].y ? E[0] : E[1];
        label(SHAPE_LABEL[shape.kind].toLowerCase(), top.x, top.y - 9 * pr, colour);
      }
    }

    // Where the molecule turns about, while it is being turned.
    if (turn.mode === 'molecule' || turnWaiting()) {
      const [s] = project([pivot]);
      if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
        const colour = dark ? '#e2e8f0' : '#0f2236';
        const r = 5 * pr;
        stroke(s.x - r, s.y, s.x + r, s.y, colour, 1.5 * pr);
        stroke(s.x, s.y - r, s.x, s.y + r, colour, 1.5 * pr);
      }
    }

    // The coordinate axes, in the corner: which way x, y and z point on screen.
    const L = 5;
    const tips = project([pivot, ...[AXES.x, AXES.y, AXES.z].map(e => frame([pivot[0] + L * e[0], pivot[1] + L * e[1], pivot[2] + L * e[2]]))]);
    if (tips.every(s => Number.isFinite(s.x) && Number.isFinite(s.y))) {
      const arms = [1, 2, 3].map(k => ({ x: tips[k].x - tips[0].x, y: tips[k].y - tips[0].y }));
      // Three orthogonal arms of one length, seen from anywhere, have squared
      // screen lengths that add up to twice the square of that length.
      const unit = Math.sqrt(arms.reduce((sum, a) => sum + a.x * a.x + a.y * a.y, 0) / 2) || 1;
      const size = 40 * pr;
      const cx = cv.width - 66 * pr;
      const cy = cv.height - 66 * pr;
      const colours = dark ? ['#f87171', '#4ade80', '#60a5fa'] : ['#dc2626', '#15803d', '#1d4ed8'];
      const d0 = depth(pivot);
      ['x', 'y', 'z'].map((name, k) => {
        const e = AXES[name];
        const tip = frame([pivot[0] + L * e[0], pivot[1] + L * e[1], pivot[2] + L * e[2]]);
        return { name, colour: colours[k], dx: arms[k].x / unit * size, dy: arms[k].y / unit * size, toward: depth(tip) - d0 };
      }).sort((p, q) => p.toward - q.toward).forEach(a => {
        const alpha = a.toward < 0 ? 0.6 : 1;
        stroke(cx, cy, cx + a.dx, cy + a.dy, a.colour, 2.75 * pr, alpha);
        const len = Math.hypot(a.dx, a.dy);
        // An arm seen end-on has no direction on screen: its name sits beside the hub.
        const ux = len > 4 * pr ? a.dx / len : 0.7;
        const uy = len > 4 * pr ? a.dy / len : 0.7;
        ctx.globalAlpha = alpha;
        label(a.name, cx + a.dx + ux * 11 * pr, cy + a.dy + uy * 11 * pr, a.colour, 13);
        ctx.globalAlpha = 1;
      });
    }
    ctx.restore();
  }

  if (showBox) showBox.addEventListener('click', () => {
    showBox.setAttribute('aria-pressed', String(!boxShown()));
    paintOverlay();
  });

  /* --- What was done ----------------------------------------------------------
   * Every step that changed the coordinates is kept, in order, with the point
   * it turned about or moved. From that list come the equations and the
   * Python script under the workspace, and the one rotation the editconf
   * command needs.
   */
  let pyPanel = null;
  let pyVariant = 'mdanalysis';
  let mathsLatex = '';

  /** The cell as the script writes it: lengths in nm, with the angles of a triclinic one. */
  function scriptBox() {
    const format = exportFormat ? exportFormat.value : 'pdb';
    if (format === 'xyz') return null;
    if (state.boxVectors && isTriclinic(state.boxVectors)) {
      const ang = anglesFromBoxVectors(state.boxVectors);
      return { lengths: [ang.a, ang.b, ang.c], angles: [ang.alpha, ang.beta, ang.gamma] };
    }
    const box = currentBox();
    return box && box.length >= 3 && box.every(v => Number.isFinite(v) && v > 0) ? { lengths: box.slice(0, 3) } : null;
  }

  function renderPython() {
    if (!recordPython) return;
    if (!pyPanel) {
      pyPanel = createPythonPanel(recordPython, {
        title: 'Python script',
        filename: 'steps.py',
        variants: [{ id: 'mdanalysis', label: 'Whole script' }, { id: 'numpy', label: 'NumPy function' }],
        onVariantChange: (id) => { pyVariant = id; renderPython(); },
        empty: '# Load a structure and the script that repeats your steps appears here.'
      });
    }
    if (!state.atoms.length) { pyPanel.setCode(''); return; }
    const format = exportFormat ? exportFormat.value : 'pdb';
    const input = state.fileName || `input.${state.format || 'pdb'}`;
    const output = `${exportBaseName()}.${format}`;
    pyPanel.setFilename(`${exportBaseName()}_steps.py`);
    pyPanel.setCode(transformScript(state.steps, {
      variant: pyVariant,
      unit: state.unit,
      input,
      output,
      velocities: state.atoms.some(a => a.vx !== null && a.vx !== undefined),
      box: scriptBox()
    }));
    const esc = t => String(t).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    pyPanel.setNote(pyVariant === 'numpy'
      ? `Needs numpy only. Call <code>transform(x)</code> with an (N, 3) array in ${state.unit === 'nm' ? 'nm' : 'Å'}, the unit of <code>${esc(input)}</code>, read however you like.`
      : `Runs with Python 3, numpy and MDAnalysis: <code>python ${esc(exportBaseName())}_steps.py</code>. It reads <code>${esc(input)}</code> from the same folder and writes <code>${esc(output)}</code>.`);
  }

  function renderMaths() {
    if (!mathsBody) return;
    const { blocks, latex } = transformLatex(state.steps, { unit: state.unit });
    mathsLatex = latex;
    if (btnCopyLatex) btnCopyLatex.disabled = !latex;
    if (!blocks.length) {
      const hint = document.createElement('p');
      hint.className = 'stk-hint';
      hint.textContent = 'The matrix or vector of each step, and the one transform they add up to, appear here.';
      mathsBody.replaceChildren(hint);
      return;
    }
    mathsBody.replaceChildren(...blocks.map(block => {
      const part = document.createElement('section');
      part.className = 'cm-eq';
      const heading = document.createElement('h3');
      heading.textContent = block.heading;
      const eq = document.createElement('div');
      eq.className = 'cm-eq-tex stk-scroll';
      // Without KaTeX the TeX source is shown, which is still readable.
      let typeset = false;
      if (window.katex) {
        try {
          window.katex.render(block.tex, eq, { displayMode: true, throwOnError: false, output: 'htmlAndMathml' });
          typeset = true;
        } catch (e) { typeset = false; }
      }
      if (!typeset) { eq.textContent = block.tex; eq.classList.add('cm-eq-src'); }
      eq.setAttribute('role', 'group');
      eq.setAttribute('aria-label', `Equations: ${block.heading}`);
      part.append(heading, eq);
      if (block.note) {
        const note = document.createElement('p');
        note.className = 'stk-hint';
        note.textContent = block.note;
        part.append(note);
      }
      return part;
    }));
    // An equation wider than the panel scrolls sideways, and so has to be
    // reachable from the keyboard.
    mathsBody.querySelectorAll('.cm-eq-tex').forEach(eq => {
      if (eq.scrollWidth > eq.clientWidth + 1) eq.tabIndex = 0;
    });
  }

  function renderRecord() {
    if (recordSection) recordSection.hidden = !state.atoms.length;
    const n = state.steps.length;
    if (recordCount) recordCount.textContent = n === 1 ? '1 step' : `${n} steps`;
    if (recordEmpty) recordEmpty.hidden = n > 0;
    if (recordList) {
      recordList.hidden = n === 0;
      recordList.replaceChildren(...state.steps.map(step => {
        const li = document.createElement('li');
        li.textContent = `${describeStep(step, state.unit)}.`;
        return li;
      }));
    }
    renderMaths();
    renderPython();
  }

  copyButton(btnCopyLatex, () => mathsLatex || null, 'Could not copy the LaTeX. Select the equations and copy them by hand.');
  if (btnShowMaths) btnShowMaths.addEventListener('click', () => {
    const el = $('cmMaths');
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  if (btnShowPython) btnShowPython.addEventListener('click', () => {
    if (recordPython) recordPython.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  /* --- Equivalent gmx editconf command --------------------------------------
   * The point of this panel is not to replace `gmx editconf` but to hand back
   * a command that reproduces what was just set up visually, so the same
   * result can go into a script and be recorded in a workflow.
   *
   * The order below is taken from editconf.cpp rather than guessed: scale,
   * then -translate, then -rotate, then the box, and -center last of all.
   *
   * Differences worth stating rather than papering over, all shown to the
   * user:
   *
   *  - editconf works in nanometres throughout, so a source measured in
   *    angstrom has its translation converted here.
   *  - this tool rotates about the geometric centre; editconf's `-rotate`
   *    turns the coordinates about the origin. The two agree only when the
   *    structure is centred on the origin first, which is why a rotation
   *    without a preceding centring is flagged.
   */

  const NM_PER = { A: 0.1, nm: 1 };

  /** Convert a length from the source unit into nanometres, as editconf expects. */
  function toNm(value) {
    return value * (NM_PER[state.unit] ?? 1);
  }

  function editconfCommand() {
    if (!state.atoms.length) return null;

    const a = state.applied;
    const inFile = state.fileName || `input.${state.format || 'gro'}`;
    const outFmt = exportFormat ? exportFormat.value : 'gro';
    const outName = exportBaseName();

    const parts = [`gmx editconf -f ${inFile} -o ${outName}.${outFmt}`];
    const notes = [];

    // editconf reads gro/g96/pdb/brk/ent/esp/tpr and writes all but tpr.
    // .xyz is neither, so a command naming one would simply fail | better to
    // say so than to hand over something that does not run.
    const READS = ['gro', 'g96', 'pdb', 'brk', 'ent', 'esp', 'tpr'];
    const WRITES = ['gro', 'g96', 'pdb', 'brk', 'ent', 'esp'];
    const inExt = (inFile.split('.').pop() || '').toLowerCase();

    if (!READS.includes(inExt)) {
      notes.push(`editconf cannot read .${inExt}. Convert it first, for example ` +
                 `with \`obabel ${inFile} -O input.pdb\`, and point -f at that.`);
    }
    if (!WRITES.includes(outFmt)) {
      notes.push(`editconf cannot write .${outFmt} either, it emits ` +
                 `gro, g96 or pdb. Choose one of those above, or keep using ` +
                 `the download button here.`);
    }

    // Centring. editconf's -center moves the geometric centre; there is no
    // centre-of-mass equivalent, so that case is called out.
    if (a.centre) {
      parts.push('-center 0 0 0');
      if (a.centre === 'mass') {
        notes.push('-center uses the geometric centre; editconf has no ' +
                   'centre-of-mass option, so this will differ slightly for a ' +
                   'structure whose mass is unevenly distributed.');
      }
    }

    if (a.tx || a.ty || a.tz) {
      parts.push(`-translate ${toNm(a.tx).toFixed(4)} ${toNm(a.ty).toFixed(4)} ${toNm(a.tz).toFixed(4)}`);
      if (state.unit !== 'nm') {
        notes.push(`Translation converted from ${state.unit} to nm, which is what editconf expects.`);
      }
    }

    // Rotations do not add angle by angle, so the angles written are those
    // of the one rotation the steps add up to, in editconf's own order (a
    // turn about x, then y, then z).
    const turns = state.steps.filter(step => step.type === 'rotate');
    const net = eulerFromMatrix(netTransform(turns).matrix);
    const angle = v => String(Number(v.toFixed(4)));
    if (turns.length && [net.x, net.y, net.z].some(v => Math.abs(v) > 5e-5)) {
      parts.push(`-rotate ${angle(net.x)} ${angle(net.y)} ${angle(net.z)}`);
      if (turns.length > 1) {
        notes.push(`${turns.length} rotations were applied; -rotate gives the one rotation they add up to.`);
      }
      // Only a rotation about a centre, not about the origin, displaces the
      // structure relative to editconf.
      const offOrigin = (a.pivots || ['geometric']).filter(p => p !== 'origin');
      if (!a.centre && offOrigin.length) {
        const about = offOrigin.every(p => p === 'mass') ? 'the centre of mass'
          : offOrigin.every(p => p === 'geometric') ? 'the geometric centre'
            : 'the geometric centre and the centre of mass';
        notes.push(`This tool rotated about ${about}; editconf rotates ` +
                   'about the origin, so the structure will also be displaced. ' +
                   'editconf applies -center after -rotate, so adding -center 0 0 0 ' +
                   'removes that displacement and makes the two agree.');
      }
      if (state.box) {
        notes.push('editconf rotates coordinates and velocities but not the cell, ' +
                   'so the same caveat applies: rebuild or re-solvate the box before ' +
                   'running a periodic system from these coordinates.');
      }
    }

    // Box. A cubic, dodecahedral or octahedral cell takes a single length.
    const box = currentBox();
    if (box && box.length >= 3 && box.every(Number.isFinite) && box.some(v => v > 0)) {
      if (state.boxVectors && isTriclinic(state.boxVectors)) {
        const ang = anglesFromBoxVectors(state.boxVectors);
        parts.push(`-bt triclinic -box ${ang.a.toFixed(4)} ${ang.b.toFixed(4)} ${ang.c.toFixed(4)}`);
        parts.push(`-angles ${ang.alpha.toFixed(2)} ${ang.beta.toFixed(2)} ${ang.gamma.toFixed(2)}`);
        notes.push('-angles is given as (bc, ac, ab), the same order editconf uses.');
      } else {
        const equal = Math.abs(box[0] - box[1]) < 1e-4 && Math.abs(box[1] - box[2]) < 1e-4;
        parts.push(equal
          ? `-bt cubic -box ${box[0].toFixed(4)}`
          : `-bt triclinic -box ${box[0].toFixed(4)} ${box[1].toFixed(4)} ${box[2].toFixed(4)}`);
      }

      // editconf.cpp:786, giving -box or -d turns centring on unless -c was
      // named explicitly. Setting a box here does not move anything, so -noc
      // is needed or the command would centre a structure this tool left alone.
      if (!a.centre) {
        parts.push('-noc');
        notes.push('-noc is included because -box would otherwise centre the ' +
                   'system in the box, which was not done here.');
      }
    }

    // editconf translates before it rotates, so that sequence replays exactly.
    // The reverse does not: a rotation applied first here would be applied
    // second there, giving different coordinates.
    const rotIdx = a.order.lastIndexOf('rotate');
    const transIdx = a.order.lastIndexOf('translate');
    if (rotIdx > -1 && transIdx > -1 && rotIdx < transIdx) {
      notes.push('A rotation was applied before this translation. editconf ' +
                 'always translates first and rotates second, so this sequence ' +
                 'cannot be replayed in one command, run it as two, rotating ' +
                 'in the first and translating in the second.');
    }

    return { command: parts.join(' \\\n  '), notes };
  }

  function renderEditconf() {
    if (!editconfOut) return;
    const result = editconfCommand();

    if (!result) {
      editconfOut.textContent = 'Load a structure to see the equivalent command.';
      if (editconfNotes) {
        editconfNotes.hidden = true;
        editconfNotesList.replaceChildren();
      }
      return;
    }

    editconfOut.textContent = result.command;
    if (editconfNotes) {
      editconfNotesList.replaceChildren(...result.notes.map(n => {
        const li = document.createElement('li');
        li.textContent = n;
        return li;
      }));
      editconfNotes.hidden = result.notes.length === 0;
    }
  }

  copyButton(btnCopyEditconf, () => {
    const result = editconfCommand();
    return result ? result.command : null;
  }, 'Could not copy the command. Select the text and copy it by hand.');

  if (fileNameInput) fileNameInput.addEventListener('input', () => {
    updateExportInfo();
    renderEditconf();
    renderPython();
  });

  if (btnShowAll) btnShowAll.addEventListener('click', () => {
    state.showAllRows = !state.showAllRows;
    renderOutput();
  });

  /* --- Undo -----------------------------------------------------------------
   * Each transformation pushes a snapshot of the coordinates before it runs,
   * so undo restores exactly what was there rather than trying to invert the
   * operation. Inverting would be cheaper in memory, but a rotation's inverse
   * is the transpose applied in the opposite order, and accumulated rounding
   * over repeated undo/redo would slowly move atoms, a snapshot cannot drift.
   *
   * Coordinates are stored in typed arrays rather than as cloned atom objects:
   * only the numbers change, and a Float64Array of a 30,000-atom system is
   * about 0.7 MB where an array of objects is many times that.
   *
   * The stack is bounded by total bytes rather than by a step count, so a
   * small structure keeps a long history and a very large one keeps a short
   * one instead of exhausting memory.
   */
  const UNDO_BYTES = 64 * 1024 * 1024;
  const UNDO_STEPS = 25;
  const undoStack = [];
  const redoStack = [];

  function snapshotBytes(s) {
    return s.coords.byteLength + (s.vels ? s.vels.byteLength : 0);
  }

  /** Capture the coordinates and derived state as they stand right now. */
  function snapshot(label) {
    const n = state.atoms.length;
    const coords = new Float64Array(n * 3);
    const hasVel = state.atoms.some(a => a.vx !== null && a.vx !== undefined);
    const vels = hasVel ? new Float64Array(n * 3) : null;

    for (let i = 0; i < n; i++) {
      const a = state.atoms[i];
      coords[i * 3] = a.x; coords[i * 3 + 1] = a.y; coords[i * 3 + 2] = a.z;
      if (vels) {
        vels[i * 3] = a.vx || 0; vels[i * 3 + 1] = a.vy || 0; vels[i * 3 + 2] = a.vz || 0;
      }
    }

    return {
      label,
      coords,
      vels,
      // The editconf command is derived from what has been applied, so the
      // record of that has to travel with the coordinates or the command
      // would describe a state that no longer exists.
      applied: JSON.parse(JSON.stringify(state.applied)),
      steps: JSON.parse(JSON.stringify(state.steps)),
      box: state.box ? state.box.slice() : null,
      boxVectors: state.boxVectors ? state.boxVectors.slice() : null,
      boxEdited: state.boxEdited
    };
  }

  function pushUndo(label) {
    if (!state.atoms.length) return;
    undoStack.push(snapshot(label));

    // A fresh action makes any forward history unreachable, which is what
    // every editor does, keeping it would let redo jump to a state that no
    // longer follows from the current one.
    redoStack.length = 0;

    while (undoStack.length > UNDO_STEPS) undoStack.shift();
    let bytes = undoStack.reduce((sum, s) => sum + snapshotBytes(s), 0);
    while (undoStack.length > 1 && bytes > UNDO_BYTES) {
      bytes -= snapshotBytes(undoStack.shift());
    }

    updateUndoButton();
  }

  function applySnapshot(snap) {
    for (let i = 0; i < state.atoms.length; i++) {
      const a = state.atoms[i];
      a.x = snap.coords[i * 3]; a.y = snap.coords[i * 3 + 1]; a.z = snap.coords[i * 3 + 2];
      if (snap.vels) {
        a.vx = snap.vels[i * 3]; a.vy = snap.vels[i * 3 + 1]; a.vz = snap.vels[i * 3 + 2];
      }
    }

    state.applied = snap.applied;
    state.steps = snap.steps || [];
    state.box = snap.box;
    state.boxVectors = snap.boxVectors;
    state.boxEdited = snap.boxEdited;
    state.revision++;

    updateSystemStats();
    renderEditconf();
    if (!state.boxEdited) seedBoxInputs();
    renderOutput();
    renderViewer();
    updateTurnReadout();
    renderRecord();
    updateUndoButton();
  }

  function undo() {
    const snap = undoStack.pop();
    if (!snap) return;
    redoStack.push(snapshot(snap.label));
    applySnapshot(snap);
    showToast(`Undid: ${snap.label}`, 'success');
  }

  function redo() {
    const snap = redoStack.pop();
    if (!snap) return;
    undoStack.push(snapshot(snap.label));
    applySnapshot(snap);
    showToast(`Redid: ${snap.label}`, 'success');
  }

  function setButton(btn, stack, verb) {
    if (!btn) return;
    const empty = stack.length === 0;
    btn.disabled = empty;
    btn.title = empty ? `Nothing to ${verb}` : `${verb[0].toUpperCase()}${verb.slice(1)}: ${stack[stack.length - 1].label}`;
  }

  function updateUndoButton() {
    setButton(btnUndo, undoStack, 'undo');
    setButton(btnRedo, redoStack, 'redo');
  }

  if (btnUndo) btnUndo.addEventListener('click', undo);
  if (btnRedo) btnRedo.addEventListener('click', redo);

  // Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes. Ignored while a
  // field has focus so the browser's own undo still works inside a text box.
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;

    const key = e.key.toLowerCase();
    if (key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    } else if (key === 'y') {
      e.preventDefault();
      redo();
    }
  });

  /* --- Closing the file ------------------------------------------------------
   * Returns to the empty state with nothing kept: the coordinates, the history
   * and the drawn model all go, so the next file starts clean. Focus moves to
   * the file button, which is where a keyboard user would carry on.
   */
  function closeWorkspace() {
    state.atoms = [];
    originalAtoms = [];
    state.box = null;
    state.boxVectors = null;
    state.boxEdited = false;
    state.fileName = null;
    state.format = null;
    state.title = '';
    state.unknownElements = [];
    state.showAllRows = false;
    state.revision++;
    resetApplied();
    undoStack.length = 0;
    redoStack.length = 0;
    updateUndoButton();
    previewCache = { signature: null, text: '' };
    previewToken++;
    setBusy('format', null);
    resetTurn();
    if (viewer && !viewerFailed) {
      viewer.clear();
      viewer.render();
    }
    paintOverlay();
    updateTurnReadout();
    renderRecord();
    if (outputArea) outputArea.textContent = '';
    setStructureLoaded(false);
    if (workspace) workspace.hidden = true;
    if (uploadZone) uploadZone.hidden = false;
    if (fileInput) fileInput.value = '';
    if (chooseFileBtn) chooseFileBtn.focus();
  }

  if (btnCloseWorkspace) btnCloseWorkspace.addEventListener('click', closeWorkspace);

  /* --- How the mass was calculated -----------------------------------------
   * A single number is easy to trust and hard to check. The working is shown
   * per element (count, weight used, contribution) along with anything that
   * was excluded and why, and can be downloaded so it can go into a methods
   * section or be checked against a topology.
   */
  function renderMassDetail() {
    if (!massTable) return;
    const b = massBreakdown(state.atoms);

    if (!b.atoms) {
      massTable.innerHTML = '';
      if (massAssumptions) massAssumptions.textContent = '';
      return;
    }

    const rows = b.rows.map(r => `
      <tr>
        <td>${r.symbol}</td>
        <td>${r.count.toLocaleString()}</td>
        <td>${r.weight}</td>
        <td>${r.subtotal.toFixed(3)}</td>
      </tr>`).join('');

    massTable.innerHTML = `
      <table class="cm-mass">
        <thead>
          <tr>
            <th>Element</th>
            <th>Atoms</th>
            <th>Weight (u)</th>
            <th>Subtotal (Da)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td>${b.rows.reduce((s, r) => s + r.count, 0).toLocaleString()}</td>
            <td></td>
            <td>${b.total.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>`;

    // Anything excluded from the sum is stated rather than left to be inferred
    // from a total that does not add up to the atom count.
    const notes = [];
    if (b.virtualSites) {
      notes.push(`${b.virtualSites.toLocaleString()} massless interaction site(s) ` +
                 `excluded, TIP4P/TIP5P charge sites and dummy masses carry no mass.`);
    }
    if (b.unidentified.length) {
      const list = b.unidentified.map(u => `${u.symbol} x${u.count}`).join(', ');
      notes.push(`${b.unidentified.reduce((s, u) => s + u.count, 0)} atom(s) of ` +
                 `unidentified element contributed nothing: ${list}.`);
    }
    if (massAssumptions) massAssumptions.textContent = notes.join(' ');
  }

  function massWorkingCsv() {
    const b = massBreakdown(state.atoms);
    const lines = [
      '# Molecular weight working',
      `# source,${state.fileName || 'unknown'}`,
      `# atoms in file,${b.atoms}`,
      '# method,sum of standard atomic weights over all atoms present',
      '# weights,CIAAW standard atomic weights (natural isotope averages)',
      '# excluded,massless interaction sites and atoms of unidentified element',
      '',
      'element,atoms,weight_u,subtotal_Da'
    ];
    for (const r of b.rows) lines.push(`${r.symbol},${r.count},${r.weight},${r.subtotal.toFixed(6)}`);
    lines.push(`TOTAL,${b.rows.reduce((s, r) => s + r.count, 0)},,${b.total.toFixed(6)}`);
    if (b.virtualSites) lines.push(`# massless sites excluded,${b.virtualSites}`);
    for (const u of b.unidentified) lines.push(`# unidentified excluded,${u.symbol},${u.count}`);
    return lines.join('\n');
  }

  if (btnMassDownload) btnMassDownload.addEventListener('click', () => {
    if (!state.atoms.length) return;
    const blob = new Blob([massWorkingCsv()], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(state.fileName || 'structure').replace(/\.[^.]+$/, '')}_mass_working.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Downloaded the mass working.', 'success');
  });

  // The summary is a disclosure, so the detail is only built when opened.
  if (btnMassDetail && massDetail) btnMassDetail.addEventListener('click', () => {
    massDetail.open = true;
    massDetail.scrollIntoView({ block: 'nearest' });
  });
  if (massDetail) massDetail.addEventListener('toggle', () => {
    if (massDetail.open) renderMassDetail();
  });

});
