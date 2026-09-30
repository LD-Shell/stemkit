import { describe, test, expect } from '@jest/globals';
import '../tests/setup.js';
import {
  parseDelimited, toCSV, numericColumn, columnStats, isMissing,
  dropMissing, deduplicate, fillMissing, fillWithStatistic,
  trimWhitespace, changeCase, sortByColumn, filterRows,
  roundColumn, renameColumn, dropColumns, profileData,
  transformColumn,
  readCell, splitRecords, columnNames, guessDelimiter, readTable, writeTable, cellText, stripSpaces,
  exactSum, exactMean, exactPopulationSD, median, exactLn, exactLog10, roundNumber, compareCodePoints,
  titleCase, textToNumber, compareCells, applyStep, runRecipe, checkStep, checkRecipe, columnsAfterStep,
  stepColumns, describeStep, listColumns, normaliseStep, recipeToJSON, parseRecipe, profileTable, STEP_TYPES
} from '../src/core/data-cleaning.js';

const CSV = `name,score,group
Alice,90,A
Bob,,B
Carol,75,A
Bob,,B
Dave,88,`;

describe('parseDelimited', () => {
  test('parses a CSV with a header row', () => {
    const r = parseDelimited(CSV);
    expect(r.fields).toEqual(['name', 'score', 'group']);
    expect(r.rows).toHaveLength(5);
  });

  test('converts numeric fields to numbers', () => {
    expect(parseDelimited(CSV).rows[0].score).toBe(90);
  });

  test('detects a tab delimiter', () => {
    const r = parseDelimited('a\tb\n1\t2');
    expect(r.fields).toEqual(['a', 'b']);
    expect(r.rows[0].b).toBe(2);
  });

  test('detects a semicolon delimiter', () => {
    expect(parseDelimited('a;b\n1;2').fields).toEqual(['a', 'b']);
  });

  test('returns an empty result for blank input', () => {
    expect(parseDelimited('').rows).toEqual([]);
    expect(parseDelimited(null).rows).toEqual([]);
  });
});

describe('toCSV', () => {
  test('round-trips through the parser', () => {
    const r = parseDelimited('a,b\n1,2\n3,4');
    const back = parseDelimited(toCSV(r.rows));
    expect(back.rows).toHaveLength(2);
    expect(back.rows[1].a).toBe(3);
  });

  test('accepts an explicit delimiter', () => {
    expect(toCSV([{ a: 1, b: 2 }], { delimiter: '\t' })).toContain('\t');
  });
});

describe('isMissing', () => {
  test('treats null, undefined and empty string as missing', () => {
    expect(isMissing(null)).toBe(true);
    expect(isMissing(undefined)).toBe(true);
    expect(isMissing('')).toBe(true);
  });

  test('treats zero and false as present', () => {
    expect(isMissing(0)).toBe(false);
    expect(isMissing(false)).toBe(false);
  });
});

describe('numericColumn and columnStats', () => {
  const rows = parseDelimited(CSV).rows;

  test('extracts only finite numbers', () => {
    expect(numericColumn(rows, 'score')).toEqual([90, 75, 88]);
  });

  test('counts missing values', () => {
    const s = columnStats(rows, 'score');
    expect(s.n).toBe(3);
    expect(s.missing).toBe(2);
  });

  test('computes the population standard deviation', () => {
    const s = columnStats([{ v: 2 }, { v: 4 }, { v: 4 }, { v: 4 }, { v: 5 }, { v: 5 }, { v: 7 }, { v: 9 }], 'v');
    expect(s.mean).toBeCloseTo(5, 10);
    expect(s.std).toBeCloseTo(2, 10);
  });

  test('reports min, max and median', () => {
    const s = columnStats(rows, 'score');
    expect(s.min).toBe(75);
    expect(s.max).toBe(90);
    expect(s.median).toBe(88);
  });

  test('handles a column with no numeric values', () => {
    const s = columnStats(rows, 'name');
    expect(s.n).toBe(0);
    expect(Number.isNaN(s.mean)).toBe(true);
  });
});

describe('dropMissing', () => {
  const rows = parseDelimited(CSV).rows;

  test('removes rows missing the target column', () => {
    const r = dropMissing(rows, ['score']);
    expect(r.rows).toHaveLength(3);
    expect(r.removed).toBe(2);
  });

  test('checks every column when none are named', () => {
    expect(dropMissing(rows).rows.length).toBeLessThan(rows.length);
  });

  test('keeps rows where zero is the value', () => {
    expect(dropMissing([{ a: 0 }], ['a']).removed).toBe(0);
  });
});

describe('deduplicate', () => {
  const rows = parseDelimited(CSV).rows;

  test('removes exact duplicate rows', () => {
    const r = deduplicate(rows);
    expect(r.removed).toBe(1);
  });

  test('keeps the first occurrence', () => {
    const r = deduplicate([{ a: 1, b: 'first' }, { a: 1, b: 'first' }]);
    expect(r.rows[0].b).toBe('first');
  });

  test('can deduplicate on a subset of columns', () => {
    const r = deduplicate([{ a: 1, b: 2 }, { a: 1, b: 3 }], ['a']);
    expect(r.rows).toHaveLength(1);
  });
});

describe('fill operations', () => {
  const rows = parseDelimited(CSV).rows;

  test('fills missing cells with a constant', () => {
    const r = fillMissing(rows, ['score'], 0);
    expect(r.filled).toBe(2);
    expect(r.rows[1].score).toBe(0);
  });

  test('fills with the column mean', () => {
    const r = fillWithStatistic(rows, ['score'], 'mean');
    // Mean of 90, 75, 88 is 84.333...
    expect(r.rows[1].score).toBeCloseTo(84.3333, 3);
  });

  test('fills with the column median', () => {
    const r = fillWithStatistic(rows, ['score'], 'median');
    expect(r.rows[1].score).toBe(88);
  });

  test('does not mutate the input', () => {
    fillMissing(rows, ['score'], 0);
    expect(rows[1].score).not.toBe(0);
  });
});

describe('text transforms', () => {
  test('trims surrounding whitespace', () => {
    const r = trimWhitespace([{ a: '  x  ' }]);
    expect(r.rows[0].a).toBe('x');
    expect(r.changed).toBe(1);
  });

  test('changes case in each mode', () => {
    expect(changeCase([{ a: 'hello world' }], ['a'], 'upper').rows[0].a).toBe('HELLO WORLD');
    expect(changeCase([{ a: 'HELLO' }], ['a'], 'lower').rows[0].a).toBe('hello');
    expect(changeCase([{ a: 'hello world' }], ['a'], 'title').rows[0].a).toBe('Hello World');
  });

  test('leaves non-string cells untouched', () => {
    expect(changeCase([{ a: 42 }], ['a'], 'upper').rows[0].a).toBe(42);
  });
});

describe('sortByColumn', () => {
  test('sorts numbers numerically, not lexicographically', () => {
    const r = sortByColumn([{ v: 10 }, { v: 9 }, { v: 100 }], 'v');
    expect(r.map(x => x.v)).toEqual([9, 10, 100]);
  });

  test('sorts descending on request', () => {
    const r = sortByColumn([{ v: 1 }, { v: 3 }, { v: 2 }], 'v', { descending: true });
    expect(r.map(x => x.v)).toEqual([3, 2, 1]);
  });

  test('sorts strings lexicographically', () => {
    const r = sortByColumn([{ v: 'b' }, { v: 'a' }], 'v');
    expect(r[0].v).toBe('a');
  });

  test('places missing values last in both directions', () => {
    const asc = sortByColumn([{ v: 2 }, { v: null }, { v: 1 }], 'v');
    expect(asc[2].v).toBeNull();
    const desc = sortByColumn([{ v: 2 }, { v: null }, { v: 1 }], 'v', { descending: true });
    expect(desc[2].v).toBeNull();
  });

  test('does not mutate the input', () => {
    const rows = [{ v: 3 }, { v: 1 }];
    sortByColumn(rows, 'v');
    expect(rows[0].v).toBe(3);
  });
});

describe('filterRows', () => {
  const rows = [{ v: 1 }, { v: 5 }, { v: 10 }];

  test('filters with numeric comparisons', () => {
    expect(filterRows(rows, 'v', 'gt', 4).rows).toHaveLength(2);
    expect(filterRows(rows, 'v', 'lte', 5).rows).toHaveLength(2);
  });

  test('filters with equality', () => {
    expect(filterRows(rows, 'v', 'eq', 5).rows).toHaveLength(1);
    expect(filterRows(rows, 'v', 'ne', 5).rows).toHaveLength(2);
  });

  test('filters strings case-insensitively with contains', () => {
    const r = filterRows([{ s: 'Hello' }, { s: 'World' }], 's', 'contains', 'hello');
    expect(r.rows).toHaveLength(1);
  });

  test('reports how many rows were removed', () => {
    expect(filterRows(rows, 'v', 'gt', 4).removed).toBe(1);
  });
});

describe('column operations', () => {
  test('rounds numeric cells', () => {
    const r = roundColumn([{ v: 3.14159 }], ['v'], 2);
    expect(r.rows[0].v).toBe(3.14);
  });

  test('renames a column', () => {
    const r = renameColumn([{ old: 1 }], 'old', 'new');
    expect(r[0].new).toBe(1);
    expect(r[0].old).toBeUndefined();
  });

  test('drops columns', () => {
    const r = dropColumns([{ a: 1, b: 2 }], ['b']);
    expect(r[0].b).toBeUndefined();
    expect(r[0].a).toBe(1);
  });
});

describe('profileData', () => {
  test('summarises shape and completeness', () => {
    const rows = parseDelimited(CSV).rows;
    const p = profileData(rows, ['name', 'score', 'group']);
    expect(p.nRows).toBe(5);
    expect(p.nColumns).toBe(3);
    expect(p.missingByColumn.score).toBe(2);
    expect(p.duplicateRows).toBe(1);
  });

  test('handles an empty table', () => {
    const p = profileData([], []);
    expect(p.nRows).toBe(0);
    expect(p.totalMissing).toBe(0);
  });
});

describe('transformColumn', () => {
  const rows = [{ v: 1 }, { v: 10 }, { v: 100 }];

  test('applies base-10 and natural logarithms', () => {
    expect(transformColumn(rows, ['v'], 'log10').rows.map(r => r.v))
      .toEqual([0, 1, 2]);
    expect(transformColumn(rows, ['v'], 'ln').rows[1].v)
      .toBeCloseTo(Math.log(10), 10);
  });

  test('skips non-positive values instead of producing -Infinity', () => {
    // Math.log10(0) is -Infinity and Math.log10(-1) is NaN; either would
    // silently poison every later statistic on the column.
    const r = transformColumn([{ v: 1 }, { v: 0 }, { v: -5 }], ['v'], 'log10');
    expect(r.skipped).toBe(2);
    expect(r.rows[1].v).toBe(0);
    expect(r.rows[2].v).toBe(-5);
  });

  test('takes absolute values', () => {
    expect(transformColumn([{ v: -3 }], ['v'], 'abs').rows[0].v).toBe(3);
  });

  test('min-max scales onto the unit interval', () => {
    const r = transformColumn([{ v: 0 }, { v: 5 }, { v: 10 }], ['v'], 'minmax');
    expect(r.rows.map(x => x.v)).toEqual([0, 0.5, 1]);
  });

  test('z-score uses the population standard deviation', () => {
    // Matches scikit-learn's StandardScaler; pandas would divide by n-1 and
    // give slightly different values.
    const data = [2, 4, 4, 4, 5, 5, 7, 9].map(v => ({ v }));
    const r = transformColumn(data, ['v'], 'zscore');
    expect(r.rows.map(x => +x.v.toFixed(4)))
      .toEqual([-1.5, -0.5, -0.5, -0.5, 0, 0, 1, 2]);
  });

  test('maps a constant column to zero rather than dividing by zero', () => {
    expect(transformColumn([{ v: 7 }, { v: 7 }], ['v'], 'minmax').rows[0].v).toBe(0);
    expect(transformColumn([{ v: 7 }, { v: 7 }], ['v'], 'zscore').rows[0].v).toBe(0);
  });

  test('computes statistics before rewriting any value', () => {
    // Scaling in place would measure each cell against a partially
    // transformed column and give a different, wrong answer.
    const r = transformColumn([{ v: 0 }, { v: 10 }], ['v'], 'minmax');
    expect(r.rows.map(x => x.v)).toEqual([0, 1]);
  });

  test('leaves non-numeric cells untouched', () => {
    const r = transformColumn([{ v: 'text' }, { v: 4 }], ['v'], 'abs');
    expect(r.rows[0].v).toBe('text');
  });

  test('does not mutate the input', () => {
    transformColumn(rows, ['v'], 'log10');
    expect(rows[1].v).toBe(10);
  });

  test('ignores an unknown operation', () => {
    const r = transformColumn(rows, ['v'], 'nonsense');
    expect(r.rows.map(x => x.v)).toEqual([1, 10, 100]);
    expect(r.transformed).toBe(0);
  });
});

/* ====================================================================== *
 * Recipes
 * ====================================================================== */

const table = (columns, rows) => ({ columns, rows });
const run = (t, steps) => runRecipe(t, steps).table;

describe('readCell', () => {
  test('reads numbers written with digits, sign, point and exponent', () => {
    expect(readCell('12')).toBe(12);
    expect(readCell(' 12 ')).toBe(12);
    expect(readCell('-.5')).toBe(-0.5);
    expect(readCell('+4')).toBe(4);
    expect(readCell('1.')).toBe(1);
    expect(readCell('1e-7')).toBe(1e-7);
    expect(Object.is(readCell('-0'), -0)).toBe(true);
  });

  test('leaves everything else as text', () => {
    for (const t of ['NA', 'true', '2024-01-05', '1,5', '12 kg', ' 12', '0x1A', '1_000', '١٢', 'Infinity']) {
      expect(readCell(t)).toBe(t);
    }
  });

  test('reads an empty cell as missing', () => {
    expect(readCell('')).toBeNull();
    expect(readCell(undefined)).toBeNull();
  });

  test('keeps whole numbers of 2^53 and above as text', () => {
    expect(readCell('9007199254740991')).toBe(9007199254740991);
    expect(readCell('9007199254740993')).toBe('9007199254740993');
    expect(readCell('1e20')).toBe(1e20);
  });

  test('reads a decimal comma when asked, and then a point is text', () => {
    expect(readCell('1,5', ',')).toBe(1.5);
    expect(readCell('1.5', ',')).toBe('1.5');
    expect(readCell('12', ',')).toBe(12);
  });

  test('does not read numbers too large for a double', () => {
    expect(readCell('1e400')).toBe('1e400');
  });
});

describe('splitRecords', () => {
  test("splits like Python's csv.reader", () => {
    expect(splitRecords('a,b\n1,2,3\n4\n\n5,6\n')).toEqual([['a', 'b'], ['1', '2', '3'], ['4'], [], ['5', '6']]);
    expect(splitRecords('a,b\r\n"x,1","q""r"\r\n" y",z\n')).toEqual([['a', 'b'], ['x,1', 'q"r'], [' y', 'z']]);
    expect(splitRecords('a,"b"x,c\n')).toEqual([['a', 'bx', 'c']]);
    expect(splitRecords('a, "b,c"\n')).toEqual([['a', ' "b', 'c"']]);
    expect(splitRecords(' \na,b\n')).toEqual([[' '], ['a', 'b']]);
  });

  test('keeps line breaks inside quotes, as \\n', () => {
    expect(splitRecords('"x\r\ny",2\r\n')).toEqual([['x\ny', '2']]);
  });

  test('reads an unclosed quote to the end', () => {
    expect(splitRecords('a,"bc\nd')).toEqual([['a', 'bc\nd']]);
  });

  test('uses the delimiter given', () => {
    expect(splitRecords('a;b\n1,5;2\n', ';')).toEqual([['a', 'b'], ['1,5', '2']]);
    expect(splitRecords('a\t\tb\n', '\t')).toEqual([['a', '', 'b']]);
  });
});

describe('columnNames', () => {
  test('trims names, names empty ones and numbers repeats', () => {
    expect(columnNames([' a ', '', 'a', 'a_2', 'a'], 6)).toEqual(['a', 'column_2', 'a_2', 'a_2_2', 'a_3', 'column_6']);
  });
});

describe('guessDelimiter', () => {
  test('picks the delimiter that splits the lines evenly', () => {
    expect(guessDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(guessDelimiter('a\tb\n1\t2\n')).toBe('\t');
    expect(guessDelimiter('a;b\n1,5;2,5\n')).toBe(';');
    expect(guessDelimiter('a b c\n1 2 3\n')).toBe(' ');
    expect(guessDelimiter('a, b, c\n1, 2, 3\n')).toBe(',');
  });
});

describe('readTable', () => {
  test('reads a header, numbers, text and missing values', () => {
    const t = readTable('name,score\nAna,90\nBen,\n');
    expect(t.columns).toEqual(['name', 'score']);
    expect(t.rows).toEqual([['Ana', 90], ['Ben', null]]);
    expect(t.settings).toEqual({ delimiter: ',', decimal: '.', header: true });
  });

  test('guesses a decimal comma in a semicolon file', () => {
    const t = readTable('a;b\n1,5;2\n3,25;4\n');
    expect(t.settings.decimal).toBe(',');
    expect(t.rows[0]).toEqual([1.5, 2]);
  });

  test('guesses there is no header when the first row is numbers', () => {
    const t = readTable('1,2\n3,4\n');
    expect(t.settings.header).toBe(false);
    expect(t.columns).toEqual(['column_1', 'column_2']);
    expect(t.rows).toHaveLength(2);
  });

  test('pads short rows, widens for long ones and skips blank lines', () => {
    const t = readTable('﻿a,b\r\n1\r\n\r\n2,3,4\r\n');
    expect(t.columns).toEqual(['a', 'b', 'column_3']);
    expect(t.rows).toEqual([[1, null, null], [2, 3, 4]]);
    expect(t.notes.shortRows).toBe(1);
  });

  test('follows the settings it is given', () => {
    const t = readTable('a;b\n1.5;2\n', { delimiter: ';', decimal: ',', header: false });
    expect(t.rows[1]).toEqual(['1.5', 2]);
  });
});

describe('writeTable', () => {
  test("quotes like Python's csv writer", () => {
    const t = table(['a', 'b'], [[' x', 'q"r'], ['a,b', 'l\nm'], [null, 1e-7], [298, 0.1]]);
    expect(writeTable(t)).toBe('a,b\n x,"q""r"\n"a,b","l\nm"\n,1e-7\n298,0.1\n');
  });

  test('writes a lone empty field as ""', () => {
    expect(writeTable(table(['a'], [['x'], [null]]))).toBe('a\nx\n""\n');
  });

  test('writes numbers as JavaScript does', () => {
    expect(cellText(-0)).toBe('0');
    expect(cellText(1e21)).toBe('1e+21');
    expect(cellText(null)).toBe('');
  });
});

describe('exact arithmetic', () => {
  test('exactSum is correctly rounded, as math.fsum', () => {
    expect(exactSum([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1])).toBe(1);
    expect(exactSum([1e-16, 1, 1e16])).toBe(10000000000000002);
    expect(exactSum([1e100, 1, -1e100, 1e-100])).toBe(1);
    expect(exactSum([])).toBe(0);
  });

  test('mean, population SD and median', () => {
    expect(exactMean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
    expect(exactPopulationSD([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test('logarithms are exact where the answer is', () => {
    for (let k = -20; k <= 22; k++) expect(exactLog10(10 ** k)).toBe(k);
    expect(exactLn(1)).toBe(0);
    expect(exactLn(Math.E)).toBe(1);
  });

  test('logarithms are correctly rounded', () => {
    // Math.log10 and Math.log are one bit off for these in V8; the values
    // here are Python's float(Decimal(x).log10()) and .ln().
    expect(exactLog10(1 / 7)).toBe(-0.8450980400142568);
    expect(exactLn(3)).toBe(1.0986122886681098);
    expect(exactLog10(2)).toBe(0.3010299956639812);
    expect(exactLn(5e-324)).toBe(-744.4400719213812);
    expect(exactLn(1 + 2 ** -52)).toBe(2.2204460492503128e-16);
    expect(Number.isNaN(exactLn(0))).toBe(true);
    expect(Number.isNaN(exactLog10(-1))).toBe(true);
  });
});

describe('roundNumber', () => {
  test('rounds the number as written, ties away from zero', () => {
    expect(roundNumber(2.675, 2)).toBe(2.68);
    expect(roundNumber(1.005, 2)).toBe(1.01);
    expect(roundNumber(-2.5, 0)).toBe(-3);
    expect(roundNumber(0.125, 2)).toBe(0.13);
    expect(roundNumber(1234.5678, -2)).toBe(1200);
  });

  test('can send ties to the even digit', () => {
    expect(roundNumber(2.5, 0, { ties: 'even' })).toBe(2);
    expect(roundNumber(3.5, 0, { ties: 'even' })).toBe(4);
    expect(roundNumber(0.125, 2, { ties: 'even' })).toBe(0.12);
    expect(roundNumber(0.5, 0, { ties: 'even' })).toBe(0);
  });

  test('rounds to significant figures', () => {
    expect(roundNumber(0.00123456, 3, { significant: true })).toBe(0.00123);
    expect(roundNumber(987654, 2, { significant: true })).toBe(990000);
    expect(roundNumber(1e-7, 1, { significant: true })).toBe(1e-7);
  });

  test('leaves numbers already short enough alone', () => {
    expect(roundNumber(298, 2)).toBe(298);
    expect(roundNumber(1e300, 2)).toBe(1e300);
    expect(Object.is(roundNumber(-0.001, 2), -0)).toBe(true);
  });
});

describe('text rules', () => {
  test('stripSpaces removes what trim() removes', () => {
    expect(stripSpaces(' 　 x ﻿')).toBe('x');
    expect(stripSpaces('\u001f x')).toBe('\u001f x');
  });

  test('compareCodePoints orders by code point, not UTF-16 unit', () => {
    expect(compareCodePoints('！', '😀')).toBe(-1);
    expect('！' < '😀').toBe(false);
    expect(compareCodePoints('a', 'ab')).toBe(-1);
    expect(compareCodePoints('b', 'a')).toBe(1);
  });

  test('titleCase upper-cases the first letter of each word', () => {
    expect(titleCase("they're émile 3RD (hello) o'neil")).toBe("They're Émile 3rd (Hello) O'neil");
  });

  test('textToNumber ignores spaces and handles text that is not a number', () => {
    expect(textToNumber(' 12 ')).toBe(12);
    expect(textToNumber('12 kg')).toBeNull();
    expect(textToNumber('12 kg', '.', true)).toBe('12 kg');
    expect(textToNumber('0,5', ',')).toBe(0.5);
  });

  test('compareCells puts numbers before text and ignores case', () => {
    expect(compareCells(10, 9)).toBe(1);
    expect(compareCells(10, 'a')).toBe(-1);
    expect(compareCells('B', 'a')).toBe(1);
    expect(compareCells('A', 'a')).toBe(0);
  });
});

describe('steps', () => {
  const t = table(['name', 'score', 'group'], [
    ['Ana', 90, 'A'], ['Bob', null, 'B'], ['Carol', 75, 'A'], ['Bob', null, 'B'], ['Dave', 88, null]
  ]);

  test('dropMissing drops rows with a gap in the columns named, or in any', () => {
    expect(run(t, [{ type: 'dropMissing', columns: ['score'] }]).rows).toHaveLength(3);
    expect(run(t, [{ type: 'dropMissing', columns: [] }]).rows).toHaveLength(2);
  });

  test('dedupe keeps the first of each repeated row', () => {
    expect(run(t, [{ type: 'dedupe', columns: [] }]).rows).toHaveLength(4);
    expect(run(t, [{ type: 'dedupe', columns: ['group'] }]).rows.map(r => r[0])).toEqual(['Ana', 'Bob', 'Dave']);
  });

  test('dedupe tells a number from the same digits as text', () => {
    const r = run(table(['a'], [[1], ['1'], [1], [-0], [0]]), [{ type: 'dedupe', columns: [] }]);
    expect(r.rows).toEqual([[1], ['1'], [-0]]);
  });

  test('filter compares numbers as numbers and fails text and gaps', () => {
    expect(run(t, [{ type: 'filter', column: 'score', op: 'gt', value: 80 }]).rows.map(r => r[0])).toEqual(['Ana', 'Dave']);
    expect(run(t, [{ type: 'filter', column: 'score', op: 'lt', value: 80 }]).rows.map(r => r[0])).toEqual(['Carol']);
    expect(run(t, [{ type: 'filter', column: 'group', op: 'ne', value: 'A' }]).rows).toHaveLength(3);
    expect(run(t, [{ type: 'filter', column: 'name', op: 'contains', value: 'O' }]).rows).toHaveLength(3);
    expect(run(t, [{ type: 'filter', column: 'score', op: 'missing' }]).rows).toHaveLength(2);
  });

  test('sort is stable, numbers first, missing last in both directions', () => {
    const s = table(['k'], [['b'], [null], [2], ['A'], [10], ['a']]);
    expect(run(s, [{ type: 'sort', column: 'k' }]).rows.flat()).toEqual([2, 10, 'A', 'a', 'b', null]);
    expect(run(s, [{ type: 'sort', column: 'k', descending: true }]).rows.flat()).toEqual(['b', 'A', 'a', 10, 2, null]);
  });

  test('fill with a value, the mean, the median or the value above', () => {
    expect(run(t, [{ type: 'fill', columns: ['score'], method: 'value', value: 0 }]).rows[1][1]).toBe(0);
    const mean = runRecipe(t, [{ type: 'fill', columns: ['score'], method: 'mean' }]);
    expect(mean.table.rows[1][1]).toBe(exactMean([90, 75, 88]));
    expect(mean.results[0].changed).toBe(2);
    expect(mean.results[0].note).toBe('mean 84.3333');
    expect(run(t, [{ type: 'fill', columns: ['score'], method: 'median' }]).rows[3][1]).toBe(88);
    expect(run(t, [{ type: 'fill', columns: ['score'], method: 'previous' }]).rows.map(r => r[1])).toEqual([90, 90, 75, 75, 88]);
  });

  test('replace whole cells or text inside cells', () => {
    const r = table(['a'], [['n.d.'], [-999], ['12 kg']]);
    expect(run(r, [{ type: 'replace', columns: [], find: 'n.d.', with: null, whole: true }]).rows[0][0]).toBeNull();
    expect(run(r, [{ type: 'replace', columns: [], find: -999, with: 0, whole: true }]).rows[1][0]).toBe(0);
    expect(run(r, [{ type: 'replace', columns: [], find: ' kg', with: '', whole: false }]).rows[2][0]).toBe('12');
  });

  test('trim turns text of only spaces into a gap, and can shrink runs', () => {
    const r = table(['a'], [['  x  '], ['   '], ['a \t b']]);
    expect(run(r, [{ type: 'trim', columns: [] }]).rows.flat()).toEqual(['x', null, 'a \t b']);
    expect(run(r, [{ type: 'trim', columns: [], collapse: true }]).rows.flat()).toEqual(['x', null, 'a b']);
  });

  test('case changes text and leaves numbers alone', () => {
    const r = table(['a'], [['straße'], [42]]);
    expect(run(r, [{ type: 'case', columns: [], mode: 'upper' }]).rows.flat()).toEqual(['STRASSE', 42]);
  });

  test('toNumber converts the text that is a number', () => {
    const r = table(['a'], [[' 12 '], ['n.d.'], [3]]);
    expect(run(r, [{ type: 'toNumber', columns: [], decimal: '.', invalid: 'missing' }]).rows.flat()).toEqual([12, null, 3]);
  });

  test('round, and transforms that need the whole column', () => {
    const r = table(['x'], [[1], [2], [3], ['t'], [null]]);
    expect(run(r, [{ type: 'transform', columns: [], operation: 'minmax' }]).rows.flat()).toEqual([0, 0.5, 1, 't', null]);
    const z = run(r, [{ type: 'transform', columns: [], operation: 'zscore' }]).rows.flat();
    expect(z[1]).toBe(0);
    expect(z[0]).toBeCloseTo(-1.224744871391589, 14);
    expect(run(r, [{ type: 'transform', columns: [], operation: 'add', value: -1 }]).rows.flat()).toEqual([0, 1, 2, 't', null]);
    expect(run(table(['x'], [[1.25]]), [{ type: 'round', columns: [], digits: 1 }]).rows[0][0]).toBe(1.3);
  });

  test('log makes zero and negative values missing, and says so', () => {
    const r = runRecipe(table(['x'], [[100], [0], [-5]]), [{ type: 'transform', columns: [], operation: 'log10' }]);
    expect(r.table.rows.flat()).toEqual([2, null, null]);
    expect(r.results[0].note).toBe('2 zero or negative values became missing');
  });

  test('rename and dropColumns change the columns', () => {
    const r = run(t, [{ type: 'rename', column: 'score', to: ' points ' }, { type: 'dropColumns', columns: ['group'] }]);
    expect(r.columns).toEqual(['name', 'points']);
    expect(r.rows[0]).toEqual(['Ana', 90]);
  });

  test('applyStep never changes the table it is given', () => {
    const before = JSON.stringify(t);
    for (const step of [{ type: 'fill', columns: [], method: 'value', value: 1 }, { type: 'sort', column: 'name' },
      { type: 'case', columns: [], mode: 'upper' }, { type: 'dropColumns', columns: ['name'] }]) {
      applyStep(t, step);
    }
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe('checking steps', () => {
  test('names the problem a step has at its place', () => {
    expect(checkStep({ type: 'sort', column: 'x' }, ['a'])).toBe('There is no column "x" at this point.');
    expect(checkStep({ type: 'filter', column: 'a', op: 'gt', value: 'x' }, ['a'])).toBe('Enter a number to compare with.');
    expect(checkStep({ type: 'rename', column: 'a', to: 'b' }, ['a', 'b'])).toBe('There is already a column "b".');
    expect(checkStep({ type: 'dropColumns', columns: ['a'] }, ['a'])).toBe('At least one column has to stay.');
    expect(checkStep({ type: 'round', columns: [], digits: 30 }, ['a'])).toBe('Decimal places run from -15 to 15.');
    expect(checkStep({ type: 'nope' }, ['a'])).toBe('This is not a step the Data Cleaner knows.');
    expect(checkStep({ type: 'dedupe', columns: [] }, ['a'])).toBeNull();
  });

  test('follows the columns through renames and removals', () => {
    const steps = [{ type: 'rename', column: 'a', to: 'b' }, { type: 'sort', column: 'a' }, { type: 'sort', column: 'b' }];
    expect(checkRecipe(['a'], steps)).toEqual([null, 'There is no column "a" at this point.', null]);
    expect(columnsAfterStep(['a', 'c'], { type: 'dropColumns', columns: ['c'] })).toEqual(['a']);
    expect(stepColumns({ type: 'trim', columns: [] }, ['a', 'b'])).toEqual(['a', 'b']);
  });

  test('runRecipe skips steps that are off or cannot run', () => {
    const t = table(['a'], [[2], [1]]);
    const r = runRecipe(t, [
      { type: 'sort', column: 'a', enabled: false },
      { type: 'sort', column: 'zzz' },
      { type: 'filter', column: 'a', op: 'gt', value: 1 }
    ]);
    expect(r.results.map(x => x.status)).toEqual(['off', 'error', 'ok']);
    expect(r.results[2]).toMatchObject({ rowsBefore: 2, rowsAfter: 1, columnsBefore: 1, columnsAfter: 1 });
    expect(r.table.rows).toEqual([[2]]);
  });

  test('runRecipe reuses the unchanged start of an earlier run', () => {
    const t = table(['a'], [[2], [1]]);
    const steps = [{ id: 1, type: 'sort', column: 'a' }, { id: 2, type: 'filter', column: 'a', op: 'gt', value: 1 }];
    const first = runRecipe(t, steps);
    const again = runRecipe(t, [steps[0], { ...steps[1], value: 0 }], { reuse: { steps, results: first.results } });
    expect(again.results[0]).toBe(first.results[0]);
    expect(again.table.rows).toEqual([[1], [2]]);
  });
});

describe('describing steps', () => {
  test('says what each step does', () => {
    expect(describeStep({ type: 'dropMissing', columns: ['a'] })).toBe('Drop rows where a is missing');
    expect(describeStep({ type: 'filter', column: 'op', op: 'eq', value: 'ana' })).toBe('Keep rows where op is "ana"');
    expect(describeStep({ type: 'fill', columns: [], method: 'mean' })).toBe('Fill missing values in every column with the column mean');
    expect(describeStep({ type: 'round', columns: ['x'], digits: 3, significant: true })).toBe('Round x to 3 significant figures');
    expect(describeStep({ type: 'transform', columns: ['T'], operation: 'add', value: -273.15 })).toBe('Subtract 273.15 from T');
    expect(describeStep({ type: 'replace', columns: ['m'], find: ' kg', with: '', whole: false })).toBe('Remove " kg" from text in m');
  });

  test('every step type has words', () => {
    for (const type of STEP_TYPES) expect(describeStep(normaliseStep({ type }))).not.toBe('Unknown step');
  });

  test('lists columns in words', () => {
    expect(listColumns([])).toBe('every column');
    expect(listColumns(['a', 'b', 'c'])).toBe('a, b and c');
    expect(listColumns(['a', 'b', 'c', 'd', 'e'])).toBe('5 columns');
  });
});

describe('recipes as files', () => {
  test('round-trip through JSON', () => {
    const steps = [{ id: 7, type: 'sort', column: 'a', descending: true, enabled: false }, { type: 'trim', columns: ['b'] }];
    const back = parseRecipe(recipeToJSON(steps, { fileName: 'x.csv' }));
    expect(back.steps).toEqual([
      { type: 'sort', column: 'a', descending: true, enabled: false },
      { type: 'trim', columns: ['b'], collapse: false }
    ]);
    expect(back.source).toEqual({ fileName: 'x.csv' });
  });

  test('accept a bare list of steps', () => {
    expect(parseRecipe('[{"type":"dedupe"}]').steps).toEqual([{ type: 'dedupe', columns: [] }]);
  });

  test('refuse what is not a recipe', () => {
    expect(() => parseRecipe('{')).toThrow('not valid JSON');
    expect(() => parseRecipe('{"a":1}')).toThrow('no list of steps');
    expect(() => parseRecipe('[{"type":"explode"}]')).toThrow('Step 1');
  });
});

describe('profileTable', () => {
  test('counts numbers, text, gaps, padded text and repeated rows', () => {
    const p = profileTable(table(['a', 'b'], [[1, ' x'], [1, ' x'], [null, '12'], ['n', null]]));
    expect(p.duplicateRows).toBe(1);
    expect(p.missing).toBe(2);
    expect(p.columns[0]).toMatchObject({ numbers: 2, texts: 1, missing: 1 });
    expect(p.columns[1]).toMatchObject({ texts: 3, padded: 2, numeric: 1, missing: 1 });
  });
});
