/**
 * The Outlier Detector's figure and script (src/core/outliers-figure.js).
 *
 * When Python with numpy, scipy and matplotlib is installed, the scripts are
 * run: reading the file or holding the values, they must flag the rows
 * outliers.js flags, draw the rule's lines where the page draws them, report
 * Grubbs' test as the page does, and leave matplotlib with the preview's axis
 * limits (js/figure-plot.js).
 */
import { describe, test, expect, beforeAll } from '@jest/globals';
import './setup.js';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectOutliers, grubbsTest, extractNumericColumn } from '../src/core/outliers.js';
import { readTable, WHITESPACE } from '../src/core/data-cleaning.js';
import { outlierFigure, outlierScript, outlierLines } from '../src/core/outliers-figure.js';
import { normaliseFigure, applyStyle } from '../src/core/figure.js';
import { buildFigure } from '../js/figure-plot.js';

const PYTHON = (() => {
  try {
    return spawnSync('python3', ['-c', 'import numpy, scipy, matplotlib'], { encoding: 'utf8', timeout: 60000 }).status === 0;
  } catch {
    return false;
  }
})();
const withPython = PYTHON ? test : test.skip;

const INSPECT = String.raw`

# --- test only: report what was computed and drawn ---
import json as _json
fig.canvas.draw()
_leg = ax.get_legend()
print('@@OUT@@' + _json.dumps({
    'rows': [int(r) for r in row], 'values': value.tolist(),
    'flagged': [int(r) for r in row[flagged]],
    'lower': float(lower), 'upper': float(upper),
    'centre': float(centre) if 'centre' in globals() else None,
    'grubbs': [float(G), float(critical), float(grubbs_p)] if 'G' in globals() else None,
    'xlim': [float(v) for v in ax.get_xlim()], 'ylim': [float(v) for v in ax.get_ylim()],
    'legend': [t.get_text() for t in _leg.get_texts()] if _leg else None,
}))
`;

function run(script, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stemkit-od-'));
  writeFileSync(join(dir, 'outliers.py'), script + INSPECT);
  Object.entries(files).forEach(([name, text]) => writeFileSync(join(dir, name), text));
  return new Promise((resolve) => {
    const child = spawn('python3', ['outliers.py'], { cwd: dir, env: { ...process.env, MPLBACKEND: 'Agg' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('@@OUT@@'));
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, stdout, stderr, out: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}

// The page's example: fifteen readings near 80, one far too high and one far too low.
const EXAMPLE = [78, 80, 79, 81, 77, 80, 79, 82, 78, 250, 80, 79, 3, 81, 79];

// A file as a person might have one, with the cells the page skips: text, blanks,
// true/false, a whole number too large to keep its digits, a blank line.
const CSV_TEXT = [
  'id;site ; level',
  '1;A;4.1', '2;B;3.9', '3;A;n/a', '4;B;4.4', '', '5;A;-0.5e1', '6;B;4.0', '7;A;', '8;B;true',
  '9;A;4.2', '10;B;12.5', '11;A;3.8', '12;B;9007199254740993', '13;A;4.05', '14;B; 4.3 ', '15;A;.5'
].join('\n') + '\n';

/* A file as the page reads it (js/outlier-detector.js): the table of the Data
   Cleaner's reader, its rows keyed by column, and what the script is told
   about the file. */
function pageRead(name, text, encoding = 'utf-8', settings = {}) {
  const read = readTable(text, settings);
  const rows = read.rows.map((r) => Object.fromEntries(read.columns.map((c, i) => [c, r[i]])));
  const file = {
    name, encoding,
    delimiter: read.settings.delimiter === WHITESPACE ? null : read.settings.delimiter,
    decimal: read.settings.decimal, header: read.settings.header, headerCells: read.headerCells
  };
  return { read, rows, file };
}

/* A scan of one column of such a file, with the script reading the file. */
function scanOf(page, column, method, threshold) {
  const { values, indexMap } = extractNumericColumn(page.rows, column);
  return {
    values, rows: indexMap.map((i) => i + 1), method, threshold, column,
    file: { ...page.file, position: page.read.columns.indexOf(column) }, source: 'files'
  };
}

function make(spec, style = {}) {
  const drawn = normaliseFigure(applyStyle(outlierFigure(spec), style));
  return { spec, drawn, script: outlierScript(drawn, spec) };
}

const embedded = (method, threshold) => ({
  values: EXAMPLE, rows: EXAMPLE.map((_, i) => i + 1), method, threshold, column: 'measurement', source: 'embed'
});
const fromFile = (method, threshold) => scanOf(pageRead('levels.csv', CSV_TEXT), 'level', method, threshold);

/*
 * The same eight readings, 4.1 3.9 4.4 12.5 4.2 3.8 4.05 4.3, in every way a
 * file may be written: each must give the script the numbers and rows the
 * page read. `bytes` is the file as saved; `text` what the page decoded.
 */
const LEVELS = [4.1, 3.9, 4.4, 12.5, 4.2, 3.8, 4.05, 4.3];
const comma = (v) => String(v).replace('.', ',');
const latin1 = (text) => Buffer.from(text, 'latin1');
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const WRITTEN = [
  { name: 'semicolons_decimal_commas.csv', column: 'level', text: ['id;level', ...LEVELS.map((v, i) => `${i + 1};${comma(v)}`)].join('\r\n') + '\r\n' },
  { name: 'tabs_decimal_commas_no_header.txt', column: 'column_2', text: LEVELS.map((v, i) => `${i + 1}\t${comma(v)}`).join('\n') + '\n' },
  { name: 'no_header.csv', column: 'column_2', text: LEVELS.map((v, i) => `${i + 1},${v}`).join('\n') + '\n' },
  { name: 'one_column.txt', column: 'column_1', text: LEVELS.join('\n') + '\n' },
  { name: 'in_columns.dat', column: 'level (mM)', text: ['# readings', '# id  level', '  id    level (mM)   site', ...LEVELS.map((v, i) => `  ${String(i + 1).padStart(2)}    ${v.toFixed(2).padStart(6)}       ${'AB'[i % 2]}`), ''].join('\n') },
  // A first row with a word in it is taken for names; here the person has said it is data.
  { name: 'in_columns_decimal_commas.txt', column: 'column_2', settings: { header: false }, text: LEVELS.map((v, i) => `${i + 1}   ${comma(v)}\t x`).join('\r') + '\r' },
  { name: 'windows_1252.csv', column: 'level (µM)', encoding: 'windows-1252', text: ['id,level (µM),température', ...LEVELS.map((v, i) => `${i + 1},${v},20`)].join('\r\n') + '\r\n' },
  { name: 'utf_16.txt', column: 'level (µM)', encoding: 'utf-16le', text: ['id\tlevel (µM)', ...LEVELS.map((v, i) => `${i + 1}\t${v}`)].join('\r\n') + '\r\n' },
  { name: 'utf_8_bom.csv', column: 'level', bom: true, text: ['id,level', ...LEVELS.map((v, i) => `${i + 1},${v}`)].join('\n') + '\n' },
  { name: 'quoted.csv', column: 'level, mM', text: ['"id","level, mM"', ...LEVELS.map((v, i) => `"${i + 1}","${v}"`)].join('\n') + '\n' },
  // Two columns of one name, and one with none: neither can be found by its header.
  { name: 'names_twice.csv', column: 'level_2', text: ['level,level,', ...LEVELS.map((v, i) => `${i + 1},${v},x`)].join('\n') + '\n' },
  { name: 'no_name.csv', column: 'column_2', text: ['id,,site', ...LEVELS.map((v, i) => `${i + 1},${v},A`)].join('\n') + '\n' },
  // A first row of numbers that holds names all the same, as the person says.
  { name: 'numbers_as_names.csv', column: '10', settings: { header: true }, text: ['0,10', ...LEVELS.map((v, i) => `${i + 1},${v}`)].join('\n') + '\n' },
  // Signs, exponents and sizes: a plus sign is read, and so is a number past 2**53
  // that is not written as a whole number. NaN, 1e400, a whole number too long
  // to keep its digits and a number with its unit are not.
  { name: 'signs_and_sizes.csv', column: 'x', values: [5e22, -3e22, 6.02e23, 1e22, 5e22, 2.5e22],
    text: 'x\n+5e22\n-3e22\n6.02e23\n 1E+22 \n.5e23\n25000000000000000000000.0\nNaN\n1e400\n9007199254740993\n 12 kg\n' }
];
const bytesOf = (w) => (w.encoding === 'windows-1252' ? latin1(w.text) : w.encoding === 'utf-16le' ? utf16(w.text)
  : Buffer.concat([Buffer.from(w.bom ? [0xef, 0xbb, 0xbf] : []), Buffer.from(w.text, 'utf8')]));

const CASES = {
  zscore: embedded('zscore', 3),
  modzscore: embedded('modzscore', 3.5),
  iqr: embedded('iqr', 1.5),
  zscoreFile: fromFile('zscore', 2),
  modzscoreFile: fromFile('modzscore', 3.5),
  iqrFile: fromFile('iqr', 1.5),
  // More than half the values equal: the MAD is 0 and the mean absolute deviation stands in.
  fallback: { values: [5, 5, 5, 5, 5, 5, 7, 5, 30, 5], rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], method: 'modzscore', threshold: 3.5, column: 'x', source: 'embed' },
  // The middle half of the values equal: the IQR is 0 and every other value is outside the fences.
  iqrZero: { values: [5, 5, 5, 5, 5, 5, 5, 5.0001, 4.9999, 7], rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], method: 'iqr', threshold: 1.5, column: 'x', source: 'embed' }
};

// Every value the same, where numpy's SD is 1.5e-17 and not 0. Run apart from the
// cases above: a figure of one value has no axis limits to compare.
const CONSTANT = Array(6).fill(0.1);
const constant = (method, threshold) => ({ values: CONSTANT, rows: [1, 2, 3, 4, 5, 6], method, threshold, column: 'x', source: 'embed' });

const close = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

describe('outlierLines', () => {
  test('the Z-score: the mean and the mean ± k SD', () => {
    const l = outlierLines([1, 2, 3, 4, 5], 'zscore', 2);
    expect(l.centre).toBe(3);
    expect(l.upper).toBeCloseTo(3 + 2 * Math.sqrt(2.5), 12);
    expect(l.ruleName).toBe('Mean ± 2 SD');
  });
  test('the modified Z-score: where 0.6745 (x - median) / MAD reaches ±k', () => {
    const l = outlierLines(EXAMPLE, 'modzscore', 3.5);
    const flagged = detectOutliers(EXAMPLE, 'modzscore', 3.5).indices.map((i) => EXAMPLE[i]);
    for (const v of EXAMPLE) expect(v < l.lower || v > l.upper).toBe(flagged.includes(v));
  });
  test("Tukey's fences, and no centre line", () => {
    const l = outlierLines(EXAMPLE, 'iqr', 1.5);
    const r = detectOutliers(EXAMPLE, 'iqr', 1.5);
    expect([l.lower, l.upper, l.centre]).toEqual([r.lower, r.upper, null]);
  });
  test('a constant sample: the Z-score lines meet on the mean, whatever rounding leaves of the SD', () => {
    const l = outlierLines(CONSTANT, 'zscore', 3);
    expect(l.lower).toBe(l.centre);
    expect(l.upper).toBe(l.centre);
    expect(l.centre).toBeCloseTo(0.1, 15);
  });
});

describe('outlierFigure', () => {
  test('the values against their rows, the flagged ones apart, and the rule\'s lines', () => {
    const { drawn } = make(CASES.zscore);
    const byId = Object.fromEntries(drawn.panels[0].series.map((s) => [s.id, s]));
    expect(byId.flagged_points.x).toEqual([10]);
    expect(byId.flagged_points.y).toEqual([250]);
    expect(byId.kept.x).toHaveLength(14);
    expect(byId.threshold_hi.x).toEqual([1, 15]);
    expect(byId.threshold_lo.legend).toBe(false);
    expect(drawn.xLabel).toBe('Row');
    expect(drawn.panels[0].yLabel).toBe('measurement');
  });
  test('with the lines off, and with nothing flagged', () => {
    const { drawn } = make({ ...CASES.zscore, lines: false, threshold: 5 });
    const byId = Object.fromEntries(drawn.panels[0].series.map((s) => [s.id, s]));
    expect(byId.threshold_hi.show).toBe(false);
    expect(byId.flagged_points.show).toBe(false);
  });
  test('no values, no figure', () => {
    expect(outlierFigure({ values: [] })).toBeNull();
  });
});

describe('outlierScript', () => {
  test('reads the column from the file, or holds the values', () => {
    // The header cell is " level": the script strips it, as the page did, and finds it by name.
    expect(make(CASES.zscoreFile).script).toContain("row, value = read_column('levels.csv', 'level', delimiter=';')");
    const held = make(CASES.zscore).script;
    expect(held).not.toContain('read_column');
    expect(held).toMatch(/^row = np\.array\(\[1, 2, 3/m);
    // An example has no file: its values are held even when the file is asked for.
    expect(make({ ...CASES.zscore, source: 'files' }).script).toContain('# The example has no file to read');
  });

  test('the call says how the file is written', () => {
    const call = (name) => {
      const w = WRITTEN.find((x) => x.name === name);
      const script = make(scanOf(pageRead(w.name, w.text, w.encoding, w.settings), w.column, 'zscore', 2)).script;
      return script.slice(script.indexOf('row, value = read_column')).split('\n\n')[0].replace(/\s+/g, ' ');
    };
    expect(call('semicolons_decimal_commas.csv')).toBe("row, value = read_column('semicolons_decimal_commas.csv', 'level', delimiter=';', decimal=',')");
    expect(call('tabs_decimal_commas_no_header.txt')).toBe("row, value = read_column('tabs_decimal_commas_no_header.txt', 1, delimiter='\\t', decimal=',', header=False)");
    expect(call('no_header.csv')).toBe("row, value = read_column('no_header.csv', 1, header=False)");
    expect(call('in_columns.dat')).toBe("row, value = read_column('in_columns.dat', 1, delimiter=None)");
    expect(call('in_columns_decimal_commas.txt')).toBe("row, value = read_column('in_columns_decimal_commas.txt', 1, delimiter=None, decimal=',', header=False)");
    expect(call('windows_1252.csv')).toBe("row, value = read_column('windows_1252.csv', 'level (µM)', encoding='cp1252')");
    expect(call('utf_16.txt')).toBe("row, value = read_column('utf_16.txt', 'level (µM)', delimiter='\\t', encoding='utf-16')");
    expect(call('quoted.csv')).toBe("row, value = read_column('quoted.csv', 'level, mM')");
    // Found by place where the header cannot find it: a name used twice, a column with no name.
    expect(call('names_twice.csv')).toBe("row, value = read_column('names_twice.csv', 1)");
    expect(call('no_name.csv')).toBe("row, value = read_column('no_name.csv', 1)");
    expect(call('numbers_as_names.csv')).toBe("row, value = read_column('numbers_as_names.csv', '10')");
  });

  test('a file given without its header row, as before, is read by the name', () => {
    const spec = { ...CASES.zscoreFile, file: { name: 'levels.csv', delimiter: ';' } };
    expect(make(spec).script).toContain("row, value = read_column('levels.csv', 'level', delimiter=';')");
  });
});

const runs = {};
const written = {};
beforeAll(async () => {
  if (!PYTHON) return;
  await Promise.all([
    ...Object.entries(CASES).map(async ([name, spec]) => {
      const m = make(spec);
      runs[name] = { ...m, r: await run(m.script, { 'levels.csv': CSV_TEXT }) };
    }),
    ...WRITTEN.map(async (w) => {
      const m = make(scanOf(pageRead(w.name, w.text, w.encoding, w.settings), w.column, 'iqr', 1.5));
      written[w.name] = { ...m, r: await run(m.script, { [w.name]: bytesOf(w) }) };
    })
  ]);
}, 240000);

describe('the script, run', () => {
  withPython('runs without errors or warnings', () => {
    for (const [name, { r }] of Object.entries(runs)) expect([name, r.code, r.stderr]).toEqual([name, 0, '']);
  });

  withPython('reads the numbers and rows the page read', () => {
    for (const name of ['zscoreFile', 'modzscoreFile', 'iqrFile']) {
      const { spec, r } = runs[name];
      expect(r.out.rows).toEqual(spec.rows);
      expect(r.out.values).toEqual(spec.values);
    }
  });

  withPython('reads every way a file is written as the page read it', () => {
    for (const w of WRITTEN) {
      const { spec, r } = written[w.name];
      expect([w.name, r.code, r.stderr]).toEqual([w.name, 0, '']);
      // The page read the eight readings, on rows 1 to 8 ...
      expect([w.name, spec.values]).toEqual([w.name, w.values || LEVELS]);
      // ... and so did the script, from the bytes of the file.
      expect([w.name, r.out.values, r.out.rows]).toEqual([w.name, spec.values, spec.rows]);
    }
    expect(written['signs_and_sizes.csv'].spec.rows).toEqual([1, 2, 3, 4, 5, 6]);
  });

  withPython('flags the rows the page flags, and draws the lines where the page does', () => {
    for (const [name, { spec, r }] of Object.entries(runs)) {
      const want = detectOutliers(spec.values, spec.method, spec.threshold).indices.map((i) => spec.rows[i]);
      expect([name, r.out.flagged]).toEqual([name, want]);
      const lines = outlierLines(spec.values, spec.method, spec.threshold);
      expect(close(r.out.lower, lines.lower, 1e-12) && close(r.out.upper, lines.upper, 1e-12)).toBe(true);
      if (lines.centre !== null) expect(close(r.out.centre, lines.centre, 1e-12)).toBe(true);
    }
  });

  withPython('says when the spread a rule divides by is zero', () => {
    expect(runs.fallback.r.stdout).toContain('More than half the values are equal, so the MAD is 0');
    expect(runs.iqrZero.r.stdout).toContain('The middle half of the values are equal, so the IQR is 0');
    expect(runs.iqrZero.r.out.flagged).toEqual([8, 9, 10]);
    for (const name of ['zscore', 'modzscore', 'iqr']) expect(runs[name].r.stdout).not.toMatch(/is 0/);
  });

  withPython('a constant sample: nothing flagged, no Grubbs test, and the script says why', async () => {
    for (const [method, threshold, says] of [['zscore', 1, 'the SD is 0'], ['modzscore', 2, 'the MAD is 0'], ['iqr', 0.5, 'the IQR is 0']]) {
      const spec = constant(method, threshold);
      const r = await run(make(spec).script);
      expect([method, r.code, r.stderr]).toEqual([method, 0, '']);
      expect(detectOutliers(spec.values, method, threshold).indices).toEqual([]);
      expect(r.out.flagged).toEqual([]);
      expect(r.out.lower).toBe(r.out.upper);
      expect(grubbsTest(spec.values, 0.05)).toBeNull();
      expect(r.out.grubbs).toBeNull();
      expect(r.stdout).toContain(says);
    }
  }, 120000);

  withPython("reports the page's Grubbs' test", () => {
    for (const { spec, r } of Object.values(runs)) {
      const g = grubbsTest(spec.values, 0.05);
      expect(close(r.out.grubbs[0], g.G, 1e-12)).toBe(true);
      // jStat's inverse t and its 1 - cdf tail agree with SciPy's to about 1e-8.
      expect(close(r.out.grubbs[1], g.critical, 1e-8)).toBe(true);
      expect(Math.abs(r.out.grubbs[2] - g.p)).toBeLessThan(1e-8);
    }
  });

  withPython("matplotlib's axis limits are the preview's", () => {
    for (const [name, { drawn, r }] of Object.entries(runs)) {
      const layout = buildFigure(drawn, { normalised: true }).layout;
      const [x, y] = [layout.xaxis.range, layout.yaxis.range];
      const ok = [...r.out.xlim.map((v, k) => close(v, x[k])), ...r.out.ylim.map((v, k) => close(v, y[k]))].every(Boolean);
      if (!ok) throw new Error(`${name}: matplotlib x ${r.out.xlim} y ${r.out.ylim}, preview x ${x} y ${y}`);
    }
    expect(runs.zscore.r.out.legend).toEqual(['Mean', 'Mean ± 3 SD', 'Values', 'Outliers']);
    expect(runs.iqr.r.out.legend).toEqual(['Fences at 1.5 × IQR', 'Values', 'Outliers']);
  });
});
