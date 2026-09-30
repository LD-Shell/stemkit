import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MDP_RELEASE, MDP_MANUAL, normaliseName, canonicalName, mdpDocUrl, optionInfo, sectionsInOrder, listOptions,
  obsoleteOptions, searchOptions, loadMdpDocs, parseMdp, mdpValue, checkMdp, explainMdp,
  psToSteps, nsToSteps, stepsToPs, formatDuration,
  FORCE_FIELDS, THERMOSTATS, BAROSTATS, STAGES, SYSTEM_TYPES, defaultSettings, generateMdp, generateWorkflow
} from '../src/core/gromacs-mdp.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'gromacs');

/* Every id on the live manual page, fetched once (see the file's header). */
const ANCHORS = fs.readFileSync(path.join(FIXTURES, 'manual-anchors-2025.1.txt'), 'utf8')
  .split('\n').filter(l => l && !l.startsWith('#'));

/*
 * grompp's verdicts on the broken files. Recorded by running real grompp
 * (GROMACS 2025.0, mixed precision, -maxwarn 0) on a solvated AMBER99SB-ILDN
 * peptide with position restraints available:
 *     GMX_BIN=/path/to/gmx node tools/check-gromacs-grompp.mjs --record
 */
const BROKEN = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'broken-mdp.json'), 'utf8')).cases;

const anchorOf = (url) => url.slice(url.indexOf('#') + 1);

describe('the option table', () => {
  test('describes GROMACS 2025.1 and links into its manual', () => {
    expect(MDP_RELEASE).toBe('2025.1');
    expect(MDP_MANUAL).toBe('https://manual.gromacs.org/2025.1/user-guide/mdp-options.html');
  });

  test('has every option on the manual page, and the undocumented ones grompp reads', () => {
    const documented = listOptions({ undocumented: false });
    // 310 `.. mdp::` directives in mdp-options.rst (QMMM is written `.. MDP::`).
    expect(documented).toHaveLength(310);
    const pageOptions = ANCHORS.filter(a => !a.startsWith('mdp-value-') && !['mdp-general', 'mdp-colvars'].includes(a));
    expect(new Set(documented.map(n => anchorOf(mdpDocUrl(n))))).toEqual(new Set(pageOptions));
    const all = listOptions();
    expect(all.length).toBe(325);
    for (const n of ['Shake-SOR', 'IMD-group', 'weight-equil-wl-delta', 'weight-c-range', 'nnpot-active', 'nnpot-model-input4']) {
      expect(all).toContain(n);
      expect(optionInfo(n).documented).toBe(false);
    }
  });

  test('every value anchor it links to is on the live page', () => {
    const page = new Set(ANCHORS);
    let checked = 0;
    for (const n of listOptions({ undocumented: false })) {
      const info = optionInfo(n);
      expect(page.has(anchorOf(info.url))).toBe(true);
      for (const v of [...info.values, ...info.cases]) {
        if (!v.url.includes('#mdp-value-')) continue;
        expect(page.has(anchorOf(v.url))).toBe(true);
        checked += 1;
      }
    }
    // 213 value entries on the page; X, Y and Z of swapcoords share one.
    expect(checked).toBe(215);
  });

  test('forms URLs the way Sphinx names the anchors', () => {
    expect(mdpDocUrl('tau_t')).toBe(`${MDP_MANUAL}#mdp-tau-t`);
    expect(mdpDocUrl('TCOUPL', 'v_rescale')).toBe(`${MDP_MANUAL}#mdp-value-tcoupl-v-rescale`);
    expect(mdpDocUrl('pcoupl', 'C-rescale')).toBe(`${MDP_MANUAL}#mdp-value-pcoupl-C-rescale`);
    expect(mdpDocUrl('DispCorr', 'EnerPres')).toBe(`${MDP_MANUAL}#mdp-value-DispCorr-EnerPres`);
    // Colliding ids get Sphinx's serial numbers: >0, 0 and <0 all make nstlist-0.
    expect(mdpDocUrl('nstlist', '0')).toBe(`${MDP_MANUAL}#mdp-value-0`);
    expect(mdpDocUrl('nstlist', '<0')).toBe(`${MDP_MANUAL}#mdp-value-1`);
    expect(mdpDocUrl('userint1')).toBe(`${MDP_MANUAL}#mdp-userint1-0`);
    expect(mdpDocUrl('swapcoords', 'Z')).toBe(`${MDP_MANUAL}#mdp-value-swapcoords-X-Y-Z`);
    // Family members link to the documented first member.
    expect(mdpDocUrl('pull_coord3_k')).toBe(`${MDP_MANUAL}#mdp-pull-coord1-k`);
    expect(mdpDocUrl('awh2-dim3-start')).toBe(`${MDP_MANUAL}#mdp-awh1-dim1-start`);
    expect(mdpDocUrl('rot-type2')).toBe(`${MDP_MANUAL}#mdp-rot-type0`);
    // grompp reads lmc-move; the manual documents it as lmc-mc-move.
    expect(mdpDocUrl('lmc-move')).toBe(`${MDP_MANUAL}#mdp-lmc-mc-move`);
    expect(mdpDocUrl('nstxtcout')).toBe(`${MDP_MANUAL}#mdp-nstxout-compressed`);
    expect(mdpDocUrl('Shake-SOR')).toBe(`${MDP_MANUAL}#bonds`);
    expect(mdpDocUrl('nnpot-active')).toBe('https://manual.gromacs.org/2025.1/reference-manual/special/nnpot.html#usage');
    expect(mdpDocUrl('no-such-option')).toBe('');
  });

  test('names compare as grompp compares them', () => {
    expect(normaliseName('tau_t')).toBe('TAUT');
    expect(canonicalName('Tau_T')).toBe('tau-t');
    expect(canonicalName('vdw-type')).toBe('vdwtype');
    expect(canonicalName('dh_hist_size')).toBe('dh-hist-size');
    expect(canonicalName('pull_coord12_k')).toBe('pull-coord12-k');
    expect(canonicalName('pull-coord01-k')).toBeNull(); // grompp compares the whole name
    expect(canonicalName('awh1_dim2_end')).toBe('awh1-dim2-end');
    expect(canonicalName('iontype3-in-B')).toBe('iontype3-in-B');
    expect(canonicalName('lmc-mc-move')).toBeNull();
  });

  test('defaults are those of readir.cpp, with the manual\'s where it differs', () => {
    const d = (n) => optionInfo(n).default;
    expect(d('integrator')).toBe('md');
    expect(d('dt')).toBe('0.001');
    expect(d('nsteps')).toBe('0');
    expect(d('nstlist')).toBe('10');
    expect(d('nstcalcenergy')).toBe('100');
    expect(d('nstenergy')).toBe('1000');
    expect(d('nstlog')).toBe('1000');
    expect(d('tau-p')).toBe('5');
    expect(d('verlet-buffer-tolerance')).toBe('0.005');
    expect(d('ewald-rtol')).toBe('1e-05');
    expect(d('fourierspacing')).toBe('0.12');
    expect(d('tcoupl')).toBe('no');
    expect(d('constraint-algorithm')).toBe('LINCS');
    expect(d('ensemble-temperature-setting')).toBe('auto');
    expect(d('pull-coord1-dim')).toBe('Y Y Y');
    expect(d('density-guided-simulation-active')).toBe('false');
    expect(optionInfo('coulomb-modifier')).toMatchObject({ default: 'Potential-shift', gromppDefault: 'Potential-shift-Verlet' });
    expect(optionInfo('pull-coord2-kB').defaultFrom).toBe('pull-coord2-k');
    // Where the manual prints another default than grompp uses:
    expect(optionInfo('simulation-part')).toMatchObject({ default: '1', docDefault: '0' });
    expect(optionInfo('nstdhdl')).toMatchObject({ default: '50', docDefault: '100' });
    expect(optionInfo('awh1-ndim')).toMatchObject({ default: '0', docDefault: '1' });
  });

  test('enums list their documented values and every spelling grompp accepts', () => {
    const t = optionInfo('tcoupl');
    expect(t.kind).toBe('enum');
    expect(t.values.map(v => v.value)).toEqual(['no', 'berendsen', 'nose-hoover', 'andersen', 'andersen-massive', 'v-rescale']);
    expect(t.accepted).toContain('yes'); // the old alias of berendsen
    expect(t.values.find(v => v.value === 'berendsen').status).toBe('deprecated');
    expect(optionInfo('cutoff-scheme').values.find(v => v.value === 'group').status).toBe('removed');
    const e = optionInfo('ensemble-temperature-setting');
    expect(e.values.find(v => v.value === 'not-available').status).toBe('rejected');
    expect(e.accepted).toContain('not available');
    expect(optionInfo('lmc-move')).toMatchObject({ docName: 'lmc-mc-move', readWhen: { option: 'free-energy' } });
    expect(optionInfo('lmc-stats').accepted).toContain('minvar');
    expect(optionInfo('DispCorr').accepted).toEqual(expect.arrayContaining(['no', 'EnerPres', 'Ener', 'AllEnerPres', 'AllEner']));
  });

  test('records kinds, units, list shapes, gates and families', () => {
    expect(optionInfo('tau-t')).toMatchObject({ kind: 'reals', per: 'tc-grps', unit: 'ps' });
    expect(optionInfo('ref-p')).toMatchObject({ kind: 'reals', per: 'pcoupltype', unit: 'bar' });
    expect(optionInfo('accelerate')).toMatchObject({ per: 'acc-grps', times: 3 });
    expect(optionInfo('emtol').unit).toBe('kJ mol⁻¹ nm⁻¹');
    expect(optionInfo('mass-repartition-factor').kind).toBe('real');
    expect(optionInfo('nsteps').kind).toBe('integer');
    expect(optionInfo('mts-levels').readWhen).toMatchObject({ option: 'mts' });
    expect(optionInfo('pull-coord2-rate')).toMatchObject({
      name: 'pull-coord2-rate', readWhen: { option: 'pull' },
      family: { template: 'pull-coord{N}-rate', count: 'pull-ncoords', first: 1, index: [2] }
    });
    expect(optionInfo('rot-k3').family).toMatchObject({ first: 0, index: [3] });
    expect(optionInfo('adress').status.status).toBe('removed');
  });

  test('every option has a plain-English summary', () => {
    for (const n of listOptions()) {
      const s = optionInfo(n).summary;
      expect(s.length).toBeGreaterThan(15);
      expect(s).toMatch(/[.?]$/);
    }
  });

  test('knows the obsolete names grompp renames or ignores', () => {
    const all = obsoleteOptions();
    expect(all.find(o => o.name === 'nstxtcout').replacement).toBe('nstxout-compressed');
    expect(all.find(o => o.name === 'title').replacement).toBeNull();
    expect(optionInfo('unconstrained_start')).toMatchObject({ obsolete: true, replacement: 'continuation' });
    expect(optionInfo('gb-algorithm')).toMatchObject({ obsolete: true, replacement: null });
  });

  test('lists sections in manual order and searches options', () => {
    const s = sectionsInOrder();
    expect(s[0]).toMatchObject({ id: 'preprocessing', title: 'Preprocessing' });
    expect(s[0].options).toEqual(['include', 'define']);
    expect(s.map(x => x.id)).toContain('neural-network-potentials');
    expect(s.findIndex(x => x.id === 'temperature-coupling')).toBeLessThan(s.findIndex(x => x.id === 'pressure-coupling'));
    expect(sectionsInOrder({ undocumented: false }).some(x => x.id === 'neural-network-potentials')).toBe(false);
    expect(searchOptions('tcoupl')[0].name).toBe('tcoupl');
    expect(searchOptions('barostat').map(r => r.name)).toContain('pcoupl');
  });

  test('loads the full documentation with links resolved', async () => {
    const docs = await loadMdpDocs();
    const html = docs.option('tau_t');
    expect(html).toContain(`href="${MDP_MANUAL}#mdp-tc-grps"`);
    expect(html).toContain('data-mdp="tc-grps"');
    expect(docs.value('tcoupl', 'V-rescale')).toMatch(/canonical ensemble/);
    expect(docs.value('swapcoords', 'Z')).toMatch(/Z direction/);
    expect(docs.value('sc-function', 'gapsys')).toMatch(/Gapsys/);
    expect(docs.option('fourier-ny')).toMatch(/Grid size when using PME/); // shared with fourier-nz
    expect(docs.section('simulated-annealing')).toMatch(/Confused\? OK/);
    expect(docs.option('nnpot-active')).toBe('');
  });

  test('the generated tables are up to date with the GROMACS source, when it is here', () => {
    if (!fs.existsSync(path.join(ROOT, 'gromacs-2025.1', 'docs', 'user-guide', 'mdp-options.rst'))) return;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-gromacs-mdp.mjs'), '--check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('parseMdp', () => {
  test('reads name = value, comments and line numbers', () => {
    const p = parseMdp('; header\n\nintegrator = md   ; leap-frog\n  dt=0.002\n');
    expect(p.errors).toEqual([]);
    expect(p.entries).toEqual([
      { line: 3, key: 'integrator', value: 'md', comment: 'leap-frog', name: 'integrator', empty: false },
      { line: 4, key: 'dt', value: '0.002', comment: '', name: 'dt', empty: false }
    ]);
    expect(p.lines.map(l => l.kind)).toEqual(['comment', 'blank', 'entry', 'entry']);
    expect(p.values).toEqual({ integrator: 'md', dt: '0.002' });
  });

  test('keeps everything after the first = as the value', () => {
    const p = parseMdp('define = -DPOSRES -DFC=1000\n');
    expect(p.entries[0].value).toBe('-DPOSRES -DFC=1000');
  });

  test('treats dashes, underscores and case as the same name', () => {
    const p = parseMdp('tau_t = 0.1\nTAU-T = 0.2\n');
    expect(p.errors).toEqual([{ line: 2, id: 'duplicate', message: expect.stringContaining('also on line 1') }]);
    expect(mdpValue(p, 'Tau-T')).toBe('0.1');
  });

  test('ignores a line with an empty value, which is not a duplicate', () => {
    const p = parseMdp('tcoupl = ; v-rescale\ntcoupl = v-rescale\n');
    expect(p.errors).toEqual([]);
    expect(p.entries[0]).toMatchObject({ empty: true, comment: 'v-rescale' });
    expect(mdpValue(p, 'tcoupl')).toBe('v-rescale');
  });

  test('reports lines grompp cannot read', () => {
    const p = parseMdp('nsteps 100\n= 5\n#include "x.itp"\n');
    expect(p.errors.map(e => [e.line, e.id])).toEqual([[1, 'no-equals'], [2, 'no-name'], [3, 'no-equals']]);
    expect(p.errors[2].message).toMatch(/not preprocessed/);
  });

  test('handles CRLF line ends and marks unknown names', () => {
    const p = parseMdp('dt = 0.002\r\nfoo = 1\r\n');
    expect(p.entries.map(e => [e.line, e.name])).toEqual([[1, 'dt'], [2, null]]);
  });
});

describe('checkMdp agrees with grompp', () => {
  test.each(BROKEN.map(c => [c.name, c]))('%s', (name, c) => {
    const r = checkMdp(c.mdp, c.context ? { context: c.context } : {});
    expect(r.grompp.passes).toBe(c.grompp.passes);
    // Where grompp did not stop on a fatal error, the counts match too;
    // couple-same draws messages that need the coordinates and topology.
    if (!c.grompp.fatal && name !== 'couple-same') {
      expect([r.grompp.errors, r.grompp.warnings, r.grompp.notes]).toEqual([c.grompp.errors, c.grompp.warnings, c.grompp.notes]);
    }
  });

  test('the set covers passing and failing files', () => {
    expect(BROKEN.length).toBe(102);
    expect(BROKEN.filter(c => c.grompp.passes).length).toBeGreaterThan(20);
    expect(BROKEN.filter(c => !c.grompp.passes).length).toBeGreaterThan(60);
  });
});

describe('checkMdp messages', () => {
  const ids = (text, options) => checkMdp(text, options).issues.map(i => `${i.severity}:${i.id}`);
  const base = 'integrator = md\ndt = 0.002\nconstraints = h-bonds\ntcoupl = v-rescale\ntc-grps = System\ntau-t = 0.1\nref-t = 300\n';

  test('says why, where and links the manual', () => {
    const r = checkMdp(`${base}tau-p = 1\npcoupl = Berendsen\ncompressibility = 4.5e-5\nref-p = 1\n`);
    const w = r.issues.find(i => i.id === 'berendsen-barostat');
    expect(w).toMatchObject({ severity: 'warning', option: 'pcoupl', line: 9, source: 'grompp', url: `${MDP_MANUAL}#mdp-pcoupl` });
    expect(w.message).toMatch(/C-rescale/);
    expect(r.grompp).toMatchObject({ passes: false, warnings: 1 });
    expect(checkMdp(`${base}pcoupl = Berendsen\ncompressibility = 4.5e-5\nref-p = 1\n`, { maxwarn: 1 }).grompp.passes).toBe(true);
  });

  test('suggests the name meant', () => {
    expect(checkMdp('nstxout_compresed = 100').issues[0].message).toMatch(/Did you mean nstxout-compressed\?/);
    expect(checkMdp('lmc-mc-move = no').issues[0].message).toMatch(/reads lmc-move/);
    expect(checkMdp('tcoupl = v-rescal').issues[0].message).toMatch(/Did you mean v-rescale\?/);
  });

  test('explains the manual\'s spellings grompp refuses', () => {
    const r = checkMdp('ensemble-temperature-setting = not-available');
    expect(r.issues[0]).toMatchObject({ severity: 'error', id: 'bad-enum' });
    expect(r.issues[0].message).toMatch(/not available/);
  });

  test('counts entries that must match', () => {
    expect(ids(`${base.replace('tau-t = 0.1', 'tau-t = 0.1 0.1')}`)).toContain('error:tc-count');
    expect(ids(`${base}pcoupl = C-rescale\npcoupltype = semiisotropic\ncompressibility = 4.5e-5\nref-p = 1 1\n`))
      .toContain('error:pcoupl-count');
    expect(ids(`${base}annealing = single\nannealing-npoints = 2\nannealing-time = 0\nannealing-temp = 300 310\n`))
      .toContain('error:annealing-time-count');
    expect(ids(`${base}free-energy = yes\ninit-lambda-state = 0\ncoul-lambdas = 0 1\nvdw-lambdas = 0 0.5 1\n`))
      .toContain('error:lambda-count');
  });

  test('follows grompp\'s cross-option checks', () => {
    expect(ids(`${base}gen-vel = yes\ncontinuation = yes\n`)).toContain('error:genvel-continuation');
    expect(ids(`${base}pcoupl = Parrinello-Rahman\ntau-p = 5\ncompressibility = 4.5e-5\nref-p = 1\ngen-vel = yes\n`)).toContain('warning:pr-genvel');
    expect(ids(`${base}define = -DPOSRES\npcoupl = C-rescale\ncompressibility = 4.5e-5\nref-p = 1\n`)).toContain('warning:posres-refcoord');
    expect(ids(`${base}pcoupl = C-rescale\ntau-p = 0.5\nnstpcouple = 100\ncompressibility = 4.5e-5\nref-p = 1\n`)).toContain('warning:tau-p-short');
    expect(ids(`${base}nstenergy = 150\n`)).toContain('warning:nstenergy-multiple');
    expect(ids(`${base}rvdw = 1.2\n`)).toContain('error:rc-mismatch');
    expect(ids(`${base}vdw-modifier = Force-switch\nrvdw-switch = 1.0\n`)).toContain('error:rvdw-switch-range');
    expect(ids(`${base}verlet-buffer-tolerance = 0\n`)).toContain('error:vbt-zero');
    expect(ids(`${base}mass-repartition-factor = 0.5\n`)).toContain('error:mass-repartition');
    expect(ids(`${base}dt = 0.004\n`.replace('dt = 0.002\n', ''))).toContain('warning:dt-without-hmr');
    expect(ids(base.replace('tcoupl = v-rescale', 'tcoupl = no').replace(/tc-grps.*\n|tau-t.*\n|ref-t.*\n/g, '') +
      'pcoupl = C-rescale\ncompressibility = 4.5e-5\nref-p = 1\n')).toContain('error:crescale-temperature');
    expect(ids('integrator = steep\nnsteps = 0\n')).toEqual(expect.arrayContaining(['note:nsteps-zero', 'note:em-zero-steps']));
  });

  test('reports gated options as grompp does', () => {
    expect(ids('pull-ncoords = 1').filter(x => !x.startsWith('note:'))).toEqual(['warning:inactive']);
    const pull = 'pull = yes\npull-ngroups = 2\npull-ncoords = 1\npull-group1-name = A\npull-group2-name = B\npull-coord1-groups = 1 2\n';
    expect(ids(`${pull}pull-coord2-k = 5\n`)).toContain('warning:inactive');
    expect(checkMdp(`${pull}pull-coord2-k = 5\n`).issues.find(i => i.id === 'inactive').message).toMatch(/pull-ncoords = 1/);
  });

  test('uses the context for checks that need the topology', () => {
    const npt = `${base}pcoupl = Parrinello-Rahman\ntau-p = 5\ncompressibility = 4.5e-5\nref-p = 1\nrefcoord-scaling = com\n`;
    expect(ids(npt)).not.toContain('note:posres-pr');
    expect(ids(npt, { context: { posres: true } })).toContain('note:posres-pr');
    const issue = checkMdp(`${npt}define = -DPOSRES\n`).issues.find(i => i.id === 'posres-pr');
    expect(issue.assumes).toMatch(/-DPOSRES/);
    expect(ids(base, { context: { forceField: 'gromos54a7' } })).toContain('warning:gromos-twin-range');
    expect(ids(`${base.replace('h-bonds', 'all-bonds')}`, { context: { forceField: 'amber' } })).toContain('note:all-bonds-ff');
    expect(ids(base, { context: { indexGroups: ['Protein', 'SOL'] } })).toContain('error:group-unknown');
    // grompp warns about -D macros the topology never uses.
    expect(ids(`${base}define = -DPOSRES\n`, { context: { posres: false } })).toContain('warning:define-unused');
    expect(ids(`${base}define = -DPOSRES -DFLEXIBLE\n`, { context: { usedMacros: ['POSRES'] } })).toContain('warning:define-unused');
    expect(ids(`${base}define = -DPOSRES\n`)).not.toContain('warning:define-unused');
  });

  test('returns the settings as grompp resolves them', () => {
    const r = checkMdp(`${base}nstenergy = 50\n`);
    expect(r.settings).toMatchObject({ dt: 0.002, nstcalcenergy: 50, 'tc-grps': 'System', 'coulomb-modifier': 'Potential-shift' });
    // ir_optimal_nsttcouple: v-rescale wants 5 steps per tau-t = 0.1 ps.
    expect(r.settings.nsttcouple).toBe(10);
  });
});

describe('explainMdp', () => {
  const text = [
    '; NPT', 'define = -DPOSRES', 'integrator = md', 'dt = 0.002', 'nsteps = 50000', 'nstxout-compressed = 5000',
    'tcoupl = V-rescale', 'tc_grps = Protein Non-Protein', 'tau_t = 0.1 0.1', 'ref_t = 300 300', 'nstlist = 10',
    'title = old', 'pull-ncoords = 1', 'tcouple = no', 'nstxtcout ='
  ].join('\n');
  const rows = explainMdp(text);
  const row = (n) => rows[n - 1];

  test('gives one row per line with the option\'s summary and link', () => {
    expect(rows).toHaveLength(15);
    expect(row(1)).toMatchObject({ kind: 'comment' });
    expect(row(3)).toMatchObject({ name: 'integrator', url: `${MDP_MANUAL}#mdp-integrator`, valueUrl: `${MDP_MANUAL}#mdp-value-integrator-md`, isDefault: true });
    expect(row(3).summary).toBe(optionInfo('integrator').summary);
  });

  test('says what each setting does in this file', () => {
    expect(row(2).meaning).toMatch(/position restraints/);
    expect(row(4).meaning).toBe('2 fs per step.');
    expect(row(5).meaning).toBe('50,000 steps of 0.002 ps = 100 ps.');
    expect(row(6).meaning).toBe('Every 5,000 steps = 10 ps.');
    expect(row(7).meaning).toMatch(/^V-rescale: Stochastic velocity rescaling/);
    expect(row(9).meaning).toBe('Protein: 300 K, tau-t 0.1 ps; Non-Protein: 300 K, tau-t 0.1 ps.');
    expect(row(11).meaning).toMatch(/\(This is the default\.\)$/);
  });

  test('marks what grompp ignores, does not read or does not know', () => {
    expect(row(12)).toMatchObject({ status: 'obsolete', name: 'title' });
    expect(row(13)).toMatchObject({ status: 'inactive', name: 'pull-ncoords' });
    expect(row(13).meaning).toMatch(/pull = yes/);
    expect(row(14)).toMatchObject({ status: 'unknown' });
    expect(row(14).meaning).toMatch(/Did you mean tcoupl\?/);
    expect(row(14).issues[0].id).toBe('unknown');
    expect(row(15)).toMatchObject({ status: 'ignored' });
  });
});

describe('units', () => {
  test('converts between time and steps', () => {
    expect(psToSteps(10, 0.002)).toBe(5000);
    expect(psToSteps(0, 0.002)).toBe(0);
    expect(psToSteps(0.0001, 0.002)).toBe(1);
    expect(nsToSteps(100, 0.002)).toBe(50000000);
    expect(nsToSteps(1, 0.004)).toBe(250000);
    expect(stepsToPs(5000, 0.002)).toBe(10);
    expect(psToSteps(1, 0)).toBe(0);
  });

  test('writes times in a readable unit', () => {
    expect(formatDuration(0.002)).toBe('2 fs');
    expect(formatDuration(10)).toBe('10 ps');
    expect(formatDuration(1500)).toBe('1.5 ns');
    expect(formatDuration(2e6)).toBe('2 µs');
  });
});

describe('generateMdp', () => {
  const contextFor = (ff, posres) => ({ posres, forceField: ff, system: FORCE_FIELDS[ff].resolution === 'coarse-grained' ? 'coarse-grained' : 'all-atom' });

  const combos = [];
  for (const ff of Object.keys(FORCE_FIELDS)) {
    for (const stage of Object.keys(STAGES)) {
      const baros = ['npt', 'prod', 'pull'].includes(stage) ? ['c-rescale', 'parrinello-rahman'] : [undefined];
      const hmrs = STAGES[stage].dynamics && FORCE_FIELDS[ff].hmr ? [false, true] : [false];
      for (const barostat of baros) for (const hmr of hmrs) combos.push([ff, stage, barostat, hmr]);
    }
  }

  test.each(combos)('%s %s %s HMR=%s is a file grompp accepts', (ff, stage, barostat, hmr) => {
    const g = generateMdp({ forceField: ff, stage, barostat, hmr });
    const parsed = parseMdp(g.text);
    expect(parsed.errors).toEqual([]);
    for (const e of parsed.entries) {
      expect(e.name).not.toBeNull();
      expect(e.comment.length).toBeGreaterThan(5); // every setting says why
      expect(e.value).not.toBe('');
    }
    const r = checkMdp(g.text, { context: contextFor(ff, g.settings.posres) });
    const counted = r.issues.filter(i => i.source === 'grompp');
    expect(counted.filter(i => i.severity === 'error')).toEqual([]);
    // Only GROMOS draws a warning, from its topology.
    expect(counted.filter(i => i.severity === 'warning').map(i => i.id)).toEqual(ff === 'gromos54a7' ? ['gromos-twin-range'] : []);
    expect(g.expected.map(e => e.id).sort()).toEqual(counted.map(i => i.id).sort());
    // The only notes are the documented, expected ones.
    for (const n of counted.filter(i => i.severity === 'note')) expect(['posres-comm', 'bond-period', 'posres-pr']).toContain(n.id);
    expect(g.text).toMatch(/^; /);
    expect(g.fileName).toBe(`${stage}.mdp`);
    // ASCII only, so any editor and any GROMACS reads it.
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(g.text)).toBe(true);
  });

  test('converts run length and output times to steps', () => {
    const g = generateMdp({ stage: 'prod', lengthNs: 50, output: { xtcPs: 10, energyPs: 5, logPs: 100 } });
    const v = parseMdp(g.text).values;
    expect(v).toMatchObject({ dt: '0.002', nsteps: '25000000', 'nstxout-compressed': '5000', nstenergy: '2500', nstlog: '50000' });
    expect(Number(v.nstenergy) % Number(v.nstcalcenergy)).toBe(0);
    expect(v.nstcomm).toBe(v.nstcalcenergy);
    const odd = parseMdp(generateMdp({ stage: 'prod', output: { energyPs: 0.15 } }).text).values;
    expect(odd.nstenergy).toBe('75');
    expect(odd.nstcalcenergy).toBe('75');
  });

  test('applies hydrogen mass repartitioning with a 4 fs step', () => {
    const g = generateMdp({ stage: 'prod', hmr: true });
    expect(parseMdp(g.text).values).toMatchObject({ dt: '0.004', 'mass-repartition-factor': '3.0', constraints: 'h-bonds' });
    expect(g.expected.map(e => e.id)).toContain('bond-period');
    const m = generateMdp({ stage: 'prod', forceField: 'martini3', hmr: true });
    expect(parseMdp(m.text).values['mass-repartition-factor']).toBeUndefined();
    expect(m.warnings.join(' ')).toMatch(/no hydrogens/);
  });

  test('follows each force field\'s conventions', () => {
    const v = (ff) => parseMdp(generateMdp({ stage: 'prod', forceField: ff }).text).values;
    expect(v('charmm36')).toMatchObject({ 'vdw-modifier': 'Force-switch', 'rvdw-switch': '1.0', rvdw: '1.2', rcoulomb: '1.2', DispCorr: 'no', coulombtype: 'PME' });
    expect(v('amber')).toMatchObject({ rvdw: '1.0', DispCorr: 'EnerPres' });
    expect(v('gromos54a7')).toMatchObject({ rvdw: '1.4', rcoulomb: '1.4', DispCorr: 'no' });
    expect(v('opls-aa')).toMatchObject({ rvdw: '1.0', DispCorr: 'EnerPres' });
    expect(v('martini3')).toMatchObject({
      dt: '0.02', coulombtype: 'Reaction-Field', 'epsilon-r': '15', 'epsilon-rf': '0', rcoulomb: '1.1', rvdw: '1.1',
      constraints: 'none', nstlist: '20', compressibility: '3e-4'
    });
    expect(generateMdp({ stage: 'prod', forceField: 'charmm36' }).text).toContain('force-fields.html#gmx-charmm-ff');
  });

  test('sets up each stage', () => {
    const v = (stage, extra) => parseMdp(generateMdp({ stage, ...extra }).text).values;
    expect(v('em')).toMatchObject({ integrator: 'steep', emtol: '1000.0', constraints: 'none' });
    expect(v('em-cg')).toMatchObject({ integrator: 'cg', nstcgsteep: '1000' });
    expect(v('nvt')).toMatchObject({ define: '-DPOSRES', 'gen-vel': 'yes', continuation: 'no', pcoupl: 'no' });
    expect(v('npt')).toMatchObject({ define: '-DPOSRES', 'gen-vel': 'no', continuation: 'yes', pcoupl: 'C-rescale', 'refcoord-scaling': 'com' });
    expect(v('prod')).toMatchObject({ pcoupl: 'C-rescale', continuation: 'yes' });
    expect(v('prod').define).toBeUndefined();
    expect(v('prod', { barostat: 'none' }).pcoupl).toBe('no');
    expect(v('nvt', { system: 'solution' }).define).toBeUndefined(); // nothing to restrain in a liquid
    expect(v('anneal')).toMatchObject({ annealing: 'single single', 'annealing-npoints': '4 4', pcoupl: 'no' });
    expect(v('pull')).toMatchObject({ pull: 'yes', 'pull-coord1-rate': '0.0', 'pull-coord1-groups': '1 2' });
    expect(v('pull', { pull: { mode: 'steered', rateNmPerPs: 0.005 } })['pull-coord1-rate']).toBe('0.005');
  });

  test('couples membranes semi-isotropically and names their groups', () => {
    const v = parseMdp(generateMdp({ stage: 'prod', system: 'membrane' }).text).values;
    expect(v).toMatchObject({ pcoupltype: 'semiisotropic', compressibility: '4.5e-5 4.5e-5', 'ref-p': '1.0 1.0', 'tc-grps': 'SOLU MEMB SOLV' });
  });

  test('adjusts choices grompp would refuse, and says so', () => {
    const a = generateMdp({ stage: 'prod', couplingType: 'anisotropic' });
    expect(parseMdp(a.text).values).toMatchObject({ pcoupl: 'Parrinello-Rahman', compressibility: '4.5e-5 4.5e-5 4.5e-5 0.0 0.0 0.0' });
    expect(a.warnings.join(' ')).toMatch(/anisotropic/);
    const b = generateMdp({ stage: 'anneal', anneal: { barostat: 'c-rescale' } });
    expect(parseMdp(b.text).values['tc-grps']).toBe('System');
    expect(b.warnings.join(' ')).toMatch(/single temperature group/);
  });

  test('warns about deprecated methods, which grompp would warn about', () => {
    const g = generateMdp({ stage: 'prod', thermostat: 'berendsen', barostat: 'berendsen' });
    expect(g.warnings.join(' ')).toMatch(/deprecated|Berendsen/);
    expect(g.expected.filter(e => e.severity === 'warning').map(e => e.id).sort()).toEqual(['berendsen-barostat', 'berendsen-thermostat']);
    expect(checkMdp(g.text).grompp.passes).toBe(false);
  });

  test('Nose-Hoover gets chain length 1 and a longer time constant', () => {
    const v = parseMdp(generateMdp({ stage: 'prod', thermostat: 'nose-hoover', barostat: 'parrinello-rahman' }).text).values;
    expect(v).toMatchObject({ tcoupl: 'Nose-Hoover', 'nh-chain-length': '1', 'tau-t': '0.5 0.5', 'tau-p': '5.0' });
  });

  test('writes a workflow whose stages chain', () => {
    const files = generateWorkflow({ forceField: 'charmm36', temperature: 310, hmr: true });
    expect(files.map(f => f.fileName)).toEqual(['em.mdp', 'nvt.mdp', 'npt.mdp', 'prod.mdp']);
    const v = files.map(f => parseMdp(f.text).values);
    expect(v[1]).toMatchObject({ 'gen-vel': 'yes', continuation: 'no', 'gen-temp': '310.0', 'ref-t': '310.0 310.0', dt: '0.004' });
    expect(v[2]).toMatchObject({ continuation: 'yes', 'gen-vel': 'no' });
    expect(v[3]).toMatchObject({ continuation: 'yes', dt: '0.004' });
    expect(v[0]['mass-repartition-factor']).toBeUndefined(); // masses do not matter to a minimiser
    const custom = generateWorkflow({ perStage: { prod: { lengthNs: 10 } } });
    expect(parseMdp(custom[3].text).values.nsteps).toBe('5000000');
  });

  test('defaultSettings fills every choice', () => {
    const s = defaultSettings('npt', { forceField: 'martini3', system: 'membrane' });
    expect(s).toMatchObject({ stage: 'npt', forceField: 'martini3', couplingType: 'semiisotropic', barostat: 'c-rescale', posres: true });
    expect(Object.keys(THERMOSTATS)).toEqual(['v-rescale', 'nose-hoover', 'berendsen']);
    expect(Object.keys(BAROSTATS)).toEqual(['c-rescale', 'parrinello-rahman', 'berendsen']);
    expect(Object.keys(SYSTEM_TYPES)).toEqual(['protein', 'membrane', 'solution']);
  });
});

/*
 * With GROMACS installed (GMX_BIN), hand two generated files to real grompp
 * on a small water box. tools/check-gromacs-grompp.mjs does this for every
 * preset and the broken files; this only makes sure the setup still runs.
 */
const GMX = process.env.GMX_BIN || '';
const withGromacs = GMX && fs.existsSync(GMX) ? describe : describe.skip;

withGromacs('real grompp (GMX_BIN)', () => {
  test('accepts generated files for a water box', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-mdp-'));
    const run = (args, input) => spawnSync(GMX, [...args, '-quiet'], { cwd: dir, input, encoding: 'utf8' });
    try {
      fs.writeFileSync(path.join(dir, 'topol.top'), '#include "amber99sb-ildn.ff/forcefield.itp"\n#include "amber99sb-ildn.ff/tip3p.itp"\n[ system ]\nwater\n[ molecules ]\n');
      expect(run(['solvate', '-cs', 'spc216.gro', '-box', '3', '3', '3', '-o', 'sys.gro', '-p', 'topol.top']).status).toBe(0);
      for (const stage of ['em', 'nvt']) {
        const g = generateMdp({ stage, system: 'solution' });
        fs.writeFileSync(path.join(dir, `${stage}.mdp`), g.text);
        const r = run(['grompp', '-f', `${stage}.mdp`, '-c', 'sys.gro', '-p', 'topol.top', '-o', `${stage}.tpr`]);
        expect(r.status).toBe(0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
