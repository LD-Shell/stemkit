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
 * every command sequence in tests/fixtures/gromacs-ndx/commands.json. Then
 * two checks beyond make_ndx: grompp's verdict on each .mdp in
 * mdp-groups.json against checkMdpGroups, and `gmx select` on the periodic
 * system (periodic-system.mjs) against customGroup for each selection in
 * periodic-select.json.
 *
 * With --write, the expected results the tests read (the fixture .ndx files,
 * the digests in commands.json and large-system.json, grompp's verdicts and
 * gmx select's atoms) are rewritten from GROMACS's output instead of
 * compared. GMX_BIN may name gmx or gmx_mpi; the MPI build runs without
 * mpirun.
 *
 * Exits 0 when nothing differs, or when GMX_BIN is unset (nothing to check).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readGromacsStructure, defaultGroups, makeNdx, writeNdx, parseNdx, checkMdpGroups, customGroup
} from '../src/core/gromacs-ndx.js';
import { largeSystemGro } from '../tests/fixtures/gromacs-ndx/large-system.mjs';
import { periodicSystemGro } from '../tests/fixtures/gromacs-ndx/periodic-system.mjs';

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

/* ---- grompp's verdict on the groups an .mdp names ---- */

/*
 * The argon system, index and .mdp cases in mdp-groups.json: grompp either
 * accepts each .mdp or stops, and checkMdpGroups must say the same. Warnings
 * are allowed (-maxwarn), since only the groups are in question.
 */
const mdpFile = path.join(FIX, 'mdp-groups.json');
if (fs.existsSync(mdpFile)) {
  const spec = JSON.parse(fs.readFileSync(mdpFile, 'utf8'));
  const dir = path.join(tmp, 'grompp');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'ar.gro'), spec.gro);
  fs.writeFileSync(path.join(dir, 'ar.top'), spec.top);
  fs.writeFileSync(path.join(dir, 'index.ndx'), spec.index);
  const n = readGromacsStructure(spec.gro, 'ar.gro').atoms.length;
  const groups = parseNdx(spec.index).groups;
  for (const c of spec.cases) {
    const mdp = { ...spec.base, ...c.mdp };
    fs.writeFileSync(path.join(dir, 'run.mdp'),
      Object.entries(mdp).map(([k, v]) => `${k} = ${v}`).join('\n') + '\n');
    const r = spawnSync(GMX, ['-quiet', 'grompp', '-f', 'run.mdp', '-c', 'ar.gro', '-p', 'ar.top',
      '-n', 'index.ndx', '-o', 'run.tpr', '-po', 'out.mdp', '-maxwarn', '20'],
    { cwd: dir, encoding: 'utf8' });
    const accepted = r.status === 0;
    const log = `${r.stdout}\n${r.stderr}`;
    const fatal = /Fatal error:\n([^\n]+)/.exec(log) || /ERROR 1 \[[^\]]*\]:\n\s*([^\n]+)/.exec(log);
    const message = accepted ? '' : (fatal ? fatal[1].trim() : 'grompp failed');
    const ours = checkMdpGroups(groups, mdp, n).ok;
    report(ours === accepted, `grompp: ${c.label}`,
      ours === accepted ? '' : `grompp ${accepted ? 'accepts' : `stops (${message})`}, we say ${ours}`);
    if (write) Object.assign(c, { grompp: accepted, message });
    else report(c.grompp === accepted, `grompp: ${c.label} is recorded`);
  }
  if (write) {
    const cases = spec.cases.map(c => `    ${JSON.stringify(c)}`).join(',\n');
    fs.writeFileSync(mdpFile, `{\n  "gro": ${JSON.stringify(spec.gro)},\n` +
      `  "top": ${JSON.stringify(spec.top)},\n  "index": ${JSON.stringify(spec.index)},\n` +
      `  "base": ${JSON.stringify(spec.base)},\n  "cases": [\n${cases}\n  ]\n}\n`);
  }
}

/* ---- gmx select through the periodic boundary ---- */

const selectFile = path.join(FIX, 'periodic-select.json');
if (fs.existsSync(selectFile)) {
  const cases = JSON.parse(fs.readFileSync(selectFile, 'utf8'));
  const file = path.join(tmp, 'periodic.gro');
  const text = periodicSystemGro();
  fs.writeFileSync(file, text);
  const top = readGromacsStructure(text, 'periodic.gro');
  const out = path.join(tmp, 'select.ndx');
  for (const c of cases) {
    fs.rmSync(out, { force: true });
    execFileSync(GMX, ['-quiet', 'select', '-s', file, '-select', c.select, '-on', out],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const ref = parseNdx(fs.readFileSync(out, 'utf8')).groups[0].atoms;
    const ours = customGroup(top, c.spec, c.options || {}).atoms;
    const same = ours.join(' ') === ref.join(' ');
    const label = `gmx select "${c.select}" as ${JSON.stringify(c.spec)}`;
    report(same, label, same ? '' : `gmx select ${ref.length} atoms, we ${ours.length}`);
    const expect = { atoms: ref.length, sha256: sha(ref.join(' ')) };
    if (write) Object.assign(c, expect);
    else report(c.sha256 === expect.sha256 && c.atoms === expect.atoms, `${label} is recorded`);
  }
  if (write) {
    fs.writeFileSync(selectFile, `[\n${cases.map(c => `  ${JSON.stringify(c)}`).join(',\n')}\n]\n`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
const note = write ? ' (fixtures rewritten)' : '';
console.log(`${checked - failures}/${checked} checks agree with ${path.basename(GMX)}${note}.`);
process.exit(failures ? 1 : 0);
