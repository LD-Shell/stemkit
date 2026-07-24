/**
 * @module core/units
 *
 * Unit conversion for computational chemistry and molecular dynamics,
 * extracted from STEMKit's Scientific Converter.
 *
 * Each category defines a base unit with factor 1.0; every other unit records
 * how many of itself make up one base unit. Conversion therefore reduces to
 *
 *   result = value * (factor[to] / factor[from])
 *
 * Working through a single base rather than storing pairwise factors keeps the
 * table O(n) instead of O(n^2) and makes every entry independently checkable
 * against its cited source.
 *
 * Conversion factors are CODATA 2018 / SI 2019 values, verified against
 * `scipy.constants`. Where a factor is exact by definition (metric prefixes,
 * the thermochemical calorie of 4.184 J, the 2019 elementary charge) the `ref`
 * field says so.
 *
 * Temperature is handled separately: Celsius and Fahrenheit are affine, not
 * multiplicative, so a single factor cannot express them.
 */

/**
 * Unit database. Keys are category identifiers; each category names its units
 * with a conversion factor relative to that category's base unit.
 */
export const UNIT_DB = Object.freeze({
  energy: {
    title: "Energy & Thermodynamics",
    icon: "fa-bolt",
    color: "orange",
    note: "Base unit: Hartree (E<sub>h</sub>). Molar factors (kcal/mol, kJ/mol) multiply the per-particle energy by the Avogadro constant N<sub>A</sub> = 6.02214076&times;10<sup>23</sup> mol<sup>-1</sup> (exact, SI 2019).",
    units: {
      hartree: { name: "Hartree", symbol: "Eh", symbolHtml: "E<sub>h</sub>", factor: 1.0, desc: "Atomic unit of energy. Standard for quantum chemistry (Gaussian, ORCA). E<sub>h</sub> = 4.3597447222071&times;10<sup>-18</sup> J.", ref: "CODATA 2018: Hartree energy" },
      rydberg: { name: "Rydberg", symbol: "Ry", factor: 2.0, desc: "1 E<sub>h</sub> = 2 Ry exactly. The Rydberg energy (13.605693 eV) is the ionization energy of hydrogen in the infinite-mass limit.", ref: "CODATA 2018: E_h = 2 R_inf hc (exact ratio)" },
      ev: { name: "Electron-volt", symbol: "eV", factor: 27.211386245988, desc: "Common in solid-state physics and band-gap calculations. 1 eV = 1.602176634&times;10<sup>-19</sup> J (exact, SI 2019).", ref: "CODATA 2018: Hartree energy in eV" },
      kcal: { name: "kcal / mol", symbol: "kcal/mol", factor: 627.5094740631, desc: "Standard for organic chemistry and AMBER/CHARMM force fields. Uses the thermochemical calorie (1 cal = 4.184 J exactly).", ref: "CODATA 2018 + thermochemical calorie (4.184 J)" },
      kj: { name: "kJ / mol", symbol: "kJ/mol", factor: 2625.4996394799, desc: "SI derived molar unit. Required for GROMACS topologies and OPLS parameters.", ref: "CODATA 2018 x N_A (SI 2019)" },
      cm: { name: "Inverse cm", symbol: "cm-1", symbolHtml: "cm<sup>-1</sup>", factor: 219474.6313632, desc: "Spectroscopic wavenumber. E = hc*nu; 1 E<sub>h</sub> = 219474.63 cm<sup>-1</sup>.", ref: "CODATA 2018: hartree-inverse-metre relationship" },
      kelvin: { name: "Kelvin eq.", symbol: "K", factor: 315775.024804, desc: "Thermal-energy equivalent E / k<sub>B</sub>, with k<sub>B</sub> = 1.380649&times;10<sup>-23</sup> J/K (exact, SI 2019).", ref: "CODATA 2018: hartree-kelvin relationship" },
      cal: { name: "cal / mol", symbol: "cal/mol", factor: 627509.4740631, desc: "Per-mole thermochemical calorie. 1 cal = 4.184 J exactly.", ref: "Thermochemical calorie (4.184 J) + CODATA 2018" },
      joule: { name: "Joule", symbol: "J", factor: 4.3597447222071e-18, desc: "Macroscopic SI unit of energy (per particle, not per mole).", ref: "CODATA 2018: Hartree energy in J" },
      erg: { name: "Erg", symbol: "erg", factor: 4.3597447222071e-11, desc: "CGS unit of energy. 1 erg = 10<sup>-7</sup> J exactly.", ref: "CGS definition + CODATA 2018" }
    }
  },
  length: {
    title: "Distance & Length",
    icon: "fa-ruler",
    color: "blue",
    note: "Base unit: nanometer (nm), the GROMACS length unit. The bohr radius a<sub>0</sub> = 5.29177210903&times;10<sup>-11</sup> m is the atomic unit of length.",
    units: {
      nm: { name: "Nanometer", symbol: "nm", factor: 1.0, desc: "Standard distance unit in GROMACS (.gro coordinates, box vectors).", ref: "SI 2019 (exact metric prefix)" },
      angstrom: { name: "Angstrom", symbol: "Å", symbolHtml: "&Aring;", factor: 10.0, desc: "PDB files and AMBER/CHARMM coordinates. 1 A = 10<sup>-10</sup> m exactly.", ref: "Defined: 1 A = 0.1 nm (exact)" },
      bohr: { name: "Bohr radius", symbol: "a0", symbolHtml: "a<sub>0</sub>", factor: 18.897259886, desc: "Atomic unit of length. a<sub>0</sub> = 0.529177210903 A. Common in QM code outputs.", ref: "CODATA 2018: Bohr radius" },
      pm: { name: "Picometer", symbol: "pm", factor: 1000.0, desc: "Precise bond lengths in crystallography (1 pm = 0.01 A).", ref: "SI 2019 (exact metric prefix)" },
      um: { name: "Micrometer", symbol: "µm", symbolHtml: "&micro;m", factor: 0.001, desc: "Mesoscale / microscopy scale (1 um = 1000 nm).", ref: "SI 2019 (exact metric prefix)" },
      fm: { name: "Femtometer", symbol: "fm", factor: 1e6, desc: "Nuclear scale (fermi). 1 fm = 10<sup>-15</sup> m.", ref: "SI 2019 (exact metric prefix)" },
      cm: { name: "Centimeter", symbol: "cm", factor: 1e-7, desc: "Macroscopic scale.", ref: "SI 2019 (exact metric prefix)" },
      m: { name: "Meter", symbol: "m", factor: 1e-9, desc: "Base SI unit of length.", ref: "SI 2019 (exact)" }
    }
  },
  time: {
    title: "Time & Dynamics",
    icon: "fa-clock",
    color: "emerald",
    note: "Base unit: picosecond (ps), the GROMACS time unit. The atomic unit of time hbar/E<sub>h</sub> = 2.4188843265857&times;10<sup>-17</sup> s.",
    units: {
      ps: { name: "Picosecond", symbol: "ps", factor: 1.0, desc: "Standard time unit in GROMACS (dt, trajectory output).", ref: "SI 2019 (exact metric prefix)" },
      ns: { name: "Nanosecond", symbol: "ns", factor: 0.001, desc: "Typical scale for reporting MD production-run lengths.", ref: "SI 2019 (exact metric prefix)" },
      fs: { name: "Femtosecond", symbol: "fs", factor: 1000.0, desc: "MD integration timestep (usually 1-2 fs).", ref: "SI 2019 (exact metric prefix)" },
      au: { name: "Atomic time", symbol: "a.u.", factor: 41341.373335, desc: "Atomic unit of time hbar/E<sub>h</sub>. 1 a.u. = 0.0242 fs.", ref: "CODATA 2018: atomic unit of time" },
      us: { name: "Microsecond", symbol: "µs", symbolHtml: "&micro;s", factor: 1e-6, desc: "Long-timescale / enhanced-sampling regime.", ref: "SI 2019 (exact metric prefix)" },
      ms: { name: "Millisecond", symbol: "ms", factor: 1e-9, desc: "Biological timescale (folding, large conformational change).", ref: "SI 2019 (exact metric prefix)" },
      s: { name: "Second", symbol: "s", factor: 1e-12, desc: "Base SI unit of time.", ref: "SI 2019 (exact)" }
    }
  },
  force: {
    title: "Force & Gradients",
    icon: "fa-arrow-down-up-across-line",
    color: "purple",
    note: "Base unit: kJ mol<sup>-1</sup> nm<sup>-1</sup> (GROMACS force). The atomic unit of force is E<sub>h</sub>/a<sub>0</sub> = 8.2387234983&times;10<sup>-8</sup> N.",
    units: {
      gromacs: { name: "GROMACS Force", symbol: "kJ mol-1 nm-1", symbolHtml: "kJ mol<sup>-1</sup> nm<sup>-1</sup>", factor: 1.0, desc: "Standard force unit reported by mdrun and in force-field derivatives.", ref: "GROMACS Reference Manual (unit system)" },
      amber: { name: "AMBER Force", symbol: "kcal mol-1 Å-1", symbolHtml: "kcal mol<sup>-1</sup> &Aring;<sup>-1</sup>", factor: 0.02390057, desc: "AMBER/CHARMM force unit. Derived from 1 kcal = 4.184 kJ and 1 A = 0.1 nm.", ref: "Thermochemical calorie + A definition" },
      ev_ang: { name: "eV per Angstrom", symbol: "eV/Å", symbolHtml: "eV/&Aring;", factor: 0.01036427, desc: "Gradient unit in VASP, Quantum ESPRESSO, and DFT codes.", ref: "CODATA 2018 (eV) + A definition" },
      hartree_bohr: { name: "Hartree / Bohr", symbol: "Eh a0-1", symbolHtml: "E<sub>h</sub> a<sub>0</sub><sup>-1</sup>", factor: 4.960827e-4, desc: "Atomic unit of force (per particle). 1 E<sub>h</sub>/a<sub>0</sub> = 8.2387&times;10<sup>-8</sup> N.", ref: "CODATA 2018: atomic unit of force" },
      pn: { name: "Piconewton", symbol: "pN", factor: 1.660539, desc: "AFM and single-molecule pulling (SMD) experiments.", ref: "CODATA 2018: N_A + SI 2019" },
      newton: { name: "Newton", symbol: "N", factor: 1.660539e-12, desc: "Base SI unit of force (per particle).", ref: "SI 2019 + CODATA 2018 (N_A)" }
    }
  },
  pressure: {
    title: "Pressure & Stress",
    icon: "fa-compress",
    color: "rose",
    note: "Base unit: bar, the GROMACS pressure unit. 1 bar = 10<sup>5</sup> Pa exactly. The atomic unit of pressure E<sub>h</sub>/a<sub>0</sub><sup>3</sup> = 2.9421015697&times;10<sup>13</sup> Pa.",
    units: {
      bar: { name: "Bar", symbol: "bar", factor: 1.0, desc: "Standard pressure unit in GROMACS (Parrinello-Rahman, Berendsen).", ref: "Defined: 1 bar = 10^5 Pa (exact)" },
      atm: { name: "Atmosphere", symbol: "atm", factor: 0.986923266716, desc: "Standard physical atmosphere. 1 atm = 101325 Pa exactly.", ref: "Defined: 1 atm = 101325 Pa (exact)" },
      pa: { name: "Pascal", symbol: "Pa", factor: 100000.0, desc: "Base SI unit of pressure (N/m^2).", ref: "SI 2019 (exact)" },
      kpa: { name: "Kilopascal", symbol: "kPa", factor: 100.0, desc: "Common engineering pressure unit.", ref: "SI 2019 (exact metric prefix)" },
      mpa: { name: "Megapascal", symbol: "MPa", factor: 0.1, desc: "Stress unit in materials science (1 MPa = 1 N/mm^2).", ref: "SI 2019 (exact metric prefix)" },
      gpa: { name: "Gigapascal", symbol: "GPa", factor: 0.0001, desc: "Bulk modulus, high-pressure physics, VASP stress tensor.", ref: "SI 2019 (exact metric prefix)" },
      torr: { name: "Torr", symbol: "Torr", factor: 750.061682704, desc: "1 Torr = 1/760 atm = 133.322 Pa. Vacuum work / mmHg.", ref: "Defined: 1 Torr = 101325/760 Pa" },
      psi: { name: "Pounds per sq. inch", symbol: "psi", factor: 14.503773773, desc: "Imperial engineering pressure. 1 psi = 6894.757 Pa.", ref: "Defined via lbf and inch (NIST SP 811)" },
      kbar: { name: "Kilobar", symbol: "kbar", factor: 0.001, desc: "Solid-state / geophysics pressure (1 kbar = 0.1 GPa).", ref: "Defined: 1 kbar = 10^3 bar (exact)" },
      au_p: { name: "Atomic pressure", symbol: "Eh a0-3", symbolHtml: "E<sub>h</sub> a<sub>0</sub><sup>-3</sup>", factor: 3.398927e-9, desc: "Atomic unit of pressure = 2.94210&times;10<sup>13</sup> Pa = 294.21 Mbar.", ref: "CODATA 2018: atomic unit of pressure" }
    }
  },
  dipole: {
    title: "Electric Dipole Moment",
    icon: "fa-magnet",
    color: "cyan",
    note: "Base unit: debye (D). 1 D = 10<sup>-21</sup>/c C&middot;m = 3.335641&times;10<sup>-30</sup> C&middot;m. The atomic unit e&middot;a<sub>0</sub> = 8.4783536255&times;10<sup>-30</sup> C&middot;m = 2.541746 D.",
    units: {
      debye: { name: "Debye", symbol: "D", factor: 1.0, desc: "CGS unit of molecular dipole moment. Water = 1.85 D. Reported by Gaussian/ORCA population analyses.", ref: "Defined: 1 D = 10^-18 statC*cm = 3.335641e-30 C*m" },
      au_dip: { name: "Atomic unit", symbol: "e a0", symbolHtml: "e a<sub>0</sub>", factor: 0.3934303, desc: "Atomic unit of electric dipole moment. QM codes output dipoles in a.u. 1 e*a<sub>0</sub> = 2.541746 D.", ref: "CODATA 2018: a.u. of electric dipole moment (8.4783536255e-30 C*m)" },
      e_ang: { name: "e x Angstrom", symbol: "e Å", symbolHtml: "e &Aring;", factor: 0.2081943, desc: "Charge-times-distance dipole used in classical MD analysis and Bader charges.", ref: "CODATA 2018 (e) + A definition" },
      e_nm: { name: "e x nm", symbol: "e nm", factor: 0.02081943, desc: "GROMACS-style charge x distance dipole (e*nm).", ref: "CODATA 2018 (e) + nm definition" },
      cm_dip: { name: "Coulomb-meter", symbol: "C·m", symbolHtml: "C&middot;m", factor: 3.335641e-30, desc: "SI unit of electric dipole moment.", ref: "CODATA 2018 (e) + SI 2019" }
    }
  },
  charge: {
    title: "Electric Charge",
    icon: "fa-bolt-lightning",
    color: "amber",
    note: "Base unit: elementary charge e = 1.602176634&times;10<sup>-19</sup> C (exact, SI 2019). In classical MD, partial atomic charges are always expressed in units of e.",
    units: {
      e: { name: "Elementary charge", symbol: "e", factor: 1.0, desc: "Partial atomic charge unit in all force fields (.itp, .mol2, RESP/CHELPG output).", ref: "SI 2019: elementary charge (exact)" },
      coulomb: { name: "Coulomb", symbol: "C", factor: 1.602176634e-19, desc: "SI unit of electric charge. 1 e = 1.602176634&times;10<sup>-19</sup> C exactly.", ref: "SI 2019 (exact)" },
      statc: { name: "Statcoulomb", symbol: "statC", factor: 4.803204712571e-10, desc: "CGS-Gaussian (Franklin) charge unit. 1 e = 4.80320&times;10<sup>-10</sup> statC.", ref: "CGS-Gaussian: e = 4.80320471e-10 statC" }
    }
  },
  polarizability: {
    title: "Polarizability",
    icon: "fa-atom",
    color: "teal",
    note: "Base unit: atomic unit e<sup>2</sup>a<sub>0</sub><sup>2</sup>/E<sub>h</sub> = 1.64877727436&times;10<sup>-41</sup> C<sup>2</sup>m<sup>2</sup>J<sup>-1</sup>. The volume polarizability (&Aring;<sup>3</sup>, Gaussian-CGS convention) is the form usually tabulated for molecules.",
    units: {
      au_pol: { name: "Atomic unit", symbol: "a.u.", factor: 1.0, desc: "Atomic unit of electric polarizability. Standard output of QM polarizability jobs.", ref: "CODATA 2018: a.u. of electric polarizability (1.64877727436e-41 C^2 m^2 J^-1)" },
      ang3: { name: "Volume (CGS)", symbol: "Å3", symbolHtml: "&Aring;<sup>3</sup>", factor: 0.14818471, desc: "Volume polarizability, Gaussian-CGS convention. 1 a.u. = 0.148185 A^3. Common in molecular polarizability tables.", ref: "CODATA 2018: a_0^3 in A^3 (Gaussian convention)" },
      si_pol: { name: "SI", symbol: "C2 m2 J-1", symbolHtml: "C<sup>2</sup> m<sup>2</sup> J<sup>-1</sup>", factor: 1.64877727436e-41, desc: "SI unit of electric polarizability (equivalently F*m^2).", ref: "CODATA 2018: a.u. of electric polarizability" }
    }
  },
  spectroscopy: {
    title: "Spectroscopy (E / freq / wavelength)",
    icon: "fa-wave-square",
    color: "indigo",
    note: "Base unit: wavenumber cm<sup>-1</sup>. Related by E = hc*nu = h*f and lambda = 1/nu. Uses h = 6.62607015&times;10<sup>-34</sup> J&middot;s and c = 299792458 m/s (both exact, SI 2019). Wavelength is INVERSE-proportional and is handled specially: edit one field at a time.",
    units: {
      cm1: { name: "Wavenumber", symbol: "cm-1", symbolHtml: "cm<sup>-1</sup>", factor: 1.0, desc: "Reciprocal wavelength (energy-proportional). Standard for IR/Raman vibrational spectra.", ref: "SI 2019: c, h exact" },
      thz: { name: "Frequency", symbol: "THz", factor: 0.0299792458, desc: "f = c*nu. 1 cm<sup>-1</sup> = 0.0299792458 THz.", ref: "SI 2019: speed of light (exact)" },
      ghz: { name: "Frequency", symbol: "GHz", factor: 29.9792458, desc: "Microwave rotational spectroscopy. 1 cm<sup>-1</sup> = 29.9792458 GHz.", ref: "SI 2019: speed of light (exact)" },
      mev: { name: "Energy", symbol: "meV", factor: 0.1239841984, desc: "1 cm<sup>-1</sup> = 0.123984 meV. Phonon / THz energy scale.", ref: "SI 2019 + CODATA 2018 (eV)" },
      ev_s: { name: "Energy", symbol: "eV", factor: 1.239841984e-4, desc: "Photon energy. E[eV] = 1.239841984e-4 x nu[cm^-1].", ref: "SI 2019 + CODATA 2018 (eV)" },
      zj: { name: "Energy", symbol: "zJ", factor: 0.01986445857, desc: "Photon energy in zeptojoules (10^-21 J). E = hc*nu.", ref: "SI 2019: h, c exact" },
      wl_nm: { name: "Wavelength", symbol: "nm", factor: 1e7, inverse: true, desc: "lambda = 10^7 / nu[cm^-1]. INVERSE relation - edit this field alone.", ref: "SI 2019: lambda = 1/nu" }
    }
  },
  temperature: {
    title: "Temperature",
    icon: "fa-temperature-half",
    color: "red",
    note: "Base unit: kelvin (K). Celsius and Fahrenheit are OFFSET scales, converted with affine formulas rather than a single ratio. k<sub>B</sub>T energy equivalents use k<sub>B</sub> = 1.380649&times;10<sup>-23</sup> J/K (exact, SI 2019).",
    affine: true,
    units: {
      k: { name: "Kelvin", symbol: "K", desc: "SI base unit of thermodynamic temperature. MD thermostats (ref_t) use K.", ref: "SI 2019: defined via k_B (exact)" },
      c: { name: "Celsius", symbol: "°C", symbolHtml: "&deg;C", desc: "degC = K - 273.15. Offset scale.", ref: "Defined: T[K] = T[C] + 273.15" },
      f: { name: "Fahrenheit", symbol: "°F", symbolHtml: "&deg;F", desc: "degF = (K - 273.15)*9/5 + 32. Offset scale.", ref: "Defined via Celsius (exact)" },
      kt_kj: { name: "kBT", nameHtml: "k<sub>B</sub>T", symbol: "kJ/mol", desc: "Thermal energy N_A*k_B*T. At 300 K = 2.494 kJ/mol.", ref: "SI 2019: k_B, N_A (exact)" },
      kt_kcal: { name: "kBT", nameHtml: "k<sub>B</sub>T", symbol: "kcal/mol", desc: "Thermal energy in kcal/mol. At 300 K = 0.596 kcal/mol (= RT).", ref: "SI 2019: k_B, N_A + thermochemical calorie" },
      kt_mev: { name: "kBT", nameHtml: "k<sub>B</sub>T", symbol: "meV", desc: "Thermal energy per particle. At 300 K = 25.85 meV.", ref: "SI 2019: k_B + CODATA 2018 (eV)" }
    }
  },
  heatcap: {
    title: "Heat Capacity & Entropy",
    icon: "fa-fire",
    color: "fuchsia",
    note: "Base unit: J mol<sup>-1</sup> K<sup>-1</sup>. The molar gas constant R = N<sub>A</sub>k<sub>B</sub> = 8.314462618 J mol<sup>-1</sup> K<sup>-1</sup> (exact, SI 2019) relates these entries.",
    units: {
      j_molk: { name: "J / (mol K)", symbol: "J mol-1 K-1", symbolHtml: "J mol<sup>-1</sup> K<sup>-1</sup>", factor: 1.0, desc: "SI molar heat capacity / entropy. Output of thermochemistry (freq) jobs.", ref: "SI 2019: R = 8.314462618 (exact)" },
      cal_molk: { name: "cal / (mol K) [e.u.]", symbol: "cal mol-1 K-1", symbolHtml: "cal mol<sup>-1</sup> K<sup>-1</sup>", factor: 0.2390057361, desc: "Entropy unit (e.u., 'gibbs'). Common in older thermochemistry tables. 1 cal = 4.184 J.", ref: "Thermochemical calorie (4.184 J exact)" },
      kj_molk: { name: "kJ / (mol K)", symbol: "kJ mol-1 K-1", symbolHtml: "kJ mol<sup>-1</sup> K<sup>-1</sup>", factor: 0.001, desc: "SI molar unit scaled by 1000.", ref: "SI 2019 (exact prefix)" },
      r_units: { name: "In units of R", symbol: "R", factor: 0.120272356, desc: "Dimensionless multiples of the gas constant R. C_v of a monatomic ideal gas = 1.5 R.", ref: "SI 2019: R = 8.314462618 (exact)" },
      kb_units: { name: "kB per particle", nameHtml: "k<sub>B</sub> per particle", symbol: "kB", symbolHtml: "k<sub>B</sub>", factor: 0.120272356, desc: "Per-particle entropy in units of k_B (numerically equal to multiples of R per mole).", ref: "SI 2019: k_B = 1.380649e-23 J/K (exact)" }
    }
  }
});

/** Absolute zero in degrees Celsius. */
const ABSOLUTE_ZERO_C = -273.15;

/** Molar gas constant R = N_A k_B, in J mol^-1 K^-1 (exact, SI 2019). */
const GAS_CONSTANT = 8.314462618;

/** Boltzmann constant k_B, in J/K (exact, SI 2019). */
const BOLTZMANN = 1.380649e-23;

/** Elementary charge, in C, the joules in one electron-volt (exact, SI 2019). */
const ELEMENTARY_CHARGE = 1.602176634e-19;

/**
 * Convert a value between two units of the same category.
 *
 * @param {number} value
 * @param {string} category
 * @param {string} from - Source unit key.
 * @param {string} to - Target unit key.
 * @returns {number} Converted value, or NaN when the request is invalid.
 */
export function convert(value, category, from, to) {
  if (!Number.isFinite(value)) return NaN;
  if (category === 'temperature') return convertTemperature(value, from, to);

  const cat = UNIT_DB[category];
  if (!cat) return NaN;
  const f = cat.units[from];
  const t = cat.units[to];
  if (!f || !t) return NaN;

  // Reciprocal units (wavelength against wavenumber) are inversely rather than
  // linearly proportional to the base, so they invert on the way in and again
  // on the way out. Without this a wavelength conversion silently returns a
  // plausible-looking but wrong number rather than failing loudly.
  const base = f.inverse ? f.factor / value : value / f.factor;
  if (!Number.isFinite(base)) return NaN;

  return t.inverse ? t.factor / base : base * t.factor;
}

/**
 * Convert between temperature scales.
 *
 * Celsius and Fahrenheit have offset zero points, so these are affine
 * transformations rather than simple scalings and cannot live in the factor
 * table. Kelvin is used as the pivot.
 *
 * @param {number} value
 * @param {'k'|'c'|'f'} from
 * @param {'k'|'c'|'f'} to
 * @returns {number}
 */
export function convertTemperature(value, from, to) {
  if (!Number.isFinite(value)) return NaN;

  let kelvin;
  switch (from) {
    case 'k': kelvin = value; break;
    case 'c': kelvin = value - ABSOLUTE_ZERO_C; break;
    case 'f': kelvin = (value - 32) * (5 / 9) - ABSOLUTE_ZERO_C; break;
    // kBT energy equivalents: invert the thermal-energy relations below.
    case 'kt_kj': kelvin = value * 1000 / GAS_CONSTANT; break;
    case 'kt_kcal': kelvin = value * 4184 / GAS_CONSTANT; break;
    case 'kt_mev': kelvin = value * (ELEMENTARY_CHARGE * 1e-3) / BOLTZMANN; break;
    default: return NaN;
  }

  switch (to) {
    case 'k': return kelvin;
    case 'c': return kelvin + ABSOLUTE_ZERO_C;
    case 'f': return (kelvin + ABSOLUTE_ZERO_C) * (9 / 5) + 32;
    // Thermal energy at temperature T, molar (R T) or per-particle (k_B T).
    case 'kt_kj': return kelvin * GAS_CONSTANT / 1000;
    case 'kt_kcal': return kelvin * GAS_CONSTANT / 4184;
    case 'kt_mev': return kelvin * BOLTZMANN / (ELEMENTARY_CHARGE * 1e-3);
    default: return NaN;
  }
}

/**
 * List the multiplicative category identifiers.
 *
 * Affine categories (temperature) are excluded because their units have no
 * conversion factor and no base unit, so they cannot take part in the
 * factor-table algebra callers expect here. Use {@link listAllCategories} to
 * drive a UI that offers every category, and {@link isAffine} to branch.
 *
 * @returns {string[]}
 */
export function listCategories() {
  return Object.keys(UNIT_DB).filter(c => !UNIT_DB[c].affine);
}

/**
 * List every category identifier, affine ones included.
 *
 * @returns {string[]}
 */
export function listAllCategories() {
  return Object.keys(UNIT_DB);
}

/**
 * Whether a category converts by offset rather than by a scale factor.
 *
 * @param {string} category
 * @returns {boolean}
 */
export function isAffine(category) {
  return Boolean(UNIT_DB[category] && UNIT_DB[category].affine);
}

/**
 * List the unit keys within a category.
 *
 * @param {string} category
 * @returns {string[]} Empty when the category is unknown.
 */
export function listUnits(category) {
  const cat = UNIT_DB[category];
  return cat ? Object.keys(cat.units) : [];
}

/**
 * Retrieve a unit's metadata.
 *
 * @param {string} category
 * @param {string} unit
 * @returns {{name:string, symbol:string, factor:number, ref:string}|null}
 */
export function getUnit(category, unit) {
  const cat = UNIT_DB[category];
  if (!cat) return null;
  return cat.units[unit] || null;
}

/**
 * Find the base unit of a category, i.e. the one with factor exactly 1.
 *
 * @param {string} category
 * @returns {string|null}
 */
export function baseUnit(category) {
  const cat = UNIT_DB[category];
  if (!cat) return null;
  for (const [k, u] of Object.entries(cat.units)) {
    if (u.factor === 1) return k;
  }
  return null;
}

/**
 * Locate the category containing a given unit key.
 *
 * Unit keys are not globally unique, `cm` is both inverse centimetres under
 * energy and centimetres under length, so the first match is returned and
 * callers that care should pass an explicit category.
 *
 * @param {string} unit
 * @returns {string|null}
 */
export function findCategory(unit) {
  for (const [cat, def] of Object.entries(UNIT_DB)) {
    if (def.units[unit]) return cat;
  }
  return null;
}

/**
 * Convert kT into an energy unit at a given temperature.
 *
 * Uses the molar gas constant R = 8.314462618 J/(mol K), so results are per
 * mole and directly comparable with force-field energies.
 *
 * @param {number} kt - Energy in units of kT.
 * @param {number} temperature - Temperature in kelvin.
 * @param {'kj'|'kcal'|'mev'} unit
 * @returns {number}
 */
export function convertKT(kt, temperature, unit) {
  if (!Number.isFinite(kt) || !Number.isFinite(temperature)) return NaN;
  const R = 8.314462618;
  const joulesPerMole = kt * R * temperature;

  switch (unit) {
    case 'kj': return joulesPerMole / 1000;
    case 'kcal': return joulesPerMole / 4184;
    case 'mev': {
      // Per particle rather than per mole, expressed in meV.
      const NA = 6.02214076e23;
      const e = 1.602176634e-19;
      return (joulesPerMole / NA / e) * 1000;
    }
    default: return NaN;
  }
}

/**
 * Format a converted value with an appropriate representation.
 *
 * Very large or very small magnitudes are shown in exponential form, since
 * fixed-point would either lose all significant digits or run to dozens of
 * characters.
 *
 * @param {number} value
 * @param {number} [sigFigs=6]
 * @returns {string}
 */
export function formatValue(value, sigFigs = 6) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value === 0) return '0';
  const mag = Math.abs(value);
  if (mag >= 1e6 || mag < 1e-4) return value.toExponential(sigFigs - 1);
  return String(Number(value.toPrecision(sigFigs)));
}
