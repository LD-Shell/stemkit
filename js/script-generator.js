/*
 * STEMKit, MD Workflow Generator (SLURM, PBS, LSF, Grid Engine + GROMACS/LAMMPS/PLUMED)
 * Author: Olanrewaju M. Daramola
 *
 * Client-side only. Generates batch scripts for four schedulers, a staged
 * GROMACS workflow (EM / NVT / NPT / Production with grompp->mdrun chaining),
 * a GROMACS .top header, LAMMPS submission scripts and PLUMED input files.
 * The directive header comes from src/core/scheduler.js through the adapter
 * in script-generator-slurm.js and the PLUMED input from src/core/plumed.js
 * through script-generator-plumed.js; this file is DOM wiring and the engine
 * blocks.
 *
 * Correctness references (see on-page "Method & References"):
 *  - Force field <-> combination rule <-> fudge factors are coupled:
 *        AMBER    : comb 2, fudgeLJ 0.5, fudgeQQ 0.8333
 *        CHARMM36 : comb 2, fudgeLJ 1.0, fudgeQQ 1.0
 *        OPLS-AA  : comb 3, fudgeLJ 0.5, fudgeQQ 0.5
 *    (GROMACS manual + shipped forcefield.itp files.)
 *  - GROMACS staging: each grompp -c reads the previous stage .gro; -t reads
 *    the previous .cpt (continuation) when that stage was MD, since energy
 *    minimisation writes no checkpoint; -r supplies the restraint reference
 *    (often identical to -c) when position restraints are used.
 *  - GROMACS GPU offload: gmx mdrun -nb gpu -pme gpu -bonded gpu -update gpu.
 *  - GROMACS is threaded (set --cpus-per-task); LAMMPS is MPI-parallel
 *    (set --ntasks-per-node). LAMMPS GPU: -sf gpu -pk gpu N ; KOKKOS: -k on g N -sf kk.
 *  - #!/bin/bash -e so failures abort and show as FAILED in sacct.
 */

import { buildHeaderFromDOM } from './script-generator-slurm.js';
import { getScheduler, envVars, launcher, submitCommand } from '../src/core/scheduler.js';
import { estimateCoreHours, arrayConcurrency } from '../src/core/slurm.js';
import { createPlumedBuilder } from './script-generator-plumed.js';

document.addEventListener('DOMContentLoaded', () => {

    const $ = (id) => document.getElementById(id);
    const escapeHtml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // =====================================================================
    // Canonical force-field parameter table
    // =====================================================================
    // `dir` is the force-field directory the #include lines name. AMBER99SB-ILDN
    // and OPLS-AA ship with GROMACS under these names; CHARMM36 does not, so
    // it names the MacKerell lab port and the header says where to get it.
    const FF_PRESETS = {
        'amber99sb-ildn': { label: 'AMBER99SB-ILDN', comb: '2', fudgeLJ: '0.5', fudgeQQ: '0.8333', family: 'amber',  dir: 'amber99sb-ildn.ff' },
        'charmm36':       { label: 'CHARMM36',       comb: '2', fudgeLJ: '1.0', fudgeQQ: '1.0',    family: 'charmm', dir: 'charmm36-jul2022.ff', download: true },
        'opls-aa':        { label: 'OPLS-AA',        comb: '3', fudgeLJ: '0.5', fudgeQQ: '0.5',    family: 'opls',   dir: 'oplsaa.ff' }
    };

    // =====================================================================
    // Shared state
    // =====================================================================
    let currentEngine = 'gromacs'; // 'gromacs' | 'lammps' | 'plumed'
    let manualOverride = false;

    // =====================================================================
    // Helpers
    // =====================================================================
    function toggleVisibility(el, show) {
        if (el) el.hidden = !show;
    }

    function setWarnings(container, messages) {
        if (!container) return;
        container.hidden = !messages.length;
        container.innerHTML = messages.length
            ? `<i class="fa-solid fa-triangle-exclamation"></i><div class="sg-warn-list">` +
              messages.map(m => `<p>${m}</p>`).join('') + `</div>`
            : '';
    }

    function getInt(id, dflt) {
        const v = parseInt(($(id)?.value || ''), 10);
        return Number.isFinite(v) ? v : dflt;
    }
    function getStr(id, dflt) {
        const v = ($(id)?.value || '').trim();
        return v || dflt;
    }
    // Optional sections are role="switch" buttons; the rest are checkboxes.
    function isChecked(id) {
        const el = $(id);
        if (!el) return false;
        return el.getAttribute('role') === 'switch' ? el.getAttribute('aria-checked') === 'true' : !!el.checked;
    }
    function currentScheduler() {
        const id = getStr('jobScheduler', 'slurm');
        try { return getScheduler(id).id; } catch (_) { return 'slurm'; }
    }

    // =====================================================================
    // Scheduler header: built by the tested core (src/core/scheduler.js,
    // which hands SLURM to src/core/slurm.js) through the adapter in
    // script-generator-slurm.js, which reads the form via the DOM helpers
    // above. Same shape as the local SLURM function it replaced.
    // =====================================================================
    const buildSchedulerHeader = (engine, warnings) =>
        buildHeaderFromDOM(engine, warnings, { $, getStr, getInt, isChecked });

    // SLURM and PBS expose the per-task thread count inside the job; LSF and
    // Grid Engine count slots, so for them the requested number is written in,
    // next to the directive it matches.
    const OMP_NOTE = {
        pbs: '# PBS sets NCPUS (and OMP_NUM_THREADS) from ompthreads for rank 0, per\n' +
             '# pbs_resources(7B); the requested count is the fallback.',
        lsf: '# LSF reports slots (LSB_DJOB_NUMPROC), not threads per task; this matches the\n' +
             '# ptile requested above.',
        sge: '# Grid Engine reports slots (NSLOTS), not threads per task; this matches the PE\n' +
             '# request above.'
    };

    // The OMP_NUM_THREADS export for a scheduler other than SLURM. `threads`
    // has the same floor the core applies to the header's thread count.
    function ompExport(scheduler, threads) {
        const n = Math.max(1, threads);
        const value = scheduler === 'pbs' ? `\${NCPUS:-${n}}` : String(n);
        return `${OMP_NOTE[scheduler]}\nexport OMP_NUM_THREADS=${value}\n\n`;
    }

    function envBlock(engine, scheduler) {
        let e = `\n# --- Environment ---\n`;
        if (scheduler === 'pbs') {
            e += `# PBS starts the job in $HOME; work where qsub ran.\n`;
            e += `cd "$PBS_O_WORKDIR"\n`;
        } else if (scheduler === 'lsf') {
            e += `# LSF starts in the submission directory when the node can see it; be explicit.\n`;
            e += `cd "$LS_SUBCWD"\n`;
        }
        e += `mkdir -p logs\n`;
        e += `module purge\n`;
        if (engine === 'gromacs') {
            e += `module load gromacs/2023   # adjust to your cluster's module name\n\n`;
            if (scheduler === 'slurm') {
                e += `# Match OpenMP threads to the CPUs Slurm granted.\n`;
                e += `export OMP_NUM_THREADS=\${SLURM_CPUS_PER_TASK:-1}\n`;
                e += `# Slurm > 22.05: also export for srun-launched steps.\n`;
                e += `export SRUN_CPUS_PER_TASK=\$SLURM_CPUS_PER_TASK\n\n`;
            } else {
                e += ompExport(scheduler, getInt('jobCpus', 1));
            }
        } else {
            e += `module load lammps         # adjust to your cluster's module name\n\n`;
            e += `# LAMMPS is MPI-parallel; threads per rank matter only with the OPENMP\n`;
            e += `# package (or KOKKOS built with its OpenMP backend).\n`;
            if (scheduler === 'slurm') {
                e += `export OMP_NUM_THREADS=\${SLURM_CPUS_PER_TASK:-1}\n`;
                // srun, which launches LAMMPS, no longer inherits --cpus-per-task,
                // so a threaded run would put every thread of a rank on one core.
                if (getInt('lmpCpus', 1) > 1) {
                    e += `# Slurm > 22.05: srun does not inherit --cpus-per-task; export it.\n`;
                    e += `export SRUN_CPUS_PER_TASK=\$SLURM_CPUS_PER_TASK\n`;
                }
                e += `\n`;
            } else {
                e += ompExport(scheduler, getInt('lmpCpus', 1));
            }
        }
        return e;
    }

    // How each scheduler hands the allocation to mpirun; srun needs no note.
    const LAUNCH_NOTE = {
        pbs: '# PBS_NODEFILE has one line per MPI rank. An MPI built with PBS (TM) support\n' +
             '# reads it itself; otherwise add -machinefile "$PBS_NODEFILE".',
        lsf: '# LSB_DJOB_NUMPROC is the slot count of the allocation; Open MPI and Intel MPI\n' +
             '# with LSF integration also take the host list from LSB_MCPU_HOSTS.',
        sge: '# NSLOTS is the slot count of the PE; Open MPI and MPICH built with Grid Engine\n' +
             '# support read the host list from $PE_HOSTFILE.'
    };

    // =====================================================================
    // GROMACS: GPU flag string from advanced toggles.
    // Encodes rules from the GROMACS "Getting good performance from mdrun"
    // guide. Returns { flags, warnings }.
    // =====================================================================
    function gmxGpuFlags() {
        const gpus = getInt('jobGpus', 0);
        if (gpus <= 0) return { flags: '', warnings: [] };

        const warnings = [];
        const nb     = isChecked('gpuNb');
        const pme    = isChecked('gpuPme');
        const bonded = isChecked('gpuBonded');
        const update = isChecked('gpuUpdate');
        const ntmpiStr = getStr('gpuNtmpi', '');
        const ntmpi = parseInt(ntmpiStr, 10);

        const flags = [];
        if (nb)     flags.push('-nb gpu');
        if (pme)    flags.push('-pme gpu');
        if (bonded) flags.push('-bonded gpu');
        if (update) flags.push('-update gpu');
        if (ntmpiStr) flags.push(`-ntmpi ${ntmpiStr}`);

        // Rule: bonded offload requires the short-range non-bonded task on GPU.
        if (bonded && !nb) {
            warnings.push('<code>-bonded gpu</code> requires the short-range non-bonded task on the GPU too. Enable <code>-nb gpu</code>.');
        }

        // Rule: PME on GPU supports only a single PME rank. If more than one
        // rank is requested, pin -npme 1 automatically.
        if (pme && Number.isFinite(ntmpi) && ntmpi > 1) {
            if (!flags.some(f => f.startsWith('-npme'))) {
                flags.push('-npme 1');
            }
            warnings.push('PME on GPU supports only one PME rank, so <code>-npme 1</code> was added automatically.');
        }

        // Note: GPU-resident mode (-update gpu) is incompatible with dynamic
        // load balancing and needs constraints = h-bonds: the GPU constraint
        // code takes only small coupled groups, and all-bonds on a protein
        // couples far more than that.
        if (update) {
            warnings.push('<strong>Action needed in your .mdp:</strong> <code>-update gpu</code> (GPU-resident mode) <strong>requires <code>constraints = h-bonds</code></strong>, not <code>all-bonds</code>. With all-bonds on a protein, <code>mdrun</code> refuses the GPU update at startup; the cause is your .mdp, not this script. GPU-resident mode also disables dynamic load balancing; for efficiency use infrequent T/P coupling and a larger <code>nstcalcenergy</code>.');
        }

        return { flags: flags.length ? ' ' + flags.join(' ') : '', warnings };
    }

    // =====================================================================
    // GROMACS staged workflow
    // =====================================================================
    // Stage definitions come from the DOM. Each stage row has:
    //   toggle checkbox (data-stage), mdp input, deffnm input, posres checkbox
    const GMX_STAGES = ['em', 'nvt', 'npt', 'prod'];

    function readStage(key) {
        return {
            key,
            enabled: isChecked(`stage_${key}_on`),
            mdp:     getStr(`stage_${key}_mdp`, `${key}.mdp`),
            deffnm:  getStr(`stage_${key}_deffnm`, key),
            posres:  isChecked(`stage_${key}_posres`)
        };
    }

    function generateGromacsScript() {
        const out = $('slurmOutput');
        if (!out) return;
        const warnings = [];

        const { header, isArray, scheduler } = buildSchedulerHeader('gromacs', warnings);
        let s = header;
        s += envBlock('gromacs', scheduler);

        s += `# --- Execution ---\n`;

        if (isArray) {
            const baseDir = getStr('jobArrayDir', 'run_');
            s += `# One directory per array task.\n`;
            s += `SYSTEM_DIR="${baseDir}\${${envVars(scheduler).arrayIndex}}"\n`;
            s += `cd "\$SYSTEM_DIR" || { echo "Missing directory \$SYSTEM_DIR" >&2; exit 1; }\n\n`;
        }

        const topol = getStr('gmxTopol', 'topol.top');
        const startConf = getStr('gmxStartConf', 'system.gro');
        const ndx = getStr('gmxIndex', '');
        // GROMACS executable name. Many HPC modules ship the MPI build as
        // gmx_mpi, so this is user-settable rather than hardcoded.
        const gmxBin = (getStr('gmxBinary', 'gmx') || 'gmx').trim() || 'gmx';
        if (/\s/.test(gmxBin)) {
            warnings.push(`The GROMACS executable name "<code>${gmxBin}</code>" contains a space. Use just the command name (e.g. <code>gmx</code> or <code>gmx_mpi</code>).`);
        }
        const ndxFlag = ndx ? ` -n ${ndx}` : '';
        const gpuResult = gmxGpuFlags();
        const gpuFlags = gpuResult.flags;
        gpuResult.warnings.forEach(w => { if (!warnings.includes(w)) warnings.push(w); });

        // Optional PLUMED coupling for GROMACS mdrun.
        const usePlumed = isChecked('gmxUsePlumed');
        const plumedFile = getStr('gmxPlumedFile', 'plumed.dat');
        const plumedScope = getStr('gmxPlumedScope', 'prod'); // 'prod' | 'all'

        const stages = GMX_STAGES.map(readStage).filter(st => st.enabled);

        if (!stages.length) {
            s += `# (No workflow stages enabled, enable EM/NVT/NPT/Production on the left.)\n`;
            renderOutput(out, s);
            setWarnings($('slurmWarnings'), warnings);
            return;
        }

        // Warn if a restrained stage lacks a prior coordinate source is fine;
        // but warn if production has restraints (unusual).
        stages.forEach(st => {
            if (st.key === 'prod' && st.posres) {
                warnings.push('Production stage has position restraints enabled, unusual; restraints are normally released for production.');
            }
        });

        // If GPU-resident mode is on, put the .mdp requirement INTO the script.
        // UI warnings are lost the moment someone copies the file, and grompp
        // fails before mdrun runs, users otherwise blame the generated script.
        if (isChecked('gpuUpdate')) {
            s += `# ==============================================================\n`;
            s += `# IMPORTANT - '-update gpu' requires this in EVERY MD .mdp file:\n`;
            s += `#     constraints = h-bonds      ; not all-bonds\n`;
            s += `# With all-bonds on a protein, mdrun refuses the GPU update at\n`;
            s += `# startup. That error comes from the .mdp, not from this script.\n`;
            s += `# ==============================================================\n\n`;
        }

        // mdrun gets -ntomp $OMP_NUM_THREADS. The two must agree (mdrun stops
        // when they differ), so with several thread-MPI ranks (-ntmpi, GPU
        // runs only) the variable itself is divided between the ranks.
        const ntmpi = getInt('jobGpus', 0) > 0 ? getInt('gpuNtmpi', 0) : 0;
        if (ntmpi > 1) {
            const cpus = getInt('jobCpus', 1);
            if (cpus < ntmpi) {
                warnings.push(`CPUs per task (${cpus}) is below <code>-ntmpi ${ntmpi}</code>; each thread-MPI rank needs at least one CPU.`);
            } else if (cpus % ntmpi !== 0) {
                warnings.push(`CPUs per task (${cpus}) is not a multiple of <code>-ntmpi ${ntmpi}</code>, so some cores stay idle. Pick a CPU count that divides evenly between the ranks.`);
            }
            s += `# -ntmpi ${ntmpi}: share the task's CPUs between the thread-MPI ranks.\n`;
            s += `export OMP_NUM_THREADS=$((OMP_NUM_THREADS / ${ntmpi}))\n\n`;
        }

        let prev = null; // previous stage (for -c / -t wiring)
        stages.forEach((st, i) => {
            const tpr = `${st.deffnm}.tpr`;
            s += `# ---- ${st.key.toUpperCase()} ----\n`;

            // grompp: -c from previous stage .gro (or initial conf), -r for restraints,
            // -t from the previous stage's .cpt for continuation. Energy
            // minimisation writes no checkpoint, so the stage after it gets no -t.
            let grompp = `${gmxBin} grompp -f ${st.mdp} -p ${topol}${ndxFlag}`;
            const cSource = prev ? `${prev.deffnm}.gro` : startConf;
            grompp += ` -c ${cSource}`;
            if (st.posres) grompp += ` -r ${cSource}`;   // restraint reference (often == -c)
            if (prev && prev.key !== 'em') grompp += ` -t ${prev.deffnm}.cpt`; // continuation
            grompp += ` -o ${tpr}`;
            s += grompp + `\n`;

            // mdrun. Energy minimisation is not an MD integrator, so drop
            // -update gpu and the checkpoint restart there; keep -nb/-pme.
            let stageGpu = gpuFlags;
            if (st.key === 'em') {
                stageGpu = stageGpu.replace(' -update gpu', '');
            }
            let mdrun = `${gmxBin} mdrun -deffnm ${st.deffnm}${stageGpu} -ntomp $OMP_NUM_THREADS -pin on`;
            if (st.key !== 'em') {
                // -cpi allows a safe restart; harmless if the .cpt is absent.
                mdrun += ` -cpi ${st.deffnm}.cpt`;
            }
            // Optional PLUMED: attach to production only, or to every MD stage.
            if (usePlumed) {
                const attachHere = plumedScope === 'all'
                    ? (st.key !== 'em')       // all MD stages (not EM)
                    : (st.key === 'prod');    // production only
                if (attachHere) mdrun += ` -plumed ${plumedFile}`;
            }
            s += mdrun + `\n\n`;

            prev = st;
        });

        s += `echo "Workflow complete."\n`;

        renderOutput(out, s);
        setWarnings($('slurmWarnings'), warnings);
    }

    // =====================================================================
    // LAMMPS script
    // =====================================================================
    function generateLammpsScript() {
        const out = $('slurmOutput');
        if (!out) return;
        const warnings = [];

        const { header, isArray, scheduler } = buildSchedulerHeader('lammps', warnings);
        let s = header;
        s += envBlock('lammps', scheduler);

        s += `# --- Execution ---\n`;

        if (isArray) {
            const baseDir = getStr('jobArrayDir', 'run_');
            s += `SYSTEM_DIR="${baseDir}\${${envVars(scheduler).arrayIndex}}"\n`;
            s += `cd "\$SYSTEM_DIR" || { echo "Missing directory \$SYSTEM_DIR" >&2; exit 1; }\n\n`;
        }

        const inFile = getStr('lmpInput', 'in.lammps');
        const logFile = getStr('lmpLog', 'log.lammps');
        const gpus = getInt('jobGpus', 0);
        const accel = getStr('lmpAccel', 'none'); // none | gpu | kokkos | intel | omp | opt
        const ompThreads = getInt('lmpCpus', 1); // cpus-per-task = OpenMP threads/rank

        let lmpArgs = `-in ${inFile} -log ${logFile}`;
        let note = '';

        switch (accel) {
            case 'gpu':
                // GPU package: -sf appends /gpu to supported styles; -pk sets GPUs/node.
                lmpArgs += ` -sf gpu -pk gpu ${gpus > 0 ? gpus : 1}`;
                note = '# GPU package: -sf gpu appends /gpu to supported styles; -pk gpu N sets GPUs/node.';
                if (gpus <= 0) warnings.push('GPU package selected but 0 GPUs requested. Set GPUs per node above 0.');
                break;
            case 'kokkos':
                // KOKKOS on GPU: typically one MPI rank per GPU.
                lmpArgs += ` -k on g ${gpus > 0 ? gpus : 1} -sf kk -pk kokkos`;
                note = '# KOKKOS (GPU): typically one MPI rank per GPU (-k on g N).';
                if (gpus <= 0) warnings.push('KOKKOS/GPU selected but 0 GPUs requested. Set GPUs per node above 0, or use the OPENMP package for CPU threading.');
                break;
            case 'intel':
                // INTEL package: vectorised CPU (and optional Phi offload).
                lmpArgs += ` -sf intel -pk intel 0`;
                note = '# INTEL package: -pk intel 0 = CPU only (use a nonzero value only for Xeon Phi offload). Your input may also need "package intel 0".';
                break;
            case 'omp':
                // OPENMP package: hybrid MPI + OpenMP. -pk omp N must match cpus-per-task.
                lmpArgs += ` -sf omp -pk omp ${ompThreads}`;
                note = scheduler === 'slurm'
                    ? '# OPENMP package: hybrid MPI x OpenMP. -pk omp N matches --cpus-per-task; benchmark 1/2/4 threads per rank.'
                    : '# OPENMP package: hybrid MPI x OpenMP. -pk omp N matches the threads per rank requested above; benchmark 1/2/4 threads per rank.';
                if (ompThreads <= 1) {
                    warnings.push('OPENMP package with 1 thread/rank behaves like MPI-only. Set CPUs per task above 1 to use threading (2 is often optimal).');
                }
                break;
            case 'opt':
                // OPT package: templated CPU pair-style speedups (5-25%).
                lmpArgs += ` -sf opt`;
                note = '# OPT package: templated CPU pair styles (typically 5-25% faster). No -pk needed.';
                break;
            case 'none':
            default:
                if (gpus > 0) {
                    warnings.push('GPUs requested but no accelerator package selected. Choose <b>GPU</b> or <b>KOKKOS</b>, or set GPUs to 0.');
                }
                break;
        }

        if (note) s += note + `\n`;
        if (LAUNCH_NOTE[scheduler]) s += LAUNCH_NOTE[scheduler] + `\n`;
        s += `${launcher(scheduler, { cpusPerTask: ompThreads })} lmp ${lmpArgs}\n`;
        s += `echo "LAMMPS run complete. Check the Performance line in ${logFile}."\n`;
        s += `# Tip: accelerating is not always faster. Benchmark task/thread/GPU\n`;
        s += `#      combinations for YOUR system and styles before production runs.\n`;

        renderOutput(out, s);
        setWarnings($('slurmWarnings'), warnings);
    }

    // =====================================================================
    // Dispatcher
    // =====================================================================
    function generateSubmitScript() {
        if (currentEngine === 'gromacs') generateGromacsScript();
        else if (currentEngine === 'lammps') generateLammpsScript();
        else if (currentEngine === 'plumed') plumedTab.generate();
        updateResourceSummary();
    }

    // =====================================================================
    // Topology header (GROMACS only)
    // =====================================================================
    function applyForcefieldPreset() {
        const sel = $('topForcefield');
        if (!sel) return;
        const preset = FF_PRESETS[sel.value];
        if (!preset) return;
        if ($('topComb'))  $('topComb').value  = preset.comb;
        if ($('topFudge')) $('topFudge').value = preset.family;
    }

    function resolveFudge() {
        switch ($('topFudge')?.value) {
            case 'amber':  return { LJ: '0.5', QQ: '0.8333' };
            case 'charmm': return { LJ: '1.0', QQ: '1.0' };
            case 'opls':   return { LJ: '0.5', QQ: '0.5' };
            case 'none':   return { LJ: '1.0', QQ: '1.0' };
            default:       return { LJ: '1.0', QQ: '1.0' };
        }
    }

    function generateTopologyHeader() {
        const out = $('topOutput');
        if (!out) return;

        const ffKey    = $('topForcefield') ? $('topForcefield').value : 'amber99sb-ildn';
        const preset   = FF_PRESETS[ffKey];
        const solv     = $('topSolvent') ? $('topSolvent').value : 'spce';
        const comb     = $('topComb') ? $('topComb').value : (preset ? preset.comb : '2');
        const fudge    = resolveFudge();
        const includes = $('topIncludes') ? $('topIncludes').value : '';

        const warnings = [];
        if (preset) {
            if (comb !== preset.comb) {
                warnings.push(`Combination rule <b>${comb}</b> is non-canonical for ${preset.label}, whose <code>forcefield.itp</code> sets <b>rule ${preset.comb}</b>. The header says how to apply it to a local copy of the force field.`);
            }
            if (fudge.LJ !== preset.fudgeLJ || fudge.QQ !== preset.fudgeQQ) {
                warnings.push(`Fudge factors <b>${fudge.LJ}/${fudge.QQ}</b> differ from ${preset.label}'s canonical <b>${preset.fudgeLJ}/${preset.fudgeQQ}</b>. Only override if intentional; the header says how to apply it to a local copy of the force field.`);
            }
        }

        const ffDir = preset ? preset.dir : `${ffKey}.ff`;
        const defaultsRow = (c, lj, qq) => `1         ${c.padEnd(9, ' ')} yes        ${lj.padEnd(8, ' ')} ${qq}`;
        const overridden = preset && (comb !== preset.comb || fudge.LJ !== preset.fudgeLJ || fudge.QQ !== preset.fudgeQQ);

        let t = `; ==================================================================\n`;
        t += `; STEMKit (stemkit.net) auto-generated GROMACS topology header\n`;
        t += `; Force field: ${preset ? preset.label : ffKey}\n`;
        if (preset && preset.download) {
            t += `; ${preset.label} is not distributed with GROMACS. Download the GROMACS\n`;
            t += `; port from the MacKerell lab (mackerell.umaryland.edu), unpack it here\n`;
            t += `; and make the ${ffDir} paths below match its directory name.\n`;
        }
        t += `; ==================================================================\n\n`;

        // forcefield.itp carries the force field's own [ defaults ], and grompp
        // accepts only one, so the header never writes a second. The values are
        // shown as a comment; an override becomes instructions for a local copy.
        if (overridden) {
            t += `; Advanced override. ${ffDir}/forcefield.itp sets [ defaults ] itself,\n`;
            t += `; and grompp rejects a second one, so to run with these values copy\n`;
            t += `; ${ffDir} into this directory and edit the line in its forcefield.itp\n`;
            t += `; (grompp searches the working directory before the GROMACS library):\n`;
            t += `; nbfunc  comb-rule  gen-pairs  fudgeLJ  fudgeQQ\n`;
            t += `; ${defaultsRow(comb, fudge.LJ, fudge.QQ)}\n`;
            t += `; The force field ships:\n`;
            t += `; ${defaultsRow(preset.comb, preset.fudgeLJ, preset.fudgeQQ)}\n\n`;
        } else {
            t += `; [ defaults ] comes from ${ffDir}/forcefield.itp (grompp accepts\n`;
            t += `; only one [ defaults ] directive):\n`;
            t += `; nbfunc  comb-rule  gen-pairs  fudgeLJ  fudgeQQ\n`;
            t += `; ${defaultsRow(comb, fudge.LJ, fudge.QQ)}\n\n`;
        }

        t += `; --- Core force field ---\n`;
        t += `#include "${ffDir}/forcefield.itp"\n\n`;

        if (includes && includes.trim() !== '') {
            t += `; --- Custom / additional topologies ---\n`;
            t += `${includes.trim()}\n\n`;
        }

        t += `; --- Water model ---\n`;
        t += `#include "${ffDir}/${solv}.itp"\n\n`;

        t += `; --- Ions ---\n`;
        t += `#include "${ffDir}/ions.itp"\n\n`;

        t += `[ system ]\n; Name\nMD system\n\n`;
        t += `[ molecules ]\n; Compound   #mols\n`;
        t += `; Fill in with your actual species and counts, e.g.:\n`;
        t += `; Protein_A    1\n; SOL          10000\n; NA           30\n; CL           28\n`;

        renderOutput(out, t, { topology: true });
        setWarnings($('topWarnings'), warnings);
    }

    // =====================================================================
    // Engine tab switching
    // =====================================================================
    const OUTPUT_FILE = { gromacs: 'submit.sh', lammps: 'submit.sh', plumed: 'plumed.dat' };

    function switchEngine(engine) {
        currentEngine = engine;

        document.querySelectorAll('[data-engine-tab]').forEach(btn => {
            btn.setAttribute('aria-selected', btn.getAttribute('data-engine-tab') === engine ? 'true' : 'false');
        });

        // Panels visible per engine
        toggleVisibility($('gromacsPanel'), engine === 'gromacs');
        toggleVisibility($('lammpsPanel'),  engine === 'lammps');
        toggleVisibility($('plumedPanel'),  engine === 'plumed');

        // Resource-model fields: GROMACS shows CPUs/task, LAMMPS shows tasks/node.
        // PLUMED generates an input file, so the cluster card is hidden.
        toggleVisibility($('gmxCpuField'),  engine === 'gromacs');
        toggleVisibility($('lmpTaskField'), engine === 'lammps');
        toggleVisibility($('lmpCpuField'),  engine === 'lammps');
        toggleVisibility($('clusterCard'), engine !== 'plumed');

        // Topology + GROMACS GPU flags only relevant to GROMACS
        toggleVisibility($('topologyCard'), engine === 'gromacs');
        toggleVisibility($('gmxGpuCard'), engine === 'gromacs');
        toggleVisibility($('lmpGpuCard'), engine === 'lammps');

        // Output labels + secondary box
        const lbl = $('primaryOutputLabel');
        if (lbl) lbl.textContent = OUTPUT_FILE[engine];
        document.querySelectorAll('[data-target="slurmOutput"]').forEach(btn => {
            btn.setAttribute('data-filename', OUTPUT_FILE[engine]);
        });
        toggleVisibility($('topologyOutputBox'), engine === 'gromacs');
        toggleVisibility($('outputSplit'), engine === 'gromacs');

        if (engine === 'plumed') plumedTab.enter();
        else plumedTab.leave();
        syncSchedulerUI();
        generateSubmitScript();
        if (engine === 'gromacs') generateTopologyHeader();
        scheduleSave();
    }

    // Everything on the page that follows the scheduler choice: the PE field,
    // the hint under the selector, the badge on the output panel, the submit
    // command under the script and the Copy/Download labels.
    function syncSchedulerUI() {
        const id = currentScheduler();
        const meta = getScheduler(id);
        toggleVisibility($('sgePeField'), id === 'sge');

        const hint = $('schedulerHint');
        if (hint) {
            hint.innerHTML = `Directives use <code>${escapeHtml(meta.prefix)}</code>; submit with ` +
                `<code>${escapeHtml(submitCommand(id))}</code>.`;
        }

        const plumed = currentEngine === 'plumed';
        const badge = $('schedulerBadge');
        if (badge) badge.textContent = plumed ? `PLUMED ${plumedTab.version()}` : meta.label;

        const foot = $('submitHint');
        if (foot) {
            if (plumed) {
                foot.innerHTML = 'Pass it to the engine, e.g. <code>gmx mdrun -plumed plumed.dat</code>.';
            } else {
                // SLURM and Grid Engine open the log file as the job starts, so the
                // directory has to exist before submission; the script's mkdir is
                // too late for them.
                const cmd = (meta.logDirAtStart ? 'mkdir -p logs && ' : '') + submitCommand(id);
                foot.innerHTML = `Submit with <code>${escapeHtml(cmd)}</code>` +
                    (meta.stdin ? ' (bsub reads the <code>#BSUB</code> lines from standard input only).' : '.');
            }
        }

        const what = plumed ? 'plumed.dat' : `submit.sh (${meta.label})`;
        document.querySelectorAll('[data-target="slurmOutput"]').forEach(btn => {
            const verb = btn.classList.contains('copy-btn') ? 'Copy' : 'Download';
            btn.setAttribute('aria-label', `${verb} ${what}`);
            btn.title = `${verb} ${what}`;
        });
    }

    // =====================================================================
    // Resource summary under the cluster form
    // =====================================================================
    function updateResourceSummary() {
        const host = $('resourceSummary');
        if (!host) return;
        const engine = currentEngine === 'lammps' ? 'lammps' : 'gromacs';
        const config = {
            engine,
            nodes: getInt('jobNodes', 1),
            cpusPerTask: engine === 'gromacs' ? getInt('jobCpus', 1) : getInt('lmpCpus', 1),
            tasksPerNode: getInt('jobTasks', 1),
            walltime: getStr('jobTime', '')
        };
        const gpus = getInt('jobGpus', 0) * config.nodes;
        const est = estimateCoreHours(config);
        const cores = est ? est.cores
            : config.nodes * (engine === 'gromacs' ? config.cpusPerTask : config.tasksPerNode * Math.max(1, config.cpusPerTask));
        const fmt = (n, digits = 0) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: digits });
        const items = [
            ['Nodes', fmt(config.nodes)],
            ['Cores', fmt(cores)],
            ['GPUs', fmt(gpus)]
        ];
        if (est) {
            items.push(['Wall time', `${fmt(est.hours, 2)} h`]);
            items.push(['Core-hours', fmt(est.coreHours, 1)]);
        } else {
            items.push(['Wall time', 'unreadable']);
        }
        if (isChecked('jobArrayToggle')) {
            const conc = arrayConcurrency(getStr('jobArrayRange', ''));
            if (conc) {
                items.push(['Array', `${fmt(conc.total)} tasks, ${fmt(conc.concurrent)} in flight`]);
                items.push(['In flight', `${fmt(cores * conc.concurrent)} cores` + (gpus ? `, ${fmt(gpus * conc.concurrent)} GPUs` : '')]);
                if (est) items.push(['Core-hours, all tasks', fmt(est.coreHours * conc.total, 1)]);
            }
        }
        host.innerHTML = items.map(([k, v]) =>
            `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');
    }

    // =====================================================================
    // Output rendering: syntax colouring
    // =====================================================================
    // A small tokenizer for the generated files. It escapes as it goes and
    // never drops a character, so the pane's textContent stays the exact text
    // that Copy and Download hand out.
    const DIRECTIVE_LINE = /^(#SBATCH|#PBS|#BSUB|#\$)(?=\s|$)/;
    const TOPOLOGY_DIRECTIVE = /^#(include|define|undef|ifdef|ifndef|else|endif)\b/;

    function highlightLine(line, opts) {
        const esc = escapeHtml;
        const span = (cls, text) => `<span class="${cls}">${esc(text)}</span>`;
        const directive = opts.topology ? TOPOLOGY_DIRECTIVE : DIRECTIVE_LINE;
        if (directive.test(line)) return span('tok-d', line);
        const commentChar = opts.topology ? ';' : '#';
        if (line.trimStart().startsWith(commentChar)) return span('tok-c', line);

        let out = '';
        let i = 0;
        const n = line.length;
        const varAt = (j) => {
            // $NAME, ${...}, $(...) and $((...)) all start here; return the length.
            if (line[j] !== '$') return 0;
            const c = line[j + 1];
            if (c === '{') { const k = line.indexOf('}', j); return k < 0 ? 0 : k - j + 1; }
            if (c === '(') return 2;
            const m = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(j));
            return m ? m[0].length : 0;
        };
        while (i < n) {
            const ch = line[i];
            if (ch === commentChar && (i === 0 || /\s/.test(line[i - 1]))) {
                out += span('tok-c', line.slice(i));
                break;
            }
            if (ch === "'") {
                const k = line.indexOf("'", i + 1);
                const end = k < 0 ? n : k + 1;
                out += span('tok-s', line.slice(i, end));
                i = end;
                continue;
            }
            if (ch === '"') {
                // Variables expand inside double quotes, so they keep their colour.
                const k = line.indexOf('"', i + 1);
                const end = k < 0 ? n : k + 1;
                let inner = '';
                let j = i;
                while (j < end) {
                    const len = Math.min(varAt(j), end - j);
                    if (len && line[j + 1] !== '(') { inner += span('tok-v', line.slice(j, j + len)); j += len; }
                    else { inner += esc(line[j]); j += 1; }
                }
                out += `<span class="tok-s">${inner}</span>`;
                i = end;
                continue;
            }
            const len = varAt(i);
            if (len) {
                if (line[i + 1] === '(') {
                    // $( and $((: colour the opener, leave the contents to the scanner,
                    // and colour the matching closer when it turns up.
                    const dbl = line[i + 2] === '(';
                    const opener = dbl ? '$((' : '$(';
                    out += span('tok-v', opener);
                    i += opener.length;
                    let depth = 1;
                    let j = i;
                    while (j < n && depth > 0) {
                        if (line[j] === '(') depth += 1;
                        else if (line[j] === ')') depth -= 1;
                        if (depth > 0) j += 1;
                    }
                    const closer = dbl ? '))' : ')';
                    const body = line.slice(i, j);
                    out += highlightLine(body, opts);
                    if (j < n) { out += span('tok-v', closer); i = j + closer.length; }
                    else i = n;
                    continue;
                }
                out += span('tok-v', line.slice(i, i + len));
                i += len;
                continue;
            }
            out += esc(ch);
            i += 1;
        }
        return out;
    }

    function renderOutput(node, text, opts = {}) {
        if (!node) return;
        node.innerHTML = text.split('\n').map(l => highlightLine(l, opts)).join('\n');
    }

    // =====================================================================
    // PLUMED tab
    // =====================================================================
    const plumedTab = createPlumedBuilder({
        $, getStr, isChecked, setWarnings, renderOutput, escapeHtml,
        showToast: (...a) => showToast(...a),
        downloadText: (...a) => downloadText(...a),
        scheduleSave: () => scheduleSave(),
        setFields: (values) => {
            settingsFields().forEach(el => {
                if (Object.prototype.hasOwnProperty.call(values, el.id)) setFieldValue(el, values[el.id]);
            });
        },
        syncVisibility: () => syncVisibility(),
        onVersionChange: () => syncSchedulerUI()
    });

    // =====================================================================
    // Wire up events
    // =====================================================================
    // Engine tabs
    document.querySelectorAll('[data-engine-tab]').forEach(btn => {
        btn.addEventListener('click', () => switchEngine(btn.getAttribute('data-engine-tab')));
    });

    // Switches toggle themselves and then announce a change, so the same
    // listeners serve them and the checkboxes.
    document.querySelectorAll('#builderLayout [role="switch"]').forEach(sw => {
        sw.addEventListener('click', () => {
            sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
            sw.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    // Generic inputs that affect the submit script
    const submitInputIds = [
        'jobName','jobPartition','jobNodes','jobCpus','jobTasks','lmpCpus','jobGpus',
        'jobTime','jobMem','jobArrayRange','jobArrayDir','jobMailUser','sgePe',
        'gmxTopol','gmxStartConf','gmxIndex','gmxBinary','gpuNtmpi',
        'lmpInput','lmpLog'
    ];
    submitInputIds.forEach(id => { const el = $(id); if (el) el.addEventListener('input', generateSubmitScript); });

    const submitToggleIds = [
        'jobArrayToggle','usePartition','useMail',
        'gpuNb','gpuPme','gpuBonded','gpuUpdate'
    ];
    submitToggleIds.forEach(id => { const el = $(id); if (el) el.addEventListener('change', generateSubmitScript); });

    if ($('lmpAccel')) $('lmpAccel').addEventListener('change', generateSubmitScript);
    if ($('jobScheduler')) $('jobScheduler').addEventListener('change', () => {
        syncSchedulerUI();
        generateSubmitScript();
    });

    // GROMACS + PLUMED coupling
    ['gmxUsePlumed','gmxPlumedScope'].forEach(id => {
        const el = $(id); if (el) el.addEventListener('change', () => {
            syncVisibility();
            generateGromacsScript();
        });
    });
    if ($('gmxPlumedFile')) $('gmxPlumedFile').addEventListener('input', generateGromacsScript);

    // Optional sections open and close with their switch.
    ['jobArrayToggle', 'usePartition', 'useMail'].forEach(id => {
        const el = $(id); if (el) el.addEventListener('change', syncVisibility);
    });

    // GROMACS stage rows
    GMX_STAGES.forEach(key => {
        ['on','mdp','deffnm','posres'].forEach(suffix => {
            const el = $(`stage_${key}_${suffix}`);
            if (!el) return;
            const evt = (el.type === 'checkbox' || el.getAttribute('role') === 'switch') ? 'change' : 'input';
            el.addEventListener(evt, generateGromacsScript);
        });
    });

    // Force field coupling
    if ($('topForcefield')) $('topForcefield').addEventListener('change', () => {
        if (!manualOverride) applyForcefieldPreset();
        generateTopologyHeader();
    });
    if ($('topSolvent'))  $('topSolvent').addEventListener('change', generateTopologyHeader);
    if ($('topIncludes')) $('topIncludes').addEventListener('input', generateTopologyHeader);
    if ($('topAdvancedToggle')) $('topAdvancedToggle').addEventListener('change', () => {
        manualOverride = isChecked('topAdvancedToggle');
        syncVisibility();
        if (!manualOverride) applyForcefieldPreset();
        generateTopologyHeader();
    });
    if ($('topComb'))  $('topComb').addEventListener('change', generateTopologyHeader);
    if ($('topFudge')) $('topFudge').addEventListener('change', generateTopologyHeader);

    // The sub-panels that open under a switch or a select, derived from the
    // current state so restoring saved settings uses the same code path.
    function syncVisibility() {
        toggleVisibility($('arraySettings'), isChecked('jobArrayToggle'));
        toggleVisibility($('partitionWrap'), isChecked('usePartition'));
        toggleVisibility($('mailWrap'), isChecked('useMail'));
        toggleVisibility($('gmxPlumedWrap'), isChecked('gmxUsePlumed'));
        toggleVisibility($('topAdvancedPanel'), isChecked('topAdvancedToggle'));
        toggleVisibility($('plumedWholeWrap'), isChecked('plumedWhole'));
        toggleVisibility($('plumedWalkersDisk'), getStr('plumedWalkersMode', 'none') === 'disk');
    }

    // =====================================================================
    // Toasts, copy and download
    // =====================================================================
    function showToast(message, kind = '') {
        const c = $('toastContainer');
        if (!c) return;
        const toast = document.createElement('div');
        toast.className = 'stk-toast' + (kind ? ` stk-toast-${kind}` : '');
        toast.setAttribute('role', 'status');
        const icon = kind === 'danger' ? 'fa-circle-exclamation' : kind === 'ok' ? 'fa-circle-check' : 'fa-circle-info';
        toast.innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
        toast.querySelector('span').textContent = message;
        c.appendChild(toast);
        setTimeout(() => toast.remove(), 3200);
    }

    // The pane holds coloured spans; textContent is the plain file.
    const outputText = (id) => ($(id) ? $(id).textContent : '');

    function downloadText(text, filename, type = 'text/plain') {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const el = e.currentTarget;
            const code = outputText(el.getAttribute('data-target'));
            const originalHTML = el.innerHTML;
            const done = () => {
                el.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
                el.setAttribute('aria-pressed', 'true');
                setTimeout(() => {
                    el.innerHTML = originalHTML;
                    el.removeAttribute('aria-pressed');
                }, 2000);
            };
            const fallbackCopy = () => {
                const ta = document.createElement('textarea');
                ta.value = code; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                try { document.execCommand('copy'); done(); } catch (_) { showToast('Copy failed. Select the text and copy it by hand.', 'danger'); }
                document.body.removeChild(ta);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(code).then(done).catch(fallbackCopy);
            } else { fallbackCopy(); }
        });
    });

    document.querySelectorAll('.download-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const el = e.currentTarget;
            downloadText(outputText(el.getAttribute('data-target')), el.getAttribute('data-filename') || 'output.txt');
        });
    });

    // =====================================================================
    // Saved settings: localStorage, export and import
    // =====================================================================
    // One key holds every field on the page plus the PLUMED builder state,
    // written a moment after each change and read back on load. The same
    // object, with a version, is what Export writes and Import reads.
    const STORAGE_KEY = 'stemkit.script-generator';
    const SETTINGS_VERSION = 1;
    let saveTimer = null;

    function settingsFields() {
        return Array.from(document.querySelectorAll(
            '#builderLayout input[id], #builderLayout select[id], #builderLayout textarea[id], #builderLayout [role="switch"][id]'
        )).filter(el => !(el.tagName === 'INPUT' && (el.type === 'file' || el.type === 'button')) &&
            !el.hasAttribute('data-nosave'));
    }

    function fieldValue(el) {
        if (el.getAttribute('role') === 'switch') return el.getAttribute('aria-checked') === 'true';
        if (el.type === 'checkbox') return el.checked;
        return el.value;
    }

    function setFieldValue(el, value) {
        if (el.getAttribute('role') === 'switch') { el.setAttribute('aria-checked', value ? 'true' : 'false'); return; }
        if (el.type === 'checkbox') { el.checked = !!value; return; }
        if (el.tagName === 'SELECT') {
            const v = String(value);
            if (Array.from(el.options).some(o => o.value === v)) el.value = v;
            return;
        }
        el.value = value == null ? '' : String(value);
    }

    function serialiseSettings() {
        const fields = {};
        settingsFields().forEach(el => { fields[el.id] = fieldValue(el); });
        return {
            tool: 'script-generator',
            version: SETTINGS_VERSION,
            engine: currentEngine,
            fields,
            plumed: plumedTab.serialise()
        };
    }

    // Unknown keys are ignored: a file from a newer page, or one with a
    // field this page no longer has, still restores everything it can.
    function applySettings(data) {
        if (!data || typeof data !== 'object') return false;
        const fields = data.fields && typeof data.fields === 'object' ? data.fields : {};
        settingsFields().forEach(el => {
            if (Object.prototype.hasOwnProperty.call(fields, el.id)) setFieldValue(el, fields[el.id]);
        });

        plumedTab.restore(data.plumed, fields);

        manualOverride = isChecked('topAdvancedToggle');
        if (!manualOverride) applyForcefieldPreset();
        syncVisibility();
        const engine = ['gromacs', 'lammps', 'plumed'].includes(data.engine) ? data.engine : 'gromacs';
        switchEngine(engine);
        return true;
    }

    function saveSettings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serialiseSettings())); } catch (_) { /* storage may be unavailable */ }
    }
    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveSettings, 300);
    }
    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            return data && data.tool === 'script-generator' ? data : null;
        } catch (_) { return null; }
    }

    // Field edits bubble up from anywhere in the builder, including the
    // PLUMED cards built at run time; engine changes save from switchEngine.
    $('builderLayout')?.addEventListener('input', scheduleSave);
    $('builderLayout')?.addEventListener('change', scheduleSave);
    $('builderLayout')?.addEventListener('click', (e) => {
        if (e.target.closest('button')) scheduleSave();
    });

    const defaultSettings = serialiseSettings();

    if ($('exportSettings')) $('exportSettings').addEventListener('click', () => {
        saveSettings();
        downloadText(JSON.stringify(serialiseSettings(), null, 2), 'md-workflow-settings.json', 'application/json');
    });
    if ($('importSettings')) $('importSettings').addEventListener('click', () => $('importSettingsFile')?.click());
    if ($('importSettingsFile')) $('importSettingsFile').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        file.text().then(text => {
            let data;
            try { data = JSON.parse(text); } catch (_) {
                showToast(`${file.name} is not valid JSON.`, 'danger');
                return;
            }
            if (!data || data.tool !== 'script-generator') {
                showToast(`${file.name} is not a settings file from this tool.`, 'danger');
                return;
            }
            if (Number(data.version) > SETTINGS_VERSION) {
                showToast(`Settings version ${data.version} is newer than this page understands; unknown settings were ignored.`, 'warn');
            }
            applySettings(data);
            saveSettings();
            showToast(`Settings imported from ${file.name}.`, 'ok');
        }).catch(() => showToast(`Could not read ${file.name}.`, 'danger'));
    });
    if ($('resetSettings')) $('resetSettings').addEventListener('click', () => {
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* nothing to clear */ }
        applySettings(defaultSettings);
        showToast('Settings reset to the defaults.', 'ok');
    });

    // =====================================================================
    // Output column: split handle and the "View script" button
    // =====================================================================
    // Drag the handle between the two panes to trade height between them;
    // arrow keys do the same from the keyboard. Only active side by side.
    (function wireSplit() {
        const handle = $('outputSplit');
        const column = $('outputColumn');
        const top = $('topologyOutputBox');
        if (!handle || !column || !top) return;
        const setHeight = (px) => {
            const max = column.clientHeight * 0.7;
            const h = Math.min(max, Math.max(112, px));
            top.style.setProperty('--sg-top-h', `${Math.round(h)}px`);
        };
        let startY = 0, startH = 0;
        const onMove = (e) => setHeight(startH + (startY - e.clientY));
        const onUp = () => {
            handle.classList.remove('is-dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            startY = e.clientY;
            startH = top.getBoundingClientRect().height;
            handle.classList.add('is-dragging');
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });
        handle.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            setHeight(top.getBoundingClientRect().height + (e.key === 'ArrowUp' ? 24 : -24));
        });
    })();

    // A sticky column sized to the viewport overflows it until the page has
    // scrolled far enough for the column to stick, so size it from where it
    // actually is: what is left below its top edge, up to the sticky height.
    (function wireStickyHeight() {
        const column = $('outputColumn');
        if (!column) return;
        const wide = window.matchMedia('(min-width: 1024px)');
        let frame = 0;
        const update = () => {
            frame = 0;
            if (!wide.matches) { column.style.removeProperty('--sg-col-h'); return; }
            const stickyTop = parseFloat(getComputedStyle(column).top) || 0;
            const top = Math.max(column.getBoundingClientRect().top, stickyTop);
            column.style.setProperty('--sg-col-h', `${Math.round(window.innerHeight - top - 16)}px`);
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
        window.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        update();
    })();

    // Shown only while the form is on screen and the output is not, so it
    // neither covers the script nor follows the reader into the documentation.
    (function wireJump() {
        const btn = $('viewScript');
        const column = $('outputColumn');
        const settings = $('settingsColumn');
        if (!btn || !column || !settings || !('IntersectionObserver' in window)) return;
        const seen = { settings: false, output: false };
        const apply = () => { btn.hidden = window.innerWidth >= 1024 || seen.output || !seen.settings; };
        const watch = (el, key) => new IntersectionObserver((entries) => {
            seen[key] = entries.some(en => en.isIntersecting);
            apply();
        }, { threshold: 0.02 }).observe(el);
        watch(settings, 'settings');
        watch(column, 'output');
        window.addEventListener('resize', apply);
        btn.addEventListener('click', () => column.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    })();

    // =====================================================================
    // Init
    // =====================================================================
    const saved = loadSettings();
    if (saved) {
        applySettings(saved);
    } else {
        applyForcefieldPreset();
        syncVisibility();
        switchEngine('gromacs');
    }
});
