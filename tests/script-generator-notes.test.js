import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGromacsStructure, defaultGroups, writeNdx, parseNdx } from '../src/core/gromacs-ndx.js';
import { generatePlumedInput } from '../src/core/plumed.js';

/**
 * The MD Workflow Generator's prose (how it works, the method notes, the
 * hints and the FAQ) held to what it describes: the page's own controls, the
 * core library and, when they are installed, GROMACS and PLUMED themselves.
 *
 * Prose drifts without any other test failing. The version menu gained 2.11
 * while the notes still said "2.9 or 2.10"; the notes quoted `plumed
 * --version`, which PLUMED refuses; they promised `COORDINATION` a linked-cell
 * speed-up that PLUMED only gives multicolvars; and they said the index file
 * matched `gmx make_ndx` byte for byte without naming the one group written
 * differently on purpose. Each test below reads the page as a visitor does
 * and fails when a claim stops matching its subject.
 *
 * Optional programs, skipped when absent:
 *   GMX_BIN=/path/to/gmx   gmx or gmx_mpi (the MPI build runs without mpirun)
 *   plumed on the PATH
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'script-generator.html'), 'utf8');
const CHANGELOG = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

const GMX = process.env.GMX_BIN || '';
const hasGromacs = Boolean(GMX) && fs.existsSync(GMX);
const plumedVersion = (() => {
  const r = spawnSync('plumed', ['info', '--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
})();
const hasPlumed = plumedVersion !== '';

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', ge: '≥', le: '≤',
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", hellip: '…', rarr: '→', ndash: '–', mdash: '—' };

/** What a visitor reads: tags dropped, entities decoded, white space collapsed. */
function visible(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-z]+);/g, (m, name) => ENTITIES[name] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The page's paragraphs, list items, notes and FAQ answers, as visible text.
 * A claim and its qualification sit in the same one of these, so this is
 * the unit the tests read. Notes nest a <div> in a <div>, hence the lazy
 * match up to the note's own closing pair.
 */
function blocks(html) {
  const out = [];
  for (const re of [/<p\b[^>]*>([\s\S]*?)<\/p>/g, /<li\b[^>]*>([\s\S]*?)<\/li>/g,
    /<details\b[^>]*>([\s\S]*?)<\/details>/g, /<div class="stk-note"[^>]*>([\s\S]*?)<\/div><\/div>/g]) {
    for (const m of html.matchAll(re)) out.push(visible(m[1]));
  }
  return out;
}

/** The Method pane of one engine, from its tab to the next one. */
function methodPane(name) {
  const start = PAGE.indexOf(`data-doc-pane="${name}"`);
  const next = PAGE.indexOf('data-doc-pane="', start + 1);
  expect(start).toBeGreaterThan(0);
  return PAGE.slice(start, next > start ? next : undefined);
}

/** A FAQ entry's question and answer, found by the start of the question. */
function faq(question) {
  const m = [...PAGE.matchAll(/<details class="stk-faq">([\s\S]*?)<\/details>/g)]
    .find(d => visible(d[1]).startsWith(question));
  expect(m).toBeDefined();
  return visible(m[1]);
}

/** Every "PLUMED 2.9, 2.10 or 2.11"-style list of releases in a text. */
function releaseLists(text) {
  const lists = [];
  for (const m of text.matchAll(/PLUMED (\d+\.\d+(?:(?:, | or | and )\d+\.\d+)+)/g)) {
    lists.push(m[1].split(/, | or | and /));
  }
  return lists;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-notes-'));
}

/* ------------------------------------------------------------------ *
 * Index groups: "byte for byte", and the one group written otherwise
 * ------------------------------------------------------------------ */

/* Two atoms whose residue name is blank: make_ndx makes a nameless group. */
const BLANK_RESNAME_PDB =
  'ATOM      1  C1           1       1.000   1.000   1.000  1.00  0.00           C\n' +
  'ATOM      2  C2           1       2.000   1.000   1.000  1.00  0.00           C\n' +
  'END\n';
const OURS = '[ System ]\n   1    2\n[ Other ]\n   1    2\n[ Group ]\n   1    2\n';

describe('index groups: the notes name the one group not written as make_ndx writes it', () => {
  const claim = /make_ndx(?: \w+)? (?:exactly|byte for byte)|exactly the groups `?gmx make_ndx/;

  test('every claim of exact agreement with make_ndx on the page says a nameless group becomes Group', () => {
    const claims = blocks(PAGE).filter(b => claim.test(b));
    expect(claims.length).toBeGreaterThanOrEqual(2);
    for (const b of claims) expect(b).toMatch(/\bGroup\b/);
  });

  test('and so does the changelog', () => {
    const claims = CHANGELOG.split(/\n(?=- )|\n\n/).map(b => b.replace(/\s+/g, ' ')).filter(b => claim.test(b));
    expect(claims.length).toBeGreaterThanOrEqual(1);
    for (const b of claims) expect(b).toMatch(/`Group`/);
  });

  test('writeNdx names the group of a blank residue name Group, as the notes say', () => {
    const top = readGromacsStructure(BLANK_RESNAME_PDB, 'blank.pdb');
    expect(writeNdx(defaultGroups(top))).toBe(OURS);
  });

  test('the reason given holds: GROMACS\'s reader takes "[  ]" for two atom numbers of the group before', () => {
    // parseNdx ports init_index; make_ndx's own output for the file above.
    const theirs = OURS.replace('[ Group ]', '[  ]');
    const { groups } = parseNdx(theirs);
    expect(groups.map(g => g.name)).toEqual(['System', 'Other']);
    expect(groups[1].atoms).toEqual([1, 2, 0, 0, 1, 2]);
  });

  (hasGromacs ? test : test.skip)('real make_ndx: "[  ]" is the only difference, and GROMACS cannot read it back', () => {
    const dir = tmpdir();
    try {
      fs.writeFileSync(path.join(dir, 'blank.pdb'), BLANK_RESNAME_PDB);
      const run = args => spawnSync(GMX, ['make_ndx', '-quiet', ...args],
        { cwd: dir, input: 'q\n', encoding: 'utf8', env: { ...process.env, OMP_NUM_THREADS: '1' } });
      expect(run(['-f', 'blank.pdb', '-o', 'blank.ndx']).status).toBe(0);
      const theirs = fs.readFileSync(path.join(dir, 'blank.ndx'), 'utf8');
      expect(theirs).toContain('\n[  ]\n');
      expect(theirs.replace('\n[  ]\n', '\n[ Group ]\n')).toBe(OURS);

      expect(run(['-f', 'blank.pdb', '-n', 'blank.ndx', '-o', 'back.ndx']).status).toBe(0);
      const back = parseNdx(fs.readFileSync(path.join(dir, 'back.ndx'), 'utf8')).groups;
      expect(back.map(g => g.name)).toEqual(['System', 'Other']);
      expect(back[1].atoms).toEqual([1, 2, 0, 0, 1, 2]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * COORDINATION: a neighbour list, not linked cells
 * ------------------------------------------------------------------ */

describe('PLUMED speed notes: linked cells are for multicolvars, NLIST for COORDINATION', () => {
  test('no note ties linked cells to COORDINATION, except to say it has none', () => {
    // The bare word, any case: COORDINATIONNUMBER and COORDINATION_MOMENTS are
    // multicolvars and do get linked cells.
    const about = blocks(PAGE).filter(b => /linked[- ]cells?/i.test(b) && /\bcoordination\b/i.test(b));
    for (const b of about) expect(b).toMatch(/no linked cells/);
  });

  test('advice on D_MAX for COORDINATION points to NLIST instead', () => {
    const advice = blocks(PAGE).filter(b => /\bCOORDINATION\b/.test(b) && /\bD_MAX\b/.test(b));
    expect(advice.length).toBeGreaterThanOrEqual(2);
    for (const b of advice) {
      expect(b).toMatch(/\bNLIST\b/);
      expect(b).toMatch(/no linked cells|does not speed it up/);
    }
    const note = advice.find(b => b.startsWith('A neighbour list for COORDINATION'));
    expect(note).toMatch(/NL_CUTOFF/);
    expect(note).toMatch(/NL_STRIDE/);
  });

  test('the D_MAX note names the multicolvars it helps', () => {
    const note = blocks(methodPane('plumed')).find(b => /^Set D_MAX on/.test(b));
    expect(note).toMatch(/multicolvar/);
    expect(note).toMatch(/COORDINATIONNUMBER/);
    expect(note).not.toMatch(/\bcoordination\b/i);
  });

  const [major, minor] = plumedVersion.split('.').map(Number);
  const atLeast210 = hasPlumed && (major > 2 || (major === 2 && minor >= 10));
  (atLeast210 ? test : test.skip)('real PLUMED (2.10 or later logs its link cells): COORDINATIONNUMBER uses them with D_MAX, COORDINATION does not', () => {
    const dir = tmpdir();
    try {
      // Forty atoms on a jittered grid in a 2 nm box; only the log matters.
      const rows = [];
      for (let i = 0; i < 40; i++) {
        rows.push(`X ${(0.1 + (i % 4) * 0.45).toFixed(3)} ${(0.1 + (Math.floor(i / 4) % 5) * 0.37).toFixed(3)} ` +
          `${(0.1 + Math.floor(i / 20) * 0.9 + (i % 3) * 0.05).toFixed(3)}`);
      }
      fs.writeFileSync(path.join(dir, 'x.xyz'), `40\n2 2 2\n${rows.join('\n')}\n`);
      const log = (input) => {
        fs.writeFileSync(path.join(dir, 'plumed.dat'), input);
        const r = spawnSync('plumed', ['driver', '--ixyz', 'x.xyz', '--length-units', 'nm', '--box', '2,2,2',
          '--plumed', 'plumed.dat'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PLUMED_NUM_THREADS: '1' } });
        expect(r.status).toBe(0);
        return r.stdout;
      };
      const sw = 'SWITCH={RATIONAL R_0=0.3 D_MAX=0.6}';
      const cn = log(`cn: COORDINATIONNUMBER SPECIES=1-40 ${sw} MEAN\nPRINT ARG=cn.mean FILE=colvar\n`);
      const c = log(`c: COORDINATION GROUPA=1-20 GROUPB=21-40 ${sw}\nPRINT ARG=c FILE=colvar\n`);
      expect(cn).toMatch(/link cell cutoff/i);
      expect(c).not.toMatch(/link cell/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * PLUMED versions, where they are chosen, and the commands quoted
 * ------------------------------------------------------------------ */

describe('PLUMED notes: the releases, the menu and the commands match the page', () => {
  const menu = PAGE.match(/<select id="plumedVersion"[^>]*>([\s\S]*?)<\/select>/);
  const offered = [...menu[1].matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
  const lead = visible(methodPane('plumed').match(/<p class="stk-lead">([\s\S]*?)<\/p>/)[1]);
  const answer = faq('How does the PLUMED builder help me?');

  test('the notes and the FAQ list exactly the releases the menu offers', () => {
    expect(offered.length).toBeGreaterThanOrEqual(3);
    for (const text of [lead, answer]) {
      const lists = releaseLists(text);
      expect(lists.length).toBeGreaterThanOrEqual(1);
      for (const list of lists) expect(list).toEqual(offered);
    }
  });

  test('they say where the menu is: the panel that holds it', () => {
    const at = PAGE.indexOf('<select id="plumedVersion"');
    const panel = PAGE.lastIndexOf('<section class="stk-panel"', at);
    const title = visible(PAGE.slice(panel, at).match(/<h2 class="stk-panel-t"[^>]*>([\s\S]*?)<\/h2>/)[1]);
    expect(title).toBe('System and setup');
    for (const text of [lead, answer]) {
      expect(text).toContain(title);
      expect(text).not.toMatch(/next to the CV list/);
    }
  });

  // Every `plumed ...` command a visitor may copy from the page.
  const commands = [...PAGE.matchAll(/<code>(plumed [^<]*)<\/code>/g)].map(m => visible(m[1]));

  test('every quoted plumed command starts with a subcommand, not an option', () => {
    // `plumed --version` and `plumed --multi N` are refused: PLUMED's own
    // options are for installation checks; the work is done by subcommands.
    expect(commands.length).toBeGreaterThanOrEqual(3);
    for (const c of commands) expect(c.split(/\s+/)[1]).toMatch(/^[a-z][a-z_-]*$/);
    expect(commands).toContain('plumed info --version');
  });

  test('the header the note describes is the header every generated file has', () => {
    const note = blocks(methodPane('plumed')).find(b => /file's header/.test(b));
    const check = note.match(/plumed driver [^,]*plumed\.dat/)[0];
    for (const version of offered) {
      const header = generatePlumedInput({ version }).input.split('\n').slice(0, 5).join('\n');
      expect(header).toContain(`# Target: PLUMED ${version}`);
      expect(header).toContain(check);
    }
  });

  (hasPlumed ? test : test.skip)('real PLUMED accepts every quoted command\'s subcommand and options', () => {
    for (const c of commands) {
      const [, sub, ...rest] = c.split(/\s+/);
      const help = spawnSync('plumed', [sub, '--help'], { encoding: 'utf8' });
      expect({ command: c, status: help.status }).toEqual({ command: c, status: 0 });
      const text = help.stdout + help.stderr;
      for (const opt of rest.filter(t => t.startsWith('--')).map(t => t.split('=')[0])) {
        expect({ command: c, listed: text.includes(`${opt} `) }).toEqual({ command: c, listed: true });
      }
    }
    expect(spawnSync('plumed', ['--version'], { encoding: 'utf8' }).status).not.toBe(0);
  });
});
