import { describe, test, expect } from '@jest/globals';
import {
  mapScale, toDataCoordinates, validateCalibration, pixelResolution,
  erasePoints, sortPoints, formatValue, generateCSV, digitisePoints,
  pythonString, pythonIdentifier, validateCalibrationForm
} from '../src/core/digitizer.js';

const LINEAR_CAL = {
  pxX1: 100, pxX2: 500, valX1: 0, valX2: 100,
  pxY1: 400, pxY2: 100, valY1: 0, valY2: 50,
  logX: false, logY: false
};

const LOG_CAL = {
  pxX1: 100, pxX2: 500, valX1: 1, valX2: 1000,
  pxY1: 400, pxY2: 100, valY1: 0.001, valY2: 1,
  logX: true, logY: true
};

describe('mapScale', () => {
  test('interpolates linearly between calibration points', () => {
    // Halfway in pixels is halfway in value.
    expect(mapScale(300, 100, 500, 0, 100)).toBeCloseTo(50, 10);
  });

  test('returns the endpoint values exactly', () => {
    expect(mapScale(100, 100, 500, 0, 100)).toBeCloseTo(0, 10);
    expect(mapScale(500, 100, 500, 0, 100)).toBeCloseTo(100, 10);
  });

  test('extrapolates beyond the calibration range', () => {
    expect(mapScale(700, 100, 500, 0, 100)).toBeCloseTo(150, 10);
    expect(mapScale(-100, 100, 500, 0, 100)).toBeCloseTo(-50, 10);
  });

  test('handles an inverted pixel axis, as screen y is', () => {
    // Pixel y grows downward while data y grows upward.
    expect(mapScale(250, 400, 100, 0, 50)).toBeCloseTo(25, 10);
  });

  test('interpolates in log space on a logarithmic axis', () => {
    // Halfway between 1 and 1000 in log space is 10^1.5 = 31.62, not 500.
    expect(mapScale(300, 100, 500, 1, 1000, true)).toBeCloseTo(31.6227766, 6);
  });

  test('places decade boundaries at equal pixel spacing on a log axis', () => {
    const a = mapScale(100, 100, 400, 1, 1000, true);
    const b = mapScale(200, 100, 400, 1, 1000, true);
    const c = mapScale(300, 100, 400, 1, 1000, true);
    expect(a).toBeCloseTo(1, 8);
    expect(b).toBeCloseTo(10, 8);
    expect(c).toBeCloseTo(100, 8);
  });

  test('returns null for coincident calibration pixels', () => {
    expect(mapScale(300, 200, 200, 0, 100)).toBeNull();
  });

  test('returns null for a non-positive value on a log axis', () => {
    expect(mapScale(300, 100, 500, 0, 1000, true)).toBeNull();
    expect(mapScale(300, 100, 500, -1, 1000, true)).toBeNull();
  });

  test('returns null for non-finite input', () => {
    expect(mapScale(NaN, 100, 500, 0, 100)).toBeNull();
  });
});

describe('toDataCoordinates', () => {
  test('maps a pixel position to data coordinates', () => {
    const d = toDataCoordinates(300, 250, LINEAR_CAL);
    expect(d.x).toBeCloseTo(50, 10);
    expect(d.y).toBeCloseTo(25, 10);
  });

  test('maps on a doubly logarithmic plot', () => {
    const d = toDataCoordinates(300, 250, LOG_CAL);
    expect(d.x).toBeCloseTo(31.6227766, 6);
    expect(d.y).toBeCloseTo(0.0316227766, 8);
  });

  test('returns null for an incomplete calibration', () => {
    expect(toDataCoordinates(300, 250, { ...LINEAR_CAL, pxX1: null })).toBeNull();
    expect(toDataCoordinates(300, 250, null)).toBeNull();
  });

  test('returns null when a calibration is degenerate', () => {
    expect(toDataCoordinates(300, 250, { ...LINEAR_CAL, pxX2: 100 })).toBeNull();
  });
});

describe('validateCalibration', () => {
  test('accepts a well-formed calibration', () => {
    const v = validateCalibration(LINEAR_CAL);
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
  });

  test('rejects coincident calibration pixels', () => {
    const v = validateCalibration({ ...LINEAR_CAL, pxX2: 100 });
    expect(v.valid).toBe(false);
    expect(v.errors.some(e => e.includes('pixel column'))).toBe(true);
  });

  test('rejects identical calibration values', () => {
    const v = validateCalibration({ ...LINEAR_CAL, valY2: 0 });
    expect(v.valid).toBe(false);
  });

  test('rejects a non-positive value on a logarithmic axis', () => {
    const v = validateCalibration({ ...LOG_CAL, valX1: 0 });
    expect(v.valid).toBe(false);
    expect(v.errors.some(e => e.includes('logarithmic'))).toBe(true);
  });

  test('warns when calibration points are very close together', () => {
    const v = validateCalibration({ ...LINEAR_CAL, pxX2: 110 });
    expect(v.valid).toBe(true);
    expect(v.warnings.length).toBeGreaterThan(0);
  });

  test('reports missing values rather than throwing', () => {
    expect(validateCalibration(null).valid).toBe(false);
    expect(validateCalibration({}).valid).toBe(false);
  });
});

describe('pixelResolution', () => {
  test('reports data units per pixel', () => {
    const r = pixelResolution(LINEAR_CAL);
    // 100 data units across 400 pixels is 0.25 per pixel.
    expect(r.dx).toBeCloseTo(0.25, 10);
    expect(r.dy).toBeCloseTo(50 / 300, 10);
  });

  test('returns null for an invalid calibration', () => {
    expect(pixelResolution({ ...LINEAR_CAL, pxX2: 100 })).toBeNull();
  });
});

describe('point management', () => {
  const points = [
    { pxX: 100, pxY: 100 }, { pxX: 105, pxY: 103 }, { pxX: 300, pxY: 200 }
  ];

  test('erases points inside the radius', () => {
    const r = erasePoints(points, 100, 100, 10);
    expect(r.removed).toBe(2);
    expect(r.points).toHaveLength(1);
  });

  test('leaves points outside the radius', () => {
    expect(erasePoints(points, 100, 100, 2).removed).toBe(1);
  });

  test('does not mutate the input array', () => {
    erasePoints(points, 100, 100, 500);
    expect(points).toHaveLength(3);
  });

  test('sorts points left to right', () => {
    const s = sortPoints([{ pxX: 300 }, { pxX: 100 }, { pxX: 200 }]);
    expect(s.map(p => p.pxX)).toEqual([100, 200, 300]);
  });

  test('sorting does not mutate the input', () => {
    const p = [{ pxX: 3 }, { pxX: 1 }];
    sortPoints(p);
    expect(p[0].pxX).toBe(3);
  });
});

describe('formatValue', () => {
  test('shows everyday magnitudes in plain decimal', () => {
    expect(formatValue(1.5)).toBe('1.5');
    expect(formatValue(1234.5)).toBe('1234.5');
  });

  test('shows extreme magnitudes in exponential form', () => {
    expect(formatValue(1e-8)).toContain('e-8');
    expect(formatValue(1e10)).toContain('e+');
  });

  test('handles zero and non-finite values', () => {
    expect(formatValue(0)).toBe('0');
    expect(formatValue(NaN)).toBe('');
  });
});

describe('digitisePoints and generateCSV', () => {
  test('digitises a batch of pixel positions', () => {
    const d = digitisePoints([{ pxX: 300, pxY: 250 }], LINEAR_CAL);
    expect(d[0].logicalX).toBeCloseTo(50, 10);
    expect(d[0].logicalY).toBeCloseTo(25, 10);
  });

  test('omits points that cannot be mapped', () => {
    expect(digitisePoints([{ pxX: 300, pxY: 250 }], { ...LINEAR_CAL, pxX2: 100 }))
      .toEqual([]);
  });

  test('emits a CSV header and one row per point', () => {
    const csv = generateCSV([
      { name: 'Series 1', points: [{ pxX: 1, logicalX: 1, logicalY: 2 }] }
    ]);
    expect(csv.split('\n')[0]).toBe('Dataset,X,Y');
    expect(csv).toContain('"Series 1",1,2');
  });

  test('escapes quotes in dataset names', () => {
    const csv = generateCSV([
      { name: 'a"b', points: [{ pxX: 1, logicalX: 1, logicalY: 2 }] }
    ]);
    expect(csv).toContain('"a""b"');
  });

  test('handles empty input', () => {
    expect(generateCSV([]).trim()).toBe('Dataset,X,Y');
    expect(generateCSV(null).trim()).toBe('Dataset,X,Y');
  });
});

describe('pythonString', () => {
  test('escapes single quotes', () => {
    expect(pythonString("Ala's data")).toBe("Ala\\'s data");
  });

  test('escapes backslashes before quotes so the literal stays valid', () => {
    expect(pythonString('C:\\runs')).toBe('C:\\\\runs');
  });

  test('flattens newlines, which are a syntax error in a quoted literal', () => {
    expect(pythonString('a\nb')).toBe('a b');
    expect(pythonString('a\r\nb')).toBe('a b');
  });

  test('handles null and undefined', () => {
    expect(pythonString(null)).toBe('');
    expect(pythonString(undefined)).toBe('');
  });
});

describe('pythonIdentifier', () => {
  test('replaces illegal characters with underscores', () => {
    expect(pythonIdentifier('Series 1')).toBe('Series_1');
    expect(pythonIdentifier('a-b.c')).toBe('a_b_c');
  });

  test('prefixes a leading digit', () => {
    expect(pythonIdentifier('1series')).toBe('ds_1series');
  });

  test('leaves a valid identifier unchanged', () => {
    expect(pythonIdentifier('valid_name')).toBe('valid_name');
  });

  test('handles empty input', () => {
    expect(pythonIdentifier('')).toBe('ds_');
  });
});

describe('validateCalibrationForm', () => {
  const good = {
    pxX1: 100, pxX2: 500, pxY1: 400, pxY2: 100,
    valX1: '0', valX2: '100', valY1: '0', valY2: '50',
    logX: false, logY: false
  };

  test('accepts a complete form and returns a numeric calibration', () => {
    const r = validateCalibrationForm(good);
    expect(r.valid).toBe(true);
    expect(r.calibration.valX2).toBe(100);
  });

  test('names the markers that have not been placed', () => {
    const r = validateCalibrationForm({ ...good, pxX1: null, pxY2: null });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('X1');
    expect(r.errors[0]).toContain('Y2');
  });

  test('reports which axis values are not numbers', () => {
    const r = validateCalibrationForm({ ...good, valX2: 'abc' });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('X2');
  });

  test('rejects a non-positive value on a logarithmic axis', () => {
    const r = validateCalibrationForm({ ...good, logX: true, valX1: '0' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('logarithmic'))).toBe(true);
  });

  test('rejects coincident pixels and identical values', () => {
    expect(validateCalibrationForm({ ...good, pxX2: 100 }).valid).toBe(false);
    expect(validateCalibrationForm({ ...good, valY2: '0' }).valid).toBe(false);
  });

  test('passes through geometry warnings', () => {
    const r = validateCalibrationForm({ ...good, pxX2: 110 });
    expect(r.valid).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test('handles missing input', () => {
    expect(validateCalibrationForm(null).valid).toBe(false);
  });
});
