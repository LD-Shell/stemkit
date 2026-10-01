import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STAGE_KEYS, unitLabels, lengthOptions, formatTime, formatBytes, formatCount, lammpsLineHtml, lineHtml,
  expandIncludes, explainFiles, statusOfFile, packagesFromHelp
} from '../js/script-generator-lammps-model.js';

/*
 * The LAMMPS tab of the MD Workflow Generator: the plain functions behind
 * it (js/script-generator-lammps-model.js) and the page's markup, which the
 * tab's script and the saved settings rely on. The tab draws what
 * src/core/lammps-workflow.js builds and src/core/lammps-input.js checks;
 * their own tests hold them to LAMMPS itself.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'script-generator.html'), 'utf8');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** The text a pane shows for a line of HTML: tags dropped, entities back. */
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** The markup between two comments of the page. */
function section(startMarker, endMarker) {
  const a = PAGE.indexOf(startMarker);
  const b = PAGE.indexOf(endMarker, a + 1);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  return PAGE.slice(a, b);
}
const LAMMPS_PANEL = section('<!-- ============ LAMMPS PANEL ============ -->', '<!-- ============ PLUMED PANEL ============ -->');
const LAMMPS_VIEWS = section('<!-- LAMMPS: the run files, every command and style, and checking an input -->', '<section id="scriptBox"');
const LAMMPS_STEPS = section('<!-- LAMMPS set-up: four views of #lammpsPanel', '<!-- CLUSTER PARAMETERS -->');
const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);

describe('units: labels and lengths in the style\'s time unit', () => {
  test('real: fs steps, lengths given in ps or ns', () => {
    const u = unitLabels(null, 'real');
    expect(u.labels.time).toBe('fs');
    expect(u.labels.distance).toBe('Å');
    expect(u.labels.pressure).toBe('atm');
    expect(u.toTime(100, 'ps')).toBe(100000);
    expect(u.toTime(1, 'ns')).toBe(1000000);
    expect(u.toTime(2, 'fs')).toBe(2);
  });

  test('metal: ps is the time unit', () => {
    const u = unitLabels(null, 'metal');
    expect(u.labels.time).toBe('ps');
    expect(u.labels.pressure).toBe('bar');
    expect(u.toTime(1, 'ns')).toBe(1000);
    expect(u.toTime(500, 'fs')).toBe(0.5);
  });

  test('lj: reduced time, no conversion, a single length unit', () => {
    const u = unitLabels(null, 'lj');
    expect(u.timeInPs).toBeNull();
    expect(u.outUnit).toBe('tau');
    expect(u.toTime(50, 'tau')).toBe(50);
    expect(lengthOptions('lj')).toEqual([{ value: 'tau', label: 'τ' }]);
    expect(lengthOptions('real').map(o => o.value)).toEqual(['fs', 'ps', 'ns']);
  });

  test('the reference\'s unit table is used when it has loaded', async () => {
    const { UNITS } = await import('../src/core/lammps-reference.js');
    for (const style of Object.keys(UNITS)) {
      const u = unitLabels(UNITS, style);
      expect(u.labels.time).toBe(UNITS[style].time);
      expect(u.labels.distance).toBe(UNITS[style].distance);
    }
    expect(unitLabels(UNITS, 'real').toTime(1, 'ps')).toBe(1000);
  });

  test('times read as people say them', () => {
    expect(formatTime(100000, unitLabels(null, 'real'))).toBe('100 ps');
    expect(formatTime(2, unitLabels(null, 'real'))).toBe('2 fs');
    expect(formatTime(1000, unitLabels(null, 'metal'))).toBe('1 ns');
    expect(formatTime(5000, unitLabels(null, 'lj'))).toBe('5,000 τ');
    expect(formatBytes(1234567)).toBe('1.23 MB');
    expect(formatCount(50000000)).toBe('50,000,000');
  });
});

describe('an input line, coloured', () => {
  const lines = [
    'fix 1 all nvt temp 300.0 300.0 100.0 # thermostat',
    'pair_style lj/charmm/coul/long 8.0 10.0 &',
    'variable T equal ${temp}*2 # "quoted # not a comment"',
    "print 'a # b' # then a comment",
    '# ---- Thermostat ----',
    '   ',
    'dump 1 all custom 100 dump.lammpstrj id type x y z',
    'if "${rstep} < 0" then "include in.system" else "read_restart a.restart.${rstep}"',
    'run 1000 <&> "x"'
  ];

  test('every character is kept, so Copy hands out the file', () => {
    for (const l of lines) {
      expect(text(lammpsLineHtml(l, esc))).toBe(l);
      expect(text(lammpsLineHtml(l, esc, true))).toBe(l);
    }
  });

  test('the command, the style, variables, comments and continuation marks', () => {
    const fix = lammpsLineHtml(lines[0], esc);
    expect(fix).toContain('<span class="tok-k">fix</span>');
    expect(fix).toContain('<span class="tok-st">nvt</span>');
    expect(fix).toContain('<span class="tok-c"># thermostat</span>');
    const pair = lammpsLineHtml(lines[1], esc);
    expect(pair).toContain('<span class="tok-st">lj/charmm/coul/long</span>');
    expect(pair).toContain('<span class="tok-d">&amp;</span>');
    expect(lammpsLineHtml(lines[2], esc)).toContain('<span class="tok-v">${temp}</span>');
    // A # inside quotes does not start a comment.
    expect(lammpsLineHtml(lines[3], esc)).toContain('<span class="tok-s">\'a # b\'</span>');
    expect(lammpsLineHtml(lines[4], esc)).toBe('<span class="tok-h"># ---- Thermostat ----</span>');
  });

  test('a continuation line has no command of its own', () => {
    expect(lammpsLineHtml('   10.0 12.0', esc, true)).not.toContain('tok-k');
  });

  test('the other files keep their own colouring', () => {
    const shell = (l) => `<sh>${l}</sh>`;
    expect(lineHtml('sh', 'srun lmp', esc, shell)).toBe('<sh>srun lmp</sh>');
    expect(lineHtml('md', '# README', esc, shell)).toBe('<span class="tok-d"># README</span>');
    expect(lineHtml('plumed', '# plumed', esc, shell)).toBe('<span class="tok-c"># plumed</span>');
  });
});

describe('a stage is checked with the files it includes', () => {
  const files = [
    { name: 'in.nvt', kind: 'lammps', text: 'units real\ninclude in.settings\nrun 100\n' },
    { name: 'in.settings', kind: 'lammps', text: 'pair_style lj/cut 10\nbogus 1\n' },
    { name: 'README.md', kind: 'md', text: '# hi\n' }
  ];

  test('the included lines are read in place, and each line says where it came from', () => {
    const ex = expandIncludes('in.nvt', new Map(files.map(f => [f.name, f])));
    expect(ex.lines).toEqual(['units real', '# include in.settings', 'pair_style lj/cut 10', 'bogus 1', 'run 100']);
    expect(ex.map[3]).toEqual({ file: 'in.settings', line: 2 });
    expect(ex.map[1]).toEqual({ file: 'in.nvt', line: 2, include: 'in.settings' });
    expect(ex.includes).toEqual(['in.settings']);
  });

  test('a file that includes itself is read once', () => {
    const loop = [{ name: 'a', kind: 'lammps', text: 'include a\nrun 1\n' }];
    expect(expandIncludes('a', new Map(loop.map(f => [f.name, f]))).lines).toEqual(['include a', 'run 1']);
  });

  // A stand-in for the checker: an unknown command is an error on its line.
  const api = {
    checkInput: (t) => ({
      issues: t.split('\n').map((l, i) => (/^bogus/.test(l) ? { line: i + 1, severity: 'error', id: 'unknown', message: 'Unknown command: bogus' } : null)).filter(Boolean),
      state: {}
    }),
    explainInput: (t) => t.replace(/\n$/, '').split('\n').map((l, i) => ({
      line: i + 1, lastLine: i + 1, kind: l.startsWith('#') ? 'comment' : 'command', text: l, command: l.split(' ')[0],
      title: l.split(' ')[0], meaning: `does ${l}`, status: 'ok', issues: []
    }))
  };

  test('a problem in a shared file is reported on that file, at its own line', () => {
    const r = explainFiles(api, files);
    expect(r.issues.get('in.settings')).toEqual([expect.objectContaining({ line: 2, file: 'in.settings', via: 'in.nvt', severity: 'error' })]);
    expect(r.issues.get('in.nvt')).toEqual([]);
    expect(statusOfFile(files[1], r)).toMatchObject({ level: 'error', badge: 'LAMMPS stops' });
    expect(statusOfFile(files[0], r)).toMatchObject({ level: 'ok' });
    expect(statusOfFile(files[2], r)).toBeNull();
  });

  test('each file\'s rows are numbered by its own lines; the include line is explained as include', () => {
    const r = explainFiles(api, files);
    const own = r.rows.get('in.nvt');
    expect(own.map(x => x.line)).toEqual([1, 2, 3]);
    expect(own[1]).toMatchObject({ command: 'include', title: 'include', url: 'https://docs.lammps.org/include.html' });
    const shared = r.rows.get('in.settings');
    expect(shared.map(x => [x.line, x.command])).toEqual([[1, 'pair_style'], [2, 'bogus']]);
    expect(shared[1].issues.map(i => i.message)).toEqual(['Unknown command: bogus']);
  });
});

describe('the run files as the page checks them, with the real modules', () => {
  const vars = (wf) => Object.assign({}, ...Object.values(wf.vars || {}).map(v => (v && v.first) || {}));
  const pageChecks = (I, wf) => explainFiles(I, wf.files, { vars: vars(wf), order: wf.stages.map(s => s.file), restart: { units: wf.units, atomStyle: wf.atomStyle } });

  test('the CHARMM peptide of the LAMMPS examples: every file explained, nothing LAMMPS would stop on', async () => {
    const data = path.join(ROOT, 'lammps/examples/peptide/data.peptide');
    const I = await import('../src/core/lammps-input.js');
    const W = await import('../src/core/lammps-workflow.js');
    const D = await import('../src/core/lammps-data.js');
    const summary = fs.existsSync(data) ? D.summariseData(D.parseDataFile(fs.readFileSync(data, 'utf8')), { units: 'real' }) : null;
    const wf = W.buildLammpsWorkflow(W.defaultLammpsState('charmm-switch'), { data: summary });
    const r = pageChecks(I, wf);
    const lammps = wf.files.filter(f => f.kind === 'lammps');
    for (const f of lammps) {
      const rows = r.rows.get(f.name);
      expect(rows.length).toBeGreaterThan(0);
      // Every row is numbered by the file's own lines.
      const n = f.text.replace(/\n$/, '').split('\n').length;
      for (const row of rows) expect(row.lastLine || row.line).toBeLessThanOrEqual(n);
      expect(statusOfFile(f, r).level).not.toBe('error');
    }
    const serious = [...r.issues.values()].flat().filter(i => i.severity === 'error');
    expect(serious).toEqual([]);
  });

  test('every force-field preset gives files the page shows without an error', async () => {
    const I = await import('../src/core/lammps-input.js');
    const W = await import('../src/core/lammps-workflow.js');
    for (const ff of W.LMP_FORCE_FIELDS.filter(f => f.id !== 'custom')) {
      const wf = W.buildLammpsWorkflow(W.defaultLammpsState(ff.id), {});
      const r = pageChecks(I, wf);
      const errors = [...r.issues.values()].flat().filter(i => i.severity === 'error').map(i => `${ff.id} ${i.file}:${i.line} ${i.message}`);
      expect(errors).toEqual([]);
    }
  });
});

describe('the packages of a build, from lmp -h', () => {
  const HELP = [
    'Large-scale Atomic/Molecular Massively Parallel Simulator - 29 Aug 2024 - Update 2',
    '',
    'Installed packages:',
    '',
    'EXTRA-FIX KSPACE MANYBODY MOLECULE OPENMP',
    'RIGID',
    '',
    'List of individual style options included in this LAMMPS executable',
    '',
    '* Atom styles:',
    '',
    'angle           atomic          body            bond            charge',
    'full',
    '',
    '* Integrate styles:',
    '',
    'verlet',
    ''
  ].join('\n');

  test('the package list and the version', () => {
    const p = packagesFromHelp(HELP);
    expect(p.packages).toEqual(['EXTRA-FIX', 'KSPACE', 'MANYBODY', 'MOLECULE', 'OPENMP', 'RIGID']);
    expect(p.version).toBe('29 Aug 2024 - Update 2');
    expect(p.styles['atom']).toEqual(['angle', 'atomic', 'body', 'bond', 'charge', 'full']);
  });

  test('text without the list gives null', () => {
    expect(packagesFromHelp('LAMMPS (29 Aug 2024)')).toBeNull();
  });
});

describe('the page: the LAMMPS tab uses the GROMACS tab\'s parts', () => {
  test('four steps and three views, each tab naming the panel it controls', () => {
    const steps = [...LAMMPS_STEPS.matchAll(/data-lx-step="(\w+)" aria-controls="(\w+)"/g)].map(m => [m[1], m[2]]);
    expect(steps.map(s => s[0])).toEqual(['system', 'stages', 'groups', 'job']);
    for (const [, target] of steps) expect(LAMMPS_PANEL).toContain(`id="${target}"`);
    const views = [...LAMMPS_VIEWS.matchAll(/data-lx-view="(\w+)" aria-selected="\w+" aria-controls="(\w+)"/g)].map(m => [m[1], m[2]]);
    expect(views.map(v => v[0])).toEqual(['files', 'commands', 'check']);
    for (const [, target] of views) expect(LAMMPS_VIEWS).toContain(`id="${target}"`);
    expect(LAMMPS_STEPS).toContain('class="stk-tabs gx-steps"');
    expect(LAMMPS_VIEWS).toContain('class="stk-panel sg-out gx-files lx-files"');
  });

  test('a card for each stage the workflow builds', () => {
    expect([...LAMMPS_PANEL.matchAll(/data-lx-stage="(\w+)"/g)].map(m => m[1])).toEqual(STAGE_KEYS);
    for (const k of STAGE_KEYS) {
      expect(LAMMPS_PANEL).toContain(`id="lx_${k}_on"`);
      expect(LAMMPS_PANEL).toContain(`id="lx_${k}_restrain"`);
      expect(LAMMPS_PANEL).toContain(`data-lx-file="${k}"`);
    }
  });

  test('the fields of the old LAMMPS form keep their ids, so saved settings still restore', () => {
    for (const id of ['lmpInput', 'lmpLog', 'lmpAccel', 'lmpGpuCard']) expect(LAMMPS_PANEL).toContain(`id="${id}"`);
    expect(PAGE).toContain('id="lmpCpus"');
    expect(PAGE).toContain('id="jobTasks"');
    for (const v of ['none', 'gpu', 'kokkos', 'intel', 'omp', 'opt']) expect(LAMMPS_PANEL).toContain(`<option value="${v}"`);
  });

  test('no id is used twice, and every label names a field that exists', () => {
    const all = ids(PAGE);
    const dup = all.filter((x, i) => all.indexOf(x) !== i);
    expect(dup).toEqual([]);
    for (const html of [LAMMPS_PANEL, LAMMPS_VIEWS]) {
      for (const m of html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)) expect(all).toContain(m[1]);
      for (const m of html.matchAll(/aria-(?:labelledby|controls|describedby)="([^"]+)"/g)) {
        for (const id of m[1].split(/\s+/)) expect(all).toContain(id);
      }
    }
  });

  test('the LAMMPS markup never uses the GROMACS tab\'s hooks, which select page-wide', () => {
    for (const html of [LAMMPS_PANEL, LAMMPS_VIEWS, LAMMPS_STEPS]) expect(html).not.toMatch(/data-gx-/);
  });

  test('fields that only drive the page are not saved', () => {
    for (const id of ['lxDataFile', 'lxChkText', 'lxChkHelp', 'lxRefFind', 'lxRefKind', 'lxRefOnly', 'lxGroupName', 'lxGroupValues']) {
      expect(PAGE).toMatch(new RegExp(`id="${id}"[^>]*data-nosave`));
    }
  });

  test('the stylesheet is linked, and the tab\'s script is loaded by the page\'s', () => {
    expect(PAGE).toContain('<link rel="stylesheet" href="src/tools/lammps.css">');
    const main = fs.readFileSync(path.join(ROOT, 'js/script-generator.js'), 'utf8');
    expect(main).toMatch(/import \{ createLammpsTab \} from '\.\/script-generator-lammps\.js'/);
    // The core modules load when the tab is first shown, not with the page.
    const tab = fs.readFileSync(path.join(ROOT, 'js/script-generator-lammps.js'), 'utf8');
    expect(tab).not.toMatch(/^import .*src\/core\/lammps-(input|workflow|data)\.js/m);
    expect(tab).toMatch(/import\('\.\.\/src\/core\/lammps-workflow\.js'\)/);
  });
});
