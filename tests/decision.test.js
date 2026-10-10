/**
 * The rules behind the Decision Matrix page (js/decision.js): what a field
 * counts as, how weighted totals are ranked and tied, and what the page says
 * about the ranking and about entries it corrected. The page itself is
 * checked in a browser; these are the parts that decide what it shows.
 */

import { describe, test, expect } from '@jest/globals';
import {
  WEIGHT, SCORE, readEntry, tieTolerance, rankOptions, fmt, listNames, rankingKey,
  resultSentence, summaryText, correctionNote
} from '../js/decision.js';

const ranks = result => result.rows.map(r => [r.rank, r.name]);

describe('readEntry', () => {
  test('a number inside the range is used as typed, decimals included', () => {
    expect(readEntry('4', WEIGHT)).toEqual({ value: 4, why: null });
    expect(readEntry('2.5', WEIGHT)).toEqual({ value: 2.5, why: null });
    expect(readEntry('10', SCORE)).toEqual({ value: 10, why: null });
  });

  test('a number outside the range counts as the nearest end of it', () => {
    expect(readEntry('9', WEIGHT)).toEqual({ value: 5, why: 'high' });
    expect(readEntry('0', SCORE)).toEqual({ value: 1, why: 'low' });
    expect(readEntry('-3', WEIGHT)).toEqual({ value: 1, why: 'low' });
  });

  test('a field with no number counts as the value it started with', () => {
    expect(readEntry('', WEIGHT)).toEqual({ value: 3, why: 'blank' });
    expect(readEntry('', SCORE)).toEqual({ value: 5, why: 'blank' });
    expect(readEntry('abc', SCORE)).toEqual({ value: 5, why: 'blank' });
  });
});

describe('rankOptions', () => {
  test('the worked example: totals, share of the best possible score, order', () => {
    // By hand: A = 4*9 + 3*4 + 5*6 + 2*5 = 88, B = 24 + 24 + 35 + 16 = 99,
    // C = 28 + 18 + 45 + 6 = 97, of (4 + 3 + 5 + 2) * 10 = 140.
    const r = rankOptions(['Job A', 'Job B', 'Job C'], [4, 3, 5, 2], [[9, 4, 6, 5], [6, 8, 7, 8], [7, 6, 9, 3]]);
    expect(r.maxPossible).toBe(140);
    expect(r.rows.map(x => [x.rank, x.name, x.total, x.tied])).toEqual([
      [1, 'Job B', 99, false], [2, 'Job C', 97, false], [3, 'Job A', 88, false]
    ]);
    expect(r.rows[0].pct).toBeCloseTo(100 * 99 / 140, 12);
    expect(r.winners.map(w => w.name)).toEqual(['Job B']);
  });

  test('equal totals share a rank and the next rank skips: 1, 1, 3', () => {
    const r = rankOptions(['A', 'B', 'C'], [3, 3], [[5, 5], [5, 5], [2, 2]]);
    expect(ranks(r)).toEqual([[1, 'A'], [1, 'B'], [3, 'C']]);
    expect(r.rows.map(x => x.tied)).toEqual([true, true, false]);
    expect(r.winners.map(w => w.name)).toEqual(['A', 'B']);
  });

  test('a tie below the top: 1, 2, 2, 4', () => {
    const r = rankOptions(['A', 'B', 'C', 'D'], [2], [[3], [9], [1], [3]]);
    expect(ranks(r)).toEqual([[1, 'B'], [2, 'A'], [2, 'D'], [4, 'C']]);
    expect(r.rows.map(x => x.tied)).toEqual([false, true, true, false]);
  });

  test('totals equal on paper but not in floating point are tied, in the order entered', () => {
    // Weights 1.1, 1.1, 1.4: First = 1.1 + 5.5 + 4.2 and Second = 2.2 + 4.4 + 4.2
    // are both 10.8, but the sums come out as 10.799999999999999 and 10.8.
    const weights = [1.1, 1.1, 1.4];
    expect(1 * 1.1 + 5 * 1.1 + 3 * 1.4).not.toBe(2 * 1.1 + 4 * 1.1 + 3 * 1.4);
    const r = rankOptions(['First', 'Second'], weights, [[1, 5, 3], [2, 4, 3]]);
    expect(ranks(r)).toEqual([[1, 'First'], [1, 'Second']]);
    expect(r.rows[0].total).toBe(r.rows[1].total);
    expect(r.rows[0].pct).toBe(r.rows[1].pct);
    // The same pair below a clear winner shares second place.
    const below = rankOptions(['First', 'Second', 'Best'], weights, [[1, 5, 3], [2, 4, 3], [10, 10, 10]]);
    expect(ranks(below)).toEqual([[1, 'Best'], [2, 'First'], [2, 'Second']]);
  });

  test('the order entered does not change who is tied', () => {
    const a = rankOptions(['First', 'Second'], [1.1, 1.1, 1.4], [[1, 5, 3], [2, 4, 3]]);
    const b = rankOptions(['Second', 'First'], [1.1, 1.1, 1.4], [[2, 4, 3], [1, 5, 3]]);
    expect(ranks(a)).toEqual([[1, 'First'], [1, 'Second']]);
    expect(ranks(b)).toEqual([[1, 'Second'], [1, 'First']]);
  });

  test('totals that differ by the smallest step a person can enter are not tied', () => {
    // 0.001 on one score out of ten criteria at full weight: 1 part in 500 000.
    const n = 10;
    const top = new Array(n).fill(10);
    const less = [...top.slice(0, -1), 9.999];
    const r = rankOptions(['A', 'B'], new Array(n).fill(5), [less, top]);
    expect(ranks(r)).toEqual([[1, 'B'], [2, 'A']]);
  });
});

describe('tieTolerance', () => {
  test('is relative to the totals and grows with the number of criteria', () => {
    expect(tieTolerance(10, 10, 3)).toBe(2 * 5 * Number.EPSILON * 10);
    expect(tieTolerance(100, 10, 3)).toBe(10 * tieTolerance(10, 10, 3));
    expect(tieTolerance(10, 10, 8)).toBeGreaterThan(tieTolerance(10, 10, 3));
  });

  test('covers every pair of one-decimal weights and whole scores that are equal on paper', () => {
    // Exact totals in tenths, from integer arithmetic, against the floating-point sums.
    const weights = [1.1, 2.3, 4.7];
    const tenths = [11, 23, 47];
    const seen = new Map();
    let worst = 0;
    for (let a = 1; a <= 10; a++) for (let b = 1; b <= 10; b++) for (let c = 1; c <= 10; c++) {
      const exact = a * tenths[0] + b * tenths[1] + c * tenths[2];
      const got = a * weights[0] + b * weights[1] + c * weights[2];
      if (seen.has(exact)) {
        const other = seen.get(exact);
        expect(Math.abs(got - other)).toBeLessThanOrEqual(tieTolerance(got, other, 3));
        worst = Math.max(worst, Math.abs(got - other));
      } else seen.set(exact, got);
    }
    expect(worst).toBeGreaterThan(0); // the tolerance is needed: some pairs do differ
  });
});

describe('what the page shows', () => {
  test('fmt: whole numbers as they are, two decimals at most, no rounding noise', () => {
    expect(fmt(99)).toBe('99');
    expect(fmt(16.5)).toBe('16.5');
    expect(fmt(18.75)).toBe('18.75');
    expect(fmt(10.799999999999999)).toBe('10.8');
    expect(fmt((1.1 + 1.3) * 10)).toBe('24'); // 24.000000000000004
  });

  test('listNames', () => {
    expect(listNames(['A'])).toBe('A');
    expect(listNames(['A', 'B'])).toBe('A and B');
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C');
  });

  test('one sentence for a winner, a tie for first, and a tie of everything', () => {
    const win = rankOptions(['Job A', 'Job B', 'Job C'], [4, 3, 5, 2], [[9, 4, 6, 5], [6, 8, 7, 8], [7, 6, 9, 3]]);
    expect(resultSentence(win)).toBe('Job B ranks first with 99 of 140 (71%).');
    const tie = rankOptions(['A', 'B', 'C'], [3, 3], [[5, 5], [5, 5], [2, 2]]);
    expect(resultSentence(tie)).toBe('A and B are tied for first, each with 30 of 60 (50%).');
    const all = rankOptions(['A', 'B', 'C'], [3], [[5], [5], [5]]);
    expect(resultSentence(all)).toBe('All 3 options are tied, each with 15 of 30 (50%).');
    const two = rankOptions(['A', 'B'], [3], [[5], [5]]);
    expect(resultSentence(two)).toBe('A and B are tied for first, each with 15 of 30 (50%).');
  });

  test('the maximum is shown without rounding noise', () => {
    const r = rankOptions(['A', 'B'], [1.1, 1.3], [[5, 5], [4, 4]]);
    expect(r.maxPossible).not.toBe(24);
    expect(resultSentence(r)).toBe('A ranks first with 12 of 24 (50%).');
    expect(summaryText(r)).toContain('1. A: 12/24 (50%)\n2. B: 9.6/24 (40%)');
  });

  test('the copied ranking numbers ties alike and says they are tied', () => {
    const r = rankOptions(['A', 'B', 'C'], [3, 3], [[5, 5], [5, 5], [2, 2]]);
    expect(summaryText(r)).toBe(
      'Decision Matrix result\nTied for first: A and B\n\n' +
      '1. A: 30/60 (50%), tied\n1. B: 30/60 (50%), tied\n3. C: 12/60 (20%)\n\n' +
      'Generated with STEMKit Decision Matrix (stemkit.net).');
  });

  test('rankingKey changes with the order or a tie, not with the scores alone', () => {
    const a = rankOptions(['A', 'B'], [3], [[5], [4]]);
    const sameOrder = rankOptions(['A', 'B'], [3], [[9], [4]]);
    const tied = rankOptions(['A', 'B'], [3], [[4], [4]]);
    const swapped = rankOptions(['A', 'B'], [3], [[3], [4]]);
    expect(rankingKey(sameOrder)).toBe(rankingKey(a));
    expect(rankingKey(tied)).not.toBe(rankingKey(a));
    expect(rankingKey(swapped)).not.toBe(rankingKey(a));
  });
});

describe('correctionNote', () => {
  const high = { label: 'weight of Salary', raw: '9', used: 5, why: 'high', range: WEIGHT };
  const low = { label: 'score of Job A on Growth', raw: '0', used: 1, why: 'low', range: SCORE };
  const blank = { label: 'score of Job B on Salary', raw: '', used: 5, why: 'blank', range: SCORE };

  test('nothing to say when every entry was used as typed', () => {
    expect(correctionNote([], { written: true })).toBe('');
  });

  test('one entry corrected by Rank the options', () => {
    expect(correctionNote([high], { written: true }))
      .toBe('Weight of Salary was 9, outside the range of 1 to 5, so it was set to 5.');
    expect(correctionNote([blank], { written: true }))
      .toBe('Score of Job B on Salary had no number in it, so it was set to 5, the value it started with.');
  });

  test('one entry outside its range while it is still being typed', () => {
    expect(correctionNote([low], { written: false }))
      .toBe('Score of Job A on Growth is 0, outside the range of 1 to 10, so it counts as 1.');
  });

  test('several entries are counted and named, the first three of many', () => {
    expect(correctionNote([high, low, blank], { written: true })).toBe(
      '3 entries were corrected and are outlined in the matrix: weight of Salary from 9 to 5, ' +
      'score of Job A on Growth from 0 to 1 and score of Job B on Salary from no number to 5.');
    expect(correctionNote([high, low, blank, high, low], { written: true })).toBe(
      '5 entries were corrected and are outlined in the matrix: weight of Salary from 9 to 5, ' +
      'score of Job A on Growth from 0 to 1, score of Job B on Salary from no number to 5 and 2 more.');
    expect(correctionNote([high, low], { written: false })).toBe(
      '2 entries are outside their range and count as the nearest end of it: ' +
      'weight of Salary (9, counted as 5) and score of Job A on Growth (0, counted as 1).');
  });
});
