/**
 * @module core/nonlinear-fit
 *
 * Least-squares fitting of an equation a person types, such as
 * `y = A*exp(-t/tau) + y0`, to their data, with uncertainties that match
 * scipy.optimize.curve_fit.
 *
 * The minimiser is Levenberg–Marquardt on the untransformed data. The
 * Jacobian comes from symbolic derivatives of the typed equation (see
 * `differentiate` in expression.js), with a finite difference only for the
 * entries where a formula is undefined, such as x^n ln x at x = 0. Each step
 * is solved by QR factorisation rather than through JᵀJ, so a polynomial in x
 * around 2000 does not lose half its digits to squaring. Steps are damped in
 * the MINPACK scaling (each parameter measured against the size of its own
 * Jacobian column), and the damping follows Nielsen's update. Bounds are kept
 * by projecting each trial point into the box, and a parameter that finishes
 * on a bound is reported as such, because its uncertainty then describes a
 * constrained estimate.
 *
 * Uncertainties follow curve_fit exactly: the covariance is (JᵀWJ)⁻¹,
 * multiplied by the reduced chi-square unless `absoluteSigma` is set, and a
 * 95% interval uses Student's t on n - p degrees of freedom. The tests run
 * scipy on the same data and compare.
 *
 * Starting values are the usual weak point of nonlinear fitting, so they are
 * searched for rather than assumed. Parameters the equation is linear in
 * (A and y0 in A*exp(-t/tau) + y0) are solved exactly by linear least squares
 * for each trial value of the others, which leaves only tau to search, over
 * decades and over scales taken from the data. The best few candidates then
 * seed the fit, and more are tried, with random perturbations, when the first
 * attempt fails to converge, cannot separate its parameters or fits poorly.
 *
 * Oscillations get their own search, because decades cannot find a frequency.
 * The parameters that set the frequency of a sin, cos or tan are recognised
 * from the equation (w, f with 2π, a period T), the strongest frequencies in
 * the data come from a Lomb–Scargle periodogram, and each becomes the value
 * of that parameter that turns the argument at that rate; phases are tried at
 * quarter turns. Trial frequencies above the Nyquist limit of the sampling are
 * left out, and a fit that ends up there anyway (an alias, which meets the
 * points as well as the true frequency) loses to one below it. A negative
 * amplitude is then made positive by moving the phase.
 *
 * Bad input never throws. Rows with blank or non-numeric values are dropped
 * and counted, a model that cannot be evaluated names the part that fails,
 * and parameters that the data cannot tell apart are named with a suggestion.
 */

import {
  parseEquation, symbolsOf, classify, compile, differentiate, toText, special
} from './expression.js';

/* ------------------------------------------------------------------ *
 * Distributions
 * ------------------------------------------------------------------ */

/* Continued fraction for the regularised incomplete beta (modified Lentz). */
function betaFraction(a, b, x) {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 20000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return h;
}

/*
 * Regularised incomplete beta I_x(a, b). The complement y = 1 - x is passed
 * separately so that callers who know it exactly do not lose it to rounding,
 * and so, optionally, is the log of the prefactor x^a y^b / B(a, b), which a
 * caller can often compute more accurately than this general formula.
 */
function regularizedBeta(a, b, x, y = 1 - x, lnFront = null) {
  if (x <= 0) return 0;
  if (y <= 0) return 1;
  const lbt = lnFront ?? (special.lgamma(a + b) - special.lgamma(a) - special.lgamma(b) +
    a * Math.log(x) + b * Math.log(y));
  const bt = Math.exp(lbt);
  if (x < (a + 1) / (a + b + 2)) return (bt * betaFraction(a, b, x)) / a;
  return 1 - (bt * betaFraction(b, a, y)) / b;
}

/* Stirling's series for ln Γ(z) without its leading terms; for z >= 20 the
 * terms after 1/z^9 are below 1e-17. */
function stirlingTail(z) {
  const w = 1 / (z * z);
  return (1 / 12 - w * (1 / 360 - w * (1 / 1260 - w * (1 / 1680 - w / 1188)))) / z;
}

/*
 * ln Γ(a + b) - ln Γ(a). For large a the two log-gammas are large and nearly
 * equal, so subtracting them loses digits (about 1e-9 of the result by a =
 * 1e6, which is 2 million degrees of freedom); the Stirling form does not.
 */
function lgammaDifference(a, b) {
  if (a < 20) return special.lgamma(a + b) - special.lgamma(a);
  return (a - 0.5) * Math.log1p(b / a) + b * Math.log(a + b) - b + stirlingTail(a + b) - stirlingTail(a);
}

const LN_SQRT_PI = 0.5 * Math.log(Math.PI);

/**
 * Quantile of the standard normal distribution: Acklam's rational
 * approximation, polished by one Halley step on erfc to full double precision.
 *
 * @param {number} p - Probability in (0, 1).
 * @returns {number} NaN outside (0, 1).
 */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const plow = 0.02425;
  let x;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - plow) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log1p(-p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = 0.5 * special.erfc(-x / Math.SQRT2) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/*
 * Upper tail P(T > t) for t >= 0: half of I_x(dof/2, 1/2) at x = dof/(dof + t²).
 * The prefactor is built from log1p and the Stirling difference, because x is
 * close to 1 for large dof and a plain log(x) would lose digits there.
 */
function studentTail(t, dof) {
  if (t === 0) return 0.5;
  const t2 = t * t;
  const a = dof / 2;
  const lnFront = lgammaDifference(a, 0.5) - LN_SQRT_PI - a * Math.log1p(t2 / dof) +
    Math.log(t) - 0.5 * Math.log(dof + t2);
  return 0.5 * regularizedBeta(a, 0.5, dof / (dof + t2), t2 / (dof + t2), lnFront);
}

function studentDensity(t, dof) {
  return Math.exp(lgammaDifference(dof / 2, 0.5) - 0.5 * Math.log(dof * Math.PI) -
    ((dof + 1) / 2) * Math.log1p((t * t) / dof));
}

/**
 * Cumulative distribution function of Student's t, from the incomplete beta
 * function: within a few units in the last place of a 40-digit reference up
 * to 10^4 degrees of freedom, and within about 1e-11 up to 10^9.
 *
 * @param {number} t
 * @param {number} dof - Degrees of freedom, > 0 (need not be an integer;
 *   Infinity gives the normal distribution).
 * @returns {number}
 */
export function studentTCdf(t, dof) {
  if (Number.isNaN(t) || !(dof > 0)) return NaN;
  if (dof === Infinity) return 0.5 * special.erfc(-t / Math.SQRT2);
  if (t === Infinity) return 1;
  if (t === -Infinity) return 0;
  const tail = studentTail(Math.abs(t), dof);
  return t >= 0 ? 1 - tail : tail;
}

/**
 * Quantile of Student's t distribution, so that P(T <= t) = p.
 *
 * Closed forms for 1 and 2 degrees of freedom; otherwise the Cornish–Fisher
 * expansion, refined by safeguarded Newton steps on the incomplete-beta tail
 * below 10^5 degrees of freedom (above that the expansion alone is exact to
 * double precision, and more accurate than the tail). Checked against a
 * 40-digit reference to about 1e-14 relative; scipy.stats.t.ppf is itself off
 * by up to 2e-9 at small dof.
 *
 * @param {number} p - Probability in (0, 1).
 * @param {number} dof - Degrees of freedom, > 0.
 * @returns {number} NaN for invalid input.
 */
export function studentTQuantile(p, dof) {
  if (!(p > 0 && p < 1) || !(dof > 0)) return NaN;
  if (p === 0.5) return 0;
  if (dof === Infinity || dof > 1e12) return normalQuantile(p);
  const upper = p > 0.5;
  const q = upper ? 1 - p : p;
  let t;
  if (dof === 1) {
    // cot(pi q) rather than tan(pi (1/2 - q)), which loses digits near pi/2.
    t = 1 / Math.tan(Math.PI * q);
  } else if (dof === 2) {
    t = (1 - 2 * q) / Math.sqrt(2 * q * (1 - q));
  } else {
    const z = -normalQuantile(q);
    const z2 = z * z;
    const g1 = (z2 + 1) * z / 4;
    const g2 = ((5 * z2 + 16) * z2 + 3) * z / 96;
    const g3 = (((3 * z2 + 19) * z2 + 17) * z2 - 15) * z / 384;
    const g4 = ((((79 * z2 + 776) * z2 + 1482) * z2 - 1920) * z2 - 945) * z / 92160;
    t = z + g1 / dof + g2 / dof ** 2 + g3 / dof ** 3 + g4 / dof ** 4;
    if (!(t > 0) || !Number.isFinite(t)) t = z;

    let lo = 0;
    let hi = Infinity;
    for (let iter = 0; dof < 1e5 && iter < 100; iter++) {
      const diff = studentTail(t, dof) - q;
      if (diff > 0) lo = t; else hi = t;
      let next = t + diff / studentDensity(t, dof);
      if (!(next > lo && next < hi)) next = hi === Infinity ? 2 * t + 1 : (lo + hi) / 2;
      if (Math.abs(next - t) <= 1e-14 * Math.abs(next)) {
        t = next;
        break;
      }
      t = next;
    }
  }
  return upper ? t : -t;
}

/* ------------------------------------------------------------------ *
 * Small dense linear algebra, column-major
 * ------------------------------------------------------------------ */

function columnNorm(A, n, col) {
  const off = col * n;
  let scale = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(A[off + i]));
  if (scale === 0 || !Number.isFinite(scale)) return scale;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const v = A[off + i] / scale;
    s += v * v;
  }
  return scale * Math.sqrt(s);
}

/*
 * Householder QR of an n×m matrix, in place. R ends up on and above the
 * diagonal; each reflector's tail stays below it, with its head in `head`.
 */
function householderQR(A, n, m) {
  const k = Math.min(n, m);
  const head = new Float64Array(m);
  const beta = new Float64Array(m);
  const diag = new Float64Array(m);
  for (let c = 0; c < k; c++) {
    const off = c * n;
    const norm = columnNormFrom(A, n, c, c);
    if (norm === 0 || !Number.isFinite(norm)) continue;
    const x0 = A[off + c];
    const alpha = x0 > 0 ? -norm : norm;
    const v0 = x0 - alpha;
    let vtv = v0 * v0;
    for (let i = c + 1; i < n; i++) vtv += A[off + i] * A[off + i];
    head[c] = v0;
    beta[c] = 2 / vtv;
    diag[c] = alpha;
    for (let j = c + 1; j < m; j++) {
      const oj = j * n;
      let s = v0 * A[oj + c];
      for (let i = c + 1; i < n; i++) s += A[off + i] * A[oj + i];
      s *= beta[c];
      A[oj + c] -= s * v0;
      for (let i = c + 1; i < n; i++) A[oj + i] -= s * A[off + i];
    }
    A[off + c] = alpha;
  }
  return { A, n, m, head, beta, diag };
}

function columnNormFrom(A, n, col, from) {
  const off = col * n;
  let scale = 0;
  for (let i = from; i < n; i++) scale = Math.max(scale, Math.abs(A[off + i]));
  if (scale === 0 || !Number.isFinite(scale)) return scale;
  let s = 0;
  for (let i = from; i < n; i++) {
    const v = A[off + i] / scale;
    s += v * v;
  }
  return scale * Math.sqrt(s);
}

/* b ← Qᵀ b, in place. */
function applyQt(qr, b) {
  const { A, n, m, head, beta } = qr;
  for (let c = 0; c < Math.min(n, m); c++) {
    if (beta[c] === 0) continue;
    const off = c * n;
    let s = head[c] * b[c];
    for (let i = c + 1; i < n; i++) s += A[off + i] * b[i];
    s *= beta[c];
    b[c] -= s * head[c];
    for (let i = c + 1; i < n; i++) b[i] -= s * A[off + i];
  }
}

/* The m×m upper triangle R, column-major. */
function upperR(qr) {
  const { A, n, m, diag } = qr;
  const R = new Float64Array(m * m);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < j; i++) R[j * m + i] = A[j * n + i];
    R[j * m + j] = diag[j];
  }
  return R;
}

/* Solve R x = b for upper-triangular R (column-major, leading dimension ld),
 * setting components with a zero pivot to zero. */
function backSubstitute(A, ld, diag, b, m, pivotFloor = 0) {
  const x = new Float64Array(m);
  for (let i = m - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < m; j++) s -= A[j * ld + i] * x[j];
    x[i] = Math.abs(diag[i]) > pivotFloor ? s / diag[i] : 0;
  }
  return x;
}

/*
 * The Levenberg–Marquardt step: minimise |R h - qtr|² + mu |D h|², by QR of
 * the stacked 2m×m matrix [R; sqrt(mu) D], never forming RᵀR.
 */
function dampedStep(R, qtr, D, mu, m) {
  const rows = 2 * m;
  const S = new Float64Array(rows * m);
  const b = new Float64Array(rows);
  const sm = Math.sqrt(mu);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i <= j; i++) S[j * rows + i] = R[j * m + i];
    S[j * rows + m + j] = sm * D[j];
    b[j] = qtr[j];
  }
  const qr = householderQR(S, rows, m);
  applyQt(qr, b);
  return backSubstitute(qr.A, rows, qr.diag, b, m);
}

/*
 * One-sided Jacobi SVD of a small square matrix: returns the singular values
 * and the right singular vectors (column k of V pairs with s[k]).
 */
function jacobiSVD(M, m) {
  const U = Float64Array.from(M);
  const V = new Float64Array(m * m);
  for (let i = 0; i < m; i++) V[i * m + i] = 1;
  for (let sweep = 0; sweep < 80; sweep++) {
    let rotated = false;
    for (let p = 0; p < m - 1; p++) {
      for (let q = p + 1; q < m; q++) {
        let alpha = 0;
        let beta = 0;
        let gamma = 0;
        for (let i = 0; i < m; i++) {
          const up = U[p * m + i];
          const uq = U[q * m + i];
          alpha += up * up;
          beta += uq * uq;
          gamma += up * uq;
        }
        if (gamma === 0 || !(Math.abs(gamma) > 1e-15 * Math.sqrt(alpha * beta))) continue;
        rotated = true;
        const zeta = (beta - alpha) / (2 * gamma);
        const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = c * t;
        for (let i = 0; i < m; i++) {
          const up = U[p * m + i];
          const uq = U[q * m + i];
          U[p * m + i] = c * up - s * uq;
          U[q * m + i] = s * up + c * uq;
          const vp = V[p * m + i];
          const vq = V[q * m + i];
          V[p * m + i] = c * vp - s * vq;
          V[q * m + i] = s * vp + c * vq;
        }
      }
    }
    if (!rotated) break;
  }
  const s = new Float64Array(m);
  for (let k = 0; k < m; k++) s[k] = columnNorm(U, m, k);
  return { s, V };
}

/* ------------------------------------------------------------------ *
 * The model on the data
 * ------------------------------------------------------------------ */

const CBRT_EPS = Math.cbrt(Number.EPSILON);

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/* Compiled model: f and one derivative per parameter, sharing one value array
 * laid out as [independent..., parameters...]. */
function prepareModel(ast, independent, paramNames) {
  const names = [...independent, ...paramNames];
  const dAst = paramNames.map(p => differentiate(ast, p));
  return {
    ast,
    names,
    nInd: independent.length,
    f: compile(ast, names),
    dAst,
    df: dAst.map(d => (d ? compile(d, names) : null)),
    vals: new Float64Array(names.length)
  };
}

function subsetData(data, count) {
  if (data.n <= count) return data;
  const idx = [];
  for (let k = 0; k < count; k++) idx.push(Math.round((k * (data.n - 1)) / (count - 1)));
  const pick = arr => Float64Array.from(idx, i => arr[i]);
  const sub = {
    n: idx.length,
    X: data.X.map(pick),
    Y: pick(data.Y),
    SW: pick(data.SW),
    rows: Int32Array.from(idx, i => data.rows[i])
  };
  sub.yy = weightedSquares(sub);
  return sub;
}

function weightedSquares(data) {
  let s = 0;
  for (let i = 0; i < data.n; i++) s += (data.SW[i] * data.Y[i]) ** 2;
  return s;
}

/* r ← sqrt(w)(y - f); returns chi-square, or NaN when the model fails. */
function residualVector(model, data, p, r) {
  const { f, vals, nInd } = model;
  vals.set(p, nInd);
  const { n, X, Y, SW } = data;
  let chi2 = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < nInd; k++) vals[k] = X[k][i];
    const ri = SW[i] * (Y[i] - f(vals));
    r[i] = ri;
    chi2 += ri * ri;
  }
  return Number.isFinite(chi2) ? chi2 : NaN;
}

/* Finite difference of f in one slot of the shared value array, kept inside
 * the parameter's bounds, falling back to one side when the other side is
 * undefined. Returns 0 when neither side helps. */
function numericDerivative(model, slot, lo, hi) {
  const { f, vals } = model;
  const v0 = vals[slot];
  const h = CBRT_EPS * (Math.abs(v0) || 1);
  const up = Math.min(v0 + h, hi);
  const down = Math.max(v0 - h, lo);
  vals[slot] = up;
  const fu = f(vals);
  vals[slot] = down;
  const fd = f(vals);
  vals[slot] = v0;
  if (Number.isFinite(fu) && Number.isFinite(fd) && up !== down) return (fu - fd) / (up - down);
  const f0 = f(vals);
  if (Number.isFinite(f0)) {
    if (Number.isFinite(fu) && up !== v0) return (fu - f0) / (up - v0);
    if (Number.isFinite(fd) && down !== v0) return (f0 - fd) / (v0 - down);
  }
  return 0;
}

/* Weighted Jacobian columns for the parameters in `cols`, column-major. */
function jacobian(model, data, p, cols, J, lo, hi) {
  const { vals, nInd, df } = model;
  vals.set(p, nInd);
  const { n, X, SW } = data;
  const m = cols.length;
  const fns = cols.map(j => df[j]);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < nInd; k++) vals[k] = X[k][i];
    for (let t = 0; t < m; t++) {
      const g = fns[t];
      let v = g ? g(vals) : NaN;
      if (!Number.isFinite(v)) {
        const j = cols[t];
        v = numericDerivative(model, nInd + j, lo[j], hi[j]);
      }
      J[t * n + i] = SW[i] * v;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Levenberg–Marquardt
 * ------------------------------------------------------------------ */

function levenbergMarquardt(model, data, start, free, lo, hi, opts) {
  const { n } = data;
  const nf = free.length;
  const p = Float64Array.from(start);
  for (const j of free) p[j] = clamp(p[j], lo[j], hi[j]);
  let r = new Float64Array(n);
  let rTrial = new Float64Array(n);
  let chi2 = residualVector(model, data, p, r);
  const out = { p, chi2, converged: false, iterations: 0, reason: '' };
  if (!Number.isFinite(chi2)) {
    out.reason = 'nonfinite';
    return out;
  }
  if (nf === 0) {
    out.converged = true;
    return out;
  }

  const tol = opts.tolerance;
  const J = new Float64Array(n * nf);
  const D = new Float64Array(nf);
  const g = new Float64Array(nf);
  const cn = new Float64Array(nf);
  const pTrial = new Float64Array(p.length);
  let mu = 1e-3;
  let nu = 2;
  let iter = 0;

  outer:
  while (iter < opts.maxIterations) {
    iter++;
    if (chi2 === 0 || chi2 <= 1e-30 * data.yy) {
      out.converged = true;
      out.reason = 'exact';
      break;
    }
    jacobian(model, data, p, free, J, lo, hi);
    for (let k = 0; k < nf; k++) {
      const off = k * n;
      let s = 0;
      for (let i = 0; i < n; i++) s += J[off + i] * r[i];
      g[k] = s;
      cn[k] = columnNorm(J, n, k);
      if (cn[k] > D[k]) D[k] = cn[k];
    }

    // A parameter on a bound that the gradient pushes further out stays put.
    const move = [];
    for (let k = 0; k < nf; k++) {
      const j = free[k];
      if ((p[j] <= lo[j] && g[k] <= 0) || (p[j] >= hi[j] && g[k] >= 0)) continue;
      move.push(k);
    }
    const rn = Math.sqrt(chi2);
    let cosine = 0;
    for (const k of move) if (cn[k] > 0) cosine = Math.max(cosine, Math.abs(g[k]) / (cn[k] * rn));
    if (move.length === 0 || cosine <= tol) {
      out.converged = true;
      out.reason = 'gradient';
      break;
    }

    const m = move.length;
    const A = new Float64Array(n * m);
    for (let t = 0; t < m; t++) A.set(J.subarray(move[t] * n, move[t] * n + n), t * n);
    const qr = householderQR(A, n, m);
    const qtr = Float64Array.from(r);
    applyQt(qr, qtr);
    const R = upperR(qr);
    const Dm = Float64Array.from(move, k => D[k] || 1);
    let qn2 = 0;
    for (let t = 0; t < m; t++) qn2 += qtr[t] * qtr[t];
    const step = new Float64Array(m);

    for (;;) {
      const h = dampedStep(R, qtr, Dm, mu, m);
      if (!h.every(Number.isFinite)) {
        // The damped system overflowed (columns of 1e150 and more): no step can be computed.
        out.reason = 'stalled';
        break outer;
      }
      pTrial.set(p);
      let dxn = 0;
      let xn = 0;
      for (let t = 0; t < m; t++) {
        const j = free[move[t]];
        pTrial[j] = clamp(p[j] + h[t], lo[j], hi[j]);
        step[t] = pTrial[j] - p[j];
        dxn += (Dm[t] * step[t]) ** 2;
        xn += (Dm[t] * p[j]) ** 2;
      }
      dxn = Math.sqrt(dxn);
      xn = Math.sqrt(xn);
      // Predicted reduction of chi-square for the step actually taken.
      let left = 0;
      for (let i = 0; i < m; i++) {
        let s = qtr[i];
        for (let j = i; j < m; j++) s -= R[j * m + i] * step[j];
        left += s * s;
      }
      const predicted = qn2 - left;
      const chiTrial = residualVector(model, data, pTrial, rTrial);
      const actual = chi2 - chiTrial;

      if (Number.isFinite(chiTrial) && predicted > 0 && actual > 0) {
        const rho = actual / predicted;
        const before = chi2;
        p.set(pTrial);
        [r, rTrial] = [rTrial, r];
        chi2 = chiTrial;
        mu *= Math.max(1 / 3, 1 - (2 * rho - 1) ** 3);
        nu = 2;
        if ((actual <= tol * before && predicted <= tol * before) || dxn <= tol * (xn + tol)) {
          out.converged = true;
          out.reason = 'small change';
          break outer;
        }
        continue outer;
      }
      // Rejected. A step this small cannot change the answer, so stop here.
      if (dxn <= tol * (xn + tol)) {
        out.converged = true;
        out.reason = 'small step';
        break outer;
      }
      mu *= nu;
      nu *= 2;
      iter++;
      if (!(mu < 1e300)) {
        out.reason = 'stalled';
        break outer;
      }
      if (iter >= opts.maxIterations) break outer;
    }
  }
  if (!out.converged && !out.reason) out.reason = 'iterations';
  out.chi2 = chi2;
  out.iterations = iter;
  return out;
}

/* ------------------------------------------------------------------ *
 * Covariance and identifiability
 * ------------------------------------------------------------------ */

/* Below this ratio of singular values of the column-scaled Jacobian, a
 * direction in parameter space is treated as undetermined. Exact
 * degeneracies (a*b) sit near 1e-16; honest but ill-conditioned models, such
 * as a cubic in years, stay above 1e-9. */
const RANK_TOLERANCE = 1e-11;

function covarianceAt(model, data, p, free, lo, hi) {
  const n = data.n;
  const m = free.length;
  if (m === 0) return { cov: [], groups: [], condition: 1 };
  const J = new Float64Array(n * m);
  jacobian(model, data, p, free, J, lo, hi);
  const cn = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    cn[k] = columnNorm(J, n, k);
    if (cn[k] > 0 && Number.isFinite(cn[k])) {
      const off = k * n;
      for (let i = 0; i < n; i++) J[off + i] /= cn[k];
    }
  }
  const qr = householderQR(J, n, m);
  const { s, V } = jacobiSVD(upperR(qr), m);
  const smax = Math.max(...s);
  const cut = RANK_TOLERANCE * smax;

  const undetermined = new Set();
  const groups = [];
  for (let k = 0; k < m; k++) {
    if (s[k] > cut && smax > 0) continue;
    const members = [];
    for (let j = 0; j < m; j++) if (Math.abs(V[k * m + j]) >= 0.2) members.push(j);
    members.forEach(j => undetermined.add(j));
    groups.push(members);
  }
  for (let k = 0; k < m; k++) {
    if (!(cn[k] > 0 && Number.isFinite(cn[k])) && !undetermined.has(k)) {
      undetermined.add(k);
      groups.push([k]);
    }
  }

  const cov = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let k = 0; k < m; k++) {
    if (!(s[k] > cut) || smax === 0) continue;
    const w = 1 / (s[k] * s[k]);
    for (let i = 0; i < m; i++) {
      const vi = V[k * m + i] * w;
      for (let j = 0; j < m; j++) cov[i][j] += vi * V[k * m + j];
    }
  }
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      if (undetermined.has(i) || undetermined.has(j)) cov[i][j] = i === j ? Infinity : NaN;
      else cov[i][j] /= cn[i] * cn[j];
    }
  }
  const smin = Math.min(...s);
  return { cov, groups, condition: smin > 0 ? smax / smin : Infinity };
}

/* True when the model's residuals at p, and at p with slot j replaced, are bit
 * for bit the same on every row (and finite). */
function sameCurve(model, data, p, j, value, base, trial) {
  const q = Float64Array.from(p);
  q[j] = value;
  if (!Number.isFinite(residualVector(model, data, q, trial))) return false;
  for (let i = 0; i < data.n; i++) if (trial[i] !== base[i]) return false;
  return true;
}

/*
 * True when the equation cannot tell parameter j from its negative, as for
 * the width s of exp(-(x - mu)^2/(2*s^2)). Judged at two arbitrary values,
 * with the other parameters at p; a model undefined there counts as not.
 */
function signBlind(model, data, p, j) {
  const base = new Float64Array(data.n);
  const trial = new Float64Array(data.n);
  const q = Float64Array.from(p);
  for (const v of [0.7, 1.9]) {
    q[j] = v;
    if (!Number.isFinite(residualVector(model, data, q, base))) return false;
    if (!sameCurve(model, data, q, j, -v, base, trial)) return false;
  }
  return true;
}

const TWO_PI = 2 * Math.PI;

/*
 * Report equivalent solutions the way people expect. Which of several equally
 * good values the search lands on is an accident, so:
 *   - a parameter that enters only squared (a Gaussian width) is made
 *     positive, as curve_fit gives from a positive start;
 *   - a phase, which changes nothing when shifted by 2π, is brought into
 *     (-π, π], so sin(w*x + phi) does not report phi = -100000.
 * A change is kept only when the curve is unchanged: bit for bit for the
 * sign, and for the phase no worse after polishing from the shifted value
 * (the shift itself rounds a little). A parameter that does not affect the
 * curve at all is left as it is, and bounds are respected.
 */
function tidyValues(model, data, fit, free, lo, hi, opts) {
  const n = data.n;
  const base = new Float64Array(n);
  const trial = new Float64Array(n);
  const p = fit.p;
  residualVector(model, data, p, base);
  // Whether a nudge to slot j changes the curve; `base` must hold the residuals at `point`.
  const matters = (point, j) =>
    !sameCurve(model, data, point, j, point[j] === 0 ? 1e-6 : point[j] * (1 + 1e-6), base, trial);

  for (const j of free) {
    if (p[j] < 0 && -p[j] <= hi[j] && -p[j] >= lo[j] && matters(p, j) &&
        sameCurve(model, data, p, j, -p[j], base, trial)) {
      p[j] = -p[j];
    }
  }

  let result = fit;
  for (const j of free) {
    const v = result.p[j];
    if (!(Math.abs(v) > Math.PI) || !Number.isFinite(v)) continue;
    const wrapped = v - TWO_PI * Math.round(v / TWO_PI);
    const w = [wrapped, wrapped + TWO_PI, wrapped - TWO_PI]
      .filter(c => c >= lo[j] && c <= hi[j])
      .sort((a, b) => Math.abs(a) - Math.abs(b))[0];
    if (w === undefined || Math.abs(w) >= Math.abs(v)) continue;
    const q = Float64Array.from(result.p);
    q[j] = w;
    const chi2 = residualVector(model, data, q, trial);
    // Cheap test first: a parameter that is not a phase is far off after the
    // shift. The floor is for exact data, whose chi-square is rounding error.
    const floor = data.yy * 1e-20;
    if (!(chi2 <= result.chi2 * (1 + 1e-6) + floor)) continue;
    residualVector(model, data, result.p, base);
    if (!matters(result.p, j)) continue;
    const polished = levenbergMarquardt(model, data, q, free, lo, hi, opts);
    if (polished.converged && polished.chi2 <= result.chi2 * (1 + 1e-9) + floor) {
      polished.iterations += result.iterations;
      result = polished;
    }
  }
  return result;
}

/*
 * An oscillation fits as well with its amplitude negated and its phase half a
 * turn away (a quarter turn for cos(u)^2), and which of the two the search
 * finds is an accident; people expect the positive amplitude. So a pure phase
 * is turned by half a turn, or else a quarter, when that leaves fewer negative
 * linear parameters (the amplitude flips, an offset does not), and the change
 * is kept if the fit polished from there is as good and still has fewer.
 */
function positiveAmplitudes(model, data, fit, free, lo, hi, opts, waves, linear) {
  if (!waves || linear.length === 0) return fit;
  const negatives = p => linear.filter(j => p[j] < 0).length;
  const scratch = linearScratch(data.n, linear.length);
  let result = fit;
  for (const j of waves.pure) {
    if (!free.includes(j)) continue;
    const { vals } = waves;
    vals.set(result.p, 1);
    vals[0] = waves.xs[0];
    const half = Math.PI / Math.abs(waves.turn.get(j)(vals));
    if (!Number.isFinite(half)) continue;
    for (const turn of [half, half / 2]) {
      const before = negatives(result.p);
      if (before === 0) return result;
      const v = result.p[j];
      const turned = [v - turn, v + turn].filter(c => c >= lo[j] && c <= hi[j])
        .sort((a, b) => Math.abs(a) - Math.abs(b))[0];
      if (turned === undefined) continue;
      const q = Float64Array.from(result.p);
      q[j] = turned;
      if (!Number.isFinite(solveLinear(model, data, q, linear, lo, hi, scratch)) || negatives(q) >= before) continue;
      const polished = levenbergMarquardt(model, data, q, free, lo, hi, opts);
      if (polished.converged && negatives(polished.p) < before &&
          polished.chi2 <= result.chi2 * (1 + 1e-9) + data.yy * 1e-20) {
        polished.iterations += result.iterations;
        result = polished;
        break;
      }
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Starting values
 * ------------------------------------------------------------------ */

const GUESS_ROWS = 150;
const START_ROWS = 800;
const GRID_BUDGET = 2e6;

function sortedStats(values) {
  const a = Float64Array.from(values).sort();
  const n = a.length;
  let sum = 0;
  for (const v of a) sum += v;
  return {
    min: a[0],
    max: a[n - 1],
    mean: sum / n,
    median: n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2,
    range: a[n - 1] - a[0],
    absMax: Math.max(Math.abs(a[0]), Math.abs(a[n - 1]))
  };
}

function dataStats(data) {
  const y = sortedStats(data.Y);
  let iMax = 0;
  let iMin = 0;
  let iPeak = 0;
  for (let i = 1; i < data.n; i++) {
    if (data.Y[i] > data.Y[iMax]) iMax = i;
    if (data.Y[i] < data.Y[iMin]) iMin = i;
    if (Math.abs(data.Y[i] - y.median) > Math.abs(data.Y[iPeak] - y.median)) iPeak = i;
  }
  const x = data.X.map(col => ({
    ...sortedStats(col),
    atYMax: col[iMax],
    atYMin: col[iMin],
    atPeak: col[iPeak]
  }));
  if (x.length) {
    const col = data.X[0];
    let iLo = 0;
    let iHi = 0;
    for (let i = 1; i < data.n; i++) {
      if (col[i] < col[iLo]) iLo = i;
      if (col[i] > col[iHi]) iHi = i;
    }
    y.atXMin = data.Y[iLo];
    y.atXMax = data.Y[iHi];
  }
  return { x, y };
}

/* Trial values for a nonlinear parameter: decades of both signs, and scales,
 * positions and rates read off the data. */
function candidateValues(stats, lo, hi) {
  const out = [];
  const seen = new Set();
  const add = v => {
    if (!Number.isFinite(v) || v < lo || v > hi) return;
    const key = Number(v.toPrecision(10));
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  };
  [1, -1, 0.5, 2, 0].forEach(add);
  for (let e = -8; e <= 8; e++) {
    add(10 ** e);
    add(-(10 ** e));
    add(3 * 10 ** e);
    add(-3 * 10 ** e);
  }
  for (const s of stats.x) {
    [s.min, s.max, s.mean, s.median, s.atYMax, s.atYMin, s.atPeak].forEach(add);
    for (let k = 1; k < 10; k++) add(s.min + (k / 10) * s.range);
    for (const d of [1, 2, 4, 10]) {
      add(s.range / d);
      add(d / s.range);
      add(-d / s.range);
    }
    add(1 / s.absMax);
    add(-1 / s.absMax);
  }
  const y = stats.y;
  [y.min, y.max, y.mean, y.range, -y.range, y.atXMin, y.atXMax].forEach(add);
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    add((lo + hi) / 2);
    if (lo > 0) add(Math.sqrt(lo * hi));
  }
  if (Number.isFinite(lo)) add(lo);
  if (Number.isFinite(hi)) add(hi);
  return out;
}

/* A first value suggested by the parameter's name. */
function seedFor(name, stats, independent, lo, hi) {
  const x = stats.x[0];
  let v = 1;
  if (x) {
    const location = new Set(['mu', 'μ', 'xc', 'center', 'centre', 'loc', 'peak', 'pos', 'position']);
    independent.forEach(ind => ['0', '_0', 'c', '_c'].forEach(suffix => location.add(ind + suffix)));
    if (location.has(name)) v = x.atPeak;
    else if (/^(sigma|σ|s|w|width|fwhm|tau|τ|gamma|γ|lambda|λ|scale|hwhm)(_?\d*)$/.test(name)) v = x.range / 4 || 1;
    else if (/^(k|rate|kappa|κ)(_?\d*)$/.test(name)) v = x.range > 0 ? 1 / x.range : 1;
  }
  if (!Number.isFinite(v)) v = 1;
  if (v < lo || v > hi) {
    if (Number.isFinite(lo) && Number.isFinite(hi)) v = (lo + hi) / 2;
    else if (Number.isFinite(lo)) v = lo + Math.max(1, Math.abs(lo));
    else v = hi - Math.max(1, Math.abs(hi));
  }
  return v;
}

/* The free parameters that enter the equation linearly and independently of
 * each other, so that they can be solved for exactly given the rest. An
 * additive constant (derivative 1, as y0 in A*exp(-t/tau) + y0) counts; a
 * parameter the equation does not use (derivative 0) does not. */
function linearSubset(model, candidates, paramNames) {
  const ids = candidates.map(j => (model.dAst[j] ? new Set(symbolsOf(model.dAst[j]).identifiers) : null));
  const chosen = [];
  candidates.forEach((j, t) => {
    const d = model.dAst[j];
    if (!d || !model.df[j] || (d.type === 'number' && d.value === 0) || ids[t].has(paramNames[j])) return;
    const clash = chosen.some(({ j: k, t: u }) => ids[t].has(paramNames[k]) || ids[u].has(paramNames[j]));
    if (!clash) chosen.push({ j, t });
  });
  return chosen.map(c => c.j);
}

/* Work arrays for solveLinear, reused across the thousands of calls a grid makes. */
function linearScratch(n, m) {
  return { r: new Float64Array(n), A: new Float64Array(n * m), b: new Float64Array(n), cn: new Float64Array(m) };
}

/*
 * Set the linear parameters to their least-squares values for the current
 * values of the others; returns the resulting chi-square. Unless a bound
 * clipped the solution, chi-square comes from the factorisation itself,
 * |Rc - (Qᵀb)top|² + |(Qᵀb)bottom|², which saves evaluating the model again.
 */
function solveLinear(model, data, p, linear, lo, hi, scratch) {
  const { n, X, Y, SW } = data;
  const m = linear.length;
  const { f, df, vals, nInd } = model;
  const { A, b, cn } = scratch;
  for (const j of linear) p[j] = 0;
  vals.set(p, nInd);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < nInd; k++) vals[k] = X[k][i];
    const bi = SW[i] * (Y[i] - f(vals));
    if (!Number.isFinite(bi)) return NaN;
    b[i] = bi;
    for (let t = 0; t < m; t++) {
      const a = SW[i] * df[linear[t]](vals);
      if (!Number.isFinite(a)) return NaN;
      A[t * n + i] = a;
    }
  }
  for (let t = 0; t < m; t++) {
    cn[t] = columnNorm(A, n, t) || 1;
    for (let i = 0; i < n; i++) A[t * n + i] /= cn[t];
  }
  const qr = householderQR(A, n, m);
  applyQt(qr, b);
  const c = backSubstitute(qr.A, n, qr.diag, b, m, 1e-10);
  let clipped = false;
  linear.forEach((j, t) => {
    const v = c[t] / cn[t];
    p[j] = clamp(v, lo[j], hi[j]);
    if (p[j] !== v) clipped = true;
  });
  if (clipped) return residualVector(model, data, p, scratch.r);
  let chi2 = 0;
  for (let i = m; i < n; i++) chi2 += b[i] * b[i];
  for (let i = 0; i < m; i++) {
    let s = qr.diag[i] * c[i] - b[i];
    for (let j = i + 1; j < m; j++) s += qr.A[j * n + i] * c[j];
    chi2 += s * s;
  }
  return Number.isFinite(chi2) ? chi2 : NaN;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Oscillations
 * ------------------------------------------------------------------ */

/*
 * An oscillation defeats the general search in three ways. Chi-square as a
 * function of the frequency is a comb of narrow minima, one for each whole
 * number of cycles across the data, so trial values by decades almost never
 * land in the right one. From a wrong frequency the cheapest improvement is
 * often to switch the oscillation off (tau → 0 in exp(-x/tau)*cos(…)), after
 * which the frequency and phase no longer change the curve and nothing leads
 * back. And above the Nyquist limit of the sampling there are frequencies that
 * pass through every point as well as the true one does (aliases). So the
 * frequency is read off the data with a periodogram and turned into a value of
 * whichever parameter sets it; phases are tried at quarter turns; and trial
 * frequencies the points cannot resolve are left out.
 */

const PERIODIC = new Set(['sin', 'cos', 'tan']);
const PERIODOGRAM_ROWS = 1000;
/* Points times frequencies; about 10 ms. */
const PERIODOGRAM_WORK = 4e6;
/* Frequency steps per resolution width, 2π over the range of x. */
const OVERSAMPLE = 5;
const PEAKS = 3;

function occurrences(ast, name) {
  let count = 0;
  for (const node of postOrder(ast)) if (node.type === 'symbol' && node.name === name) count++;
  return count;
}

/* The median gap between neighbouring distinct values. */
function typicalSpacing(values) {
  const a = Float64Array.from(values).sort();
  const range = a[a.length - 1] - a[0];
  if (!(range > 0)) return NaN;
  const gaps = [];
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    if (d > 1e-12 * range) gaps.push(d);
  }
  const g = Float64Array.from(gaps).sort();
  const m = g.length;
  if (m === 0) return NaN;
  return m % 2 ? g[(m - 1) / 2] : (g[m / 2 - 1] + g[m / 2]) / 2;
}

/*
 * The Nyquist limit of the sampling, as an angular frequency: π over the
 * typical spacing. Unevenly spaced data hold some information above it, but a
 * frequency found up there is far more often an alias.
 */
function samplingLimit(values) {
  return Math.PI / typicalSpacing(values);
}

/*
 * The strongest few angular frequencies in y: a Lomb–Scargle periodogram with
 * a floating mean and the fit's weights (Zechmeister and Kürster, 2009), so
 * uneven x is fine, after removing a straight line so that an offset or a
 * trend does not swamp the low frequencies. Frequencies run from half a cycle
 * across the data to the Nyquist limit, a fifth of a resolution width apart,
 * and each peak is refined by a parabola through its neighbours. The cosines
 * and sines are advanced from one frequency to the next by a rotation rather
 * than evaluated afresh, so each point and frequency costs a few
 * multiplications. Returns [{omega, power}], strongest first, with power the
 * fraction of the detrended variance that a sinusoid at omega explains.
 */
function periodogramPeaks(data, count) {
  const sub = subsetData(data, PERIODOGRAM_ROWS);
  const n = sub.n;
  const X = sub.X[0];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (X[i] < lo) lo = X[i];
    if (X[i] > hi) hi = X[i];
  }
  const range = hi - lo;
  const top = samplingLimit(X);
  if (n < 8 || !(range > 0) || !Number.isFinite(top)) return [];

  // Centred x, normalised weights, and the residuals from a weighted line.
  const mid = (lo + hi) / 2;
  const x = Float64Array.from(X, v => v - mid);
  const w = Float64Array.from(sub.SW, s => s * s);
  let sw = 0;
  for (let i = 0; i < n; i++) sw += w[i];
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    w[i] /= sw;
    sx += w[i] * x[i];
    sy += w[i] * sub.Y[i];
  }
  let vxx = 0;
  let vxy = 0;
  for (let i = 0; i < n; i++) {
    vxx += w[i] * (x[i] - sx) ** 2;
    vxy += w[i] * (x[i] - sx) * (sub.Y[i] - sy);
  }
  const slope = vxx > 0 ? vxy / vxx : 0;
  const wr = new Float64Array(n);
  let yy = 0;
  for (let i = 0; i < n; i++) {
    const r = sub.Y[i] - sy - slope * (x[i] - sx);
    wr[i] = w[i] * r;
    yy += wr[i] * r;
  }
  if (!(yy > 0) || !Number.isFinite(yy)) return [];

  const step = TWO_PI / (OVERSAMPLE * range);
  const first = Math.PI / range;
  const nFreq = Math.min(Math.floor((top - first) / step) + 1, Math.floor(PERIODOGRAM_WORK / n));
  if (!(nFreq >= 3)) return [];
  const c = Float64Array.from(x, v => Math.cos(first * v));
  const s = Float64Array.from(x, v => Math.sin(first * v));
  const cd = Float64Array.from(x, v => Math.cos(step * v));
  const sd = Float64Array.from(x, v => Math.sin(step * v));
  const power = new Float64Array(nFreq);
  for (let k = 0; k < nFreq; k++) {
    let C = 0;
    let S = 0;
    let YC = 0;
    let YS = 0;
    let CC = 0;
    let CS = 0;
    for (let i = 0; i < n; i++) {
      const ci = c[i];
      const si = s[i];
      const wc = w[i] * ci;
      C += wc;
      S += w[i] * si;
      YC += wr[i] * ci;
      YS += wr[i] * si;
      CC += wc * ci;
      CS += wc * si;
      c[i] = ci * cd[i] - si * sd[i];
      s[i] = si * cd[i] + ci * sd[i];
    }
    // The residuals have zero weighted mean (the line took it out), so YC and
    // YS need no correction for it; the weights sum to 1, so sin² = 1 - cos².
    const cc = CC - C * C;
    const ss = 1 - CC - S * S;
    const cs = CS - C * S;
    const d = cc * ss - cs * cs;
    power[k] = d > 1e-9 ? (ss * YC * YC + cc * YS * YS - 2 * cs * YC * YS) / (yy * d) : 0;
  }

  const maxima = [];
  for (let k = 0; k < nFreq; k++) {
    const left = k > 0 ? power[k - 1] : -Infinity;
    const right = k < nFreq - 1 ? power[k + 1] : -Infinity;
    if (power[k] > 0 && power[k] >= left && power[k] > right) maxima.push(k);
  }
  maxima.sort((a, b) => power[b] - power[a]);
  const peaks = [];
  for (const k of maxima) {
    // Sidelobes of a peak already taken are not new frequencies.
    if (peaks.some(q => Math.abs(q.k - k) < 1.5 * OVERSAMPLE)) continue;
    let shift = 0;
    if (k > 0 && k < nFreq - 1) {
      const curve = power[k - 1] - 2 * power[k] + power[k + 1];
      if (curve < 0) shift = clamp((0.5 * (power[k - 1] - power[k + 1])) / curve, -0.5, 0.5);
    }
    peaks.push({ k, omega: first + (k + shift) * step, power: power[k] });
    if (peaks.length >= count) break;
  }
  return peaks.map(q => ({ omega: q.omega, power: q.power }));
}

/*
 * The oscillating parts of the equation, for one independent variable x. In
 * each sin, cos or tan whose argument u changes with x, a searched parameter
 * that appears in du/dx sets the frequency (w in sin(w*x + phi), f in
 * cos(2*pi*f*t), T in sin(2*pi*t/T)); one that appears only in u shifts the
 * phase (phi, or t0 in sin(w*(t - t0))). A shift is a pure phase when it
 * appears nowhere else and only linearly, so that its values repeat every
 * 2π/|du/dphi|. Also returns the periodogram peaks, the Nyquist limit of the
 * data, and a few x values at which to measure how fast a trial argument
 * turns. Null when nothing searched oscillates.
 */
function analyseWaves(model, data, paramNames, searched) {
  if (model.nInd !== 1 || data.n < 2) return null;
  const x = model.names[0];
  const index = new Map(paramNames.map((name, j) => [name, j]));
  const wanted = new Set(searched);
  const terms = [];
  for (const node of postOrder(model.ast)) {
    if (node.type !== 'call' || !PERIODIC.has(node.name)) continue;
    const u = node.args[0];
    const ids = symbolsOf(u).identifiers;
    if (!ids.includes(x)) continue;
    const du = differentiate(u, x);
    if (!du) continue;
    const inRate = new Set(symbolsOf(du).identifiers);
    const term = { u, rate: compile(du, model.names), frequency: [], phase: [] };
    for (const id of ids) {
      const j = index.get(id);
      if (j === undefined || !wanted.has(j)) continue;
      (inRate.has(id) ? term.frequency : term.phase).push(j);
    }
    if (term.frequency.length || term.phase.length) terms.push(term);
  }
  if (terms.length === 0) return null;

  const frequency = [...new Set(terms.flatMap(t => t.frequency))];
  const phase = [...new Set(terms.flatMap(t => t.phase))].filter(j => !frequency.includes(j));
  const turn = new Map();
  const pure = new Set();
  for (const j of phase) {
    const name = paramNames[j];
    const own = terms.filter(t => t.phase.includes(j));
    const dus = own.map(t => differentiate(t.u, name));
    if (dus.some(d => !d)) continue;
    turn.set(j, compile(dus[0], model.names));
    const inside = own.reduce((acc, t) => acc + occurrences(t.u, name), 0);
    if (inside === occurrences(model.ast, name) && dus.every(d => !symbolsOf(d).identifiers.includes(name))) {
      pure.add(j);
    }
  }

  // x at both ends and at a few rows between, enough to catch the fastest
  // turn of an argument such as a*x + b*x^2.
  const col = data.X[0];
  let iLo = 0;
  let iHi = 0;
  for (let i = 1; i < data.n; i++) {
    if (col[i] < col[iLo]) iLo = i;
    if (col[i] > col[iHi]) iHi = i;
  }
  const xs = [col[iLo], col[iHi]];
  for (let k = 1; k < 8; k++) xs.push(col[Math.round((k * (data.n - 1)) / 8)]);

  const nyquist = samplingLimit(col);
  let peaks = [];
  if (frequency.length && Number.isFinite(nyquist)) {
    peaks = periodogramPeaks(data, PEAKS).filter(q => q.omega <= nyquist * (1 + 1e-9));
  }
  return {
    terms, frequency, phase, pure, turn, peaks, nyquist,
    xs: Float64Array.from(xs),
    vals: new Float64Array(model.names.length)
  };
}

/* How fast one term's argument turns with x at the parameter values p: the
 * largest |du/dx| over the sample x. A rate that is infinite at one x, as for
 * sin(w*sqrt(x)) at 0, says nothing about the sampling and is passed over. */
function turnRate(waves, term, p) {
  const { vals, xs } = waves;
  vals.set(p, 1);
  let top = 0;
  for (const x of xs) {
    vals[0] = x;
    const r = Math.abs(term.rate(vals));
    if (r > top && r < Infinity) top = r;
  }
  return top;
}

/* The fastest turn among the terms whose rate parameter j (any frequency
 * parameter, for j < 0) helps to set. */
function fastestTurn(waves, p, j = -1) {
  let top = 0;
  for (const term of waves.terms) {
    if (j >= 0 ? !term.frequency.includes(j) : term.frequency.length === 0) continue;
    top = Math.max(top, turnRate(waves, term, p));
  }
  return top;
}

/*
 * Values of frequency parameter j that make the argument of one of its terms
 * turn at each rate in `omegas`, the others held at p; one term at a time, so
 * that in a*cos(w*t) + b*cos(2*w*t) either can match the peak. The rate is
 * measured, not assumed to be the parameter itself: probes at 1 and 2 give the
 * power law (w^1 for w*x, f^1 with a factor 2π for 2*pi*f*x, T^-1 for
 * 2*pi*x/T), which is solved and then checked. A value outside the bounds is
 * replaced by its negative when that is inside; with `bothSigns` (nothing
 * else could absorb the sign) both are returned.
 */
function valuesForRates(waves, j, p, omegas, lo, hi, bothSigns) {
  const q = Float64Array.from(p);
  const out = [];
  const add = v => {
    if (v >= lo[j] && v <= hi[j] && !out.some(u => Math.abs(u - v) <= 1e-9 * Math.abs(v))) out.push(v);
  };
  for (const term of waves.terms) {
    if (!term.frequency.includes(j)) continue;
    const rate = v => {
      q[j] = v;
      return turnRate(waves, term, q);
    };
    const r1 = rate(1);
    const r2 = rate(2);
    if (!(r1 > 0 && r2 > 0 && Number.isFinite(r1) && Number.isFinite(r2))) continue;
    const power = Math.log2(r2 / r1);
    if (!(Math.abs(power) > 0.1)) continue;
    for (const omega of omegas) {
      let v = (omega / r1) ** (1 / power);
      for (let k = 0; k < 3 && Number.isFinite(v); k++) {
        const r = rate(v);
        if (!(r > 0) || Math.abs(r / omega - 1) < 1e-9) break;
        v *= (omega / r) ** (1 / power);
      }
      if (!(Math.abs(rate(v) / omega - 1) < 1e-3)) continue;
      if (bothSigns) {
        add(v);
        add(-v);
      } else {
        add(v >= lo[j] && v <= hi[j] ? v : -v);
      }
    }
  }
  return out;
}

/*
 * Starting points for the coordinate descent: every combination of the trial
 * frequencies (for two frequency parameters, of the first few each) with the
 * phases at quarter turns, ranked by chi-square with the other parameters at
 * their seeds. The best three with different frequencies are returned. Without
 * these, the descent from a wrong frequency tends to switch the oscillation off.
 */
function waveStarts(waves, evaluate, seeded, frequency, phases, targets, lo, hi) {
  let points = [seeded];
  for (const j of frequency.slice(0, 2)) {
    const values = targets.get(j).slice(0, frequency.length > 1 ? 4 : Infinity);
    if (values.length === 0) continue;
    points = points.flatMap(p => values.map(v => {
      const q = Float64Array.from(p);
      q[j] = v;
      return q;
    }));
  }
  for (const j of phases.slice(0, 2)) {
    points = points.flatMap(p => {
      const values = phaseValues(waves, j, p, 4, lo, hi);
      return values.length ? values.map(v => {
        const q = Float64Array.from(p);
        q[j] = v;
        return q;
      }) : [p];
    });
  }
  const ranked = points.map(evaluate).filter(r => r.chi2 < Infinity).sort((a, b) => a.chi2 - b.chi2);
  const out = [];
  for (const r of ranked) {
    if (out.some(q => frequency.every(j => q[j] === r.p[j]))) continue;
    out.push(r.p);
    if (out.length >= 3) break;
  }
  return out;
}

/* Values of phase parameter j that turn its argument by each of `steps` equal
 * parts of a circle from zero, brought inside the bounds by whole turns. */
function phaseValues(waves, j, p, steps, lo, hi) {
  const { vals } = waves;
  vals.set(p, 1);
  vals[0] = waves.xs[0];
  const perUnit = Math.abs(waves.turn.get(j)?.(vals));
  if (!(perUnit > 0) || !Number.isFinite(perUnit)) return [];
  const period = TWO_PI / perUnit;
  const out = [];
  for (let m = 1 - steps / 2; m <= steps / 2; m++) {
    let v = (m * period) / steps;
    if (v < lo[j]) v += period * Math.ceil((lo[j] - v) / period);
    if (v > hi[j]) v -= period * Math.ceil((v - hi[j]) / period);
    if (v >= lo[j] && v <= hi[j]) out.push(v);
  }
  return out;
}

/*
 * Ranked starting points. Parameters with a starting value keep it; the
 * linear ones among the rest are solved exactly for each trial; the
 * nonlinear ones are searched over a full grid when that is affordable, and
 * by coordinate descent from name-based seeds when it is not. Parameters
 * that set the frequency or phase of an oscillation get the trial values
 * described under Oscillations, and the descent also starts from each
 * periodogram peak.
 */
function startingPoints(ctx, unknown) {
  const { model, guessData, base, lo, hi, stats, paramNames, waves } = ctx;
  const linear = linearSubset(model, unknown, paramNames);
  const nonlinear = unknown.filter(j => !linear.includes(j));
  const scratch = linearScratch(guessData.n, linear.length);
  const found = [];

  const evaluate = p => {
    const q = Float64Array.from(p);
    const chi2 = linear.length
      ? solveLinear(model, guessData, q, linear, lo, hi, scratch)
      : residualVector(model, guessData, q, scratch.r);
    if (Number.isFinite(chi2)) found.push({ chi2, p: q });
    return { chi2: Number.isFinite(chi2) ? chi2 : Infinity, p: q };
  };

  const seeded = Float64Array.from(base);
  for (const j of nonlinear) seeded[j] = seedFor(paramNames[j], stats, ctx.independent, lo[j], hi[j]);

  // Oscillations: each frequency starts at the strongest peak (the others, and
  // half of each for the likes of sin(w*t)^2, are trial values), each phase at 0.
  const frequency = waves ? waves.frequency.filter(j => nonlinear.includes(j)) : [];
  const phases = waves ? waves.phase.filter(j => nonlinear.includes(j)) : [];
  const targets = new Map();
  if (waves) {
    const omegas = waves.peaks.flatMap(q => [q.omega, q.omega / 2]);
    const bothSigns = linear.length === 0 && phases.length === 0;
    for (const j of frequency) {
      const values = valuesForRates(waves, j, seeded, omegas, lo, hi, bothSigns);
      targets.set(j, values);
      if (values.length) seeded[j] = values[0];
    }
    for (const j of phases) {
      if (!waves.pure.has(j)) continue;
      const values = phaseValues(waves, j, seeded, 4, lo, hi);
      if (values.length) seeded[j] = values.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
    }
  }
  // Trial frequencies above what these points can resolve would find aliases.
  // Judged only for a parameter that sets its rate alone: in a*x + b*x^2 the
  // rate at a trial a depends on the b it will be paired with.
  const limit = waves ? Math.min(waves.nyquist, samplingLimit(guessData.X[0])) : NaN;
  const resolvable = (j, v) => {
    if (waves.terms.some(t => t.frequency.includes(j) && t.frequency.length > 1)) return true;
    const q = Float64Array.from(seeded);
    q[j] = v;
    return !(fastestTurn(waves, q, j) > limit * (1 + 1e-9));
  };
  // Every frequency read off the data: the search can concentrate there.
  const tuned = frequency.length > 0 && frequency.every(j => targets.get(j).length);

  if (nonlinear.length === 0) {
    evaluate(seeded);
  } else {
    // A width that enters only squared needs no negative trials: they repeat the
    // positive ones. Unless the bounds allow only negative values.
    const lists = nonlinear.map(j => {
      const values = candidateValues(stats, lo[j], hi[j]);
      const positive = values.filter(v => v >= 0);
      const list = positive.length && signBlind(model, guessData, seeded, j) ? positive : values;
      if (frequency.includes(j)) {
        const kept = Number.isFinite(limit) ? list.filter(v => resolvable(j, v)) : list;
        return [...new Set([...targets.get(j), ...(kept.length ? kept : list)])];
      }
      if (phases.includes(j)) {
        // A pure phase repeats every turn, so eighth turns cover it; decades would not.
        if (waves.pure.has(j)) {
          const turns = phaseValues(waves, j, seeded, 8, lo, hi);
          if (turns.length) return turns;
        }
        return [...new Set([...list, ...phaseValues(waves, j, seeded, 4, lo, hi)])];
      }
      return list;
    });
    const total = lists.reduce((acc, l) => acc * Math.max(1, l.length), 1);
    // With a frequency read off the data, a descent from each peak finds what
    // the grid would, for a small part of the cost.
    const budget = tuned ? GRID_BUDGET / 10 : GRID_BUDGET;
    if (total * guessData.n <= budget) {
      const p = Float64Array.from(seeded);
      const recurse = t => {
        if (t === nonlinear.length) {
          evaluate(p);
          return;
        }
        for (const v of lists[t]) {
          p[nonlinear[t]] = v;
          recurse(t + 1);
        }
      };
      recurse(0);
    } else {
      const ones = Float64Array.from(seeded);
      for (const j of nonlinear) ones[j] = clamp(1, lo[j], hi[j]);
      // Starts at the periodogram peaks make the name-based ones redundant.
      const waveSeeds = waves ? waveStarts(waves, evaluate, seeded, frequency, phases, targets, lo, hi) : [];
      const seeds = tuned && waveSeeds.length ? waveSeeds : [...waveSeeds, seeded, ones];
      for (const seed of seeds) {
        let current = evaluate(seed);
        for (let sweep = 0; sweep < 4; sweep++) {
          let improved = false;
          nonlinear.forEach((j, t) => {
            for (const v of lists[t]) {
              const trial = Float64Array.from(current.p);
              trial[j] = v;
              const res = evaluate(trial);
              if (res.chi2 < current.chi2 * (1 - 1e-9)) {
                current = res;
                improved = true;
              }
            }
          });
          if (!improved) break;
        }
      }
    }
  }

  found.sort((a, b) => a.chi2 - b.chi2);
  const picked = [];
  for (const cand of found) {
    const distinct = picked.every(q => nonlinear.some(j => {
      const a = cand.p[j];
      const b = q.p[j];
      return Math.abs(a - b) > 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1e-300);
    }));
    if (picked.length === 0 || distinct) picked.push(cand);
    if (picked.length >= 4) break;
  }
  return picked.map(c => c.p);
}

/* ------------------------------------------------------------------ *
 * Diagnosing a model that cannot be evaluated
 * ------------------------------------------------------------------ */

function childrenOf(node) {
  switch (node.type) {
    case 'unary': return [node.arg];
    case 'binary': return [node.left, node.right];
    case 'call': return node.args;
    default: return [];
  }
}

function postOrder(node, out = []) {
  for (const c of childrenOf(node)) postOrder(c, out);
  out.push(node);
  return out;
}

function failureReason(node, args) {
  const [a, b] = args;
  const overflow = 'a result too large to represent';
  if (node.type === 'binary') {
    if (node.op === '/') return b === 0 ? 'division by zero' : overflow;
    if (node.op === '^') {
      if (a < 0 && !Number.isInteger(b)) return 'a negative number raised to a fractional power';
      if (a === 0 && b < 0) return 'zero raised to a negative power';
    }
    return overflow;
  }
  if (node.type === 'call') {
    const name = node.name === 'ln' ? 'log' : node.name.replace(/^arc/, 'a');
    switch (name) {
      case 'log': case 'log10': case 'log2':
        return a === 0 ? 'the logarithm of zero' : 'the logarithm of a negative number';
      case 'sqrt': return 'the square root of a negative number';
      case 'asin': case 'acos': case 'atanh': return 'an argument outside -1 to 1';
      case 'acosh': return 'an argument below 1';
      case 'gamma': case 'lgamma':
        return a <= 0 && Number.isInteger(a) ? 'zero or a negative whole number, where gamma is infinite' : overflow;
      case 'pow':
        if (a < 0 && !Number.isInteger(b)) return 'a negative number raised to a fractional power';
        if (a === 0 && b < 0) return 'zero raised to a negative power';
        return overflow;
      default: return overflow;
    }
  }
  return 'an undefined value';
}

function diagnoseNonFinite(model, data, p, paramSet) {
  const nodes = postOrder(model.ast);
  const fns = nodes.map(nd => compile(nd, model.names));
  const index = new Map(nodes.map((nd, i) => [nd, i]));
  const { vals, nInd } = model;
  vals.set(p, nInd);
  const tally = new Map();
  const values = new Float64Array(nodes.length);
  const rows = Math.min(data.n, 5000);
  for (let i = 0; i < rows; i++) {
    for (let k = 0; k < nInd; k++) vals[k] = data.X[k][i];
    for (let t = 0; t < nodes.length; t++) values[t] = fns[t](vals);
    for (let t = 0; t < nodes.length; t++) {
      if (Number.isFinite(values[t])) continue;
      const kids = childrenOf(nodes[t]).map(c => values[index.get(c)]);
      if (!kids.every(Number.isFinite)) continue;
      const entry = tally.get(t) ?? { count: 0, first: i, args: kids };
      entry.count++;
      tally.set(t, entry);
      break;
    }
  }
  if (tally.size === 0) {
    return 'The equation gives values too large to work with at the starting values. ' +
      'Try starting values closer to the data.';
  }
  const [t, info] = [...tally.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  const node = nodes[t];
  const involved = symbolsOf(node).identifiers.filter(id => paramSet.has(id));
  const rowsText = info.count === 1 ? '1 row' : `${info.count} rows`;
  let message = `The equation cannot be evaluated: ${toText(node)} is undefined ` +
    `(${failureReason(node, info.args)}) for ${rowsText}, first at row ${data.rows[info.first] + 1}.`;
  message += involved.length
    ? ` Give starting values for ${involved.join(', ')} that keep it defined, or set bounds.`
    : ' That part does not depend on any parameter, so remove those rows or change the equation.';
  return message;
}

/* ------------------------------------------------------------------ *
 * Input handling
 * ------------------------------------------------------------------ */

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' ? NaN : Number(s);
  }
  return NaN;
}

function optionalNumber(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = toNumber(v);
  return Number.isNaN(n) ? fallback : n;
}

function failure(message, extra = {}) {
  return {
    ok: false,
    message,
    converged: false,
    iterations: 0,
    parameters: [],
    warnings: [],
    ...extra
  };
}

function listNames(names) {
  const quoted = names.map(n => `'${n}'`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Fit an equation to data by nonlinear least squares.
 *
 * @param {object} spec
 * @param {object} [spec.ast] - Right-hand side AST from expression.js.
 * @param {string} [spec.expression] - Or the equation as typed; parsed with
 *   `parseEquation`, so `y = …`, `f(x) = …` and a bare right side all work.
 * @param {string[]} [spec.independent] - Variables bound to data columns.
 *   Default: the names in the equation that have a column, else the guess
 *   from `classify`.
 * @param {Array<{name:string, initial?:number, min?:number, max?:number,
 *         fixed?:boolean}|string>} [spec.parameters] - Output order. Default:
 *   every other name, from `classify`. A fixed parameter needs `initial`.
 * @param {Object<string, ArrayLike<number|string>>} spec.columns - One array
 *   per independent variable.
 * @param {ArrayLike<number|string>} spec.y - Observations. May instead be
 *   given as `columns[dependent]`.
 * @param {ArrayLike<number|string>} [spec.sigma] - 1-sigma uncertainties of y.
 * @param {boolean} [spec.absoluteSigma=false] - As in curve_fit: when false,
 *   sigma gives relative weights and the covariance is scaled by the reduced
 *   chi-square; when true it is not scaled.
 * @param {number} [spec.maxIterations=500]
 * @param {number} [spec.tolerance=1e-10] - Relative change in chi-square and
 *   in the scaled parameters at which the fit has converged.
 * @param {boolean} [spec.multistart=true] - Retry from other starting points
 *   when the first attempt fails, cannot separate its parameters, or fits
 *   poorly (R² < 0.99).
 * @returns {object} On success `{ok:true, message, converged, iterations,
 *   parameters:[{name, value, stderr, ci:[lo,hi], fixed, atBound, bound}],
 *   free, covariance, correlation, n, dof, rss, chi2, reducedChi2, r2, adjR2,
 *   rmse, aic, bic, predicted, residuals, rows, predict, band, warnings, …}`.
 *   `ci` is the 95% interval with Student's t. `covariance` and `correlation`
 *   cover the free parameters, in the order of `free`. `rss` and `rmse` are
 *   unweighted, in the units of y; `chi2`, `r2`, `aic` and `bic` use the
 *   weights when sigma is given. A fixed parameter reports `stderr: 0` and a
 *   zero-width interval. `rows` maps each entry of `predicted`/`residuals` to
 *   its original row. On failure `{ok:false, message, warnings, error?}`,
 *   where `error` carries the offsets of a parse error.
 */
export function fitModel(spec) {
  try {
    return fitModelUnchecked(spec ?? {});
  } catch (err) {
    return failure(`The fit stopped unexpectedly: ${err && err.message ? err.message : String(err)}`);
  }
}

function fitModelUnchecked(spec) {
  const warnings = [];
  const opts = {
    maxIterations: Math.max(1, Math.floor(optionalNumber(spec.maxIterations, 500))) || 500,
    tolerance: optionalNumber(spec.tolerance, 1e-10) > 0 ? optionalNumber(spec.tolerance, 1e-10) : 1e-10
  };
  const multistart = spec.multistart !== false;
  const absoluteSigma = spec.absoluteSigma === true;

  /* The equation */
  let ast = spec.ast && typeof spec.ast === 'object' ? spec.ast : null;
  let dependent = null;
  let eqArguments = null;
  let notes = [];
  if (!ast) {
    if (typeof spec.expression !== 'string') return failure('Type an equation to fit, such as y = a*x + b.');
    const eq = parseEquation(spec.expression);
    if (!eq.ok) return failure(eq.error.message, { error: eq.error });
    ast = eq.ast;
    dependent = eq.dependent;
    eqArguments = eq.arguments;
    notes = eq.notes;
  }
  const info = classify(ast, { arguments: eqArguments ?? undefined, dependent: dependent ?? undefined });
  if (info.unknownFunctions.length) {
    return failure(`Unknown function ${listNames(info.unknownFunctions)}.`);
  }
  const identifiers = symbolsOf(ast).identifiers;
  const columns = spec.columns && typeof spec.columns === 'object' ? spec.columns : {};

  /* Independent variables */
  let independent;
  if (Array.isArray(spec.independent) && spec.independent.length) {
    independent = spec.independent.map(String);
  } else {
    const withColumns = identifiers.filter(id => Object.hasOwn(columns, id) && id !== dependent);
    independent = withColumns.length ? withColumns : info.independent;
  }
  if (independent.length === 0) {
    return failure('Say which name in the equation is the variable measured along the x axis.');
  }
  if (new Set(independent).size !== independent.length) {
    return failure('A variable is listed twice.');
  }

  /* Parameters */
  const specs = [];
  if (Array.isArray(spec.parameters)) {
    for (const raw of spec.parameters) {
      const ps = typeof raw === 'string' ? { name: raw } : raw;
      if (!ps || typeof ps.name !== 'string' || ps.name === '') return failure('Every parameter needs a name.');
      specs.push(ps);
    }
  } else {
    const indSet = new Set(independent);
    for (const name of info.parameters) if (!indSet.has(name)) specs.push({ name });
    // classify guessed its own independent variables; any it took that the
    // caller did not are parameters here.
    for (const name of info.independent) {
      if (!indSet.has(name) && !specs.some(s => s.name === name)) specs.push({ name });
    }
  }
  const paramNames = specs.map(s => s.name);
  if (new Set(paramNames).size !== paramNames.length) return failure('A parameter is listed twice.');
  const clash = paramNames.find(n => independent.includes(n));
  if (clash) return failure(`'${clash}' cannot be both a variable and a parameter.`);

  // Names in the equation that are neither variables, parameters nor constants.
  const known = new Set([...independent, ...paramNames]);
  const constantsForced = new Set(paramNames);
  for (const id of identifiers) {
    if (known.has(id)) continue;
    if ((id === 'pi' || id === 'e') && !constantsForced.has(id)) continue;
    specs.push({ name: id });
    paramNames.push(id);
    known.add(id);
    warnings.push(`'${id}' was not in the parameter list, so it is fitted as a parameter.`);
  }

  const nPar = paramNames.length;
  const lo = new Float64Array(nPar);
  const hi = new Float64Array(nPar);
  const fixed = new Array(nPar).fill(false);
  const initial = new Array(nPar).fill(undefined);
  for (let j = 0; j < nPar; j++) {
    const s = specs[j];
    lo[j] = optionalNumber(s.min, -Infinity);
    hi[j] = optionalNumber(s.max, Infinity);
    if (lo[j] > hi[j]) return failure(`The lower bound of '${s.name}' is above its upper bound.`);
    const init = optionalNumber(s.initial, undefined);
    if (init !== undefined && Number.isFinite(init)) {
      if (init < lo[j] || init > hi[j]) {
        warnings.push(`The starting value of '${s.name}' was outside its bounds and was moved inside.`);
      }
      initial[j] = clamp(init, lo[j], hi[j]);
    }
    fixed[j] = Boolean(s.fixed);
    if (fixed[j] && initial[j] === undefined) return failure(`Give a value for '${s.name}' to hold it fixed.`);
    if (!identifiers.includes(s.name) && !fixed[j]) {
      fixed[j] = true;
      if (initial[j] === undefined) initial[j] = 0;
      warnings.push(`'${s.name}' does not appear in the equation, so it was not fitted.`);
    }
  }
  const free = [];
  for (let j = 0; j < nPar; j++) if (!fixed[j]) free.push(j);

  /* Data */
  let yRaw = spec.y;
  if (yRaw == null && dependent && Object.hasOwn(columns, dependent)) yRaw = columns[dependent];
  if (yRaw == null || typeof yRaw.length !== 'number') return failure('No y values were given.');
  const total = yRaw.length;
  for (const name of independent) {
    const col = columns[name];
    if (col == null || typeof col.length !== 'number') return failure(`No data column for '${name}'.`);
    if (col.length !== total) {
      return failure(`The '${name}' column has ${col.length} values but y has ${total}.`);
    }
  }
  const sigmaRaw = spec.sigma ?? null;
  if (sigmaRaw != null && (typeof sigmaRaw.length !== 'number' || sigmaRaw.length !== total)) {
    return failure(`The uncertainties have ${sigmaRaw?.length ?? 0} values but y has ${total}.`);
  }

  const keep = [];
  let blank = 0;
  let badSigma = 0;
  for (let i = 0; i < total; i++) {
    let ok = Number.isFinite(toNumber(yRaw[i]));
    for (const name of independent) ok = ok && Number.isFinite(toNumber(columns[name][i]));
    if (!ok) {
      blank++;
      continue;
    }
    if (sigmaRaw) {
      const s = toNumber(sigmaRaw[i]);
      if (!(s > 0) || !Number.isFinite(s)) {
        badSigma++;
        continue;
      }
    }
    keep.push(i);
  }
  if (blank) warnings.push(`Dropped ${blank} row${blank === 1 ? '' : 's'} with a blank or non-numeric value.`);
  if (badSigma) {
    warnings.push(`Dropped ${badSigma} row${badSigma === 1 ? '' : 's'} whose uncertainty was missing, zero or negative.`);
  }
  const n = keep.length;
  const data = {
    n,
    X: independent.map(name => Float64Array.from(keep, i => toNumber(columns[name][i]))),
    Y: Float64Array.from(keep, i => toNumber(yRaw[i])),
    SW: Float64Array.from(keep, i => (sigmaRaw ? 1 / toNumber(sigmaRaw[i]) : 1)),
    rows: Int32Array.from(keep)
  };
  data.yy = weightedSquares(data);
  const nFree = free.length;
  if (n <= nFree) {
    return failure(`${n} usable data point${n === 1 ? '' : 's'} cannot determine ${nFree} free ` +
      `parameter${nFree === 1 ? '' : 's'}; you need at least ${nFree + 1}. Add data or hold some parameters fixed.`,
    { warnings });
  }

  /* Model */
  const model = prepareModel(ast, independent, paramNames);
  const stats = dataStats(data);
  const base = new Float64Array(nPar);
  for (let j = 0; j < nPar; j++) base[j] = initial[j] ?? 1;
  const unknown = free.filter(j => initial[j] === undefined);
  const waves = analyseWaves(model, data, paramNames, unknown);
  // The subsets that the search and the first fits use must resolve the
  // oscillation too: six points or more to a cycle of the fastest strong peak.
  let guessRows = GUESS_ROWS;
  let startRows = START_ROWS;
  if (waves && waves.peaks.length) {
    const strong = waves.peaks.filter(q => q.power >= 0.25 * waves.peaks[0].power);
    const needed = Math.ceil((3 * n * Math.max(...strong.map(q => q.omega))) / waves.nyquist);
    guessRows = clamp(needed, GUESS_ROWS, START_ROWS);
    startRows = Math.max(needed, START_ROWS);
  }
  const ctx = {
    model, lo, hi, stats, paramNames, independent, base, waves,
    guessData: subsetData(data, guessRows)
  };
  const startData = subsetData(data, startRows);

  let starts = startingPoints(ctx, unknown);
  if (starts.length === 0 && unknown.length < nFree && multistart) {
    // The given starting values make the equation undefined; search instead.
    starts = startingPoints(ctx, free);
    if (starts.length) warnings.push('The starting values given make the equation undefined, so others were used.');
  }
  if (starts.length === 0) {
    const seeded = Float64Array.from(base);
    for (const j of unknown) seeded[j] = seedFor(paramNames[j], stats, independent, lo[j], hi[j]);
    return failure(diagnoseNonFinite(model, data, seeded, new Set(free.map(j => paramNames[j]))), { warnings });
  }

  /* Fit, retrying from other starts when the first attempt is not good */
  const tssOf = d => {
    let sw = 0;
    let swy = 0;
    for (let i = 0; i < d.n; i++) {
      const w = d.SW[i] * d.SW[i];
      sw += w;
      swy += w * d.Y[i];
    }
    const mean = swy / sw;
    let s = 0;
    for (let i = 0; i < d.n; i++) s += (d.SW[i] * (d.Y[i] - mean)) ** 2;
    return s;
  };
  const startTss = tssOf(startData);
  // A frequency the points cannot resolve, which the search avoids but a fit
  // can still wander to.
  const aliased = res => Boolean(waves?.frequency.length) &&
    fastestTurn(waves, res.p) > waves.nyquist * (1 + 1e-6);
  const isGood = res => {
    if (!res.converged || !Number.isFinite(res.chi2) || aliased(res)) return false;
    if (startTss > 0 && 1 - res.chi2 / startTss < 0.99) return false;
    return covarianceAt(model, startData, res.p, free, lo, hi).groups.length === 0;
  };
  const better = (a, b) => {
    if (!b || !Number.isFinite(b.chi2)) return Number.isFinite(a.chi2);
    if (!Number.isFinite(a.chi2)) return false;
    const ta = aliased(a);
    if (ta !== aliased(b)) {
      // An alias meets the points about as well as the true frequency, so it
      // must fit clearly better to be preferred; an exact fit to exact data is
      // not clearly better than another exact fit.
      const tie = Math.max(a.chi2, b.chi2) * 1e-6 + startData.yy * 1e-20;
      return ta ? a.chi2 < b.chi2 - tie : a.chi2 <= b.chi2 + tie;
    }
    if (a.chi2 < b.chi2 * (1 - 1e-9)) return true;
    return a.chi2 <= b.chi2 * (1 + 1e-9) && a.converged && !b.converged;
  };

  let best = levenbergMarquardt(model, startData, starts[0], free, lo, hi, opts);
  if (multistart && nFree > 0 && !isGood(best)) {
    const linearAll = linearSubset(model, free, paramNames);
    const rand = mulberry32(20240929);
    const scratch = linearScratch(startData.n, linearAll.length);
    const extra = starts.slice(1);
    for (let k = 0; k < 6; k++) {
      const from = Number.isFinite(best.chi2) ? best.p : starts[0];
      const q = Float64Array.from(from);
      for (const j of free) {
        if (linearAll.includes(j)) continue;
        const v = q[j];
        let nv = v === 0 ? 2 * rand() - 1 : v * 10 ** (2 * rand() - 1);
        if (rand() < 0.15) nv = -nv;
        q[j] = clamp(nv, lo[j], hi[j]);
      }
      if (linearAll.length) solveLinear(model, startData, q, linearAll, lo, hi, scratch);
      extra.push(q);
    }
    for (const s of extra) {
      const res = levenbergMarquardt(model, startData, s, free, lo, hi, opts);
      if (better(res, best)) best = res;
      if (isGood(best)) break;
    }
  }
  let fit = best;
  if (startData !== data && Number.isFinite(best.chi2)) {
    fit = levenbergMarquardt(model, data, best.p, free, lo, hi, opts);
  }
  if (!Number.isFinite(fit.chi2)) {
    return failure(diagnoseNonFinite(model, data, fit.p, new Set(free.map(j => paramNames[j]))), { warnings });
  }
  fit = positiveAmplitudes(model, data, fit, free, lo, hi, opts, waves, linearSubset(model, free, paramNames));
  fit = tidyValues(model, data, fit, free, lo, hi, opts);

  return buildResult({
    model, data, fit, free, fixed, lo, hi, paramNames, independent, dependent,
    absoluteSigma, weighted: Boolean(sigmaRaw), warnings, notes, opts
  });
}

function buildResult(r) {
  const { model, data, fit, free, fixed, lo, hi, paramNames, independent, warnings, opts } = r;
  const { n } = data;
  const p = fit.p;
  const nFree = free.length;
  const dof = n - nFree;
  const chi2 = fit.chi2;

  /* Residuals and goodness of fit */
  const predicted = new Float64Array(n);
  const residuals = new Float64Array(n);
  const { vals, nInd, f } = model;
  vals.set(p, nInd);
  let rss = 0;
  let sw = 0;
  let swy = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < nInd; k++) vals[k] = data.X[k][i];
    predicted[i] = f(vals);
    residuals[i] = data.Y[i] - predicted[i];
    rss += residuals[i] * residuals[i];
    const w = data.SW[i] * data.SW[i];
    sw += w;
    swy += w * data.Y[i];
  }
  const meanY = swy / sw;
  let tss = 0;
  for (let i = 0; i < n; i++) tss += (data.SW[i] * (data.Y[i] - meanY)) ** 2;
  const r2 = tss > 0 ? 1 - chi2 / tss : chi2 === 0 ? 1 : NaN;
  const adjR2 = dof > 0 && Number.isFinite(r2) ? 1 - ((1 - r2) * (n - 1)) / dof : NaN;
  const logLike = n * Math.log(chi2 / n);

  /* Covariance, scaled as curve_fit does */
  const covInfo = covarianceAt(model, data, p, free, lo, hi);
  const scale = r.absoluteSigma ? 1 : chi2 / dof;
  const covariance = covInfo.cov.map(row => row.map(v => v * scale));
  const correlation = covariance.map((row, i) => row.map((v, j) => {
    if (i === j) return 1;
    const d = Math.sqrt(covariance[i][i] * covariance[j][j]);
    return d > 0 && Number.isFinite(d) ? v / d : NaN;
  }));
  const t975 = studentTQuantile(0.975, dof);

  const freeIndex = new Map(free.map((j, k) => [j, k]));
  const parameters = paramNames.map((name, j) => {
    const value = p[j];
    if (fixed[j]) return { name, value, stderr: 0, ci: [value, value], fixed: true, atBound: false, bound: null };
    const k = freeIndex.get(j);
    const variance = covariance[k][k];
    const stderr = variance >= 0 ? Math.sqrt(variance) : variance === Infinity ? Infinity : NaN;
    const bound = value <= lo[j] ? 'lower' : value >= hi[j] ? 'upper' : null;
    return {
      name, value, stderr,
      ci: [value - t975 * stderr, value + t975 * stderr],
      fixed: false,
      atBound: bound !== null,
      bound
    };
  });

  /* Warnings and the headline message */
  const messages = [];
  for (const group of covInfo.groups) {
    const names = group.map(k => paramNames[free[k]]);
    if (names.length === 1) {
      messages.push(`The fit does not change with '${names[0]}' at these data, so it cannot be determined. ` +
        'Hold it fixed or remove it from the equation.');
    } else if (names.length > 1) {
      messages.push(`${listNames(names)} cannot be told apart: the data fix only a combination of them ` +
        '(such as a product or ratio). Hold one of them fixed or rewrite the equation.');
    }
  }
  for (const prm of parameters) {
    if (prm.atBound) {
      warnings.push(`'${prm.name}' finished at its ${prm.bound} bound (${prm.value}). The best fit may lie ` +
        'beyond it, and its uncertainty is not reliable.');
    }
  }
  if (!covInfo.groups.length) {
    let worst = null;
    for (let i = 0; i < nFree; i++) {
      for (let j = i + 1; j < nFree; j++) {
        const c = correlation[i][j];
        if (Math.abs(c) > 0.999 && (!worst || Math.abs(c) > Math.abs(worst.c))) worst = { i, j, c };
      }
    }
    if (worst) {
      warnings.push(`${listNames([paramNames[free[worst.i]], paramNames[free[worst.j]]])} are strongly correlated ` +
        `(r = ${worst.c.toFixed(4)}), so each is poorly determined on its own even though the curve is well defined.`);
    }
  }
  if (chi2 === 0 && !r.absoluteSigma) {
    warnings.push('The curve passes through every point exactly, so the uncertainties come out as zero.');
  }
  if (!fit.converged && fit.reason === 'stalled') {
    messages.push(`The fit stopped after ${fit.iterations} iteration${fit.iterations === 1 ? '' : 's'} without ` +
      'settling, because no further step improved it; these are the best values found, and may not be the best ' +
      'fit. Try other starting values or a simpler equation.');
  } else if (!fit.converged) {
    messages.push(`The fit did not settle within ${opts.maxIterations} iterations; these are the best values ` +
      'found. Try starting values closer to the data, or allow more iterations.');
  }
  warnings.push(...messages);
  const message = messages.length ? messages[0]
    : `Converged after ${fit.iterations} iteration${fit.iterations === 1 ? '' : 's'}.`;

  /* Evaluation after the fit */
  const fillPoint = point => {
    vals.set(p, nInd);
    if (typeof point === 'number') {
      vals[0] = point;
      for (let k = 1; k < nInd; k++) vals[k] = NaN;
    } else {
      for (let k = 0; k < nInd; k++) vals[k] = toNumber(point?.[independent[k]]);
    }
  };
  const predict = point => {
    fillPoint(point);
    return f(vals);
  };
  const band = (points, level = 0.95) => {
    const list = Array.isArray(points) ? points : [];
    const lower = new Float64Array(list.length);
    const upper = new Float64Array(list.length);
    const tq = studentTQuantile(0.5 + level / 2, dof);
    const grad = new Float64Array(nFree);
    list.forEach((point, idx) => {
      fillPoint(point);
      const y = f(vals);
      for (let k = 0; k < nFree; k++) {
        const j = free[k];
        const g = model.df[j] ? model.df[j](vals) : NaN;
        grad[k] = Number.isFinite(g) ? g : numericDerivative(model, nInd + j, lo[j], hi[j]);
      }
      let variance = 0;
      for (let a = 0; a < nFree; a++) {
        if (grad[a] === 0) continue;
        for (let b = 0; b < nFree; b++) {
          if (grad[b] !== 0) variance += grad[a] * covariance[a][b] * grad[b];
        }
      }
      const half = tq * Math.sqrt(variance);
      lower[idx] = y - half;
      upper[idx] = y + half;
    });
    return { lower, upper };
  };

  return {
    ok: true,
    message,
    converged: fit.converged,
    iterations: fit.iterations,
    parameters,
    free: free.map(j => paramNames[j]),
    covariance,
    correlation,
    n,
    dof,
    rss,
    chi2,
    reducedChi2: chi2 / dof,
    r2,
    adjR2,
    rmse: Math.sqrt(rss / n),
    aic: logLike + 2 * nFree,
    bic: logLike + nFree * Math.log(n),
    predicted,
    residuals,
    rows: data.rows,
    predict,
    band,
    warnings,
    notes: r.notes,
    expression: toText(model.ast),
    dependent: r.dependent,
    independent: [...independent],
    weighted: r.weighted,
    absoluteSigma: r.absoluteSigma,
    condition: covInfo.condition
  };
}
