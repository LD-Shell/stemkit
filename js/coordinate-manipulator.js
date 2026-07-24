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
    applied: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, centre: null, order: [] },
    // Bumped whenever the coordinates change, so the preview cache knows to
    // rebuild without having to compare the atom list itself.
    revision: 0
  };

  const resetApplied = () => {
    state.applied = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, centre: null, order: [] };
  };

  // --- 2. Bindings ---
  const $ = (id) => document.getElementById(id);

  const uploadZone = $('uploadZone');
  const fileInput = $('fileInput');
  const workspace = $('workspace');
  const outputArea = $('coordOutput');
  const exportFormat = $('exportFormat');
  const unitNote = $('transUnitNote');
  const boxNote = $('boxSource');
  const warningBox = $('previewNote');

  const btnShowAll = $('btnShowAll');
  const btnUndo = $('btnUndo');
  const btnRedo = $('btnRedo');
  const massDetail = $('massDetail');
  const massTable = $('massTable');
  const massAssumptions = $('massAssumptions');
  const btnMassDownload = $('btnMassDownload');
  const btnMassDetail = $('btnMassDetail');
  const showBox = $('showBox');
  const editconfOut = $('editconfOut');
  const editconfNotes = $('editconfNotes');
  const btnCopyEditconf = $('btnCopyEditconf');
  const fileNameInput = $('exportName');
  const viewerCanvas = $('viewerCanvas');
  const viewerStyle = $('viewerStyle');
  const viewerNote = $('viewerNote');
  const viewerFallback = $('viewerFallback');
  const btnViewerReset = $('btnViewerReset');

  // The statistics panel is a set of individual fields rather than one block,
  // so each is written separately.
  const statAtomCount = $('statAtomCount');
  const statGeoCenter = $('statGeoCenter');
  const statMassCenter = $('statMassCenter');
  const statMolWeight = $('statMolWeight');
  const statBoundingBox = $('statBoundingBox');
  const systemFormatLabel = $('systemFormatLabel');

  const rotX = $('rotX');
  const rotY = $('rotY');
  const rotZ = $('rotZ');
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
  const btnReset = $('btnResetRot');
  const btnDownload = $('btnDownload');
  const btnCopy = $('btnCopyBuffer');

  let originalAtoms = [];

  // --- 3. File intake ---
  // The dashed box is the drop target; the surrounding section only positions
  // it. Binding to the section instead paints drag feedback on an element with
  // no border, and (because the file input lives inside it) lets the
  // synthetic click from `fileInput.click()` bubble back into the same handler
  // and re-open the picker, which loses the change event.
  const dropArea = $('dropArea') || uploadZone;

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    if (dropArea) dropArea.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, false);
  });

  const DRAG_CLASSES = ['bg-purple-100', 'dark:bg-purple-900/30', 'border-purple-400'];

  if (dropArea) {
    ['dragenter', 'dragover'].forEach(evt =>
      dropArea.addEventListener(evt, () => dropArea.classList.add(...DRAG_CLASSES)));
    ['dragleave', 'drop'].forEach(evt =>
      dropArea.addEventListener(evt, () => dropArea.classList.remove(...DRAG_CLASSES)));

    dropArea.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });

    dropArea.addEventListener('click', (e) => {
      if (e.target === fileInput) return;   // our own synthetic click, ignore
      if (fileInput) fileInput.click();
    });
  }

  if (fileInput) fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });

  function handleFile(file) {
    const name = (file && file.name) || '';
    const ext = name.split('.').pop().toLowerCase();

    if (!['pdb', 'gro', 'xyz', 'ent'].includes(ext)) {
      showToast('Unsupported file type, use .pdb, .gro or .xyz.', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = parseStructure(e.target.result, name);

      if (!result || result.atoms.length === 0) {
        showToast('No atoms could be parsed from that file.', 'error');
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

      if (systemFormatLabel) {
        systemFormatLabel.textContent =
          `${name} · ${(result.format || '').toUpperCase()} · ${result.unit === 'nm' ? 'nm' : 'Å'}`;
      }

      seedBoxInputs();
      updateSystemStats();
      renderOutput();
      renderEditconf();

      if (uploadZone) uploadZone.classList.add('hidden');
      if (workspace) workspace.classList.remove('hidden');

      if (state.unknownElements.length) {
        showToast(
          `Unrecognised element symbol(s): ${state.unknownElements.join(', ')}. ` +
          `Carbon mass assumed for those atoms.`,
          'info'
        );
      }
    };
    reader.readAsText(file);
    fileInput.value = '';
  }

  // --- 4. Statistics ---
  function updateSystemStats() {
    if (!statAtomCount) return;

    const s = structureStats(state.atoms);
    const bb = s.boundingBox;
    const com = centreOfMass(state.atoms);
    const u = state.unit === 'nm' ? 'nm' : 'Å';
    const f = (n) => Number.isFinite(n) ? n.toFixed(3) : '0.000';
    const triple = (x, y, z) => `${f(x)}, ${f(y)}, ${f(z)}`;

    statAtomCount.textContent = s.nAtoms;

    if (statGeoCenter) {
      statGeoCenter.textContent = s.nAtoms
        ? triple((bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2, (bb.minZ + bb.maxZ) / 2)
        : '0.0, 0.0, 0.0';
    }

    if (statMassCenter) {
      statMassCenter.textContent = (com && com.mass)
        ? triple(com.x, com.y, com.z)
        : '0.0, 0.0, 0.0';
    }

    if (statMolWeight) {
      statMolWeight.textContent = s.totalMass ? `${s.totalMass.toFixed(2)} Da` : ', ';
      if (massDetail && massDetail.open) renderMassDetail();
    }

    if (statBoundingBox) {
      statBoundingBox.textContent = s.nAtoms
        ? `${(bb.maxX - bb.minX).toFixed(1)} × ${(bb.maxY - bb.minY).toFixed(1)} × ` +
          `${(bb.maxZ - bb.minZ).toFixed(1)} ${u}`
        : '0.0 × 0.0 × 0.0';
    }

    if (unitNote) {
      unitNote.textContent =
        `Source coordinates are in ${u}. ` +
        `Export as ${exportFormat ? exportFormat.value.toUpperCase() : 'PDB'} uses ` +
        `${targetUnit(exportFormat ? exportFormat.value : 'pdb') === 'nm' ? 'nm' : 'Å'}; ` +
        `conversion is applied automatically.`;
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
    renderViewer();
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

  function updateBoxNote(box) {
    if (!boxNote) return;
    const fit = boxFitsStructure(state.atoms, state.unit, box);
    const source = boxSourceText();
    if (fit.fits) {
      boxNote.textContent =
        `Box (nm): ${box.map(v => v.toFixed(3)).join(' × ')}, ${source}`;
      boxNote.className = 'text-xs text-slate-500';
    } else {
      boxNote.textContent =
        `${source} The structure overflows the box along ${fit.overflow.join(', ')}. ` +
        `Increase those dimensions or the system will be clipped.`;
      boxNote.className = 'text-xs text-amber-600 dark:text-amber-400';
    }
  }

  [boxLx, boxLy, boxLz].filter(Boolean).forEach(el =>
    el.addEventListener('input', () => {
      state.boxEdited = true;
      // Typing lengths describes a rectangular cell, so any triclinic
      // components read from the source no longer apply.
      state.boxVectors = null;
      updateBoxNote(currentBox());
      renderOutput();
    }));

  if (boxPad) boxPad.addEventListener('input', () => {
    if (!state.boxEdited) seedBoxInputs();
    renderOutput();
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

    // Rotate about the geometric centre so the structure does not swing away
    // from the origin; velocities rotate with the frame but are not translated.
    pushUndo('rotation');
    state.atoms = rotateAtoms(state.atoms, dx, dy, dz, geometricCentre(state.atoms));
    state.revision++;
    state.applied.rx += dx; state.applied.ry += dy; state.applied.rz += dz;
    state.applied.order.push('rotate');
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
        'info'
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

  // The page offers one "Align Origin" button plus a mode select, rather than
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

  if (btnReset) btnReset.addEventListener('click', () => {
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
    showToast(message, 'success');
  }

  // --- 7. Output ---
  let previewCache = { signature: null, text: '' };
  let previewToken = 0;

  /** Row count beneath the preview heading, so the size is never a surprise. */
  function updatePreviewNote(count, working) {
    if (!warningBox) return;
    const fit = state.box && boxFitsStructure(state.atoms, state.unit, currentBox());
    if (fit && !fit.fits) return;          // the overflow warning takes priority
    warningBox.textContent = working
      ? `${count.toLocaleString()} atoms | formatting…`
      : `${count.toLocaleString()} atoms | complete buffer, scrollable`;
  }

  if (exportFormat) exportFormat.addEventListener('change', () => {
    updateSystemStats();
    renderOutput();
  });

  function renderOutput() {
    if (!outputArea || state.atoms.length === 0) return;

    const format = exportFormat ? exportFormat.value : 'pdb';
    const box = currentBox();

    // The whole buffer is shown, however large, so it can always be scrolled
    // to the end. Two things keep that affordable.
    //
    // First, the result is cached against a signature of what it was built
    // from, so the common case, a redraw where nothing relevant changed , 
    // costs nothing. Formatting is only repeated when the coordinates, the
    // format or the cell actually change.
    //
    // Second, for a large system the work is handed to a later task rather
    // than done inside the click handler. Formatting a million atoms takes
    // seconds; doing that synchronously would freeze the page with no
    // indication why, so the row count and a "formatting" note are painted
    // first and the text arrives when it is ready.
    // Capped by default so a large system stays responsive, with the button
    // lifting it. The cap is generous enough that most structures are shown
    // whole and the button never appears.
    const PREVIEW_LIMIT = 5000;
    const limited = !state.showAllRows && state.atoms.length > PREVIEW_LIMIT;
    const rows = limited ? state.atoms.slice(0, PREVIEW_LIMIT) : state.atoms;

    if (btnShowAll) {
      btnShowAll.classList.toggle('hidden', state.atoms.length <= PREVIEW_LIMIT);
      btnShowAll.textContent = state.showAllRows
        ? `Show first ${PREVIEW_LIMIT.toLocaleString()}`
        : `Show all ${state.atoms.length.toLocaleString()}`;
    }

    const signature = [
      state.revision, format, state.unit, limited,
      (box || []).join(','), (state.boxVectors || []).join(',')
    ].join('|');

    if (previewCache.signature === signature) {
      outputArea.textContent = previewCache.text;
      updatePreviewNote(state.atoms.length);
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
      updatePreviewNote(state.atoms.length);
      return;
    }

    outputArea.textContent =
      `Formatting ${state.atoms.length.toLocaleString()} atoms…`;
    updatePreviewNote(state.atoms.length, true);

    // A later transformation supersedes this one: without the token an older,
    // slower build could land after a newer one and show stale coordinates.
    const token = ++previewToken;
    setTimeout(() => {
      if (token !== previewToken) return;
      previewCache = { signature, text: build() };
      outputArea.textContent = previewCache.text;
      updatePreviewNote(state.atoms.length);
    }, 0);

    updateBoxNote(box);

    if (warningBox) {
      const fit = boxFitsStructure(state.atoms, state.unit, box);
      if (!fit.fits) {
        warningBox.textContent =
          `Warning: the structure is larger than the box along ` +
          `${fit.overflow.join(', ')}.`;
        warningBox.classList.remove('hidden');
      } else {
        warningBox.classList.add('hidden');
      }
    }
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
    const blob = new Blob([fullOutput()], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `structure.${format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast(`Downloaded structure.${format}`, 'success');
  });

  if (btnCopy) btnCopy.addEventListener('click', () => {
    if (!requireStructure()) return;
    navigator.clipboard.writeText(fullOutput())
      .then(() => showToast('Coordinates copied.', 'success'))
      .catch(() => showToast('Clipboard access denied.', 'error'));
  });

  // --- 8. Utilities ---
  function showToast(msg, type) {
    const container = $('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    const colors = type === 'success'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30'
      : type === 'error'
        ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30'
        : 'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30';
    toast.className =
      `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  document.querySelectorAll('.accordion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', !expanded);
      const target = $(btn.getAttribute('data-target'));
      if (target) target.classList.toggle('expanded');
    });
  });

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
    viewerFallback.classList.remove('hidden');
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
        const dark = document.documentElement.classList.contains('dark');
        viewer = window.$3Dmol.createViewer(viewerCanvas, {
          backgroundColor: dark ? '#0f172a' : '#f1f5f9'
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
            `${state.atoms.length.toLocaleString()} atoms, the export is complete`
          : 'Updates after every transformation';
      }
    } catch (err) {
      console.error(err);
      viewerFailed = true;
      showViewerFallback('The 3D view could not be started. Transformations and ' +
                         'export still work.');
    }
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


  /* --- Resizable split between the view and the preview --------------------
   * The useful proportion depends on the structure and on what the user is
   * doing, so it is left adjustable rather than fixed. The preview keeps a
   * concrete height and the view takes whatever is left, which is what lets
   * the preview scroll internally instead of pushing the page taller.
   */
  const viewSplit = $('viewSplit');
  const previewPanel = $('previewPanel');

  if (viewSplit && previewPanel) {
    const MIN_PREVIEW = 100;   // still shows a few rows
    const MIN_VIEW = 160;      // still recognisably a structure

    let dragging = false;

    const setPreviewHeight = (px) => {
      const shell = previewPanel.parentElement;
      const available = shell ? shell.getBoundingClientRect().height : window.innerHeight;
      const max = Math.max(MIN_PREVIEW, available - MIN_VIEW);
      previewPanel.style.height = `${Math.round(Math.min(Math.max(px, MIN_PREVIEW), max))}px`;
    };

    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const point = e.touches ? e.touches[0].clientY : e.clientY;
      // Distance from the pointer to the bottom of the panel is the height
      // the preview should take.
      setPreviewHeight(previewPanel.getBoundingClientRect().bottom - point);
    };

    const SPLIT_KEY = 'stemkit-coord-split';
    const DEFAULT_PREVIEW = 240;

    // Restore the previous choice. Storage may be unavailable, in which case
    // the split simply starts at its default each visit.
    try {
      const saved = Number(localStorage.getItem(SPLIT_KEY));
      if (Number.isFinite(saved) && saved > 0) previewPanel.style.height = `${saved}px`;
    } catch (e) { /* no persistence */ }

    const remember = () => {
      try {
        localStorage.setItem(SPLIT_KEY, String(Math.round(previewPanel.getBoundingClientRect().height)));
      } catch (e) { /* no persistence */ }
    };

    const stop = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      remember();
    };

    const start = (e) => {
      dragging = true;
      // Suppressed during the drag so the pointer does not select the
      // surrounding text as it moves.
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'row-resize';
      e.preventDefault();
    };

    // Double-click returns to the default rather than leaving the user to
    // drag back to a size they cannot see a number for.
    viewSplit.addEventListener('dblclick', () => {
      previewPanel.style.height = `${DEFAULT_PREVIEW}px`;
      remember();
      if (viewer && !viewerFailed) { viewer.resize(); viewer.render(); }
    });

    viewSplit.addEventListener('mousedown', start);
    viewSplit.addEventListener('touchstart', start, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchend', stop);

    // Keyboard equivalent, so the split is not mouse-only.
    viewSplit.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 48 : 16;
      const current = previewPanel.getBoundingClientRect().height;
      if (e.key === 'ArrowUp') { setPreviewHeight(current + step); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { setPreviewHeight(current - step); e.preventDefault(); }
      else return;
      remember();
      if (viewer && !viewerFailed) { viewer.resize(); viewer.render(); }
    });

    // The WebGL canvas is sized from its container, so it has to be told.
    let resizeTimer = null;
    const syncViewer = () => {
      if (!viewer || viewerFailed) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { viewer.resize(); viewer.render(); }, 60);
    };
    window.addEventListener('mouseup', syncViewer);
    window.addEventListener('touchend', syncViewer);
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
  function drawBox() {
    if (!viewer || !showBox || !showBox.checked) return;

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

    const dark = document.documentElement.classList.contains('dark');
    for (const [p1, p2] of edges) {
      viewer.addLine({
        start: corner(...p1),
        end: corner(...p2),
        color: dark ? '#64748b' : '#94a3b8',
        dashed: true
      });
    }
  }

  if (showBox) showBox.addEventListener('change', renderViewer);


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
    const outName = (fileNameInput && fileNameInput.value.trim()) || 'output';

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
      if (!a.centre) {
        notes.push('This tool rotates about the geometric centre; editconf rotates ' +
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
      if (editconfNotes) editconfNotes.innerHTML = '';
      return;
    }

    editconfOut.textContent = result.command;
    if (editconfNotes) {
      editconfNotes.innerHTML = result.notes.length
        ? '<ul class="list-disc pl-4 space-y-1">' +
          result.notes.map(n => `<li>${n}</li>`).join('') + '</ul>'
        : '';
    }
  }

  if (btnCopyEditconf) btnCopyEditconf.addEventListener('click', () => {
    const result = editconfCommand();
    if (!result) return;
    navigator.clipboard.writeText(result.command).then(
      () => showToast('Command copied.', 'success'),
      () => showToast('Could not copy the command.', 'error')
    );
  });

  if (exportFormat) exportFormat.addEventListener('change', renderEditconf);
  if (fileNameInput) fileNameInput.addEventListener('input', renderEditconf);


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
    btn.classList.toggle('opacity-40', empty);
    btn.classList.toggle('cursor-not-allowed', empty);
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
      <tr class="border-b border-slate-200/60 dark:border-slate-800">
        <td class="py-1 pr-3 font-mono">${r.symbol}</td>
        <td class="py-1 pr-3 text-right">${r.count.toLocaleString()}</td>
        <td class="py-1 pr-3 text-right font-mono">${r.weight}</td>
        <td class="py-1 text-right font-mono">${r.subtotal.toFixed(3)}</td>
      </tr>`).join('');

    massTable.innerHTML = `
      <table class="w-full text-[11px]">
        <thead class="text-slate-500 dark:text-slate-400">
          <tr class="border-b border-slate-300 dark:border-slate-700">
            <th class="text-left py-1 pr-3 font-bold">Element</th>
            <th class="text-right py-1 pr-3 font-bold">Atoms</th>
            <th class="text-right py-1 pr-3 font-bold">Weight (u)</th>
            <th class="text-right py-1 font-bold">Subtotal (Da)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr class="font-bold">
            <td class="pt-1 pr-3">Total</td>
            <td class="pt-1 pr-3 text-right">${b.rows.reduce((s, r) => s + r.count, 0).toLocaleString()}</td>
            <td></td>
            <td class="pt-1 text-right font-mono">${b.total.toFixed(2)}</td>
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
