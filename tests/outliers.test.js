import { describe, test, expect } from '@jest/globals';
import '../tests/setup.js';
import {
  MAD_TO_SIGMA,
  median, medianAbsoluteDeviation, quartiles,
  zScores, modifiedZScores,
  detectZScore, detectModifiedZScore, detectIQR, detectOutliers,
  grubbsTest,
  extractNumericColumn, mapToRowIndices, partitionRows
} from '../src/core/outliers.js';

/* Reference values from numpy/scipy (linear-interpolation quantiles). */

const CONTAMINATED = [10, 12, 11, 13, 12, 11, 14, 10, 13, 12, 95];
const CLEAN = [2, 4, 4, 4, 5, 5, 7, 9];

describe('median', () => {
  test('returns the central value for odd n', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  test('averages the two central values for even n', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test('does not require pre-sorted input', () => {
    expect(median([95, 10, 12])).toBe(12);
  });

  test('does not mutate the caller array', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  test('returns NaN for empty or invalid input', () => {
    expect(Number.isNaN(median([]))).toBe(true);
    expect(Number.isNaN(median(null))).toBe(true);
  });
});

describe('medianAbsoluteDeviation', () => {
  test('matches the numpy MAD', () => {
    expect(medianAbsoluteDeviation(CONTAMINATED)).toBeCloseTo(1.0, 12);
  });

  test('is zero when more than half the values are identical', () => {
    expect(medianAbsoluteDeviation([5, 5, 5, 5, 1, 100])).toBe(0);
  });

  test('is unaffected by a single extreme value', () => {
    const withOutlier = medianAbsoluteDeviation([1, 2, 3, 4, 5, 1000]);
    const without = medianAbsoluteDeviation([1, 2, 3, 4, 5, 6]);
    expect(withOutlier).toBeCloseTo(without, 12);
  });
});

describe('quartiles', () => {
  test('matches numpy linear-interpolation percentiles', () => {
    const q = quartiles(CONTAMINATED);
    expect(q.q1).toBeCloseTo(11.0, 12);
    expect(q.q2).toBeCloseTo(12.0, 12);
    expect(q.q3).toBeCloseTo(13.0, 12);
  });

  test('interpolates between order statistics when needed', () => {
    const q = quartiles(CLEAN);
    expect(q.q1).toBeCloseTo(4.0, 12);
    expect(q.q2).toBeCloseTo(4.5, 12);
    expect(q.q3).toBeCloseTo(5.5, 12);
  });

  test('IQR is the difference of the outer quartiles', () => {
    const q = quartiles(CONTAMINATED);
    expect(q.iqr).toBeCloseTo(q.q3 - q.q1, 12);
  });

  test('collapses to a point for a constant sample', () => {
    const q = quartiles([7, 7, 7, 7]);
    expect(q.iqr).toBe(0);
    expect(q.q2).toBe(7);
  });

  test('returns null for empty input', () => {
    expect(quartiles([])).toBeNull();
  });
});

describe('zScores', () => {
  test('matches numpy with the ddof=1 standard deviation', () => {
    const z = zScores(CONTAMINATED);
    expect(z[0]).toBeCloseTo(-0.37280344870866333, 12);
    expect(z[10]).toBeCloseTo(3.0113831973359995, 12);
  });

  test('sums to zero across the sample', () => {
    const z = zScores(CONTAMINATED);
    expect(z.reduce((s, v) => s + v, 0)).toBeCloseTo(0, 10);
  });

  test('returns zeros rather than NaN for a constant sample', () => {
    expect(zScores([5, 5, 5])).toEqual([0, 0, 0]);
  });

  test('returns an empty array for empty input', () => {
    expect(zScores([])).toEqual([]);
  });
});

describe('modifiedZScores', () => {
  test('matches the Iglewicz-Hoaglin definition', () => {
    const m = modifiedZScores(CONTAMINATED);
    expect(m[10]).toBeCloseTo(55.9835, 4);
    expect(m[1]).toBeCloseTo(0, 12);
  });

  test('resists masking far better than the plain Z-score', () => {
    // The same outlier scores ~3 on Z but ~56 on modified Z, because the mean
    // and SD are themselves inflated by the contamination.
    const z = zScores(CONTAMINATED)[10];
    const m = modifiedZScores(CONTAMINATED)[10];
    expect(m).toBeGreaterThan(z * 10);
  });

  test('falls back to the mean absolute deviation when the MAD is zero', () => {
    const values = [5, 5, 5, 5, 5, 5, 100];
    const m = modifiedZScores(values);
    expect(Number.isFinite(m[6])).toBe(true);
    expect(Math.abs(m[6])).toBeGreaterThan(1);
  });

  test('returns zeros when every value is identical', () => {
    expect(modifiedZScores([3, 3, 3])).toEqual([0, 0, 0]);
  });
});

describe('detectZScore', () => {
  test('flags the contaminating value at the default threshold', () => {
    const r = detectZScore(CONTAMINATED, 3);
    expect(r.indices).toEqual([10]);
  });

  test('respects a stricter threshold', () => {
    expect(detectZScore(CONTAMINATED, 3.5).indices).toEqual([]);
  });

  test('flags nothing in clean data', () => {
    expect(detectZScore(CLEAN, 3).indices).toEqual([]);
  });

  test('reports a degenerate sample instead of flagging everything', () => {
    const r = detectZScore([4, 4, 4, 4], 3);
    expect(r.indices).toEqual([]);
    expect(r.degenerate).toBe(true);
  });
});

describe('detectModifiedZScore', () => {
  test('flags the contaminating value', () => {
    expect(detectModifiedZScore(CONTAMINATED, 3.5).indices).toEqual([10]);
  });

  test('catches an outlier that the plain Z-score misses', () => {
    // Two outliers mask each other under the mean/SD criterion.
    const twin = [10, 11, 12, 11, 10, 12, 11, 90, 92];
    expect(detectZScore(twin, 3).indices).toEqual([]);
    expect(detectModifiedZScore(twin, 3.5).indices).toEqual([7, 8]);
  });

  test('signals when the mean-absolute-deviation fallback was used', () => {
    const r = detectModifiedZScore([5, 5, 5, 5, 5, 5, 100], 3.5);
    expect(r.usedFallback).toBe(true);
  });

  test('does not use the fallback for well-spread data', () => {
    expect(detectModifiedZScore(CONTAMINATED, 3.5).usedFallback).toBe(false);
  });
});

describe('detectIQR', () => {
  test('flags points beyond the 1.5 IQR fence', () => {
    const r = detectIQR(CONTAMINATED, 1.5);
    expect(r.indices).toEqual([10]);
  });

  test('computes fences from the quartiles', () => {
    const r = detectIQR(CONTAMINATED, 1.5);
    expect(r.lower).toBeCloseTo(11 - 1.5 * 2, 12);
    expect(r.upper).toBeCloseTo(13 + 1.5 * 2, 12);
  });

  test('a larger multiplier flags fewer points', () => {
    const loose = detectIQR(CONTAMINATED, 3.0);
    const tight = detectIQR(CONTAMINATED, 1.5);
    expect(loose.indices.length).toBeLessThanOrEqual(tight.indices.length);
  });

  test('flags both tails', () => {
    const r = detectIQR([-100, 10, 11, 12, 11, 10, 12, 11, 200], 1.5);
    expect(r.indices).toContain(0);
    expect(r.indices).toContain(8);
  });

  test('returns null for empty input', () => {
    expect(detectIQR([], 1.5)).toBeNull();
  });
});

describe('grubbsTest', () => {
  test('G and the critical value match the scipy-derived reference', () => {
    const r = grubbsTest(CONTAMINATED, 0.05);
    expect(r.G).toBeCloseTo(3.0113831973359995, 10);
    expect(r.critical).toBeCloseTo(2.3547300515655385, 8);
  });

  test('identifies the extreme observation and declares it an outlier', () => {
    const r = grubbsTest(CONTAMINATED, 0.05);
    expect(r.index).toBe(10);
    expect(r.value).toBe(95);
    expect(r.isOutlier).toBe(true);
  });

  test('reports a significant p-value for a true outlier', () => {
    expect(grubbsTest(CONTAMINATED, 0.05).p).toBeLessThan(0.05);
  });

  test('does not flag clean data', () => {
    const r = grubbsTest(CLEAN, 0.05);
    expect(r.isOutlier).toBe(false);
    expect(r.p).toBeGreaterThan(0.05);
  });

  test('returns null when the sample is too small or has no spread', () => {
    expect(grubbsTest([1, 2], 0.05)).toBeNull();
    expect(grubbsTest([5, 5, 5, 5], 0.05)).toBeNull();
  });
});

describe('detectOutliers dispatch', () => {
  test('routes to each named method', () => {
    expect(detectOutliers(CONTAMINATED, 'zscore', 3).method).toBe('zscore');
    expect(detectOutliers(CONTAMINATED, 'modzscore', 3.5).method).toBe('modzscore');
    expect(detectOutliers(CONTAMINATED, 'iqr', 1.5).method).toBe('iqr');
  });

  test('applies each method default when no threshold is supplied', () => {
    expect(detectOutliers(CONTAMINATED, 'zscore').threshold).toBe(3);
    expect(detectOutliers(CONTAMINATED, 'modzscore').threshold).toBe(3.5);
    expect(detectOutliers(CONTAMINATED, 'iqr').threshold).toBe(1.5);
  });

  test('returns null for an unknown method', () => {
    expect(detectOutliers(CONTAMINATED, 'nonsense', 3)).toBeNull();
  });
});

describe('row mapping', () => {
  const rows = [
    { v: 10 }, { v: 'bad' }, { v: 12 }, { v: null }, { v: 95 }
  ];

  test('extracts only finite numeric values', () => {
    const { values, indexMap } = extractNumericColumn(rows, 'v');
    expect(values).toEqual([10, 12, 95]);
    expect(indexMap).toEqual([0, 2, 4]);
  });

  test('maps compacted positions back to original rows', () => {
    const { indexMap } = extractNumericColumn(rows, 'v');
    // Position 2 in the compacted vector is row 4 in the source table.
    expect(mapToRowIndices([2], indexMap)).toEqual([4]);
  });

  test('drops positions that fall outside the map', () => {
    expect(mapToRowIndices([0, 99], [7])).toEqual([7]);
  });

  test('handles a missing column without throwing', () => {
    expect(extractNumericColumn(rows, 'absent').values).toEqual([]);
    expect(extractNumericColumn(null, 'v').values).toEqual([]);
  });

  test('partitions rows into clean and flagged sets', () => {
    const { clean, flagged } = partitionRows(rows, [4]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].v).toBe(95);
    expect(clean).toHaveLength(4);
  });

  test('partitioning is lossless', () => {
    const { clean, flagged } = partitionRows(rows, [0, 2]);
    expect(clean.length + flagged.length).toBe(rows.length);
  });

  test('an empty flag list retains every row', () => {
    expect(partitionRows(rows, []).clean).toHaveLength(5);
  });
});

describe('end-to-end detection', () => {
  test('constants are exported for downstream reuse', () => {
    expect(MAD_TO_SIGMA).toBeCloseTo(0.6745, 6);
  });

  test('all three methods agree on an unambiguous outlier', () => {
    const z = detectZScore(CONTAMINATED, 3).indices;
    const m = detectModifiedZScore(CONTAMINATED, 3.5).indices;
    const i = detectIQR(CONTAMINATED, 1.5).indices;
    expect(z).toEqual([10]);
    expect(m).toEqual([10]);
    expect(i).toEqual([10]);
  });
});
