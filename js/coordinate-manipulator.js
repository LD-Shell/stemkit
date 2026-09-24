/**
 * Coordinate Manipulator | UI layer.
 *
 * Structure parsing, geometry, rotations, unit handling, box calculation, and
 * output formatting live in @stemkit/core; this file handles DOM wiring only.
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
  translateAtoms,
  centreAtoms,
  formatStructure,
  computeBoxFromBounds,
  boxFitsStructure,
  targetUnit,
  unitFactor,
  MIN_BOX_NM
} from '../src/core/structure.js';

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
    // Bumped whenever the coordinates change, so the preview cache knows to
    // rebuild without having to compare the atom list itself.
    revision: 0
  };

  const resetApplied = () => {
    state.applied = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, centre: null, order: [], pivots: [] };
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

    seedBoxInputs();
    updateSystemStats();
    updateExportInfo();
    renderOutput();
    renderEditconf();
    renderViewer();

    if (state.unknownElements.length) {
      showToast(
        `Unrecognised element symbol(s): ${state.unknownElements.join(', ')}. ` +
        `Carbon mass assumed for those atoms.`,
        'warn'
      );
    }
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
    const dx = Number(rotX.value) || 0;
    const dy = Number(rotY.value) || 0;
    const dz = Number(rotZ.value) || 0;

    // Rotate about the pivot chosen under "Rotate about": the geometric
    // centre (the default, so the structure does not swing away), the centre
    // of mass, or the origin. Velocities rotate with the frame but are not
    // translated.
    const pivotMode = rotPivot && ['mass', 'origin'].includes(rotPivot.value) ? rotPivot.value : 'geometric';
    const pivot = pivotMode === 'origin' ? { x: 0, y: 0, z: 0 }
      : pivotMode === 'mass' ? centreOfMass(state.atoms)
        : geometricCentre(state.atoms);
    pushUndo('rotation');
    state.atoms = rotateAtoms(state.atoms, dx, dy, dz, pivot);
    state.revision++;
    state.applied.rx += dx; state.applied.ry += dy; state.applied.rz += dz;
    state.applied.order.push('rotate');
    if (!state.applied.pivots) state.applied.pivots = [];
    state.applied.pivots.push(pivotMode);
    afterTransform(`Rotated by (${dx}°, ${dy}°, ${dz}°).`);

    // The cell is not rotated with the contents, and it defines the lattice.
    // For an isolated molecule that is harmless; for a periodic system it
    // means the images no longer tile as they did, so the rotated coordinates
    // are only safe as a starting geometry to re-solvate, not as a drop-in
    // replacement for the original frame.
    if ((dx || dy || dz) && state.box && state.box.length >= 3) {
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
    pushUndo('translation');
    state.atoms = translateAtoms(state.atoms, dx, dy, dz);
    state.revision++;
    state.applied.tx += dx; state.applied.ty += dy; state.applied.tz += dz;
    state.applied.order.push('translate');
    afterTransform(`Translated by (${dx}, ${dy}, ${dz}).`);
  });

  // The page offers one "Centre on origin" button plus a mode select, rather than
  // a separate button per centring method.
  if (btnCentre) btnCentre.addEventListener('click', () => {
    if (!requireStructure()) return;
    const mode = centerMode && centerMode.value === 'mass' ? 'mass' : 'geometric';
    pushUndo('centring');
    state.atoms = centreAtoms(state.atoms, mode);
    state.revision++;
    state.applied.centre = mode;
    state.applied.order.push('centre');
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

  function afterTransform(message) {
    updateSystemStats();
    renderEditconf();
    if (!state.boxEdited) seedBoxInputs();
    renderOutput();
    renderViewer();
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
  });

  function renderOutput() {
    if (!outputArea || state.atoms.length === 0) return;

    const format = exportFormat ? exportFormat.value : 'pdb';
    const box = currentBox();
    const fit = boxFitsStructure(state.atoms, state.unit, box);
    updateBoxNote(box, fit);

    // The whole buffer is shown, however large, so it can always be scrolled
    // to the end. Two things keep that affordable.
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

  copyButton(btnCopy, () => (requireStructure() ? fullOutput() : null),
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

  /** Rebuild the model from the current coordinates. */
  function renderViewer() {
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

      viewer.clear();
      viewer.addModel(pdb, 'pdb');
      viewer.setStyle({}, styleSpec());
      drawBox();
      viewer.zoomTo();
      viewer.render();

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

  /** Redraw the cell outline alone, leaving the model and the camera as
   *  they are. */
  function refreshBox() {
    if (!viewer || viewerFailed) return;
    viewer.removeAllShapes();
    drawBox();
    viewer.render();
  }

  if (viewerStyle) viewerStyle.addEventListener('change', () => {
    if (!viewer || viewerFailed) return;
    viewer.setStyle({}, styleSpec());
    viewer.render();
  });

  if (btnViewerReset) btnViewerReset.addEventListener('click', () => {
    if (!viewer || viewerFailed) return;
    viewer.zoomTo();
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

  /**
   * Outline the simulation cell.
   *
   * Drawn from the cell vectors rather than left to 3Dmol's unit-cell helper,
   * because the cell may be triclinic: a rhombic dodecahedron is a
   * parallelepiped, not a cuboid, and drawing it as a box would misrepresent
   * where the periodic images actually sit.
   *
   * GROMACS places the cell origin at (0, 0, 0), so the outline is drawn from
   * there. If the structure has been translated away from the origin it will
   * sit outside the outline, which is worth seeing rather than hiding.
   */
  const boxShown = () => !showBox || showBox.getAttribute('aria-pressed') !== 'false';

  function drawBox() {
    if (!viewer || !boxShown()) return;

    const box = currentBox();
    if (!box || box.length < 3 || !box.every(Number.isFinite)) return;

    // The model is fed to 3Dmol in angstrom; the cell store is nm.
    const S = 10;
    const v = state.boxVectors && state.boxVectors.length >= 9
      ? state.boxVectors
      : [box[0], box[1], box[2], 0, 0, 0, 0, 0, 0];

    // GROMACS order: v1x v2y v3z v1y v1z v2x v2z v3x v3y
    const a = [v[0] * S, v[3] * S, v[4] * S];
    const b = [v[5] * S, v[1] * S, v[6] * S];
    const c = [v[7] * S, v[8] * S, v[2] * S];

    const corner = (i, j, k) => ({
      x: i * a[0] + j * b[0] + k * c[0],
      y: i * a[1] + j * b[1] + k * c[1],
      z: i * a[2] + j * b[2] + k * c[2]
    });

    const edges = [
      [[0,0,0],[1,0,0]], [[0,0,0],[0,1,0]], [[0,0,0],[0,0,1]],
      [[1,0,0],[1,1,0]], [[1,0,0],[1,0,1]],
      [[0,1,0],[1,1,0]], [[0,1,0],[0,1,1]],
      [[0,0,1],[1,0,1]], [[0,0,1],[0,1,1]],
      [[1,1,0],[1,1,1]], [[1,0,1],[1,1,1]], [[0,1,1],[1,1,1]]
    ];

    const dark = isDark();
    for (const [p1, p2] of edges) {
      viewer.addLine({
        start: corner(...p1),
        end: corner(...p2),
        color: dark ? '#64748b' : '#94a3b8',
        dashed: true
      });
    }
  }

  if (showBox) showBox.addEventListener('click', () => {
    showBox.setAttribute('aria-pressed', String(!boxShown()));
    refreshBox();
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

    if (a.rx || a.ry || a.rz) {
      parts.push(`-rotate ${a.rx} ${a.ry} ${a.rz}`);
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
    state.box = snap.box;
    state.boxVectors = snap.boxVectors;
    state.boxEdited = snap.boxEdited;
    state.revision++;

    updateSystemStats();
    renderEditconf();
    if (!state.boxEdited) seedBoxInputs();
    renderOutput();
    renderViewer();
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
    if (viewer && !viewerFailed) {
      viewer.clear();
      viewer.render();
    }
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
