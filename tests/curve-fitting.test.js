import { describe, test, expect } from '@jest/globals';
import '../tests/setup.js';
import {
  PARAM_COUNT, LINEARISED_MODELS,
  parseXYData, validateForModel,
  rSquared, rmse, adjustedRSquared, assessFitAdequacy,
  fitCurve, formatEquation, sampleCurve, residuals,
  pythonModelExpression, generateMatplotlibCode
} from '../src/core/curve-fitting.js';

/* Reference values from numpy.polyfit. */

const LINEAR = [[1, 2.1], [2, 4.2], [3, 5.9], [4, 8.1], [5, 9.8]];
const EXPONENTIAL = [[1, 2.0], [2, 4.1], [3, 8.2], [4, 16.1], [5, 32.3]];

describe('parseXYData', () => {
  test('parses whitespace-delimited pairs', () => {
    const r = parseXYData('1 2\n3 4\n5 6');
    expect(r.data).toEqual([[1, 2], [3, 4], [5, 6]]);
  });

  test('parses comma-delimited pairs', () => {
    expect(parseXYData('1,2\n3,4').data).toEqual([[1, 2], [3, 4]]);
  });

  test('sorts points by ascending x', () => {
    expect(parseXYData('5 1\n1 2\n3 3').data).toEqual([[1, 2], [3, 3], [5, 1]]);
  });

  test('selects the requested columns', () => {
    const r = parseXYData('0 10 100\n1 20 200', 0, 2);
    expect(r.data).toEqual([[0, 100], [1, 200]]);
  });

  test('counts and reports rows missing the requested columns', () => {
    const r = parseXYData('1 2 3\n4 5\n6 7 8', 0, 2);
    expect(r.missingColumns).toBe(1);
    expect(r.data).toHaveLength(2);
    expect(r.warnings[0]).toContain('missing requested columns');
  });

  test('counts and reports non-numeric rows such as headers', () => {
    const r = parseXYData('x y\n1 2\n3 4');
    expect(r.nonNumeric).toBe(1);
    expect(r.data).toEqual([[1, 2], [3, 4]]);
    expect(r.warnings.some(w => w.includes('text headers'))).toBe(true);
  });

  test('handles scientific notation and negatives', () => {
    expect(parseXYData('-1.5e2 2.5e-3').data).toEqual([[-150, 0.0025]]);
  });

  test('handles CRLF line endings', () => {
    expect(parseXYData('1 2\r\n3 4\r\n').data).toHaveLength(2);
  });

  test('returns empty results without warnings for blank input', () => {
    const r = parseXYData('');
    expect(r.data).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('rejects negative or non-integer column indices', () => {
    expect(parseXYData('1 2', -1, 0).data).toEqual([]);
    expect(parseXYData('1 2', 0, 1.5).data).toEqual([]);
  });

  test('handles non-string input without throwing', () => {
    expect(parseXYData(null).data).toEqual([]);
  });
});

describe('validateForModel', () => {
  test('accepts any finite data for linear and polynomial models', () => {
    const withNegatives = [[-1, -5], [0, 0], [1, 5]];
    expect(validateForModel(withNegatives, 'linear').valid).toBe(true);
    expect(validateForModel(withNegatives, 'polynomial2').valid).toBe(true);
    expect(validateForModel(withNegatives, 'polynomial3').valid).toBe(true);
  });

  test('rejects non-positive y for exponential models', () => {
    const r = validateForModel([[1, 1], [2, 0]], 'exponential');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('y > 0');
  });

  test('rejects non-positive x or y for power models', () => {
    expect(validateForModel([[0, 1], [2, 3]], 'power').valid).toBe(false);
    expect(validateForModel([[1, -1], [2, 3]], 'power').valid).toBe(false);
  });

  test('rejects non-positive x for logarithmic models', () => {
    expect(validateForModel([[0, 1], [2, 3]], 'logarithmic').valid).toBe(false);
  });

  test('rejects unknown models and empty data', () => {
    expect(validateForModel(LINEAR, 'quartic').valid).toBe(false);
    expect(validateForModel([], 'linear').valid).toBe(false);
  });
});

describe('goodness of fit', () => {
  const identity = (x) => x;

  test('R-squared is 1 for a perfect fit', () => {
    expect(rSquared([[1, 1], [2, 2], [3, 3]], identity)).toBeCloseTo(1, 12);
  });

  test('R-squared is 0 when the model only predicts the mean', () => {
    expect(rSquared([[1, 1], [2, 2], [3, 3]], () => 2)).toBeCloseTo(0, 12);
  });

  test('R-squared can go negative for a worse-than-mean model', () => {
    expect(rSquared([[1, 1], [2, 2], [3, 3]], () => 100)).toBeLessThan(0);
  });

  test('R-squared is 1 for a constant response fitted exactly', () => {
    expect(rSquared([[1, 5], [2, 5]], () => 5)).toBe(1);
  });

  test('R-squared is undefined for a constant response fitted badly', () => {
    expect(Number.isNaN(rSquared([[1, 5], [2, 5]], () => 9))).toBe(true);
  });

  test('RMSE is zero for a perfect fit', () => {
    expect(rmse([[1, 1], [2, 2]], identity)).toBeCloseTo(0, 12);
  });

  test('RMSE matches a hand calculation', () => {
    // Residuals of 1 and -1 give a root-mean-square of 1.
    expect(rmse([[1, 2], [2, 1]], identity)).toBeCloseTo(1, 12);
  });

  test('adjusted R-squared penalises extra parameters', () => {
    expect(adjustedRSquared(0.9, 10, 2)).toBeLessThan(0.9);
  });

  test('adjusted R-squared is undefined when n does not exceed k', () => {
    expect(Number.isNaN(adjustedRSquared(0.9, 2, 2))).toBe(true);
  });

  test('degenerate inputs give NaN rather than throwing', () => {
    expect(Number.isNaN(rSquared([], identity))).toBe(true);
    expect(Number.isNaN(rmse([], identity))).toBe(true);
  });
});

describe('assessFitAdequacy', () => {
  test('flags an under-determined fit as an error', () => {
    const a = assessFitAdequacy(2, 'polynomial3');
    expect(a.level).toBe('error');
    expect(a.message).toContain('Under-determined');
  });

  test('warns that an exact fit is not evidence of a good model', () => {
    const a = assessFitAdequacy(4, 'polynomial3');
    expect(a.level).toBe('warn');
    expect(a.exactFit).toBe(true);
  });

  test('warns when there is barely more data than parameters', () => {
    expect(assessFitAdequacy(3, 'linear').level).toBe('warn');
  });

  test('is satisfied with ample data', () => {
    const a = assessFitAdequacy(50, 'linear');
    expect(a.level).toBe('ok');
    expect(a.message).toBeNull();
  });

  test('reports the parameter count for each model', () => {
    expect(assessFitAdequacy(10, 'linear').nParams).toBe(2);
    expect(assessFitAdequacy(10, 'polynomial3').nParams).toBe(4);
  });
});

describe('fitCurve | linear', () => {
  test('slope and intercept match numpy polyfit', () => {
    const f = fitCurve(LINEAR, 'linear');
    expect(f.equation[0]).toBeCloseTo(1.93, 6);
    expect(f.equation[1]).toBeCloseTo(0.23, 6);
  });

  test('R-squared and RMSE match numpy', () => {
    const f = fitCurve(LINEAR, 'linear');
    expect(f.r2).toBeCloseTo(0.9984185697437546, 8);
    expect(f.rmse).toBeCloseTo(0.10862780491200198, 8);
  });

  test('recovers an exact relationship', () => {
    const f = fitCurve([[0, 0], [1, 2], [2, 4], [3, 6]], 'linear');
    expect(f.equation[0]).toBeCloseTo(2, 8);
    expect(f.r2).toBeCloseTo(1, 8);
    expect(f.rmse).toBeCloseTo(0, 8);
  });

  test('predict evaluates the fitted line', () => {
    const f = fitCurve([[0, 0], [1, 2], [2, 4]], 'linear');
    expect(f.predict(10)).toBeCloseTo(20, 6);
  });

  test('is not marked as linearised', () => {
    expect(fitCurve(LINEAR, 'linear').linearised).toBe(false);
  });
});

describe('fitCurve | other models', () => {
  test('polynomial2 coefficients match numpy polyfit', () => {
    const f = fitCurve(LINEAR, 'polynomial2');
    // regression.js returns coefficients in descending powers, as numpy does.
    expect(f.equation[0]).toBeCloseTo(-0.0214285714, 5);
    expect(f.equation[1]).toBeCloseTo(2.0585714286, 5);
    expect(f.equation[2]).toBeCloseTo(0.08, 5);
  });

  test('exponential recovers the growth rate of a doubling series', () => {
    const f = fitCurve(EXPONENTIAL, 'exponential');
    // regression.js weights the log-space fit by y, so the estimate differs
    // slightly from an unweighted log-OLS (which would give ln 2 = 0.69315).
    expect(f.equation[1]).toBeCloseTo(0.6902163057, 6);
    expect(f.equation[1]).toBeCloseTo(Math.LN2, 2);
  });

  test('exponential and power are flagged as linearised, logarithmic is not', () => {
    expect(fitCurve(EXPONENTIAL, 'exponential').linearised).toBe(true);
    expect(fitCurve([[1, 1], [2, 4], [3, 9]], 'power').linearised).toBe(true);
    // Not logarithmic: `y = a + b ln x` is linear in its parameters, so
    // regressing y on ln x is ordinary least squares on the untransformed y.
    // Only x is transformed, and transforming x introduces no bias in y.
    expect(fitCurve([[1, 0], [2, 0.7], [3, 1.1]], 'logarithmic').linearised).toBe(false);
  });

  test('power recovers a quadratic exponent', () => {
    const f = fitCurve([[1, 1], [2, 4], [3, 9], [4, 16]], 'power');
    expect(f.equation[1]).toBeCloseTo(2, 4);
  });

  test('polynomial3 fits a cubic essentially exactly', () => {
    const cubic = [[-2, -8], [-1, -1], [0, 0], [1, 1], [2, 8], [3, 27]];
    expect(fitCurve(cubic, 'polynomial3').r2).toBeCloseTo(1, 6);
  });

  test('a higher-order polynomial never fits worse than a lower one', () => {
    const p2 = fitCurve(LINEAR, 'polynomial2').r2;
    const p3 = fitCurve(LINEAR, 'polynomial3').r2;
    expect(p3).toBeGreaterThanOrEqual(p2 - 1e-9);
  });
});

describe('fitCurve | error handling', () => {
  test('reports a domain violation rather than throwing', () => {
    const f = fitCurve([[1, 1], [2, -5]], 'exponential');
    expect(f.error).toContain('y > 0');
  });

  test('requires at least two points', () => {
    expect(fitCurve([[1, 1]], 'linear').error).toContain('at least 2');
  });

  test('rejects an unknown model', () => {
    expect(fitCurve(LINEAR, 'sigmoid').error).toContain('Unknown model');
  });

  test('carries adequacy information alongside a successful fit', () => {
    expect(fitCurve(LINEAR, 'linear').adequacy.level).toBe('ok');
    expect(fitCurve([[1, 1], [2, 2]], 'linear').adequacy.exactFit).toBe(true);
  });
});

describe('formatEquation', () => {
  test('renders each model family', () => {
    expect(formatEquation([2, 3], 'linear')).toBe('y = 2x + 3');
    expect(formatEquation([2, 3], 'exponential')).toBe('y = 2 * e^(3x)');
    expect(formatEquation([2, 3], 'power')).toBe('y = 2 * x^(3)');
    expect(formatEquation([2, 3], 'logarithmic')).toBe('y = 2 + 3 * ln(x)');
  });

  test('renders a negative coefficient as subtraction', () => {
    expect(formatEquation([2, -3], 'linear')).toBe('y = 2x - 3');
  });

  test('renders polynomials with descending powers', () => {
    expect(formatEquation([1, 2, 3], 'polynomial2')).toBe('y = 1x^2 + 2x + 3');
    expect(formatEquation([1, 2, 3, 4], 'polynomial3')).toBe('y = 1x^3 + 2x^2 + 3x + 4');
  });

  test('returns an empty string for unknown or invalid input', () => {
    expect(formatEquation([1, 2], 'mystery')).toBe('');
    expect(formatEquation(null, 'linear')).toBe('');
  });
});

describe('sampleCurve', () => {
  const double = (x) => 2 * x;

  test('produces the requested number of samples', () => {
    const s = sampleCurve(double, 0, 10, 11);
    expect(s.x).toHaveLength(11);
    expect(s.y).toHaveLength(11);
  });

  test('spans the requested range inclusively', () => {
    const s = sampleCurve(double, 0, 10, 11);
    expect(s.x[0]).toBeCloseTo(0, 12);
    expect(s.x[10]).toBeCloseTo(10, 12);
    expect(s.y[10]).toBeCloseTo(20, 12);
  });

  test('omits samples where the prediction is not finite', () => {
    const s = sampleCurve((x) => (x < 5 ? NaN : x), 0, 10, 11);
    expect(s.x.length).toBeLessThan(11);
    expect(s.y.every(Number.isFinite)).toBe(true);
  });

  test('returns empty arrays for a degenerate request', () => {
    expect(sampleCurve(double, 0, 10, 1).x).toEqual([]);
    expect(sampleCurve(double, NaN, 10, 5).x).toEqual([]);
  });
});

describe('residuals', () => {
  test('computes observed minus predicted', () => {
    const r = residuals([[1, 3], [2, 5]], (x) => x);
    expect(r[0].residual).toBeCloseTo(2, 12);
    expect(r[1].residual).toBeCloseTo(3, 12);
  });

  test('carries the observed and predicted values through', () => {
    const r = residuals([[1, 3]], (x) => x * 2);
    expect(r[0].observed).toBe(3);
    expect(r[0].predicted).toBe(2);
  });

  test('residuals of a perfect fit are zero', () => {
    const r = residuals([[1, 1], [2, 2]], (x) => x);
    expect(r.every(e => Math.abs(e.residual) < 1e-12)).toBe(true);
  });

  test('returns an empty array for non-array input', () => {
    expect(residuals(null, (x) => x)).toEqual([]);
  });
});

describe('exported constants', () => {
  test('parameter counts are defined for every supported model', () => {
    expect(PARAM_COUNT.linear).toBe(2);
    expect(PARAM_COUNT.polynomial2).toBe(3);
    expect(PARAM_COUNT.polynomial3).toBe(4);
  });

  test('the linearised list covers exactly the models that transform y', () => {
    expect(LINEARISED_MODELS).toContain('exponential');
    expect(LINEARISED_MODELS).toContain('power');
    expect(LINEARISED_MODELS).not.toContain('logarithmic');
    expect(LINEARISED_MODELS).not.toContain('linear');
  });
});

describe('pythonModelExpression', () => {
  test('renders each model as a Python expression in x', () => {
    expect(pythonModelExpression([2, 1], 'linear').body).toBe('2 * x + 1');
    expect(pythonModelExpression([2, 1], 'exponential').body).toContain('np.exp');
    expect(pythonModelExpression([2, 1], 'power').body).toContain('np.power');
    expect(pythonModelExpression([2, 1], 'logarithmic').body).toContain('np.log');
  });

  test('renders polynomials with descending powers', () => {
    expect(pythonModelExpression([1, 2, 3], 'polynomial2').body)
      .toBe('1*x**2 + 2*x + 3');
    expect(pythonModelExpression([1, 2, 3, 4], 'polynomial3').body)
      .toBe('1*x**3 + 2*x**2 + 3*x + 4');
  });

  test('supplies a human-readable label', () => {
    expect(pythonModelExpression([2, 1], 'linear').label).toContain('y =');
  });

  test('returns null for unknown or invalid input', () => {
    expect(pythonModelExpression([1, 2], 'sigmoid')).toBeNull();
    expect(pythonModelExpression(null, 'linear')).toBeNull();
  });
});

describe('generateMatplotlibCode', () => {
  const fit = fitCurve(LINEAR, 'linear');

  test('emits a self-contained runnable script', () => {
    const code = generateMatplotlibCode(fit);
    expect(code).toContain('import numpy as np');
    expect(code).toContain('import matplotlib.pyplot as plt');
    expect(code).toContain('plt.show()');
  });

  test('embeds the data so the script needs no external file', () => {
    const code = generateMatplotlibCode(fit);
    expect(code).toContain('x = np.array([1, 2, 3, 4, 5])');
    expect(code).toContain('y = np.array([2.1, 4.2, 5.9, 8.1, 9.8])');
  });

  test('embeds the fitted coefficients rather than refitting', () => {
    const code = generateMatplotlibCode(fit);
    expect(code).toContain('def model(x):');
    expect(code).not.toContain('polyfit');
  });

  test('records the R-squared in a comment', () => {
    expect(generateMatplotlibCode(fit)).toContain('R^2 = 0.9984');
  });

  test('warns in the script when the fit was linearised', () => {
    const expFit = fitCurve(EXPONENTIAL, 'exponential');
    const code = generateMatplotlibCode(expFit);
    expect(code).toContain('linearisation');
    expect(code).toContain('curve_fit');
  });

  test('omits that warning for a directly fitted model', () => {
    expect(generateMatplotlibCode(fit)).not.toContain('linearisation');
  });

  test('returns guidance when no fit is supplied', () => {
    expect(generateMatplotlibCode(null).startsWith('#')).toBe(true);
    expect(generateMatplotlibCode({}).startsWith('#')).toBe(true);
  });

  test('reports an unsupported model rather than emitting broken code', () => {
    const code = generateMatplotlibCode({
      model: 'sigmoid', equation: [1, 2], r2: 0.9, points: [[1, 1]]
    });
    expect(code).toContain('Unsupported model');
  });
});

/*
 * Which models are actually solved on transformed data.
 *
 * `y = a + b ln x` is linear in its parameters, so regressing y on ln x is
 * ordinary least squares on the untransformed y. Listing it as linearised put
 * an inaccurate note on the fit summary and in the exported Python, so the
 * distinction is pinned here.
 */
describe('linearised models', () => {
  test('exponential and power transform y; logarithmic does not', () => {
    expect(LINEARISED_MODELS).toContain('exponential');
    expect(LINEARISED_MODELS).toContain('power');
    expect(LINEARISED_MODELS).not.toContain('logarithmic');
    expect(LINEARISED_MODELS).not.toContain('linear');
    expect(LINEARISED_MODELS).not.toContain('polynomial2');
  });

  test('a logarithmic fit is not flagged as linearised', () => {
    const data = [[1, 0.2], [2, 1.9], [3, 2.6], [4, 3.4], [5, 3.6], [6, 4.4]];
    const fit = fitCurve(data, 'logarithmic');
    expect(fit.error).toBeNull();
    expect(fit.linearised).toBe(false);
  });

  test('an exponential fit is flagged as linearised', () => {
    const data = [[1, 2.1], [2, 4.2], [3, 7.9], [4, 16.5], [5, 33]];
    const fit = fitCurve(data, 'exponential');
    expect(fit.error).toBeNull();
    expect(fit.linearised).toBe(true);
  });

  test('a logarithmic fit minimises squared residuals in y', () => {
    const data = [[1, 0.2], [2, 1.9], [3, 2.6], [4, 3.4], [5, 3.6], [6, 4.4]];
    const fit = fitCurve(data, 'logarithmic');
    const sse = f => data.reduce((s, [x, y]) => s + (y - f(x)) ** 2, 0);
    const base = sse(fit.predict);
    // No nearby parameter pair does better, which is what ordinary least
    // squares guarantees and a transformed fit does not.
    const [a, b] = fit.equation;
    let best = base;
    for (let da = -0.2; da <= 0.2; da += 0.01) {
      for (let db = -0.2; db <= 0.2; db += 0.01) {
        best = Math.min(best, sse(x => (a + da) + (b + db) * Math.log(x)));
      }
    }
    expect(best).toBeGreaterThanOrEqual(base * 0.999);
  });

  test('a point that cannot be transformed is rejected, not dropped', () => {
    const withZero = [[1, 2], [2, 0], [3, 8]];
    const fit = fitCurve(withZero, 'exponential');
    expect(fit.error).toMatch(/y > 0/);
    expect(fit.n).toBeUndefined();
  });
});
