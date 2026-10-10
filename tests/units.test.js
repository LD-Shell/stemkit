import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  UNIT_DB, CONSTANTS, convert, convertTemperature, convertKT,
  listCategories, listAllCategories, isAffine,
  listUnits, getUnit, baseUnit, findCategory, formatValue
} from '../src/core/units.js';

/*
 * Reference values are CODATA 2018 / SI 2019, cross-checked against
 * scipy.constants: REFERENCE below is what scipy 1.11.4 prints (it reports
 * "CODATA 2018"), and where Python with that data set is installed the table
 * is printed again and compared. Comparisons use relative tolerances because
 * the constants span forty orders of magnitude.
 */

const relClose = (a, b, tol = 1e-9) => Math.abs(a - b) / Math.abs(b) < tol;

/*
 * Every factor, from scipy.constants and nothing else. Where CODATA publishes
 * the quantity itself (the hartree in eV, in inverse metres and in kelvin, the
 * atomic units of time, force, dipole moment and polarizability) that
 * published value is used, so the comparison is with an independent number
 * and not with the same arithmetic done twice. The volume polarizability goes
 * through the vacuum permittivity, alpha / (4 pi eps0), not through a0^3.
 */
const SCIPY_FACTORS = String.raw`
import json, math
import scipy
import scipy.constants as C
from scipy.constants import physical_constants as P

def pc(name):
    return P[name][0]

a0, Eh = pc('Bohr radius'), pc('Hartree energy')
kjmolnm = C.kilo / C.N_A / C.nano          # one kJ/mol/nm, in N
debye = 1e-21 / C.c                         # one debye, in C m
wavenumber = C.h * C.c / C.centi            # h c (1 cm^-1), in J
R = C.N_A * C.k                             # exact; scipy's own R is cut at ten digits

factors = {
    'energy': {
        'hartree': 1.0,
        'rydberg': Eh / pc('Rydberg constant times hc in J'),
        'ev': pc('Hartree energy in eV'),
        'kcal': Eh * C.N_A / (C.kilo * C.calorie),
        'kj': Eh * C.N_A / C.kilo,
        'cm': pc('hartree-inverse meter relationship') * C.centi,
        'kelvin': pc('hartree-kelvin relationship'),
        'cal': Eh * C.N_A / C.calorie,
        'joule': Eh,
        'erg': Eh / C.erg,
    },
    'length': {
        'nm': 1.0, 'angstrom': C.nano / C.angstrom, 'bohr': C.nano / a0, 'pm': C.nano / C.pico,
        'um': C.nano / C.micro, 'fm': C.nano / C.femto, 'cm': C.nano / C.centi, 'm': C.nano,
    },
    'time': {
        'ps': 1.0, 'ns': C.pico / C.nano, 'fs': C.pico / C.femto, 'au': C.pico / pc('atomic unit of time'),
        'us': C.pico / C.micro, 'ms': C.pico / C.milli, 's': C.pico,
    },
    'force': {
        'gromacs': 1.0,
        'amber': kjmolnm / (C.kilo * C.calorie / C.N_A / C.angstrom),
        'ev_ang': kjmolnm / (C.eV / C.angstrom),
        'hartree_bohr': kjmolnm / pc('atomic unit of force'),
        'pn': kjmolnm / C.pico,
        'newton': kjmolnm,
    },
    'pressure': {
        'bar': 1.0, 'atm': C.bar / C.atm, 'pa': C.bar, 'kpa': C.bar / C.kilo, 'mpa': C.bar / C.mega,
        'gpa': C.bar / C.giga, 'torr': C.bar / C.torr, 'psi': C.bar / C.psi, 'kbar': 1 / C.kilo,
        'au_p': C.bar / (Eh / a0 ** 3),
    },
    'dipole': {
        'debye': 1.0,
        'au_dip': debye / pc('atomic unit of electric dipole mom.'),
        'e_ang': debye / (C.e * C.angstrom),
        'e_nm': debye / (C.e * C.nano),
        'cm_dip': debye,
    },
    'charge': {'e': 1.0, 'coulomb': C.e, 'statc': C.e * C.c * 10},
    'polarizability': {
        'au_pol': 1.0,
        'ang3': pc('atomic unit of electric polarizability') / (4 * math.pi * C.epsilon_0) / C.angstrom ** 3,
        'si_pol': pc('atomic unit of electric polarizability'),
    },
    'spectroscopy': {
        'cm1': 1.0, 'thz': C.c / C.centi / C.tera, 'ghz': C.c / C.centi / C.giga,
        'mev': wavenumber / C.eV / C.milli, 'ev_s': wavenumber / C.eV, 'zj': wavenumber / C.zepto,
        'wl_nm': C.centi / C.nano,
    },
    'heatcap': {
        'j_molk': 1.0, 'cal_molk': 1 / C.calorie, 'kj_molk': 1 / C.kilo, 'r_units': 1 / R, 'kb_units': 1 / R,
    },
}

print(json.dumps({
    'scipy': scipy.__version__,
    'codata': getattr(getattr(C, '_codata', None), '_current_codata', None),
    'constants': {
        'speedOfLight': C.c, 'planck': C.h, 'elementaryCharge': C.e, 'boltzmann': C.k, 'avogadro': C.N_A,
        'bohrRadius': a0, 'hartree': Eh, 'gasConstant': R,
    },
    'factors': factors,
    'kT300': {'kt_kj': R * 300 / C.kilo, 'kt_kcal': R * 300 / (C.kilo * C.calorie), 'kt_mev': C.k * 300 / C.eV / C.milli},
}))
`;

/* What that script prints with scipy 1.11.4 (CODATA 2018). */
const REFERENCE = {
  energy: {
    hartree: 1.0, rydberg: 2.0000000000000457, ev: 27.211386245988, kcal: 627.5094740630558,
    kj: 2625.4996394798254, cm: 219474.6313632, kelvin: 315775.02480407, cal: 627509.4740630557,
    joule: 4.3597447222071e-18, erg: 4.3597447222071004e-11
  },
  length: {
    nm: 1.0, angstrom: 10.0, bohr: 18.897261246257703, pm: 1000.0000000000001, um: 0.001,
    fm: 1000000.0, cm: 1.0000000000000001e-07, m: 1e-09
  },
  time: {
    ps: 1.0, ns: 0.001, fs: 999.9999999999999, au: 41341.373335182114, us: 1e-06, ms: 1e-09,
    s: 1e-12
  },
  force: {
    gromacs: 1.0, amber: 0.02390057361376673, ev_ang: 0.0010364269656262175,
    hartree_bohr: 2.0155295508053966e-05, pn: 1.6605390671738465, newton: 1.6605390671738465e-12
  },
  pressure: {
    bar: 1.0, atm: 0.9869232667160128, pa: 100000.0, kpa: 100.0, mpa: 0.1, gpa: 0.0001,
    torr: 750.0616827041698, psi: 14.503773773020923, kbar: 0.001, au_p: 3.3989309217431656e-09
  },
  dipole: {
    debye: 1.0, au_dip: 0.39343026952179116, e_ang: 0.20819433270935594,
    e_nm: 0.020819433270935595, cm_dip: 3.33564095198152e-30
  },
  charge: {
    e: 1.0, coulomb: 1.602176634e-19, statc: 4.803204712570263e-10
  },
  polarizability: {
    au_pol: 1.0, ang3: 0.14818471147213705, si_pol: 1.64877727436e-41
  },
  spectroscopy: {
    cm1: 1.0, thz: 0.0299792458, ghz: 29.9792458, mev: 0.12398419843320026,
    ev_s: 0.00012398419843320026, zj: 0.019864458571489288, wl_nm: 10000000.0
  },
  heatcap: {
    j_molk: 1.0, cal_molk: 0.2390057361376673, kj_molk: 0.001, r_units: 0.12027235504272604,
    kb_units: 0.12027235504272604
  }
};

/*
 * The entries scipy takes from a figure CODATA publishes, rounded to eleven to
 * fourteen digits. The module computes them from a0 and E_h, so the two may
 * differ in the last published digit: 1e-11 covers that (the largest
 * difference is 5.6e-12, the atomic unit of force). Every other entry is the
 * same exact arithmetic in two languages and must agree to rounding.
 */
const PUBLISHED = new Set([
  'energy.rydberg', 'energy.ev', 'energy.cm', 'energy.kelvin', 'time.au', 'force.hartree_bohr',
  'dipole.au_dip', 'polarizability.ang3', 'polarizability.si_pol'
]);
const tolerance = (cat, unit) => (PUBLISHED.has(`${cat}.${unit}`) ? 1e-11 : 1e-14);

// scipy.constants holds one CODATA adjustment at a time. This page cites 2018,
// so a scipy that has moved on (its Bohr radius is no longer the 2018 one)
// skips the comparison instead of failing it.
const SCIPY = (() => {
  try {
    const run = spawnSync('python3', ['-s', '-c', SCIPY_FACTORS], { encoding: 'utf8', timeout: 60000 });
    return run.status === 0 ? JSON.parse(run.stdout) : null;
  } catch {
    return null;
  }
})();
const withPython = SCIPY && SCIPY.constants.bohrRadius === 5.29177210903e-11 ? test : test.skip;

describe('constants', () => {
  test('the five defining constants are the SI 2019 values', () => {
    // BIPM, SI Brochure, 9th edition (2019), section 2.2.
    expect(CONSTANTS.speedOfLight).toBe(299792458);
    expect(CONSTANTS.planck).toBe(6.62607015e-34);
    expect(CONSTANTS.elementaryCharge).toBe(1.602176634e-19);
    expect(CONSTANTS.boltzmann).toBe(1.380649e-23);
    expect(CONSTANTS.avogadro).toBe(6.02214076e23);
  });

  test('the Bohr radius and the Hartree energy are the CODATA 2018 values', () => {
    // Tiesinga et al., Rev. Mod. Phys. 93, 025010 (2021): 5.291 772 109 03(80)e-11 m
    // and 4.359 744 722 2071(85)e-18 J. The 1986 radius, 0.529177249 A, was
    // behind the old length table.
    expect(CONSTANTS.bohrRadius).toBe(5.29177210903e-11);
    expect(CONSTANTS.hartree).toBe(4.3597447222071e-18);
    expect(convert(1, 'length', 'bohr', 'm')).toBe(5.29177210903e-11);
    expect(convert(1, 'energy', 'hartree', 'joule')).toBe(4.3597447222071e-18);
  });

  test('the gas constant is N_A k_B in full, not cut at ten digits', () => {
    expect(CONSTANTS.gasConstant).toBe(8.31446261815324);
    expect(convert(1, 'heatcap', 'r_units', 'j_molk')).toBe(8.31446261815324);
    expect(convert(1, 'heatcap', 'kb_units', 'j_molk')).toBe(8.31446261815324);
  });

  test('every factor matches scipy.constants, as recorded', () => {
    expect(Object.keys(REFERENCE)).toEqual(listCategories());
    for (const cat of listCategories()) {
      expect(Object.keys(REFERENCE[cat])).toEqual(listUnits(cat));
      for (const u of listUnits(cat)) {
        const got = getUnit(cat, u).factor;
        const want = REFERENCE[cat][u];
        if (!relClose(got, want, tolerance(cat, u))) throw new Error(`${cat}.${u}: ${got}, scipy has ${want}`);
      }
    }
  });

  test('the atomic units are the values CODATA 2018 publishes', () => {
    // NIST, Fundamental Physical Constants (2018 adjustment): atomic units of
    // time, force, electric dipole moment and electric polarizability, and
    // E_h / a0^3 as this page quotes it.
    expect(relClose(convert(1, 'time', 'au', 's'), 2.4188843265857e-17, 1e-12)).toBe(true);
    expect(relClose(convert(1, 'force', 'hartree_bohr', 'newton'), 8.2387234983e-8, 1e-11)).toBe(true);
    expect(relClose(convert(1, 'pressure', 'au_p', 'pa'), 2.9421015697e13, 1e-10)).toBe(true);
    expect(relClose(convert(1, 'dipole', 'au_dip', 'cm_dip'), 8.4783536255e-30, 1e-11)).toBe(true);
    expect(relClose(convert(1, 'polarizability', 'au_pol', 'si_pol'), 1.64877727436e-41, 1e-11)).toBe(true);
  });

  test('the same bohr and hartree are in every table', () => {
    // The length table once held the 1986 Bohr radius while the force table
    // held the 2018 one, and the atomic pressure was a third number. Each
    // atomic unit is rebuilt here from the energy and length tables.
    const F = (cat, u) => UNIT_DB[cat].units[u].factor;
    const bohrPerNm = F('length', 'bohr');
    const hartreePerKj = 1 / F('energy', 'kj');
    const barPerKjNm3 = 1e27 / (CONSTANTS.avogadro * 1e2); // 1 kJ/mol/nm^3, in bar
    expect(relClose(F('force', 'hartree_bohr'), hartreePerKj / bohrPerNm, 1e-14)).toBe(true);
    expect(relClose(F('pressure', 'au_p'), hartreePerKj / bohrPerNm ** 3 / barPerKjNm3, 1e-14)).toBe(true);
    expect(relClose(F('dipole', 'au_dip'), F('dipole', 'e_nm') * bohrPerNm, 1e-14)).toBe(true);
    expect(relClose(F('polarizability', 'ang3'), (F('length', 'angstrom') / bohrPerNm) ** 3, 1e-14)).toBe(true);
  });

  withPython('scipy.constants is CODATA 2018 and holds the same constants', () => {
    expect(SCIPY.codata).toBe('CODATA 2018');
    for (const [name, value] of Object.entries(SCIPY.constants)) expect(CONSTANTS[name]).toBe(value);
  });

  withPython('every factor matches scipy.constants, computed now', () => {
    for (const cat of listCategories()) {
      for (const u of listUnits(cat)) {
        const got = getUnit(cat, u).factor;
        const want = SCIPY.factors[cat][u];
        if (!relClose(got, want, tolerance(cat, u))) throw new Error(`${cat}.${u}: ${got}, scipy has ${want}`);
        // And the table recorded above is what scipy still prints.
        expect(relClose(REFERENCE[cat][u], want, 1e-15)).toBe(true);
      }
    }
  });

  withPython('thermal energies match scipy.constants', () => {
    for (const [u, want] of Object.entries(SCIPY.kT300)) {
      expect(relClose(convert(300, 'temperature', 'k', u), want, 1e-14)).toBe(true);
    }
  });
});

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
    // A factor such as 1e-9 is not a double; 1 m used to be 999999999.9999999 nm.
    expect(convert(1, 'length', 'nm', 'pm')).toBe(1000);
    expect(convert(1, 'length', 'm', 'nm')).toBe(1e9);
    expect(convert(1, 'length', 'm', 'cm')).toBe(100);
    expect(convert(1, 'time', 's', 'ms')).toBe(1000);
    expect(convert(1, 'time', 's', 'ps')).toBe(1e12);
    expect(convert(1, 'pressure', 'gpa', 'mpa')).toBe(1000);
    expect(convert(2.5, 'heatcap', 'kj_molk', 'j_molk')).toBe(2500);
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

  test('every force unit is its energy unit over its length unit', () => {
    // The force factors once disagreed with the energy and length tables
    // (eV/A off by 10, Eh/a0 by 25), so each is derived here from the other
    // two categories: an energy unit per length unit, in kJ/mol per nm.
    const E = (u) => UNIT_DB.energy.units[u].factor / UNIT_DB.energy.units.kj.factor;
    const L = (u) => UNIT_DB.length.units[u].factor / UNIT_DB.length.units.nm.factor;
    const derived = {
      amber: E('kcal') / L('angstrom'),
      ev_ang: E('ev') / L('angstrom'),
      hartree_bohr: E('hartree') / L('bohr')
    };
    for (const [unit, factor] of Object.entries(derived)) {
      expect(relClose(UNIT_DB.force.units[unit].factor, factor, 1e-14)).toBe(true);
    }
    // The values people compare: DFT forces against GROMACS, and the atomic
    // unit of force in newtons (CODATA 2018: 8.2387234983e-8 N).
    expect(relClose(convert(1, 'force', 'ev_ang', 'gromacs'), 964.8533212331, 1e-9)).toBe(true);
    expect(relClose(convert(1, 'force', 'hartree_bohr', 'newton'), 8.2387234983e-8, 1e-9)).toBe(true);
  });

  test('spectroscopy and heat capacity categories convert', () => {
    expect(Number.isFinite(convert(1, 'spectroscopy', 'cm1', 'thz'))).toBe(true);
    expect(Number.isFinite(convert(1, 'heatcap', 'j_molk', 'cal_molk'))).toBe(true);
  });
});

describe('conversion algebra', () => {
  // Awkward and ordinary values alike, across thirty orders of magnitude.
  const SAMPLES = [7.5, 0.1, 1 / 3, 2.5e-7, 123456.789, 6.02214076e23, 1.380649e-23, -4.184, 298.15];

  test('converting a unit to itself gives the value back exactly', () => {
    // Through the base, 8 of the 64 units returned a neighbouring double
    // (7.5 kJ/mol came back as 7.499999999999999).
    for (const cat of listAllCategories()) {
      for (const u of listUnits(cat)) {
        for (const v of SAMPLES) expect(convert(v, cat, u, u)).toBe(v);
      }
    }
  });

  test('every conversion round-trips to within one unit in the last place', () => {
    // A double times a ratio is not one-to-one, so there and back cannot
    // always be exact; with one rounding each way it is never further than
    // the neighbouring double (2^-52 of the value).
    const EPS = 2 ** -52;
    for (const cat of listCategories()) {
      const units = listUnits(cat);
      for (const a of units) {
        for (const b of units) {
          for (const v of SAMPLES) {
            const back = convert(convert(v, cat, a, b), cat, b, a);
            if (Math.abs(back - v) > EPS * Math.abs(v)) throw new Error(`${v} ${cat}.${a} via ${b} came back as ${back}`);
          }
        }
      }
    }
  });

  test('ratios that are exact by definition come out exact', () => {
    // Each once carried the rounding of both factors: 1 J was
    // 9999999.999999998 erg and 1 kcal/mol was 4.183999999999824 kJ/mol.
    expect(convert(1, 'energy', 'kcal', 'kj')).toBe(4.184);
    expect(convert(4.184, 'energy', 'kj', 'kcal')).toBe(1);
    expect(convert(1, 'energy', 'joule', 'erg')).toBe(1e7);
    expect(convert(1, 'pressure', 'atm', 'pa')).toBe(101325);
    expect(convert(1, 'pressure', 'atm', 'torr')).toBe(760);
    expect(convert(1, 'force', 'amber', 'gromacs')).toBe(41.84);
    expect(convert(3, 'energy', 'rydberg', 'hartree')).toBe(1.5);
  });

  test('a conversion with no finite answer is NaN', () => {
    expect(Number.isNaN(convert(0, 'spectroscopy', 'wl_nm', 'cm1'))).toBe(true);
    expect(Number.isNaN(convert(0, 'spectroscopy', 'cm1', 'wl_nm'))).toBe(true);
    expect(Number.isNaN(convert(1e305, 'length', 'nm', 'fm'))).toBe(true);
  });

  test('values far outside the everyday range still convert', () => {
    expect(relClose(convert(1e200, 'length', 'nm', 'fm'), 1e206, 1e-15)).toBe(true);
    expect(relClose(convert(1e-200, 'length', 'nm', 'angstrom'), 1e-199, 1e-15)).toBe(true);
    expect(convert(1e-320, 'length', 'nm', 'angstrom')).toBe(1e-319);
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

  test('a temperature in its own scale comes back exactly', () => {
    // Through kelvin, 0.1 degC came back as 0.10000000000002274.
    for (const u of listUnits('temperature')) {
      for (const v of [0.1, 7.5, 36.6, -40, 298.15]) expect(convertTemperature(v, u, u)).toBe(v);
    }
  });

  test('Celsius and Fahrenheit convert without a detour through kelvin', () => {
    // Body temperature was 98.60000000000001 degF, and 0 degF was
    // -17.77777777777777 degC.
    expect(convertTemperature(37, 'c', 'f')).toBe(98.6);
    expect(convertTemperature(98.6, 'f', 'c')).toBe(37);
    expect(convertTemperature(100, 'c', 'f')).toBe(212);
    expect(convertTemperature(0, 'f', 'c')).toBe(-160 / 9);
    // Every fifth degree Celsius is a whole degree Fahrenheit, and back.
    for (let c = -100; c <= 200; c += 5) {
      expect(convertTemperature(c, 'c', 'f')).toBe(c * 9 / 5 + 32);
      expect(convertTemperature(c * 9 / 5 + 32, 'f', 'c')).toBe(c);
    }
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
    // R = N_A k_B = 8.31446261815324 J/(mol K), and k_B / e in meV/K.
    const R = 8.31446261815324;
    expect(relClose(convert(300, 'temperature', 'k', 'kt_kj'), 300 * R / 1000, 1e-15)).toBe(true);
    expect(relClose(convert(300, 'temperature', 'k', 'kt_kcal'), 300 * R / 4184, 1e-15)).toBe(true);
    expect(relClose(convert(300, 'temperature', 'k', 'kt_mev'), 300 * 1.380649e-23 / 1.602176634e-22, 1e-15)).toBe(true);
  });

  test('kBT scales round-trip back to kelvin', () => {
    for (const u of ['kt_kj', 'kt_kcal', 'kt_mev']) {
      const there = convert(300, 'temperature', 'k', u);
      expect(relClose(convert(there, 'temperature', u, 'k'), 300)).toBe(true);
    }
  });

  test('kBT agrees exactly with the standalone convertKT helper', () => {
    // The helper had its own R, cut at ten digits, so the meV values differed
    // by 1.8e-11 (25.851999785959073 against 25.851999786435535 at 300 K).
    for (const T of [77, 273.15, 300, 1000]) {
      expect(convertKT(1, T, 'kj')).toBe(convert(T, 'temperature', 'k', 'kt_kj'));
      expect(convertKT(1, T, 'kcal')).toBe(convert(T, 'temperature', 'k', 'kt_kcal'));
      expect(convertKT(1, T, 'mev')).toBe(convert(T, 'temperature', 'k', 'kt_mev'));
    }
    expect(convertKT(1, 300, 'mev')).toBe(25.851999786435535);
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
