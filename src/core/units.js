/**
 * @module core/units
 *
 * Unit conversion for computational chemistry and molecular dynamics,
 * extracted from STEMKit's Scientific Converter.
 *
 * Each category defines a base unit with factor 1.0; every other unit records
 * how many of itself make up one base unit. Conversion therefore reduces to
 *
 *   result = value * factor[to] / factor[from]
 *
 * rounded once (see {@link convert}). Working through a single base rather
 * than storing pairwise factors keeps the table O(n) instead of O(n^2) and
 * makes every entry independently checkable against its cited source.
 *
 * No factor is typed in as a rounded decimal. The module holds the five exact
 * defining constants of the SI (2019) and the two measured constants every
 * atomic unit here reduces to, the Bohr radius and the Hartree energy at their
 * CODATA 2018 recommended values, and computes each factor from those in
 * double precision. Two tables therefore cannot disagree: the bohr of the
 * length table is the bohr inside the atomic units of force, pressure, dipole
 * moment and polarizability. The tests compare every factor with
 * `scipy.constants`. Where a factor is exact by definition (metric prefixes,
 * the thermochemical calorie of 4.184 J, the 2019 elementary charge) the `ref`
 * field says so.
 *
 * Temperature is handled separately: Celsius and Fahrenheit are affine, not
 * multiplicative, so a single factor cannot express them.
 */

/* --- Constants ------------------------------------------------------------ */

/** Speed of light in vacuum, m/s (exact, SI 2019). */
const SPEED_OF_LIGHT = 299792458;

/** Planck constant, J s (exact, SI 2019). */
const PLANCK = 6.62607015e-34;

/** Elementary charge, C, and so the joules in one electron-volt (exact, SI 2019). */
const ELEMENTARY_CHARGE = 1.602176634e-19;

/** Boltzmann constant, J/K (exact, SI 2019). */
const BOLTZMANN = 1.380649e-23;

/** Avogadro constant, 1/mol (exact, SI 2019). */
const AVOGADRO = 6.02214076e23;

/**
 * Bohr radius a_0, m. CODATA 2018 recommended value, 5.291 772 109 03(80)e-11
 * (Tiesinga, Mohr, Newell and Taylor, Rev. Mod. Phys. 93, 025010, 2021).
 */
const BOHR_RADIUS = 5.29177210903e-11;

/**
 * Hartree energy E_h, J. CODATA 2018 recommended value,
 * 4.359 744 722 2071(85)e-18 (same source).
 */
const HARTREE = 4.3597447222071e-18;

/** Reduced Planck constant h / 2 pi, J s. */
const HBAR = PLANCK / (2 * Math.PI);

/** Molar gas constant R = N_A k_B, J/(mol K): 8.31446261815324 exactly. */
const GAS_CONSTANT = AVOGADRO * BOLTZMANN;

/** Thermochemical calorie, J (exact by definition). */
const CALORIE = 4.184;

/** Standard atmosphere, Pa (exact by definition). */
const ATMOSPHERE = 101325;

/**
 * Pound-force per square inch, Pa: the avoirdupois pound (0.45359237 kg) under
 * standard gravity (9.80665 m/s^2) on a square inch (0.0254 m)^2, each exact.
 */
const PSI = 0.45359237 * 9.80665 / (0.0254 * 0.0254);

/** Debye, C m: 1e-18 statC cm, which is 1e-21/c with c in m/s (exact). */
const DEBYE = 1e-21 / SPEED_OF_LIGHT;

/** One kJ/mol/nm in newtons per particle: 1e3 J / N_A / 1e-9 m. */
const KJ_MOL_NM = 1e12 / AVOGADRO;

/** The energy of one wavenumber, h c (100 m^-1), in joules. */
const WAVENUMBER = PLANCK * SPEED_OF_LIGHT * 100;

/**
 * The constants the factors are built from, for callers that want the same
 * numbers the tables use. Units are SI.
 */
export const CONSTANTS = Object.freeze({
  speedOfLight: SPEED_OF_LIGHT,
  planck: PLANCK,
  elementaryCharge: ELEMENTARY_CHARGE,
  boltzmann: BOLTZMANN,
  avogadro: AVOGADRO,
  bohrRadius: BOHR_RADIUS,
  hartree: HARTREE,
  gasConstant: GAS_CONSTANT,
  source: 'SI 2019 (exact c, h, e, k_B, N_A); CODATA 2018 (a_0, E_h)'
});

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
      ev: { name: "Electron-volt", symbol: "eV", factor: HARTREE / ELEMENTARY_CHARGE, desc: "Common in solid-state physics and band-gap calculations. 1 eV = 1.602176634&times;10<sup>-19</sup> J (exact, SI 2019).", ref: "CODATA 2018: Hartree energy in eV" },
      kcal: { name: "kcal / mol", symbol: "kcal/mol", factor: HARTREE * AVOGADRO / (1000 * CALORIE), desc: "Standard for organic chemistry and AMBER/CHARMM force fields. Uses the thermochemical calorie (1 cal = 4.184 J exactly).", ref: "CODATA 2018 + thermochemical calorie (4.184 J)" },
      kj: { name: "kJ / mol", symbol: "kJ/mol", factor: HARTREE * AVOGADRO / 1000, desc: "SI derived molar unit. Required for GROMACS topologies and OPLS parameters.", ref: "CODATA 2018 x N_A (SI 2019)" },
      cm: { name: "Inverse cm", symbol: "cm-1", symbolHtml: "cm<sup>-1</sup>", factor: HARTREE / WAVENUMBER, desc: "Spectroscopic wavenumber. E = hc*nu; 1 E<sub>h</sub> = 219474.63 cm<sup>-1</sup>.", ref: "CODATA 2018: hartree-inverse-metre relationship" },
      kelvin: { name: "Kelvin eq.", symbol: "K", factor: HARTREE / BOLTZMANN, desc: "Thermal-energy equivalent E / k<sub>B</sub>, with k<sub>B</sub> = 1.380649&times;10<sup>-23</sup> J/K (exact, SI 2019).", ref: "CODATA 2018: hartree-kelvin relationship" },
      cal: { name: "cal / mol", symbol: "cal/mol", factor: HARTREE * AVOGADRO / CALORIE, desc: "Per-mole thermochemical calorie. 1 cal = 4.184 J exactly.", ref: "Thermochemical calorie (4.184 J) + CODATA 2018" },
      joule: { name: "Joule", symbol: "J", factor: HARTREE, desc: "Macroscopic SI unit of energy (per particle, not per mole).", ref: "CODATA 2018: Hartree energy in J" },
      erg: { name: "Erg", symbol: "erg", factor: HARTREE * 1e7, desc: "CGS unit of energy. 1 erg = 10<sup>-7</sup> J exactly.", ref: "CGS definition + CODATA 2018" }
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
      bohr: { name: "Bohr radius", symbol: "a0", symbolHtml: "a<sub>0</sub>", factor: 1e-9 / BOHR_RADIUS, desc: "Atomic unit of length. a<sub>0</sub> = 0.529177210903 A. Common in QM code outputs.", ref: "CODATA 2018: Bohr radius" },
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
      au: { name: "Atomic time", symbol: "a.u.", factor: 1e-12 * HARTREE / HBAR, desc: "Atomic unit of time hbar/E<sub>h</sub>. 1 a.u. = 0.0242 fs.", ref: "CODATA 2018: atomic unit of time" },
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
      amber: { name: "AMBER Force", symbol: "kcal mol-1 Å-1", symbolHtml: "kcal mol<sup>-1</sup> &Aring;<sup>-1</sup>", factor: 1 / (10 * CALORIE), desc: "AMBER/CHARMM force unit. Derived from 1 kcal = 4.184 kJ and 1 A = 0.1 nm.", ref: "Thermochemical calorie + A definition" },
      ev_ang: { name: "eV per Angstrom", symbol: "eV/Å", symbolHtml: "eV/&Aring;", factor: KJ_MOL_NM * 1e-10 / ELEMENTARY_CHARGE, desc: "Gradient unit in VASP, Quantum ESPRESSO, and DFT codes.", ref: "CODATA 2018 (eV) + A definition" },
      hartree_bohr: { name: "Hartree / Bohr", symbol: "Eh a0-1", symbolHtml: "E<sub>h</sub> a<sub>0</sub><sup>-1</sup>", factor: KJ_MOL_NM * BOHR_RADIUS / HARTREE, desc: "Atomic unit of force (per particle). 1 E<sub>h</sub>/a<sub>0</sub> = 8.2387&times;10<sup>-8</sup> N.", ref: "CODATA 2018: atomic unit of force" },
      pn: { name: "Piconewton", symbol: "pN", factor: KJ_MOL_NM * 1e12, desc: "AFM and single-molecule pulling (SMD) experiments.", ref: "SI 2019: N_A (exact)" },
      newton: { name: "Newton", symbol: "N", factor: KJ_MOL_NM, desc: "Base SI unit of force (per particle).", ref: "SI 2019: N_A (exact)" }
    }
  },
  pressure: {
    title: "Pressure & Stress",
    icon: "fa-compress",
    color: "rose",
    note: "Base unit: bar, the GROMACS pressure unit. 1 bar = 10<sup>5</sup> Pa exactly. The atomic unit of pressure E<sub>h</sub>/a<sub>0</sub><sup>3</sup> = 2.9421015697&times;10<sup>13</sup> Pa.",
    units: {
      bar: { name: "Bar", symbol: "bar", factor: 1.0, desc: "Standard pressure unit in GROMACS (Parrinello-Rahman, Berendsen).", ref: "Defined: 1 bar = 10^5 Pa (exact)" },
      atm: { name: "Atmosphere", symbol: "atm", factor: 1e5 / ATMOSPHERE, desc: "Standard physical atmosphere. 1 atm = 101325 Pa exactly.", ref: "Defined: 1 atm = 101325 Pa (exact)" },
      pa: { name: "Pascal", symbol: "Pa", factor: 100000.0, desc: "Base SI unit of pressure (N/m^2).", ref: "SI 2019 (exact)" },
      kpa: { name: "Kilopascal", symbol: "kPa", factor: 100.0, desc: "Common engineering pressure unit.", ref: "SI 2019 (exact metric prefix)" },
      mpa: { name: "Megapascal", symbol: "MPa", factor: 0.1, desc: "Stress unit in materials science (1 MPa = 1 N/mm^2).", ref: "SI 2019 (exact metric prefix)" },
      gpa: { name: "Gigapascal", symbol: "GPa", factor: 0.0001, desc: "Bulk modulus, high-pressure physics, VASP stress tensor.", ref: "SI 2019 (exact metric prefix)" },
      torr: { name: "Torr", symbol: "Torr", factor: 1e5 * 760 / ATMOSPHERE, desc: "1 Torr = 1/760 atm = 133.322 Pa. Vacuum work / mmHg.", ref: "Defined: 1 Torr = 101325/760 Pa" },
      psi: { name: "Pounds per sq. inch", symbol: "psi", factor: 1e5 / PSI, desc: "Imperial engineering pressure. 1 psi = 6894.757 Pa.", ref: "Defined via lbf and inch (NIST SP 811)" },
      kbar: { name: "Kilobar", symbol: "kbar", factor: 0.001, desc: "Solid-state / geophysics pressure (1 kbar = 0.1 GPa).", ref: "Defined: 1 kbar = 10^3 bar (exact)" },
      au_p: { name: "Atomic pressure", symbol: "Eh a0-3", symbolHtml: "E<sub>h</sub> a<sub>0</sub><sup>-3</sup>", factor: 1e5 * BOHR_RADIUS ** 3 / HARTREE, desc: "Atomic unit of pressure = 2.94210&times;10<sup>13</sup> Pa = 294.21 Mbar.", ref: "CODATA 2018: atomic unit of pressure" }
    }
  },
  dipole: {
    title: "Electric Dipole Moment",
    icon: "fa-magnet",
    color: "cyan",
    note: "Base unit: debye (D). 1 D = 10<sup>-21</sup>/c C&middot;m = 3.335641&times;10<sup>-30</sup> C&middot;m. The atomic unit e&middot;a<sub>0</sub> = 8.4783536255&times;10<sup>-30</sup> C&middot;m = 2.541746 D.",
    units: {
      debye: { name: "Debye", symbol: "D", factor: 1.0, desc: "CGS unit of molecular dipole moment. Water = 1.85 D. Reported by Gaussian/ORCA population analyses.", ref: "Defined: 1 D = 10^-18 statC*cm = 3.335641e-30 C*m" },
      au_dip: { name: "Atomic unit", symbol: "e a0", symbolHtml: "e a<sub>0</sub>", factor: DEBYE / (ELEMENTARY_CHARGE * BOHR_RADIUS), desc: "Atomic unit of electric dipole moment. QM codes output dipoles in a.u. 1 e*a<sub>0</sub> = 2.541746 D.", ref: "CODATA 2018: a.u. of electric dipole moment (8.4783536255e-30 C*m)" },
      e_ang: { name: "e x Angstrom", symbol: "e Å", symbolHtml: "e &Aring;", factor: DEBYE / (ELEMENTARY_CHARGE * 1e-10), desc: "Charge-times-distance dipole used in classical MD analysis and Bader charges.", ref: "CODATA 2018 (e) + A definition" },
      e_nm: { name: "e x nm", symbol: "e nm", factor: DEBYE / (ELEMENTARY_CHARGE * 1e-9), desc: "GROMACS-style charge x distance dipole (e*nm).", ref: "CODATA 2018 (e) + nm definition" },
      cm_dip: { name: "Coulomb-meter", symbol: "C·m", symbolHtml: "C&middot;m", factor: DEBYE, desc: "SI unit of electric dipole moment.", ref: "CODATA 2018 (e) + SI 2019" }
    }
  },
  charge: {
    title: "Electric Charge",
    icon: "fa-bolt-lightning",
    color: "amber",
    note: "Base unit: elementary charge e = 1.602176634&times;10<sup>-19</sup> C (exact, SI 2019). In classical MD, partial atomic charges are always expressed in units of e.",
    units: {
      e: { name: "Elementary charge", symbol: "e", factor: 1.0, desc: "Partial atomic charge unit in all force fields (.itp, .mol2, RESP/CHELPG output).", ref: "SI 2019: elementary charge (exact)" },
      coulomb: { name: "Coulomb", symbol: "C", factor: ELEMENTARY_CHARGE, desc: "SI unit of electric charge. 1 e = 1.602176634&times;10<sup>-19</sup> C exactly.", ref: "SI 2019 (exact)" },
      statc: { name: "Statcoulomb", symbol: "statC", factor: ELEMENTARY_CHARGE * SPEED_OF_LIGHT * 10, desc: "CGS-Gaussian (Franklin) charge unit. 1 e = 4.80320&times;10<sup>-10</sup> statC.", ref: "CGS-Gaussian: e = 4.80320471e-10 statC" }
    }
  },
  polarizability: {
    title: "Polarizability",
    icon: "fa-atom",
    color: "teal",
    note: "Base unit: atomic unit e<sup>2</sup>a<sub>0</sub><sup>2</sup>/E<sub>h</sub> = 1.64877727436&times;10<sup>-41</sup> C<sup>2</sup>m<sup>2</sup>J<sup>-1</sup>. The volume polarizability (&Aring;<sup>3</sup>, Gaussian-CGS convention) is the form usually tabulated for molecules.",
    units: {
      au_pol: { name: "Atomic unit", symbol: "a.u.", factor: 1.0, desc: "Atomic unit of electric polarizability. Standard output of QM polarizability jobs.", ref: "CODATA 2018: a.u. of electric polarizability (1.64877727436e-41 C^2 m^2 J^-1)" },
      ang3: { name: "Volume (CGS)", symbol: "Å3", symbolHtml: "&Aring;<sup>3</sup>", factor: (BOHR_RADIUS * 1e10) ** 3, desc: "Volume polarizability, Gaussian-CGS convention. 1 a.u. = 0.148185 A^3. Common in molecular polarizability tables.", ref: "CODATA 2018: a_0^3 in A^3 (Gaussian convention)" },
      si_pol: { name: "SI", symbol: "C2 m2 J-1", symbolHtml: "C<sup>2</sup> m<sup>2</sup> J<sup>-1</sup>", factor: (ELEMENTARY_CHARGE * BOHR_RADIUS) ** 2 / HARTREE, desc: "SI unit of electric polarizability (equivalently F*m^2).", ref: "CODATA 2018: a.u. of electric polarizability" }
    }
  },
  spectroscopy: {
    title: "Spectroscopy (E / freq / wavelength)",
    icon: "fa-wave-square",
    color: "indigo",
    note: "Base unit: wavenumber cm<sup>-1</sup>. Related by E = hc*nu = h*f and lambda = 1/nu. Uses h = 6.62607015&times;10<sup>-34</sup> J&middot;s and c = 299792458 m/s (both exact, SI 2019). Wavelength is the reciprocal of the others (lambda = 1/nu), so doubling it halves every other field.",
    units: {
      cm1: { name: "Wavenumber", symbol: "cm-1", symbolHtml: "cm<sup>-1</sup>", factor: 1.0, desc: "Reciprocal wavelength (energy-proportional). Standard for IR/Raman vibrational spectra.", ref: "SI 2019: c, h exact" },
      thz: { name: "Frequency", symbol: "THz", factor: SPEED_OF_LIGHT / 1e10, desc: "f = c*nu. 1 cm<sup>-1</sup> = 0.0299792458 THz.", ref: "SI 2019: speed of light (exact)" },
      ghz: { name: "Frequency", symbol: "GHz", factor: SPEED_OF_LIGHT / 1e7, desc: "Microwave rotational spectroscopy. 1 cm<sup>-1</sup> = 29.9792458 GHz.", ref: "SI 2019: speed of light (exact)" },
      mev: { name: "Energy", symbol: "meV", factor: WAVENUMBER / ELEMENTARY_CHARGE * 1000, desc: "1 cm<sup>-1</sup> = 0.123984 meV. Phonon / THz energy scale.", ref: "SI 2019 + CODATA 2018 (eV)" },
      ev_s: { name: "Energy", symbol: "eV", factor: WAVENUMBER / ELEMENTARY_CHARGE, desc: "Photon energy. E[eV] = 1.239841984e-4 x nu[cm^-1].", ref: "SI 2019 + CODATA 2018 (eV)" },
      zj: { name: "Energy", symbol: "zJ", factor: WAVENUMBER * 1e21, desc: "Photon energy in zeptojoules (10^-21 J). E = hc*nu.", ref: "SI 2019: h, c exact" },
      wl_nm: { name: "Wavelength", symbol: "nm", factor: 1e7, inverse: true, desc: "lambda = 10^7 / nu[cm^-1]. The reciprocal of the other fields: a longer wavelength is a smaller wavenumber, frequency and energy.", ref: "SI 2019: lambda = 1/nu" }
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
    note: "Base unit: J mol<sup>-1</sup> K<sup>-1</sup>. The molar gas constant R = N<sub>A</sub>k<sub>B</sub> = 8.31446261815324 J mol<sup>-1</sup> K<sup>-1</sup> (exact, SI 2019) relates these entries.",
    units: {
      j_molk: { name: "J / (mol K)", symbol: "J mol-1 K-1", symbolHtml: "J mol<sup>-1</sup> K<sup>-1</sup>", factor: 1.0, desc: "SI molar heat capacity / entropy. Output of thermochemistry (freq) jobs.", ref: "SI 2019: R = N_A k_B = 8.31446261815324 (exact)" },
      cal_molk: { name: "cal / (mol K) [e.u.]", symbol: "cal mol-1 K-1", symbolHtml: "cal mol<sup>-1</sup> K<sup>-1</sup>", factor: 1 / CALORIE, desc: "Entropy unit (e.u., 'gibbs'). Common in older thermochemistry tables. 1 cal = 4.184 J.", ref: "Thermochemical calorie (4.184 J exact)" },
      kj_molk: { name: "kJ / (mol K)", symbol: "kJ mol-1 K-1", symbolHtml: "kJ mol<sup>-1</sup> K<sup>-1</sup>", factor: 0.001, desc: "SI molar unit scaled by 1000.", ref: "SI 2019 (exact prefix)" },
      r_units: { name: "In units of R", symbol: "R", factor: 1 / GAS_CONSTANT, desc: "Dimensionless multiples of the gas constant R. C_v of a monatomic ideal gas = 1.5 R.", ref: "SI 2019: R = N_A k_B = 8.31446261815324 (exact)" },
      kb_units: { name: "kB per particle", nameHtml: "k<sub>B</sub> per particle", symbol: "kB", symbolHtml: "k<sub>B</sub>", factor: 1 / GAS_CONSTANT, desc: "Per-particle entropy in units of k_B (numerically equal to multiples of R per mole).", ref: "SI 2019: k_B = 1.380649e-23 J/K (exact)" }
    }
  }
});

/** Absolute zero in degrees Celsius. */
const ABSOLUTE_ZERO_C = -273.15;

/** The scales {@link convertTemperature} knows. */
const TEMPERATURE_SCALES = Object.freeze(['k', 'c', 'f', 'kt_kj', 'kt_kcal', 'kt_mev']);

/**
 * The rounding error of a product: a * b = p + productError(a, b, p) exactly,
 * where p is the rounded a * b (Dekker's product on Veltkamp's splitting).
 */
function productError(a, b, p) {
  const SPLIT = 134217729; // 2^27 + 1
  const ca = SPLIT * a;
  const ah = ca - (ca - a);
  const al = a - ah;
  const cb = SPLIT * b;
  const bh = cb - (cb - b);
  const bl = b - bh;
  return ((ah * bh - p) + ah * bl + al * bh) + al * bl;
}

/** Magnitudes between which the error terms below neither overflow nor vanish. */
const SAFE_MIN = 1e-140;
const SAFE_MAX = 1e140;
const safe = x => { const m = Math.abs(x); return m > SAFE_MIN && m < SAFE_MAX; };

/**
 * a * b / c, rounded once.
 *
 * Written plainly, the product rounds and then the quotient rounds, and the
 * two errors add up: 1 J came out as 9999999.999999998 erg. Here the part of
 * the product that rounding dropped and the remainder of the division are
 * both recovered and folded back in, so the result is the double nearest the
 * true a * b / c. Outside the range where those corrections are themselves
 * reliable the plain result stands.
 */
function mulDiv(a, b, c) {
  const p = a * b;
  const q = p / c;
  if (!safe(a) || !safe(b) || !safe(c) || !safe(p) || !safe(q)) return q;
  const back = q * c;
  const remainder = ((p - back) - productError(q, c, back)) + productError(a, b, p);
  return q + remainder / c;
}

/**
 * The whole number n when a factor is 1/n, otherwise 0.
 *
 * A metre is 1e-9 of itself per nanometre, and 1e-9 is not a double, though
 * 1e9 is. Dividing by the nearest double instead made 1 m come out as
 * 999999999.9999999 nm; multiplying by the whole number does not.
 */
function wholeReciprocal(factor) {
  const n = Math.round(1 / factor);
  return n > 1 && n <= Number.MAX_SAFE_INTEGER && 1 / n === factor ? n : 0;
}

/**
 * Convert a value between two units of the same category.
 *
 * A value in its own unit comes back unchanged, and every other conversion is
 * rounded once, which is as close as doubles get: there and back again lands
 * on the starting value or on the double next to it.
 *
 * @param {number} value
 * @param {string} category
 * @param {string} from - Source unit key.
 * @param {string} to - Target unit key.
 * @returns {number} Converted value, or NaN when the request is invalid or
 *   has no finite answer (a wavelength of zero has no wavenumber).
 */
export function convert(value, category, from, to) {
  if (!Number.isFinite(value)) return NaN;
  if (category === 'temperature') return convertTemperature(value, from, to);

  const cat = UNIT_DB[category];
  if (!cat) return NaN;
  const f = cat.units[from];
  const t = cat.units[to];
  if (!f || !t) return NaN;

  // Through the base this would be value / factor * factor, which rounds
  // twice and can land on the neighbouring double (7.5 kJ/mol came back as
  // 7.499999999999999).
  if (from === to) return value;

  // Reciprocal units (wavelength against wavenumber) are inversely rather than
  // linearly proportional to the base, so between one of them and a linear
  // unit the value moves under the fraction. Without this a wavelength
  // conversion silently returns a plausible-looking but wrong number rather
  // than failing loudly.
  let result;
  if (Boolean(f.inverse) !== Boolean(t.inverse)) {
    result = mulDiv(f.factor, t.factor, value);
  } else {
    // value * factor[to] / factor[from], with each 1/n factor moved across
    // the fraction as its n.
    const nTo = wholeReciprocal(t.factor);
    const nFrom = wholeReciprocal(f.factor);
    result = mulDiv(value, (nTo ? 1 : t.factor) * (nFrom || 1), (nFrom ? 1 : f.factor) * (nTo || 1));
  }

  return Number.isFinite(result) ? result : NaN;
}

/**
 * Convert between temperature scales.
 *
 * Celsius and Fahrenheit have offset zero points, so these are affine
 * transformations rather than simple scalings and cannot live in the factor
 * table. Kelvin is used as the pivot.
 *
 * @param {number} value
 * @param {'k'|'c'|'f'|'kt_kj'|'kt_kcal'|'kt_mev'} from
 * @param {'k'|'c'|'f'|'kt_kj'|'kt_kcal'|'kt_mev'} to
 * @returns {number}
 */
export function convertTemperature(value, from, to) {
  if (!Number.isFinite(value)) return NaN;
  // The same scale on both sides: no trip through kelvin, which would add
  // and subtract 273.15 and return 0.10000000000002274 for 0.1 degC.
  if (from === to && TEMPERATURE_SCALES.includes(from)) return value;
  // Nor between Celsius and Fahrenheit, which differ by a scale and 32 degF:
  // 37 degC is 98.6 degF, not the 98.60000000000001 that adding and removing
  // 273.15 leaves.
  if (from === 'c' && to === 'f') return value * 9 / 5 + 32;
  if (from === 'f' && to === 'c') return (value - 32) * 5 / 9;

  let kelvin;
  switch (from) {
    case 'k': kelvin = value; break;
    case 'c': kelvin = value - ABSOLUTE_ZERO_C; break;
    case 'f': kelvin = (value - 32) * 5 / 9 - ABSOLUTE_ZERO_C; break;
    // kBT energy equivalents: invert the thermal-energy relations below.
    case 'kt_kj': kelvin = value * 1000 / GAS_CONSTANT; break;
    case 'kt_kcal': kelvin = value * (1000 * CALORIE) / GAS_CONSTANT; break;
    case 'kt_mev': kelvin = value * (ELEMENTARY_CHARGE / 1000) / BOLTZMANN; break;
    default: return NaN;
  }

  switch (to) {
    case 'k': return kelvin;
    case 'c': return kelvin + ABSOLUTE_ZERO_C;
    case 'f': return (kelvin + ABSOLUTE_ZERO_C) * 9 / 5 + 32;
    // Thermal energy at temperature T, molar (R T) or per-particle (k_B T).
    case 'kt_kj': return kelvin * GAS_CONSTANT / 1000;
    case 'kt_kcal': return kelvin * GAS_CONSTANT / (1000 * CALORIE);
    case 'kt_mev': return kelvin * BOLTZMANN / (ELEMENTARY_CHARGE / 1000);
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
 * kJ/mol and kcal/mol use the molar gas constant R = N_A k_B, so they are per
 * mole and directly comparable with force-field energies; meV is per particle
 * and uses k_B. One kT at T is the thermal energy {@link convertTemperature}
 * reports for T, so the two cannot disagree.
 *
 * @param {number} kt - Energy in units of kT.
 * @param {number} temperature - Temperature in kelvin.
 * @param {'kj'|'kcal'|'mev'} unit
 * @returns {number}
 */
export function convertKT(kt, temperature, unit) {
  if (!Number.isFinite(kt) || !Number.isFinite(temperature)) return NaN;
  if (unit !== 'kj' && unit !== 'kcal' && unit !== 'mev') return NaN;
  return kt * convertTemperature(temperature, 'k', `kt_${unit}`);
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
