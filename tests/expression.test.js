import { describe, test, expect } from '@jest/globals';
import {
  FUNCTIONS, CONSTANTS, PHYSICAL_CONSTANTS, special,
  parseExpression, parseEquation, symbolsOf, classify, compile, differentiate,
  toText, toLatex, symbolToLatex
} from '../src/core/expression.js';

/* Strip positions and flags so trees can be compared by shape alone. */
function shape(node) {
  switch (node.type) {
    case 'number': return { type: 'number', value: node.value };
    case 'symbol': return { type: 'symbol', name: node.name };
    case 'unary': return { type: 'unary', op: node.op, arg: shape(node.arg) };
    case 'binary': return { type: 'binary', op: node.op, left: shape(node.left), right: shape(node.right) };
    case 'call': return { type: 'call', name: node.name, args: node.args.map(shape) };
    default: return node;
  }
}

const ast = text => {
  const r = parseExpression(text);
  if (!r.ok) throw new Error(`${text}: ${r.error.message}`);
  return r.ast;
};
const err = text => {
  const r = parseExpression(text);
  if (r.ok) throw new Error(`${text} parsed`);
  return r.error;
};
const num = value => ({ type: 'number', value });
const sym = name => ({ type: 'symbol', name });
const bin = (op, left, right) => ({ type: 'binary', op, left, right });
const call = (name, ...args) => ({ type: 'call', name, args });
const neg = arg => ({ type: 'unary', op: '-', arg });

describe('parseExpression: numbers and names', () => {
  test('reads decimal and scientific numbers', () => {
    expect(shape(ast('1e-3'))).toEqual(num(0.001));
    expect(shape(ast('.5'))).toEqual(num(0.5));
    expect(shape(ast('2.'))).toEqual(num(2));
    expect(shape(ast('2E+3'))).toEqual(num(2000));
    expect(ast('1.25').raw).toBe('1.25');
  });

  test('names may use any alphabet, digits and underscores', () => {
    expect(shape(ast('k_1 + E_a + tau0 + α*τ'))).toEqual(
      bin('+', bin('+', bin('+', sym('k_1'), sym('E_a')), sym('tau0')), bin('*', sym('α'), sym('τ')))
    );
  });

  test('bx is one name and x2 is a name, b x is a product', () => {
    expect(shape(ast('bx'))).toEqual(sym('bx'));
    expect(shape(ast('x2'))).toEqual(sym('x2'));
    expect(shape(ast('b x'))).toEqual(bin('*', sym('b'), sym('x')));
  });

  test('records character offsets on every node', () => {
    const t = ast('a + exp(x)');
    expect([t.start, t.end]).toEqual([0, 10]);
    expect([t.right.start, t.right.end]).toEqual([4, 10]);
    expect([t.right.args[0].start, t.right.args[0].end]).toEqual([8, 9]);
  });
});

describe('parseExpression: precedence', () => {
  test('^ groups from the right and ** is ^', () => {
    expect(shape(ast('2^3^2'))).toEqual(bin('^', num(2), bin('^', num(3), num(2))));
    expect(shape(ast('a**b'))).toEqual(bin('^', sym('a'), sym('b')));
  });

  test('unary minus binds more loosely than ^', () => {
    expect(shape(ast('-x^2'))).toEqual(neg(bin('^', sym('x'), num(2))));
    expect(shape(ast('(-x)^2'))).toEqual(bin('^', neg(sym('x')), num(2)));
    expect(shape(ast('2^-x'))).toEqual(bin('^', num(2), neg(sym('x'))));
  });

  test('sums and products associate to the left', () => {
    expect(shape(ast('a - b - c'))).toEqual(bin('-', bin('-', sym('a'), sym('b')), sym('c')));
    expect(shape(ast('a/b*c'))).toEqual(bin('*', bin('/', sym('a'), sym('b')), sym('c')));
  });

  test('a unary sign may follow an operator', () => {
    expect(shape(ast('a*-b'))).toEqual(bin('*', sym('a'), neg(sym('b'))));
    expect(shape(ast('a - -b'))).toEqual(bin('-', sym('a'), neg(sym('b'))));
  });
});

describe('parseExpression: implicit multiplication', () => {
  test.each([
    ['2x', bin('*', num(2), sym('x'))],
    ['3(x+1)', bin('*', num(3), bin('+', sym('x'), num(1)))],
    ['2 pi', bin('*', num(2), sym('pi'))],
    ['(a+b)(c+d)', bin('*', bin('+', sym('a'), sym('b')), bin('+', sym('c'), sym('d')))],
    ['2exp(x)', bin('*', num(2), call('exp', sym('x')))],
    ['(a+b)x', bin('*', bin('+', sym('a'), sym('b')), sym('x'))],
    ['2x^2', bin('*', num(2), bin('^', sym('x'), num(2)))],
    ['a + b x + c x^2', bin('+', bin('+', sym('a'), bin('*', sym('b'), sym('x'))),
      bin('*', sym('c'), bin('^', sym('x'), num(2))))]
  ])('%s', (text, expected) => {
    expect(shape(ast(text))).toEqual(expected);
  });

  test('marks the node as implicit', () => {
    expect(ast('2x').implicit).toBe(true);
    expect(ast('2*x').implicit).toBeUndefined();
  });

  test('a name that is not a function, followed by a bracket, multiplies', () => {
    // Unary minus binds more tightly than '*', so -k*t is (-k)*t, as in Python.
    expect(shape(ast('A(1 - exp(-k*t))'))).toEqual(
      bin('*', sym('A'), bin('-', num(1), call('exp', bin('*', neg(sym('k')), sym('t')))))
    );
    expect(shape(ast('tau(1-x)'))).toEqual(bin('*', sym('tau'), bin('-', num(1), sym('x'))));
    expect(shape(ast('n(1-x)'))).toEqual(bin('*', sym('n'), bin('-', num(1), sym('x'))));
  });

  test('a name a letter or two from a function multiplies, with a note naming the function', () => {
    const r = parseExpression('expo(-x/tau)');
    expect(shape(r.ast)).toEqual(bin('*', sym('expo'), bin('/', neg(sym('x')), sym('tau'))));
    expect(r.notes).toEqual([
      "'expo(…)' is read as expo times the bracket, since there is no function called expo. " +
      'Write exp(…) if you meant the function exp.'
    ]);
    expect(parseExpression('sine(x)').notes[0]).toMatch(/Write sin\(…\) if you meant the function sin\./);
    const imax = parseExpression('Imax*0 + Imax(1 - exp(-t/tau))');
    expect(shape(imax.ast.right)).toEqual(
      bin('*', sym('Imax'), bin('-', num(1), call('exp', bin('/', neg(sym('t')), sym('tau')))))
    );
    expect(imax.notes[0]).toMatch(/^'Imax\(…\)' is read as Imax times the bracket/);
    expect(parseEquation('y = expo(x)')).toMatchObject({ ok: true, notes: [expect.stringMatching(/exp\(…\)/)] });
    expect(parseExpression('A(1 - x)').notes).toEqual([]);
    expect(parseExpression('tau(1 - x)').notes).toEqual([]);
  });

  test('on the left of = a bracket lists the variables instead', () => {
    expect(parseEquation('A(t) = A0*exp(-k*t)')).toMatchObject({ ok: true, dependent: 'A', arguments: ['t'] });
  });

  test('a known function name always calls', () => {
    expect(shape(ast('gamma(1 - x)'))).toEqual(call('gamma', bin('-', num(1), sym('x'))));
  });

  test('reads t/2tau left to right and says so', () => {
    const r = parseExpression('t/2tau');
    expect(shape(r.ast)).toEqual(bin('*', bin('/', sym('t'), num(2)), sym('tau')));
    expect(r.notes[0]).toBe("'t/2tau' is read as (t/2)*tau. Write t/(2*tau) if you meant to divide by both.");
  });

  test('a number after a value needs an operator', () => {
    expect(err('x 2').message).toBe("Missing an operator between 'x' and '2'");
  });
});

describe('parseExpression: pasted text', () => {
  test('unicode operators, superscripts and other brackets', () => {
    expect(shape(ast('a × b − c ÷ d'))).toEqual(bin('-', bin('*', sym('a'), sym('b')), bin('/', sym('c'), sym('d'))));
    expect(shape(ast('x² + y⁻¹'))).toEqual(bin('+', bin('^', sym('x'), num(2)), bin('^', sym('y'), neg(num(1)))));
    expect(shape(ast('[a + b]*{c}'))).toEqual(bin('*', bin('+', sym('a'), sym('b')), sym('c')));
    expect(shape(ast('π*r^2'))).toEqual(bin('*', sym('pi'), bin('^', sym('r'), num(2))));
  });

  test('NumPy prefixes and LaTeX backslashes are dropped', () => {
    expect(shape(ast('np.exp(-x) + scipy.special.erf(x)'))).toEqual(
      bin('+', call('exp', neg(sym('x'))), call('erf', sym('x')))
    );
    expect(shape(ast('\\alpha \\cdot \\exp(-t/\\tau)'))).toEqual(
      bin('*', sym('alpha'), call('exp', bin('/', neg(sym('t')), sym('tau'))))
    );
  });
});

describe('parseExpression: messages', () => {
  test.each([
    ['y = A*exp(-t/tau', "Missing ')' to close the '(' at position 10", 9, 10],
    ['expo(x, y)', "Unknown function 'expo'. Did you mean exp?", 0, 10],
    ['EXP(x)', "Unknown function 'EXP'. Did you mean exp?", 0, 3],
    ['Sin(x)', "Unknown function 'Sin'. Did you mean sin?", 0, 3],
    ['lg(x)', "Unknown function 'lg'. Did you mean log10?", 0, 2],
    ['foo(x, y)', "Unknown function 'foo'", 0, 9],
    ['sin(x, y)', "'sin' takes 1 argument, not 2", 0, 9],
    ['atan2(x)', "'atan2' takes 2 arguments, not 1", 0, 8],
    ['a*/b', "Two operators in a row: '*/'", 1, 3],
    ['', 'The equation is empty', 0, 0],
    ['   ', 'The equation is empty', 0, 0],
    ['a # b', "Unexpected character '#'", 2, 3],
    ['|x|', "Unexpected character '|'. Write abs(x) for an absolute value.", 0, 1],
    ['a +', "Missing a value after '+'", 2, 3],
    ['*a', "Missing a value before '*'", 0, 1],
    ['(a]', "The '(' at position 1 is closed by ']'; use ')'", 0, 3],
    ['a)', "There is a ')' with no matching opening bracket", 1, 2],
    ['()', "Empty brackets: put something inside '()'", 0, 2],
    ['f(,x)', "Missing an argument before ','", 2, 3],
    ['atan2(y,)', "Missing an argument after ','", 7, 8],
    ['a, b', "Unexpected ','. Commas only separate the arguments of a function, as in atan2(y, x)", 1, 2],
    ['1.2.3', "Malformed number '1.2.3'", 0, 5],
    ['sin x', "'sin' is a function, so it needs brackets: sin(…)", 0, 3],
    ['sin^2(x)', 'Write sin(x)^2 rather than sin^2(x)', 0, 4],
    ['\\frac{a}{b}', "Write fractions with '/', for example (a + b)/(c + d)", 0, 5],
    ['a = b', "Only one '=' is allowed", 2, 3],
    // Brackets are matched first, so the unclosed one is named even after another slip.
    ['a*/b + (c', "Missing ')' to close the '(' at position 8", 7, 8],
    ['sin(a*(b + c)', "Missing ')' to close the '(' at position 4", 3, 4],
    ['a*(b + exp(c', "Missing ')' to close the '(' at position 11", 10, 11],
    ['a + b)', "There is a ')' with no matching opening bracket", 5, 6],
    ['(a +)', "Missing a value after '+'", 3, 5]
  ])('%s', (text, message, start, end) => {
    expect(err(text)).toEqual({ message, start, end });
  });

  test('does not suggest a function for a Greek letter or a subscripted name', () => {
    expect(parseExpression('tau(x)').ok).toBe(true);
    expect(parseExpression('k_1(x)').ok).toBe(true);
    expect(parseExpression('a0(x)').ok).toBe(true);
  });

  test('never throws, even on nonsense', () => {
    for (const bad of [null, undefined, 42, '((((((((((', ')))', '+-*/^', 'x'.repeat(5000), '('.repeat(1000)]) {
      expect(() => parseExpression(bad)).not.toThrow();
    }
    expect(parseExpression('('.repeat(1000)).error.message).toMatch(/nested too deeply|Missing/);
  });
});

describe('parseEquation', () => {
  test('y = rhs', () => {
    const r = parseEquation('y = A*exp(-t/tau) + y0');
    expect(r.ok).toBe(true);
    expect(r.dependent).toBe('y');
    expect(r.arguments).toBeNull();
    expect(r.rhsStart).toBe(4);
    expect(r.ast.start).toBe(4);
    expect(toText(r.ast)).toBe('A*exp(-t/tau) + y0');
  });

  test('f(x) = rhs, I(V) = rhs and y(t, T) = rhs', () => {
    expect(parseEquation('f(x) = a*x').arguments).toEqual(['x']);
    expect(parseEquation('I(V) = I0*(exp(V/(n*Vt)) - 1)')).toMatchObject({ ok: true, dependent: 'I', arguments: ['V'] });
    expect(parseEquation('y(t, T) = a*t + b*T')).toMatchObject({ ok: true, dependent: 'y', arguments: ['t', 'T'] });
  });

  test('a bare right-hand side', () => {
    const r = parseEquation('a + b x');
    expect(r).toMatchObject({ ok: true, dependent: null, arguments: null, rhsStart: 0 });
  });

  test.each([
    ['y =', "Nothing after '='", 2, 3],
    ['y = ', "Nothing after '='", 2, 3],
    ['', 'The equation is empty', 0, 0],
    ['y = y + 1', "'y' appears on both sides of '='. The right side should give y in terms of the other quantities", 4, 5],
    ['log(y) = a*x', 'The left side should name what is fitted, such as y or f(x). To fit log(y), transform the y data first and fit that column', 0, 6],
    ['2y = x', "The left side of '=' should be a name such as y, or f(x)", 0, 2],
    ['f(x, x) = x', "'x' is listed twice in f(x, x)", 5, 6],
    ['a = b = c', "Only one '=' is allowed", 6, 7],
    ['y = A*exp(-t/tau', "Missing ')' to close the '(' at position 10", 9, 10],
    ['f(x = a*x', "Missing ')' to close the '(' at position 2", 1, 2]
  ])('%s', (text, message, start, end) => {
    const r = parseEquation(text);
    expect(r.ok).toBe(false);
    expect(r.error).toEqual({ message, start, end });
  });

  test('carries the reading notes', () => {
    expect(parseEquation('y = t/2tau').notes).toHaveLength(1);
  });
});

describe('symbolsOf', () => {
  test('lists names and functions in order of first appearance', () => {
    const r = symbolsOf(ast('y0 + A*exp(-t/tau) + sin(A*t)'));
    expect(r.identifiers).toEqual(['y0', 'A', 't', 'tau']);
    expect(r.functions).toEqual(['exp', 'sin']);
  });
});

describe('classify', () => {
  const eq = text => parseEquation(text);

  test.each([
    ['y = A*exp(-t/tau) + y0', ['t'], ['A', 'tau', 'y0']],
    ['I(V) = I0*(exp(V/(n*Vt)) - 1)', ['V'], ['I0', 'n', 'Vt']],
    ['k = A*exp(-Ea/(R*T))', ['T'], ['A', 'Ea', 'R']],
    ['y = a + b x + c x^2', ['x'], ['a', 'b', 'c']],
    ['sigma = s0 + s1*erf((x - mu)/(sqrt(2)*w))', ['x'], ['s0', 's1', 'mu', 'w']],
    ['z = a*x + b*y + c', ['x', 'y'], ['a', 'b', 'c']],
    ['y(t, T) = a*t + b*T', ['t', 'T'], ['a', 'b']],
    ['y = a*x1 + b*x2', ['x1', 'x2'], ['a', 'b']],
    ['y = a0 + a1*x0 + a2*x1', ['x0', 'x1'], ['a0', 'a1', 'a2']],
    ['x = A*exp(-t/tau)*cos(w*t) + x0', ['t'], ['A', 'tau', 'w', 'x0']],
    ['y = m*u + q', ['q'], ['m', 'u']]
  ])('%s', (text, independent, parameters) => {
    const r = classify(eq(text));
    expect(r.independent).toEqual(independent);
    expect(r.parameters).toEqual(parameters);
    expect(r.unknownFunctions).toEqual([]);
  });

  test('accepts a bare AST and an explicit choice of variables', () => {
    const r = classify(ast('a*exp(-b*u)'), { independent: ['u'] });
    expect(r).toMatchObject({ independent: ['u'], parameters: ['a', 'b'] });
  });

  test('treats pi and e as constants unless told otherwise', () => {
    expect(classify(eq('y = A*e^(-k*t) + pi'))).toMatchObject({ parameters: ['A', 'k'], constants: ['e', 'pi'], notes: [] });
    expect(classify(eq('y = a*e + x'), { parameters: ['e'] })).toMatchObject({ parameters: ['a', 'e'], constants: [] });
    expect(classify(eq('y = a*e + x'), { constants: ['pi'] })).toMatchObject({ parameters: ['a', 'e'], constants: [] });
    expect(classify(eq('y = a*e + x')).notes[0]).toMatch(/Euler/);
  });

  test('points out names that look like physical constants', () => {
    const r = classify(eq('k = A*exp(-Ea/(R*T))'));
    expect(r.suggestedConstants).toEqual([{ name: 'R', ...PHYSICAL_CONSTANTS.R }]);
    expect(PHYSICAL_CONSTANTS.R.value).toBeCloseTo(8.314462618, 9);
  });

  test('handles empty input', () => {
    expect(classify(null)).toMatchObject({ independent: [], parameters: [] });
  });
});

describe('FUNCTIONS and CONSTANTS', () => {
  test('are frozen tables with arity, description and a Python spelling', () => {
    expect(Object.isFrozen(FUNCTIONS)).toBe(true);
    for (const [name, f] of Object.entries(FUNCTIONS)) {
      expect(typeof f.description).toBe('string');
      expect(f.python).toMatch(/^(np|scipy\.special)\./);
      expect(Array.isArray(f.arity) || Number.isInteger(f.arity)).toBe(true);
      if (f.aliasOf) expect(FUNCTIONS[f.aliasOf]).toBeDefined();
      expect(name).toMatch(/^[a-z][a-z0-9]*$/);
    }
    expect(FUNCTIONS.heaviside.python).toBe('np.heaviside(…, 0.5)');
    expect(FUNCTIONS.ln.aliasOf).toBe('log');
    expect(CONSTANTS.pi.value).toBe(Math.PI);
    expect(CONSTANTS.e.value).toBe(Math.E);
  });
});

describe('compile', () => {
  const at = (text, names, values) => compile(ast(text), names)(values);

  test('evaluates arithmetic in the order of the names', () => {
    expect(at('A*exp(-t/tau) + y0', ['t', 'A', 'tau', 'y0'], [2, 5, 4, 1])).toBeCloseTo(5 * Math.exp(-0.5) + 1, 12);
    expect(at('a + b x + c x^2', ['x', 'a', 'b', 'c'], new Float64Array([3, 1, 2, 0.5]))).toBe(1 + 6 + 4.5);
    expect(at('2^3^2', [], [])).toBe(512);
    expect(at('-x^2', ['x'], [3])).toBe(-9);
    expect(at('x^-1', ['x'], [4])).toBe(0.25);
  });

  test('uses the constants unless they are named', () => {
    expect(at('e^x + pi', ['x'], [1])).toBeCloseTo(Math.E + Math.PI, 12);
    expect(at('e*x', ['x', 'e'], [2, 10])).toBe(20);
  });

  test('every function matches its definition', () => {
    const cases = {
      'ln(x)': Math.log(2.5), 'log(x)': Math.log(2.5), 'log10(x)': Math.log10(2.5), 'log2(x)': Math.log2(2.5),
      'sqrt(x)': Math.sqrt(2.5), 'cbrt(-x)': -Math.cbrt(2.5), 'abs(-x)': 2.5, 'sign(-x)': -1,
      'sin(x)': Math.sin(2.5), 'cos(x)': Math.cos(2.5), 'tan(x)': Math.tan(2.5), 'asin(x/4)': Math.asin(0.625),
      'acos(x/4)': Math.acos(0.625), 'atan(x)': Math.atan(2.5), 'atan2(x, 1)': Math.atan2(2.5, 1),
      'sinh(x)': Math.sinh(2.5), 'cosh(x)': Math.cosh(2.5), 'tanh(x)': Math.tanh(2.5), 'asinh(x)': Math.asinh(2.5),
      'acosh(x)': Math.acosh(2.5), 'atanh(x/4)': Math.atanh(0.625), 'pow(x, 2)': 6.25, 'min(x, 1)': 1,
      'max(x, 1)': 2.5, 'floor(x)': 2, 'ceil(x)': 3, 'round(x)': 2, 'round(3.5)': 4, 'round(-0.5)': -0,
      'heaviside(x)': 1, 'heaviside(-x)': 0, 'heaviside(0)': 0.5, 'sinc(0)': 1, 'sinc(0.5)': 2 / Math.PI,
      'arcsin(x/4)': Math.asin(0.625), 'arctan2(x, 1)': Math.atan2(2.5, 1),
      'erf(0.5)': 0.5204998778130465, 'erfc(3)': 2.209049699858544e-5, 'gamma(5.5)': 52.34277778455352,
      'gamma(5)': 24, 'lgamma(100)': 359.1342053695754, 'gamma(-1.5)': 2.3632718012073544
    };
    for (const [text, expected] of Object.entries(cases)) {
      const value = at(text, ['x'], [2.5]);
      if (Object.is(expected, -0)) expect(Object.is(value, -0)).toBe(true);
      else expect(value).toBeCloseTo(expected, 12);
    }
  });

  test('special functions are accurate in the tails', () => {
    expect(special.erf(2.4)).toBeCloseTo(0.999311486103355, 15);
    expect(special.erfc(6) / 2.1519736712498913e-17).toBeCloseTo(1, 12);
    expect(special.erfc(-1)).toBeCloseTo(1.842700792949715, 14);
    expect(special.lgamma(0.5)).toBeCloseTo(0.5723649429247001, 13);
    expect(special.lgamma(1e5)).toBeCloseTo(1051287.7089736232, 6);
    expect(special.digamma(1)).toBeCloseTo(-0.5772156649015329, 12);
    expect(special.digamma(-0.5)).toBeCloseTo(0.03648997397857652, 12);
    expect(special.gamma(0)).toBe(Infinity);
    expect(Number.isNaN(special.gamma(-2))).toBe(true);
  });

  test('refuses a name it has no value for', () => {
    expect(() => compile(ast('a*x'), ['x'])).toThrow(/no value supplied for 'a'/);
  });
});

describe('differentiate', () => {
  const names = ['x', 'a'];
  const check = (text, points = [[0.7, 1.3], [1.9, 0.45], [2.5, 1.1]]) => {
    const tree = ast(text);
    const d = differentiate(tree, 'a');
    expect(d).not.toBeNull();
    const f = compile(tree, names);
    const g = compile(d, names);
    for (const [x, a] of points) {
      const h = 1e-6 * Math.max(1, Math.abs(a));
      const numeric = (f([x, a + h]) - f([x, a - h])) / (2 * h);
      const analytic = g([x, a]);
      expect(Math.abs(numeric - analytic)).toBeLessThan(1e-6 * Math.max(1, Math.abs(numeric)));
    }
  };

  test.each([
    'exp(a*x)', 'log(a*x)', 'ln(a + x)', 'log10(a*x)', 'log2(a*x)', 'sqrt(a*x)', 'cbrt(a*x - 3)', 'abs(a*x - 1)',
    'sign(a*x - 1)*a', 'sin(a*x)', 'cos(a*x)', 'tan(a*x)', 'asin(a*x/4)', 'acos(a*x/4)', 'atan(a*x)',
    'atan2(a*x, a + x)', 'sinh(a*x)', 'cosh(a*x)', 'tanh(a*x)', 'asinh(a*x)', 'acosh(a*x + 1)', 'atanh(a*x/4)',
    'erf(a*x)', 'erfc(a*x)', 'gamma(a*x)', 'lgamma(a*x)', 'pow(a, x) + pow(x, a) + pow(a, a)', 'min(a*x, 2)',
    'max(a*x, 2)', 'heaviside(a*x - 1)*a', 'floor(a*x)*a', 'ceil(a*x)*a', 'round(a*x)*a', 'sinc(a*x)',
    'sinc(a*x - 0.6)', 'x^a + a^x + a^a + a^2 + (a*x)^0.5', '(a*x + 1)/(a - x) - a/x + x/a', '-a*x + +a',
    'arcsin(a*x/4) + arctan2(a, x)', 'e^(a*x) + pi*a', 'a^-2 + 2^-a'
  ])('%s', text => check(text));

  test('simplifies as it goes', () => {
    const d = (text, name) => toText(differentiate(ast(text), name));
    expect(d('a*x', 'a')).toBe('x');
    expect(d('a*x + b', 'b')).toBe('1');
    expect(d('a*x + b', 'c')).toBe('0');
    expect(d('x^2', 'x')).toBe('2*x');
    expect(d('x^3', 'x')).toBe('3*x^2');
    expect(d('A*exp(-t/tau) + y0', 'A')).toBe('exp(-t/tau)');
    expect(d('A*exp(-t/tau) + y0', 'tau')).toBe('A*(exp(-t/tau)*(t/tau^2))');
    expect(d('a - b*x', 'b')).toBe('-x');
  });

  test('handles a hand-built call it has no rule for by returning null', () => {
    expect(differentiate(call('mystery', sym('a')), 'a')).toBeNull();
    expect(differentiate(null, 'a')).toBeNull();
  });
});

describe('toText', () => {
  test.each([
    ['2x', '2*x'],
    ['a+b x+c x^2', 'a + b*x + c*x^2'],
    ['a*(-b/c)', 'a*(-b/c)'],
    ['a - (b - c)', 'a - (b - c)'],
    ['a/(b*c)', 'a/(b*c)'],
    ['(a^b)^c', '(a^b)^c'],
    ['a^b^c', 'a^b^c'],
    ['(-x)^2', '(-x)^2'],
    ['-x^2', '-x^2'],
    ['2^-3', '2^(-3)'],
    ['np.exp(-x) + .5', 'exp(-x) + 0.5'],
    ['x²', 'x^2'],
    ['A(1-exp(-k t))', 'A*(1 - exp(-k*t))']
  ])('%s → %s', (text, expected) => {
    expect(toText(ast(text))).toBe(expected);
  });

  test('round-trips every shape', () => {
    const samples = [
      'A*exp(-t/tau) + y0', 'I0*(exp(V/(n*Vt)) - 1)', 'A*exp(-Ea/(R*T))', 'a + b x + c x^2',
      's0 + s1*erf((x - mu)/(sqrt(2)*w))', 'a*x + b*y + c', '-(a+b)*(c-d)/(e^-x)^2', 'atan2(y, x)^-1', '--x',
      'min(a, b)*max(c, d) - 1e-3', 'a - -b + (-c)', 'a*-b', 'x/2/y'
    ];
    for (const s of samples) {
      const tree = ast(s);
      expect(shape(ast(toText(tree)))).toEqual(shape(tree));
    }
    for (const s of samples) {
      const d = differentiate(ast(s), 'a');
      if (d.type !== 'number') expect(shape(ast(toText(d)))).toEqual(shape(d));
    }
  });
});

describe('toLatex', () => {
  test.each([
    ['A*exp(-t/tau) + y0', 'A e^{-t/\\tau} + y_{0}'],
    ['I0*(exp(V/(n*Vt)) - 1)', 'I_{0} \\left(e^{V/\\left(n \\mathit{Vt}\\right)} - 1\\right)'],
    ['A*exp(-Ea/(R*T))', 'A e^{-\\mathit{Ea}/\\left(R T\\right)}'],
    ['a + b x + c x^2', 'a + b x + c x^{2}'],
    ['s0 + s1*erf((x - mu)/(sqrt(2)*w))', 's_{0} + s_{1} \\operatorname{erf}\\left(\\frac{x - \\mu}{\\sqrt{2} w}\\right)'],
    ['A*exp(-(x-mu)^2/(2*s^2)) + c', 'A \\exp\\left(-\\frac{\\left(x - \\mu\\right)^{2}}{2 s^{2}}\\right) + c'],
    ['k_1*E_a/tau0', '\\frac{k_{1} E_{a}}{\\tau_{0}}'],
    ['T_melt + k_alpha + α', 'T_{\\mathrm{melt}} + k_{\\alpha} + \\alpha'],
    ['1e-3*x + 2.5e4', '10^{-3} x + 2.5 \\times 10^{4}'],
    ['x*2', 'x \\cdot 2'],
    ['2*3', '2 \\cdot 3'],
    ['(a+b)(c+d)', '\\left(a + b\\right) \\left(c + d\\right)'],
    ['-x^2', '-x^{2}'],
    ['(-x)^2', '\\left(-x\\right)^{2}'],
    ['2^3^2', '2^{3^{2}}'],
    ['sqrt(x) + cbrt(x) + abs(x) + floor(x)', '\\sqrt{x} + \\sqrt[3]{x} + \\left|x\\right| + \\left\\lfloor x \\right\\rfloor'],
    ['ln(x) + log10(x) + gamma(x) + lgamma(x)', '\\ln\\left(x\\right) + \\log_{10}\\left(x\\right) + \\Gamma\\left(x\\right) + \\ln\\Gamma\\left(x\\right)'],
    ['heaviside(x) + sign(x) + sinc(x) + asinh(x)', 'H\\left(x\\right) + \\operatorname{sgn}\\left(x\\right) + \\operatorname{sinc}\\left(x\\right) + \\operatorname{arsinh}\\left(x\\right)'],
    ['pow(x, 2) + pow(a + b, 2)', 'x^{2} + \\left(a + b\\right)^{2}'],
    ['a - (-b)', 'a - \\left(-b\\right)'],
    ['a*(-b)', 'a \\left(-b\\right)']
  ])('%s', (text, expected) => {
    expect(toLatex(ast(text))).toBe(expected);
  });

  test('renders a whole equation from a parseEquation result', () => {
    expect(toLatex(parseEquation('I(V) = I0*V'))).toBe('I\\left(V\\right) = I_{0} V');
    expect(toLatex(parseEquation('sigma = a'))).toBe('\\sigma = a');
    expect(toLatex(parseEquation('a*x'))).toBe('a x');
  });

  test('symbolToLatex', () => {
    expect(symbolToLatex('tau')).toBe('\\tau');
    expect(symbolToLatex('tau0')).toBe('\\tau_{0}');
    expect(symbolToLatex('k_B')).toBe('k_{B}');
    expect(symbolToLatex('conc')).toBe('\\mathit{conc}');
    expect(symbolToLatex('μ')).toBe('\\mu');
    expect(symbolToLatex('')).toBe('');
  });
});
