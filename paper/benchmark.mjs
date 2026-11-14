#!/usr/bin/env node
/**
 * The throughput figures of section 1.2 of the preprint.
 *
 *   node paper/benchmark.mjs            # from the repository root
 *
 * Builds a two-million-row, three-column .xvg and a million-atom PDB in memory,
 * then times `parseXvg`, and `parsePDB` followed by `centreOfMass`, five times
 * each. It prints the first run (the engine is still warming up) and the median
 * of the five, with the machine and Node.js version, which are what the paper
 * has to state. Generating the files is not timed. The PDB serials wrap modulo
 * 100000, as the fixed column requires.
 */
import os from 'node:os';
import { parseXvg, parsePDB, centreOfMass } from '../src/core/node.js';

const ROWS = 2_000_000;
const ATOMS = 1_000_000;
const RUNS = 5;

const col = (x, d) => x.toFixed(d).padStart(11);
const rows = new Array(ROWS);
for (let i = 0; i < ROWS; i++) {
  rows[i] = `${col(i * 0.002, 3)} ${col(0.1 + Math.sin(i / 1e4) * 0.05, 6)} ${col(1.5 + Math.cos(i / 7e3) * 0.2, 6)}`;
}
const xvg = '@ title "benchmark"\n@ xaxis label "Time (ps)"\n' + rows.join('\n') + '\n';

const lines = new Array(ATOMS);
for (let i = 0; i < ATOMS; i++) {
  const serial = String((i + 1) % 100000).padStart(5);
  const resi = String((i % 9999) + 1).padStart(4);
  const x = ((i % 100) * 3.1).toFixed(3).padStart(8);
  const y = ((((i / 100) | 0) % 100) * 3.1).toFixed(3).padStart(8);
  const z = (((i / 10000) | 0) * 3.1).toFixed(3).padStart(8);
  lines[i] = `ATOM  ${serial}  CA  ALA A${resi}    ${x}${y}${z}  1.00  0.00           C`;
}
const pdb = lines.join('\n') + '\nEND\n';

function time(label, size, fn) {
  const t = [];
  for (let k = 0; k < RUNS; k++) {
    const t0 = performance.now();
    fn();
    t.push((performance.now() - t0) / 1000);
  }
  const sorted = [...t].sort((a, b) => a - b);
  console.log(`${label}: ${size}; first run ${t[0].toFixed(2)} s, median of ${RUNS} ${sorted[Math.floor(RUNS / 2)].toFixed(2)} s`);
  return sorted[Math.floor(RUNS / 2)];
}

const cpu = os.cpus()[0];
console.log(`${cpu.model}, ${os.cpus().length} threads, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB, Node.js ${process.version}`);
const tx = time('parseXvg', `${ROWS} rows, ${(xvg.length / 1e6).toFixed(0)} MB`, () => parseXvg(xvg));
console.log(`  = ${(ROWS / tx / 1e6).toFixed(2)} million rows per second`);
time('parsePDB + centreOfMass', `${ATOMS} atoms, ${(pdb.length / 1e6).toFixed(0)} MB`, () => centreOfMass(parsePDB(pdb).atoms));
