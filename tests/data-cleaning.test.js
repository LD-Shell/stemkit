import { describe, test, expect } from '@jest/globals';
import '../tests/setup.js';
import {
  parseDelimited, toCSV, numericColumn, columnStats, isMissing,
  dropMissing, deduplicate, fillMissing, fillWithStatistic,
  trimWhitespace, changeCase, sortByColumn, filterRows,
  roundColumn, renameColumn, dropColumns, profileData,
  transformColumn
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
