import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalQuantile, studentTCdf, studentTQuantile, fitModel } from '../src/core/nonlinear-fit.js';
import { bandVisibility, defaultPlotStyle } from '../src/core/plot-style.js';

/* ------------------------------------------------------------------ *
 * Synthetic data
 * ------------------------------------------------------------------ */

/* A seeded generator, so every run fits the same noisy data. */
function uniform(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Standard normal deviates by Box–Muller. */
function normal(seed) {
  const u = uniform(seed);
  return () => {
    let a = 0;
    while (a === 0) a = u();
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u());
  };
}

const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const R_GAS = 8.314462618;

/*
 * The data sets, shared by the recovery tests and the scipy comparison. Each
 * holds the spec for fitModel, the true parameter values, and the model in
 * Python for curve_fit (free parameters only; a fixed one is written in).
 */
function makeCases() {
  const cases = {};

  {
    const g = normal(1);
    const t = linspace(0, 10, 60);
    cases.decay = {
      spec: { expression: 'y = A*exp(-t/tau) + y0', columns: { t }, y: t.map(v => 5 * Math.exp(-v / 2.5) + 1 + 0.05 * g()) },
      truth: { A: 5, tau: 2.5, y0: 1 },
      python: 'lambda X, A, tau, y0: A*np.exp(-X[0]/tau) + y0',
      band: { t: [0, 1.3, 5, 9.7] }
    };
  }
  {
    const g = normal(2);
    const T = linspace(280, 400, 30);
    cases.arrhenius = {
      spec: {
        expression: 'k = A*exp(-Ea/(R*T))',
        independent: ['T'],
        parameters: [{ name: 'A' }, { name: 'Ea' }, { name: 'R', initial: R_GAS, fixed: true }],
        columns: { T },
        y: T.map(v => 1e7 * Math.exp(-5e4 / (R_GAS * v)) * (1 + 0.01 * g()))
      },
      truth: { A: 1e7, Ea: 5e4, R: R_GAS },
      python: `lambda X, A, Ea: A*np.exp(-Ea/(${R_GAS}*X[0]))`,
      band: { T: [285, 330, 395] }
    };
  }
  {
    const g = normal(3);
    const x = linspace(-3, 5, 80);
    cases.gaussian = {
      spec: {
        expression: 'y = A*exp(-(x - mu)^2/(2*s^2)) + c',
        columns: { x },
        y: x.map(v => 3 * Math.exp(-((v - 1.2) ** 2) / (2 * 0.7 ** 2)) + 0.5 + 0.03 * g())
      },
      truth: { A: 3, mu: 1.2, s: 0.7, c: 0.5 },
      python: 'lambda X, A, mu, s, c: A*np.exp(-(X[0] - mu)**2/(2*s**2)) + c',
      band: { x: [-2, 0.9, 1.2, 4] }
    };
  }
  {
    const g = normal(4);
    const x = linspace(0, 10, 50);
    cases.logistic = {
      spec: {
        expression: 'y = L/(1 + exp(-k*(x - x0)))',
        columns: { x },
        y: x.map(v => 10 / (1 + Math.exp(-1.5 * (v - 4))) + 0.1 * g())
      },
      truth: { L: 10, k: 1.5, x0: 4 },
      python: 'lambda X, L, k, x0: L/(1 + np.exp(-k*(X[0] - x0)))',
      band: { x: [1, 4, 8] }
    };
  }
  {
    const g = normal(5);
    const x = linspace(0.5, 20, 40);
    cases.power = {
      spec: { expression: 'y = a*x^b', columns: { x }, y: x.map(v => 2 * v ** 1.7 * (1 + 0.02 * g())) },
      truth: { a: 2, b: 1.7 },
      python: 'lambda X, a, b: a*X[0]**b',
      band: { x: [1, 10, 19] }
    };
  }
  {
    const g = normal(6);
    const x = [];
    const y = [];
    const z = [];
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        x.push(i);
        y.push(0.5 * j);
        z.push(1.5 * i - 2 * 0.5 * j + 3 + 0.05 * g());
      }
    }
    cases.plane = {
      spec: { expression: 'z = a*x + b*y + c', independent: ['x', 'y'], columns: { x, y }, y: z },
      truth: { a: 1.5, b: -2, c: 3 },
      python: 'lambda X, a, b, c: a*X[0] + b*X[1] + c',
      band: { x: [0, 3.5, 7], y: [0, 1.7, 3.5] }
    };
  }
  {
    // Noise that grows with x, and sigma that says so.
    const g = normal(7);
    const x = linspace(1, 10, 30);
    const sigma = x.map(v => 0.02 * v);
    const y = x.map((v, i) => 3 * Math.exp(-0.3 * v) + sigma[i] * g());
    cases.weighted = {
      spec: { expression: 'y = A*exp(-k*x)', columns: { x }, y, sigma },
      truth: { A: 3, k: 0.3 },
      python: 'lambda X, A, k: A*np.exp(-k*X[0])',
      band: { x: [1, 5, 10] }
    };
    cases.absoluteSigma = {
      spec: { ...cases.weighted.spec, absoluteSigma: true },
      truth: cases.weighted.truth,
      python: cases.weighted.python,
      band: cases.weighted.band
    };
  }
  {
    // The damped oscillation that once came back with tau → 0 and R² = 0.18.
    const { spec, truth } = ringdown(2, 60, 0.03, 14);
    cases.ringdown = {
      spec, truth,
      python: 'lambda X, A, tau, P, phi, y0: A*np.exp(-X[0]/tau)*np.cos(2*np.pi*X[0]/P + phi) + y0',
      band: { x: [0.5, 3, 7.7, 11] }
    };
  }
  {
    const g = normal(15);
    const t = linspace(0, 20, 120);
    cases.trendWave = {
      spec: { expression: 'y = A*sin(2*pi*t/T) + m*t + c', columns: { t }, y: t.map(v => 1.2 * Math.sin((2 * Math.PI * v) / 3.3) + 0.4 * v - 1 + 0.05 * g()) },
      truth: { A: 1.2, T: 3.3, m: 0.4, c: -1 },
      python: 'lambda X, A, T, m, c: A*np.sin(2*np.pi*X[0]/T) + m*X[0] + c',
      band: { t: [1, 10, 19] }
    };
  }
  return cases;
}

/* y = 2 e^(-x/4) cos(2πx/P + 0.3) + 0.1 on [0, 12]: a ringdown, typed the way people type it. */
function ringdown(P, n, noise, seed) {
  const g = normal(seed);
  const x = linspace(0, 12, n);
  return {
    spec: {
      expression: 'y = A*exp(-x/tau)*cos(2*pi*x/P + phi) + y0', columns: { x },
      y: x.map(v => 2 * Math.exp(-v / 4) * Math.cos((2 * Math.PI * v) / P + 0.3) + 0.1 + noise * g())
    },
    truth: { A: 2, tau: 4, P, phi: 0.3, y0: 0.1 }
  };
}

const CASES = makeCases();

/* Relative difference, measured against the larger of the two. */
const rel = (a, b) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));

/* ------------------------------------------------------------------ *
 * Speed
 * ------------------------------------------------------------------ */

// Timed in a plain Node process: Jest's module sandbox runs this code about
// ten times slower than a browser or Node does, and more so when the other
// suites run alongside, so a time measured here says little about the engine.
function timeInNode(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'stemkit-speed-'));
  try {
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
    const module = new URL('../src/core/nonlinear-fit.js', import.meta.url).href;
    const script = `
      import { readFileSync } from 'node:fs';
      import { fitModel } from ${JSON.stringify(module)};
      const spec = JSON.parse(readFileSync(process.argv[1], 'utf8'));
      const t0 = performance.now();
      const fit = fitModel(spec);
      console.log(JSON.stringify({ ms: performance.now() - t0, iterations: fit.iterations }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, join(dir, 'spec.json')],
      { encoding: 'utf8', timeout: 60000 });
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Shared CI runners are slower and busier than a desktop; the bound still
// catches a fit that has become several times slower.
const SPEED_BOUND_MS = process.env.CI ? 5000 : 2000;

describe('fitModel speed', () => {
  test('10 000 points and 5 parameters', () => {
    const g = normal(12);
    const x = linspace(-5, 10, 10000);
    const y = x.map(v => 3 * Math.exp(-((v - 2) ** 2) / (2 * 0.8 ** 2)) + 0.5 + 0.1 * v + 0.05 * g());
    const spec = { expression: 'y = A*exp(-(x - mu)^2/(2*s^2)) + b0 + b1*x', columns: { x }, y };
    expectRecovered(fitModel(spec), { A: 3, mu: 2, s: 0.8, b0: 0.5, b1: 0.1 });

    const { ms, iterations } = timeInNode(spec);
    console.log(`10 000 points, 5 parameters: ${ms.toFixed(0)} ms, ${iterations} iterations`);
    // About 0.2 s on a desktop; the target is 1 s, and the bound leaves room for a busy machine.
    expect(ms).toBeLessThan(SPEED_BOUND_MS);
  });

  test('10 000 points of a damped oscillation, 5 parameters', () => {
    // The periodogram and the search from its peaks, on top of the fit itself.
    const g = normal(16);
    const x = linspace(0, 100, 10000);
    const y = x.map(v => 3 * Math.exp(-v / 60) * Math.cos((2 * Math.PI * v) / 7 + 0.3) + 0.5 + 0.1 * g());
    const spec = { expression: 'y = A*exp(-x/tau)*cos(2*pi*x/P + phi) + y0', columns: { x }, y };
    expectRecovered(fitModel(spec), { A: 3, tau: 60, P: 7, phi: 0.3, y0: 0.5 });

    const { ms, iterations } = timeInNode(spec);
    console.log(`10 000 points, damped oscillation: ${ms.toFixed(0)} ms, ${iterations} iterations`);
    // About 0.1 s on a desktop.
    expect(ms).toBeLessThan(SPEED_BOUND_MS);
  });
});

/* ------------------------------------------------------------------ *
 * Distributions
 * ------------------------------------------------------------------ */

describe('Student t and the normal quantile', () => {
  /*
   * Reference values, computed once and pasted in:
   *   python3 -c "from scipy import stats
   *   for d in [1, 2, 5, 30, 1000]: print(d, [repr(stats.t.ppf(p, d)) for p in (0.975, 0.995, 0.9)])"
   * (scipy 1.11), and the same quantiles to 40 digits with mpmath, by findroot
   * on 1 - betainc(d/2, 1/2, 0, d/(d + t^2), regularized=True)/2.
   */
  const P = [0.975, 0.995, 0.9];
  const SCIPY_PPF = {
    1: [12.706204736432095, 63.65674116287399, 3.0776835372078066],
    2: [4.302652729911275, 9.92484320091807, 1.8856180831641507],
    5: [2.5705818366147395, 4.032142983557536, 1.4758840487820273],
    30: [2.0422724563012373, 2.7499956535670305, 1.3104150225671307],
    1000: [1.9623390808264074, 2.580754698065942, 1.2823987214609247]
  };
  const MPMATH_PPF = {
    1: [12.706204736174693, 63.656741162871524, 3.0776835371752541],
    2: [4.3026527297494618, 9.9248432009182886, 1.885618083164127],
    5: [2.5705818356363148, 4.0321429835552272, 1.4758840488244813],
    30: [2.0422724563012379, 2.749995653567225, 1.3104150253913957],
    1000: [1.9623390808264081, 2.5807546980659508, 1.2823987214609246]
  };
  /* stats.t.cdf(t, dof) for these (dof, t), scipy 1.11; mpmath agrees to 1e-16. */
  const SCIPY_CDF = [
    [1, 0.5, 0.6475836176504333], [1, -3, 0.10241638234956672], [2, 2.5, 0.9351941398892446],
    [5, -1.2, 0.14194552835305113], [5, 4, 0.9948382922595843], [30, 2.042, 0.9749856646719011],
    [1000, 1.96, 0.9748634075221256], [3.5, 0.7, 0.7361829288271604], [10, -8, 5.887471394833078e-06]
  ];

  test.each(Object.keys(SCIPY_PPF))('quantiles at %s degrees of freedom match scipy.stats.t.ppf', dof => {
    P.forEach((p, i) => {
      const t = studentTQuantile(p, Number(dof));
      // scipy (Boost) is itself off by up to 2e-9 here, as the 40-digit values show.
      expect(rel(t, SCIPY_PPF[dof][i])).toBeLessThan(1e-8);
      expect(rel(t, MPMATH_PPF[dof][i])).toBeLessThan(1e-13);
      expect(rel(studentTQuantile(1 - p, Number(dof)), -MPMATH_PPF[dof][i])).toBeLessThan(1e-13);
    });
  });

  test('the cdf matches scipy.stats.t.cdf and inverts the quantile', () => {
    for (const [dof, t, want] of SCIPY_CDF) expect(rel(studentTCdf(t, dof), want)).toBeLessThan(1e-13);
    for (const dof of [1, 2, 3, 7.5, 30, 1000, 1e5]) {
      for (const p of [1e-6, 0.025, 0.3, 0.9, 0.995]) {
        expect(rel(studentTCdf(studentTQuantile(p, dof), dof), p)).toBeLessThan(1e-11);
      }
    }
  });

  test('large and infinite degrees of freedom approach the normal distribution', () => {
    // mpmath, 50 digits: the 0.975 quantile at 1e6 degrees of freedom.
    expect(rel(studentTQuantile(0.975, 1e6), 1.959966356814107)).toBeLessThan(1e-14);
    expect(rel(studentTQuantile(0.975, Infinity), 1.959963984540054)).toBeLessThan(1e-15);
    expect(rel(normalQuantile(0.975), 1.959963984540054)).toBeLessThan(1e-15);
    expect(rel(normalQuantile(1e-10), -6.361340902404056)).toBeLessThan(1e-14);
    expect(studentTCdf(1.96, Infinity)).toBeCloseTo(0.9750021048517795, 15);
  });

  test('invalid input gives NaN, the ends give infinities', () => {
    expect(studentTQuantile(0, 5)).toBeNaN();
    expect(studentTQuantile(1.2, 5)).toBeNaN();
    expect(studentTQuantile(0.9, 0)).toBeNaN();
    expect(studentTQuantile(0.9, NaN)).toBeNaN();
    expect(studentTQuantile(0.5, 3)).toBe(0);
    expect(studentTCdf(NaN, 3)).toBeNaN();
    expect(studentTCdf(1, -1)).toBeNaN();
    expect(studentTCdf(Infinity, 3)).toBe(1);
    expect(studentTCdf(-Infinity, 3)).toBe(0);
    expect(studentTCdf(0, 3)).toBe(0.5);
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
    expect(normalQuantile(-1)).toBeNaN();
  });
});

/* ------------------------------------------------------------------ *
 * Recovering known parameters
 * ------------------------------------------------------------------ */

/* Each fitted value within four standard errors of the truth, and the fit sound. */
function expectRecovered(fit, truth) {
  expect(fit.ok).toBe(true);
  expect(fit.converged).toBe(true);
  for (const p of fit.parameters) {
    expect(Number.isFinite(p.value)).toBe(true);
    if (p.fixed) {
      expect(p.value).toBe(truth[p.name]);
      continue;
    }
    expect(p.stderr).toBeGreaterThan(0);
    expect(Number.isFinite(p.stderr)).toBe(true);
    if (Math.abs(p.value - truth[p.name]) > 4 * p.stderr) {
      throw new Error(`${p.name} = ${p.value} ± ${p.stderr}, truth ${truth[p.name]}`);
    }
  }
}

describe('fitModel recovers known parameters, with no starting values given', () => {
  test.each(['decay', 'arrhenius', 'gaussian', 'logistic', 'power', 'plane'])('%s', name => {
    const { spec, truth } = CASES[name];
    const fit = fitModel(spec);
    expectRecovered(fit, truth);
    expect(fit.r2).toBeGreaterThan(0.99);
    expect(fit.warnings.filter(w => /bound|told apart|undefined/.test(w))).toEqual([]);
  });

  test('the result has the documented shape and its numbers agree with each other', () => {
    const { spec } = CASES.decay;
    const fit = fitModel(spec);
    const n = spec.y.length;
    expect(fit).toMatchObject({ ok: true, n, dof: n - 3, free: ['A', 'tau', 'y0'] });
    expect(fit.parameters.map(p => p.name)).toEqual(['A', 'tau', 'y0']);
    expect(fit.message).toMatch(/^Converged after \d+ iterations?\.$/);

    const t975 = studentTQuantile(0.975, fit.dof);
    fit.parameters.forEach((p, k) => {
      expect(p).toMatchObject({ fixed: false, atBound: false });
      expect(p.ci[0]).toBeCloseTo(p.value - t975 * p.stderr, 12);
      expect(p.ci[1]).toBeCloseTo(p.value + t975 * p.stderr, 12);
      expect(p.stderr).toBeCloseTo(Math.sqrt(fit.covariance[k][k]), 15);
      expect(fit.correlation[k][k]).toBe(1);
    });
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(fit.covariance[i][j]).toBeCloseTo(fit.covariance[j][i], 15);
        expect(fit.correlation[i][j]).toBeCloseTo(fit.covariance[i][j] /
          Math.sqrt(fit.covariance[i][i] * fit.covariance[j][j]), 12);
      }
    }

    let rss = 0;
    let mean = 0;
    spec.y.forEach(v => { mean += v / n; });
    let tss = 0;
    spec.y.forEach((v, i) => {
      expect(fit.predicted[i] + fit.residuals[i]).toBeCloseTo(v, 12);
      rss += fit.residuals[i] ** 2;
      tss += (v - mean) ** 2;
    });
    expect(rel(fit.rss, rss)).toBeLessThan(1e-12);
    expect(rel(fit.chi2, rss)).toBeLessThan(1e-12);
    expect(rel(fit.reducedChi2, rss / (n - 3))).toBeLessThan(1e-12);
    expect(rel(fit.rmse, Math.sqrt(rss / n))).toBeLessThan(1e-12);
    expect(rel(fit.r2, 1 - rss / tss)).toBeLessThan(1e-12);
    expect(rel(fit.adjR2, 1 - ((1 - fit.r2) * (n - 1)) / (n - 3))).toBeLessThan(1e-12);
    expect(rel(fit.aic, n * Math.log(rss / n) + 6)).toBeLessThan(1e-12);
    expect(rel(fit.bic, n * Math.log(rss / n) + 3 * Math.log(n))).toBeLessThan(1e-12);

    const [A, tau, y0] = fit.parameters.map(p => p.value);
    expect(fit.predict({ t: 2 })).toBeCloseTo(A * Math.exp(-2 / tau) + y0, 12);
    expect(fit.predict(2)).toBeCloseTo(A * Math.exp(-2 / tau) + y0, 12);

    const { lower, upper } = fit.band([{ t: 0 }, { t: 3 }, 8]);
    expect(lower).toHaveLength(3);
    for (let i = 0; i < 3; i++) expect(upper[i]).toBeGreaterThan(lower[i]);
    // At t = 0 the curve is A + y0, so the band is t * sqrt(var A + var y0 + 2 cov).
    const c = fit.covariance;
    expect((upper[0] - lower[0]) / 2).toBeCloseTo(t975 * Math.sqrt(c[0][0] + c[2][2] + 2 * c[0][2]), 12);
    const wide = fit.band([{ t: 3 }], 0.99);
    expect(wide.upper[0] - wide.lower[0]).toBeGreaterThan(upper[1] - lower[1]);
  });

  test('a fixed parameter keeps its value, with no uncertainty, and is left out of the covariance', () => {
    const fit = fitModel(CASES.arrhenius.spec);
    const R = fit.parameters.find(p => p.name === 'R');
    expect(R).toMatchObject({ value: R_GAS, stderr: 0, ci: [R_GAS, R_GAS], fixed: true, atBound: false });
    expect(fit.free).toEqual(['A', 'Ea']);
    expect(fit.covariance).toHaveLength(2);
    expect(fit.dof).toBe(30 - 2);
    // A and Ea are famously correlated; the page is told so.
    expect(fit.warnings.join(' ')).toMatch(/'A' and 'Ea' are strongly correlated/);
  });

  test('a weighted fit uses sigma, and its R² is weighted', () => {
    const { spec, truth } = CASES.weighted;
    const fit = fitModel(spec);
    expectRecovered(fit, truth);
    expect(fit.weighted).toBe(true);
    const plain = fitModel({ ...spec, sigma: undefined });
    expect(plain.parameters[1].value).not.toBeCloseTo(fit.parameters[1].value, 6);

    let chi2 = 0;
    let sw = 0;
    let swy = 0;
    spec.y.forEach((v, i) => {
      const w = 1 / spec.sigma[i] ** 2;
      chi2 += w * fit.residuals[i] ** 2;
      sw += w;
      swy += w * v;
    });
    let tss = 0;
    spec.y.forEach((v, i) => { tss += (v - swy / sw) ** 2 / spec.sigma[i] ** 2; });
    expect(rel(fit.chi2, chi2)).toBeLessThan(1e-12);
    expect(rel(fit.r2, 1 - chi2 / tss)).toBeLessThan(1e-12);
    // The sigma were the true noise, so the reduced chi-square is near 1.
    expect(fit.reducedChi2).toBeGreaterThan(0.5);
    expect(fit.reducedChi2).toBeLessThan(1.6);

    // absoluteSigma takes sigma at face value: the covariance is not rescaled.
    const absolute = fitModel({ ...spec, absoluteSigma: true });
    absolute.parameters.forEach((p, k) => {
      expect(p.value).toBe(fit.parameters[k].value);
      expect(rel(p.stderr, fit.parameters[k].stderr / Math.sqrt(fit.reducedChi2))).toBeLessThan(1e-12);
    });
  });

  test('a parameter held at an active bound is reported, with a warning', () => {
    const g = normal(8);
    const x = linspace(0, 5, 20);
    const y = x.map(v => 2 * v - 0.5 + 0.05 * g());
    const fit = fitModel({ expression: 'y = a*x + b', columns: { x }, y, parameters: [{ name: 'a' }, { name: 'b', min: 0 }] });
    expect(fit.ok).toBe(true);
    const [a, b] = fit.parameters;
    expect(b).toMatchObject({ value: 0, atBound: true, bound: 'lower' });
    expect(a.atBound).toBe(false);
    // With b pinned at 0 the slope is the best line through the origin.
    const sxy = x.reduce((s, v, i) => s + v * y[i], 0);
    const sxx = x.reduce((s, v) => s + v * v, 0);
    expect(a.value).toBeCloseTo(sxy / sxx, 8);
    expect(fit.warnings).toContain("'b' finished at its lower bound (0). The best fit may lie beyond it, and its uncertainty is not reliable.");

    const upper = fitModel({ expression: 'y = a*x + b', columns: { x }, y, parameters: [{ name: 'a', max: 1.5 }, { name: 'b' }] });
    expect(upper.parameters[0]).toMatchObject({ value: 1.5, atBound: true, bound: 'upper' });
    expect(upper.warnings.some(w => w.startsWith("'a' finished at its upper bound"))).toBe(true);
  });

  test('bounds that are not active change nothing', () => {
    const { spec } = CASES.decay;
    const free = fitModel(spec);
    const boxed = fitModel({ ...spec, parameters: [{ name: 'A', min: 0, max: 100 }, { name: 'tau', min: 0.01 }, { name: 'y0', max: 50 }] });
    boxed.parameters.forEach((p, k) => {
      expect(p.atBound).toBe(false);
      expect(rel(p.value, free.parameters[k].value)).toBeLessThan(1e-8);
    });
  });

  test('starting values are guessed across scales and for peaks away from the middle', () => {
    const g = normal(9);
    let t = linspace(0, 1000, 80);
    expectRecovered(fitModel({
      expression: 'y = A*exp(-t/tau) + y0', columns: { t },
      y: t.map(v => 2e-3 * Math.exp(-v / 250) + 5e-4 + 2e-5 * g())
    }), { A: 2e-3, tau: 250, y0: 5e-4 });
    t = linspace(0, 1e-6, 80);
    expectRecovered(fitModel({
      expression: 'y = A*exp(-t/tau) + y0', columns: { t },
      y: t.map(v => -300 * Math.exp(-v / 2e-7) + 40 + g())
    }), { A: -300, tau: 2e-7, y0: 40 });
    const x = linspace(500, 700, 200);
    expectRecovered(fitModel({
      expression: 'y = A*exp(-(x - mu)^2/(2*s^2)) + c', columns: { x },
      y: x.map(v => -0.3 * Math.exp(-((v - 612) ** 2) / (2 * 9 ** 2)) + 1 + 0.005 * g())
    }), { A: -0.3, mu: 612, s: 9, c: 1 });
    const narrow = linspace(0, 100, 400);
    expectRecovered(fitModel({
      expression: 'y = A*exp(-(x - mu)^2/(2*s^2)) + c', columns: { x: narrow },
      y: narrow.map(v => 7 * Math.exp(-((v - 37) ** 2) / (2 * 0.5 ** 2)) + 2 + 0.1 * g())
    }), { A: 7, mu: 37, s: 0.5, c: 2 });
  });

  test('the typed starting values are used when they are good', () => {
    const { spec, truth } = CASES.decay;
    const fit = fitModel({ ...spec, parameters: [{ name: 'A', initial: 4 }, { name: 'tau', initial: 3 }, { name: 'y0', initial: 0 }] });
    expectRecovered(fit, truth);
    expect(rel(fit.parameters[1].value, fitModel(spec).parameters[1].value)).toBeLessThan(1e-8);
  });

  test('a width that enters only squared comes out positive; a negative amplitude stays negative', () => {
    const { spec, truth } = CASES.gaussian;
    const fit = fitModel({ ...spec, parameters: [{ name: 'A', initial: -1 }, { name: 'mu', initial: 1 }, { name: 's', initial: -0.5 }, { name: 'c' }] });
    expectRecovered(fit, truth);
    expect(fit.parameters[2].value).toBeGreaterThan(0);
    const dip = fitModel({ ...spec, y: spec.y.map(v => 1 - v) });
    expect(dip.parameters.map(p => Math.sign(p.value))).toEqual([-1, 1, 1, 1]);
    // Bounds that exclude the positive side are respected.
    const negative = fitModel({ ...spec, parameters: [{ name: 'A' }, { name: 'mu' }, { name: 's', max: -0.01 }, { name: 'c' }] });
    expect(negative.parameters[2].value).toBeCloseTo(-fit.parameters[2].value, 6);
  });

  test('a phase is reported within (-π, π]', () => {
    const g = normal(13);
    const x = linspace(0, 10, 100);
    const y = x.map(v => 2 * Math.sin(1.7 * v + 0.4) + 1 + 0.02 * g());
    for (const initial of [undefined, 20, -1000]) {
      const fit = fitModel({
        expression: 'y = A*sin(w*x + phi) + c', columns: { x }, y,
        parameters: [{ name: 'A', initial: 2 }, { name: 'w', initial: 1.7 }, { name: 'phi', initial }, { name: 'c' }]
      });
      expect(fit.converged).toBe(true);
      const phi = fit.parameters[2].value;
      expect(Math.abs(phi)).toBeLessThanOrEqual(Math.PI);
      // A positive amplitude with phase 0.4, or the same curve as -A with phase 0.4 - π.
      const A = fit.parameters[0].value;
      expect(A > 0 ? phi : phi + Math.PI).toBeCloseTo(0.4, 1);
      expect(fit.r2).toBeGreaterThan(0.999);
    }
    // An ordinary parameter larger than π is left alone.
    expect(fitModel(CASES.arrhenius.spec).parameters[1].value).toBeGreaterThan(4e4);
  });
});

/* ------------------------------------------------------------------ *
 * Oscillations
 * ------------------------------------------------------------------ */

const TWO_PI = 2 * Math.PI;

/*
 * Each fitted value within four standard errors of the truth, or 1e-6
 * relative for exact data. A phase counts modulo a whole turn (`turns` gives
 * the turn in the parameter's units where it is not 2π, as for t0 in
 * sin(w*(t - t0))), and the same curve with the amplitudes negated and the
 * phases half a turn away counts too.
 */
function expectWave(fit, truth, { phases = ['phi'], amplitudes = ['A'], turns = {} } = {}) {
  expect(fit.ok).toBe(true);
  expect(fit.converged).toBe(true);
  for (const p of fit.parameters) expect(Number.isFinite(p.stderr)).toBe(true);
  const matches = flip => fit.parameters.every(p => {
    const turn = phases.includes(p.name) ? turns[p.name] ?? TWO_PI : 0;
    let want = truth[p.name];
    if (flip && amplitudes.includes(p.name)) want = -want;
    if (flip) want += turn / 2;
    let d = p.value - want;
    if (turn) d -= turn * Math.round(d / turn);
    return Math.abs(d) <= 4 * p.stderr + 1e-6 * Math.max(1, Math.abs(want));
  });
  if (!matches(false) && !matches(true)) {
    throw new Error(fit.parameters.map(p => `${p.name} = ${p.value} ± ${p.stderr}, truth ${truth[p.name]}`).join('; '));
  }
}

describe('fitModel finds oscillations with no starting values given', () => {
  // The frequency is read off the data, so the fit neither switches the
  // oscillation off (tau → 0) nor settles on an alias above the sampling rate.
  const RINGDOWNS = [];
  for (const n of [60, 200]) {
    for (const P of [1.15, 2, 3, 5]) {
      for (const noise of [0, 0.03]) RINGDOWNS.push([n, P, noise]);
    }
  }
  test.each(RINGDOWNS)('A*exp(-x/tau)*cos(2*pi*x/P + phi) + y0: %i points, P = %f, noise %f', (n, P, noise) => {
    const { spec, truth } = ringdown(P, n, noise, 100 + n + 10 * P);
    const fit = fitModel(spec);
    expectWave(fit, truth);
    expect(fit.r2).toBeGreaterThan(noise ? 0.99 : 1 - 1e-12);
    // Reported the way people expect: a positive amplitude, the phase in (-π, π].
    expect(fit.parameters[0].value).toBeGreaterThan(0);
    expect(Math.abs(fit.parameters[3].value)).toBeLessThanOrEqual(Math.PI);
  });

  test('frequency written as w, as f with 2π, and as a period with a trend', () => {
    const g = normal(17);
    const t = linspace(0, 10, 80);
    expectWave(fitModel({
      expression: 'y = A*sin(w*t + phi) + c', columns: { t },
      y: t.map(v => 1.5 * Math.sin(2.7 * v - 1.1) + 0.4 + 0.05 * g())
    }), { A: 1.5, w: 2.7, phi: -1.1, c: 0.4 });

    const s = linspace(0, 4, 100);
    expectWave(fitModel({
      expression: 'y = A*cos(2*pi*f*t) + B*sin(2*pi*f*t) + c', columns: { t: s },
      y: s.map(v => 0.8 * Math.cos(2 * Math.PI * 1.3 * v) - 0.5 * Math.sin(2 * Math.PI * 1.3 * v) + 2 + 0.02 * g())
    }), { A: 0.8, B: -0.5, f: 1.3, c: 2 }, { phases: [], amplitudes: [] });

    const { spec, truth } = CASES.trendWave;
    const fit = fitModel(spec);
    expectWave(fit, truth, { phases: [] });
    expect(fit.r2).toBeGreaterThan(0.99);
  });

  test('a phase written as a shift in time repeats every period', () => {
    const g = normal(18);
    const t = linspace(0, 10, 100);
    const fit = fitModel({
      expression: 'y = A*sin(w*(t - t0)) + c', columns: { t },
      y: t.map(v => 1.3 * Math.sin(1.9 * (v - 0.6)) + 0.2 + 0.02 * g())
    });
    expectWave(fit, { A: 1.3, w: 1.9, t0: 0.6, c: 0.2 }, { phases: ['t0'], turns: { t0: TWO_PI / 1.9 } });
  });

  test('unevenly spaced x, sorted or not', () => {
    const g = normal(19);
    const u = uniform(20);
    const x = Array.from({ length: 80 }, () => 12 * u()).sort((a, b) => a - b);
    expectWave(fitModel({
      expression: 'y = A*exp(-x/tau)*cos(2*pi*x/P + phi) + y0', columns: { x },
      y: x.map(v => 2 * Math.exp(-v / 4) * Math.cos(Math.PI * v + 0.3) + 0.1 + 0.02 * g())
    }), { A: 2, tau: 4, P: 2, phi: 0.3, y0: 0.1 });

    const shuffled = Array.from({ length: 70 }, () => 10 * u());
    expectWave(fitModel({
      expression: 'y = A*sin(w*x + phi) + c', columns: { x: shuffled },
      y: shuffled.map(v => Math.sin(3.3 * v + 2.5) + 0.2 + 0.03 * g())
    }), { A: 1, w: 3.3, phi: 2.5, c: 0.2 });
  });

  test('a frequency close to the Nyquist limit is found, and not an alias of it', () => {
    // Spacing 0.1, so the Nyquist limit is π/0.1 ≈ 31.4 rad per unit.
    const g = normal(21);
    const x = linspace(0, 9.9, 100);
    const fit = fitModel({
      expression: 'y = A*sin(w*x + phi) + c', columns: { x },
      y: x.map(v => Math.sin(28 * v + 0.7) + 0.5 + 0.02 * g())
    });
    expectWave(fit, { A: 1, w: 28, phi: 0.7, c: 0.5 });
    expectWave(fitModel({
      expression: 'y = A*exp(-x/tau)*cos(2*pi*x/P + phi) + y0', columns: { x },
      y: x.map(v => 2 * Math.exp(-v / 6) * Math.cos((2 * Math.PI * v) / 0.25 + 0.3) + 0.1 + 0.01 * g())
    }), { A: 2, tau: 6, P: 0.25, phi: 0.3, y0: 0.1 });
  });

  test('two frequencies, and a fundamental with its harmonic', () => {
    const g = normal(22);
    const t = linspace(0, 20, 300);
    const fit = fitModel({
      expression: 'y = A*sin(w1*t + p1) + B*sin(w2*t + p2) + c', columns: { t },
      y: t.map(v => Math.sin(1.1 * v + 0.3) + 0.6 * Math.sin(3.7 * v - 1) + 0.1 + 0.02 * g())
    });
    // Which name takes which frequency is an accident of the search.
    const [A, w1, p1, B, w2, p2, c] = fit.parameters.map(p => p.name);
    const straight = fit.parameters[1].value < fit.parameters[4].value;
    const truth = straight
      ? { [A]: 1, [w1]: 1.1, [p1]: 0.3, [B]: 0.6, [w2]: 3.7, [p2]: -1, [c]: 0.1 }
      : { [A]: 0.6, [w1]: 3.7, [p1]: -1, [B]: 1, [w2]: 1.1, [p2]: 0.3, [c]: 0.1 };
    expectWave(fit, truth, { phases: ['p1', 'p2'], amplitudes: ['A', 'B'] });

    const s = linspace(0, 10, 200);
    expectWave(fitModel({
      expression: 'y = a0 + a1*cos(w*t) + b1*sin(w*t) + a2*cos(2*w*t) + b2*sin(2*w*t)', columns: { t: s },
      y: s.map(v => 0.5 + 2 * Math.cos(1.3 * v) - Math.sin(1.3 * v) + 0.4 * Math.cos(2.6 * v) + 0.3 * Math.sin(2.6 * v) + 0.03 * g())
    }), { a0: 0.5, a1: 2, b1: -1, a2: 0.4, b2: 0.3, w: 1.3 }, { phases: [], amplitudes: [] });
  });

  test('a negative amplitude is turned positive by moving the phase, cos² included', () => {
    const g = normal(23);
    const theta = linspace(0, 180, 37);
    // Malus's law in degrees: the same curve as -I0 with theta0 a quarter turn away.
    const malus = fitModel({
      expression: 'I = I0*cos((theta - theta0)*pi/180)^2 + b', columns: { theta },
      y: theta.map(v => 5 * Math.cos(((v - 30) * Math.PI) / 180) ** 2 + 0.2 + 0.05 * g())
    });
    const [I0, theta0, b] = malus.parameters;
    expect(I0.value).toBeGreaterThan(0);
    expect(Math.abs(theta0.value - 30)).toBeLessThan(4 * theta0.stderr);
    expect(Math.abs(b.value - 0.2)).toBeLessThan(4 * b.stderr);

    // A phase held to [0, 2π] by bounds stays there.
    const t = linspace(0, 15, 150);
    const bounded = fitModel({
      expression: 'y = A*sin(w*t + phi) + c', columns: { t },
      y: t.map(v => 2 * Math.sin(1.3 * v - 0.5) + 1 + 0.05 * g()),
      parameters: [{ name: 'A' }, { name: 'w' }, { name: 'phi', min: 0, max: TWO_PI }, { name: 'c' }]
    });
    expectWave(bounded, { A: 2, w: 1.3, phi: TWO_PI - 0.5, c: 1 });
    expect(bounded.parameters[0].value).toBeGreaterThan(0);
    expect(bounded.parameters[2]).toMatchObject({ atBound: false });
  });
});

/* ------------------------------------------------------------------ *
 * The same fits in scipy
 * ------------------------------------------------------------------ */

const SCIPY = (() => {
  try {
    return spawnSync('python3', ['-c', 'import numpy, scipy'], { timeout: 60000 }).status === 0;
  } catch {
    return false;
  }
})();
const withScipy = SCIPY ? describe : describe.skip;

/*
 * curve_fit (method 'lm', tolerances at their floor so it lands on the exact
 * minimum) from the true values, and a delta-method confidence band built
 * from its pcov with central differences, as an independent check on band().
 */
const SCIPY_SCRIPT = String.raw`
import json, sys
import numpy as np
from scipy import stats
from scipy.optimize import curve_fit

cases = json.load(open(sys.argv[1]))
out = {}
for name, c in cases.items():
    f = eval(c['python'])
    X = np.array([c['columns'][k] for k in c['independent']], dtype=float)
    y = np.array(c['y'], dtype=float)
    sigma = None if c['sigma'] is None else np.array(c['sigma'], dtype=float)
    popt, pcov = curve_fit(f, X, y, p0=c['p0'], sigma=sigma, absolute_sigma=c['absoluteSigma'],
                           method='lm', ftol=1e-15, xtol=1e-15, gtol=1e-15, maxfev=100000)
    P = np.array([c['band'][k] for k in c['independent']], dtype=float)
    G = np.empty((P.shape[1], len(popt)))
    for j in range(len(popt)):
        h = 1e-6 * (abs(popt[j]) + 1e-12)
        up, down = popt.copy(), popt.copy()
        up[j] += h
        down[j] -= h
        G[:, j] = (f(P, *up) - f(P, *down)) / (2 * h)
    dof = len(y) - len(popt)
    half = stats.t.ppf(0.975, dof) * np.sqrt(np.einsum('ij,jk,ik->i', G, pcov, G))
    w = np.ones_like(y) if sigma is None else 1 / sigma**2
    r = y - f(X, *popt)
    ybar = np.sum(w * y) / np.sum(w)
    out[name] = {
        'popt': popt.tolist(),
        'perr': np.sqrt(np.diag(pcov)).tolist(),
        'centre': f(P, *popt).tolist(),
        'half': half.tolist(),
        'chi2': float(np.sum(w * r**2)),
        'r2': float(1 - np.sum(w * r**2) / np.sum(w * (y - ybar)**2)),
    }
print(json.dumps(out))
`;

withScipy('fitModel agrees with scipy.optimize.curve_fit', () => {
  const names = ['decay', 'arrhenius', 'gaussian', 'logistic', 'power', 'plane', 'weighted', 'absoluteSigma', 'ringdown', 'trendWave'];
  const fits = {};
  let scipy = {};
  let dir;

  beforeAll(() => {
    const input = {};
    for (const name of names) {
      const { spec, truth, python, band } = CASES[name];
      const fit = fitModel(spec);
      fits[name] = fit;
      const free = fit.parameters.filter(p => !p.fixed);
      input[name] = {
        python,
        independent: fit.independent,
        columns: spec.columns,
        y: spec.y,
        sigma: spec.sigma ?? null,
        absoluteSigma: spec.absoluteSigma === true,
        p0: free.map(p => truth[p.name]),
        band
      };
    }
    dir = mkdtempSync(join(tmpdir(), 'stemkit-nonlinear-fit-'));
    writeFileSync(join(dir, 'cases.json'), JSON.stringify(input));
    writeFileSync(join(dir, 'fit.py'), SCIPY_SCRIPT);
    const r = spawnSync('python3', [join(dir, 'fit.py'), join(dir, 'cases.json')], { encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0) throw new Error(`python3 failed: ${r.stderr}`);
    scipy = JSON.parse(r.stdout);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const worst = { value: 0, stderr: 0, band: 0 };
  afterAll(() => {
    // Printed so the agreement can be quoted, not just passed.
    console.log(`scipy agreement, worst relative difference: values ${worst.value.toExponential(1)}, ` +
      `standard errors ${worst.stderr.toExponential(1)}, band half-widths ${worst.band.toExponential(1)}`);
  });

  test.each(names)('%s: values to 1e-6, standard errors and the band to 1e-5', name => {
    const fit = fits[name];
    const ref = scipy[name];
    expect(fit.ok).toBe(true);
    const free = fit.parameters.filter(p => !p.fixed);
    expect(free).toHaveLength(ref.popt.length);
    free.forEach((p, i) => {
      const dv = rel(p.value, ref.popt[i]);
      const ds = rel(p.stderr, ref.perr[i]);
      worst.value = Math.max(worst.value, dv);
      worst.stderr = Math.max(worst.stderr, ds);
      if (dv > 1e-6) throw new Error(`${name} ${p.name}: page ${p.value}, scipy ${ref.popt[i]}`);
      // curve_fit's pcov comes from MINPACK's forward-difference Jacobian and
      // the page's from exact derivatives, which costs a few digits.
      if (ds > 1e-5) throw new Error(`${name} ${p.name} stderr: page ${p.stderr}, scipy ${ref.perr[i]}`);
    });
    expect(rel(fit.chi2, ref.chi2)).toBeLessThan(1e-9);
    expect(rel(fit.r2, ref.r2)).toBeLessThan(1e-9);

    const points = ref.centre.map((_, k) => Object.fromEntries(fit.independent.map(v => [v, CASES[name].band[v][k]])));
    const { lower, upper } = fit.band(points);
    ref.centre.forEach((centre, k) => {
      expect(rel((upper[k] + lower[k]) / 2, centre)).toBeLessThan(1e-6);
      const db = rel((upper[k] - lower[k]) / 2, ref.half[k]);
      worst.band = Math.max(worst.band, db);
      if (db > 1e-5) throw new Error(`${name} band at ${JSON.stringify(points[k])}: page ${(upper[k] - lower[k]) / 2}, scipy ${ref.half[k]}`);
    });
  });
});

/* ------------------------------------------------------------------ *
 * Robustness
 * ------------------------------------------------------------------ */

describe('fitModel with awkward input', () => {
  test('rows with blank, non-numeric or non-finite values are dropped and counted', () => {
    const x = [0, 1, 2, 3, '4', 5, 6, 7, 8, null, 10, 11];
    const y = [1, 3.1, 4.9, 7.2, 9, '', 13.1, 'n/a', 16.8, 19, NaN, 23.1];
    const fit = fitModel({ expression: 'y = a*x + b', columns: { x }, y });
    expect(fit.ok).toBe(true);
    expect(fit.n).toBe(8);
    expect(fit.warnings).toContain('Dropped 4 rows with a blank or non-numeric value.');
    expect(Array.from(fit.rows)).toEqual([0, 1, 2, 3, 4, 6, 8, 11]);
    expect(fit.parameters[0].value).toBeCloseTo(2, 0);

    const sigma = [0.1, 0.1, 0, 0.1, -1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 'x'];
    const weighted = fitModel({ expression: 'y = a*x + b', columns: { x }, y, sigma });
    expect(weighted.n).toBe(5);
    expect(weighted.warnings).toEqual(expect.arrayContaining([
      'Dropped 4 rows with a blank or non-numeric value.',
      'Dropped 3 rows whose uncertainty was missing, zero or negative.'
    ]));
    expect(fitModel({ expression: 'y = a*x + b', columns: { x: [1, 2, Infinity, 4] }, y: [1, 2, 3, 4] }).n).toBe(3);
  });

  test('no more points than free parameters is refused with a clear message', () => {
    const fit = fitModel({ expression: 'y = a*x^2 + b*x + c', columns: { x: [1, 2, 3, 4] }, y: [1, 2, 3, NaN] });
    expect(fit.ok).toBe(false);
    expect(fit.message).toBe('3 usable data points cannot determine 3 free parameters; you need at least 4. ' +
      'Add data or hold some parameters fixed.');
    expect(fit.warnings).toContain('Dropped 1 row with a blank or non-numeric value.');
    expect(fitModel({ expression: 'y = a*x', columns: { x: [] }, y: [] }).message).toMatch(/^0 usable data points/);
    // Holding one fixed makes the same data enough.
    expect(fitModel({
      expression: 'y = a*x^2 + b*x + c', columns: { x: [1, 2, 3] }, y: [1, 2, 3.5],
      parameters: [{ name: 'a' }, { name: 'b' }, { name: 'c', initial: 0, fixed: true }]
    }).ok).toBe(true);
  });

  test('parameters the data cannot separate are named, with infinite uncertainty', () => {
    const g = normal(10);
    const x = linspace(0, 5, 20);
    const fit = fitModel({ expression: 'y = a*b*x', columns: { x }, y: x.map(v => 2 * v + 0.05 * g()) });
    expect(fit.ok).toBe(true);
    expect(fit.message).toMatch(/^'a' and 'b' cannot be told apart/);
    expect(fit.warnings).toContain(fit.message);
    expect(fit.parameters.map(p => p.stderr)).toEqual([Infinity, Infinity]);
    const [a, b] = fit.parameters.map(p => p.value);
    expect(a * b).toBeCloseTo(2, 1);
    expect(Number.isNaN(fit.correlation[0][1])).toBe(true);

    // A parameter the curve does not depend on at all.
    const flat = fitModel({ expression: 'y = a*x + 0*c', columns: { x }, y: x.map(v => 2 * v + 0.05 * g()) });
    expect(flat.ok).toBe(true);
    expect(flat.message).toMatch(/'c'/);
    expect(flat.parameters[1].stderr).toBe(Infinity);
    expect(Number.isFinite(flat.parameters[0].stderr)).toBe(true);
  });

  test('a model undefined at the starting value recovers from other starts, or says why it cannot', () => {
    const g = normal(11);
    const x = linspace(1, 10, 30);
    const y = x.map(v => Math.log(12 - v) + 0.01 * g());
    const fit = fitModel({ expression: 'y = log(a - x)', columns: { x }, y, parameters: [{ name: 'a', initial: 0 }] });
    expect(fit.ok).toBe(true);
    expect(fit.parameters[0].value).toBeCloseTo(12, 1);
    expect(fit.warnings).toContain('The starting values given make the equation undefined, so others were used.');

    const stuck = fitModel({ expression: 'y = log(a - x)', columns: { x }, y, parameters: [{ name: 'a', initial: 0 }], multistart: false });
    expect(stuck.ok).toBe(false);
    expect(stuck.message).toBe('The equation cannot be evaluated: log(a - x) is undefined (the logarithm of a negative ' +
      'number) for 30 rows, first at row 1. Give starting values for a that keep it defined, or set bounds.');

    // Undefined whatever the parameters are: the data are to blame.
    const always = fitModel({ expression: 'y = a*sqrt(x)', columns: { x: [-1, 1, 2, 3] }, y: [1, 1, 1.4, 1.7] });
    expect(always.ok).toBe(false);
    expect(always.message).toMatch(/sqrt\(x\) is undefined \(the square root of a negative number\) for 1 row, first at row 1\. That part does not depend on any parameter/);
  });

  test('a fit that runs out of iterations returns its best values, marked unconverged', () => {
    const t = linspace(0, 10, 40);
    const y = t.map(v => 5 * Math.exp(-v / 2.5) + 1);
    const start = [{ name: 'A', initial: 1 }, { name: 'tau', initial: 100 }, { name: 'y0', initial: 0 }];
    // A rejected trial step counts as an iteration, so from this poor start the
    // first few make no progress; six are enough to improve on it but not to settle.
    const fit = fitModel({ expression: 'y = A*exp(-t/tau) + y0', columns: { t }, y, parameters: start, maxIterations: 6, multistart: false });
    expect(fit.ok).toBe(true);
    expect(fit.converged).toBe(false);
    expect(fit.iterations).toBe(6);
    expect(fit.message).toBe('The fit did not settle within 6 iterations; these are the best values found. ' +
      'Try starting values closer to the data, or allow more iterations.');
    expect(fit.warnings).toContain(fit.message);
    fit.parameters.forEach(p => expect(Number.isFinite(p.value)).toBe(true));
    const atStart = y.reduce((s, v, i) => s + (v - Math.exp(-t[i] / 100)) ** 2, 0);
    expect(fit.rss).toBeLessThan(atStart);
    // Given room, the same start does settle.
    expect(fitModel({ expression: 'y = A*exp(-t/tau) + y0', columns: { t }, y, parameters: start, multistart: false }).converged).toBe(true);
  });

  test('bad specs fail with a message and never throw', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    const bad = [
      [undefined, /Type an equation/],
      [null, /Type an equation/],
      [{}, /Type an equation/],
      [{ expression: 'y = a*x +', columns: { x }, y }, /Missing a value after '\+'/],
      [{ expression: 'y = a*x', columns: {}, y }, /No data column for 'x'/],
      [{ expression: 'y = a*x', columns: { x } }, /No y values/],
      [{ expression: 'y = a*x', columns: { x: [1, 2] }, y }, /The 'x' column has 2 values but y has 5/],
      [{ expression: 'y = a*x', columns: { x }, y, sigma: [1, 2] }, /uncertainties have 2 values but y has 5/],
      [{ expression: 'y = a*x', columns: { x }, y, parameters: [{ name: 'a', min: 3, max: 1 }] }, /lower bound of 'a' is above/],
      [{ expression: 'y = a*x', columns: { x }, y, parameters: [{ name: 'a', fixed: true }] }, /Give a value for 'a'/],
      [{ expression: 'y = a*x', columns: { x }, y, parameters: [{ name: 'a' }, { name: 'a' }] }, /listed twice/],
      [{ expression: 'y = a*x', columns: { x }, y, parameters: [{ name: 'x' }] }, /both a variable and a parameter/],
      [{ expression: 'y = 2', columns: { x }, y }, /Say which name/]
    ];
    for (const [spec, message] of bad) {
      let fit;
      expect(() => { fit = fitModel(spec); }).not.toThrow();
      expect(fit.ok).toBe(false);
      expect(fit.message).toMatch(message);
      expect(Array.isArray(fit.warnings)).toBe(true);
    }
    expect(fitModel({ expression: 'y = a*x +', columns: { x }, y }).error).toEqual({ message: "Missing a value after '+'", start: 8, end: 9 });
  });

  test('accepts numbers as strings, typed arrays and y given as a column', () => {
    const fit = fitModel({
      expression: 'y = a*x + b',
      columns: { x: Float64Array.from([1, 2, 3, 4]), y: ['3', '5.1', ' 6.9 ', '9'] }
    });
    expect(fit.ok).toBe(true);
    expect(fit.parameters[0].value).toBeCloseTo(2, 1);
    expect(fit.dependent).toBe('y');
  });

  test('a curve through every point gives zero uncertainties and says so', () => {
    const x = [1, 2, 3, 4, 5];
    const fit = fitModel({ expression: 'y = a*x + b', columns: { x }, y: x.map(v => 3 * v - 1) });
    expect(fit.ok).toBe(true);
    expect(fit.parameters[0].value).toBeCloseTo(3, 12);
    expect(fit.parameters[1].value).toBeCloseTo(-1, 12);
    expect(fit.r2).toBeCloseTo(1, 12);
    expect(fit.parameters[0].stderr).toBeLessThan(1e-6);
  });

  test('names left out of the parameter list are fitted, with a note', () => {
    const x = [1, 2, 3, 4, 5, 6];
    const fit = fitModel({ expression: 'y = a*x + b', columns: { x }, y: [3.1, 4.9, 7.2, 9, 10.8, 13.1], parameters: [{ name: 'a' }] });
    expect(fit.ok).toBe(true);
    expect(fit.parameters.map(p => p.name)).toEqual(['a', 'b']);
    expect(fit.warnings).toContain("'b' was not in the parameter list, so it is fitted as a parameter.");
  });
});

/* ------------------------------------------------------------------ *
 * Whether a switched-on band can be seen (core/plot-style)
 * ------------------------------------------------------------------ */

describe('bandVisibility', () => {
  /* What the Curve Fitter's plot draws for a one-variable fit. */
  const plotted = (fit, x, y, style) => {
    const grid = linspace(Math.min(...x), Math.max(...x), 200);
    const b = fit.band(grid, style.band.level);
    return { x, y, curve: { x: grid, y: grid.map(v => fit.predict(v)) }, band: { x: grid, lower: Array.from(b.lower), upper: Array.from(b.upper) } };
  };
  const withBand = (extra = {}) => {
    const s = defaultPlotStyle();
    return { ...s, ...extra, band: { ...s.band, show: true, ...(extra.band || {}) } };
  };
  const x = linspace(0, 7, 8);
  const noisy = [1.3, 2.6, 5.5, 6.4, 9.6, 10.1, 13.7, 14.2];

  test('a band wider than the line is shown, with no note', () => {
    const style = withBand();
    const fit = fitModel({ expression: 'y = a*x + b', columns: { x }, y: noisy });
    expect(bandVisibility(plotted(fit, x, noisy, style), style, fit)).toEqual({ status: 'shown', message: '' });
  });

  test('parameters that cannot be told apart leave the band undetermined, though x = 0 comes out finite', () => {
    const style = withBand();
    const y = [0.02, 2.01, 3.98, 6.03, 7.99, 10.02, 11.98, 14.01];
    const fit = fitModel({ expression: 'y = a*b*x', columns: { x }, y, parameters: [{ name: 'a', value: 1 }, { name: 'b', value: 1 }] });
    expect(fit.ok).toBe(true);
    const model = plotted(fit, x, y, style);
    // Every gradient is zero at x = 0, so that one point is finite, with zero width.
    expect(model.band.lower[0]).toBe(model.band.upper[0]);
    expect(model.band.lower.slice(1).every(v => Number.isNaN(v))).toBe(true);
    const v = bandVisibility(model, style, fit);
    expect(v.status).toBe('undetermined');
    expect(v.message).toBe('Band not drawn: the parameters are not independent, so their uncertainties, and the band, cannot be worked out.');
  });

  test('a band thinner than the fit line is reported as hidden, at its level', () => {
    const style = withBand({ band: { level: 0.99 } });
    const y = x.map(v => 2 * v + 1 + (v % 2 ? 1e-4 : -1e-4));
    const fit = fitModel({ expression: 'y = a*x + b', columns: { x }, y });
    const v = bandVisibility(plotted(fit, x, y, style), style, fit);
    expect(v.status).toBe('hidden');
    expect(v.message).toBe('Band is narrower than the line: the 99% band is hidden behind the fitted curve because the fit is very tight.');
    expect(bandVisibility(plotted(fit, x, y, style), { ...style, yScale: 'log' }, fit).status).toBe('shown');
  });

  test('the threshold is the fit line\'s width, in points on the main panel', () => {
    const style = withBand();
    const y = x.map(v => 2 * v + 1 + (v % 2 ? 0.02 : -0.02));
    const fit = fitModel({ expression: 'y = a*x + b', columns: { x }, y });
    const model = plotted(fit, x, y, style);
    const widths = model.band.upper.map((u, i) => u - model.band.lower[i]);
    const all = [...model.band.lower, ...model.band.upper, ...y, ...model.curve.y];
    const bandPt = (Math.max(...widths) / (Math.max(...all) - Math.min(...all))) * style.height * 72 * 0.77;
    expect(bandPt).toBeGreaterThan(0.2);
    expect(bandPt).toBeLessThan(6);
    const line = w => ({ ...style, fit: { ...style.fit, width: w } });
    expect(bandVisibility(model, line(bandPt * 1.2), fit).status).toBe('hidden');
    expect(bandVisibility(model, line(bandPt * 0.8), fit).status).toBe('shown');
    // A residual panel shrinks the main one, and the band with it.
    const resid = { ...line(bandPt * 0.8), residuals: { show: true, heightRatio: 0.5 } };
    expect(bandVisibility(model, resid, fit).status).toBe('hidden');
  });

  test('a narrow y range from fixed limits makes the same band visible', () => {
    const style = withBand();
    const y = x.map(v => 2 * v + 1 + (v % 2 ? 1e-4 : -1e-4));
    const fit = fitModel({ expression: 'y = a*x + b', columns: { x }, y });
    const model = plotted(fit, x, y, style);
    expect(bandVisibility(model, style, fit).status).toBe('hidden');
    const zoomed = { ...style, yLim: [0.999, 1.001] };
    expect(bandVisibility(model, zoomed, fit).status).toBe('shown');
  });

  test('no band asked for, none to draw, or several variables: off', () => {
    const fit = fitModel({ expression: 'y = a*x + b', columns: { x }, y: noisy });
    const style = withBand();
    const model = plotted(fit, x, noisy, style);
    expect(bandVisibility(model, defaultPlotStyle(), fit)).toEqual({ status: 'off', message: '' });
    expect(bandVisibility({ ...model, band: undefined }, style, fit).status).toBe('off');
    expect(bandVisibility({ ...model, multivariate: { observed: noisy, predicted: noisy } }, style, fit).status).toBe('off');
    expect(bandVisibility(null, style, fit).status).toBe('off');
  });
});
