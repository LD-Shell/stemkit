/**
 * @module core/expression
 *
 * Parse, inspect, evaluate and differentiate the equations people type into
 * the curve fitter, such as `y = A*exp(-t/tau) + y0` or
 * `I(V) = I0*(exp(V/(n*Vt)) - 1)`.
 *
 * Nothing here uses `eval` or `new Function`. An equation is parsed into a
 * small syntax tree and compiled into nested closures, so a typed equation can
 * only ever compute arithmetic. The same tree gives the derivatives the fitter
 * needs for its Jacobian, the LaTeX shown on the page and the text of the
 * exported Python.
 *
 * Reading rules, chosen to match how equations are written on paper:
 *
 *   - `^` and `**` both mean power and group from the right, so `2^3^2` is
 *     2^9. Unary minus binds more loosely than power: `-x^2` is -(x^2).
 *   - A number followed by a name or a bracket multiplies (`2x`, `3(x+1)`,
 *     `2 pi`, `2exp(x)`), as does a closing bracket followed by a name or a
 *     bracket (`(a+b)(c+d)`), and two names separated by a space (`b x`).
 *     Implicit multiplication has the same precedence as `*` and reads left to
 *     right, so `t/2tau` is (t/2)*tau; the parser adds a note when it meets
 *     that pattern, because people usually mean t/(2*tau).
 *   - Names are letters (any alphabet, so α and τ work), digits and
 *     underscores, starting with a letter or underscore. `bx` is therefore ONE
 *     name, not b times x, and `x2` is a name too. Write `b x` or `b*x`.
 *   - A name followed by a bracket is a call when the name is a known
 *     function. Otherwise it is multiplication, so `A(1 - exp(-k*t))` means A
 *     times the bracket. Two kinds of name are treated specially. One that
 *     differs from a function only in case, or is another common spelling of
 *     one (`Sin(x)`, `lg(x)`), is an error with a suggestion, since it can
 *     only have been meant as a call. One a letter or two away from a
 *     function (`expo(x)`, `Imax(1 - x)`) still multiplies, because names like
 *     Imax are ordinary parameters, but a note names the function in case it
 *     was meant. Known function names always call, so `gamma(1 - x)` is the
 *     gamma function; write `gamma*(1 - x)` for a parameter called gamma. On
 *     the left of `=`, `f(x) =` and `I(V) =` list the independent variables.
 *   - Brackets are matched before anything else is read, so an unclosed one
 *     is reported even when something earlier is also amiss.
 *   - `pi` and `e` are constants. A caller can turn either into a parameter.
 *   - Conveniences for pasted text: `×`, `·` and `−` are read as `*` and `-`,
 *     superscript digits as powers (`x²`), `[ ]` and `{ }` as brackets, NumPy
 *     prefixes are dropped (`np.exp`), and so is a LaTeX backslash (`\tau`).
 *
 * Positions in error objects are zero-based offsets into the text, in UTF-16
 * code units as JavaScript counts them. Positions quoted inside messages count
 * from 1, as a person reading the equation would.
 */

/* ------------------------------------------------------------------ *
 * Special functions
 * ------------------------------------------------------------------ */

const SQRT_PI = Math.sqrt(Math.PI);
const TWO_OVER_SQRT_PI = 2 / SQRT_PI;
const LN_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);

/*
 * erf by its power series, all of whose terms are positive:
 * erf(x) = 2/sqrt(pi) exp(-x^2) sum (2x^2)^n x / (1*3*...*(2n+1)).
 * Unlike the alternating Taylor series it loses no digits to cancellation.
 */
function erfSeries(x) {
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n < 300; n++) {
    term *= (2 * x2) / (2 * n + 1);
    sum += term;
    if (Math.abs(term) < 1e-17 * Math.abs(sum)) break;
  }
  return TWO_OVER_SQRT_PI * Math.exp(-x2) * sum;
}

/*
 * erfc by its continued fraction (modified Lentz), for x >= 2.5 where the
 * fraction converges quickly and 1 - erf would lose the digits that matter.
 */
function erfcFraction(x) {
  const tiny = 1e-300;
  let f = x;
  let C = x;
  let D = 0;
  for (let k = 1; k < 2000; k++) {
    const a = k / 2;
    D = x + a * D;
    if (D === 0) D = tiny;
    D = 1 / D;
    C = x + a / C;
    if (C === 0) C = tiny;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x * x) / (SQRT_PI * f);
}

/**
 * Error function, accurate to a few units in the last place.
 *
 * @param {number} x
 * @returns {number}
 */
function erf(x) {
  if (Number.isNaN(x)) return NaN;
  const ax = Math.abs(x);
  if (ax < 2.5) return erfSeries(x);
  const tail = ax > 27 ? 0 : erfcFraction(ax);
  return x < 0 ? tail - 1 : 1 - tail;
}

/**
 * Complementary error function, 1 - erf(x), keeping relative accuracy in the
 * far tail where erf itself rounds to 1.
 *
 * @param {number} x
 * @returns {number}
 */
function erfc(x) {
  if (Number.isNaN(x)) return NaN;
  if (x < 2.5) return 1 - erf(x);
  return x > 27 ? 0 : erfcFraction(x);
}

/* Lanczos approximation, g = 7, n = 9: about 15 significant digits. */
const LANCZOS_G = 7;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
];

function lanczosSum(x) {
  let a = LANCZOS[0];
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return a;
}

/**
 * Gamma function. Exact factorials for positive integers up to 171, the
 * reflection formula below 1/2, and NaN at the poles (negative integers),
 * as scipy.special.gamma gives.
 *
 * @param {number} x
 * @returns {number}
 */
function gamma(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (Number.isInteger(x)) {
    if (x === 0) return Object.is(x, -0) ? -Infinity : Infinity;
    if (x < 0) return NaN;
    let r = 1;
    for (let k = 2; k < x && r !== Infinity; k++) r *= k;
    return r;
  }
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  if (x > 171.7) return Infinity;
  const z = x - 1;
  const t = z + LANCZOS_G + 0.5;
  // Split the power so that t^(z+1/2) cannot overflow before exp(-t) reins it in.
  const h = Math.pow(t, (z + 0.5) / 2);
  return Math.sqrt(2 * Math.PI) * h * (h * Math.exp(-t)) * lanczosSum(z);
}

/**
 * Natural logarithm of |Γ(x)|, as scipy.special.gammaln; finite far beyond
 * the point where Γ itself overflows.
 *
 * @param {number} x
 * @returns {number}
 */
function lgamma(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x <= 0 && Number.isInteger(x)) return Infinity;
  if (x < 0.5) {
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  }
  if (x === 1 || x === 2) return 0;
  const z = x - 1;
  const t = z + LANCZOS_G + 0.5;
  return LN_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(lanczosSum(z));
}

/**
 * Digamma ψ(x) = d/dx ln Γ(x), needed for the derivatives of gamma and
 * lgamma. Recurrence up to x >= 10, then the asymptotic series.
 *
 * @param {number} x
 * @returns {number}
 */
function digamma(x) {
  if (Number.isNaN(x)) return NaN;
  if (x <= 0 && Number.isInteger(x)) return NaN;
  if (x < 0) return digamma(1 - x) - Math.PI / Math.tan(Math.PI * x);
  let r = 0;
  while (x < 10) {
    r -= 1 / x;
    x += 1;
  }
  const f = 1 / (x * x);
  return r + Math.log(x) - 0.5 / x -
    f * (1 / 12 - f * (1 / 120 - f * (1 / 252 - f * (1 / 240 - f / 132))));
}

/** Normalised sinc, sin(πx)/(πx), with sinc(0) = 1, as numpy.sinc. */
function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/* d/dx sinc(x) = (cos(πx) - sinc(x))/x, with its series near zero where the
 * closed form is 0/0. */
function sincDerivative(x) {
  if (Math.abs(x) < 1e-4) {
    const p2 = Math.PI * Math.PI;
    return -p2 * x / 3 + p2 * p2 * x * x * x / 30;
  }
  return (Math.cos(Math.PI * x) - sinc(x)) / x;
}

/** Unit step with H(0) = 0.5, as numpy.heaviside(x, 0.5). */
function heaviside(x) {
  if (Number.isNaN(x)) return NaN;
  return x < 0 ? 0 : x > 0 ? 1 : 0.5;
}

/* Round half to even, as numpy.round does, so the page and the exported
 * Python agree on 2.5 -> 2. Math.round would give 3. */
function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * The special functions used by the compiled equations, exposed so the fitter
 * (and tests) can use exactly the same implementations.
 *
 * @type {{erf:Function, erfc:Function, gamma:Function, lgamma:Function,
 *         digamma:Function, sinc:Function, heaviside:Function}}
 */
export const special = Object.freeze({ erf, erfc, gamma, lgamma, digamma, sinc, heaviside });

/* ------------------------------------------------------------------ *
 * Functions and constants
 * ------------------------------------------------------------------ */

function entry(arity, description, python, extra = {}) {
  return Object.freeze({ arity, description, python, ...extra });
}

/**
 * The functions an equation may call.
 *
 * `arity` is the number of arguments, or `[min, max]`. `python` is the
 * NumPy/SciPy spelling: call it with the arguments, `np.exp(u)`, or, when it
 * contains '…', substitute the comma-separated arguments for the '…'
 * (`np.heaviside(…, 0.5)` becomes `np.heaviside(u, 0.5)`). Alias entries carry
 * `aliasOf`, naming the entry they duplicate, so a list shown to people can
 * group them.
 *
 * `log` is the natural logarithm, as in NumPy; `sinc` is NumPy's normalised
 * sinc, sin(πx)/(πx); `round` rounds halves to even, as NumPy does;
 * `heaviside(0)` is 0.5.
 *
 * @type {Readonly<Object<string, {arity:number|number[], description:string,
 *        python:string, aliasOf?:string}>>}
 */
export const FUNCTIONS = Object.freeze({
  exp: entry(1, 'Exponential, e to the power of x', 'np.exp'),
  log: entry(1, 'Natural logarithm (base e)', 'np.log'),
  ln: entry(1, 'Natural logarithm, the same as log', 'np.log', { aliasOf: 'log' }),
  log10: entry(1, 'Base-10 logarithm', 'np.log10'),
  log2: entry(1, 'Base-2 logarithm', 'np.log2'),
  sqrt: entry(1, 'Square root', 'np.sqrt'),
  cbrt: entry(1, 'Cube root, real for negative numbers too', 'np.cbrt'),
  abs: entry(1, 'Absolute value', 'np.abs'),
  sign: entry(1, 'Sign: -1, 0 or 1', 'np.sign'),
  sin: entry(1, 'Sine of an angle in radians', 'np.sin'),
  cos: entry(1, 'Cosine of an angle in radians', 'np.cos'),
  tan: entry(1, 'Tangent of an angle in radians', 'np.tan'),
  asin: entry(1, 'Inverse sine, in radians', 'np.arcsin'),
  acos: entry(1, 'Inverse cosine, in radians', 'np.arccos'),
  atan: entry(1, 'Inverse tangent, in radians', 'np.arctan'),
  atan2: entry(2, 'Angle of the point (x, y), written atan2(y, x), in radians', 'np.arctan2'),
  sinh: entry(1, 'Hyperbolic sine', 'np.sinh'),
  cosh: entry(1, 'Hyperbolic cosine', 'np.cosh'),
  tanh: entry(1, 'Hyperbolic tangent', 'np.tanh'),
  asinh: entry(1, 'Inverse hyperbolic sine', 'np.arcsinh'),
  acosh: entry(1, 'Inverse hyperbolic cosine', 'np.arccosh'),
  atanh: entry(1, 'Inverse hyperbolic tangent', 'np.arctanh'),
  erf: entry(1, 'Error function', 'scipy.special.erf'),
  erfc: entry(1, 'Complementary error function, 1 - erf(x)', 'scipy.special.erfc'),
  gamma: entry(1, 'Gamma function, gamma(n) = (n - 1)!', 'scipy.special.gamma'),
  lgamma: entry(1, 'Natural log of the absolute value of the gamma function', 'scipy.special.gammaln'),
  pow: entry(2, 'Power: pow(a, b) is a^b', 'np.power'),
  min: entry(2, 'The smaller of two values', 'np.minimum'),
  max: entry(2, 'The larger of two values', 'np.maximum'),
  heaviside: entry(1, 'Unit step: 0 below zero, 1 above, 0.5 at zero', 'np.heaviside(…, 0.5)'),
  floor: entry(1, 'Round down to an integer', 'np.floor'),
  ceil: entry(1, 'Round up to an integer', 'np.ceil'),
  round: entry(1, 'Round to the nearest integer, halves to even as NumPy does', 'np.round'),
  sinc: entry(1, 'Normalised sinc, sin(pi x)/(pi x), with sinc(0) = 1, as NumPy defines it', 'np.sinc'),
  arcsin: entry(1, 'Inverse sine, the same as asin', 'np.arcsin', { aliasOf: 'asin' }),
  arccos: entry(1, 'Inverse cosine, the same as acos', 'np.arccos', { aliasOf: 'acos' }),
  arctan: entry(1, 'Inverse tangent, the same as atan', 'np.arctan', { aliasOf: 'atan' }),
  arctan2: entry(2, 'The same as atan2(y, x)', 'np.arctan2', { aliasOf: 'atan2' }),
  arcsinh: entry(1, 'Inverse hyperbolic sine, the same as asinh', 'np.arcsinh', { aliasOf: 'asinh' }),
  arccosh: entry(1, 'Inverse hyperbolic cosine, the same as acosh', 'np.arccosh', { aliasOf: 'acosh' }),
  arctanh: entry(1, 'Inverse hyperbolic tangent, the same as atanh', 'np.arctanh', { aliasOf: 'atanh' })
});

/*
 * Implementations, keyed by canonical name. Names starting with '$' are
 * internal: they appear only in derivatives, and cannot be typed because '$'
 * is not part of the name grammar.
 */
const IMPL = Object.freeze({
  exp: Math.exp, log: Math.log, log10: Math.log10, log2: Math.log2,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: Math.sign,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  erf, erfc, gamma, lgamma, pow: Math.pow,
  min: (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.min(a, b)),
  max: (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.max(a, b)),
  heaviside, floor: Math.floor, ceil: Math.ceil, round: roundHalfEven, sinc,
  $digamma: digamma, $dsinc: sincDerivative
});

function canonical(name) {
  return Object.hasOwn(FUNCTIONS, name) ? (FUNCTIONS[name].aliasOf ?? name) : name;
}

/**
 * Named constants. They are not fitted unless the caller asks for that (see
 * `classify`).
 *
 * @type {Readonly<Object<string, {value:number, description:string,
 *        python:string, latex:string}>>}
 */
export const CONSTANTS = Object.freeze({
  pi: Object.freeze({ value: Math.PI, description: 'pi, 3.14159…', python: 'np.pi', latex: '\\pi' }),
  e: Object.freeze({ value: Math.E, description: "Euler's number, 2.71828…, the base of natural logarithms", python: 'np.e', latex: 'e' })
});

/**
 * Physical constants that people often leave as symbols in an equation, such
 * as R in k = A*exp(-Ea/(R*T)). They are never applied automatically, since R
 * might equally be a radius; `classify` lists the ones that appear as
 * `suggestedConstants` so the page can offer to hold them fixed. Left free, R
 * and Ea could not both be fitted, because only their ratio affects k.
 *
 * @type {Readonly<Object<string, {value:number, units:string, description:string}>>}
 */
export const PHYSICAL_CONSTANTS = (() => {
  const c = (value, units, description) => Object.freeze({ value, units, description });
  const kB = c(1.380649e-23, 'J/K', 'Boltzmann constant');
  const NA = c(6.02214076e23, '1/mol', 'Avogadro constant');
  const Vt = c(0.025692579, 'V', 'Thermal voltage kT/q at 25 °C');
  return Object.freeze({
    R: c(8.314462618, 'J/(mol K)', 'Molar gas constant'),
    k_B: kB, kB,
    N_A: NA, NA,
    F: c(96485.33212, 'C/mol', 'Faraday constant'),
    h: c(6.62607015e-34, 'J s', 'Planck constant'),
    hbar: c(1.054571817e-34, 'J s', 'Reduced Planck constant'),
    Vt, V_T: Vt, VT: Vt
  });
})();

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

const GREEK = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta',
  'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi',
  'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi',
  'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi',
  'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega'
];
const GREEK_SET = new Set(GREEK);
const GREEK_CHARS = Object.freeze({
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon',
  'ϵ': 'epsilon', 'ζ': 'zeta', 'η': 'eta', 'θ': 'theta', 'ϑ': 'vartheta',
  'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'mu', 'µ': 'mu', 'ν': 'nu',
  'ξ': 'xi', 'π': 'pi', 'ρ': 'rho', 'σ': 'sigma', 'ς': 'varsigma',
  'τ': 'tau', 'υ': 'upsilon', 'φ': 'phi', 'ϕ': 'phi', 'χ': 'chi', 'ψ': 'psi',
  'ω': 'omega', 'Γ': 'Gamma', 'Δ': 'Delta', 'Θ': 'Theta', 'Λ': 'Lambda',
  'Ξ': 'Xi', 'Π': 'Pi', 'Σ': 'Sigma', 'Υ': 'Upsilon', 'Φ': 'Phi',
  'Ψ': 'Psi', 'Ω': 'Omega'
});

/*
 * Function names that may also stand alone as ordinary names, because people
 * use them for parameters: gamma the Greek letter, min and max for plateau
 * levels. Every other function name used without brackets is an error, since
 * `sin x` or `exp` alone is almost always a slip.
 */
const NAME_OK_WITHOUT_BRACKETS = new Set(['gamma', 'min', 'max']);

/* Misspellings and foreign spellings worth a direct suggestion. */
const SUGGEST = Object.freeze({
  lg: 'log10', log_10: 'log10', log_2: 'log2', log_e: 'log', sgn: 'sign',
  step: 'heaviside', fabs: 'abs', power: 'pow', sqr: 'sqrt', sen: 'sin',
  tg: 'tan', arctg: 'atan'
});

function editDistance(a, b) {
  // Optimal string alignment: insertions, deletions, substitutions and
  // adjacent transpositions each cost 1, so 'epx' is one step from 'exp'.
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/*
 * The function a name was probably meant to be, or null. `certain` is true
 * when the name is another spelling of the function (the SUGGEST table, or
 * the same letters in another case), and false when it is merely a letter or
 * two away, which ordinary parameter names such as Imax often are. Greek
 * letters and names with digits or underscores are taken to be parameters
 * (tau(1 - x) is tau times the bracket), and short names are only matched
 * ignoring case, so n(1 - x) is not mistaken for ln.
 */
function suggestFunction(name) {
  if (Object.hasOwn(SUGGEST, name)) return { name: SUGGEST[name], certain: true };
  if (GREEK_SET.has(name) || Object.hasOwn(GREEK_CHARS, name)) return null;
  const lower = name.toLowerCase();
  const names = Object.keys(FUNCTIONS);
  const sameLetters = names.find(f => f.toLowerCase() === lower);
  if (sameLetters) return { name: sameLetters, certain: true };
  if ([...name].length < 3 || /[_\d]/.test(name)) return null;
  const limit = name.length >= 5 ? 2 : 1;
  let best = null;
  let bestDistance = limit + 1;
  for (const f of names) {
    if (FUNCTIONS[f].aliasOf) continue;
    const dist = editDistance(lower, f);
    if (dist < bestDistance) {
      best = f;
      bestDistance = dist;
    }
  }
  return best ? { name: best, certain: false } : null;
}

/* ------------------------------------------------------------------ *
 * Tokeniser
 * ------------------------------------------------------------------ */

const T_NUM = 'number';
const T_ID = 'ident';
const T_OP = 'op';
const T_OPEN = 'open';
const T_CLOSE = 'close';
const T_COMMA = 'comma';
const T_EQ = 'equals';
const T_END = 'end';

const RE_SPACE = /\s+/y;
const RE_NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const RE_IDENT = /[\p{L}_][\p{L}\p{M}\p{Nd}_]*/uy;
const RE_LATEX_WORD = /[A-Za-z]+/y;

const OP_CHARS = Object.freeze({
  '+': '+', '-': '-', '−': '-', '–': '-', '*': '*', '×': '*', '·': '*',
  '⋅': '*', '∙': '*', '/': '/', '÷': '/', '∕': '/', '^': '^'
});
const BRACKETS = Object.freeze({ '(': ')', '[': ']', '{': '}' });
const CLOSERS = new Set([')', ']', '}']);
const SUPERSCRIPT_DIGITS = Object.freeze({
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9'
});
/* NumPy and friends: `np.exp(x)` pasted from Python reads as `exp(x)`. */
const MODULE_PREFIXES = new Set(['np', 'numpy', 'math', 'scipy', 'special', 'sp']);
const CHARACTER_HINTS = Object.freeze({
  '|': 'Write abs(x) for an absolute value.',
  '√': 'Write sqrt(x) for a square root.',
  '!': 'Write gamma(n + 1) for the factorial n!.',
  '°': 'Angles are in radians; multiply degrees by pi/180.',
  ';': 'Separate the arguments of a function with commas.'
});

function isDigit(ch) {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function tokenize(text) {
  const tokens = [];
  const n = text.length;
  const fail = (message, start, end) => ({ ok: false, error: { message, start, end } });
  let i = 0;

  while (i < n) {
    const ch = text[i];

    RE_SPACE.lastIndex = i;
    if (RE_SPACE.test(text)) {
      i = RE_SPACE.lastIndex;
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1]))) {
      RE_NUMBER.lastIndex = i;
      const raw = RE_NUMBER.exec(text)[0];
      const end = i + raw.length;
      if (text[end] === '.') {
        let j = end;
        while (j < n && (isDigit(text[j]) || text[j] === '.')) j++;
        return fail(`Malformed number '${text.slice(i, j)}'`, i, j);
      }
      tokens.push({ type: T_NUM, value: Number(raw), raw, start: i, end });
      i = end;
      continue;
    }

    RE_IDENT.lastIndex = i;
    const ident = RE_IDENT.exec(text);
    if (ident) {
      let name = ident[0];
      let end = i + name.length;
      while (MODULE_PREFIXES.has(name) && text[end] === '.') {
        RE_IDENT.lastIndex = end + 1;
        const next = RE_IDENT.exec(text);
        if (!next) break;
        name = next[0];
        end = end + 1 + name.length;
      }
      if (name === 'π') name = 'pi';
      tokens.push({ type: T_ID, value: name, start: i, end });
      i = end;
      continue;
    }

    if (ch === '\\') {
      RE_LATEX_WORD.lastIndex = i + 1;
      const word = RE_LATEX_WORD.exec(text);
      if (!word) {
        if (/[,;:! ]/.test(text[i + 1] ?? '')) {
          i += 2;
          continue;
        }
        return fail("Unexpected character '\\'", i, i + 1);
      }
      const w = word[0];
      const end = i + 1 + w.length;
      if (w === 'cdot' || w === 'times') tokens.push({ type: T_OP, value: '*', start: i, end });
      else if (w === 'div') tokens.push({ type: T_OP, value: '/', start: i, end });
      else if (w === 'frac') return fail("Write fractions with '/', for example (a + b)/(c + d)", i, end);
      else if (w !== 'left' && w !== 'right') tokens.push({ type: T_ID, value: w, start: i, end });
      i = end;
      continue;
    }

    if (Object.hasOwn(SUPERSCRIPT_DIGITS, ch) || ch === '⁻' || ch === '⁺') {
      let j = i;
      const minus = text[j] === '⁻';
      if (text[j] === '⁻' || text[j] === '⁺') j++;
      let digits = '';
      while (j < n && Object.hasOwn(SUPERSCRIPT_DIGITS, text[j])) digits += SUPERSCRIPT_DIGITS[text[j++]];
      if (!digits) return fail(`Unexpected character '${ch}'`, i, i + 1);
      tokens.push({ type: T_OP, value: '^', start: i, end: j });
      if (minus) tokens.push({ type: T_OP, value: '-', start: i, end: j });
      tokens.push({ type: T_NUM, value: Number(digits), raw: digits, start: i, end: j });
      i = j;
      continue;
    }

    if (Object.hasOwn(OP_CHARS, ch)) {
      if (ch === '*' && text[i + 1] === '*') {
        tokens.push({ type: T_OP, value: '^', start: i, end: i + 2 });
        i += 2;
      } else {
        tokens.push({ type: T_OP, value: OP_CHARS[ch], start: i, end: i + 1 });
        i += 1;
      }
      continue;
    }
    if (Object.hasOwn(BRACKETS, ch)) {
      tokens.push({ type: T_OPEN, value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (CLOSERS.has(ch)) {
      tokens.push({ type: T_CLOSE, value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: T_COMMA, value: ',', start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '=') {
      tokens.push({ type: T_EQ, value: '=', start: i, end: i + 1 });
      i += 1;
      continue;
    }

    const cp = String.fromCodePoint(text.codePointAt(i));
    const hint = CHARACTER_HINTS[cp];
    return fail(`Unexpected character '${cp}'${hint ? `. ${hint}` : ''}`, i, i + cp.length);
  }

  tokens.push({ type: T_END, value: '', start: n, end: n });
  return { ok: true, tokens };
}

/* ------------------------------------------------------------------ *
 * Parser
 * ------------------------------------------------------------------ */

class ParseError extends Error {
  constructor(message, start, end) {
    super(message);
    this.start = start;
    this.end = end;
  }
}

const MAX_DEPTH = 200;

function makeBinary(op, left, right, implicit = false) {
  const node = { type: 'binary', op, left, right, start: left.start, end: right.end };
  if (implicit) node.implicit = true;
  return node;
}

function arityText(arity) {
  if (Array.isArray(arity)) return `${arity[0]} to ${arity[1]} arguments`;
  return `${arity} argument${arity === 1 ? '' : 's'}`;
}

/*
 * Recursive descent, one method per precedence level:
 *   sum     := product (('+' | '-') product)*
 *   product := unary (('*' | '/') unary | implicit power)*
 *   unary   := ('+' | '-') unary | power
 *   power   := primary ('^' unary)?          right-associative
 *   primary := number | name | name '(' args ')' | '(' sum ')'
 */
class Parser {
  constructor(text, tokens) {
    this.text = text;
    this.tokens = tokens;
    this.pos = 0;
    this.depth = 0;
    this.notes = [];
  }

  peek() {
    return this.tokens[this.pos];
  }

  prev() {
    return this.pos > 0 ? this.tokens[this.pos - 1] : null;
  }

  next() {
    return this.tokens[this.pos++];
  }

  slice(tok) {
    return this.text.slice(tok.start, tok.end);
  }

  isOp(tok, ...ops) {
    return tok.type === T_OP && ops.includes(tok.value);
  }

  enter(tok) {
    if (++this.depth > MAX_DEPTH) {
      throw new ParseError('The equation is nested too deeply to read', tok.start, tok.end);
    }
  }

  parseSum() {
    this.enter(this.peek());
    let left = this.parseProduct();
    while (this.isOp(this.peek(), '+', '-')) {
      const op = this.next();
      left = makeBinary(op.value, left, this.parseProduct());
    }
    this.depth--;
    return left;
  }

  parseProduct() {
    let left = this.parseUnary();
    let lastDivision = null;
    for (;;) {
      const tok = this.peek();
      if (this.isOp(tok, '*', '/')) {
        this.next();
        left = makeBinary(tok.value, left, this.parseUnary());
        lastDivision = tok.value === '/' ? left : null;
      } else if (tok.type === T_ID || tok.type === T_OPEN) {
        const right = this.parsePower();
        if (lastDivision) this.noteDivision(lastDivision, right);
        left = makeBinary('*', left, right, true);
        lastDivision = null;
      } else if (tok.type === T_NUM) {
        const p = this.prev();
        throw new ParseError(`Missing an operator between '${this.slice(p)}' and '${this.slice(tok)}'`,
          p.start, tok.end);
      } else {
        return left;
      }
    }
  }

  noteDivision(division, factor) {
    const written = this.text.slice(division.start, factor.end);
    const num = toText(division.left);
    const den = toText(division.right);
    const f = toText(factor);
    this.notes.push(`'${written}' is read as (${num}/${den})*${f}. ` +
      `Write ${num}/(${den}*${f}) if you meant to divide by both.`);
  }

  parseUnary() {
    const tok = this.peek();
    if (this.isOp(tok, '+', '-')) {
      this.next();
      this.enter(tok);
      const arg = this.parseUnary();
      this.depth--;
      return { type: 'unary', op: tok.value, arg, start: tok.start, end: arg.end };
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePrimary();
    if (this.isOp(this.peek(), '^')) {
      const op = this.next();
      this.enter(op);
      const exponent = this.parseUnary();
      this.depth--;
      return makeBinary('^', base, exponent);
    }
    return base;
  }

  parsePrimary() {
    const tok = this.peek();
    if (tok.type === T_NUM) {
      this.next();
      return { type: 'number', value: tok.value, raw: tok.raw, start: tok.start, end: tok.end };
    }
    if (tok.type === T_ID) return this.parseName();
    if (tok.type === T_OPEN) {
      const open = this.next();
      if (this.peek().type === T_CLOSE) {
        const close = this.peek();
        throw new ParseError(`Empty brackets: put something inside '${open.value}${close.value}'`,
          open.start, close.end);
      }
      const inner = this.parseSum();
      const close = this.expectClose(open);
      return { ...inner, start: open.start, end: close.end };
    }
    throw this.unexpected(tok);
  }

  parseName() {
    const tok = this.next();
    const name = tok.value;
    const after = this.peek();

    if (after.type === T_OPEN) {
      if (Object.hasOwn(FUNCTIONS, name)) return this.parseCall(tok);
      const suggestion = suggestFunction(name);
      const didYouMean = suggestion ? `. Did you mean ${suggestion.name}?` : '';
      if (suggestion?.certain) {
        throw new ParseError(`Unknown function '${name}'${didYouMean}`, tok.start, tok.end);
      }
      // Not a function: A(1 - x) is A times the bracket.
      const { args, open, close } = this.parseArguments();
      if (args.length !== 1) {
        throw new ParseError(`Unknown function '${name}'${didYouMean}`, tok.start, close.end);
      }
      if (suggestion) {
        this.notes.push(`'${name}(…)' is read as ${name} times the bracket, since there is no function ` +
          `called ${name}. Write ${suggestion.name}(…) if you meant the function ${suggestion.name}.`);
      }
      const symbol = { type: 'symbol', name, start: tok.start, end: tok.end };
      return makeBinary('*', symbol, { ...args[0], start: open.start, end: close.end }, true);
    }

    if (Object.hasOwn(FUNCTIONS, name) && !NAME_OK_WITHOUT_BRACKETS.has(name)) {
      if (this.isOp(after, '^')) {
        throw new ParseError(`Write ${name}(x)^2 rather than ${name}^2(x)`, tok.start, after.end);
      }
      throw new ParseError(`'${name}' is a function, so it needs brackets: ${name}(…)`, tok.start, tok.end);
    }
    return { type: 'symbol', name, start: tok.start, end: tok.end };
  }

  parseCall(nameTok) {
    const name = nameTok.value;
    const { args, close } = this.parseArguments();
    const { arity } = FUNCTIONS[name];
    const [lo, hi] = Array.isArray(arity) ? arity : [arity, arity];
    if (args.length < lo || args.length > hi) {
      throw new ParseError(`'${name}' takes ${arityText(arity)}, not ${args.length}`, nameTok.start, close.end);
    }
    return { type: 'call', name, args, start: nameTok.start, end: close.end };
  }

  parseArguments() {
    const open = this.next();
    const args = [];
    if (this.peek().type !== T_CLOSE) {
      for (;;) {
        if (this.peek().type === T_COMMA) {
          const c = this.peek();
          throw new ParseError("Missing an argument before ','", c.start, c.end);
        }
        args.push(this.parseSum());
        if (this.peek().type !== T_COMMA) break;
        const comma = this.next();
        const t = this.peek();
        if (t.type === T_CLOSE || t.type === T_END) {
          throw new ParseError("Missing an argument after ','", comma.start, comma.end);
        }
      }
    }
    const close = this.expectClose(open);
    return { args, open, close };
  }

  expectClose(open) {
    const tok = this.peek();
    const want = BRACKETS[open.value];
    if (tok.type === T_CLOSE) {
      if (tok.value !== want) {
        throw new ParseError(`The '${open.value}' at position ${open.start + 1} is closed by '${tok.value}'; ` +
          `use '${want}'`, open.start, tok.end);
      }
      return this.next();
    }
    if (tok.type === T_END || tok.type === T_EQ) {
      throw new ParseError(`Missing '${want}' to close the '${open.value}' at position ${open.start + 1}`,
        open.start, open.end);
    }
    throw this.unexpected(tok);
  }

  unexpected(tok) {
    const p = this.prev();
    const s = this.slice(tok);
    switch (tok.type) {
      case T_END:
        if (!p) return new ParseError('The equation is empty', tok.start, tok.end);
        if (p.type === T_OP) return new ParseError(`Missing a value after '${this.slice(p)}'`, p.start, p.end);
        return new ParseError('The equation ends too early', tok.start, tok.end);
      case T_OP:
        if (p && p.type === T_OP) {
          return new ParseError(`Two operators in a row: '${this.text.slice(p.start, tok.end)}'`, p.start, tok.end);
        }
        return new ParseError(`Missing a value before '${s}'`, tok.start, tok.end);
      case T_CLOSE:
        if (p && p.type === T_OP) {
          return new ParseError(`Missing a value after '${this.slice(p)}'`, p.start, tok.end);
        }
        return new ParseError(`There is a '${s}' with no matching opening bracket`, tok.start, tok.end);
      case T_COMMA:
        return new ParseError("Unexpected ','. Commas only separate the arguments of a function, as in atan2(y, x)",
          tok.start, tok.end);
      case T_EQ:
        return new ParseError("Only one '=' is allowed", tok.start, tok.end);
      default:
        return new ParseError(`Unexpected '${s}'`, tok.start, tok.end);
    }
  }
}

/*
 * Match the brackets before parsing. An unclosed bracket is the commonest slip
 * while typing and it throws off the reading of everything after it, so its
 * message is the useful one even when something earlier is also wrong, such
 * as the '=' in `y = A*exp(-t/tau` given to parseExpression. Of several
 * unclosed brackets the innermost is named, as parsing would meet it first.
 */
function checkBrackets(tokens) {
  const stack = [];
  for (const tok of tokens) {
    if (tok.type === T_OPEN) {
      stack.push(tok);
    } else if (tok.type === T_CLOSE) {
      const open = stack.pop();
      if (!open) return new ParseError(`There is a '${tok.value}' with no matching opening bracket`, tok.start, tok.end);
      const want = BRACKETS[open.value];
      if (tok.value !== want) {
        return new ParseError(`The '${open.value}' at position ${open.start + 1} is closed by '${tok.value}'; ` +
          `use '${want}'`, open.start, tok.end);
      }
    }
  }
  if (stack.length === 0) return null;
  const open = stack[stack.length - 1];
  return new ParseError(`Missing '${BRACKETS[open.value]}' to close the '${open.value}' at position ${open.start + 1}`,
    open.start, open.end);
}

function parseTokens(text, tokens) {
  const parser = new Parser(text, tokens);
  try {
    if (tokens[0].type === T_END) throw new ParseError('The equation is empty', 0, text.length);
    const bracketError = checkBrackets(tokens);
    if (bracketError) throw bracketError;
    const ast = parser.parseSum();
    const rest = parser.peek();
    if (rest.type !== T_END) throw parser.unexpected(rest);
    return { ok: true, ast, notes: parser.notes };
  } catch (err) {
    if (err instanceof ParseError) {
      return { ok: false, error: { message: err.message, start: err.start, end: err.end } };
    }
    throw err;
  }
}

/**
 * Parse an expression such as `A*exp(-t/tau) + y0`.
 *
 * @param {string} text
 * @returns {{ok:true, ast:object, notes:string[]}
 *          | {ok:false, error:{message:string, start:number, end:number}}}
 *   `notes` holds readings worth showing the person, such as how `t/2tau`
 *   was grouped.
 */
export function parseExpression(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: { message: 'The equation is empty', start: 0, end: 0 } };
  }
  const tk = tokenize(text);
  if (!tk.ok) return { ok: false, error: tk.error };
  return parseTokens(text, tk.tokens);
}

function findSymbol(node, name) {
  if (!node) return null;
  switch (node.type) {
    case 'symbol': return node.name === name ? node : null;
    case 'unary': return findSymbol(node.arg, name);
    case 'binary': return findSymbol(node.left, name) || findSymbol(node.right, name);
    case 'call':
      for (const a of node.args) {
        const hit = findSymbol(a, name);
        if (hit) return hit;
      }
      return null;
    default: return null;
  }
}

function readLeftSide(lhs, text) {
  const span = [lhs[0].start, lhs[lhs.length - 1].end];
  const bracketError = checkBrackets(lhs);
  if (bracketError) {
    return { error: { message: bracketError.message, start: bracketError.start, end: bracketError.end } };
  }
  const general = () => ({
    error: { message: "The left side of '=' should be a name such as y, or f(x)", start: span[0], end: span[1] }
  });
  if (lhs[0].type !== T_ID) return general();
  const dependent = lhs[0].value;
  if (lhs.length === 1) return { dependent, arguments: null };

  if (lhs[1].type !== T_OPEN) return general();
  if (Object.hasOwn(FUNCTIONS, dependent)) {
    return {
      error: {
        message: `The left side should name what is fitted, such as y or f(x). To fit ${dependent}(y), ` +
          'transform the y data first and fit that column',
        start: span[0], end: span[1]
      }
    };
  }
  const args = [];
  let k = 2;
  for (;;) {
    const t = lhs[k];
    if (!t || t.type !== T_ID) return general();
    if (args.includes(t.value)) {
      return { error: { message: `'${t.value}' is listed twice in ${text.slice(span[0], span[1])}`, start: t.start, end: t.end } };
    }
    args.push(t.value);
    const sep = lhs[k + 1];
    if (sep && sep.type === T_COMMA) {
      k += 2;
      continue;
    }
    if (sep && sep.type === T_CLOSE && k + 2 === lhs.length) break;
    return general();
  }
  return { dependent, arguments: args };
}

/**
 * Parse an equation: `y = rhs`, `f(x) = rhs`, `I(V) = rhs`, `y(t, T) = rhs`,
 * or a bare right-hand side.
 *
 * @param {string} text
 * @returns {{ok:boolean, dependent:string|null, arguments:string[]|null,
 *            ast:object|null, rhsStart:number, notes:string[],
 *            error:{message:string, start:number, end:number}|null}}
 *   `rhsStart` is the offset of the first character of the right-hand side.
 *   AST offsets refer to the whole text, not to the right-hand side alone.
 */
export function parseEquation(text) {
  const out = { ok: false, dependent: null, arguments: null, ast: null, rhsStart: 0, notes: [], error: null };
  if (typeof text !== 'string' || text.trim() === '') {
    out.error = { message: 'The equation is empty', start: 0, end: 0 };
    return out;
  }
  const tk = tokenize(text);
  if (!tk.ok) {
    out.error = tk.error;
    return out;
  }
  const { tokens } = tk;
  const equals = tokens.filter(t => t.type === T_EQ);
  if (equals.length > 1) {
    out.error = { message: "Only one '=' is allowed", start: equals[1].start, end: equals[1].end };
    return out;
  }

  let rhs = tokens;
  if (equals.length === 1) {
    const k = tokens.indexOf(equals[0]);
    const lhs = tokens.slice(0, k);
    rhs = tokens.slice(k + 1);
    if (rhs[0].type === T_END) {
      out.error = { message: "Nothing after '='", start: equals[0].start, end: equals[0].end };
      return out;
    }
    // Nothing before '=' is harmless: '= a*x + b' reads as the bare right side.
    if (lhs.length > 0) {
      const side = readLeftSide(lhs, text);
      if (side.error) {
        out.error = side.error;
        return out;
      }
      out.dependent = side.dependent;
      out.arguments = side.arguments;
    }
  }
  out.rhsStart = rhs[0].start;

  const parsed = parseTokens(text, rhs);
  if (!parsed.ok) {
    out.error = parsed.error;
    return out;
  }
  if (out.dependent) {
    const hit = findSymbol(parsed.ast, out.dependent);
    if (hit) {
      out.error = {
        message: `'${out.dependent}' appears on both sides of '='. The right side should give ` +
          `${out.dependent} in terms of the other quantities`,
        start: hit.start, end: hit.end
      };
      return out;
    }
  }
  out.ok = true;
  out.ast = parsed.ast;
  out.notes = parsed.notes;
  return out;
}

/* ------------------------------------------------------------------ *
 * Inspection
 * ------------------------------------------------------------------ */

/**
 * The names and functions an expression uses, each in order of first
 * appearance.
 *
 * @param {object} ast
 * @returns {{identifiers:string[], functions:string[]}}
 */
export function symbolsOf(ast) {
  const identifiers = [];
  const functions = [];
  const seenIds = new Set();
  const seenFns = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'symbol':
        if (!seenIds.has(node.name)) {
          seenIds.add(node.name);
          identifiers.push(node.name);
        }
        break;
      case 'unary':
        walk(node.arg);
        break;
      case 'binary':
        walk(node.left);
        walk(node.right);
        break;
      case 'call':
        if (!seenFns.has(node.name)) {
          seenFns.add(node.name);
          functions.push(node.name);
        }
        node.args.forEach(walk);
        break;
      default:
        break;
    }
  };
  walk(ast);
  return { identifiers, functions };
}

/*
 * Guessing order for the independent variable. Only the first match is taken,
 * except that x brings y (and z) with it when they appear, for surfaces such
 * as z = a*x + b*y + c, and a family x1, x2, … is taken whole. A lone x0 is
 * not a family: it is the usual name for an offset or a centre, as in
 * x = A*exp(-t/tau) + x0, where the variable is t.
 */
const INDEPENDENT_GUESSES = [
  'x', 't', 'T', 'V', 'r', 'z', 's', 'q', 'c', 'conc', 'time', 'temp',
  'temperature', 'P', 'p', 'E', 'I', 'f', 'freq', 'omega', 'ω', 'lambda', 'λ',
  'wavelength', 'theta', 'θ', 'd', 'h', 'n', 'N', 'u', 'v', 'w'
];

function guessIndependent(names) {
  const present = new Set(names);
  if (present.has('x')) {
    const out = ['x'];
    if (present.has('y')) {
      out.push('y');
      if (present.has('z')) out.push('z');
    }
    return out;
  }
  const family = names.filter(n => /^x_?\d+$/.test(n));
  const loneOffset = family.length === 1 && /^x_?0$/.test(family[0]);
  if (family.length && !loneOffset) return family;
  for (const g of INDEPENDENT_GUESSES) if (present.has(g)) return [g];
  return [];
}

/* True when every use of `e` is as the base of a power, e^x or pow(e, x). */
function eOnlyAsBase(node, asBase = false) {
  if (!node) return true;
  switch (node.type) {
    case 'symbol': return node.name !== 'e' || asBase;
    case 'unary': return eOnlyAsBase(node.arg);
    case 'binary':
      return eOnlyAsBase(node.left, node.op === '^') && eOnlyAsBase(node.right);
    case 'call':
      return node.args.every((a, i) => eOnlyAsBase(a, canonical(node.name) === 'pow' && i === 0));
    default: return true;
  }
}

/**
 * Sort the names in an expression into independent variables, parameters and
 * constants.
 *
 * @param {object} input - An AST, or a `parseEquation` result (whose
 *   `arguments` and `dependent` are then used).
 * @param {{independent?:string[], constants?:string[], parameters?:string[],
 *          arguments?:string[], dependent?:string}} [options]
 *   `independent` fixes the variables outright. Without it they are guessed:
 *   the arguments of `f(x) =`, else the first of x, t, T, V, r, z, s, q, c,
 *   conc, time, temp, … that appears (x also brings y and z along).
 *   `constants` lists the names read as constants (default `pi` and `e`);
 *   `parameters` forces names to be parameters, which is how a caller lets
 *   someone fit a parameter called `e`.
 * @returns {{independent:string[], parameters:string[], constants:string[],
 *            unknownFunctions:string[], suggestedConstants:object[], notes:string[]}}
 *   Parameters are in order of first appearance. `suggestedConstants` lists
 *   parameters named like physical constants (see `PHYSICAL_CONSTANTS`).
 */
export function classify(input, options = {}) {
  const result = {
    independent: [], parameters: [], constants: [], unknownFunctions: [],
    suggestedConstants: [], notes: []
  };
  const ast = input && typeof input === 'object' && typeof input.type === 'string' ? input : input?.ast;
  if (!ast) return result;
  const opts = options ?? {};

  const { identifiers, functions } = symbolsOf(ast);
  result.unknownFunctions = functions.filter(f => !Object.hasOwn(FUNCTIONS, f) && !Object.hasOwn(IMPL, f));

  const forced = new Set(Array.isArray(opts.parameters) ? opts.parameters : []);
  const constantNames = new Set(
    (Array.isArray(opts.constants) ? opts.constants : Object.keys(CONSTANTS)).filter(c => !forced.has(c))
  );
  const dependent = opts.dependent ?? input?.dependent ?? null;
  const args = Array.isArray(opts.arguments) ? opts.arguments
    : Array.isArray(input?.arguments) ? input.arguments : null;

  let independent;
  if (Array.isArray(opts.independent)) independent = [...opts.independent];
  else if (args && args.length) independent = [...args];
  else {
    independent = guessIndependent(
      identifiers.filter(n => !constantNames.has(n) && !forced.has(n) && n !== dependent)
    );
  }
  const indSet = new Set(independent);

  for (const name of identifiers) {
    if (indSet.has(name)) continue;
    if (constantNames.has(name)) result.constants.push(name);
    else result.parameters.push(name);
  }
  result.independent = independent;

  if (result.constants.includes('e') && !eOnlyAsBase(ast)) {
    result.notes.push("'e' is read as Euler's number 2.718…. Make it a parameter if you meant a fitted constant.");
  }
  for (const name of result.parameters) {
    if (Object.hasOwn(PHYSICAL_CONSTANTS, name)) {
      result.suggestedConstants.push({ name, ...PHYSICAL_CONSTANTS[name] });
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

function constant(value) {
  return { fn: () => value, isConst: true, value };
}

function applyBinary(op, a, b) {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    default: return Math.pow(a, b);
  }
}

function buildBinary(op, a, b) {
  if (a.isConst && b.isConst) return constant(applyBinary(op, a.value, b.value));
  const f = a.fn;
  const g = b.fn;
  const k = b.isConst ? b.value : a.isConst ? a.value : 0;
  switch (op) {
    case '+':
      if (b.isConst) return { fn: v => f(v) + k };
      if (a.isConst) return { fn: v => k + g(v) };
      return { fn: v => f(v) + g(v) };
    case '-':
      if (b.isConst) return { fn: v => f(v) - k };
      if (a.isConst) return { fn: v => k - g(v) };
      return { fn: v => f(v) - g(v) };
    case '*':
      if (b.isConst) return { fn: v => f(v) * k };
      if (a.isConst) return { fn: v => k * g(v) };
      return { fn: v => f(v) * g(v) };
    case '/':
      if (b.isConst) return { fn: v => f(v) / k };
      if (a.isConst) return { fn: v => k / g(v) };
      return { fn: v => f(v) / g(v) };
    default:
      if (b.isConst) {
        if (k === 1) return a;
        if (k === 2) return { fn: v => { const t = f(v); return t * t; } };
        if (k === 3) return { fn: v => { const t = f(v); return t * t * t; } };
        if (k === -1) return { fn: v => 1 / f(v) };
        return { fn: v => Math.pow(f(v), k) };
      }
      if (a.isConst) return { fn: v => Math.pow(k, g(v)) };
      return { fn: v => Math.pow(f(v), g(v)) };
  }
}

function build(node, index) {
  switch (node.type) {
    case 'number':
      return constant(node.value);
    case 'symbol': {
      const i = index.get(node.name);
      if (i !== undefined) return { fn: v => v[i], isConst: false };
      if (Object.hasOwn(CONSTANTS, node.name)) return constant(CONSTANTS[node.name].value);
      throw new Error(`compile: no value supplied for '${node.name}'`);
    }
    case 'unary': {
      const a = build(node.arg, index);
      if (node.op === '+') return a;
      if (a.isConst) return constant(-a.value);
      const f = a.fn;
      return { fn: v => -f(v) };
    }
    case 'binary':
      return buildBinary(node.op, build(node.left, index), build(node.right, index));
    case 'call': {
      const impl = IMPL[canonical(node.name)];
      if (!impl) throw new Error(`compile: unknown function '${node.name}'`);
      const args = node.args.map(a => build(a, index));
      if (args.every(a => a.isConst)) return constant(impl(...args.map(a => a.value)));
      if (args.length === 1) {
        const f = args[0].fn;
        return { fn: v => impl(f(v)) };
      }
      if (args.length === 2) {
        const f = args[0].fn;
        const g = args[1].fn;
        return { fn: v => impl(f(v), g(v)) };
      }
      const fs = args.map(a => a.fn);
      return { fn: v => impl(...fs.map(h => h(v))) };
    }
    default:
      throw new Error(`compile: unknown node type '${node.type}'`);
  }
}

/**
 * Compile an expression into a fast evaluator.
 *
 * The result takes one array (or Float64Array) of values ordered as `names`;
 * the caller chooses the order, typically independent variables first and
 * then parameters, and reuses one array across calls. Constant subtrees are
 * folded once, here. Names in `names` shadow the constants, so a parameter
 * called `e` is read from the array.
 *
 * @param {object} ast
 * @param {string[]} names
 * @returns {(values:ArrayLike<number>) => number}
 * @throws {Error} When a name has no value or a function is unknown. Parsed
 *   ASTs never contain unknown functions; a missing name is a caller error.
 */
export function compile(ast, names) {
  const index = new Map();
  (names ?? []).forEach((n, i) => {
    if (!index.has(n)) index.set(n, i);
  });
  return build(ast, index).fn;
}

/* ------------------------------------------------------------------ *
 * Differentiation
 * ------------------------------------------------------------------ */

function dependsOn(node, name) {
  switch (node.type) {
    case 'symbol': return node.name === name;
    case 'unary': return dependsOn(node.arg, name);
    case 'binary': return dependsOn(node.left, name) || dependsOn(node.right, name);
    case 'call': return node.args.some(a => dependsOn(a, name));
    default: return false;
  }
}

/*
 * Constructors that simplify as they build, so the derivative of a*x with
 * respect to a is x rather than 1*x + a*0. `at` supplies the source span.
 */
function num(value, at) {
  return { type: 'number', value, raw: String(value), start: at.start, end: at.end };
}

function isNum(node, value) {
  return node.type === 'number' && (value === undefined || node.value === value);
}

function isNeg(node) {
  return node.type === 'unary' && node.op === '-';
}

function bin(op, left, right, at) {
  return { type: 'binary', op, left, right, start: at.start, end: at.end };
}

function call(name, args, at) {
  return { type: 'call', name, args, start: at.start, end: at.end };
}

function neg(a, at) {
  if (isNum(a)) return num(-a.value, at);
  if (isNeg(a)) return a.arg;
  return { type: 'unary', op: '-', arg: a, start: at.start, end: at.end };
}

function add(a, b, at) {
  if (isNum(a, 0)) return b;
  if (isNum(b, 0)) return a;
  if (isNum(a) && isNum(b)) return num(a.value + b.value, at);
  if (isNeg(b)) return sub(a, b.arg, at);
  if (isNum(b) && b.value < 0) return sub(a, num(-b.value, at), at);
  return bin('+', a, b, at);
}

function sub(a, b, at) {
  if (isNum(b, 0)) return a;
  if (isNum(a, 0)) return neg(b, at);
  if (isNum(a) && isNum(b)) return num(a.value - b.value, at);
  if (isNeg(b)) return add(a, b.arg, at);
  return bin('-', a, b, at);
}

function mul(a, b, at) {
  if (isNum(a, 0) || isNum(b, 0)) return num(0, at);
  if (isNum(a, 1)) return b;
  if (isNum(b, 1)) return a;
  if (isNum(a) && isNum(b)) return num(a.value * b.value, at);
  if (isNum(a, -1)) return neg(b, at);
  if (isNum(b, -1)) return neg(a, at);
  if (isNeg(a)) return neg(mul(a.arg, b, at), at);
  if (isNeg(b)) return neg(mul(a, b.arg, at), at);
  if (isNum(b)) return mul(b, a, at);
  if (isNum(a) && a.value < 0) return neg(mul(num(-a.value, at), b, at), at);
  if (isNum(a) && b.type === 'binary' && b.op === '*' && isNum(b.left)) {
    return mul(num(a.value * b.left.value, at), b.right, at);
  }
  return bin('*', a, b, at);
}

function div(a, b, at) {
  if (isNum(a, 0)) return num(0, at);
  if (isNum(b, 1)) return a;
  if (isNum(a) && isNum(b) && b.value !== 0) return num(a.value / b.value, at);
  if (isNeg(a)) return neg(div(a.arg, b, at), at);
  if (isNeg(b)) return neg(div(a, b.arg, at), at);
  return bin('/', a, b, at);
}

function pow(a, b, at) {
  if (isNum(b, 0)) return num(1, at);
  if (isNum(b, 1)) return a;
  return bin('^', a, b, at);
}

function derivativeOfPower(u, v, node, name) {
  const at = node;
  if (!dependsOn(v, name)) {
    const du = derive(u, name);
    if (!du) return null;
    const lowered = isNum(v) ? pow(u, num(v.value - 1, at), at) : pow(u, sub(v, num(1, at), at), at);
    return mul(mul(v, lowered, at), du, at);
  }
  const dv = derive(v, name);
  if (!dv) return null;
  if (!dependsOn(u, name)) {
    // d(u^v) = u^v ln(u) dv. ln(e) is kept rather than dropped, because the
    // caller may have made e a parameter; compile folds it to 1 otherwise.
    return mul(mul(node, call('log', [u], at), at), dv, at);
  }
  const du = derive(u, name);
  if (!du) return null;
  return mul(node, add(mul(dv, call('log', [u], at), at), div(mul(v, du, at), u, at), at), at);
}

function derivativeOfCall(node, name) {
  const at = node;
  const fname = canonical(node.name);
  const [u, w] = node.args;

  switch (fname) {
    case 'atan2': {
      // atan2(y, x): (x dy - y dx) / (x^2 + y^2)
      const dy = derive(u, name);
      const dx = derive(w, name);
      if (!dy || !dx) return null;
      return div(sub(mul(w, dy, at), mul(u, dx, at), at),
        add(pow(w, num(2, at), at), pow(u, num(2, at), at), at), at);
    }
    case 'pow':
      return derivativeOfPower(u, w, node, name);
    case 'min':
    case 'max': {
      // Subgradient: the derivative of whichever argument is selected, and
      // the average of both at a tie, through heaviside(0) = 0.5.
      const da = derive(u, name);
      const db = derive(w, name);
      if (!da || !db) return null;
      const aWins = fname === 'min' ? sub(w, u, at) : sub(u, w, at);
      const bWins = fname === 'min' ? sub(u, w, at) : sub(w, u, at);
      return add(mul(da, call('heaviside', [aWins], at), at), mul(db, call('heaviside', [bWins], at), at), at);
    }
    default:
      break;
  }

  // Piecewise-constant functions have zero derivative almost everywhere; the
  // jumps themselves are ignored, which is the usual subgradient choice.
  if (['sign', 'heaviside', 'floor', 'ceil', 'round'].includes(fname)) return num(0, at);

  const du = derive(u, name);
  if (!du) return null;
  const two = num(2, at);
  const one = num(1, at);
  const sq = x => pow(x, two, at);
  const chain = outer => (outer ? mul(outer, du, at) : null);
  const over = den => div(du, den, at);

  switch (fname) {
    case 'exp': return chain(node);
    case 'log': return over(u);
    case 'log10': return over(mul(u, num(Math.LN10, at), at));
    case 'log2': return over(mul(u, num(Math.LN2, at), at));
    case 'sqrt': return over(mul(two, node, at));
    case 'cbrt': return over(mul(num(3, at), sq(node), at));
    case 'abs': return chain(call('sign', [u], at));
    case 'sin': return chain(call('cos', [u], at));
    case 'cos': return neg(chain(call('sin', [u], at)), at);
    case 'tan': return over(sq(call('cos', [u], at)));
    case 'asin': return over(call('sqrt', [sub(one, sq(u), at)], at));
    case 'acos': return neg(over(call('sqrt', [sub(one, sq(u), at)], at)), at);
    case 'atan': return over(add(one, sq(u), at));
    case 'sinh': return chain(call('cosh', [u], at));
    case 'cosh': return chain(call('sinh', [u], at));
    case 'tanh': return over(sq(call('cosh', [u], at)));
    case 'asinh': return over(call('sqrt', [add(sq(u), one, at)], at));
    case 'acosh': return over(call('sqrt', [sub(sq(u), one, at)], at));
    case 'atanh': return over(sub(one, sq(u), at));
    case 'erf': return chain(mul(num(TWO_OVER_SQRT_PI, at), call('exp', [neg(sq(u), at)], at), at));
    case 'erfc': return neg(chain(mul(num(TWO_OVER_SQRT_PI, at), call('exp', [neg(sq(u), at)], at), at)), at);
    case 'gamma': return chain(mul(node, call('$digamma', [u], at), at));
    case 'lgamma': return chain(call('$digamma', [u], at));
    case 'sinc': return chain(call('$dsinc', [u], at));
    default: return null;
  }
}

function derive(node, name) {
  if (!dependsOn(node, name)) return num(0, node);
  switch (node.type) {
    case 'symbol':
      return num(1, node);
    case 'unary': {
      const da = derive(node.arg, name);
      if (!da) return null;
      return node.op === '-' ? neg(da, node) : da;
    }
    case 'binary': {
      const { op, left: u, right: v } = node;
      if (op === '^') return derivativeOfPower(u, v, node, name);
      const du = derive(u, name);
      const dv = derive(v, name);
      if (!du || !dv) return null;
      switch (op) {
        case '+': return add(du, dv, node);
        case '-': return sub(du, dv, node);
        case '*': return add(mul(du, v, node), mul(u, dv, node), node);
        default:
          if (isNum(dv, 0)) return div(du, v, node);
          return sub(div(du, v, node), div(mul(u, dv, node), pow(v, num(2, node), node), node), node);
      }
    }
    case 'call':
      return derivativeOfCall(node, name);
    default:
      return null;
  }
}

/**
 * Symbolic partial derivative ∂(ast)/∂name, simplified.
 *
 * Every function in `FUNCTIONS` is covered. Where a function is not smooth
 * the usual subgradient is used: sign(u)·du for abs, zero for sign, heaviside,
 * floor, ceil and round (their jumps are ignored), and the selected argument's
 * derivative for min and max (the average of both at a tie). gamma, lgamma and
 * sinc differentiate to internal functions (`$digamma`, `$dsinc`) that
 * `compile` understands but an equation cannot name.
 *
 * Returns null when the expression calls a function with no rule (only
 * possible for a hand-built AST); the fitter then differentiates that
 * parameter numerically. Values the formula leaves undefined at particular
 * points, such as x^n ln x at x = 0, are the caller's to catch: the fitter
 * falls back to a finite difference for those entries.
 *
 * @param {object} ast
 * @param {string} name
 * @returns {object|null}
 */
export function differentiate(ast, name) {
  if (!ast) return null;
  return derive(ast, name);
}

/* ------------------------------------------------------------------ *
 * Text and LaTeX
 * ------------------------------------------------------------------ */

/* Precedence: sums 1, products 2, unary minus 3, powers 4, atoms 5. */
function precedence(node) {
  if (node.type === 'binary') {
    if (node.op === '+' || node.op === '-') return 1;
    return node.op === '^' ? 4 : 2;
  }
  if (node.type === 'unary') return 3;
  if (node.type === 'number' && (node.value < 0 || Object.is(node.value, -0))) return 3;
  return 5;
}

function numberText(node) {
  let raw = node.raw ?? String(node.value);
  if (raw.startsWith('.')) raw = `0${raw}`;
  raw = raw.replace(/\.(?=$|[eE])/, '');
  return raw;
}

function text(node) {
  const paren = (s, cond) => (cond ? `(${s})` : s);
  switch (node.type) {
    case 'number':
      return numberText(node);
    case 'symbol':
      return node.name;
    case 'unary':
      return node.op + paren(text(node.arg), precedence(node.arg) <= 3);
    case 'binary': {
      const { op, left, right } = node;
      const p = precedence(node);
      if (op === '^') {
        return `${paren(text(left), precedence(left) <= 4)}^${paren(text(right), precedence(right) <= 3)}`;
      }
      const l = paren(text(left), precedence(left) < p);
      const r = paren(text(right), precedence(right) <= p || precedence(right) === 3);
      return p === 1 ? `${l} ${op} ${r}` : `${l}${op}${r}`;
    }
    case 'call':
      return `${node.name.replace(/^\$/, '')}(${node.args.map(text).join(', ')})`;
    default:
      return '';
  }
}

/**
 * Plain text of an expression, normalised: explicit `*`, spaces around `+`
 * and `-`, and only the brackets the structure needs. Parsing the result gives
 * the same tree back, so it is safe to show as "read as …" and to build code
 * from.
 *
 * @param {object} ast
 * @returns {string}
 */
export function toText(ast) {
  return ast ? text(ast) : '';
}

function latexWord(word, italicMulti) {
  if (GREEK_SET.has(word)) return `\\${word}`;
  if (Object.hasOwn(GREEK_CHARS, word)) return `\\${GREEK_CHARS[word]}`;
  if (/^\d+$/.test(word) || [...word].length === 1) return word;
  return italicMulti ? `\\mathit{${word}}` : `\\mathrm{${word}}`;
}

/**
 * LaTeX for a single name: Greek names become letters (`tau` → `\tau`), a
 * part after an underscore or trailing digits become a subscript (`k_1`,
 * `E_a`, `tau0` → `\tau_{0}`), and other multi-letter names are set in
 * italic as one word (`\mathit{conc}`).
 *
 * @param {string} name
 * @returns {string}
 */
export function symbolToLatex(name) {
  if (typeof name !== 'string' || name === '') return '';
  let base = name;
  let sub = '';
  const us = name.indexOf('_');
  if (us > 0 && us < name.length - 1) {
    base = name.slice(0, us);
    sub = name.slice(us + 1);
  } else if (us < 0) {
    const m = /^(\D.*?)(\d+)$/u.exec(name);
    if (m) {
      base = m[1];
      sub = m[2];
    }
  }
  const b = latexWord(base, true);
  if (!sub) return b;
  return `${b}_{${sub.split('_').map(s => latexWord(s, false)).join(',')}}`;
}

function numberLatex(node) {
  const raw = numberText(node);
  const m = /^(-?)([\d.]+)[eE]([+-]?)0*(\d+)$/.exec(raw);
  if (!m) return raw;
  const exponent = `${m[3] === '-' ? '-' : ''}${m[4]}`;
  return m[2] === '1' ? `${m[1]}10^{${exponent}}` : `${m[1]}${m[2]} \\times 10^{${exponent}}`;
}

const LATEX_FUNCTIONS = Object.freeze({
  log: '\\ln', log10: '\\log_{10}', log2: '\\log_{2}', sign: '\\operatorname{sgn}',
  sin: '\\sin', cos: '\\cos', tan: '\\tan', asin: '\\arcsin', acos: '\\arccos',
  atan: '\\arctan', atan2: '\\operatorname{atan2}', sinh: '\\sinh', cosh: '\\cosh',
  tanh: '\\tanh', asinh: '\\operatorname{arsinh}', acosh: '\\operatorname{arcosh}',
  atanh: '\\operatorname{artanh}', erf: '\\operatorname{erf}', erfc: '\\operatorname{erfc}',
  gamma: '\\Gamma', lgamma: '\\ln\\Gamma', min: '\\min', max: '\\max', heaviside: 'H',
  round: '\\operatorname{round}', sinc: '\\operatorname{sinc}', $digamma: '\\psi',
  $dsinc: "\\operatorname{sinc}'"
});

/* exp(u) is written e^{u} when u is short enough to read as a superscript. */
const SHORT_EXPONENT = 30;

function latex(node, inExponent) {
  const paren = (s, cond) => (cond ? `\\left(${s}\\right)` : s);
  switch (node.type) {
    case 'number':
      return numberLatex(node);
    case 'symbol':
      return symbolToLatex(node.name);
    case 'unary': {
      // A leading minus needs brackets only around a sum: -\frac{a}{b} and -a b read fine.
      const arg = latex(node.arg, inExponent);
      return node.op + paren(arg, precedence(node.arg) === 1 || precedence(node.arg) === 3 || arg.startsWith('-'));
    }
    case 'binary': {
      const { op, left, right } = node;
      if (op === '+' || op === '-') {
        const r = latex(right, inExponent);
        const needs = precedence(right) === 3 || r.startsWith('-') || (op === '-' && precedence(right) === 1);
        return `${latex(left, inExponent)} ${op} ${paren(r, needs)}`;
      }
      if (op === '*') {
        const l = paren(latex(left, inExponent), precedence(left) < 2);
        const rt = latex(right, inExponent);
        const r = paren(rt, precedence(right) < 2 || precedence(right) === 3 || rt.startsWith('-'));
        const dot = /^[\d.]/.test(r) || isNum(right);
        return `${l}${dot ? ' \\cdot ' : ' '}${r}`;
      }
      if (op === '/') {
        if (inExponent) {
          const l = paren(latex(left, true), precedence(left) < 2);
          const r = paren(latex(right, true), precedence(right) <= 3);
          return `${l}/${r}`;
        }
        // Hoist a leading minus out of the numerator: -\frac{a}{b}, not \frac{-a}{b}.
        if (isNeg(left)) return `-\\frac{${latex(left.arg, false)}}{${latex(right, false)}}`;
        return `\\frac{${latex(left, false)}}{${latex(right, false)}}`;
      }
      // Power
      const base = latex(left, inExponent);
      const baseNeeds = precedence(left) < 5 || (left.type === 'call' && canonical(left.name) === 'exp') ||
        (left.type === 'number' && /\\times|\^/.test(base));
      return `${paren(base, baseNeeds)}^{${latex(right, true)}}`;
    }
    case 'call': {
      const fname = canonical(node.name);
      const args = node.args.map(a => latex(a, inExponent));
      switch (fname) {
        case 'exp': {
          const inner = latex(node.args[0], true);
          if (inner.length <= SHORT_EXPONENT) return `e^{${inner}}`;
          return `\\exp\\left(${latex(node.args[0], inExponent)}\\right)`;
        }
        case 'sqrt': return `\\sqrt{${args[0]}}`;
        case 'cbrt': return `\\sqrt[3]{${args[0]}}`;
        case 'abs': return `\\left|${args[0]}\\right|`;
        case 'floor': return `\\left\\lfloor ${args[0]} \\right\\rfloor`;
        case 'ceil': return `\\left\\lceil ${args[0]} \\right\\rceil`;
        case 'pow': {
          const baseNeeds = precedence(node.args[0]) < 5;
          return `${paren(args[0], baseNeeds)}^{${latex(node.args[1], true)}}`;
        }
        default: {
          const cmd = LATEX_FUNCTIONS[fname] ?? `\\operatorname{${fname.replace(/^\$/, '')}}`;
          return `${cmd}\\left(${args.join(', ')}\\right)`;
        }
      }
    }
    default:
      return '';
  }
}

/**
 * LaTeX for KaTeX. Fractions use `\frac` (inline `/` inside exponents),
 * exp(u) is `e^{u}` when u is short and `\exp(…)` otherwise, `\cdot` appears
 * only where juxtaposition would be misread (before a number), and names go
 * through `symbolToLatex`.
 *
 * Passing a `parseEquation` result instead of an AST renders the whole
 * equation, `y = …` or `f(x) = …`.
 *
 * @param {object} ast - An AST, or a parseEquation result.
 * @returns {string}
 */
export function toLatex(ast) {
  if (!ast) return '';
  if (typeof ast.type !== 'string' && ast.ast) {
    const rhs = latex(ast.ast, false);
    if (!ast.dependent) return rhs;
    const lhs = symbolToLatex(ast.dependent) +
      (ast.arguments && ast.arguments.length ? `\\left(${ast.arguments.map(symbolToLatex).join(', ')}\\right)` : '');
    return `${lhs} = ${rhs}`;
  }
  return latex(ast, false);
}
