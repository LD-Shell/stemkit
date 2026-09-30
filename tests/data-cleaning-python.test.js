import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readTable, runRecipe, writeTable, describeStep, SPACE_CHARACTERS, STEP_TYPES, FILTER_OPS, TRANSFORMS
} from '../src/core/data-cleaning.js';
import {
  generateCleaningScript, pyString, pyFloat, pyTripleQuoted, cleaningFileNames, stepToPython
} from '../src/core/data-cleaning-python.js';

/* ------------------------------------------------------------------ *
 * Literals and names
 * ------------------------------------------------------------------ */

describe('Python literals', () => {
  test('strings escape quotes, backslashes and hidden characters', () => {
    expect(pyString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(pyString('tab\there\nnew')).toBe('"tab\\there\\nnew"');
    expect(pyString('nb sp')).toBe('"nb\\xa0sp"');
    expect(pyString('zero​width')).toBe('"zero\\u200bwidth"');
    expect(pyString('Zürich 😀')).toBe('"Zürich 😀"');
  });

  test('floats read back as the same double', () => {
    expect(pyFloat(298)).toBe('298.0');
    expect(pyFloat(-0.5)).toBe('-0.5');
    expect(pyFloat(1e21)).toBe('1e+21');
    expect(pyFloat(1e-7)).toBe('1e-7');
  });

  test('triple-quoted text survives quotes at the end and in runs', () => {
    expect(pyTripleQuoted('a\n')).toBe('"""\\\na\n"""');
    expect(pyTripleQuoted('say """hi"""')).not.toMatch(/"""hi/);
    expect(pyTripleQuoted('ends with "')).toMatch(/\\""""$/);
  });

  test('file names for the script and the output', () => {
    expect(cleaningFileNames('sample measurements.csv')).toEqual({
      stem: 'sample measurements', script: 'clean_sample_measurements.py', output: 'sample measurements_cleaned.csv'
    });
    expect(cleaningFileNames('2024-run.tsv').script).toBe('clean_data_2024_run.py');
  });
});

describe('generateCleaningScript', () => {
  const columns = ['a', 'b'];
  const source = { fileName: 'data.csv', delimiter: ';', decimal: ',', header: true, encoding: 'utf-8' };

  test('reads with the settings the page used', () => {
    const { code } = generateCleaningScript({ steps: [], columns, source });
    expect(code).toContain('read_table(file, sep=";", decimal=",")');
    expect(code).toContain('INPUT = "data.csv"');
    expect(code).toContain('OUTPUT = "data_cleaned.csv"');
  });

  test('includes only the helpers the steps use', () => {
    const plain = generateCleaningScript({ steps: [{ type: 'dropMissing', columns: [] }], columns, source }).code;
    expect(plain).not.toContain('def sort_rows');
    expect(plain).not.toContain('def log10');
    const withSort = generateCleaningScript({ steps: [{ type: 'sort', column: 'a' }], columns, source }).code;
    expect(withSort).toContain('def sort_rows');
    expect(withSort).toContain('def is_number');
  });

  test('comments each step in words and reports its size', () => {
    const steps = [{ type: 'filter', column: 'a', op: 'gt', value: 3 }];
    const { code, steps: ranges } = generateCleaningScript({ steps, columns, source });
    const lines = code.split('\n');
    const block = lines.slice(ranges[0].start - 1, ranges[0].end);
    expect(block[0]).toBe('# 1. Keep rows where a is more than 3');
    expect(block.join('\n')).toContain('keep_rows(df, "a", lambda v: is_number(v) and v > 3.0)');
    expect(block[block.length - 1]).toBe('report("1. Keep rows where a is more than 3", df)');
  });

  test('keeps a step that is switched off as comments', () => {
    const steps = [{ type: 'dedupe', columns: [], enabled: false }];
    const { code } = generateCleaningScript({ steps, columns, source });
    expect(code).toContain('# df = df.drop_duplicates()');
    expect(code).toContain('(switched off)');
  });

  test('says why a step that cannot run is skipped', () => {
    const steps = [{ type: 'dropColumns', columns: ['a'] }, { type: 'sort', column: 'a' }];
    const { code } = generateCleaningScript({ steps, columns, source });
    expect(code).toContain('#    Skipped, as on the page: There is no column "a" at this point.');
    expect(code).not.toContain('df = sort_rows');
  });

  test('the function form defines clean(df) and a main block', () => {
    const { code } = generateCleaningScript({ steps: [{ type: 'trim', columns: [] }], columns, source, form: 'function' });
    expect(code).toMatch(/^def clean\(df\):/m);
    expect(code).toContain('if __name__ == "__main__":');
    expect(code).toContain('    df = df.copy()');
  });

  test('embeds the data when asked', () => {
    const text = 'a;b\n1;"x ""y"""\n';
    const { code } = generateCleaningScript({ steps: [], columns, source, data: 'embed', text });
    expect(code).toContain('DATA = """\\\na;b\n');
    expect(code).toContain('read_table(io.StringIO(DATA), sep=";", decimal=",")');
    expect(code).not.toContain('INPUT =');
  });

  test('every step type has Python', () => {
    const samples = {
      dropMissing: { columns: ['a'] }, dedupe: { columns: [] }, filter: { column: 'a', op: 'eq', value: 'x' },
      sort: { column: 'a' }, fill: { columns: ['a'], method: 'value', value: 0 },
      replace: { columns: ['a'], find: 'x', with: 'y', whole: false }, trim: { columns: [] },
      case: { columns: [], mode: 'upper' }, toNumber: { columns: [], decimal: '.' },
      round: { columns: [], digits: 2 }, transform: { columns: [], operation: 'abs' },
      rename: { column: 'a', to: 'c' }, dropColumns: { columns: ['a'] }
    };
    for (const type of STEP_TYPES) {
      const py = stepToPython({ type, ...samples[type] });
      expect(py.code.length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The script gives the page's table: run it with pandas
 * ------------------------------------------------------------------ */

const PYTHON_BIN = process.env.STEMKIT_PYTHON || 'python3';
const PANDAS = (() => {
  try {
    const r = spawnSync(PYTHON_BIN, ['-c', 'import pandas, numpy'], { encoding: 'utf8', timeout: 60000 });
    return r.status === 0;
  } catch {
    return false;
  }
})();
const withPandas = PANDAS ? test : test.skip;

// Runs every case in one Python process: the plain script (its printout and
// the CSV it writes), the script with the data embedded, and clean() from
// the function form, whose table comes back cell by cell with exact types.
const DRIVER = String.raw`
import contextlib, importlib.util, io, json, os, runpy, struct, sys, warnings
import numpy as np
import pandas as pd

def typed(v):
    if isinstance(v, str):
        return ["s", v]
    if v is None or (isinstance(v, float) and v != v):
        return None
    return ["n", struct.pack(">d", float(v)).hex(), type(v).__name__]

def run(path):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        runpy.run_path(path, run_name="__main__")
    return out.getvalue()

def read(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()

results = {}
for case in json.load(open(sys.argv[1])):
    os.chdir(case["dir"])
    res = {"warnings": []}
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            res["stdout"] = run(case["script"])
            res["csv"] = read(case["output"])
            os.remove(case["output"])
            run(case["embed"])
            res["embed_csv"] = read(case["output"])
            os.remove(case["output"])
            spec = importlib.util.spec_from_file_location("clean_" + case["name"], case["module"])
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            with open(case["input"], encoding=case["encoding"]) as f:
                table = mod.read_table(f, **case["read"])
            with contextlib.redirect_stdout(io.StringIO()):
                cleaned = mod.clean(table)
            res["columns"] = [str(c) for c in cleaned.columns]
            res["cells"] = [[typed(v) for v in row] for row in cleaned.itertuples(index=False, name=None)]
        except Exception as e:
            res["error"] = type(e).__name__ + ": " + str(e)
        res["warnings"] = [str(w.category.__name__) + ": " + str(w.message) for w in caught]
    results[case["name"]] = res
print(json.dumps(results))
`;

const bitsView = new DataView(new ArrayBuffer(8));
const doubleHex = (x) => { bitsView.setFloat64(0, x); return bitsView.getBigUint64(0).toString(16).padStart(16, '0'); };
const typedJS = (v) => (v === null || v === undefined ? null : typeof v === 'string' ? ['s', v] : ['n', doubleHex(v)]);

const PYTHON_ENCODING = { 'utf-8': 'utf-8-sig', 'windows-1252': 'cp1252', 'utf-16le': 'utf-16' };

// A small deterministic generator for the random cases.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELL_POOL = [
  '', '', '12', ' 12 ', '12.5', '-3', '0', '-0', '007', '1.', '.5', '+4', '1e3', '2.675', '0.125', '-2.5',
  '1e-7', '123456789.125', '9007199254740993', '1e400', 'abc', 'ABC', 'Abc', 'émile', 'ÉMILE', 'straße',
  ' pad ', '  ', 'n.d.', 'NA', '12 kg', ' 12 ', 'a b  c', "they're", 'İi', 'ΟΔΟΣ', '😀', '！',
  'ǆ', 'true', '2024-01-05T10:00:00Z', 'x,y', 'q"t', '3,5', 'kg'
];

function randomCell(r) {
  return CELL_POOL[Math.floor(r() * CELL_POOL.length)];
}

function csvLine(cells, delimiter) {
  return cells.map(c => (c.includes(delimiter) || c.includes('"') || c.includes('\n') ? `"${c.replace(/"/g, '""')}"` : c)).join(delimiter);
}

function randomValue(r) {
  const pick = [12, -3, 0, 2.5, 'abc', 'n.d.', 'ABC', 'kg', '12', 1e3][Math.floor(r() * 10)];
  return pick;
}

function randomStep(r, columns) {
  const col = () => columns[Math.floor(r() * columns.length)];
  const some = () => (r() < 0.3 ? [] : [...new Set([col(), ...(r() < 0.3 ? [col()] : [])])]);
  const type = STEP_TYPES[Math.floor(r() * STEP_TYPES.length)];
  switch (type) {
    case 'dropMissing':
    case 'dedupe':
    case 'trim':
      return { type, columns: some(), ...(type === 'trim' ? { collapse: r() < 0.5 } : {}) };
    case 'filter': {
      const op = FILTER_OPS[Math.floor(r() * FILTER_OPS.length)];
      let value = randomValue(r);
      if (['gt', 'gte', 'lt', 'lte'].includes(op)) value = [0, 12, -2.5, 1e3][Math.floor(r() * 4)];
      if (op === 'contains' || op === 'notContains') value = ['a', 'B', '2', 'é', 'kg'][Math.floor(r() * 5)];
      return { type, column: col(), op, ...(op === 'missing' || op === 'present' ? {} : { value }) };
    }
    case 'sort':
      return { type, column: col(), descending: r() < 0.5 };
    case 'fill': {
      const method = ['value', 'mean', 'median', 'previous'][Math.floor(r() * 4)];
      return { type, columns: some(), method, ...(method === 'value' ? { value: randomValue(r) } : {}) };
    }
    case 'replace':
      return r() < 0.5
        ? { type, columns: some(), whole: true, find: randomValue(r), with: [null, 0, 'x', 7.5][Math.floor(r() * 4)] }
        : { type, columns: some(), whole: false, find: ['a', ' ', 'kg', 'É', '2'][Math.floor(r() * 5)], with: ['', 'Z', ' '][Math.floor(r() * 3)] };
    case 'case':
      return { type, columns: some(), mode: ['upper', 'lower', 'title'][Math.floor(r() * 3)] };
    case 'toNumber':
      return { type, columns: some(), decimal: r() < 0.7 ? '.' : ',', invalid: r() < 0.5 ? 'missing' : 'keep' };
    case 'round': {
      const significant = r() < 0.4;
      return { type, columns: some(), significant, digits: significant ? 1 + Math.floor(r() * 4) : Math.floor(r() * 5) - 1, ties: r() < 0.5 ? 'up' : 'even' };
    }
    case 'transform': {
      const operation = TRANSFORMS[Math.floor(r() * TRANSFORMS.length)];
      return { type, columns: some(), operation, ...(operation === 'multiply' || operation === 'add' ? { value: [2.5, -0.1, 1000, 273.15][Math.floor(r() * 4)] } : {}) };
    }
    case 'rename':
      return { type, column: col(), to: r() < 0.2 ? col() : `renamed_${Math.floor(r() * 3)}` };
    default:
      return { type: 'dropColumns', columns: [col()] };
  }
}

function randomCase(seed) {
  const r = rng(seed);
  const width = 2 + Math.floor(r() * 4);
  const height = 3 + Math.floor(r() * 12);
  const delimiter = r() < 0.7 ? ',' : ';';
  const header = Array.from({ length: width }, (_, i) => `c${i}`);
  const lines = [csvLine(header, delimiter)];
  for (let i = 0; i < height; i++) {
    const row = Array.from({ length: width }, () => randomCell(r));
    lines.push(csvLine(row, delimiter));
    if (r() < 0.15) lines.push(lines[lines.length - 1]);
  }
  const steps = Array.from({ length: 1 + Math.floor(r() * 6) }, () => randomStep(r, header));
  steps.forEach(s => { if (r() < 0.1) s.enabled = false; });
  return { name: `random_${seed}`, text: lines.join('\n') + '\n', settings: { delimiter, decimal: '.' }, steps };
}

// Numbers with every kind of exponent, for reading, writing and arithmetic.
function numbersCase() {
  const r = rng(7);
  const lines = ['x,y,z'];
  for (let i = 0; i < 400; i++) {
    const e = Math.floor(r() * 50) - 25;
    const x = (r() - 0.3) * 10 ** e;
    const y = Number((r() * 1000).toFixed(Math.floor(r() * 6)));
    const z = [0.125, 2.5, -2.5, 1.005, 2.675, 0.5, 1.5, 1e21, 1e-7, 123456789.125, 5e-324, 1.7976931348623157e308][i % 12];
    lines.push([String(x), String(y), String(z)].join(','));
  }
  return lines.join('\n') + '\n';
}

const CASES = [
  {
    name: 'sample',
    text: [
      'sample,temperature_K,yield_pct,concentration_mM,operator',
      'S01,298,45.2,0.12,ana', 'S02,303,47.9,0.35,ben', 'S03,308,,1.10,ana', 'S04,313,53.1,3.40,carl',
      'S05,318,55.8,,ben', 'S02,303,47.9,0.35,ben', 'S06,323,58.2,10.5,ana', 'S07,328,61.0,32.0,carl',
      'S08,333,63.7,98.0,ben', 'S09,338,66.4,310,ana', 'S10,343,68.9,950,carl'
    ].join('\n'),
    steps: [
      { type: 'dropMissing', columns: ['yield_pct'] },
      { type: 'dedupe', columns: [] },
      { type: 'transform', columns: ['concentration_mM'], operation: 'log10' },
      { type: 'transform', columns: ['yield_pct'], operation: 'zscore' },
      { type: 'transform', columns: ['temperature_K'], operation: 'minmax' },
      { type: 'case', columns: ['operator'], mode: 'title' },
      { type: 'sort', column: 'operator', descending: true }
    ]
  },
  {
    name: 'text',
    text: [
      'id;name;city;score;when',
      '1; Ana ;Zürich;1,5;2024-01-05T10:00:00Z',
      '2;ÉMILE;  straße  ;2,25;true',
      "3;they're;İstanbul;;FALSE",
      "4;o'neil;ΟΔΟΣ;-0,0;NA",
      '5;"quoted; semi";"multi\nline";3e2;',
      '6;;;;',
      '7;ß-test;ǆemal;1e400;n/a',
      '8;x ;　wide　; 42;\tpad\t'
    ].join('\n'),
    steps: [
      { type: 'trim', columns: [], collapse: true },
      { type: 'case', columns: ['name'], mode: 'upper' },
      { type: 'case', columns: ['city'], mode: 'lower' },
      { type: 'case', columns: ['name'], mode: 'title' },
      { type: 'toNumber', columns: ['score', 'when'], decimal: ',', invalid: 'keep' },
      { type: 'filter', column: 'city', op: 'notContains', value: 'wide' },
      { type: 'sort', column: 'city' }
    ]
  },
  {
    name: 'rounding',
    text: numbersCase(),
    steps: [
      { type: 'round', columns: ['z'], digits: 2 },
      { type: 'round', columns: ['y'], digits: 1, ties: 'even' },
      { type: 'round', columns: ['x'], digits: 3, significant: true },
      { type: 'transform', columns: ['y'], operation: 'ln' },
      { type: 'transform', columns: ['z'], operation: 'multiply', value: 1e-3 },
      { type: 'transform', columns: ['x'], operation: 'add', value: -273.15 }
    ]
  },
  { name: 'numbers_as_read', text: numbersCase(), steps: [] },
  {
    name: 'statistics',
    text: numbersCase(),
    steps: [
      { type: 'transform', columns: ['x'], operation: 'zscore' },
      { type: 'transform', columns: ['y'], operation: 'minmax' },
      { type: 'transform', columns: [], operation: 'log10' },
      { type: 'transform', columns: ['z'], operation: 'abs' }
    ]
  },
  {
    name: 'sorting',
    text: ['k,v', 'b,1', 'B,', 'a,10', '😀,2', '！,3', 'á,4', '10,5', '9,6', ',7', 'A,8', 'b,9', '-0,10', '0,11', 'ab,12'].join('\n'),
    steps: [
      { type: 'sort', column: 'k' },
      { type: 'sort', column: 'k', descending: true },
      { type: 'sort', column: 'v', descending: true },
      { type: 'sort', column: 'k' }
    ]
  },
  {
    name: 'duplicates',
    text: ['a,b', '1,x', '1.0,x', '" 1 ",x', ',', ',', '-0,y', '0,y', '1e0,X', 'x ,x'].join('\n'),
    steps: [
      { type: 'dedupe', columns: [] },
      { type: 'trim', columns: [] },
      { type: 'dedupe', columns: ['a'] },
      { type: 'dedupe', columns: ['b'] }
    ]
  },
  {
    name: 'structure',
    text: '﻿ a ,,a,  b  ,a\r\n1,2,3\r\n\r\n4,5,6,7,8,9\r\n"q,1","line\r\nbreak","say ""hi""",,\r\n""\r\n   \r\n10\r\n',
    steps: [{ type: 'dropMissing', columns: ['a_2'] }]
  },
  {
    name: 'no_header_tabs',
    text: '1\t2\t3\n4\t\t6\n7\t8\n',
    settings: { header: false },
    steps: [{ type: 'fill', columns: [], method: 'mean' }, { type: 'rename', column: 'column_2', to: 'second' }]
  },
  {
    name: 'filters',
    text: ['v,w', '12.5,a', '12,B', ',c', 'abc,', '2,x2', '-3,', '12 kg,y', '1e3,z'].join('\n'),
    steps: [
      { type: 'filter', column: 'v', op: 'ne', value: 12 },
      { type: 'filter', column: 'v', op: 'contains', value: '2' },
      { type: 'filter', column: 'w', op: 'present' },
      { type: 'filter', column: 'v', op: 'lte', value: 1000 }
    ]
  },
  {
    name: 'filters_text',
    text: ['v,w', 'ana,1', 'Ana,2', ',3', 'ben,4', '12,5'].join('\n'),
    steps: [
      { type: 'filter', column: 'v', op: 'eq', value: 'ana', enabled: false },
      { type: 'filter', column: 'v', op: 'ne', value: 'ana' },
      { type: 'filter', column: 'w', op: 'gt', value: 1 },
      { type: 'filter', column: 'v', op: 'missing' }
    ]
  },
  {
    name: 'fills',
    text: ['a,b,c,d', ',x,1,', '2,,2,', ',y,,5', '4,,3,', '5,z,,'].join('\n'),
    steps: [
      { type: 'fill', columns: ['a'], method: 'median' },
      { type: 'fill', columns: ['b'], method: 'previous' },
      { type: 'fill', columns: ['c'], method: 'mean' },
      { type: 'fill', columns: ['b'], method: 'mean' },
      { type: 'fill', columns: ['d'], method: 'value', value: 'none' }
    ]
  },
  {
    name: 'replace',
    text: ['a,b', 'n.d.,12 kg', '5,kg', '-999,3 kg', 'n.d.,x'].join('\n'),
    steps: [
      { type: 'replace', columns: ['a'], find: 'n.d.', with: null, whole: true },
      { type: 'replace', columns: ['a'], find: -999, with: 0, whole: true },
      { type: 'replace', columns: ['b'], find: ' kg', with: '', whole: false },
      { type: 'replace', columns: ['b'], find: 'kg', with: '', whole: false },
      { type: 'toNumber', columns: ['b'], decimal: '.', invalid: 'missing' }
    ]
  },
  {
    name: 'columns',
    text: ['a,b,c', '1,2,3', '4,5,6'].join('\n'),
    steps: [
      { type: 'rename', column: 'a', to: ' first ' },
      { type: 'dropColumns', columns: ['b'] },
      { type: 'sort', column: 'b', descending: true },
      { type: 'sort', column: 'first', descending: true },
      { type: 'dropColumns', columns: ['c'], enabled: false }
    ]
  },
  {
    name: 'odd_names',
    text: '"na""me",back\\slash,"two\nlines",Zürich °C,   ,名前,""""\n"a\\b",1,x,2,3,4,5\n"c""d",2,y,,6,7,8\n',
    steps: [
      { type: 'rename', column: 'na"me', to: 'name "quoted"' },
      { type: 'sort', column: 'Zürich °C', descending: true },
      { type: 'replace', columns: ['two\nlines'], find: 'x', with: 'a\\b"c', whole: true },
      { type: 'filter', column: 'name "quoted"', op: 'contains', value: '\\' },
      { type: 'fill', columns: ['Zürich °C', '"'], method: 'value', value: 'n/a "q"' },
      { type: 'dropColumns', columns: ['column_5', '名前'] }
    ]
  },
  {
    name: 'one_column',
    text: ['only', 'x', '""', 'y', '"   "'].join('\n'),
    steps: [{ type: 'trim', columns: [] }]
  },
  {
    name: 'nothing_left',
    text: ['a,b', '1,2'].join('\n'),
    steps: [{ type: 'filter', column: 'a', op: 'gt', value: 5 }]
  },
  {
    name: 'cp1252',
    text: 'name;temp\n°C test;25,5\nµ-scale;30\n',
    encoding: 'windows-1252',
    steps: [{ type: 'case', columns: ['name'], mode: 'upper' }]
  },
  {
    name: 'utf16',
    text: 'name\tvalue\nZoë\t1,5\n',
    encoding: 'utf-16le',
    steps: [{ type: 'sort', column: 'value' }]
  },
  // STEMKIT_CLEAN_CASES=500 npm test runs a longer search.
  ...Array.from({ length: Number(process.env.STEMKIT_CLEAN_CASES) || 40 }, (_, i) => randomCase(1000 + i))
];

const CASE_NAMES = CASES.map(c => c.name);
let workDir;
let results;

function pageResult(c) {
  const read = readTable(c.text, c.settings || {});
  const run = runRecipe({ columns: read.columns, rows: read.rows }, c.steps);
  const label = (i) => `${i + 1}. ${describeStep(c.steps[i])}`;
  const lines = [`Read ${c.name}.csv: ${read.rows.length} rows, ${read.columns.length} columns`];
  run.results.forEach((res, i) => {
    if (res.status === 'ok') lines.push(`${label(i)}: ${res.rowsAfter} rows, ${res.columnsAfter} columns`);
  });
  lines.push(`Wrote ${cleaningFileNames(`${c.name}.csv`).output}`);
  return {
    read,
    run,
    csv: writeTable(run.table),
    stdout: lines.join('\n') + '\n',
    columns: run.table.columns,
    cells: run.table.rows.map(row => row.map(typedJS))
  };
}

function encode(text, encoding) {
  if (encoding === 'windows-1252') return Buffer.from(text, 'latin1');
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  return Buffer.from(text, 'utf8');
}

beforeAll(() => {
  if (!PANDAS) return;
  workDir = mkdtempSync(join(tmpdir(), 'stemkit-clean-'));
  const manifest = CASES.map(c => {
    const dir = join(workDir, c.name);
    mkdirSync(dir);
    const { read } = pageResult(c);
    const encoding = c.encoding || 'utf-8';
    const input = `${c.name}.csv`;
    writeFileSync(join(dir, input), encode(c.text, encoding));
    const spec = {
      steps: c.steps,
      columns: read.columns,
      source: { fileName: input, ...read.settings, encoding }
    };
    const embedText = c.text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    writeFileSync(join(dir, 'script.py'), generateCleaningScript({ ...spec, form: 'script' }).code);
    writeFileSync(join(dir, 'embed.py'), generateCleaningScript({ ...spec, form: 'script', data: 'embed', text: embedText }).code);
    writeFileSync(join(dir, 'module.py'), generateCleaningScript({ ...spec, form: 'function' }).code);
    const readArgs = {};
    if (read.settings.delimiter !== ',') readArgs.sep = read.settings.delimiter;
    if (read.settings.decimal !== '.') readArgs.decimal = read.settings.decimal;
    if (!read.settings.header) readArgs.header = false;
    return {
      name: c.name, dir, input, encoding: PYTHON_ENCODING[encoding], read: readArgs,
      script: join(dir, 'script.py'), embed: join(dir, 'embed.py'), module: join(dir, 'module.py'),
      output: cleaningFileNames(input).output
    };
  });
  writeFileSync(join(workDir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(workDir, 'driver.py'), DRIVER);
  const r = spawnSync(PYTHON_BIN, [join(workDir, 'driver.py'), join(workDir, 'manifest.json')], {
    encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024
  });
  if (r.status !== 0) throw new Error(`The Python driver failed:\n${r.stderr}`);
  results = JSON.parse(r.stdout);
}, 300000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('the pandas script gives the page\'s table', () => {
  withPandas.each(CASE_NAMES)('%s', (name) => {
    const c = CASES.find(x => x.name === name);
    const page = pageResult(c);
    const py = results[name];
    expect(py.error).toBeUndefined();
    expect(py.warnings).toEqual([]);
    // The file the script writes is the file the page downloads, byte for byte.
    expect(py.csv).toBe(page.csv);
    expect(py.embed_csv).toBe(page.csv);
    // Its printout follows the page's row and column counts step by step.
    expect(py.stdout).toBe(page.stdout);
    // clean() returns the same cells: same text, same doubles to the bit, same gaps.
    expect(py.columns).toEqual(page.columns);
    expect(py.cells.map(row => row.map(v => (v && v[0] === 'n' ? ['n', v[1]] : v)))).toEqual(page.cells);
  });

  withPandas('numbers stay floats in the table clean() returns', () => {
    const types = new Set();
    for (const name of CASE_NAMES) {
      for (const row of results[name].cells || []) for (const v of row) if (v && v[0] === 'n') types.add(v[2]);
    }
    expect([...types].every(t => t === 'float' || t === 'float64')).toBe(true);
  });

  test('the cases cover every step type, test and transformation', () => {
    const steps = CASES.flatMap(c => c.steps);
    for (const type of STEP_TYPES) expect(steps.some(s => s.type === type)).toBe(true);
    for (const op of FILTER_OPS) expect(steps.some(s => s.type === 'filter' && s.op === op)).toBe(true);
    for (const op of TRANSFORMS) expect(steps.some(s => s.type === 'transform' && s.operation === op)).toBe(true);
    expect(SPACE_CHARACTERS).toContain('﻿');
  });
});
