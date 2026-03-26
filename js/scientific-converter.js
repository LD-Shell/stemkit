document.addEventListener('DOMContentLoaded', () => {

    // # --- 1. Master scientific dictionary ---
    const UNIT_DB = {
        energy: {
            title: "Energy & Thermodynamics",
            icon: "fa-bolt",
            color: "orange",
            units: {
                hartree: { name: "Hartree", symbol: "E<sub>h</sub>", factor: 1.0, desc: "Atomic unit of energy. Standard for quantum chemistry (Gaussian, ORCA)." },
                ev: { name: "Electron-volt", symbol: "eV", factor: 27.211386245988, desc: "Common in solid-state physics and band-gap calculations." },
                kcal: { name: "kcal / mol", symbol: "kcal/mol", factor: 627.5094740631, desc: "Standard for organic chemistry and AMBER/CHARMM force fields." },
                kj: { name: "kJ / mol", symbol: "kJ/mol", factor: 2625.4996394799, desc: "Standard SI derived unit. Required for GROMACS topologies." },
                cm: { name: "Inverse cm", symbol: "cm<sup>-1</sup>", factor: 219474.6313632, desc: "Spectroscopic unit (wavenumbers) for vibrational frequency." },
                kelvin: { name: "Kelvin eq.", symbol: "K", factor: 315775.024804, desc: "Thermal energy equivalent (E / k_B)." },
                joule: { name: "Joule", symbol: "J", factor: 4.3597447222071e-18, desc: "Standard macroscopic SI unit of energy." }
            }
        },
        length: {
            title: "Distance & Length",
            icon: "fa-ruler",
            color: "blue",
            units: {
                nm: { name: "Nanometer", symbol: "nm", factor: 1.0, desc: "Standard distance unit in GROMACS." },
                angstrom: { name: "Angstrom", symbol: "Å", factor: 10.0, desc: "Standard distance unit in PDB files and AMBER/CHARMM." },
                bohr: { name: "Bohr radius", symbol: "a<sub>0</sub>", factor: 18.897259886, desc: "Atomic unit of length. Common in QM outputs." },
                pm: { name: "Picometer", symbol: "pm", factor: 1000.0, desc: "Used for precise bond lengths in crystallography." },
                cm: { name: "Centimeter", symbol: "cm", factor: 1e-7, desc: "Macroscopic scale." },
                m: { name: "Meter", symbol: "m", factor: 1e-9, desc: "Base SI unit." }
            }
        },
        time: {
            title: "Time & Dynamics",
            icon: "fa-clock",
            color: "emerald",
            units: {
                ps: { name: "Picosecond", symbol: "ps", factor: 1.0, desc: "Standard time unit in GROMACS." },
                ns: { name: "Nanosecond", symbol: "ns", factor: 0.001, desc: "Common scale for reporting MD production run lengths." },
                fs: { name: "Femtosecond", symbol: "fs", factor: 1000.0, desc: "Typical MD integration timestep (usually 1-2 fs)." },
                au: { name: "Atomic time", symbol: "a.u.", factor: 41341.373335, desc: "Atomic unit of time. 1 a.u. ≈ 0.024 fs." },
                s: { name: "Second", symbol: "s", factor: 1e-12, desc: "Base SI unit." }
            }
        },
        force: {
            title: "Force & Gradients",
            icon: "fa-arrow-down-up-across-line",
            color: "purple",
            units: {
                gromacs: { name: "GROMACS Force", symbol: "kJ mol<sup>-1</sup> nm<sup>-1</sup>", factor: 1.0, desc: "Standard force unit in GROMACS mdrun." },
                amber: { name: "AMBER Force", symbol: "kcal mol<sup>-1</sup> Å<sup>-1</sup>", factor: 0.02390057, desc: "Standard force unit in AMBER/CHARMM." },
                ev_ang: { name: "eV per Angstrom", symbol: "eV/Å", factor: 0.01036427, desc: "Common gradient unit in VASP and Quantum ESPRESSO." },
                pn: { name: "Piconewton", symbol: "pN", factor: 1.660539, desc: "Common in AFM and single-molecule pulling experiments." },
                newton: { name: "Newton", symbol: "N", factor: 1.660539e-12, desc: "Base SI unit." }
            }
        },
        pressure: {
            title: "Pressure & Stress",
            icon: "fa-compress",
            color: "rose",
            units: {
                bar: { name: "Bar", symbol: "bar", factor: 1.0, desc: "Standard pressure unit in GROMACS." },
                atm: { name: "Atmosphere", symbol: "atm", factor: 0.986923, desc: "Standard physical atmosphere." },
                pa: { name: "Pascal", symbol: "Pa", factor: 100000.0, desc: "Base SI unit." },
                mpa: { name: "Megapascal", symbol: "MPa", factor: 0.1, desc: "Common stress unit in materials science." },
                gpa: { name: "Gigapascal", symbol: "GPa", factor: 0.0001, desc: "Common for bulk modulus and extreme pressures." }
            }
        }
    };

    // # --- 2. Interface bindings ---
    const matrixGrid = document.getElementById('matrixGrid');
    const tabs = document.querySelectorAll('.cat-tab');
    const categoryBadge = document.getElementById('categoryBadge');
    const categoryIcon = document.getElementById('categoryIcon');
    const categoryName = document.getElementById('categoryName');
    const btnReset = document.getElementById('btnReset');
    const toastContainer = document.getElementById('toastContainer');

    let activeCategory = 'energy';
    let activeColor = 'orange';

    // # --- 3. Dynamic rendering engine ---
    function renderGrid(categoryKey) {
        activeCategory = categoryKey;
        const catData = UNIT_DB[categoryKey];
        activeColor = catData.color;

        categoryIcon.className = `fa-solid ${catData.icon}`;
        categoryName.innerText = catData.title;
        categoryBadge.className = `inline-flex items-center gap-2 bg-${activeColor}-100 dark:bg-${activeColor}-900/30 text-${activeColor}-700 dark:text-${activeColor}-400 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest mb-4 border border-${activeColor}-200 dark:border-${activeColor}-800/50 transition-colors`;

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
            
            wrapper.innerHTML = `
                <div class="flex justify-between items-center">
                    <label class="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2 info-group cursor-help">
                        ${unitData.name} (${unitData.symbol})
                        <i class="fa-solid fa-circle-info text-slate-400 text-xs"></i>
                        <div class="tooltip absolute bottom-full left-0 mb-2 w-64 p-2 bg-slate-800 text-white text-xs rounded shadow-lg z-10 font-normal">
                            ${unitData.desc}
                        </div>
                    </label>
                </div>
                <div class="relative flex items-center">
                    <input type="text" id="val_${unitKey}" data-unit="${unitKey}" class="unit-input w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl p-3 pr-12 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-${activeColor}-500 transition-all" placeholder="0.0">
                    <button class="copy-btn absolute right-3 text-slate-400 hover:text-${activeColor}-500 transition-colors" data-target="val_${unitKey}" title="Copy value"><i class="fa-regular fa-copy"></i></button>
                </div>
            `;
            matrixGrid.appendChild(wrapper);
        });

        bindMatrixEvents();
    }

    // # --- 4. Mathematical scaling engine ---
    function formatOutput(value) {
        if (value === 0) return "";
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

    function executeConversion(sourceValue, sourceUnitKey) {
        const catData = UNIT_DB[activeCategory];
        const sourceFactor = catData.units[sourceUnitKey].factor;
        
        // # I am transforming the user input into a standardized base reference scalar
        const normalizedBase = sourceValue / sourceFactor;

        // # I am mapping the normalized scalar across all active output fields to ensure synchronous updates
        const inputs = document.querySelectorAll('.unit-input');
        inputs.forEach(input => {
            const targetKey = input.getAttribute('data-unit');
            if (targetKey !== sourceUnitKey) {
                const targetFactor = catData.units[targetKey].factor;
                input.value = formatOutput(normalizedBase * targetFactor);
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

    // # --- 5. Global listeners ---
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

    document.querySelectorAll('.themeToggle').forEach(btn => btn.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    }));

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

    // # Initiating the grid rendering call
    renderGrid('energy');
});