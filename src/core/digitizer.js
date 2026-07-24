/**
 * @module core/digitizer
 *
 * Pixel-to-data coordinate mapping for STEMKit's Plot Digitizer, which
 * recovers numerical values from a published figure image.
 *
 * The mapping is a two-point affine calibration per axis: the user identifies
 * two pixel positions of known data value, and every subsequent click is
 * interpolated (or extrapolated) from that pair. On a logarithmic axis the
 * interpolation is performed in log space, because a decade occupies a
 * constant pixel distance there, treating a log axis linearly is the single
 * most common way to digitise a figure incorrectly.
 *
 * The module is pure: no canvas, no DOM, no image handling.
 */

/**
 * Map one pixel coordinate onto its data value.
 *
 * @param {number} px - Pixel coordinate to convert.
 * @param {number} px1 - Pixel position of the first calibration point.
 * @param {number} px2 - Pixel position of the second calibration point.
 * @param {number} val1 - Data value at the first calibration point.
 * @param {number} val2 - Data value at the second calibration point.
 * @param {boolean} [useLog=false] - Interpolate in log10 space.
 * @returns {number|null} The data value, or null when the calibration is
 *          degenerate (coincident pixels, or non-positive values on a log axis).
 */
export function mapScale(px, px1, px2, val1, val2, useLog = false) {
  if (![px, px1, px2, val1, val2].every(Number.isFinite)) return null;

  // Coincident calibration pixels give no scale to interpolate along.
  if (px2 === px1) return null;

  if (useLog) {
    // A logarithmic axis cannot pass through or below zero.
    if (val1 <= 0 || val2 <= 0) return null;
    const l1 = Math.log10(val1);
    const l2 = Math.log10(val2);
    return Math.pow(10, l1 + ((px - px1) * (l2 - l1)) / (px2 - px1));
  }
  return val1 + ((px - px1) * (val2 - val1)) / (px2 - px1);
}

/**
 * Convert a pixel position to data coordinates using a full calibration.
 *
 * @param {number} px
 * @param {number} py
 * @param {{
 *   pxX1:number, pxX2:number, pxY1:number, pxY2:number,
 *   valX1:number, valX2:number, valY1:number, valY2:number,
 *   logX?:boolean, logY?:boolean
 * }} calibration
 * @returns {{x:number, y:number}|null} Null when the calibration is incomplete
 *          or the result is not finite.
 */
export function toDataCoordinates(px, py, calibration) {
  if (!calibration) return null;
  const {
    pxX1, pxX2, pxY1, pxY2,
    valX1, valX2, valY1, valY2,
    logX = false, logY = false
  } = calibration;

  const required = [pxX1, pxX2, pxY1, pxY2, valX1, valX2, valY1, valY2];
  if (!required.every(v => v !== null && v !== undefined && Number.isFinite(v))) {
    return null;
  }

  const x = mapScale(px, pxX1, pxX2, valX1, valX2, logX);
  const y = mapScale(py, pxY1, pxY2, valY1, valY2, logY);
  if (x === null || y === null) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * Validate a calibration before digitising begins.
 *
 * Catching these conditions up front matters: a silently wrong calibration
 * produces plausible-looking numbers that are simply incorrect, and the error
 * is invisible in the exported CSV.
 *
 * @param {object} calibration
 * @returns {{valid:boolean, errors:string[], warnings:string[]}}
 */
export function validateCalibration(calibration) {
  const errors = [];
  const warnings = [];
  if (!calibration) {
    return { valid: false, errors: ['No calibration supplied.'], warnings };
  }

  const {
    pxX1, pxX2, pxY1, pxY2,
    valX1, valX2, valY1, valY2,
    logX = false, logY = false
  } = calibration;

  const present = (v) => v !== null && v !== undefined && Number.isFinite(v);

  if (![pxX1, pxX2, pxY1, pxY2].every(present)) {
    errors.push('Calibration pixels are not all set.');
  }
  if (![valX1, valX2, valY1, valY2].every(present)) {
    errors.push('Calibration values are not all set.');
  }
  if (errors.length) return { valid: false, errors, warnings };

  if (pxX1 === pxX2) errors.push('The two X calibration points share a pixel column.');
  if (pxY1 === pxY2) errors.push('The two Y calibration points share a pixel row.');
  if (valX1 === valX2) errors.push('The two X calibration values are identical.');
  if (valY1 === valY2) errors.push('The two Y calibration values are identical.');

  if (logX && (valX1 <= 0 || valX2 <= 0)) {
    errors.push('A logarithmic X axis requires both calibration values to be positive.');
  }
  if (logY && (valY1 <= 0 || valY2 <= 0)) {
    errors.push('A logarithmic Y axis requires both calibration values to be positive.');
  }

  // Close calibration points magnify any click error along that axis.
  if (present(pxX1) && present(pxX2) && Math.abs(pxX2 - pxX1) < 20) {
    warnings.push('The X calibration points are very close together; small ' +
                  'clicking errors will be amplified across the figure.');
  }
  if (present(pxY1) && present(pxY2) && Math.abs(pxY2 - pxY1) < 20) {
    warnings.push('The Y calibration points are very close together; small ' +
                  'clicking errors will be amplified across the figure.');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Estimate the data-space uncertainty of a one-pixel click error.
 *
 * Reporting this alongside digitised values is honest practice: the precision
 * of a digitised point is set by the figure's resolution, not by the number of
 * decimal places the export happens to print.
 *
 * @param {object} calibration
 * @returns {{dx:number, dy:number}|null} Data units per pixel at mid-range.
 */
export function pixelResolution(calibration) {
  const check = validateCalibration(calibration);
  if (!check.valid) return null;

  const midX = (calibration.pxX1 + calibration.pxX2) / 2;
  const midY = (calibration.pxY1 + calibration.pxY2) / 2;

  const a = toDataCoordinates(midX, midY, calibration);
  const b = toDataCoordinates(midX + 1, midY + 1, calibration);
  if (!a || !b) return null;

  return { dx: Math.abs(b.x - a.x), dy: Math.abs(b.y - a.y) };
}

/**
 * Remove points within a radius of a pixel position.
 *
 * @param {Array<{pxX:number, pxY:number}>} points
 * @param {number} px
 * @param {number} py
 * @param {number} radius
 * @returns {{points:Array<object>, removed:number}}
 */
export function erasePoints(points, px, py, radius) {
  if (!Array.isArray(points)) return { points: [], removed: 0 };
  const r2 = radius * radius;
  const kept = points.filter(pt => {
    const dx = pt.pxX - px;
    const dy = pt.pxY - py;
    return dx * dx + dy * dy > r2;
  });
  return { points: kept, removed: points.length - kept.length };
}

/**
 * Sort points left to right by pixel column, for export.
 *
 * @param {Array<{pxX:number}>} points
 * @returns {Array<object>} A new array.
 */
export function sortPoints(points) {
  if (!Array.isArray(points)) return [];
  return [...points].sort((a, b) => a.pxX - b.pxX);
}

/**
 * Format a digitised value.
 *
 * Values in the everyday range are shown at eight significant figures, and
 * anything outside it in exponential form.
 *
 * @param {number} v
 * @returns {string}
 */
export function formatValue(v) {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const mag = Math.abs(v);
  if (mag >= 1e-4 && mag < 1e7) {
    return parseFloat(v.toPrecision(8)).toString();
  }
  return v.toExponential(6);
}

/**
 * Serialise digitised datasets as CSV.
 *
 * @param {Array<{name:string, points:Array<object>}>} datasets
 * @returns {string}
 */
export function generateCSV(datasets) {
  let csv = 'Dataset,X,Y\n';
  if (!Array.isArray(datasets)) return csv;

  for (const ds of datasets) {
    const safeName = String(ds.name ?? '').replace(/"/g, '""');
    for (const pt of sortPoints(ds.points || [])) {
      csv += `"${safeName}",${formatValue(pt.logicalX)},${formatValue(pt.logicalY)}\n`;
    }
  }
  return csv;
}

/**
 * Validate raw form inputs and build a numeric calibration.
 *
 * The UI holds axis values as strings and pixel positions as nullable numbers,
 * so this wraps `validateCalibration` with the parsing and the specific
 * messages a user needs, naming which markers are unplaced rather than
 * reporting a generic failure.
 *
 * @param {{
 *   pxX1:number|null, pxX2:number|null, pxY1:number|null, pxY2:number|null,
 *   valX1:string, valX2:string, valY1:string, valY2:string,
 *   logX?:boolean, logY?:boolean
 * }} form
 * @returns {{valid:boolean, calibration:object|null, errors:string[], warnings:string[]}}
 */
export function validateCalibrationForm(form) {
  const errors = [];
  if (!form) return { valid: false, calibration: null, errors: ['No input.'], warnings: [] };

  const missing = [];
  if (form.pxX1 === null || form.pxX1 === undefined) missing.push('X1');
  if (form.pxX2 === null || form.pxX2 === undefined) missing.push('X2');
  if (form.pxY1 === null || form.pxY1 === undefined) missing.push('Y1');
  if (form.pxY2 === null || form.pxY2 === undefined) missing.push('Y2');
  if (missing.length) {
    errors.push(
      `Calibration incomplete: still need to place ${missing.join(', ')}. ` +
      `Click each calibration button, then click that position on the plot.`
    );
    return { valid: false, calibration: null, errors, warnings: [] };
  }

  const parsed = {};
  const bad = [];
  for (const key of ['valX1', 'valX2', 'valY1', 'valY2']) {
    const n = Number(String(form[key]).trim());
    if (!Number.isFinite(n)) bad.push(key.replace('val', ''));
    parsed[key] = n;
  }
  if (bad.length) {
    errors.push(`These axis values are not numbers: ${bad.join(', ')}.`);
    return { valid: false, calibration: null, errors, warnings: [] };
  }

  const calibration = {
    pxX1: form.pxX1, pxX2: form.pxX2, pxY1: form.pxY1, pxY2: form.pxY2,
    valX1: parsed.valX1, valX2: parsed.valX2,
    valY1: parsed.valY1, valY2: parsed.valY2,
    logX: Boolean(form.logX), logY: Boolean(form.logY)
  };

  const check = validateCalibration(calibration);
  return {
    valid: check.valid,
    calibration: check.valid ? calibration : null,
    errors: [...errors, ...check.errors],
    warnings: check.warnings
  };
}

/**
 * Escape a value for embedding in a single-quoted Python string literal.
 *
 * Backslashes are escaped before quotes, so a Windows path such as
 * `C:\runs\a` does not produce an invalid literal. Newlines are flattened to
 * spaces, since a raw newline inside a single-quoted Python string is a syntax
 * error rather than a line break.
 *
 * @param {*} value
 * @returns {string} The escaped body, without surrounding quotes.
 */
export function pythonString(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, ' ');
}

/**
 * Convert a value into a valid Python identifier.
 *
 * Characters that cannot appear in an identifier become underscores, and a
 * leading digit is prefixed, since `1series` is not a legal variable name.
 *
 * @param {*} value
 * @returns {string}
 */
export function pythonIdentifier(value) {
  const id = String(value == null ? '' : value).replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(id) ? id : `ds_${id}`;
}

/**
 * Digitise a batch of pixel positions.
 *
 * @param {Array<{pxX:number, pxY:number}>} points
 * @param {object} calibration
 * @returns {Array<{pxX:number, pxY:number, logicalX:number, logicalY:number}>}
 *          Points that could not be mapped are omitted.
 */
export function digitisePoints(points, calibration) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const pt of points) {
    const d = toDataCoordinates(pt.pxX, pt.pxY, calibration);
    if (d) out.push({ ...pt, logicalX: d.x, logicalY: d.y });
  }
  return out;
}
