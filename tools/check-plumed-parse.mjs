#!/usr/bin/env node
/*
 * check-plumed-parse.mjs: hand what the generator writes to PLUMED itself.
 *
 * Every catalogue entry, bias method and function is written with its
 * starting values and read by "plumed driver --parse-only" of each release
 * named in PLUMED_BINS. The parser is the authority the keyword tables only
 * approximate: it resolves shortcuts, reads reference files and checks that
 * every printed component exists.
 *
 * Parsing is not running: PLANE and DIHEDRAL_CORRELATION once parsed and then
 * aborted or crashed on the first step. With --run every input is also
 * computed on two frames of a small made-up trajectory, which catches that.
 *
 *     PLUMED_BINS="2.9=/path/plumed-2.9,2.10=/path/plumed-2.10" \
 *         node tools/check-plumed-parse.mjs [--run] [--verbose] [--keep]
 *
 * Exits 0 when nothing fails, or when PLUMED_BINS is unset (nothing to check).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CV_DEFS, BIAS_DEFS, PLUMED_VERSIONS, createCV, createFunction, cvAvailable,
  generatePlumedInput
} from '../src/core/plumed.js';
import { loadSyntax } from '../src/core/plumed-syntax.js';

const verbose = process.argv.includes('--verbose');
const keep = process.argv.includes('--keep');
const runFrames = process.argv.includes('--run');

const bins = {};
for (const pair of String(process.env.PLUMED_BINS || '').split(',').filter(Boolean)) {
  const [v, file] = pair.split('=');
  if (PLUMED_VERSIONS.includes(v) && file) bins[v] = file;
}
if (!Object.keys(bins).length) {
  console.log('PLUMED_BINS is not set; nothing to check.');
  process.exit(0);
}

/* ---- reference files the actions read while parsing ---- */

const NATOMS = 200;

function pdbLine(serial, name, res, resid, x, y, z, occ = 1, beta = 1) {
  const n = name.length < 4 ? ` ${name}`.padEnd(4) : name;
  return `ATOM  ${String(serial).padStart(5)} ${n} ${res.padEnd(3)} A${String(resid).padStart(4)}    ` +
    `${x.toFixed(3).padStart(8)}${y.toFixed(3).padStart(8)}${z.toFixed(3).padStart(8)}` +
    `${occ.toFixed(2).padStart(6)}${beta.toFixed(2).padStart(6)}`;
}

function peptide(shift = 0) {
  const out = [];
  let serial = 1;
  for (let r = 1; r <= 12; r++) {
    for (const [i, name] of ['N', 'CA', 'C', 'O', 'CB'].entries()) {
      out.push(pdbLine(serial++, name, 'ALA', r,
        r * 3.8 + i * 0.7 + shift, Math.sin(r + i) * 2 + shift, Math.cos(r * 2 + i) * 2));
    }
  }
  return out;
}

/* A short RNA, residues RG RC RG RC, with the atoms @lcs-N picks (C2, C4,
   C6) and a few more, for ERMSD. */
function rna() {
  const out = [];
  let serial = 1;
  ['RG', 'RC', 'RG', 'RC'].forEach((res, r) => {
    for (const [i, name] of ['P', "C4'", 'N1', 'C2', 'C4', 'C6'].entries()) {
      out.push(pdbLine(serial++, name, res, r + 1,
        (r + 1) * 6.0 + i * 0.9, Math.sin(r + i) * 2.5, Math.cos(r * 2 + i) * 2.5));
    }
  });
  return out;
}

/* Two frames of NATOMS atoms on a slightly jittered simple-cubic lattice of
   0.25 nm, in a periodic box it fills, so that every atom has the four
   neighbours within 0.5 nm that the tetrahedral order parameters need and no
   three atoms are collinear. Only the running is checked, not the values. */
function trajectory() {
  const side = Math.ceil(Math.cbrt(NATOMS));
  const a = 0.25;
  const frames = [];
  for (let f = 0; f < 2; f++) {
    const lines = [String(NATOMS), `${(side * a).toFixed(3)} ${(side * a).toFixed(3)} ${(side * a).toFixed(3)}`];
    for (let i = 0; i < NATOMS; i++) {
      const g = [i % side, Math.floor(i / side) % side, Math.floor(i / (side * side))];
      const x = g.map((n, d) => n * a + 0.02 * Math.sin(1.7 * i + 2.3 * d + 0.5 * f) + 0.01);
      lines.push(`X ${x.map(v => v.toFixed(4)).join(' ')}`);
    }
    frames.push(lines.join('\n'));
  }
  return frames.join('\n');
}

function frame(shift, remark) {
  const lines = remark ? [remark] : [];
  for (let i = 1; i <= 10; i++) {
    lines.push(pdbLine(i, 'CA', 'ALA', i, i * 3.8 + shift, Math.sin(i) * 3 + shift, Math.cos(i) * 3));
  }
  lines.push('END');
  return lines.join('\n');
}

const FIXTURES = new Set();

function writeFixtures(dir) {
  const w = (name, text) => {
    FIXTURES.add(name);
    fs.writeFileSync(path.join(dir, name), `${text}\n`);
  };
  w('reference.pdb', [...peptide(), 'END'].join('\n'));
  w('ref.pdb', frame(0));
  w('path.pdb', [0, 1, 2, 3].map(s => frame(s)).join('\n'));
  w('allv.pdb', [0, 1, 2, 3].map(s => frame(s, `REMARK X=${s} Y=${s * 2}`)).join('\n'));
  w('average.pdb', frame(0));
  w('eigenvec.pdb', [1, 2].map(s => frame(s)).join('\n'));
  w('centers.dat', 'c1: CENTER ATOMS=1,2\nc2: CENTER ATOMS=3,4');
  w('rna.pdb', [...rna(), 'END'].join('\n'));
  w('traj.xyz', trajectory());
}

/* ---- cases ---- */

/* Entries that read files this script cannot write a stand-in for. */
const SKIP = {
  GHBFIX: 'reads force-field parameter tables'
};

/* Cases that parse but cannot be computed here, by release. The driver has
   no MD engine, and PLUMED 2.9's INPLANEDISTANCES aborts or crashes depending
   on the reduction and the geometry, which the builder warns about. */
const RUN_SKIP = {
  '*': ['cv ENERGY', 'cv EXTRACV'],
  '2.9': ['cv INPLANEDISTANCES', 'cv INPLANEDISTANCES (reductions)']
};

/* Starting values that name files other than the ones an entry expects. */
const FIXTURE_VALUES = { ERMSD: { REFERENCE: 'rna.pdb' } };
/* The structure MOLINFO reads, when it is not the peptide. */
const MOLINFO_FOR = { ERMSD: 'rna.pdb' };

/* Actions an entry refers to by label, defined first. */
function needsFor(type, version) {
  const old = version === '2.9';
  const q = (n) => ['a', 'b'].map((x, i) => ({
    type: `Q${n}`, label: `q${n}${x}`, values: { SPECIES: i ? '33-64' : '1-32' }
  }));
  const molecules = {
    type: 'CUSTOM', label: 'm1',
    values: {
      __raw: old
        ? 'MOLECULES MOL1=1,2,1 MOL2=9,10,9 MOL3=17,18,17 MOL4=25,26,25'
        : 'DISTANCES ATOMS1=1,2 LOCATION1=1 ATOMS2=9,10 LOCATION2=9 ATOMS3=17,18 LOCATION3=17 ATOMS4=25,26 LOCATION4=25 COMPONENTS'
    },
    print: false
  };
  return { LOCAL_Q6: q(6), LOCAL_Q4: q(4), LOCAL_Q3: q(3), SMAC: [molecules] }[type] || [];
}

function cvCases(version, syntax) {
  const cases = [];
  let seq = 0;
  for (const type of Object.keys(CV_DEFS)) {
    const def = CV_DEFS[type];
    if (!cvAvailable(def, version) || SKIP[type]) continue;
    const variants = (def.fields || []).find(f => f.variant);
    const picks = variants ? variants.options : [null];
    for (const pick of picks) {
      const config = { version, syntax, natoms: NATOMS, cvs: [], bias: { method: 'none' } };
      if (def.needsMolinfo || def.prereq) {
        config.molinfo = { structure: MOLINFO_FOR[type] || 'reference.pdb' };
        if (!MOLINFO_FOR[type]) config.whole = { enabled: true, entities: ['1-60'] };
      }
      for (const need of needsFor(type, version)) {
        const dep = createCV(need.type, ++seq, { version, syntax, label: need.label, values: need.values });
        if (need.print === false) dep.isGroup = true;
        config.cvs.push(dep);
      }
      const cv = createCV(type, ++seq, { version, syntax, values: FIXTURE_VALUES[type] });
      if (pick) cv.values[variants.k] = pick;
      config.cvs.push(cv);
      cases.push({ name: `cv ${pick || type}`, config });

      // The same CV with every flag reduction switched on, to check that each
      // component it then advertises really exists.
      if (def.compStyle === 'dot' || def.compStyle === 'underscore') {
        const all = createCV(type, ++seq, { version, syntax });
        if (pick) all.values[variants.k] = pick;
        for (const k of ['MEAN', 'SUM', 'HIGHEST', 'LOWEST']) {
          if (Object.prototype.hasOwnProperty.call(all.values, k)) all.values[k] = true;
        }
        for (const k of ['MORE_THAN', 'LESS_THAN']) {
          if (Object.prototype.hasOwnProperty.call(all.values, k)) {
            all.values[k] = '{RATIONAL R_0=0.5}; {RATIONAL R_0=0.8}';
          }
        }
        if (Object.prototype.hasOwnProperty.call(all.values, 'BETWEEN')) {
          all.values.BETWEEN = '{GAUSSIAN LOWER=0.1 UPPER=0.5 SMEAR=0.1}';
        }
        const c2 = { ...config, cvs: [...config.cvs.slice(0, -1), all] };
        cases.push({ name: `cv ${pick || type} (reductions)`, config: c2 });
      }
    }
  }
  return cases;
}

function biasCases(version, syntax) {
  const cases = [];
  for (const method of Object.keys(BIAS_DEFS)) {
    if (method === 'none') continue;
    for (const walkers of ['none', 'disk']) {
      if (walkers === 'disk' && !['metad', 'wt_metad', 'pbmetad'].includes(method)) continue;
      const d = createCV('DISTANCE', 1, { version, syntax, label: 'd1' });
      const t = createCV('TORSION', 2, { version, syntax, label: 'phi' });
      cases.push({
        name: `bias ${method}${walkers === 'disk' ? ' (walkers)' : ''}`,
        config: {
          version, syntax, natoms: NATOMS, cvs: [d, t],
          bias: {
            method, temp: '300', stride: '500', grid: true, rct: method === 'wt_metad',
            walkers: { mode: walkers, n: 4, id: 0, dir: '.', rstride: 100 }
          }
        }
      });
    }
  }
  return cases;
}

function otherCases(version, syntax) {
  const d1 = createCV('DISTANCE', 1, { version, syntax, label: 'd1' });
  const d2 = createCV('DISTANCE', 2, { version, syntax, label: 'd2', values: { ATOMS: '3,4' } });
  d1.bias = false; d2.bias = false;
  const combine = createFunction('COMBINE', 1, {
    label: 'rc', args: ['d1', 'd2'], values: { COEFFICIENTS: '0.5,-1.5' }
  });
  combine.bias = true;
  const custom = createFunction('CUSTOM', 2, { label: 'diff', args: ['d1', 'd2'], values: { FUNC: 'x - y' } });
  const many = createFunction('CUSTOM', 3, {
    label: 'm', args: ['d1', 'd2', 'rc', 'diff'], values: { VAR: 'a,b,c,d', FUNC: 'a+b+c+d' }
  });
  const base = { version, syntax, natoms: NATOMS };
  return [
    {
      name: 'functions, biased COMBINE, walls, two PRINTs',
      config: {
        ...base, cvs: [d1, d2], functions: [combine, custom, many],
        bias: { method: 'wt_metad', temp: '300', stride: '500', grid: true },
        restraints: [
          { type: 'upper', arg: 'd1', at: '3.0', kappa: '150' },
          { type: 'lower', arg: 'd2', at: '0.2', kappa: '150', exp: '4' },
          { type: 'restraint', arg: 'diff', at: '0.0', kappa: '10' }
        ],
        prints: [
          { file: 'COLVAR', stride: 500 },
          { file: 'BIAS', stride: 100, args: ['metad.bias', 'uw1.bias'] }
        ]
      }
    },
    {
      name: 'preamble, units, include',
      config: {
        ...base, cvs: [createCV('DISTANCE', 1, { version, syntax, values: { ATOMS: 'c1,c2' } })],
        units: { length: 'A', energy: 'kcal/mol', time: 'fs' },
        preamble: { restart: false, include: ['centers.dat'], flush: 1000 },
        bias: { method: 'none' }
      }
    },
    {
      name: 'restart',
      config: {
        ...base, cvs: [createCV('DISTANCE', 1, { version, syntax })],
        preamble: { restart: true }, bias: { method: 'none' }
      }
    }
  ];
}

/* ---- run ---- */

function parse(bin, dir, input) {
  // PLUMED keeps a backup of every output it finds, up to a hundred of them.
  for (const f of fs.readdirSync(dir)) {
    if (!FIXTURES.has(f)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(dir, 'plumed.dat'), input);
  const args = runFrames
    ? ['driver', '--ixyz', 'traj.xyz', '--plumed', 'plumed.dat']
    : ['driver', '--natoms', String(NATOMS), '--parse-only', '--plumed', 'plumed.dat'];
  try {
    execFileSync(bin, args,
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return '';
  } catch (e) {
    const out = `${e.stdout || ''}\n${e.stderr || ''}`;
    const lines = out.split('\n').map(l => l.replace(/^PLUMED:\s?/, '').trim());
    const at = lines.findIndex(l => /ERROR|error|assertion failed|Segmentation fault/.test(l));
    return (at > -1 ? lines.slice(at, at + 3) : lines.slice(-6)).filter(Boolean).join(' / ')
      .slice(0, 400) || 'failed without a message';
  }
}

let failed = 0;
let total = 0;
for (const version of Object.keys(bins)) {
  const syntax = await loadSyntax(version);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stemkit-plumed-${version}-`));
  writeFixtures(dir);
  const cases = [...cvCases(version, syntax), ...biasCases(version, syntax), ...otherCases(version, syntax)];
  let bad = 0;
  for (const c of cases) {
    if (runFrames && [...RUN_SKIP['*'], ...(RUN_SKIP[version] || [])].includes(c.name)) continue;
    const { input } = generatePlumedInput(c.config);
    const error = parse(bins[version], dir, input);
    total += 1;
    if (error) {
      bad += 1;
      console.log(`FAIL  PLUMED ${version}  ${c.name}\n      ${error}`);
      if (verbose) console.log(input.split('\n').filter(l => l && !l.startsWith('#')).map(l => `      | ${l}`).join('\n'));
    }
  }
  const tried = runFrames
    ? cases.filter(c => ![...RUN_SKIP['*'], ...(RUN_SKIP[version] || [])].includes(c.name)).length
    : cases.length;
  console.log(`PLUMED ${version}: ${tried - bad} of ${tried} inputs ${runFrames ? 'run' : 'parse'}.`);
  failed += bad;
  if (keep) console.log(`  files kept in ${dir}`);
  else fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} of ${total} failed.` : `All ${total} inputs ${runFrames ? 'run' : 'parse'}.`);
process.exit(failed ? 1 : 0);
