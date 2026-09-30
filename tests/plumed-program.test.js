/*
 * What the builder writes and what the checker says, handed to PLUMED itself.
 *
 * PLUMED is the authority: each input here is run by `plumed driver` on a
 * small made-up trajectory, or parsed with --parse-only, and the builder and
 * the checker must agree with what it does. The inputs are the ones the
 * cross-check with PLUMED 2.9, 2.10 and 2.11 found wrong.
 *
 * Needs a `plumed` executable of 2.9, 2.10 or 2.11: PLUMED_BIN when it is
 * set, else `plumed` on the PATH or /opt/bin/plumed. Without one the suite
 * says so and is skipped.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCV, generatePlumedInput, PLUMED_VERSIONS } from '../src/core/plumed.js';
import { loadSyntax } from '../src/core/plumed-syntax.js';
import { lintPlumedInput, importPlumedInput } from '../src/core/plumed-parse.js';

function findPlumed() {
  // PLUMED_BIN, when set, is the only one tried.
  const candidates = process.env.PLUMED_BIN ? [process.env.PLUMED_BIN] : ['plumed', '/opt/bin/plumed'];
  for (const bin of candidates) {
    const r = spawnSync(bin, ['info', '--version'], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0) {
      const m = /(\d+)\.(\d+)/.exec(r.stdout);
      const version = m ? `${m[1]}.${m[2]}` : '';
      if (PLUMED_VERSIONS.includes(version)) return { bin, version };
    }
  }
  return null;
}

const PLUMED = findPlumed();
if (!PLUMED) {
  // eslint-disable-next-line no-console
  console.log('plumed-program: no PLUMED 2.9-2.11 found (PLUMED_BIN, PATH, /opt/bin/plumed); skipped.');
}
const maybe = PLUMED ? describe : describe.skip;
const atLeast = (v) => PLUMED && Number(PLUMED.version.split('.')[1]) >= Number(v.split('.')[1]);

const NATOMS = 216;
let dir;
let syntax;

/* Two frames of a jittered 0.25 nm lattice, and a perfect tetrahedron. */
function writeTrajectories() {
  const frames = [];
  for (let f = 0; f < 2; f++) {
    const lines = [String(NATOMS), '1.5 1.5 1.5'];
    for (let i = 0; i < NATOMS; i++) {
      const g = [i % 6, Math.floor(i / 6) % 6, Math.floor(i / 36)];
      lines.push(`X ${g.map((n, d) => (n * 0.25 + 0.02 * Math.sin(1.7 * i + 2.3 * d + 0.5 * f) + 0.03).toFixed(4)).join(' ')}`);
    }
    frames.push(lines.join('\n'));
  }
  fs.writeFileSync(path.join(dir, 'traj.xyz'), `${frames.join('\n')}\n`);
  const d = 0.1 / Math.sqrt(3);
  const tet = [[0, 0, 0], [d, d, d], [d, -d, -d], [-d, d, -d], [-d, -d, d]].map(p => p.map(x => x + 5));
  fs.writeFileSync(path.join(dir, 'tet.xyz'), `5\n10 10 10\n${tet.map(p => `X ${p.join(' ')}`).join('\n')}\n`);
}

/* Run the driver; returns {ok, out, colvar}. */
function driver(input, args = ['--ixyz', 'traj.xyz']) {
  for (const f of fs.readdirSync(dir)) if (/^(COLVAR|HILLS|bck\.|State|Kernels)/.test(f)) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'plumed.dat'), input);
  const r = spawnSync(PLUMED.bin, ['driver', '--plumed', 'plumed.dat', ...args],
    { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, OMP_NUM_THREADS: '1' } });
  const colvar = fs.existsSync(path.join(dir, 'COLVAR')) ? fs.readFileSync(path.join(dir, 'COLVAR'), 'utf8') : '';
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`, colvar };
}
const parseOnly = (input) => driver(input, ['--natoms', '100', '--parse-only']);
const columns = (colvar) => (/#! FIELDS (.*)/.exec(colvar) || ['', ''])[1].split(/\s+/).slice(1);
const make = (type, label, values) => createCV(type, 1, { version: PLUMED.version, syntax, label, values });
const input = (config) => generatePlumedInput({
  version: PLUMED.version, syntax, prints: [{ file: 'COLVAR', stride: 1 }], ...config
}).input;

maybe(`the builder's files run in PLUMED ${PLUMED ? PLUMED.version : ''}`, () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-plumed-program-'));
    syntax = await loadSyntax(PLUMED.version);
    writeTrajectories();
  });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('a biased COORDINATION keeps its neighbour list under WT-MetaD (#5)', () => {
    const c = make('COORDINATION', 'c', { NLIST: true, NL_CUTOFF: '0.8', NL_STRIDE: '10' });
    c.biasValues.max = '200';
    const r = driver(input({ cvs: [c], bias: { method: 'wt_metad', temp: '300', grid: true } }));
    expect(r.out).not.toContain('NL_CUTOFF should be');
    expect(r.ok).toBe(true);
  });

  test('ABMD components have the names PLUMED gives them (#6)', () => {
    const r = driver(input({ cvs: [make('COORDINATIONNUMBER', 'cn')], bias: { method: 'abmd' } }));
    expect(r.ok).toBe(true);
    expect(columns(r.colvar).some(c => /^abmd\.cn[._]mean_min$/.test(c))).toBe(true);
  });

  test('SPECIESA and SPECIESB are what is computed (#2)', () => {
    const both = driver(input({ cvs: [make('COORDINATIONNUMBER_ADV', 'cn', { SPECIESA: '1-10', SPECIESB: '11-100' })], bias: { method: 'none' } }));
    const plain = driver('c: COORDINATIONNUMBER SPECIESA=1-10 SPECIESB=11-100 MEAN SWITCH={RATIONAL R_0=0.3 D_0=0.0 NN=6 MM=0 D_MAX=0.6}\nPRINT ARG=c.mean FILE=COLVAR\n');
    expect(both.ok && plain.ok).toBe(true);
    const value = (colvar) => colvar.split('\n').find(l => l && !l.startsWith('#')).trim().split(/\s+/)[1];
    expect(value(both.colvar)).toBe(value(plain.colvar));
  });

  test('TORSIONS counts stay inside the grid the builder gives them (#12)', () => {
    const t = make('TORSIONS', 'x', { ATOMS: 'ATOMS1=1,2,3,4 ATOMS2=5,6,7,8 ATOMS3=9,10,11,12', BETWEEN: '{GAUSSIAN LOWER=-pi UPPER=pi SMEAR=0.05}' });
    if (!t) return; // not offered for this release
    const r = driver(input({ cvs: [t], bias: { method: 'wt_metad', temp: '300', grid: true, params: { PACE: '1' } } }));
    expect(r.out).not.toContain('outside the grid');
    expect(r.ok).toBe(true);
  });

  test('a perfect tetrahedron gives 4.62, inside the TETRAHEDRAL grid (#14)', () => {
    const r = driver('t: TETRAHEDRAL SPECIESA=1 SPECIESB=2-5 MEAN SWITCH={RATIONAL R_0=0.12 D_MAX=0.2}\nPRINT ARG=t.mean FILE=COLVAR\n',
      ['--ixyz', 'tet.xyz']);
    expect(r.ok).toBe(true);
    const v = Number(r.colvar.split('\n').find(l => l && !l.startsWith('#')).trim().split(/\s+/)[1]);
    expect(v).toBeCloseTo(8 / Math.sqrt(3), 4);
    const grid = make('TETRAHEDRAL', 't').biasValues;
    expect(Number(grid.min) <= -v && Number(grid.max) >= v).toBe(true);
  });

  test('PLANE runs and can be biased (#7)', () => {
    if (!atLeast('2.10')) return;
    const r = driver(input({ cvs: [make('PLANE', 'p')], bias: { method: 'wt_metad', temp: '300', grid: true, params: { PACE: '1' } } }));
    expect(r.out).not.toContain('cannot use setValue');
    expect(r.ok).toBe(true);
  });

  test('DIHEDRAL_CORRELATION runs (#8)', () => {
    if (!atLeast('2.11')) return;
    const r = driver(input({ cvs: [make('DIHEDRAL_CORRELATION', 'd', { NOPBC: true })], bias: { method: 'restraint' } }));
    expect(r.ok).toBe(true);
  });

  test('OPES writes a state a restart can read (#43)', () => {
    // No checkpoint is signalled by the driver, as by LAMMPS: the state must
    // come from STATE_WSTRIDE, a hundred kernels here.
    const frames = Array.from({ length: 201 }, (_, i) =>
      `2\n3 3 3\nX 1 1 1\nX 1.2 1 ${(1 + 0.001 * i).toFixed(4)}`).join('\n');
    fs.writeFileSync(path.join(dir, 'pair.xyz'), `${frames}\n`);
    const r = driver(input({ cvs: [make('DISTANCE', 'd')], bias: { method: 'opes', temp: '300', params: { PACE: '1', BARRIER: '15' } } }),
      ['--ixyz', 'pair.xyz']);
    if (/opes/i.test(r.out) && /not known|not found/i.test(r.out)) return; // built without OPES
    expect(r.ok).toBe(true);
    expect(fs.statSync(path.join(dir, 'State.data')).size).toBeGreaterThan(0);
  });
});

maybe(`the checker agrees with PLUMED ${PLUMED ? PLUMED.version : ''}`, () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-plumed-check-'));
    syntax = await loadSyntax(PLUMED.version);
  });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const cases = [
    'd: DISTANCE ATOMS=1,2 components\nPRINT ARG=d.x FILE=colvar STRIDE=100',
    'restart\nd: DISTANCE ATOMS=1,2\nPRINT ARG=d FILE=colvar STRIDE=100',
    'c: COORDINATION GROUPA=1-10 GROUPB=11-20 SWITCH={rational R_0=0.3}\nPRINT ARG=c FILE=colvar STRIDE=100',
    'g: GROUP ATOMS={1\n2 3}\nd: DISTANCE ATOMS=1,2\nPRINT ARG=d FILE=colvar STRIDE=100',
    'd: DISTANCE ATOMS=1,2\nm: METAD ARG=d PACE=500 HEIGHT=1.2 GRID_MIN=0 GRID_MAX=3\nPRINT ARG=d FILE=colvar STRIDE=100',
    'd: DISTANCE ATOMS=1,2\nphi: TORSION ATOMS=1,2,3,4\nPRINT ARG=phi_1 FILE=colvar STRIDE=100',
    'd: DISTANCE ATOMS=1,2\nm: METAD ARG=d SIGMA=0.1 HEIGHT=1.2 PACE=500 GRID_MIN=0 GRID_MAX=3\nPRINT ARG=m.rbias FILE=colvar STRIDE=100',
    'u: UNITS LENGTH=A\nd: DISTANCE ATOMS=1,2\nPRINT ARG=d FILE=colvar STRIDE=100',
    'd: DISTANCE ATOMS=1,2 SERIAL\nPRINT ARG=d FILE=colvar STRIDE=100',
    'c: COORDINATION GROUPA=1-10 GROUPB=11-20 SWITCH={RATIONAL R0=0.3}\nPRINT ARG=c FILE=colvar STRIDE=100',
    'g: GROUP ATOMS=@CA-2\nc: CENTER ATOMS=g\nd: DISTANCE ATOMS=c,50\nPRINT ARG=d FILE=colvar STRIDE=100',
    'd: DISTANCE ATOMS=1,2 NOPBC\nPRINT ARG=d FILE=colvar STRIDE=100',
    'd1: DISTANCE ATOMS=1,2\nd2: DISTANCE ATOMS=3,4\nr: RESTRAINT ARG=d1,d2 AT=1,1 KAPPA=10\nPRINT ARG=r.bias FILE=colvar STRIDE=100',
    'd: DISTANCE ATOMS=1,2\nm: METAD ARG=d SIGMA=0.1 HEIGHT=1 PACE=500 GRID_MIN=0 GRID_MAX=3 WALKERS_ID=1\nPRINT ARG=m.bias FILE=colvar STRIDE=100',
    't: TORSION ATOMS=1,2,3,4\nm: METAD ARG=t PACE=500 HEIGHT=1.2 SIGMA=0.1 GRID_MIN=0 GRID_MAX=3\nPRINT ARG=t FILE=C STRIDE=500',
    'd: DISTANCE ATOMS=1,2,3\nPRINT ARG=d FILE=COLVAR STRIDE=500',
    'd: DISTANCE ATOMS=1,2 COMPONENTS\nPRINT ARG=d FILE=COLVAR STRIDE=500',
    // Inputs PLUMED runs.
    'c: CENTER ATOMS=1-5 SET_MASS=1 SET_CHARGE=-2.5\nd: DISTANCE ATOMS=c,6\nPRINT ARG=d FILE=colvar STRIDE=100',
    'd: DISTANCE ATOMS=1,2\nPRINT ARG=d FILE=colvar STRIDE=100\nDEBUG logActivity FILE=act',
    'd: DISTANCE ATOMS=1,2\nPRINT ...\n ARG=d FILE=colvar STRIDE=100',
    'a.b: DISTANCE ATOMS=1,2\n@c: DISTANCE ATOMS=3,4\nPRINT ARG=@c FILE=colvar STRIDE=100',
    'phi: TORSION ATOMS=5,7,9,15\nmetad: METAD ARG=phi SIGMA=0.35 HEIGHT=1.2 PACE=500 GRID_MIN=-pi GRID_MAX=pi\nPRINT ARG=phi,metad.bias STRIDE=500 FILE=COLVAR',
    't: TORSION ATOMS=10-1:-3\nPRINT ARG=t FILE=colvar STRIDE=100',
    // Inputs PLUMED stops at, for the reasons the messages give.
    'd:DISTANCE ATOMS=1,2\nPRINT ARG=d FILE=colvar STRIDE=100',
    'd: DISTANCE ATOMS=1,2\nm: METAD...\n ARG=d PACE=500 HEIGHT=1 SIGMA=0.1\n...\nPRINT ARG=d FILE=colvar STRIDE=100',
    'd: DISTANCE ATOMS=1,2 }\nPRINT ARG=d FILE=colvar STRIDE=100'
  ];

  test.each(cases.map((c, i) => [i, c]))('input %i', (_, text) => {
    const plumedStops = !parseOnly(text).ok;
    const r = lintPlumedInput(text, { syntax });
    expect({ text, lintStops: r.summary.errors > 0 }).toEqual({ text, lintStops: plumedStops });
  });

  test('PLUMED stops where the messages say, for the reason they give', () => {
    const said = (text) => lintPlumedInput(text, { syntax }).issues.find(i => i.level === 'error').text;
    const glued = 'd:DISTANCE ATOMS=1,2\nPRINT ARG=d FILE=colvar STRIDE=100';
    // 2.10 and 2.11 say 'Action "X" is not known'; 2.9 'I cannot understand line: X ...'.
    const unknown = (name) => new RegExp(`Action "${name}" is not known|cannot understand line: ${name} `);
    expect(parseOnly(glued).out).toMatch(unknown('D:DISTANCE'));
    expect(said(glued)).toContain('needs a space after the colon');
    const dots = 'd: DISTANCE ATOMS=1,2\nm: METAD...\n ARG=d PACE=500 HEIGHT=1 SIGMA=0.1\n...';
    expect(parseOnly(dots).out).toMatch(unknown('METAD\\.\\.\\.'));
    expect(said(dots)).toContain('needs a space before the dots');
    const brace = 'd: DISTANCE ATOMS=1,2 }\nPRINT ARG=d FILE=colvar STRIDE=100';
    expect(parseOnly(brace).out).toContain('Extra closed parenthesis');
    expect(said(brace)).toContain('closes no `{`');
    // The fixes the messages suggest are inputs PLUMED reads.
    expect(parseOnly('d: DISTANCE ATOMS=1,2\nPRINT ARG=d FILE=colvar STRIDE=100').ok).toBe(true);
    expect(parseOnly('d: DISTANCE ATOMS=1,2\nm: METAD ...\n ARG=d PACE=500 HEIGHT=1 SIGMA=0.1\n...').ok).toBe(true);
  });

  test('the command in the header, with the atom count, is one PLUMED runs', () => {
    const text = generatePlumedInput({ version: PLUMED.version, syntax, natoms: 100,
      cvs: [make('DISTANCE', 'd')], prints: [{ file: 'COLVAR', stride: 100 }] }).input;
    const command = /^# Check it before the run: {2}plumed (.*)$/m.exec(text)[1].split(/\s+/);
    expect(command).toEqual(['driver', '--natoms', '100', '--parse-only', '--plumed', 'plumed.dat']);
    fs.writeFileSync(path.join(dir, 'plumed.dat'), text);
    const r = spawnSync(PLUMED.bin, command, { cwd: dir, encoding: 'utf8', timeout: 60000 });
    expect(r.status).toBe(0);
  });

  test('walkers in one MPI job: --multi belongs to plumed driver', () => {
    // The advice given for WALKERS_MPI; PLUMED refuses the option on its own.
    expect(spawnSync(PLUMED.bin, ['--multi', '2', 'driver', '--help'], { encoding: 'utf8' }).status).not.toBe(0);
    const help = spawnSync(PLUMED.bin, ['driver', '--help'], { encoding: 'utf8' });
    expect(`${help.stdout}${help.stderr}`).toMatch(/--multi\b/);
  });

  test('a file brought into the builder is still one PLUMED runs (#33, #54)', () => {
    const original = 'd: DISTANCE ATOMS=1,2\nv: DISTANCE ATOMS1=3,4 ATOMS2=5,6\ns: SUM ARG=v PERIODIC=NO\n' +
      'c: CUSTOM ARG=d FUNC=2*x PERIODIC=NO\nsrt: SORT ARG=c,d\n' +
      'mtd: METAD ARG=d SIGMA=0.1 HEIGHT=1 PACE=500 GRID_MIN=0 GRID_MAX=3 FILE=HILLS_d\n' +
      'PRINT ARG=d,s,srt.1,mtd.bias FILE=COLVAR FMT=%10.5f\n';
    if (!atLeast('2.10')) return; // SORT of a vector is 2.10 syntax
    expect(parseOnly(original).ok).toBe(true);
    const { config } = importPlumedInput(original);
    const back = generatePlumedInput({ ...config, version: PLUMED.version, syntax }).input;
    const r = parseOnly(back);
    expect(r.out.match(/ERROR[^\n]*/) || []).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
