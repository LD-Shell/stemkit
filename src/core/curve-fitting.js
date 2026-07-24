/**
 * @module core/curve-fitting
 *
 * Least-squares curve fitting extracted from STEMKit's Curve Fitter.
 *
 * Fitting is delegated to the vendored regression.js bundle; this module adds
 * the input validation, goodness-of-fit statistics, and model-adequacy checks
 * that the raw library does not provide.
 *
 * A caveat worth stating plainly, because it affects interpretation of every
 * exponential, power, and logarithmic fit: regression.js fits these models by
 * **linearisation**, taking logarithms and running least squares in the
 * transformed space. That minimises error in log space, not in the original
 * units, so the result is not the maximum-likelihood fit under additive
 * Gaussian noise. regression.js additionally *weights* the log-space fit by y,
 * which shifts estimates slightly relative to an unweighted log-OLS: for a
 * clean doubling series it returns a growth rate of 0.69022 where plain
 * log-OLS gives ln 2 = 0.69315. Neither is wrong, but they answer different
 * questions, and the difference is large enough to matter when a rate constant
 * is being reported. For publication-grade nonlinear fits, a
 * Levenberg–Marquardt routine on the untransformed data is the correct tool.
 * `fitCurve` reports the linearisation through the `linearised` flag so
 * callers can surface it rather than bury it.
 */

import { requireVendor } from './vendor.js';

/**
 * Number of free parameters per model, used for the overfitting check.
 * @type {Object<string, number>}
 */
export const PARAM_COUNT = Object.freeze({
  linear: 2,
  exponential: 2,
  power: 2,
  logarithmic: 2,
  polynomial2: 3,
  polynomial3: 4
});

/**
 * Models whose parameters are not obtained by least squares on the data as
 * given.
 *
 * Exponential and power fits transform y before solving, so what is minimised
 * is a residual in log space rather than in the units of the measurement.
 * Checked against the vendored library: for representative data, parameters
 * exist that fit the original scale roughly 29% (exponential) and 36% (power)
 * better than the ones returned.
 *
 * The logarithmic model is deliberately absent. `y = a + b ln x` is linear in
 * its parameters, so regressing y on ln x is ordinary least squares on the
 * untransformed y, with no bias to declare. It was listed here previously,
 * which put an inaccurate note on the fit summary and in the exported Python.
 */
export const LINEARISED_MODELS = Object.freeze(['exponential', 'power']);

/**
 * Parse whitespace- or comma-delimited text into (x, y) pairs.
 *
 * Points are sorted by x so that a fitted curve can be drawn as a simple
 * polyline. Rows that lack the requested columns, or whose entries are
 * non-numeric (headers, for instance), are counted and reported rather than
 * silently discarded.
 *
 * @param {string} rawText
 * @param {number} xIdx - Zero-based column index for the abscissa.
 * @param {number} yIdx - Zero-based column index for the ordinate.
 * @returns {{data:Array<[number,number]>, warnings:string[],
 *            missingColumns:number, nonNumeric:number}}
 */
export function parseXYData(rawText, xIdx = 0, yIdx = 1) {
  const data = [];
  let missingColumns = 0;
  let nonNumeric = 0;

  if (typeof rawText !== 'string' || rawText.trim() === '') {
    return { data, warnings: [], missingColumns, nonNumeric };
  }
  if (!Number.isInteger(xIdx) || !Number.isInteger(yIdx) || xIdx < 0 || yIdx < 0) {
    return { data, warnings: ['Column indices must be non-negative integers.'],
             missingColumns, nonNumeric };
  }

  for (const line of rawText.split(/\r\n|\r|\n/)) {
    if (line.trim() === '') continue;
    const tokens = line.trim().split(/[\s,]+/).filter(Boolean);

    if (tokens.length <= Math.max(xIdx, yIdx)) {
      missingColumns++;
      continue;
    }

    const x = Number(tokens[xIdx]);
    const y = Number(tokens[yIdx]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      data.push([x, y]);
    } else {
      nonNumeric++;
    }
  }

  const warnings = [];
  if (missingColumns > 0) {
    warnings.push(`Dropped ${missingColumns} line(s) missing requested columns.`);
  }
  if (nonNumeric > 0) {
    warnings.push(`Ignored ${nonNumeric} line(s) with text headers or invalid numbers.`);
  }

  data.sort((a, b) => a[0] - b[0]);
  return { data, warnings, missingColumns, nonNumeric };
}

/**
 * Check that the data satisfy a model's domain requirements.
 *
 * Linearisation takes logarithms, so non-positive values are not merely
 * awkward, they are outside the model's domain entirely.
 *
 * @param {Array<[number,number]>} data
 * @param {string} model
 * @returns {{valid:boolean, error:string|null}}
 */
export function validateForModel(data, model) {
  if (!Array.isArray(data) || data.length === 0) {
    return { valid: false, error: 'No data points supplied.' };
  }

  switch (model) {
    case 'exponential':
      if (data.some(p => p[1] <= 0)) {
        return { valid: false, error: 'Exponential models require every y > 0' };
      }
      break;
    case 'power':
      if (data.some(p => p[0] <= 0 || p[1] <= 0)) {
        return { valid: false, error: 'Power models require every x > 0 and y > 0' };
      }
      break;
    case 'logarithmic':
      if (data.some(p => p[0] <= 0)) {
        return { valid: false, error: 'Logarithmic models require every x > 0' };
      }
      break;
    case 'linear':
    case 'polynomial2':
    case 'polynomial3':
      break;
    default:
      return { valid: false, error: `Unknown model: ${model}` };
  }
  return { valid: true, error: null };
}

/**
 * Coefficient of determination, computed against the *observed* data in the
 * original units.
 *
 * regression.js reports an r² measured in whatever space the fit was performed
 * in, which for linearised models is log space and therefore not comparable
 * across model families. Recomputing here means the r² values returned for a
 * linear and an exponential fit can be meaningfully compared.
 *
 * @param {Array<[number,number]>} data
 * @param {(x:number)=>number} predictFn
 * @returns {number} R² in (-Infinity, 1], or NaN if undefined.
 */
export function rSquared(data, predictFn) {
  if (!Array.isArray(data) || data.length === 0) return NaN;

  const ys = data.map(p => p[1]);
  const meanY = ys.reduce((s, y) => s + y, 0) / ys.length;

  let ssTot = 0;
  let ssRes = 0;
  for (const [x, y] of data) {
    const yHat = predictFn(x);
    if (!Number.isFinite(yHat)) return NaN;
    ssRes += (y - yHat) * (y - yHat);
    ssTot += (y - meanY) * (y - meanY);
  }

  // A constant response has no variance to explain; r² is undefined unless the
  // fit is exact, in which case it is conventionally 1.
  if (ssTot === 0) return ssRes === 0 ? 1 : NaN;
  return 1 - ssRes / ssTot;
}

/**
 * Root-mean-square error in the original units.
 *
 * @param {Array<[number,number]>} data
 * @param {(x:number)=>number} predictFn
 * @returns {number}
 */
export function rmse(data, predictFn) {
  if (!Array.isArray(data) || data.length === 0) return NaN;
  let sse = 0;
  let n = 0;
  for (const [x, y] of data) {
    const yHat = predictFn(x);
    if (Number.isFinite(yHat)) {
      sse += (y - yHat) * (y - yHat);
      n++;
    }
  }
  return n ? Math.sqrt(sse / n) : NaN;
}

/**
 * Adjusted R², penalising additional parameters.
 *
 * @param {number} r2
 * @param {number} n - Number of observations.
 * @param {number} k - Number of fitted parameters.
 * @returns {number} Adjusted R², or NaN when the correction is undefined.
 */
export function adjustedRSquared(r2, n, k) {
  if (!Number.isFinite(r2) || n <= k) return NaN;
  return 1 - ((1 - r2) * (n - 1)) / (n - k);
}

/**
 * Assess whether the data can support the requested model.
 *
 * @param {number} nPoints
 * @param {string} model
 * @returns {{level:'error'|'warn'|'ok', message:string|null,
 *            nParams:number, exactFit:boolean}}
 */
export function assessFitAdequacy(nPoints, model) {
  const nParams = PARAM_COUNT[model] ?? NaN;
  if (!Number.isFinite(nParams)) {
    return { level: 'error', message: `Unknown model: ${model}`, nParams: NaN, exactFit: false };
  }

  if (nPoints < nParams) {
    return {
      level: 'error',
      message: `Under-determined: ${nPoints} points cannot fix ${nParams} parameters.`,
      nParams,
      exactFit: false
    };
  }
  if (nPoints === nParams) {
    return {
      level: 'warn',
      message: `Exact fit: with ${nPoints} points a ${nParams}-parameter model ` +
               `passes through every point, so R² ≈ 1 is not evidence of a good model.`,
      nParams,
      exactFit: true
    };
  }
  if (nPoints <= nParams + 1) {
    return {
      level: 'warn',
      message: 'Very few points for this model, R² is optimistic. Add more data if you can.',
      nParams,
      exactFit: false
    };
  }
  return { level: 'ok', message: null, nParams, exactFit: false };
}

/**
 * Fit a model to (x, y) data.
 *
 * @param {Array<[number,number]>} data
 * @param {string} model - One of the keys of `PARAM_COUNT`.
 * @param {{precision?:number}} [options]
 * @returns {{model:string, equation:number[], r2:number, adjR2:number,
 *            rmse:number, predict:(x:number)=>number, points:Array<[number,number]>,
 *            n:number, nParams:number, linearised:boolean,
 *            adequacy:object, error:null}
 *          | {error:string, model:string}}
 */
export function fitCurve(data, model, options = {}) {
  const regression = requireVendor('regression');
  const { precision = 6 } = options;

  const validation = validateForModel(data, model);
  if (!validation.valid) return { error: validation.error, model };

  if (data.length < 2) {
    return { error: `Need at least 2 points; received ${data.length}.`, model };
  }

  let result;
  try {
    switch (model) {
      case 'linear':
        result = regression.linear(data, { precision });
        break;
      case 'exponential':
        result = regression.exponential(data, { precision });
        break;
      case 'power':
        result = regression.power(data, { precision });
        break;
      case 'logarithmic':
        result = regression.logarithmic(data, { precision });
        break;
      case 'polynomial2':
        result = regression.polynomial(data, { order: 2, precision });
        break;
      case 'polynomial3':
        result = regression.polynomial(data, { order: 3, precision });
        break;
      default:
        return { error: `Unknown model: ${model}`, model };
    }
  } catch (err) {
    return { error: `Fit failed: ${err.message}`, model };
  }

  const predict = (x) => {
    const p = result.predict(x);
    return Array.isArray(p) ? p[1] : NaN;
  };

  const r2 = rSquared(data, predict);
  const err = rmse(data, predict);
  const nParams = PARAM_COUNT[model];

  return {
    model,
    equation: result.equation,
    r2,
    adjR2: adjustedRSquared(r2, data.length, nParams),
    rmse: err,
    predict,
    points: data,
    n: data.length,
    nParams,
    linearised: LINEARISED_MODELS.includes(model),
    adequacy: assessFitAdequacy(data.length, model),
    error: null
  };
}

/**
 * Render a fitted equation as plain text.
 *
 * @param {number[]} eq - Coefficients as returned by regression.js.
 * @param {string} model
 * @returns {string}
 */
export function formatEquation(eq, model) {
  if (!Array.isArray(eq)) return '';
  const sign = (v) => (v >= 0 ? '+' : '-');
  const abs = (v) => Math.abs(v);

  switch (model) {
    case 'linear':
      return `y = ${eq[0]}x ${sign(eq[1])} ${abs(eq[1])}`;
    case 'exponential':
      return `y = ${eq[0]} * e^(${eq[1]}x)`;
    case 'power':
      return `y = ${eq[0]} * x^(${eq[1]})`;
    case 'logarithmic':
      return `y = ${eq[0]} ${sign(eq[1])} ${abs(eq[1])} * ln(x)`;
    case 'polynomial2':
      return `y = ${eq[0]}x^2 ${sign(eq[1])} ${abs(eq[1])}x ${sign(eq[2])} ${abs(eq[2])}`;
    case 'polynomial3':
      return `y = ${eq[0]}x^3 ${sign(eq[1])} ${abs(eq[1])}x^2 ` +
             `${sign(eq[2])} ${abs(eq[2])}x ${sign(eq[3])} ${abs(eq[3])}`;
    default:
      return '';
  }
}

/**
 * Sample a fitted curve on a uniform grid, for plotting.
 *
 * @param {(x:number)=>number} predictFn
 * @param {number} xMin
 * @param {number} xMax
 * @param {number} [steps=200]
 * @returns {{x:number[], y:number[]}} Only finite predictions are retained.
 */
export function sampleCurve(predictFn, xMin, xMax, steps = 200) {
  const x = [];
  const y = [];
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || steps < 2) {
    return { x, y };
  }

  const dx = (xMax - xMin) / (steps - 1);
  for (let i = 0; i < steps; i++) {
    const xi = xMin + i * dx;
    const yi = predictFn(xi);
    if (Number.isFinite(yi)) {
      x.push(xi);
      y.push(yi);
    }
  }
  return { x, y };
}

/**
 * Residuals of a fit, in the original units.
 *
 * @param {Array<[number,number]>} data
 * @param {(x:number)=>number} predictFn
 * @returns {Array<{x:number, observed:number, predicted:number, residual:number}>}
 */
export function residuals(data, predictFn) {
  if (!Array.isArray(data)) return [];
  return data.map(([x, y]) => {
    const predicted = predictFn(x);
    return { x, observed: y, predicted, residual: y - predicted };
  });
}

/**
 * Render a fitted model as a Python expression in `x`.
 *
 * @param {number[]} eq - Coefficients as returned by regression.js.
 * @param {string} model
 * @returns {{body:string, label:string}|null}
 */
export function pythonModelExpression(eq, model) {
  if (!Array.isArray(eq)) return null;
  const p = (n) => String(+n);

  switch (model) {
    case 'linear':
      return { body: `${p(eq[0])} * x + ${p(eq[1])}`,
               label: `y = ${p(eq[0])}x + ${p(eq[1])}` };
    case 'exponential':
      return { body: `${p(eq[0])} * np.exp(${p(eq[1])} * x)`,
               label: `y = ${p(eq[0])}*e^(${p(eq[1])}x)` };
    case 'power':
      return { body: `${p(eq[0])} * np.power(x, ${p(eq[1])})`,
               label: `y = ${p(eq[0])}*x^${p(eq[1])}` };
    case 'logarithmic':
      return { body: `${p(eq[0])} + ${p(eq[1])} * np.log(x)`,
               label: `y = ${p(eq[0])} + ${p(eq[1])}*ln(x)` };
    case 'polynomial2':
      return { body: `${p(eq[0])}*x**2 + ${p(eq[1])}*x + ${p(eq[2])}`,
               label: 'quadratic fit' };
    case 'polynomial3':
      return { body: `${p(eq[0])}*x**3 + ${p(eq[1])}*x**2 + ${p(eq[2])}*x + ${p(eq[3])}`,
               label: 'cubic fit' };
    default:
      return null;
  }
}

/**
 * Emit a standalone matplotlib script reproducing a fit.
 *
 * The script embeds the data and the fitted coefficients, so it runs without
 * STEMKit and without refitting, the figure a user sees in the browser is
 * regenerated exactly rather than approximately.
 *
 * A linearised fit carries a comment recording that fact, since a reader
 * running the script would otherwise have no way to know the coefficients did
 * not come from an ordinary least-squares fit in the original units.
 *
 * @param {{model:string, equation:number[], r2:number, points:Array<[number,number]>,
 *          linearised?:boolean}} fit - A result from `fitCurve`.
 * @returns {string} Python source, or guidance when no fit is available.
 */
export function generateMatplotlibCode(fit) {
  if (!fit || !fit.equation || !Array.isArray(fit.points)) {
    return '# Fit a model first, then request the Python code again.';
  }

  const expr = pythonModelExpression(fit.equation, fit.model);
  if (!expr) return `# Unsupported model: ${fit.model}`;

  const xs = fit.points.map(p => p[0]);
  const ys = fit.points.map(p => p[1]);
  const r2 = Number.isFinite(fit.r2) ? fit.r2.toFixed(4) : 'n/a';

  let c = 'import numpy as np\nimport matplotlib.pyplot as plt\n\n';
  c += '# --- Your data ---\n';
  c += `x = np.array([${xs.join(', ')}])\n`;
  c += `y = np.array([${ys.join(', ')}])\n\n`;
  c += `# --- Fitted ${fit.model} model (from STEMKit, R^2 = ${r2}) ---\n`;

  if (fit.linearised) {
    c += '# NOTE: this model was fitted by linearisation (least squares in log\n';
    c += '# space, y-weighted), not by non-linear least squares on the original\n';
    c += '# data. For a maximum-likelihood fit under additive Gaussian noise,\n';
    c += '# use scipy.optimize.curve_fit on the untransformed values.\n';
  }

  c += `def model(x):\n    return ${expr.body}\n\n`;
  c += 'xfit = np.linspace(x.min(), x.max(), 200)\n';
  c += 'yfit = model(xfit)\n\n';
  c += '# --- Plot ---\n';
  c += 'fig, ax = plt.subplots(figsize=(7, 5), dpi=150)\n';
  c += "ax.scatter(x, y, color='#94a3b8', s=40, label='Data', zorder=3)\n";
  c += `ax.plot(xfit, yfit, color='#10b981', lw=2.5, label='${expr.label}')\n`;
  c += "ax.set_xlabel('x')\nax.set_ylabel('y')\n";
  c += 'ax.legend(frameon=True)\n';
  c += "ax.spines['top'].set_visible(False)\nax.spines['right'].set_visible(False)\n";
  c += "fig.tight_layout()\nfig.savefig('fit.png', dpi=300, bbox_inches='tight')\nplt.show()\n";
  return c;
}
