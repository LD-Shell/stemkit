import { describe, test, expect } from '@jest/globals';
import {
  UNIT_DB, convert, convertTemperature, convertKT,
  listCategories, listAllCategories, isAffine,
  listUnits, getUnit, baseUnit, findCategory, formatValue
} from '../src/core/units.js';

/*
 * Reference values are CODATA 2018 / SI 2019, cross-checked against
 * scipy.constants. Comparisons use relative tolerances because the constants
 * span forty orders of magnitude.
 */

const relClose = (a, b, tol = 1e-9) => Math.abs(a - b) / Math.abs(b) < tol;

describe('database integrity', () => {
  test('every category exposes a title and units', () => {
    for (const cat of listCategories()) {
      expect(UNIT_DB[cat].title.length).toBeGreaterThan(0);
      expect(listUnits(cat).length).toBeGreaterThan(0);
    }
  });

  test('every category has exactly one base unit', () => {
    for (const cat of listCategories()) {
      const ones = listUnits(cat).filter(u => getUnit(cat, u).factor === 1);
      expect(ones).toHaveLength(1);
      expect(baseUnit(cat)).toBe(ones[0]);
    }
  });

  test('every factor is finite and positive', () => {
    for (const cat of listCategories()) {
      for (const u of listUnits(cat)) {
        const f = getUnit(cat, u).factor;
        expect(Number.isFinite(f)).toBe(true);
        expect(f).toBeGreaterThan(0);
      }
    }
  });

  test('every unit carries a name, symbol and source reference', () => {
    for (const cat of listCategories()) {
      for (const u of listUnits(cat)) {
        const d = getUnit(cat, u);
        expect(d.name.length).toBeGreaterThan(0);
        expect(d.symbol.length).toBeGreaterThan(0);
        expect(d.ref.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('energy conversions', () => {
  test('hartree to electron-volt matches CODATA', () => {
    expect(relClose(convert(1, 'energy', 'hartree', 'ev'), 27.211386245988)).toBe(true);
  });

  test('hartree is exactly two rydberg', () => {
    expect(convert(1, 'energy', 'hartree', 'rydberg')).toBeCloseTo(2, 12);
  });

  test('hartree to kJ/mol matches CODATA times Avogadro', () => {
    expect(relClose(convert(1, 'energy', 'hartree', 'kj'), 2625.4996394799)).toBe(true);
  });

  test('hartree to kcal/mol uses the thermochemical calorie', () => {
    expect(relClose(convert(1, 'energy', 'hartree', 'kcal'), 627.5094740631)).toBe(true);
  });

  test('the kJ to kcal ratio is exactly 4.184', () => {
    const kj = convert(1, 'energy', 'hartree', 'kj');
    const kcal = convert(1, 'energy', 'hartree', 'kcal');
    expect(kj / kcal).toBeCloseTo(4.184, 8);
  });

  test('hartree to wavenumber matches the CODATA relationship', () => {
    expect(relClose(convert(1, 'energy', 'hartree', 'cm'), 219474.6313632)).toBe(true);
  });

  test('an eV converts to about 96.5 kJ/mol', () => {
    expect(convert(1, 'energy', 'ev', 'kj')).toBeCloseTo(96.485, 2);
  });

  test('a joule is exactly ten million ergs', () => {
    expect(relClose(convert(1, 'energy', 'joule', 'erg'), 1e7)).toBe(true);
  });
});

describe('length conversions', () => {
  test('a nanometre is ten angstrom exactly', () => {
    expect(convert(1, 'length', 'nm', 'angstrom')).toBeCloseTo(10, 12);
  });

  test('a bohr radius is about 0.529 angstrom', () => {
    expect(convert(1, 'length', 'bohr', 'angstrom')).toBeCloseTo(0.529177, 5);
  });

  test('metric prefixes are exact', () => {
    expect(convert(1, 'length', 'nm', 'pm')).toBeCloseTo(1000, 9);
    expect(convert(1, 'length', 'm', 'nm')).toBeCloseTo(1e9, 0);
  });

  test('a PDB-scale bond length converts sensibly', () => {
    // A 1.54 A carbon-carbon single bond is 0.154 nm.
    expect(convert(1.54, 'length', 'angstrom', 'nm')).toBeCloseTo(0.154, 10);
  });
});

describe('time conversions', () => {
  test('a picosecond is a thousand femtoseconds', () => {
    expect(convert(1, 'time', 'ps', 'fs')).toBeCloseTo(1000, 9);
  });

  test('a microsecond is a million picoseconds', () => {
    expect(relClose(convert(1, 'time', 'us', 'ps'), 1e6)).toBe(true);
  });

  test('an atomic time unit is about 0.0242 femtoseconds', () => {
    expect(convert(1, 'time', 'au', 'fs')).toBeCloseTo(0.0241889, 6);
  });

  test('a typical MD timestep converts correctly', () => {
    expect(convert(2, 'time', 'fs', 'ps')).toBeCloseTo(0.002, 12);
  });
});

describe('pressure conversions', () => {
  test('a bar is a hundred kilopascal', () => {
    expect(convert(1, 'pressure', 'bar', 'kpa')).toBeCloseTo(100, 9);
  });

  test('an atmosphere is 101.325 kPa exactly', () => {
    expect(convert(1, 'pressure', 'atm', 'kpa')).toBeCloseTo(101.325, 6);
  });

  test('an atmosphere is 760 torr by definition', () => {
    expect(convert(1, 'pressure', 'atm', 'torr')).toBeCloseTo(760, 6);
  });

  test('an atmosphere is about 14.7 psi', () => {
    expect(convert(1, 'pressure', 'atm', 'psi')).toBeCloseTo(14.6959, 3);
  });
});

describe('other categories', () => {
  test('a debye converts to the atomic dipole unit', () => {
    expect(convert(1, 'dipole', 'debye', 'au_dip')).toBeCloseTo(0.393430, 5);
  });

  test('the elementary charge matches the exact 2019 coulomb value', () => {
    expect(relClose(convert(1, 'charge', 'e', 'coulomb'), 1.602176634e-19)).toBe(true);
  });

  test('force converts between GROMACS and AMBER conventions', () => {
    // 1 kJ/mol/nm is a small force in kcal/mol/A.
    expect(convert(1, 'force', 'gromacs', 'amber')).toBeCloseTo(0.02390057, 7);
  });

  test('spectroscopy and heat capacity categories convert', () => {
    expect(Number.isFinite(convert(1, 'spectroscopy', 'cm1', 'thz'))).toBe(true);
    expect(Number.isFinite(convert(1, 'heatcap', 'j_molk', 'cal_molk'))).toBe(true);
  });
});

describe('conversion algebra', () => {
  test('converting a unit to itself is the identity', () => {
    for (const cat of listCategories()) {
      for (const u of listUnits(cat)) {
        expect(convert(7.5, cat, u, u)).toBeCloseTo(7.5, 9);
      }
    }
  });

  test('every conversion round-trips', () => {
    for (const cat of listCategories()) {
      const units = listUnits(cat);
      const base = baseUnit(cat);
      for (const u of units) {
        const there = convert(1, cat, base, u);
        const back = convert(there, cat, u, base);
        expect(relClose(back, 1, 1e-9)).toBe(true);
      }
    }
  });

  test('conversion is linear in the value', () => {
    const one = convert(1, 'energy', 'hartree', 'kj');
    const five = convert(5, 'energy', 'hartree', 'kj');
    expect(five).toBeCloseTo(one * 5, 8);
  });

  test('conversion is transitive through an intermediate unit', () => {
    const direct = convert(1, 'energy', 'ev', 'kcal');
    const viaHartree = convert(convert(1, 'energy', 'ev', 'hartree'), 'energy', 'hartree', 'kcal');
    expect(relClose(direct, viaHartree, 1e-12)).toBe(true);
  });

  test('zero maps to zero in multiplicative categories', () => {
    expect(convert(0, 'length', 'nm', 'angstrom')).toBe(0);
  });

  test('negative values are preserved', () => {
    expect(convert(-5, 'energy', 'hartree', 'ev')).toBeLessThan(0);
  });
});

describe('temperature', () => {
  test('the freezing point of water converts across all scales', () => {
    expect(convertTemperature(0, 'c', 'k')).toBeCloseTo(273.15, 10);
    expect(convertTemperature(0, 'c', 'f')).toBeCloseTo(32, 10);
  });

  test('the boiling point of water converts across all scales', () => {
    expect(convertTemperature(100, 'c', 'f')).toBeCloseTo(212, 10);
    expect(convertTemperature(212, 'f', 'c')).toBeCloseTo(100, 10);
  });

  test('absolute zero is consistent', () => {
    expect(convertTemperature(0, 'k', 'c')).toBeCloseTo(-273.15, 10);
    expect(convertTemperature(-273.15, 'c', 'k')).toBeCloseTo(0, 10);
  });

  test('the scales cross at minus forty', () => {
    expect(convertTemperature(-40, 'c', 'f')).toBeCloseTo(-40, 10);
  });

  test('room temperature converts to the usual simulation value', () => {
    expect(convertTemperature(25, 'c', 'k')).toBeCloseTo(298.15, 10);
  });

  test('temperature conversions round-trip', () => {
    for (const from of ['k', 'c', 'f']) {
      for (const to of ['k', 'c', 'f']) {
        const there = convertTemperature(300, from, to);
        const back = convertTemperature(there, to, from);
        expect(back).toBeCloseTo(300, 8);
      }
    }
  });

  test('routes through convert when the category is temperature', () => {
    expect(convert(0, 'temperature', 'c', 'k')).toBeCloseTo(273.15, 10);
  });

  test('an unknown scale yields NaN', () => {
    expect(Number.isNaN(convertTemperature(0, 'x', 'k'))).toBe(true);
  });
});

describe('convertKT', () => {
  test('kT at 300 K is about 2.494 kJ/mol', () => {
    expect(convertKT(1, 300, 'kj')).toBeCloseTo(2.4943, 3);
  });

  test('kT at 300 K is about 0.596 kcal/mol', () => {
    expect(convertKT(1, 300, 'kcal')).toBeCloseTo(0.5961, 3);
  });

  test('kT at 300 K is about 25.85 meV per particle', () => {
    expect(convertKT(1, 300, 'mev')).toBeCloseTo(25.85, 1);
  });

  test('is linear in both kT and temperature', () => {
    expect(convertKT(2, 300, 'kj')).toBeCloseTo(convertKT(1, 300, 'kj') * 2, 8);
    expect(convertKT(1, 600, 'kj')).toBeCloseTo(convertKT(1, 300, 'kj') * 2, 8);
  });

  test('rejects an unknown target unit', () => {
    expect(Number.isNaN(convertKT(1, 300, 'furlongs'))).toBe(true);
  });
});

describe('lookup helpers', () => {
  test('getUnit returns metadata or null', () => {
    expect(getUnit('energy', 'hartree').symbol).toBe('Eh');
    expect(getUnit('energy', 'nonesuch')).toBeNull();
    expect(getUnit('nonesuch', 'hartree')).toBeNull();
  });

  test('findCategory locates a unique unit key', () => {
    expect(findCategory('hartree')).toBe('energy');
    expect(findCategory('bohr')).toBe('length');
    expect(findCategory('nonesuch')).toBeNull();
  });

  test('listUnits is empty for an unknown category', () => {
    expect(listUnits('nonesuch')).toEqual([]);
    expect(baseUnit('nonesuch')).toBeNull();
  });
});

describe('error handling', () => {
  test('an unknown category or unit yields NaN', () => {
    expect(Number.isNaN(convert(1, 'nonesuch', 'a', 'b'))).toBe(true);
    expect(Number.isNaN(convert(1, 'energy', 'nonesuch', 'ev'))).toBe(true);
    expect(Number.isNaN(convert(1, 'energy', 'hartree', 'nonesuch'))).toBe(true);
  });

  test('a non-finite value yields NaN', () => {
    expect(Number.isNaN(convert(NaN, 'energy', 'hartree', 'ev'))).toBe(true);
    expect(Number.isNaN(convert(Infinity, 'energy', 'hartree', 'ev'))).toBe(true);
  });
});

describe('formatValue', () => {
  test('shows moderate magnitudes in fixed point', () => {
    expect(formatValue(27.211386245988)).toBe('27.2114');
    expect(formatValue(1.5)).toBe('1.5');
  });

  test('shows extreme magnitudes in exponential form', () => {
    expect(formatValue(4.3597e-18)).toContain('e-18');
    expect(formatValue(1e9)).toContain('e+');
  });

  test('handles zero and non-finite input', () => {
    expect(formatValue(0)).toBe('0');
    expect(formatValue(NaN)).toBe('n/a');
  });

  test('respects the requested significant figures', () => {
    expect(formatValue(1.23456789, 3)).toBe('1.23');
  });
});

/*
 * Regression coverage for two paths a factor-table refactor can silently break:
 * reciprocal units, and the affine temperature category.
 *
 * Both were wrong at one point while the rest of this suite stayed green.
 * Wavelength conversions returned a plausible but incorrect number (a 532 nm
 * line came back as 0.0000532 cm^-1 instead of 18797), and the kBT scales
 * returned NaN. These tests pin the behaviour that was missing.
 */

describe('reciprocal (inverse) units', () => {
  test('wavenumber and wavelength are inversely proportional', () => {
    expect(relClose(convert(1000, 'spectroscopy', 'cm1', 'wl_nm'), 1e4)).toBe(true);
    expect(relClose(convert(1e4, 'spectroscopy', 'wl_nm', 'cm1'), 1000)).toBe(true);
  });

  test('halving the wavenumber doubles the wavelength', () => {
    const a = convert(2000, 'spectroscopy', 'cm1', 'wl_nm');
    const b = convert(1000, 'spectroscopy', 'cm1', 'wl_nm');
    expect(relClose(b, a * 2)).toBe(true);
  });

  test('an inverse unit round-trips through every other unit', () => {
    for (const u of listUnits('spectroscopy')) {
      const there = convert(532, 'spectroscopy', 'wl_nm', u);
      const back = convert(there, 'spectroscopy', u, 'wl_nm');
      expect(relClose(back, 532)).toBe(true);
    }
  });

  test('a 532 nm laser line is about 18797 cm^-1', () => {
    expect(convert(532, 'spectroscopy', 'wl_nm', 'cm1')).toBeCloseTo(18796.99, 1);
  });

  test('wavelength maps to frequency through the speed of light', () => {
    expect(relClose(convert(1000, 'spectroscopy', 'wl_nm', 'thz'), 299.792458)).toBe(true);
  });

  test('conversion is not linear for reciprocal units', () => {
    const one = convert(1, 'spectroscopy', 'cm1', 'wl_nm');
    const five = convert(5, 'spectroscopy', 'cm1', 'wl_nm');
    expect(relClose(five, one / 5)).toBe(true);
  });
});

describe('temperature is affine, not multiplicative', () => {
  test('is flagged affine and kept out of the factor-table listing', () => {
    expect(isAffine('temperature')).toBe(true);
    expect(isAffine('energy')).toBe(false);
    expect(listCategories()).not.toContain('temperature');
    expect(listAllCategories()).toContain('temperature');
  });

  test('convert() delegates the affine category correctly', () => {
    expect(convert(100, 'temperature', 'c', 'f')).toBeCloseTo(212, 10);
    expect(convert(0, 'temperature', 'c', 'k')).toBeCloseTo(273.15, 10);
  });

  test('kBT energy equivalents at 300 K', () => {
    const R = 8.314462618;
    expect(relClose(convert(300, 'temperature', 'k', 'kt_kj'), 300 * R / 1000)).toBe(true);
    expect(relClose(convert(300, 'temperature', 'k', 'kt_kcal'), 300 * R / 4184)).toBe(true);
    expect(convert(300, 'temperature', 'k', 'kt_mev')).toBeCloseTo(25.852, 3);
  });

  test('kBT scales round-trip back to kelvin', () => {
    for (const u of ['kt_kj', 'kt_kcal', 'kt_mev']) {
      const there = convert(300, 'temperature', 'k', u);
      expect(relClose(convert(there, 'temperature', u, 'k'), 300)).toBe(true);
    }
  });

  test('kBT agrees with the standalone convertKT helper', () => {
    expect(relClose(convertKT(1, 300, 'kj'), convert(300, 'temperature', 'k', 'kt_kj'))).toBe(true);
    expect(relClose(convertKT(1, 300, 'kcal'), convert(300, 'temperature', 'k', 'kt_kcal'))).toBe(true);
    expect(relClose(convertKT(1, 300, 'mev'), convert(300, 'temperature', 'k', 'kt_mev'), 1e-8)).toBe(true);
  });

  test('kBT is proportional to absolute temperature', () => {
    const at300 = convert(300, 'temperature', 'k', 'kt_kj');
    const at600 = convert(600, 'temperature', 'k', 'kt_kj');
    expect(relClose(at600, at300 * 2)).toBe(true);
  });

  test('unknown temperature scales yield NaN', () => {
    expect(Number.isNaN(convert(300, 'temperature', 'k', 'nonesuch'))).toBe(true);
    expect(Number.isNaN(convertTemperature(300, 'nonesuch', 'k'))).toBe(true);
  });
});

describe('presentation metadata', () => {
  test('every category carries an icon and colour for the UI', () => {
    for (const cat of listAllCategories()) {
      expect(UNIT_DB[cat].icon.length).toBeGreaterThan(0);
      expect(UNIT_DB[cat].color.length).toBeGreaterThan(0);
    }
  });

  test('every unit carries explanatory text', () => {
    for (const cat of listAllCategories()) {
      for (const u of listUnits(cat)) {
        expect(getUnit(cat, u).desc.length).toBeGreaterThan(0);
      }
    }
  });

  test('plain symbols stay free of markup', () => {
    for (const cat of listAllCategories()) {
      for (const u of listUnits(cat)) {
        expect(getUnit(cat, u).symbol).not.toMatch(/<[a-z]/i);
      }
    }
  });

  test('markup lives in the separate html fields', () => {
    expect(getUnit('energy', 'hartree').symbol).toBe('Eh');
    expect(getUnit('energy', 'hartree').symbolHtml).toBe('E<sub>h</sub>');
  });
});
