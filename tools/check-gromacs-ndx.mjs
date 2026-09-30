#!/usr/bin/env node
/*
 * check-gromacs-ndx.mjs: hand the structures and make_ndx commands the index
 * tests use to GROMACS itself, and compare what `gmx make_ndx` writes with
 * what src/core/gromacs-ndx.js writes, byte for byte.
 *
 *     GMX_BIN=/path/to/gmx node tools/check-gromacs-ndx.mjs [--write] [--verbose] [file ...]
 *
 * Checked: every .gro and .pdb in tests/fixtures/gromacs-ndx, the large
 * generated system, the test structures of a GROMACS source tree at the
 * repository root (gromacs-*), any structure named on the command line, and
 * every command sequence in tests/fixtures/gromacs-ndx/commands.json.
 *
 * With --write, the expected results the tests read (the fixture .ndx files,
 * the digests in commands.json and large-system.json) are rewritten from
 * make_ndx's output instead of compared. GMX_BIN may name gmx or gmx_mpi; the
 * MPI build runs without mpirun.
 *
 * Exits 0 when nothing differs, or when GMX_BIN is unset (nothing to check).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readGromacsStructure, defaultGroups, makeNdx, writeNdx, parseNdx
} from '../src/core/gromacs-ndx.js';
import { largeSystemGro } from '../tests/fixtures/gromacs-ndx/large-system.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(root, 'tests', 'fixtures', 'gromacs-ndx');
const args = process.argv.slice(2);
const write = args.includes('--write');
const verbose = args.includes('--verbose');
const extra = args.filter(a => !a.startsWith('--'));

const GMX = process.env.GMX_BIN;
if (!GMX) {
  console.log('GMX_BIN is not set; nothing to check.');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-ndx-'));
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

function makeNdxRef(file, input = 'q\n') {
  const out = path.join(tmp, 'out.ndx');
  fs.rmSync(out, { force: true });
  execFileSync(GMX, ['-quiet', 'make_ndx', '-f', file, '-o', out],
    { input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  return fs.readFileSync(out, 'utf8');
}

let failures = 0;
let checked = 0;
function report(ok, label, detail = '') {
  checked += 1;
  if (!ok) failures += 1;
  if (!ok || verbose) console.log(`${ok ? 'ok  ' : 'DIFF'} ${label}${detail ? `  ${detail}` : ''}`);
}

function firstDifference(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i + 1}: make_ndx "${la[i]}" vs ours "${lb[i]}"`;
  }
  return '';
}

/* ---- default groups ---- */

const structures = fs.readdirSync(FIX)
  .filter(f => /\.(gro|pdb)$/.test(f)).sort().map(f => path.join(FIX, f));
for (const dir of fs.readdirSync(root).filter(d => /^gromacs-/.test(d))) {
  const db = path.join(root, dir, 'src', 'testutils', 'simulationdatabase');
  if (fs.existsSync(db)) {
    const found = fs.readdirSync(db).filter(f => /\.(gro|pdb)$/.test(f)).sort();
    structures.push(...found.map(f => path.join(db, f)));
  }
}
structures.push(...extra);

for (const file of structures) {
  const ref = makeNdxRef(file);
  const ours = writeNdx(defaultGroups(readGromacsStructure(fs.readFileSync(file, 'utf8'), file)));
  const inFixtures = path.dirname(path.resolve(file)) === FIX;
  const expected = path.join(FIX, `${path.basename(file).replace(/\.(gro|pdb)$/, '')}.ndx`);
  if (inFixtures && write) fs.writeFileSync(expected, ref);
  const label = path.relative(root, path.resolve(file));
  report(ours === ref, label, ours === ref ? '' : firstDifference(ref, ours));
  if (inFixtures && !write && fs.existsSync(expected)) {
    const current = fs.readFileSync(expected, 'utf8') === ref;
    report(current, `${path.relative(root, expected)} is current`);
  }
}

/* ---- the large generated system ---- */

{
  const file = path.join(tmp, 'large.gro');
  const text = largeSystemGro();
  fs.writeFileSync(file, text);
  const ref = makeNdxRef(file);
  const ours = writeNdx(defaultGroups(readGromacsStructure(text, 'large.gro')));
  report(ours === ref, 'large generated system (314 648 atoms)');
  const summary = {
    sha256: sha(ref),
    groups: parseNdx(ref).groups.map(g => [g.name, g.atoms.length])
  };
  const jsonFile = path.join(FIX, 'large-system.json');
  if (write) {
    const rows = summary.groups.map(g => `    ${JSON.stringify(g)}`).join(',\n');
    const head = `{\n  "sha256": "${summary.sha256}",\n  "groups": [\n`;
    fs.writeFileSync(jsonFile, `${head}${rows}\n  ]\n}\n`);
  }
  else if (fs.existsSync(jsonFile)) {
    const stored = JSON.stringify(JSON.parse(fs.readFileSync(jsonFile, 'utf8')));
    report(stored === JSON.stringify(summary), 'large-system.json is current');
  }
}

/* ---- make_ndx commands ---- */

const casesFile = path.join(FIX, 'commands.json');
if (fs.existsSync(casesFile)) {
  const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  for (const c of cases) {
    const file = path.join(FIX, c.file);
    const ref = makeNdxRef(file, `${c.commands}\nq\n`);
    const structure = readGromacsStructure(fs.readFileSync(file, 'utf8'), file);
    const ours = writeNdx(makeNdx(structure, `${c.commands}\nq`).groups);
    const label = `${c.file}: ${JSON.stringify(c.commands)}`;
    report(ours === ref, label, ours === ref ? '' : firstDifference(ref, ours));
    const groups = parseNdx(ref).groups;
    const last = groups[groups.length - 1];
    const expect = {
      groups: groups.length, last: last.name, atoms: last.atoms.length, sha256: sha(ref)
    };
    if (write) Object.assign(c, expect);
    else {
      const current = c.sha256 === expect.sha256 && c.groups === expect.groups;
      report(current, `${label} digest is current`);
    }
  }
  if (write) {
    fs.writeFileSync(casesFile, `[\n${cases.map(c => `  ${JSON.stringify(c)}`).join(',\n')}\n]\n`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
const note = write ? ' (fixtures rewritten)' : '';
console.log(`${checked - failures}/${checked} checks agree with ${path.basename(GMX)}${note}.`);
process.exit(failures ? 1 : 0);
