document.addEventListener('DOMContentLoaded', () => {

    /* ============================================================
       # --- 1. Master scientific dictionary ---
       Every conversion factor is expressed relative to the category's
       base unit (factor = 1.0). Each unit carries a `ref` string naming
       the authoritative source of the constant it depends on so the
       tooltip can cite it inline. Sources:
         CODATA 2018  - Tiesinga, Mohr, Newell & Taylor, Rev. Mod. Phys.
                        93, 025010 (2021); values via physics.nist.gov.
         SI (2019)    - BIPM SI Brochure, 9th ed. (exact defined values).
         GROMACS      - GROMACS Reference Manual (unit system).
         AMBER        - Case et al., AMBER Reference Manual.
       ============================================================ */
    const UNIT_DB = {
        energy: {
            title: "Energy & Thermodynamics",
            icon: "fa-bolt",
            color: "orange",
            note: "Base unit: Hartree (E<sub>h</sub>). Molar factors (kcal/mol, kJ/mol) multiply the per-particle energy by the Avogadro constant N<sub>A</sub> = 6.02214076&times;10<sup>23</sup> mol<sup>-1</sup> (exact, SI 2019).",
            units: {
                hartree: { name: "Hartree", symbol: "E<sub>h</sub>", factor: 1.0, desc: "Atomic unit of energy. Standard for quantum chemistry (Gaussian, ORCA). E<sub>h</sub> = 4.3597447222071&times;10<sup>-18</sup> J.", ref: "CODATA 2018: Hartree energy" },
                rydberg: { name: "Rydberg", symbol: "Ry", factor: 2.0, desc: "1 E<sub>h</sub> = 2 Ry exactly. The Rydberg energy (13.605693 eV) is the ionization energy of hydrogen in the infinite-mass limit.", ref: "CODATA 2018: E_h = 2 R_inf hc (exact ratio)" },
                ev: { name: "Electron-volt", symbol: "eV", factor: 27.211386245988, desc: "Common in solid-state physics and band-gap calculations. 1 eV = 1.602176634&times;10<sup>-19</sup> J (exact, SI 2019).", ref: "CODATA 2018: Hartree energy in eV" },
                kcal: { name: "kcal / mol", symbol: "kcal/mol", factor: 627.5094740631, desc: "Standard for organic chemistry and AMBER/CHARMM force fields. Uses the thermochemical calorie (1 cal = 4.184 J exactly).", ref: "CODATA 2018 + thermochemical calorie (4.184 J)" },
                kj: { name: "kJ / mol", symbol: "kJ/mol", factor: 2625.4996394799, desc: "SI derived molar unit. Required for GROMACS topologies and OPLS parameters.", ref: "CODATA 2018 x N_A (SI 2019)" },
                cm: { name: "Inverse cm", symbol: "cm<sup>-1</sup>", factor: 219474.6313632, desc: "Spectroscopic wavenumber. E = hc*nu; 1 E<sub>h</sub> = 219474.63 cm<sup>-1</sup>.", ref: "CODATA 2018: hartree-inverse-metre relationship" },
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
                angstrom: { name: "Angstrom", symbol: "&Aring;", factor: 10.0, desc: "PDB files and AMBER/CHARMM coordinates. 1 A = 10<sup>-10</sup> m exactly.", ref: "Defined: 1 A = 0.1 nm (exact)" },
                bohr: { name: "Bohr radius", symbol: "a<sub>0</sub>", factor: 18.897259886, desc: "Atomic unit of length. a<sub>0</sub> = 0.529177210903 A. Common in QM code outputs.", ref: "CODATA 2018: Bohr radius" },
                pm: { name: "Picometer", symbol: "pm", factor: 1000.0, desc: "Precise bond lengths in crystallography (1 pm = 0.01 A).", ref: "SI 2019 (exact metric prefix)" },
                um: { name: "Micrometer", symbol: "&micro;m", factor: 0.001, desc: "Mesoscale / microscopy scale (1 um = 1000 nm).", ref: "SI 2019 (exact metric prefix)" },
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
                us: { name: "Microsecond", symbol: "&micro;s", factor: 1e-6, desc: "Long-timescale / enhanced-sampling regime.", ref: "SI 2019 (exact metric prefix)" },
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
                gromacs: { name: "GROMACS Force", symbol: "kJ mol<sup>-1</sup> nm<sup>-1</sup>", factor: 1.0, desc: "Standard force unit reported by mdrun and in force-field derivatives.", ref: "GROMACS Reference Manual (unit system)" },
                amber: { name: "AMBER Force", symbol: "kcal mol<sup>-1</sup> &Aring;<sup>-1</sup>", factor: 0.02390057, desc: "AMBER/CHARMM force unit. Derived from 1 kcal = 4.184 kJ and 1 A = 0.1 nm.", ref: "Thermochemical calorie + A definition" },
                ev_ang: { name: "eV per Angstrom", symbol: "eV/&Aring;", factor: 0.01036427, desc: "Gradient unit in VASP, Quantum ESPRESSO, and DFT codes.", ref: "CODATA 2018 (eV) + A definition" },
                hartree_bohr: { name: "Hartree / Bohr", symbol: "E<sub>h</sub> a<sub>0</sub><sup>-1</sup>", factor: 4.960827e-4, desc: "Atomic unit of force (per particle). 1 E<sub>h</sub>/a<sub>0</sub> = 8.2387&times;10<sup>-8</sup> N.", ref: "CODATA 2018: atomic unit of force" },
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
                au_p: { name: "Atomic pressure", symbol: "E<sub>h</sub> a<sub>0</sub><sup>-3</sup>", factor: 3.398927e-9, desc: "Atomic unit of pressure = 2.94210&times;10<sup>13</sup> Pa = 294.21 Mbar.", ref: "CODATA 2018: atomic unit of pressure" }
            }
        },
        dipole: {
            title: "Electric Dipole Moment",
            icon: "fa-magnet",
            color: "cyan",
            note: "Base unit: debye (D). 1 D = 10<sup>-21</sup>/c C&middot;m = 3.335641&times;10<sup>-30</sup> C&middot;m. The atomic unit e&middot;a<sub>0</sub> = 8.4783536255&times;10<sup>-30</sup> C&middot;m = 2.541746 D.",
            units: {
                debye: { name: "Debye", symbol: "D", factor: 1.0, desc: "CGS unit of molecular dipole moment. Water = 1.85 D. Reported by Gaussian/ORCA population analyses.", ref: "Defined: 1 D = 10^-18 statC*cm = 3.335641e-30 C*m" },
                au_dip: { name: "Atomic unit", symbol: "e a<sub>0</sub>", factor: 0.3934303, desc: "Atomic unit of electric dipole moment. QM codes output dipoles in a.u. 1 e*a<sub>0</sub> = 2.541746 D.", ref: "CODATA 2018: a.u. of electric dipole moment (8.4783536255e-30 C*m)" },
                e_ang: { name: "e x Angstrom", symbol: "e &Aring;", factor: 0.2081943, desc: "Charge-times-distance dipole used in classical MD analysis and Bader charges.", ref: "CODATA 2018 (e) + A definition" },
                e_nm: { name: "e x nm", symbol: "e nm", factor: 0.02081943, desc: "GROMACS-style charge x distance dipole (e*nm).", ref: "CODATA 2018 (e) + nm definition" },
                cm_dip: { name: "Coulomb-meter", symbol: "C&middot;m", factor: 3.335641e-30, desc: "SI unit of electric dipole moment.", ref: "CODATA 2018 (e) + SI 2019" }
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
                ang3: { name: "Volume (CGS)", symbol: "&Aring;<sup>3</sup>", factor: 0.14818471, desc: "Volume polarizability, Gaussian-CGS convention. 1 a.u. = 0.148185 A^3. Common in molecular polarizability tables.", ref: "CODATA 2018: a_0^3 in A^3 (Gaussian convention)" },
                si_pol: { name: "SI", symbol: "C<sup>2</sup> m<sup>2</sup> J<sup>-1</sup>", factor: 1.64877727436e-41, desc: "SI unit of electric polarizability (equivalently F*m^2).", ref: "CODATA 2018: a.u. of electric polarizability" }
            }
        },
        spectroscopy: {
            title: "Spectroscopy (E / freq / wavelength)",
            icon: "fa-wave-square",
            color: "indigo",
            note: "Base unit: wavenumber cm<sup>-1</sup>. Related by E = hc*nu = h*f and lambda = 1/nu. Uses h = 6.62607015&times;10<sup>-34</sup> J&middot;s and c = 299792458 m/s (both exact, SI 2019). Wavelength is INVERSE-proportional and is handled specially: edit one field at a time.",
            units: {
                cm1: { name: "Wavenumber", symbol: "cm<sup>-1</sup>", factor: 1.0, desc: "Reciprocal wavelength (energy-proportional). Standard for IR/Raman vibrational spectra.", ref: "SI 2019: c, h exact" },
                thz: { name: "Frequency", symbol: "THz", factor: 0.0299792458, desc: "f = c*nu. 1 cm<sup>-1</sup> = 0.0299792458 THz.", ref: "SI 2019: speed of light (exact)" },
                ghz: { name: "Frequency", symbol: "GHz", factor: 29.9792458, desc: "Microwave rotational spectroscopy. 1 cm<sup>-1</sup> = 29.9792458 GHz.", ref: "SI 2019: speed of light (exact)" },
                mev: { name: "Energy", symbol: "meV", factor: 0.1239841984, desc: "1 cm<sup>-1</sup> = 0.123984 meV. Phonon / THz energy scale.", ref: "SI 2019 + CODATA 2018 (eV)" },
                ev_s: { name: "Energy", symbol: "eV", factor: 1.239841984e-4, desc: "Photon energy. E[eV] = 1.239841984e-4 x nu[cm^-1].", ref: "SI 2019 + CODATA 2018 (eV)" },
                zj: { name: "Energy", symbol: "zJ", factor: 0.01986445857, desc: "Photon energy in zeptojoules (10^-21 J). E = hc*nu.", ref: "SI 2019: h, c exact" },
                wl_nm: { name: "Wavelength", symbol: "nm", factor: 1e7, desc: "lambda = 10^7 / nu[cm^-1]. INVERSE relation - edit this field alone.", ref: "SI 2019: lambda = 1/nu", inverse: true }
            }
        },
        temperature: {
            title: "Temperature",
            icon: "fa-temperature-half",
            color: "red",
            affine: true,
            note: "Base unit: kelvin (K). Celsius and Fahrenheit are OFFSET scales, converted with affine formulas rather than a single ratio. k<sub>B</sub>T energy equivalents use k<sub>B</sub> = 1.380649&times;10<sup>-23</sup> J/K (exact, SI 2019).",
            units: {
                k: { name: "Kelvin", symbol: "K", desc: "SI base unit of thermodynamic temperature. MD thermostats (ref_t) use K.", ref: "SI 2019: defined via k_B (exact)" },
                c: { name: "Celsius", symbol: "&deg;C", desc: "degC = K - 273.15. Offset scale.", ref: "Defined: T[K] = T[C] + 273.15" },
                f: { name: "Fahrenheit", symbol: "&deg;F", desc: "degF = (K - 273.15)*9/5 + 32. Offset scale.", ref: "Defined via Celsius (exact)" },
                kt_kj: { name: "k<sub>B</sub>T", symbol: "kJ/mol", desc: "Thermal energy N_A*k_B*T. At 300 K = 2.494 kJ/mol.", ref: "SI 2019: k_B, N_A (exact)" },
                kt_kcal: { name: "k<sub>B</sub>T", symbol: "kcal/mol", desc: "Thermal energy in kcal/mol. At 300 K = 0.596 kcal/mol (= RT).", ref: "SI 2019: k_B, N_A + thermochemical calorie" },
                kt_mev: { name: "k<sub>B</sub>T", symbol: "meV", desc: "Thermal energy per particle. At 300 K = 25.85 meV.", ref: "SI 2019: k_B + CODATA 2018 (eV)" }
            }
        },
        heatcap: {
            title: "Heat Capacity & Entropy",
            icon: "fa-fire",
            color: "fuchsia",
            note: "Base unit: J mol<sup>-1</sup> K<sup>-1</sup>. The molar gas constant R = N<sub>A</sub>k<sub>B</sub> = 8.314462618 J mol<sup>-1</sup> K<sup>-1</sup> (exact, SI 2019) relates these entries.",
            units: {
                j_molk: { name: "J / (mol K)", symbol: "J mol<sup>-1</sup> K<sup>-1</sup>", factor: 1.0, desc: "SI molar heat capacity / entropy. Output of thermochemistry (freq) jobs.", ref: "SI 2019: R = 8.314462618 (exact)" },
                cal_molk: { name: "cal / (mol K) [e.u.]", symbol: "cal mol<sup>-1</sup> K<sup>-1</sup>", factor: 0.2390057361, desc: "Entropy unit (e.u., 'gibbs'). Common in older thermochemistry tables. 1 cal = 4.184 J.", ref: "Thermochemical calorie (4.184 J exact)" },
                kj_molk: { name: "kJ / (mol K)", symbol: "kJ mol<sup>-1</sup> K<sup>-1</sup>", factor: 0.001, desc: "SI molar unit scaled by 1000.", ref: "SI 2019 (exact prefix)" },
                r_units: { name: "In units of R", symbol: "R", factor: 0.120272356, desc: "Dimensionless multiples of the gas constant R. C_v of a monatomic ideal gas = 1.5 R.", ref: "SI 2019: R = 8.314462618 (exact)" },
                kb_units: { name: "k<sub>B</sub> per particle", symbol: "k<sub>B</sub>", factor: 0.120272356, desc: "Per-particle entropy in units of k_B (numerically equal to multiples of R per mole).", ref: "SI 2019: k_B = 1.380649e-23 J/K (exact)" }
            }
        }
    };

    /* ============================================================
       # --- 2. Interface bindings ---
       ============================================================ */
    const matrixGrid = document.getElementById('matrixGrid');
    const tabs = document.querySelectorAll('.cat-tab');
    const categoryBadge = document.getElementById('categoryBadge');
    const categoryIcon = document.getElementById('categoryIcon');
    const categoryName = document.getElementById('categoryName');
    const categoryNote = document.getElementById('categoryNote');
    const btnReset = document.getElementById('btnReset');
    const toastContainer = document.getElementById('toastContainer');

    let activeCategory = 'energy';
    let activeColor = 'orange';

    /* ============================================================
       # --- 3. Dynamic rendering engine ---
       ============================================================ */
    function renderGrid(categoryKey) {
        activeCategory = categoryKey;
        const catData = UNIT_DB[categoryKey];
        activeColor = catData.color;

        categoryIcon.className = `fa-solid ${catData.icon}`;
        categoryName.innerText = catData.title;
        categoryBadge.className = `inline-flex items-center gap-2 bg-${activeColor}-100 dark:bg-${activeColor}-900/30 text-${activeColor}-700 dark:text-${activeColor}-400 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest mb-4 border border-${activeColor}-200 dark:border-${activeColor}-800/50 transition-colors`;

        if (categoryNote) {
            categoryNote.innerHTML = catData.note ? `<i class="fa-solid fa-circle-info mr-1 text-${activeColor}-500"></i> ${catData.note}` : '';
            categoryNote.style.display = catData.note ? 'block' : 'none';
        }

        tabs.forEach(tab => {
            const isActive = tab.getAttribute('data-cat') === categoryKey;
            const tColor = tab.getAttribute('data-color');

            if (isActive) {
                tab.className = `cat-tab px-5 py-2.5 rounded-xl text-sm transition-all border border-${tColor}-300 dark:border-${tColor}-700 bg-${tColor}-50 dark:bg-${tColor}-900/20 text-${tColor}-700 dark:text-${tColor}-300 font-bold whitespace-nowrap shadow-sm`;
            } else {
                tab.className = `cat-tab px-5 py-2.5 rounded-xl text-sm transition-all border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap`;
            }
        });

        matrixGrid.innerHTML = '';
        Object.entries(catData.units).forEach(([unitKey, unitData]) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'flex flex-col gap-1.5 relative';

            const refLine = unitData.ref
                ? `<div class="mt-2 pt-2 border-t border-slate-600/60 text-xs text-slate-300 flex items-start gap-1.5"><i class="fa-solid fa-book-bookmark mt-[3px]"></i><span>${unitData.ref}</span></div>`
                : '';

            wrapper.innerHTML = `
                <div class="flex justify-between items-center">
                    <label class="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                        ${unitData.name} (${unitData.symbol})
                        <span class="info-trigger">
                            <i class="fa-solid fa-circle-info info-icon text-xs"></i>
                            <div class="tooltip absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-80 max-w-[80vw] p-4 bg-slate-800 text-white text-sm rounded-xl shadow-2xl z-50 font-normal leading-relaxed text-left">
                                ${unitData.desc}
                                ${refLine}
                            </div>
                        </span>
                    </label>
                </div>
                <div class="relative flex items-center">
                    <input type="text" inputmode="decimal" id="val_${unitKey}" data-unit="${unitKey}" class="unit-input w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl p-3 pr-12 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-${activeColor}-500 transition-all" placeholder="0.0">
                    <button class="copy-btn absolute right-3 text-slate-400 hover:text-${activeColor}-500 transition-colors" data-target="val_${unitKey}" title="Copy value"><i class="fa-regular fa-copy"></i></button>
                </div>
            `;
            matrixGrid.appendChild(wrapper);
        });

        bindMatrixEvents();
    }

    /* ============================================================
       # --- 4. Mathematical scaling engine ---
       ============================================================ */
    function formatOutput(value) {
        if (value === 0 || Number.isNaN(value) || !Number.isFinite(value)) return "";
        const absVal = Math.abs(value);
        if (absVal > 1e7 || absVal < 1e-4) {
            return value.toExponential(6);
        }
        return parseFloat(value.toFixed(8)).toString();
    }

    function parseInput(valStr) {
        const cleanStr = valStr.replace(/,/g, '').trim();
        if (cleanStr === '' || cleanStr === '-' || cleanStr === '.') return null;
        const num = Number(cleanStr);
        return isNaN(num) ? null : num;
    }

    /* --- Affine (offset) conversion for temperature --- */
    function tempToKelvin(value, unitKey) {
        switch (unitKey) {
            case 'k': return value;
            case 'c': return value + 273.15;
            case 'f': return (value - 32) * 5 / 9 + 273.15;
            case 'kt_kj': return value * 1000 / 8.314462618;
            case 'kt_kcal': return value * 4184 / 8.314462618;
            case 'kt_mev': return value * 1.602176634e-22 / 1.380649e-23;
            default: return value;
        }
    }
    function kelvinToUnit(K, unitKey) {
        switch (unitKey) {
            case 'k': return K;
            case 'c': return K - 273.15;
            case 'f': return (K - 273.15) * 9 / 5 + 32;
            case 'kt_kj': return K * 8.314462618 / 1000;
            case 'kt_kcal': return K * 8.314462618 / 4184;
            case 'kt_mev': return K * 1.380649e-23 / 1.602176634e-22;
            default: return K;
        }
    }

    function executeConversion(sourceValue, sourceUnitKey) {
        const catData = UNIT_DB[activeCategory];
        const inputs = document.querySelectorAll('.unit-input');

        if (catData.affine) {
            const K = tempToKelvin(sourceValue, sourceUnitKey);
            inputs.forEach(input => {
                const targetKey = input.getAttribute('data-unit');
                if (targetKey !== sourceUnitKey) {
                    input.value = formatOutput(kelvinToUnit(K, targetKey));
                }
            });
            return;
        }

        const sourceUnit = catData.units[sourceUnitKey];
        const sourceFactor = sourceUnit.factor;

        let normalizedBase;
        if (sourceUnit.inverse) {
            normalizedBase = sourceFactor / sourceValue;
        } else {
            normalizedBase = sourceValue / sourceFactor;
        }

        inputs.forEach(input => {
            const targetKey = input.getAttribute('data-unit');
            if (targetKey !== sourceUnitKey) {
                const targetUnit = catData.units[targetKey];
                if (targetUnit.inverse) {
                    input.value = formatOutput(targetUnit.factor / normalizedBase);
                } else {
                    input.value = formatOutput(normalizedBase * targetUnit.factor);
                }
            }
        });
    }

    function bindMatrixEvents() {
        const inputs = document.querySelectorAll('.unit-input');
        const copyBtns = document.querySelectorAll('.copy-btn');

        inputs.forEach(input => {
            input.addEventListener('input', (e) => {
                const rawVal = e.target.value;
                const parsedValue = parseInput(rawVal);

                if (parsedValue !== null) {
                    executeConversion(parsedValue, e.target.getAttribute('data-unit'));
                } else if (rawVal.trim() === '') {
                    inputs.forEach(inp => { if (inp !== e.target) inp.value = ''; });
                }
            });

            input.addEventListener('focus', (e) => {
                inputs.forEach(inp => inp.classList.remove(`bg-${activeColor}-50`, `dark:bg-${activeColor}-900/20`, `border-${activeColor}-400`));
                e.target.classList.add(`bg-${activeColor}-50`, `dark:bg-${activeColor}-900/20`, `border-${activeColor}-400`);
            });
        });

        copyBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetId = e.currentTarget.getAttribute('data-target');
                const targetInput = document.getElementById(targetId);

                if (targetInput.value) {
                    navigator.clipboard.writeText(targetInput.value).then(() => {
                        showToast('Value copied to clipboard!');
                        const icon = e.currentTarget.querySelector('i');
                        icon.className = 'fa-solid fa-check text-emerald-500';
                        setTimeout(() => { icon.className = 'fa-regular fa-copy'; }, 1500);
                    });
                }
            });
        });
    }

    /* ============================================================
       # --- 5. Global listeners ---
       ============================================================ */
    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            renderGrid(e.currentTarget.getAttribute('data-cat'));
        });
    });

    btnReset.addEventListener('click', () => {
        const inputs = document.querySelectorAll('.unit-input');
        inputs.forEach(input => {
            input.value = '';
            input.classList.remove(`bg-${activeColor}-50`, `dark:bg-${activeColor}-900/20`, `border-${activeColor}-400`);
        });
    });

    function showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'bg-slate-800 text-white text-xs font-bold px-4 py-2 rounded-lg shadow-xl transform transition-all duration-300 translate-y-[-20px] opacity-0';
        toast.innerText = message;

        toastContainer.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.remove('translate-y-[-20px]', 'opacity-0');
            toast.classList.add('translate-y-0', 'opacity-100');
        });

        setTimeout(() => {
            toast.classList.remove('translate-y-0', 'opacity-100');
            toast.classList.add('translate-y-[-20px]', 'opacity-0');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    /* --- Documentation engine tabs (Method & References) --- */
    document.querySelectorAll('.doc-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const key = tab.getAttribute('data-doc-tab');
            document.querySelectorAll('.doc-tab').forEach(t => t.classList.toggle('active', t === tab));
            document.querySelectorAll('.doc-pane').forEach(p =>
                p.classList.toggle('active', p.getAttribute('data-doc-pane') === key));
        });
    });

    // # Initiating the grid rendering call
    renderGrid('energy');
});
