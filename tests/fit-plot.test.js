/**
 * The parts of js/fit-plot.js that need no browser: matplotlib's tick
 * locators and formatters as ported, Python's % formatting, the maths-text
 * converter, and the figure buildFitFigure lays out (text measured from
 * font averages under Node).
 *
 * MPL holds matplotlib 3.6.3's own answers for a few ranges, recorded with
 * the locator and formatter classes the generated script uses; the port must
 * give the same ticks and the same label text.
 */
import { describe, test, expect } from '@jest/globals';
import { deflateSync } from 'node:zlib';
// zlib's own crc32 needs Node 20.15; the package supports Node 18.
import { crc32 } from '../src/core/zip.js';
import {
  maxNLocator, multipleLocator, logLocator, autoMinorLocator, scalarFormat, logFormat, pyPercent, printfFormat,
  textToHtml, axisTicks, fitCurveGrid, buildFitFigure, pngWithDpi, plotlyDash, rgba, fitFigure, foldFigureStyle
} from '../js/fit-plot.js';
import { defaultPlotStyle, normalisePlotStyle } from '../src/core/plot-style.js';
import { withBackground, backgroundChoice, normaliseFigure, COLOR_CYCLE_DARK } from '../src/core/figure.js';

const MPL = {"lin": [{"a": -398810056.8485015, "b": 10339199069.722752, "n": 4, "auto": [-5000000000.0, 0.0, 5000000000.0, 10000000000.0, 15000000000.0], "cnt": 9, "maxn": [-1500000000.0, 0.0, 1500000000.0, 3000000000.0, 4500000000.0, 6000000000.0, 7500000000.0, 9000000000.0, 10500000000.0], "step": 1450000000.0, "mult": [-1450000000.0, 0.0, 1450000000.0, 2900000000.0, 4350000000.0, 5800000000.0, 7250000000.0, 8700000000.0, 10150000000.0, 11600000000.0], "lab": ["−0.5", "0.0", "0.5", "1.0", "1.5"], "off": "1e10", "slab": ["$\\mathdefault{−0.5}$", "$\\mathdefault{0.0}$", "$\\mathdefault{0.5}$", "$\\mathdefault{1.0}$", "$\\mathdefault{1.5}$"], "soff": "$\\times\\mathdefault{10^{10}}\\mathdefault{}$", "minor": [0.0, 1000000000.0, 2000000000.0, 3000000000.0, 4000000000.0, 5000000000.0, 6000000000.0, 7000000000.0, 8000000000.0, 9000000000.0, 10000000000.0]}, {"a": 55.44693628554259, "b": 55.455981099505834, "n": 1, "auto": [55.445, 55.45, 55.455, 55.46], "cnt": 6, "maxn": [55.446, 55.448, 55.449999999999996, 55.452, 55.454, 55.455999999999996], "step": 0.000923, "mult": [55.446456, 55.447379, 55.448302, 55.449225, 55.450148, 55.451071, 55.451994, 55.452917, 55.45384, 55.454763, 55.455686, 55.456609], "lab": ["−0.005", "0.000", "0.005", "0.010"], "off": "+5.545e1", "slab": ["$\\mathdefault{−5}$", "$\\mathdefault{0}$", "$\\mathdefault{5}$", "$\\mathdefault{10}$"], "soff": "$\\times\\mathdefault{10^{−3}}\\mathdefault{+5.545 \\times 10^{1}}$", "minor": [55.447, 55.448, 55.449000000000005, 55.45, 55.451, 55.452000000000005, 55.453, 55.45400000000001, 55.455000000000005]}, {"a": -2.3056833093800333, "b": 0.94749515643894, "n": 7, "auto": [-2.5, -2.0, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0], "cnt": 8, "maxn": [-2.5, -2.0, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0], "step": 0.547, "mult": [-2.7350000000000003, -2.188, -1.6410000000000002, -1.0940000000000003, -0.5470000000000002, 0.0, 0.5469999999999997, 1.0939999999999999], "lab": ["−2.5", "−2.0", "−1.5", "−1.0", "−0.5", "0.0", "0.5", "1.0"], "off": "", "slab": ["$\\mathdefault{−2.5}$", "$\\mathdefault{−2.0}$", "$\\mathdefault{−1.5}$", "$\\mathdefault{−1.0}$", "$\\mathdefault{−0.5}$", "$\\mathdefault{0.0}$", "$\\mathdefault{0.5}$", "$\\mathdefault{1.0}$"], "soff": "", "minor": [-2.3, -2.2, -2.1, -2.0, -1.9, -1.7999999999999998, -1.6999999999999997, -1.5999999999999999, -1.4999999999999998, -1.3999999999999997, -1.2999999999999996, -1.1999999999999997, -1.0999999999999996, -0.9999999999999996, -0.8999999999999997, -0.7999999999999996, -0.6999999999999995, -0.5999999999999994, -0.4999999999999991, -0.39999999999999947, -0.29999999999999893, -0.1999999999999993, -0.0999999999999992, 8.881784197001252e-16, 0.10000000000000098, 0.20000000000000107, 0.30000000000000115, 0.40000000000000124, 0.5000000000000009, 0.600000000000001, 0.7000000000000011, 0.8000000000000012, 0.9000000000000012]}, {"a": -0.5537894394923937, "b": 4.35586721704521, "n": 6, "auto": [-1.0, 0.0, 1.0, 2.0, 3.0, 4.0, 5.0], "cnt": 3, "maxn": [-2.0, 0.0, 2.0, 4.0, 6.0], "step": 2.08, "mult": [-2.08, 0.0, 2.08, 4.16, 6.24], "lab": ["−1", "0", "1", "2", "3", "4", "5"], "off": "", "slab": ["$\\mathdefault{−1}$", "$\\mathdefault{0}$", "$\\mathdefault{1}$", "$\\mathdefault{2}$", "$\\mathdefault{3}$", "$\\mathdefault{4}$", "$\\mathdefault{5}$"], "soff": "", "minor": [-0.3999999999999999, -0.19999999999999996, 0.0, 0.19999999999999996, 0.3999999999999999, 0.5999999999999999, 0.7999999999999998, 0.9999999999999998, 1.1999999999999997, 1.3999999999999995, 1.5999999999999996, 1.7999999999999994, 1.9999999999999996, 2.1999999999999997, 2.3999999999999995, 2.599999999999999, 2.7999999999999994, 2.9999999999999996, 3.1999999999999993, 3.3999999999999986, 3.5999999999999996, 3.799999999999999, 3.9999999999999982, 4.199999999999999, 4.399999999999999]}, {"a": -6.026047536227196e-06, "b": 1.1665934873267935e-05, "n": 8, "auto": [-7.499999999999999e-06, -4.9999999999999996e-06, -2.4999999999999998e-06, 0.0, 2.4999999999999998e-06, 4.9999999999999996e-06, 7.499999999999999e-06, 9.999999999999999e-06, 1.2499999999999999e-05], "cnt": 3, "maxn": [-1.2e-05, -6e-06, 0.0, 6e-06, 1.2e-05], "step": 3.25e-06, "mult": [-6.5e-06, -3.25e-06, 0.0, 3.2500000000000002e-06, 6.5e-06, 9.75e-06, 1.3000000000000001e-05], "lab": ["−0.75", "−0.50", "−0.25", "0.00", "0.25", "0.50", "0.75", "1.00", "1.25"], "off": "1e−5", "slab": ["$\\mathdefault{−0.75}$", "$\\mathdefault{−0.50}$", "$\\mathdefault{−0.25}$", "$\\mathdefault{0.00}$", "$\\mathdefault{0.25}$", "$\\mathdefault{0.50}$", "$\\mathdefault{0.75}$", "$\\mathdefault{1.00}$", "$\\mathdefault{1.25}$"], "soff": "$\\times\\mathdefault{10^{−5}}\\mathdefault{}$", "minor": [-5.999999999999999e-06, -5.5e-06, -4.9999999999999996e-06, -4.499999999999999e-06, -4e-06, -3.5000000000000004e-06, -3e-06, -2.4999999999999998e-06, -2.0000000000000003e-06, -1.5e-06, -1.0000000000000006e-06, -5.000000000000011e-07, -8.470329472543003e-22, 4.999999999999986e-07, 9.99999999999999e-07, 1.4999999999999992e-06, 1.999999999999998e-06, 2.4999999999999998e-06, 2.9999999999999984e-06, 3.499999999999997e-06, 3.999999999999999e-06, 4.4999999999999976e-06, 4.999999999999996e-06, 5.499999999999998e-06, 5.999999999999997e-06, 6.499999999999999e-06, 6.999999999999997e-06, 7.499999999999996e-06, 7.999999999999998e-06, 8.499999999999997e-06, 8.999999999999995e-06, 9.499999999999997e-06, 9.999999999999996e-06, 1.0499999999999994e-05, 1.0999999999999996e-05, 1.1499999999999995e-05]}], "log": [{"a": 1.4006292130656066e-10, "b": 1.6360512299696952e-10, "n": 4, "major": [1e-11, 1e-10, 1e-09, 1e-08], "minor": [1.3999999999999998e-10, 1.45e-10, 1.4999999999999997e-10, 1.5499999999999998e-10, 1.6e-10, 1.6499999999999997e-10], "lab": ["$\\mathdefault{10^{-11}}$", "$\\mathdefault{10^{-10}}$", "$\\mathdefault{10^{-9}}$", "$\\mathdefault{10^{-8}}$"], "mlab": ["$\\mathdefault{1.4\\times10^{-10}}$", "$\\mathdefault{1.45\\times10^{-10}}$", "$\\mathdefault{1.5\\times10^{-10}}$", "$\\mathdefault{1.55\\times10^{-10}}$", "$\\mathdefault{1.6\\times10^{-10}}$", "$\\mathdefault{1.65\\times10^{-10}}$"]}, {"a": 13.99479114354074, "b": 19.23199032195764, "n": 7, "major": [1.0, 10.0, 100.0, 1000.0], "minor": [13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0], "lab": ["$\\mathdefault{10^{0}}$", "$\\mathdefault{10^{1}}$", "$\\mathdefault{10^{2}}$", "$\\mathdefault{10^{3}}$"], "mlab": ["$\\mathdefault{1.3\\times10^{1}}$", "$\\mathdefault{1.4\\times10^{1}}$", "$\\mathdefault{1.5\\times10^{1}}$", "$\\mathdefault{1.6\\times10^{1}}$", "$\\mathdefault{1.7\\times10^{1}}$", "$\\mathdefault{1.8\\times10^{1}}$", "$\\mathdefault{1.9\\times10^{1}}$", "$\\mathdefault{2\\times10^{1}}$"]}, {"a": 1.2200973962955827e-07, "b": 1078.415876329091, "n": 2, "major": [1e-13, 1e-07, 0.1, 100000.0, 100000000000.0], "minor": [], "lab": ["$\\mathdefault{10^{-13}}$", "$\\mathdefault{10^{-7}}$", "$\\mathdefault{10^{-1}}$", "$\\mathdefault{10^{5}}$", "$\\mathdefault{10^{11}}$"], "mlab": []}, {"a": 2, "b": 30, "n": 9, "major": [0.1, 1.0, 10.0, 100.0, 1000.0], "minor": [0.2, 0.30000000000000004, 0.4, 0.5, 0.6000000000000001, 0.7000000000000001, 0.8, 0.9, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 200.0, 300.0, 400.0, 500.0, 600.0, 700.0, 800.0, 900.0, 2000.0, 3000.0, 4000.0, 5000.0, 6000.0, 7000.0, 8000.0, 9000.0], "lab": ["$\\mathdefault{10^{-1}}$", "$\\mathdefault{10^{0}}$", "$\\mathdefault{10^{1}}$", "$\\mathdefault{10^{2}}$", "$\\mathdefault{10^{3}}$"], "mlab": ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]}, {"a": 0.5, "b": 800, "n": 6, "major": [0.01, 0.1, 1.0, 10.0, 100.0, 1000.0, 10000.0], "minor": [0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.2, 0.30000000000000004, 0.4, 0.5, 0.6000000000000001, 0.7000000000000001, 0.8, 0.9, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 200.0, 300.0, 400.0, 500.0, 600.0, 700.0, 800.0, 900.0, 2000.0, 3000.0, 4000.0, 5000.0, 6000.0, 7000.0, 8000.0, 9000.0, 20000.0, 30000.0, 40000.0, 50000.0, 60000.0, 70000.0, 80000.0, 90000.0], "lab": ["$\\mathdefault{10^{-2}}$", "$\\mathdefault{10^{-1}}$", "$\\mathdefault{10^{0}}$", "$\\mathdefault{10^{1}}$", "$\\mathdefault{10^{2}}$", "$\\mathdefault{10^{3}}$", "$\\mathdefault{10^{4}}$"], "mlab": ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]}, {"a": 0.001, "b": 0.02, "n": 4, "major": [0.0001, 0.001, 0.01, 0.1, 1.0], "minor": [0.0002, 0.00030000000000000003, 0.0004, 0.0005, 0.0006000000000000001, 0.0007, 0.0008, 0.0009000000000000001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009000000000000001, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.2, 0.30000000000000004, 0.4, 0.5, 0.6000000000000001, 0.7000000000000001, 0.8, 0.9, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0], "lab": ["$\\mathdefault{10^{-4}}$", "$\\mathdefault{10^{-3}}$", "$\\mathdefault{10^{-2}}$", "$\\mathdefault{10^{-1}}$", "$\\mathdefault{10^{0}}$"], "mlab": ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]}], "printf": [["%.2f", 0, "0.00"], ["%.2f", 1e+16, "10000000000000000.00"], ["%g", 1e-300, "1e-300"], ["%.3e", -2.675, "-2.675e+00"], ["%d", 0.375, "0"], ["%5.1f", 1.5, "  1.5"], ["%+.1f", 1, "+1.0"], ["%+.1f", 2.5e-05, "+0.0"], ["%.0f", 99999.5, "100000"], ["%#.0f", 3.14159, "3."], ["%.1f%%", 123456.789, "123456.8%"], ["%e", 0.125, "1.250000e-01"], ["%.3g", 0.5, "0.5"], ["%10.4g", -0.0, "        -0"], ["%10.4g", 255, "       255"], ["%-6.2f|", 0.0001234, "0.00  |"], ["%E", 0.5, "5.000000E-01"], ["%G", -0.0, "-0"], ["%G", 255, "255"], ["%.12g", 0.0001234, "0.0001234"], ["% .2f", 1e+21, " 1000000000000000000000.00"], ["%08.3f", 1e-05, "0000.000"]]};

const AUTO_STEPS = [1, 2, 2.5, 5, 10];
const close = (got, want) => {
  expect(got.length).toBe(want.length);
  got.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThanOrEqual(1e-9 * Math.max(1e-300, Math.abs(v), Math.abs(want[i]))));
};

describe('tick locators, against matplotlib 3.6.3', () => {
  test.each(MPL.lin.map((c) => [c.a, c.b, c]))('linear axis %p to %p', (a, b, c) => {
    close(maxNLocator(a, b, c.n, AUTO_STEPS), c.auto);          // AutoLocator
    close(maxNLocator(a, b, c.cnt), c.maxn);                    // MaxNLocator(nbins)
    close(multipleLocator(a, b, c.step).locs, c.mult);          // MultipleLocator
    close(autoMinorLocator(c.auto, [a, b]), c.minor);           // AutoMinorLocator
  });
  test.each(MPL.log.map((c) => [c.a, c.b, c]))('log axis %p to %p', (a, b, c) => {
    close(logLocator(a, b, { numticks: c.n }), c.major);
    close(logLocator(a, b, { subs: 'auto', numticks: c.n }), c.minor);
  });
});

describe('tick labels, against matplotlib 3.6.3', () => {
  test.each(MPL.lin.map((c) => [c.a, c.b, c]))('ScalarFormatter %p to %p', (a, b, c) => {
    const plain = scalarFormat(c.auto, [a, b]);
    expect(plain.labels).toEqual(c.lab.map((t) => textToHtml(t)));
    expect(plain.offset).toBe(textToHtml(c.off));
    const sci = scalarFormat(c.auto, [a, b], { sci: true });
    expect(sci.labels).toEqual(c.slab.map((t) => textToHtml(t)));
    expect(sci.offset).toBe(textToHtml(c.soff));
  });
  test.each(MPL.log.map((c) => [c.a, c.b, c]))('LogFormatterSciNotation %p to %p', (a, b, c) => {
    expect(logFormat(c.major, [a, b])).toEqual(c.lab.map((t) => textToHtml(t)));
    expect(logFormat(c.minor, [a, b])).toEqual(c.mlab.map((t) => textToHtml(t)));
  });
  test('FormatStrFormatter: Python % formatting', () => {
    for (const [fmt, v, want] of MPL.printf) expect(pyPercent(fmt, v)).toBe(want);
    expect(pyPercent('%.2f', 2.675)).toBe('2.67');       // the double is just below 2.675
    expect(pyPercent('%.0f', 0.5)).toBe('0');            // half to even
    expect(pyPercent('%.1f', 1e21)).toBe('1000000000000000000000.0');
    expect(pyPercent('%5.1f%%', 12.345)).toBe(' 12.3%');
  });
  test('printfFormat accepts one conversion only', () => {
    expect(printfFormat('%.2f')).toBe('%.2f');
    expect(printfFormat('%.1f%%')).toBe('%.1f%%');
    expect(printfFormat('%d / %d')).toBeNull();
    expect(printfFormat('sci')).toBeNull();
    expect(printfFormat('{:.2f}')).toBeNull();
  });
});

describe('axisTicks', () => {
  const T = (over = {}) => ({ ...defaultPlotStyle().xTicks, ...over });
  test('ticks and labels inside the view only', () => {
    const r = axisTicks({ view: [-0.3, 10.3], log: false, ticks: T(), tickSpace: 12, minorLocated: false });
    expect(r.major.map((t) => t.v)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(r.major.map((t) => t.text)).toEqual(['0', '2', '4', '6', '8', '10']);
    expect(r.minor).toEqual([]);
  });
  test('listed values with labels, and their TeX', () => {
    const r = axisTicks({ view: [0, 7], log: false, ticks: T({ mode: 'list', values: [0, Math.PI, 2 * Math.PI, 9], labels: ['0', '$\\pi$', '$2\\pi$'] }), tickSpace: 9, minorLocated: false });
    expect(r.major.map((t) => t.text)).toEqual(['0', '<i>π</i>', '2<i>π</i>']);
    expect(r.major.map((t) => t.math)).toEqual([false, true, true]);
  });
  test('a log axis labels some minor ticks, unless the ticks were chosen', () => {
    const auto = axisTicks({ view: [2, 15], log: true, ticks: T(), tickSpace: 9, minorLocated: false });
    expect(auto.major.map((t) => t.v)).toEqual([10]);
    expect(auto.minor.filter((t) => t.text).map((t) => t.v)).toEqual([2, 3, 4, 6]);   // under a decade: 1, 2, 3, 4, 6 are labelled
    const chosen = axisTicks({ view: [2, 15], log: true, ticks: T({ format: '%g' }), tickSpace: 9, minorLocated: false });
    expect(chosen.minor.every((t) => t.text === '')).toBe(true);
  });
  test('the scientific format moves the power of ten to the end', () => {
    const r = axisTicks({ view: [0, 0.00032], log: false, ticks: T({ format: 'sci' }), tickSpace: 6, minorLocated: false });
    expect(r.offset).toBe('×10<sup>−4</sup>');
    expect(r.offsetMath).toBe(true);
  });
  test('a format that is not printf is noted', () => {
    const r = axisTicks({ view: [0, 1], log: false, ticks: T({ format: '{:.2f}' }), tickSpace: 6, minorLocated: false });
    expect(r.notes.join(' ')).toMatch(/not a printf format/);
  });
});

describe('textToHtml', () => {
  test('plain text is escaped, maths between $ is converted', () => {
    expect(textToHtml('a < b & c')).toBe('a &lt; b &amp; c');
    expect(textToHtml('Time $t$ / ms')).toBe('Time <i>t</i> / ms');
    expect(textToHtml('$\\tau_0$ / $\\mu$s')).toBe('<i>τ</i><sub>0</sub> / <i>μ</i>s');
    expect(textToHtml('$E_{\\mathrm{a}}$')).toBe('<i>E</i><sub>a</sub>');
    expect(textToHtml('$x^{-2}$')).toBe('<i>x</i><sup>−2</sup>');
    expect(textToHtml('costs $5')).toBe('costs $5');     // one $: not maths
  });
  test('unknown commands are kept and reported', () => {
    const unknown = [];
    expect(textToHtml('$\\foo x$', unknown)).toContain('\\foo');
    expect(unknown).toEqual(['foo']);
  });
});

describe('fitCurveGrid', () => {
  test('samples across the data, or from a limit that is set', () => {
    const g = fitCurveGrid([3, 1, 2], { fit: { samples: 21 } });
    expect(g.length).toBe(21);
    expect(g[0]).toBe(1);
    expect(g[20]).toBe(3);
    const lim = fitCurveGrid([1, 2, 3], { xLim: [0, null], fit: { samples: 20 } });
    expect(lim[0]).toBe(0);
    const log = fitCurveGrid([1, 1000], { xScale: 'log', fit: { samples: 31 } });
    expect(log[10]).toBeCloseTo(10, 10);
  });
});

describe('buildFitFigure', () => {
  const x = Array.from({ length: 12 }, (_, i) => i + 1);
  const y = x.map((v) => 2 * v + 1 + Math.sin(v));
  const sigma = x.map(() => 0.4);
  const grid = fitCurveGrid(x, {});
  const model = {
    x, y, sigma,
    curve: { x: grid, y: grid.map((v) => 2 * v + 1) },
    band: { x: grid, lower: grid.map((v) => 2 * v + 0.8), upper: grid.map((v) => 2 * v + 1.2) },
    residuals: { r: y.map((v, i) => v - 2 * x[i] - 1) }
  };

  test('the true size, and the tight page', () => {
    const plain = buildFitFigure(model, { export: { tight: false } });
    expect(plain.layout.width).toBeCloseTo(6.4 * 96, 6);
    expect(plain.layout.height).toBeCloseTo(4.8 * 96, 6);
    expect(plain.info.widthIn).toBeCloseTo(6.4, 9);
    const tight = buildFitFigure(model, {});
    expect(tight.info.tight).toBe(true);
    // Constrained layout leaves 3 pt round the drawing; tight puts back 0.1 in.
    expect(tight.info.widthIn).toBeGreaterThan(6.4);
    expect(tight.info.widthIn).toBeLessThan(6.6);
    expect(tight.info.figureWidthIn).toBe(6.4);
  });

  test('traces in drawing order: band, fit, data; the residual panel below', () => {
    const f = buildFitFigure(model, { band: { show: true }, residuals: { show: true } });
    expect(f.data.map((t) => [t.yaxis, t.mode, !!t.fill].join(':'))).toEqual(['y:lines:true', 'y:lines:false', 'y:markers:false', 'y2:lines:false', 'y2:markers:false']);
    expect(f.data[2].error_y.array).toEqual(sigma);
    expect(f.layout.yaxis2.domain[1]).toBeLessThan(f.layout.yaxis.domain[0]);
    expect(f.info.axes).toHaveLength(2);
    const legend = f.layout.annotations.map((a) => a.text).filter((t) => /Data|Fit|confidence/.test(t));
    expect(legend).toEqual(['Data', 'Fit', '95% confidence band']);
  });

  test('log axes are given to Plotly in decades', () => {
    const f = buildFitFigure(model, { xScale: 'log', yScale: 'log' });
    expect(f.layout.xaxis.type).toBe('log');
    const [a, b] = f.layout.xaxis.range;
    const span = Math.log10(12);   // data from 1 to 12, 5% margins in log units
    expect(a).toBeCloseTo(-0.05 * span, 9);
    expect(b).toBeCloseTo(span * 1.05, 9);
  });

  test('user limits, and one limit left automatic', () => {
    const f = buildFitFigure(model, { xLim: [0, null], yLim: [-5, 40] });
    expect(f.layout.xaxis.range[0]).toBe(0);
    expect(f.layout.xaxis.range[1]).toBeCloseTo(12 + 0.55, 9);
    expect(f.layout.yaxis.range).toEqual([-5, 40]);
  });

  test('several variables: observed against predicted, a diagonal, no band', () => {
    const f = buildFitFigure({ multivariate: { observed: y, predicted: model.curve.y.slice(0, 12) } }, { band: { show: true }, residuals: { show: true } });
    expect(f.data.some((t) => t.fill)).toBe(false);
    expect(f.data[0].x).toEqual(f.data[0].y);
    expect(f.data).toHaveLength(4);   // diagonal, points, zero line, residual points
  });

  test('legend: "best" goes where nothing is drawn; none without entries', () => {
    expect(buildFitFigure(model, {}).info.legend).toBe('upper left');   // the data rise to the right
    expect(buildFitFigure(model, { data: { label: '' }, fit: { label: '' } }).info.legend).toBeNull();
  });

  test('styles map onto Plotly: markers, alpha, dashes, fonts', () => {
    const f = buildFitFigure(model, { data: { marker: 's', size: 6, alpha: 0.5, color: '#ff0000' }, fit: { style: 'dashed', width: 2 }, fontSize: 12 });
    const pts = f.data.find((t) => t.mode === 'markers');
    expect(pts.marker.symbol).toBe('square');
    expect(pts.marker.size).toBeCloseTo(8, 9);                 // 6 pt
    expect(pts.marker.color).toBe('rgba(255,0,0,0.5)');
    expect(f.data.find((t) => t.mode === 'lines').line.dash).toBe(plotlyDash('dashed', 2));
    expect(f.layout.annotations.find((a) => a.text === 'x').font.size).toBeCloseTo(16, 9);   // 12 pt
    expect(rgba('#abc', 1)).toBe('rgba(170,187,204,1)');
  });

  test('notes what the preview cannot show as matplotlib will', () => {
    const f = buildFitFigure(model, { data: { marker: '^' }, xLabel: '$\\frac{a}{b}$ $\\hat{x}$', yLabel: '$\\weird$' });
    const notes = f.info.notes.join(' ');
    expect(notes).toMatch(/triangles/);
    expect(notes).toMatch(/Fractions/);
    expect(notes).toMatch(/Accents/);
    expect(notes).toContain('\\weird');
  });

  test('any style, even a broken one, gives a figure', () => {
    const s = normalisePlotStyle({ width: 'x', legend: { position: 'nowhere' }, xTicks: { mode: 'step', step: 1e-9 } });
    expect(() => buildFitFigure(model, s)).not.toThrow();
    expect(buildFitFigure(model, s).info.notes.join(' ')).toMatch(/ticks on the axis/);
    expect(() => buildFitFigure({}, {})).not.toThrow();
  });
});

describe('the Curve Fitter on the figure style panel', () => {
  const x = [1, 2, 3, 4];
  const model = { x, y: [2, 4, 5, 8], sigma: [0.2, 0.2, 0.3, 0.3], curve: { x, y: [2, 4, 6, 8] }, band: { x, lower: [1, 3, 5, 7], upper: [3, 5, 7, 9] } };

  test('a change of the figure panel lands in the plot style', () => {
    const s = foldFigureStyle(defaultPlotStyle(), {
      sizeUnit: 'mm', titleSize: 14, legend: { position: 'upper left' }, grid: { show: true, axis: 'y' }, xLim: [0, null],
      panels: [{ yLabel: 'Y', yScale: 'log', yTicks: { mode: 'count', count: 4 } }, { ratio: 2 }],
      series: { data: { color: '#ff0000', size: 3, errorWidth: 2, show: false }, fit: { lineWidth: 3, lineStyle: 'dashed', label: 'Model' }, band: { alpha: 0.3, label: 'CI' }, zero: { color: '#000000' } }
    });
    expect(s).toMatchObject({ sizeUnit: 'mm', titleSize: 14, xLim: [0, null], yLabel: 'Y', yScale: 'log' });
    expect(s.legend).toEqual({ ...defaultPlotStyle().legend, position: 'upper left' });
    expect(s.grid).toEqual({ ...defaultPlotStyle().grid, show: true, axis: 'y' });
    expect(s.yTicks).toMatchObject({ mode: 'count', count: 4 });
    expect(s.data).toMatchObject({ color: '#ff0000', size: 3, errorWidth: 2, show: false, edgeColor: defaultPlotStyle().data.edgeColor });
    expect(s.fit).toMatchObject({ width: 3, style: 'dashed', label: 'Model', color: defaultPlotStyle().fit.color });
    expect(s.band).toMatchObject({ alpha: 0.3, label: 'CI' });
    expect(s.residuals).toEqual(defaultPlotStyle().residuals);
    expect(foldFigureStyle(defaultPlotStyle(), {})).toEqual(normalisePlotStyle(defaultPlotStyle()));
  });

  test('the background picker on a fit: dark, transparent, and White again exactly', () => {
    const start = normalisePlotStyle({ residuals: { show: true }, band: { show: true } });
    let s = start;
    const pick = (choice, opts) => { s = foldFigureStyle(s, withBackground({}, fitFigure(model, s), choice, opts)); };
    pick('dark');
    expect(s).toMatchObject({ background: '#0f172a', foreground: '#e2e8f0', export: { transparent: false } });
    expect(s.data.color).toBe(COLOR_CYCLE_DARK[0]);
    expect(backgroundChoice(normaliseFigure(fitFigure(model, s))).choice).toBe('dark');
    pick('transparent', { ink: 'light' });
    expect(s.export.transparent).toBe(true);
    expect(buildFitFigure(model, s, { transparent: s.export.transparent }).layout.paper_bgcolor).toBe('rgba(0,0,0,0)');
    pick('white');
    expect(s).toEqual(start);
  });

  test('stored styles load unchanged: only the new size unit is added', () => {
    // A style stored before the panel moved (the publication preset, dark colours and a transparent export).
    const old = { ...defaultPlotStyle(), width: 3.5, height: 2.6, fontSize: 8, background: '#0f172a', foreground: '#e2e8f0',
      grid: { show: false, minor: false, color: '#64748b', alpha: 0.5, style: 'solid', width: 0.6 }, export: { format: 'png', filename: 'fit', transparent: true, tight: true } };
    delete old.sizeUnit;
    const loaded = normalisePlotStyle(old);
    expect(loaded.sizeUnit).toBe('in');
    const { sizeUnit, ...rest } = loaded;
    expect(rest).toEqual({ ...old, grid: { ...old.grid, axis: 'both' } });
    const f = fitFigure(model, loaded);
    expect(f).toMatchObject({ width: 3.5, background: '#0f172a', sizeUnit: 'in', export: { transparent: true } });
    expect(backgroundChoice(normaliseFigure(f))).toEqual({ choice: 'transparent', ink: 'light' });
  });
});

describe('pngWithDpi', () => {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 255]))), chunk('IEND', Buffer.alloc(0))]);

  test('records the resolution after IHDR, with a valid CRC, once', () => {
    const out = Buffer.from(pngWithDpi(new Uint8Array(png), 300));
    expect(out.subarray(37, 41).toString('latin1')).toBe('pHYs');
    expect(out.readUInt32BE(41)).toBe(Math.round(300 / 0.0254));
    expect(out.readUInt32BE(50)).toBe(crc32(out.subarray(37, 50)));
    expect(out.length).toBe(png.length + 21);
    expect(Buffer.from(pngWithDpi(new Uint8Array(out), 96)).length).toBe(out.length);
  });
});
