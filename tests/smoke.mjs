/**
 * End-to-end smoke test.
 *
 * Exercises one representative path per core module against a real install,
 * catching the class of problem a unit test cannot: a broken barrel export, a
 * mis-scoped `type` field, or a vendored bundle that fails to load. It imports
 * the package by name, as a user's script does, so under Node it runs through
 * `node.js`, which registers the vendored bundles.
 *
 *   node tests/smoke.mjs
 *
 * Prints one OK line per module checked, then a summary count. It reaches 28
 * of the 43 modules; `iso4`, `journals`, `pdf`, `zip`, `lammps-reference`, the
 * per-page figure modules and the PLUMED modules beyond `plumed` have no case
 * yet.
 */

import {
  parseXvg, generateSampleXvg,
  independentTTest,
  parsePDB, structureStats,
  generateScript,
  buildHeader, submitCommand, launcher,
  convert,
  parseBibtex, deduplicateAuto,
  fitCurve,
  parseEquation, classify, fitModel, generateFitScript, defaultPlotStyle,
  detectModifiedZScore,
  summariseGroup,
  toDataCoordinates,
  generateLatexTable,
  parseDelimited, dropMissing,
  generatePlumedInput,
  selectAtoms, SpatialGrid,
  generateWorkflow, checkMdp, GromacsMdp, readGromacsStructure, defaultGroups, writeNdx,
  normaliseFigure, figureScript, generateCleaningScript,
  defaultLammpsState, buildLammpsWorkflow, lammpsRunBlock, LammpsInput, LammpsData
} from 'stemkit-core';

let ok = 0;
let fail = 0;

const check = (name, fn) => {
  try {
    fn();
    console.log(`  OK   ${name}`);
    ok++;
  } catch (err) {
    console.log(`  ERR  ${name}: ${err.message}`);
    fail++;
  }
};

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log('STEMKit core: end-to-end smoke test\n');

check('xvg-parser', () => {
  const r = parseXvg(generateSampleXvg());
  assert(r.rowCount === 101, `expected 101 rows, got ${r.rowCount}`);
  assert(r.headers[1] === 'Backbone RMSD', 'legend not parsed');
});

check('statistics', () => {
  // Welch on these samples gives t = -5 exactly on df = 8; scipy reports
  // p = 0.0010528257933665399, so the threshold has to sit above 0.001.
  const r = independentTTest([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
  assert(Math.abs(r.t + 5) < 1e-12, `expected t = -5, got ${r.t}`);
  assert(Math.abs(r.df - 8) < 1e-12, `expected df = 8, got ${r.df}`);
  assert(Math.abs(r.p - 0.0010528257933665) < 1e-12, `p mismatch: ${r.p}`);
});

check('structure', () => {
  const pdb = 'ATOM      1  CA  ALA A   1       1.000   2.000   3.000  1.00 20.00           C\nEND';
  const s = structureStats(parsePDB(pdb).atoms);
  assert(s.nAtoms === 1, 'atom not parsed');
  assert(Math.abs(s.totalMass - 12.011) < 1e-6, 'carbon mass wrong');
});

check('structure: metalloprotein element inference', () => {
  const pdb = 'HETATM    1 FE   HEM A   1      10.000  10.000  10.000  1.00 30.00          FE\nEND';
  const s = structureStats(parsePDB(pdb).atoms);
  assert(s.elements.Fe === 1, 'heme iron not identified as Fe');
  assert(Math.abs(s.totalMass - 55.845) < 1e-6, `expected 55.845 Da, got ${s.totalMass}`);
});

check('slurm', () => {
  const { script } = generateScript({
    engine: 'gromacs', memory: '8G', walltime: '1:00:00', cpusPerTask: 16
  });
  assert(script.startsWith('#!/bin/bash'), 'missing shebang');
  assert(script.includes('#SBATCH --mem=8G'), 'memory directive missing');
  assert(script.includes('gmx mdrun'), 'run command missing');
});

check('scheduler', () => {
  const { script, warnings } = buildHeader({
    scheduler: 'pbs', engine: 'lammps', memory: '8G', walltime: '1:00:00', tasksPerNode: 16
  });
  assert(script.includes('#PBS -l select=1:ncpus=16:mpiprocs=16:ompthreads=1:mem=8gb'), 'select line wrong');
  assert(!script.includes('#SBATCH'), 'SLURM directive leaked into a PBS header');
  assert(warnings.length === 0, `unexpected warnings: ${warnings.map(w => w.message).join('; ')}`);
  assert(submitCommand('lsf') === 'bsub < submit.sh', 'LSF submits from stdin');
  assert(launcher('sge', { cpusPerTask: 2 }) === 'mpirun -np $((NSLOTS / 2))', 'hybrid launcher');
});

check('units', () => {
  assert(Math.abs(convert(1, 'length', 'nm', 'angstrom') - 10) < 1e-9, 'nm to A');
  assert(Math.abs(convert(1, 'energy', 'hartree', 'ev') - 27.211386245988) < 1e-9, 'Eh to eV');
});

check('bibtex: survives a Zotero-style @string block', () => {
  const src = '@string{n = "Nature"}\n' +
              '@article{a, title={T}, doi={10.1/x}, year={2020}}\n' +
              '@article{b, title={T}, year={2020}}';
  const p = parseBibtex(src);
  assert(p.entries.length === 2, `expected 2 entries, got ${p.entries.length}`);
  assert(p.strippedBlocks === 1, 'the @string block was not stripped');
  assert(deduplicateAuto(p.entries).removed === 1, 'duplicate not detected');
});

check('curve-fitting', () => {
  const f = fitCurve([[1, 2], [2, 4], [3, 6]], 'linear');
  assert(f.r2 > 0.999, `expected a near-perfect fit, got r2 = ${f.r2}`);
  assert(Math.abs(f.equation[0] - 2) < 1e-6, 'slope wrong');
});

check('equation fitting', () => {
  const eq = parseEquation('y = A*exp(-t/tau) + y0');
  assert(eq.ok !== false && eq.ast, 'equation not parsed');
  const { independent, parameters } = classify(eq);
  assert(independent.join() === 't' && parameters.join() === 'A,tau,y0', 'names not classified');
  const t = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const y = t.map(v => 5 * Math.exp(-v / 2) + 1);
  const f = fitModel({ ast: eq.ast, independent, parameters: parameters.map(name => ({ name })), columns: { t }, y });
  assert(f.ok && Math.abs(f.parameters[1].value - 2) < 1e-6, 'tau not recovered');
  const py = generateFitScript({
    equation: 'y = A*exp(-t/tau) + y0', ast: eq.ast, dependent: 'y', independent,
    parameters: parameters.map(name => ({ name })), data: { columns: { t }, y }, style: defaultPlotStyle(), fit: f
  });
  assert(py.includes('curve_fit'), 'no curve_fit in the script');
});

check('gromacs: .mdp and index', () => {
  const files = generateWorkflow(GromacsMdp.defaultSettings('em'), ['em', 'nvt']);
  assert(files.length === 2 && files[1].text.includes('integrator'), 'workflow not written');
  const verdict = checkMdp(files[1].text);
  assert(verdict.grompp.passes, `generated nvt.mdp would stop grompp: ${verdict.grompp.errors} errors`);
  const gro = 'water\n 3\n    1SOL     OW    1   0.126   1.624   1.679\n' +
    '    1SOL    HW1    2   0.190   1.661   1.747\n    1SOL    HW2    3   0.177   1.568   1.613\n   1.86206   1.86206   1.86206\n';
  const groups = defaultGroups(readGromacsStructure(gro, 'water.gro'));
  assert(groups.map(g => g.name).join() === 'System,Water,SOL', 'default groups differ from make_ndx');
  assert(writeNdx(groups).startsWith('[ System ]'), 'index file not written');
});

check('lammps: workflow, check and data file', () => {
  const wf = buildLammpsWorkflow(defaultLammpsState('charmm'));
  const files = Object.fromEntries(wf.files.filter(f => f.kind === 'lammps').map(f => [f.name, f.text]));
  assert(files['in.nvt'] && files['in.nvt'].includes('fix'), 'stage inputs not written');
  const chain = LammpsInput.checkChain(wf.stages.map(st => ({ name: st.file, text: files[st.file] })),
    { files, vars: { rstep: '-1', time_limit: 'off' } });
  const errors = chain.flatMap(r => r.issues.filter(i => i.severity === 'error'));
  assert(errors.length === 0, `the built inputs would stop LAMMPS: ${errors.map(e => e.message).join('; ')}`);
  assert(lammpsRunBlock(wf, { lmp: 'lmp' }).includes('in.prod'), 'run block misses production');
  const data = 'water\n\n3 atoms\n2 bonds\n1 angles\n2 atom types\n1 bond types\n1 angle types\n\n' +
    '0 10 xlo xhi\n0 10 ylo yhi\n0 10 zlo zhi\n\nMasses\n\n1 15.9994\n2 1.008\n\nAtoms # full\n\n' +
    '1 1 1 -0.834 5 5 5\n2 1 2 0.417 5.9572 5 5\n3 1 2 0.417 4.76 5.927 5\n\nBonds\n\n1 1 1 2\n2 1 1 3\n\nAngles\n\n1 1 2 1 3\n';
  const sum = LammpsData.summariseData(LammpsData.parseDataFile(data), { units: 'real' });
  assert(sum.natoms === 3 && sum.water && sum.water.model === 'TIP3P', `water not recognised: ${JSON.stringify(sum.water)}`);
});

check('figures and scripts', () => {
  const py = figureScript(normaliseFigure({ panels: [{ series: [{ id: 'a', kind: 'line', x: [0, 1], y: [1, 2] }] }] }));
  assert(py.includes('plt.subplots'), 'no figure in the script');
  const clean = generateCleaningScript({ fileName: 'a.csv', columns: ['x', 'y'], steps: [{ type: 'dropMissing', params: {} }] });
  assert(clean.code.includes('import pandas'), 'no pandas in the cleaning script');
});

check('outliers', () => {
  const r = detectModifiedZScore([1, 2, 1, 2, 1, 2, 100], 3.5);
  assert(r.indices.length === 1 && r.indices[0] === 6, 'outlier not flagged');
});

check('error-bars', () => {
  const s = summariseGroup('A', [1, 2, 3]);
  assert(s.n === 3, 'n wrong');
  assert(s.ci > 0, 'confidence interval not computed');
  assert(s.sem < s.sd, 'SEM should be smaller than SD');
});

check('digitizer', () => {
  const d = toDataCoordinates(300, 250, {
    pxX1: 100, pxX2: 500, pxY1: 400, pxY2: 100,
    valX1: 0, valX2: 100, valY1: 0, valY2: 50
  });
  assert(Math.abs(d.x - 50) < 1e-9, `expected x = 50, got ${d.x}`);
  assert(Math.abs(d.y - 25) < 1e-9, `expected y = 25, got ${d.y}`);
});

check('latex', () => {
  const t = generateLatexTable([['Sample', 'Energy'], ['A', '-1.2']]);
  assert(t.includes('\\toprule'), 'booktabs rule missing');
  assert(t.includes('\\begin{tabular}'), 'tabular missing');
});

check('plumed', () => {
  const CAT = {
    DISTANCE: { fields: [{ k: 'ATOMS', type: 'atoms', def: '1,2', required: true }] }
  };
  const { input, warnings } = generatePlumedInput({
    cvs: [{ type: 'DISTANCE', label: 'd1', values: { ATOMS: '1,2' }, bias: true }],
    biasMethod: 'wt_metad',
    biasParams: { sigma: '0.05', gridMin: '0', gridMax: '2', gridBin: '200' },
    catalogue: CAT, version: '2.9'
  });
  assert(input.includes('d1: DISTANCE ATOMS=1,2'), 'CV line missing');
  assert(input.includes('METAD'), 'bias line missing');
  assert(input.includes('metad.bias'), 'bias component not printed');
  assert(warnings.length === 0, `unexpected warnings: ${warnings.join('; ')}`);
});

check('selection', () => {
  const atoms = [
    { chain: 'A', resi: 1, resn: 'ALA', atom: 'CA', elem: 'C', x: 0, y: 0, z: 0 },
    { chain: 'A', resi: 1, resn: 'ALA', atom: 'CB', elem: 'C', x: 1, y: 0, z: 0 },
    { chain: 'B', resi: 1, resn: 'HOH', atom: 'OW', elem: 'O', x: 20, y: 0, z: 0 }
  ];
  assert(selectAtoms(atoms, 'chain:A').count === 2, 'chain selection');
  assert(selectAtoms(atoms, 'solvent:').count === 1, 'named group');
  assert(selectAtoms(atoms, '!solvent:').count === 2, 'negation');
  assert(selectAtoms(atoms, 'within:5,chain:A').count === 2, 'spatial query');
  const g = new SpatialGrid(atoms, 5);
  assert(g.hasNeighbourWithin(0, 0, 0, 1) === true, 'grid neighbour');
});

check('data-cleaning', () => {
  const { rows } = parseDelimited('a,b\n1,2\n,4');
  assert(rows.length === 2, 'parse failed');
  assert(dropMissing(rows, ['a']).removed === 1, 'missing row not dropped');
});

console.log(`\n${ok} OK, ${fail} ERR`);
process.exit(fail === 0 ? 0 : 1);
