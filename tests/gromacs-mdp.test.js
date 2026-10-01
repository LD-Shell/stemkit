import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MDP_RELEASE, MDP_MANUAL, normaliseName, canonicalName, mdpDocUrl, optionInfo, sectionsInOrder, listOptions,
  obsoleteOptions, searchOptions, loadMdpDocs, parseMdp, mdpValue, checkMdp, explainMdp,
  psToSteps, nsToSteps, stepsToPs, formatDuration, pullStart,
  FORCE_FIELDS, THERMOSTATS, BAROSTATS, STAGES, SYSTEM_TYPES, defaultSettings, generateMdp, generateWorkflow,
  GROMACS_VERSIONS, DEFAULT_GROMACS_VERSION, MDP_VERSION_CHANGES, gromacsVersion, gromacsVersionInfo, versionChanges
} from '../src/core/gromacs-mdp.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'gromacs');

/* Every id on the live manual page, fetched once (see the file's header). */
const ANCHORS = fs.readFileSync(path.join(FIXTURES, 'manual-anchors-2025.1.txt'), 'utf8')
  .split('\n').filter(l => l && !l.startsWith('#'));

/*
 * grompp's verdicts on the broken files. Recorded by running real grompp
 * (GROMACS 2025.0, mixed precision, -maxwarn 0) on a solvated AMBER99SB-ILDN
 * peptide with position restraints available (a few cases, marked `system`,
 * on the coarse-grained stand-in; a grompp that hangs counts as stopping):
 *     GMX_BIN=/path/to/gmx node tools/check-gromacs-grompp.mjs --record
 * The same cases through grompp 2024.6, 2023.5 and 2022.6 (built from source)
 * are in broken-mdp-<version>.json, checked with checkMdp's version option.
 */
const BROKEN = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'broken-mdp.json'), 'utf8')).cases;
const BROKEN_BY_VERSION = Object.fromEntries(['2024', '2023', '2022'].map(v =>
  [v, JSON.parse(fs.readFileSync(path.join(FIXTURES, `broken-mdp-${v}.json`), 'utf8'))]));

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
    // couple-same draws messages that need the coordinates and topology, and
    // cases marked counts: false have grompp read undefined memory.
    if (!c.grompp.fatal && name !== 'couple-same' && c.counts !== false) {
      expect([r.grompp.errors, r.grompp.warnings, r.grompp.notes]).toEqual([c.grompp.errors, c.grompp.warnings, c.grompp.notes]);
    }
  });

  test('the set covers passing and failing files', () => {
    expect(BROKEN.length).toBe(180);
    expect(BROKEN.filter(c => c.grompp.passes).length).toBeGreaterThan(20);
    expect(BROKEN.filter(c => !c.grompp.passes).length).toBeGreaterThan(60);
  });
});

describe.each(['2024', '2023', '2022'])('checkMdp agrees with grompp %s', (version) => {
  const fixture = BROKEN_BY_VERSION[version];

  test('the cases were recorded with that release, all of them', () => {
    expect(fixture.version).toBe(version);
    expect(fixture.release.startsWith(`${version}.`)).toBe(true);
    expect(fixture.cases.map(c => c.name)).toEqual(BROKEN.map(c => c.name));
  });

  test.each(fixture.cases.map(c => [c.name, c]))('%s', (name, c) => {
    const r = checkMdp(c.mdp, { ...(c.context ? { context: c.context } : {}), version });
    expect(r.version).toBe(version);
    expect(r.grompp.passes).toBe(c.grompp.passes);
    if (!c.grompp.fatal && name !== 'couple-same' && c.counts !== false) {
      expect([r.grompp.errors, r.grompp.warnings, r.grompp.notes]).toEqual([c.grompp.errors, c.grompp.warnings, c.grompp.notes]);
    }
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
 * Regressions from a cross-check against GROMACS 2025.1's source and real
 * grompp/mdrun 2025.0. The verdicts of grompp itself on the same kinds of
 * file are in the fixture (tools/check-gromacs-grompp.mjs --record); these
 * pin the messages and the explanations.
 */
describe('GROMACS versions', () => {
  const since = (name) => (optionInfo(name) || {}).since || null;
  const newerThan = (version) => (name) => since(name) !== null && Number(since(name)) > Number(version);

  test('lists the releases newest first, each with the patch release read and its manual', () => {
    expect(GROMACS_VERSIONS.map(v => v.id)).toEqual(['2025', '2024', '2023', '2022']);
    expect(DEFAULT_GROMACS_VERSION).toBe('2025');
    expect(GROMACS_VERSIONS.map(v => v.release)).toEqual([MDP_RELEASE, '2024.6', '2023.5', '2022.6']);
    expect(gromacsVersionInfo('2023').manual).toBe('https://manual.gromacs.org/2023.5/user-guide/mdp-options.html');
    expect(gromacsVersionInfo().manual).toBe(MDP_MANUAL);
    expect(['2023.3', 2023, 'GROMACS 2023', ' 2023 '].map(gromacsVersion)).toEqual(['2023', '2023', '2023', '2023']);
    // Anything else is the default, not a guess.
    expect([undefined, null, '', '2021', '2026', 'latest'].map(gromacsVersion)).toEqual(Array(6).fill('2025'));
  });

  test('what each release lacks names options of the table, added in 2023 to 2025, or a changed default', () => {
    for (const c of MDP_VERSION_CHANGES) {
      expect([c.option, optionInfo(c.option) && !optionInfo(c.option).obsolete]).toEqual([c.option, true]);
      expect(['2023', '2024', '2025']).toContain(c.since);
      expect(['added', 'default']).toContain(c.change);
      expect(c.note.length).toBeGreaterThan(10);
    }
    expect(since('mass-repartition-factor')).toBe('2024');
    expect(since('verlet-buffer-pressure-tolerance')).toBe('2024');
    expect(since('ensemble-temperature-setting')).toBe('2023');
    expect(since('awh2-growth-factor')).toBe('2024');
    expect(since('nnpot-active')).toBe('2025');
    expect(since('tau-t')).toBeNull();
    expect(optionInfo('tau-p').olderDefault).toEqual({ value: '1', before: '2024' });
    expect(optionInfo('awh-nsamples-update').olderDefault).toEqual({ value: '10', before: '2025' });
    expect(versionChanges('2025')).toEqual([]);
    expect(versionChanges('2024').every(c => c.since === '2025')).toBe(true);
    const lacks2023 = versionChanges('2023').map(c => c.option);
    expect(lacks2023).toEqual(expect.arrayContaining(['mass-repartition-factor', 'verlet-buffer-pressure-tolerance', 'tau-p']));
    expect(lacks2023).not.toContain('ensemble-temperature');
    expect(versionChanges('2022').map(c => c.option)).toContain('ensemble-temperature');
  });

  test('listOptions keeps to the options a release reads', () => {
    expect(listOptions({ version: '2025' })).toEqual(listOptions());
    const v2023 = listOptions({ version: '2023' });
    expect(v2023).not.toContain('mass-repartition-factor');
    expect(v2023).toContain('ensemble-temperature');
    expect(listOptions({ version: '2022' })).not.toContain('ensemble-temperature');
    expect(listOptions().length - v2023.length).toBe(MDP_VERSION_CHANGES.filter(c => c.change === 'added' && c.since > '2023').length);
  });

  test('an option newer than the release is unknown to its grompp, with what to do instead', () => {
    const text = 'integrator = md\nmass-repartition-factor = 3\n';
    const old = checkMdp(text, { version: '2023' });
    const issue = old.issues.find(i => i.id === 'newer-option');
    expect(issue).toMatchObject({ severity: 'warning', option: 'mass-repartition-factor', line: 2, source: 'grompp' });
    expect(issue.message).toMatch(/new in GROMACS 2024: grompp 2023 does not know it/);
    expect(issue.message).toMatch(/HMassRepartition/);
    expect(old.grompp.passes).toBe(false);
    expect(old.version).toBe('2023');
    expect(checkMdp(text, { version: '2024' }).issues.some(i => i.id === 'newer-option')).toBe(false);
    expect(checkMdp(text).version).toBe('2025');
    // A family member, and a misspelt name, name the release too.
    const awh = BROKEN.find(c => c.name === 'version-awh-growth-factor');
    expect(checkMdp(awh.mdp, { version: '2022' }).issues.find(i => i.id === 'newer-option').option).toBe('awh1-growth-factor');
    expect(checkMdp('nstxtcouts = 1\n', { version: '2022' }).issues[0].message).toMatch(/not an option of GROMACS 2022/);
  });

  test('defaults are the release\'s own', () => {
    const npt = 'integrator = md\ntcoupl = v-rescale\ntc-grps = System\ntau-t = 0.1\nref-t = 300\npcoupl = C-rescale\ncompressibility = 4.5e-5\nref-p = 1\n';
    expect(checkMdp(npt, { version: '2023' }).settings['tau-p']).toBe(1);
    expect(checkMdp(npt, { version: '2024' }).settings['tau-p']).toBe(5);
    const row = (version) => explainMdp('tau-p = 1\n', { version })[0];
    expect([row('2023').isDefault, row('2023').default]).toEqual([true, '1']);
    expect([row('2025').isDefault, row('2025').default]).toEqual([false, '5']);
  });

  test('explainMdp marks an option newer than the release', () => {
    const rows = explainMdp('integrator = md\nverlet-buffer-pressure-tolerance = -1\n', { version: '2023' });
    expect(rows[1]).toMatchObject({ name: 'verlet-buffer-pressure-tolerance', status: 'unknown' });
    expect(rows[1].meaning).toMatch(/^New in GROMACS 2024: grompp 2023 does not know it/);
    expect(explainMdp('integrator = md\nverlet-buffer-pressure-tolerance = -1\n')[1].status).toBe('ok');
  });

  test('checks that came and went: C-rescale anisotropic, andersen-massive, deform', () => {
    const aniso = BROKEN.find(c => c.name === 'crescale-anisotropic').mdp;
    expect(checkMdp(aniso, { version: '2022' }).issues.find(i => i.id === 'crescale-type').source).toBe('mdrun');
    expect(checkMdp(aniso, { version: '2023' }).issues.find(i => i.id === 'crescale-type').source).toBe('grompp');
    const deform = BROKEN.find(c => c.name === 'version-deform-two-groups').mdp;
    expect(checkMdp(deform, { version: '2023' }).issues.some(i => /deform/.test(i.id))).toBe(false);
    expect(checkMdp(deform, { version: '2024' }).issues.map(i => i.id)).toContain('deform-tc-grps');
    const andersen = BROKEN.find(c => c.name === 'version-andersen-massive-constraints').mdp;
    expect(checkMdp(andersen, { version: '2023' }).issues.map(i => i.id)).toContain('andersen-constraints');
    expect(checkMdp(andersen, { version: '2024' }).issues.map(i => i.id)).not.toContain('andersen-constraints');
  });

  test('Martini 3 files leave out verlet-buffer-pressure-tolerance before 2024, and say why', () => {
    for (const version of ['2022', '2023']) {
      for (const stage of ['nvt', 'npt', 'prod', 'anneal', 'pull']) {
        const g = generateMdp({ stage, forceField: 'martini3', version });
        const v = parseMdp(g.text).values;
        expect([version, stage, v['verlet-buffer-pressure-tolerance']]).toEqual([version, stage, undefined]);
        expect(v['verlet-buffer-tolerance']).toBe('-1.0');
        expect(v.rlist).toBe('1.35');
        const line = g.text.split('\n').find(l => l.startsWith('verlet-buffer-tolerance'));
        expect(line).toMatch(new RegExp(`GROMACS ${version} has no verlet-buffer-pressure-tolerance to switch off \\(new in 2024\\)`));
        expect(g.text).toMatch(new RegExp(`for GROMACS ${version}\\.\\n; Every option: https://manual\\.gromacs\\.org/${version}\\.\\d/`));
        const r = checkMdp(g.text, { version, context: { posres: g.settings.posres, forceField: 'martini3', system: 'coarse-grained' } });
        expect([version, stage, r.grompp.errors, r.grompp.warnings]).toEqual([version, stage, 0, 0]);
        // Nothing to warn about for the release (pulling keeps its own pbcatom advice).
        expect(g.warnings.filter(w => /GROMACS 20\d\d/.test(w))).toEqual([]);
      }
    }
    for (const version of ['2024', '2025']) {
      const g = generateMdp({ stage: 'prod', forceField: 'martini3', version });
      expect(parseMdp(g.text).values['verlet-buffer-pressure-tolerance']).toBe('-1.0');
      expect(g.text).not.toMatch(/has no verlet-buffer-pressure-tolerance/);
    }
  });

  test('hydrogen mass repartitioning needs 2024: older releases keep 2 fs and say so on the dt line', () => {
    const g = generateMdp({ stage: 'nvt', forceField: 'amber', hmr: true, version: '2023' });
    const v = parseMdp(g.text).values;
    expect(v['mass-repartition-factor']).toBeUndefined();
    expect(v.dt).toBe('0.002');
    expect(g.settings.hmr).toBe(false);
    expect(g.warnings.join(' ')).toMatch(/needs GROMACS 2024 or newer.*HMassRepartition/);
    expect(g.text.split('\n').find(l => l.startsWith('dt '))).toMatch(/no HMR: GROMACS 2023 has no mass-repartition-factor \(new in 2024\)/);
    const newer = generateMdp({ stage: 'nvt', forceField: 'amber', hmr: true, version: '2024' });
    expect(parseMdp(newer.text).values['mass-repartition-factor']).toBe('3.0');
    expect(parseMdp(newer.text).values.dt).toBe('0.004');
    // 4 fs typed by hand with a 2023 topology repartitioned elsewhere: the advice says how.
    const typed = generateMdp({ stage: 'nvt', forceField: 'amber', dt: 0.004, version: '2023' });
    expect(typed.warnings.join(' ')).toMatch(/unless the topology's hydrogen masses are already repartitioned/);
  });

  test('every preset passes the checker of every release, using only options it reads', () => {
    for (const { id: version } of GROMACS_VERSIONS) {
      for (const ff of Object.keys(FORCE_FIELDS)) {
        for (const stage of Object.keys(STAGES)) {
          for (const hmr of STAGES[stage].dynamics && FORCE_FIELDS[ff].hmr ? [false, true] : [false]) {
            for (const barostat of ['npt', 'prod', 'pull'].includes(stage) ? ['c-rescale', 'parrinello-rahman'] : [undefined]) {
              const g = generateMdp({ stage, forceField: ff, hmr, version, ...(barostat ? { barostat } : {}) });
              const where = `${version} ${ff} ${stage}${hmr ? ' HMR' : ''} ${barostat || ''}`;
              expect([where, g.entries.map(e => e.name).filter(newerThan(version))]).toEqual([where, []]);
              expect([where, g.expected.filter(e => e.severity !== 'note').length]).toEqual([where, ff === 'gromos54a7' ? 1 : 0]);
              expect([where, g.settings.version]).toEqual([where, version]);
            }
          }
        }
      }
    }
  });

  test('a workflow carries the release to every stage', () => {
    const wf = generateWorkflow({ forceField: 'martini3', version: '2023' });
    expect(wf.map(g => g.settings.version)).toEqual(['2023', '2023', '2023', '2023']);
    expect(wf.some(g => /verlet-buffer-pressure-tolerance\s*=/.test(g.text))).toBe(false);
  });
});

describe('agreement with grompp on corner cases', () => {
  const ids = (text, options) => checkMdp(text, options).issues.map(i => `${i.severity}:${i.id}`);
  const B = 'integrator = md\ndt = 0.002\nnsteps = 1000\ncoulombtype = PME\nrcoulomb = 1.0\nrvdw = 1.0\nconstraints = h-bonds\n' +
    'tcoupl = V-rescale\ntc-grps = System\ntau-t = 0.1\nref-t = 300\n';
  const verdict = (text, options) => checkMdp(text, options).grompp;
  const meaning = (text, name) => explainMdp(text).find(r => r.name === name);

  test('density-guided vectors are space-separated, as grompp splits them', () => {
    expect(optionInfo('density-guided-simulation-shift-vector').default).toBe('0 0 0');
    expect(optionInfo('density-guided-simulation-transformation-matrix').default).toBe('1 0 0 0 1 0 0 0 1');
    expect(verdict('density-guided-simulation-shift-vector = 0,0,0\n').passes).toBe(false);
    expect(verdict('density-guided-simulation-transformation-matrix = 1,0,0,0,1,0,0,0,1\n').passes).toBe(false);
    expect(verdict('density-guided-simulation-shift-vector = 1 , 2 , 3\n').passes).toBe(false);
    expect(verdict('density-guided-simulation-shift-vector = 1 2 3\n').passes).toBe(true);
    const m = checkMdp('density-guided-simulation-shift-vector = 0 0\n').issues.find(i => i.id === 'density-guided-vector').message;
    expect(m).toMatch(/separated by spaces/);
    expect(m).not.toMatch(/commas\./);
  });

  test('a renamed option is still gated like its new name (pull-print-com1)', () => {
    const r = checkMdp('integrator = md\npull-print-com1 = yes\n');
    expect(r.grompp.passes).toBe(false);
    const w = r.issues.find(i => i.id === 'inactive');
    expect(w).toMatchObject({ option: 'pull-print-com', line: 2 });
    expect(w.message).toMatch(/Unknown left-hand 'pull-print-com'/);
    const row = explainMdp('integrator = md\npull-print-com1 = yes\n')[1];
    expect(row).toMatchObject({ status: 'inactive', name: 'pull-print-com1' });
    expect(row.meaning).toMatch(/pull = yes/);
    const on = checkMdp('pull = yes\npull-ngroups = 2\npull-group1-name = A\npull-group2-name = B\npull-coord1-groups = 1 2\npull-print-com1 = yes\n');
    expect(on.issues.map(i => i.id)).not.toContain('inactive');
  });

  test('PME-Switch: grompp accepts it, and the text no longer says it stops', () => {
    const v = optionInfo('coulombtype').values.find(x => x.value === 'PME-Switch');
    expect(v.note).not.toMatch(/stops/);
    expect(v.note).toMatch(/unsupported/);
    const text = `${B.replace('coulombtype = PME', 'coulombtype = PME-Switch')}rcoulomb-switch = 0.96\n`;
    expect(verdict(text).passes).toBe(true);
    expect(meaning(text, 'coulombtype').meaning).not.toMatch(/stops/);
    // With the default rcoulomb-switch of 0 the switching range draws grompp's warning.
    expect(ids(B.replace('coulombtype = PME', 'coulombtype = PME-Switch'))).toContain('warning:coulomb-switch-range');
  });

  test('undocumented spellings say what grompp does with them, and failing ones are not offered', () => {
    const cm = optionInfo('coulomb-modifier');
    expect(cm.undocumented.find(u => u.value === 'Force-switch')).toMatchObject({ status: 'unsupported' });
    expect(cm.undocumented.find(u => u.value === 'Potential-shift-Verlet')).toMatchObject({ status: null });
    expect(cm.accepted).toEqual(expect.arrayContaining(['Potential-shift', 'None', 'Potential-shift-Verlet']));
    for (const bad of ['Force-switch', 'Exact-cutoff', 'Potential-switch']) expect(cm.accepted).not.toContain(bad);
    expect(optionInfo('pbc').accepted).not.toContain('unset');
    expect(optionInfo('coulombtype').accepted).not.toContain('Poisson');
    expect(optionInfo('integrator').accepted).not.toContain('sd2 - removed');
    expect(optionInfo('QMMM').accepted).not.toContain('yes');
    expect(optionInfo('tcoupl').accepted).toContain('yes'); // an alias, which works
    expect(meaning(`${B}coulomb-modifier = Force-switch\n`, 'coulomb-modifier').meaning).toMatch(/grompp stops/);
    expect(meaning(`${B}pbc = unset\n`, 'pbc').meaning).toMatch(/crashes/);
    expect(meaning('tcoupl = yes\n', 'tcoupl').meaning).toMatch(/Berendsen/);
    expect(meaning('pcoupl = Isotropic\n', 'pcoupl').meaning).toMatch(/Berendsen/);
    expect(meaning('integrator = sd2 - removed\n', 'integrator').meaning).toMatch(/mdrun stops/);
    // The checker agrees: pbc = unset is fatal, sd2 passes grompp but not mdrun.
    expect(checkMdp(`${B}pbc = unset\n`).issues.find(i => i.id === 'pbc-unset')).toBeTruthy();
    const sd2 = checkMdp(B.replace('integrator = md', 'integrator = sd2 - removed'));
    expect(sd2.grompp.passes).toBe(true);
    expect(sd2.issues.find(i => i.id === 'sd2-removed')).toMatchObject({ severity: 'error', source: 'mdrun' });
    // Spellings with spaces keep them in the comparison key.
    const nec = B.replace('coulombtype = PME', 'coulombtype = Reaction-Field-nec (unsupported)');
    expect(ids(nec)).toContain('error:coulombtype-removed');
    expect(ids(nec)).not.toContain('error:verlet-coulombtype');
  });

  test('module enums are read with case and by prefix, in explanations as in checks', () => {
    const t = (v) => `density-guided-simulation-similarity-measure = ${v}\n`;
    expect(verdict(t('Inner-Product')).passes).toBe(false);
    expect(meaning(t('Inner-Product'), 'density-guided-simulation-similarity-measure')).toMatchObject({ isDefault: false });
    expect(meaning(t('Inner-Product'), 'density-guided-simulation-similarity-measure').meaning).toMatch(/not one of the values.*case/);
    expect(verdict(t('inner')).passes).toBe(true);
    const inner = meaning(t('inner'), 'density-guided-simulation-similarity-measure');
    expect(inner.meaning).toMatch(/read as inner-product/);
    expect(inner.isDefault).toBe(true);
    expect(meaning('qmmm-cp2k-qmmethod = B\n', 'qmmm-cp2k-qmmethod').meaning).toMatch(/read as BLYP/);
  });

  test('summaries: tinit, ld-seed, andersen-seed, iontype0-name', () => {
    expect(optionInfo('tinit').summary).not.toMatch(/only changes the time stamps/);
    expect(optionInfo('tinit').summary).toMatch(/pull rates/);
    expect(optionInfo('andersen-seed').reason).not.toMatch(/ld-seed/);
    expect(optionInfo('ld-seed').summary).toMatch(/v-rescale/);
    expect(optionInfo('ld-seed').summary).not.toMatch(/Andersen/i);
    expect(optionInfo('iontype0-name')).toMatchObject({ kind: 'group' });
    expect(optionInfo('iontype0-name').summary).toMatch(/Index group/);
    const swap = 'integrator = md\nnsteps = 0\ncontinuation = yes\nswapcoords = Z\nsplit-group0 = GA\nsplit-group1 = GB\nsolvent-group = REST\niontype0-name = Argon\n';
    const r = checkMdp(swap, { context: { indexGroups: ['System', 'GA', 'GB', 'REST'] } });
    expect(r.grompp.passes).toBe(false);
    expect(r.issues.find(i => i.id === 'group-unknown')).toMatchObject({ option: 'iontype0-name' });
  });

  test('awh1-dim1-diffusion: grompp runs with 1e-5 when it is 0 or unset, and notes it', () => {
    expect(optionInfo('awh1-dim1-diffusion')).toMatchObject({ default: '1e-05', gromppDefault: '0', docDefault: null });
    const awh = 'integrator = md\ndt = 0.002\nnsteps = 0\ncontinuation = yes\ntcoupl = v-rescale\ntc-grps = System\ntau-t = 0.1\nref-t = 120\n' +
      'nstcalcenergy = 100\nnstenergy = 100\npull = yes\npull-ngroups = 2\npull-group1-name = P1\npull-group2-name = P2\n' +
      'pull-coord1-groups = 1 2\npull-coord1-type = external-potential\npull-coord1-potential-provider = awh\nawh = yes\nawh-nstout = 100\n' +
      'awh1-ndim = 1\nawh1-dim1-start = 0.4\nawh1-dim1-end = 0.7\nawh1-dim1-force-constant = 5000\n';
    expect(ids(awh)).toContain('note:awh-diffusion');
    expect(ids(`${awh}awh1-dim1-diffusion = 0\n`)).toContain('note:awh-diffusion');
    expect(ids(`${awh}awh1-dim1-diffusion = 5e-5\n`)).not.toContain('note:awh-diffusion');
    const row = meaning(`${awh}awh1-dim1-diffusion = 0\n`, 'awh1-dim1-diffusion');
    expect(row.isDefault).toBe(false);
    expect(row.meaning).toMatch(/replaces .* by 1e-5/);
  });

  test('grompp needs a positive global communication period for every integrator', () => {
    expect(ids('integrator = steep\nnstcalcenergy = -1\n')).toContain('error:nstglobalcomm');
    expect(ids(`${B.replace('tcoupl = V-rescale', 'tcoupl = no')}nstcalcenergy = 0\n`)).toContain('error:nstglobalcomm');
    expect(ids(`${B.replace('integrator = md', 'integrator = sd')}nstcalcenergy = 0\n`)).toContain('error:nstglobalcomm');
    // A thermostat supplies the period, and comm-mode = None needs none.
    expect(ids(`${B}nstcalcenergy = 0\n`)).not.toContain('error:nstglobalcomm');
    expect(ids('integrator = steep\nnstcalcenergy = -1\ncomm-mode = None\n')).not.toContain('error:nstglobalcomm');
    expect(ids('integrator = steep\n')).not.toContain('error:nstglobalcomm');
    // The COM period note now covers minimisers too.
    expect(ids('integrator = cg\nnstcomm = 1\n')).toContain('note:nstcomm-global');
  });

  test('shear deformation with pressure coupling draws grompp\'s off-diagonal warning', () => {
    const npt = `${B}pcoupl = C-rescale\ntau-p = 2\ncompressibility = 4.5e-5\nref-p = 1\ndeform-init-flow = yes\n`;
    const r = checkMdp(`${npt}deform = 0 0 0 0.01 0 0\n`);
    expect(r.grompp).toMatchObject({ passes: false, errors: 0, warnings: 1 });
    expect(r.issues.find(i => i.id === 'deform-shear-coupled').message).toMatch(/b\(x\)/);
    expect(ids(`${npt}deform = 0.01 0 0 0 0 0\n`)).toContain('error:deform-compressibility');
  });

  test('frozen atoms in the COM removal group: a warning for partial, a note for full freezing', () => {
    expect(checkMdp(`${B}freezegrps = Protein\nfreezedim = N N Y\n`).grompp).toMatchObject({ passes: false, warnings: 1 });
    expect(ids(`${B}freezegrps = Protein\nfreezedim = Y Y Y\n`)).toContain('note:freeze-com-full');
    expect(verdict(`${B}freezegrps = Protein\nfreezedim = Y Y Y\n`).passes).toBe(true);
    // Every atom partially frozen, or no COM removal: no warning.
    expect(ids(`${B}freezegrps = System\nfreezedim = N N Y\n`)).not.toContain('warning:freeze-com-partial');
    expect(ids(`${B}freezegrps = Protein\nfreezedim = N N Y\ncomm-mode = None\nnsteps = 10\n`)).not.toContain('warning:freeze-com-partial');
  });

  test('define and include words that grompp drops, or hangs on', () => {
    const hang = checkMdp(`${B}define = -D POSRES\n`);
    expect(hang.grompp.passes).toBe(false);
    expect(hang.issues.find(i => i.id === 'preprocessor-hang').message).toMatch(/hangs/);
    expect(ids(`${B}define = POSRES\n`)).toContain('warning:preprocessor-malformed');
    expect(ids(`${B}define = -I/usr/include\n`)).toContain('warning:preprocessor-malformed');
    expect(ids(`${B}include = /usr/include\n`)).toContain('warning:preprocessor-malformed');
    expect(ids(`${B}define = "-DPOSRES"\n`)).toContain('warning:preprocessor-malformed');
    expect(ids(`${B}define = -DPOSRES -DFLEXIBLE\ninclude = -I/opt/itp\n`)).not.toContain('warning:preprocessor-malformed');
    const rows = explainMdp('define = -DPOSRES -I/usr -D X\ninclude = /usr/include -I/opt\n');
    expect(rows[0].meaning).toMatch(/-I\/usr: ignored/);
    expect(rows[0].meaning).toMatch(/-D: too short .* hangs/);
    expect(rows[0].meaning).not.toMatch(/passed to the topology preprocessor/);
    expect(rows[1].meaning).toMatch(/\/usr\/include: ignored/);
    expect(rows[1].meaning).toMatch(/\/opt is searched/);
  });

  test('sc-r-power other than 6 stops grompp whether or not soft-core is on', () => {
    expect(ids(`${B}sc-r-power = 48\n`)).toContain('error:sc-r-power');
    expect(ids(`${B}free-energy = yes\nfep-lambdas = 0 1\ninit-lambda-state = 0\nsc-alpha = 0\nsc-r-power = 48\n`)).toContain('error:sc-r-power');
    expect(ids(`${B}sc-r-power = 6.0\n`)).not.toContain('error:sc-r-power');
  });

  test('fourierspacing must be above 0 when it sets the PME grid', () => {
    for (const x of ['0', '-0.0', '-1', '1e-400']) expect(ids(`${B}fourierspacing = ${x}\n`)).toContain('error:fourierspacing');
    expect(ids(`${B}fourierspacing = 0\nfourier-nx = 32\nfourier-ny = 32\nfourier-nz = 32\n`)).not.toContain('error:fourierspacing');
    expect(ids(B.replace('coulombtype = PME', 'coulombtype = Reaction-Field') + 'fourierspacing = 0\n')).not.toContain('error:fourierspacing');
  });

  test('an electric field with sigma = 0 and t0 set is accepted, with advice', () => {
    const r = checkMdp(`${B}electric-field-z = 1 0 5 0\n`);
    expect(r.grompp.passes).toBe(true);
    expect(r.issues.find(i => i.id === 'electric-field-t0')).toMatchObject({ source: 'advice', severity: 'note' });
    expect(ids(`${B}electric-field-z = inf 0 0 0\n`)).toContain('error:electric-field');
    expect(ids(`${B}electric-field-z = 1e40 0 0 0\n`)).toContain('error:electric-field');
  });

  test('rigid water is not assumed with -DFLEXIBLE or for coarse-grained systems', () => {
    const mttk = 'integrator = md-vv\ndt = 0.0005\nnsteps = 100\ncoulombtype = PME\nrcoulomb = 1.0\nrvdw = 1.0\nconstraints = none\n' +
      'tcoupl = nose-hoover\ntc-grps = System\ntau-t = 1.0\nref-t = 300\npcoupl = MTTK\ntau-p = 5.0\ncompressibility = 4.5e-5\nref-p = 1.0\n';
    expect(ids(mttk)).toContain('error:mttk-constraints');
    expect(ids(`${mttk}define = -DFLEXIBLE\n`)).not.toContain('error:mttk-constraints');
    expect(ids(`${mttk}define = -DFLEXIBLE\n`, { context: { rigidWater: true } })).toContain('error:mttk-constraints');
    const cg = 'integrator = cg\nnsteps = 100\ncoulombtype = reaction-field\nrcoulomb = 1.1\nepsilon-r = 15\nrvdw = 1.1\nconstraints = none\nconstraint-algorithm = shake\n';
    expect(ids(cg, { context: { forceField: 'martini3', system: 'coarse-grained' } })).not.toContain('error:shake-minimiser');
    expect(ids(cg)).toContain('error:shake-minimiser');
  });

  test('enforced rotation and swap groups are checked as read_rotparams and make_swap_groups do', () => {
    const rot = `${B}rotation = yes\nrot-group0 = Protein\nrot-k0 = 500\n`;
    expect(verdict(rot).passes).toBe(true);
    expect(ids(`${rot}rot-vec0 = 0 0 0\n`)).toContain('error:rot-vec-zero');
    expect(ids(`${rot}rot-slab-dist0 = 0\n`)).toContain('error:rot-slab-dist');
    expect(ids(`${rot}rot-vec0 = 1 0\n`)).toContain('error:rot-vec-count');
    expect(ids(`${rot}rot-type0 = flex2\nrot-eps0 = 0\n`)).toContain('error:rot-eps');
    expect(ids(`${rot}rot-min-gauss0 = 0\n`)).toContain('error:rot-min-gauss');
    expect(ids(`${rot}rot-fit-method0 = potential\nrot-potfit-nsteps0 = 0\n`)).toContain('error:rot-potfit-nsteps');
    expect(ids(`${B}rotation = yes\nrot-group0 = Protein\n`)).toContain('note:rot-k');
    expect(ids(`${B}rotation = yes\nrot-k0 = 500\n`)).toContain('error:group-unset');
    expect(ids(`${B}rotation = yes\nrot-ngroups = 0\n`)).toContain('error:rot-ngroups');
    expect(ids(`${B}swapcoords = Z\n`)).toContain('error:group-unset');
  });

  test('AWH parameters are checked as the AWH reader checks them', () => {
    const pull = 'pull = yes\npull-ngroups = 2\npull-ncoords = 1\npull-group1-name = Chain_A\npull-group2-name = Chain_B\npull-coord1-groups = 1 2\n' +
      'pull-coord1-type = external-potential\npull-coord1-potential-provider = awh\npull-coord1-geometry = distance\n';
    const awh = `${B}${pull}awh = yes\nawh-nbias = 1\nawh1-ndim = 1\nawh1-dim1-coord-index = 1\nawh1-dim1-start = 0.5\nawh1-dim1-end = 2.0\n` +
      'awh1-dim1-diffusion = 1e-5\n';
    expect(ids(awh)).toContain('error:awh-force-constant');
    const ok = `${awh}awh1-dim1-force-constant = 10000\n`;
    expect(verdict(ok).passes).toBe(true);
    expect(ids(`${ok}awh1-target-cutoff = 10\n`)).toContain('error:awh-target-unused');
    expect(ids(`${ok}awh1-target-beta-scaling = 0.5\n`)).toContain('error:awh-target-unused');
    expect(ids(`${ok}awh-nstout = 0\n`)).toContain('error:awh-nstout');
    expect(ids(`${ok}awh1-error-init = 0\n`)).toContain('error:awh-error-init');
    expect(ids(ok.replace('awh1-dim1-coord-index = 1', 'awh1-dim1-coord-index = 2'))).toContain('error:awh-coord-range');
    expect(ids(`${ok}awh1-share-group = -1\n`)).toContain('error:awh-share-group');
    expect(ids(ok.replace('awh1-dim1-end = 2.0', 'awh1-dim1-end = 0.5'))).toContain('warning:awh-interval-zero');
    expect(ids(ok.replace('awh1-dim1-start = 0.5', 'awh1-dim1-start = -0.5'))).toContain('error:awh-interval-range');
    expect(ids(ok.replace('pull-coord1-type = external-potential\npull-coord1-potential-provider = awh\n', ''))).toContain('error:awh-pull-type');
    expect(ids(ok.replace('awh-nbias = 1', 'awh-nbias = 0'))).toContain('error:awh-nbias');
    // Two dimensions on one pull coordinate.
    const twice = ok.replace('awh1-ndim = 1', 'awh1-ndim = 2') + 'awh1-dim2-coord-index = 1\nawh1-dim2-start = 0.5\nawh1-dim2-end = 2\n' +
      'awh1-dim2-force-constant = 1000\nawh1-dim2-diffusion = 1e-5\n';
    expect(ids(twice)).toContain('error:awh-coord-twice');
  });

  test('a group named twice, or System with another group, stops grompp', () => {
    expect(ids(B.replace('tc-grps = System\ntau-t = 0.1\nref-t = 300', 'tc-grps = Protein Protein\ntau-t = 0.1 0.1\nref-t = 300 300'))).toContain('error:group-twice');
    expect(ids(B.replace('tc-grps = System\ntau-t = 0.1\nref-t = 300', 'tc-grps = protein Protein\ntau-t = 0.1 0.1\nref-t = 300 300'))).toContain('error:group-twice');
    expect(ids(`${B}energygrps = SOL SOL\n`)).toContain('error:group-twice');
    const sys = checkMdp(`${B}comm-grps = System Protein\n`).issues.find(i => i.id === 'group-twice');
    expect(sys.assumes).toMatch(/System/);
    expect(ids(`${B}energygrps = Protein SOL\n`)).not.toContain('error:group-twice');
  });

  test('reads white space and line ends as grompp does', () => {
    expect(verdict('integrator = md\nnsteps = 1000\ntcoupl = V-rescale\u00a0\ntc-grps = System\ntau-t = 0.1\nref-t = 300\n').passes).toBe(false);
    expect(checkMdp('tcoupl = V-rescale\u00a0\n').issues[0].message).toMatch(/no-break space/);
    expect(verdict('integrator\u00a0= md\n').passes).toBe(false);
    const bom = checkMdp('\ufeffintegrator = md\nnsteps = 1000\n');
    expect(bom.grompp.passes).toBe(false);
    expect(bom.issues.find(i => i.id === 'unknown').message).toMatch(/byte-order mark/);
    // A lone CR is not a line break: the file is one line to grompp.
    const cr = parseMdp('integrator = md\rnsteps = 1000\r');
    expect(cr.entries).toHaveLength(1);
    expect(verdict('integrator = md\rnsteps = 1000\r').passes).toBe(false);
    // CRLF works, and a vertical tab or form feed is still white space.
    expect(parseMdp('dt = 0.002\r\nnsteps = 10\r\n').entries.map(e => e.value)).toEqual(['0.002', '10']);
    expect(parseMdp('dt = 0.002\r\n').lines[0].raw).toBe('dt = 0.002');
    expect(parseMdp('tc-grps = A\u00a0B\n').entries[0].value).toBe('A\u00a0B');
    expect(checkMdp('tc-grps = A\tB\u000bC\n').settings['tc-grps']).toBe('A\tB\u000bC');
  });

  test('reals are read as strtod reads them, hexadecimal included', () => {
    expect(verdict(`${B.replace('ref-t = 300', 'ref-t = 0x12c')}tinit = 0x1p-3\n`).passes).toBe(true);
    expect(checkMdp(`${B}tinit = 0x1p-3\n`).settings.tinit).toBe(0.125);
    expect(checkMdp(`${B}tinit = 0x1.8p1\n`).settings.tinit).toBe(3);
    expect(ids(`${B}tinit = 0x\n`)).toContain('error:not-real');
  });

  test('number forms grompp refuses: overflow in lists, words in accelerate, four-number vectors, int wrap-around', () => {
    expect(verdict(B.replace('ref-t = 300', 'ref-t = inf')).passes).toBe(false);
    expect(verdict(B.replace('ref-t = 300', 'ref-t = 1e-400')).passes).toBe(false);
    expect(verdict(B.replace('ref-t = 300', 'ref-t = 1e39')).passes).toBe(false);
    expect(ids(`${B}acc-grps = Protein\naccelerate = a b c\n`).filter(x => x === 'error:accelerate-number')).toHaveLength(3);
    const pull = 'pull = yes\npull-ngroups = 2\npull-group1-name = A\npull-group2-name = B\npull-coord1-groups = 1 2\n' +
      'pull-coord1-geometry = direction\npull-coord1-dim = N N Y\n';
    expect(ids(`${B}${pull}pull-coord1-vec = 0 0 1 0\n`)).toContain('error:pull-vector-count');
    expect(ids(`${B}${pull}pull-coord1-vec = 0 0 1\n`)).not.toContain('error:pull-vector-count');
    expect(ids(`${B}${pull}pull-coord1-vec = 0 0 1\npull-coord1-origin = 0 0\n`)).toContain('error:pull-vector-count');
    // get_eint keeps the low 32 bits of strtol's long.
    const wrap = checkMdp(`${B}nstlist = 2147483648\n`);
    expect(wrap.grompp.passes).toBe(false);
    expect(wrap.settings.nstlist).toBe(-2147483648);
    expect(wrap.issues.find(i => i.id === 'integer-wrap')).toMatchObject({ source: 'advice' });
    expect(checkMdp(`${B}nstlist = 4294967306\n`).settings.nstlist).toBe(10);
    const energy = checkMdp(`${B}nstenergy = 2147483648\n`);
    expect(energy.grompp.passes).toBe(true);
    expect(energy.issues.map(i => i.id)).not.toContain('nstenergy-multiple');
    // nsteps is read as a 64-bit integer; module integers are refused beyond an int.
    expect(checkMdp(B.replace('nsteps = 1000', 'nsteps = 5000000000')).settings.nsteps).toBe(5000000000);
    expect(ids(`${B}colvars-seed = 2147483648\n`)).toContain('error:integer-overflow');
    expect(ids(`${B}density-guided-simulation-force-constant = 1e40\n`)).toContain('error:real-range');
  });

  test('explanations give pull and AWH values in the unit of their geometry', () => {
    const text = 'integrator = md\npull = yes\npull-ngroups = 4\npull-ncoords = 2\npull-group1-name = A\npull-group2-name = B\n' +
      'pull-group3-name = C\npull-group4-name = D\npull-coord1-geometry = angle\npull-coord1-groups = 1 2 3 4\npull-coord1-k = 1000\n' +
      'pull-coord1-rate = 0.1\npull-coord1-init = 90\npull-coord2-groups = 1 2\npull-coord2-type = constant-force\npull-coord2-k = 100\n' +
      'nsteps = 5e5\n';
    const rows = explainMdp(text);
    const m = (n) => rows.find(r => r.name === n);
    expect(m('pull-coord1-k').meaning).toBe('1000 kJ mol⁻¹ rad⁻².');
    expect(m('pull-coord1-rate').meaning).toBe('0.1 deg/ps.');
    expect(m('pull-coord1-init').meaning).toBe('90 deg.');
    expect(m('pull-coord1-init').unit).toBe('deg');
    expect(m('pull-coord2-k').meaning).toBe('100 kJ mol⁻¹ nm⁻¹.');
    expect(m('pull-coord2-type').meaning).toMatch(/pull-coord2-k is minus the force/);
    expect(m('nsteps').meaning).toMatch(/not a whole number/);
    expect(optionInfo('pull-coord3-start').summary).toMatch(/pull-coord3-init/);
    expect(optionInfo('awh2-dim3-diffusion').summary).toBe(optionInfo('awh1-dim1-diffusion').summary);
    const fep = explainMdp('integrator = md\nfree-energy = yes\nfep-lambdas = 0 0.5 1\ninit-lambda-state = 0\nawh = yes\nawh1-ndim = 1\n' +
      'awh1-dim1-coord-provider = fep-lambda\nawh1-dim1-start = 0\nawh1-dim1-end = 2\n');
    expect(fep.find(r => r.name === 'awh1-dim1-end').meaning).toBe('Lambda state 2.');
  });

  test('notes grompp prints: the NVE drift, and rot-k', () => {
    const nve = `${B.replace('tcoupl = V-rescale', 'tcoupl = no').replace(/tc-grps.*\n|tau-t.*\n|ref-t.*\n/g, '')}nsteps = 50000\ngen-vel = yes\ngen-temp = 300\n`;
    const r = checkMdp(nve.replace('nsteps = 1000\n', ''));
    expect(r.issues.find(i => i.id === 'nve-drift').message).toMatch(/100 ps .* about 10%/);
    expect(checkMdp(nve.replace('nsteps = 1000\n', '').replace('nsteps = 50000', 'nsteps = 1000')).issues.map(i => i.id)).not.toContain('nve-drift');
  });

  test('tau-t is quoted as written, not as a float', () => {
    const m = checkMdp('integrator = md\ndt = 0.002\ntcoupl = nose-hoover\nnh-chain-length = 1\ntc-grps = System\ntau-t = 0.1\nref-t = 300\nnsttcouple = 10')
      .issues.find(i => i.id === 'tau-t-short').message;
    expect(m).toMatch(/^tau-t \(0\.1 ps\)/);
  });

  test('values that break grompp while it sizes the buffer, or mdrun later', () => {
    const r = checkMdp(B.replace('rvdw = 1.0', 'rvdw = 0'));
    expect(r.issues.find(i => i.id === 'rvdw-zero')).toMatchObject({ severity: 'error', source: 'grompp' });
    expect(ids(B.replace('rvdw = 1.0', 'rvdw = 0.001'))).toContain('error:rvdw-zero');
    expect(ids(B.replace('rvdw = 1.0', 'rvdw = 0.3'))).not.toContain('error:rvdw-zero');
    expect(ids(`${B}epsilon-r = nan\n`)).toContain('error:epsilon-r-nan');
    expect(ids(`${B}ewald-rtol = -1\n`)).toContain('error:ewald-rtol');
    expect(ids(`${B}ewald-rtol = 0\n`)).not.toContain('error:ewald-rtol');
    expect(ids(`${B}vdwtype = PME\newald-rtol-lj = -1\n`)).toContain('error:ewald-rtol-lj');
    expect(ids(`${B}vdw-modifier = Exact-cutoff\n`)).toContain('error:vdw-exact-cutoff');
    // Minimisation sizes no buffer: grompp passes, mdrun is what fails.
    const em = checkMdp('integrator = steep\nnsteps = 10\ncoulombtype = PME\newald-rtol = -1\nvdw-modifier = Exact-cutoff\n');
    expect(em.grompp.passes).toBe(true);
    expect(em.issues.find(i => i.id === 'ewald-rtol')).toMatchObject({ source: 'mdrun' });
  });

  test('GROMOS 54A7 files constrain all bonds, as GROMOS was parametrised', () => {
    expect(FORCE_FIELDS.gromos54a7.constraints).toBe('all-bonds');
    const g = generateMdp({ stage: 'prod', forceField: 'gromos54a7' });
    const line = (n) => g.text.split('\n').find(l => l.startsWith(`${n} `));
    expect(parseMdp(g.text).values.constraints).toBe('all-bonds');
    expect(line('constraints')).toMatch(/all bond lengths constrained/);
    expect(line('dt')).toMatch(/all bonds are constrained/);
    expect(g.text).not.toMatch(/bonds to hydrogen are constrained/);
    expect(g.expected.map(e => e.id)).toEqual(['gromos-twin-range']);
    expect(parseMdp(generateMdp({ stage: 'em', forceField: 'gromos54a7' }).text).values.constraints).toBe('none');
  });

  test('Martini 3 files follow the recommended Martini mdp: fixed rlist, coupling every nstlist, LINCS 8/2', () => {
    const v = parseMdp(generateMdp({ stage: 'prod', forceField: 'martini3', system: 'membrane' }).text).values;
    expect(v).toMatchObject({
      'verlet-buffer-tolerance': '-1.0', rlist: '1.35', nstlist: '20', nsttcouple: '20', nstpcouple: '20', 'lincs-order': '8', 'lincs-iter': '2'
    });
    // Nose-Hoover's 4 ps would be too short for coupling every 20 steps: grompp chooses.
    const nh = parseMdp(generateMdp({ stage: 'prod', forceField: 'martini3', thermostat: 'nose-hoover', barostat: 'parrinello-rahman' }).text).values;
    expect(nh.nsttcouple).toBeUndefined();
    expect(nh.nstpcouple).toBe('20');
    const amber = parseMdp(generateMdp({ stage: 'prod' }).text).values;
    expect(amber).toMatchObject({ 'verlet-buffer-tolerance': '0.005', 'lincs-order': '4' });
    expect(amber.rlist).toBeUndefined();
    // Conjugate gradients with LINCS on Martini's own [ constraints ].
    const cg = generateMdp({ stage: 'em-cg', forceField: 'martini3' });
    expect(parseMdp(cg.text).values['lincs-order']).toBe('8');
    expect(cg.expected).toEqual([]);
    expect(parseMdp(generateMdp({ stage: 'em-cg' }).text).values['lincs-order']).toBeUndefined();
  });

  test('the first dynamics stage of any workflow draws new velocities', () => {
    for (const stages of [['em', 'npt', 'prod'], ['em', 'prod'], ['em', 'anneal'], ['em', 'pull']]) {
      const files = generateWorkflow({ forceField: 'amber' }, stages);
      const v = parseMdp(files[1].text).values;
      expect(v).toMatchObject({ 'gen-vel': 'yes', continuation: 'no' });
      for (const f of files.slice(2)) expect(parseMdp(f.text).values['gen-vel']).toBe('no');
    }
    const kept = generateWorkflow({ perStage: { npt: { genVel: false, continuation: true } } }, ['em', 'npt']);
    expect(parseMdp(kept[1].text).values).toMatchObject({ 'gen-vel': 'no', continuation: 'yes' });
  });

  test('pull files can name central PBC atoms, and say when they need them', () => {
    const plain = generateMdp({ stage: 'pull' });
    expect(plain.warnings.join(' ')).toMatch(/pull-group1-pbcatom/);
    expect(parseMdp(plain.text).values['pull-pbc-ref-prev-step-com']).toBeUndefined();
    const g = generateMdp({ stage: 'pull', pull: { pbcatom1: 1234, pbcatom2: 56 } });
    expect(parseMdp(g.text).values).toMatchObject({ 'pull-group1-pbcatom': '1234', 'pull-group2-pbcatom': '56', 'pull-pbc-ref-prev-step-com': 'yes' });
    expect(g.warnings.join(' ')).not.toMatch(/pbcatom/);
    expect(checkMdp(g.text).issues.filter(i => i.severity !== 'note')).toEqual([]);
  });

  test('the rvdw comment follows grompp\'s rule for the electrostatics used', () => {
    const line = (ff) => generateMdp({ stage: 'prod', forceField: ff }).text.split('\n').find(l => l.startsWith('rvdw '));
    expect(line('amber')).toMatch(/may be shorter than rcoulomb/);
    expect(line('amber')).not.toMatch(/must equal/);
    expect(line('martini3')).toMatch(/must equal rcoulomb/);
  });

  test('membrane groups: SOLU exists only with a solute', () => {
    const g = generateMdp({ stage: 'nvt', forceField: 'charmm36', system: 'membrane' });
    expect(g.text.split('\n').find(l => l.startsWith('tc-grps'))).toMatch(/SOLU exists only with a solute/);
    expect(g.warnings.join(' ')).toMatch(/lipid-only bilayer use MEMB SOLV/);
    const chosen = generateMdp({ stage: 'nvt', forceField: 'charmm36', system: 'membrane', tcGroups: ['MEMB', 'SOLV'] });
    expect(chosen.warnings.join(' ')).not.toMatch(/SOLU/);
  });

  test('pull, rotation and module group names are checked against the index', () => {
    const pull = `${B}pull = yes\npull-ngroups = 2\npull-group1-name = Protein\npull-group2-name = LIG\npull-coord1-groups = 1 2\n`;
    const r = checkMdp(pull, { context: { indexGroups: ['System', 'Protein', 'Water'] } });
    expect(r.grompp.passes).toBe(false);
    expect(r.issues.find(i => i.id === 'group-unknown')).toMatchObject({ option: 'pull-group2-name' });
    expect(ids(pull, { context: { indexGroups: ['System', 'Protein', 'LIG'] } })).not.toContain('error:group-unknown');
    expect(ids(`${B}density-guided-simulation-active = yes\ndensity-guided-simulation-group = Ligand\n`, { context: { indexGroups: ['System'] } }))
      .toContain('error:group-unknown');
    expect(ids(`${B}density-guided-simulation-group = Ligand\n`, { context: { indexGroups: ['System'] } })).not.toContain('error:group-unknown');
    expect(ids(pull.replace('pull-group2-name = LIG\n', ''))).toContain('error:group-unset');
  });
});

/*
 * set_pull_init (readpull.cpp) on the coordinates grompp reads: the groups'
 * centres through the periodic boundary, their reach from the reference
 * atom, and the stop when a coordinate's groups start further apart than
 * 0.49 of the box along the dimensions it counts (pull.cpp). Real grompp
 * decides the same cases in tests/gromacs-ui.test.js (GMX_BIN).
 */
describe('pull groups in a structure (set_pull_init)', () => {
  const B = 'integrator = md\ndt = 0.002\nnsteps = 1000\ncoulombtype = PME\nrcoulomb = 1.0\nrvdw = 1.0\nconstraints = h-bonds\n' +
    'tcoupl = V-rescale\ntc-grps = System\ntau-t = 0.1\nref-t = 300\n';
  const pull = (over = {}) => {
    const o = { geometry: 'distance', dim: 'Y Y Y', vec: '0 0 0', g1: 'A', g2: 'B', extra: '', ...over };
    return `${B}pull = yes\npull-ngroups = 2\npull-ncoords = 1\npull-group1-name = ${o.g1}\npull-group2-name = ${o.g2}\n` +
      `pull-coord1-type = umbrella\npull-coord1-geometry = ${o.geometry}\npull-coord1-groups = 1 2\npull-coord1-dim = ${o.dim}\n` +
      `pull-coord1-vec = ${o.vec}\npull-coord1-start = yes\npull-coord1-k = 1000\n${o.extra}`;
  };
  // Two pairs of atoms: A centred at (0.55, 0.5, 1), B d further along x
  // (and dz along z), in a box of 4 x 4 x 10 nm unless one is given.
  const structure = (d, { dz = 0, box = [[4, 0, 0], [0, 4, 0], [0, 0, 10]], masses, extra = [] } = {}) => {
    const atoms = [{ x: 0.5, y: 0.5, z: 1 }, { x: 0.6, y: 0.5, z: 1 }, { x: 0.5 + d, y: 0.5, z: 1 + dz }, { x: 0.6 + d, y: 0.5, z: 1 + dz }, ...extra];
    const groups = [{ name: 'A', atoms: [1, 2] }, { name: 'B', atoms: [3, 4] }];
    if (extra.length) groups.push({ name: 'Wide', atoms: extra.map((_, i) => 5 + i) });
    return { name: 'test.gro', atoms, box, groups, ...(masses ? { masses } : {}) };
  };
  const check = (text, s, ctx = {}) => checkMdp(text, { context: { posres: false, structure: s, ...ctx } });
  const issue = (r, id) => r.issues.find(i => i.id === id);

  test('groups closer than 0.49 of the box pass, and their distance is where the coordinate starts', () => {
    const r = check(pull(), structure(1.9));
    expect(issue(r, 'pull-distance')).toBeUndefined();
    const start = pullStart(r.settings, structure(1.9));
    expect(start.coords[0]).toMatchObject({ checked: true, tooFar: false });
    expect(start.coords[0].value).toBeCloseTo(1.9, 5);
    expect(start.coords[0].limit).toBeCloseTo(0.49 * 4, 5);
    expect(start.groups.map(g => g.com[0])).toEqual([expect.closeTo(0.55, 5), expect.closeTo(2.45, 5)]);
  });

  test('further apart, grompp stops, with its words, the reason and the ways out', () => {
    const r = check(pull(), structure(1.98, { dz: 1.5 }));
    const i = issue(r, 'pull-distance');
    expect(i).toMatchObject({ severity: 'error', source: 'grompp', option: 'pull-coord1-dim' });
    expect(r.grompp.passes).toBe(false);
    expect(i.message).toMatch(/^Distance between pull groups 1 and 2 \(2\.48 nm\) is larger than 0\.49 times the box size \(1\.96 nm\), and grompp stops\./);
    expect(i.message).toMatch(/pull-coord1-dim = Y Y Y counts x, y and z, and the box is 4 x 4 x 10 nm: the centres of mass are apart by 1\.98 nm along x, 0 nm along y and 1\.5 nm along z\./);
    // Keeping z leaves 1.5 nm of 4.9 allowed; keeping x alone does not pass.
    expect(i.message).toMatch(/Count only the dimensions you pull along \(pull-coord1-dim = N N Y puts them 1\.5 nm apart, within the 4\.9 nm that allows\)/);
    expect(i.message).toMatch(/make the box at least 5\.07 nm along x and y/);
    expect(i.message).toMatch(/pull along a vector \(pull-coord1-geometry = direction/);
    expect(i.assumes).toMatch(/coordinates and box of test\.gro, as grompp reads them with -c, and equal atom masses/);
    // grompp stops there: nothing after set_pull_init is reported.
    expect(i).toHaveProperty('fatal', true);
  });

  test('only the counted dimensions, through the periodic boundary', () => {
    // Along x only the pair is too far; counting y and z only, it is not.
    expect(issue(check(pull({ dim: 'N Y Y' }), structure(1.98)), 'pull-distance')).toBeUndefined();
    // 2.1 nm apart along x is 1.9 nm through the boundary.
    expect(issue(check(pull(), structure(2.1)), 'pull-distance')).toBeUndefined();
    // A distance along x alone suggests no other dimension: nothing would be left.
    expect(issue(check(pull(), structure(1.98)), 'pull-distance').message).not.toMatch(/Count only/);
  });

  test('direction counts the dimensions of its vector; direction-periodic has no limit', () => {
    const far = structure(1.98, { dz: 4 });
    expect(issue(check(pull({ geometry: 'direction', vec: '0 0 1' }), far), 'pull-distance')).toBeUndefined();
    const i = issue(check(pull({ geometry: 'direction', vec: '1 0 0' }), far), 'pull-distance');
    expect(i.message).toMatch(/with pull-coord1-vec = 1 0 0 counts x,/);
    expect(i.message).toMatch(/pull-coord1-geometry = direction-periodic, as grompp suggests/);
    const periodic = check(pull({ geometry: 'direction-periodic', vec: '1 0 0' }), far);
    expect(issue(periodic, 'pull-distance')).toBeUndefined();
    expect(pullStart(periodic.settings, far).coords[0]).toMatchObject({ checked: true, limit: Infinity });
    // A signed value along the vector.
    expect(pullStart(check(pull({ geometry: 'direction', vec: '0 0 -2' }), far).settings, far).coords[0].value).toBeCloseTo(-4, 5);
  });

  test('a triclinic box limits by the box vectors the counted dimensions reach', () => {
    const box = [[5, 0, 0], [0, 5, 0], [1.5, 1.5, 3]];
    const limit = (dim) => pullStart(checkMdp(pull({ dim })).settings, structure(0.5, { box })).coords[0].limit;
    expect(limit('N N Y')).toBeCloseTo(0.49 * 3, 5);
    expect(limit('Y Y Y')).toBeCloseTo(0.49 * Math.sqrt(9 + 2.25 + 2.25), 5);
    expect(limit('Y Y N')).toBeCloseTo(0.49 * 5, 5);
  });

  test('without periodic boundaries nothing is too far', () => {
    const r = check(pull({ extra: 'pbc = no\n' }), structure(1.98, { dz: 4 }));
    expect(issue(r, 'pull-distance')).toBeUndefined();
  });

  test('centres are weighted by the masses given, or alike', () => {
    const s = structure(1, { masses: [1, 1, 1, 3] });
    const com = (ctx) => pullStart(checkMdp(pull()).settings, s, ctx).groups[1].com[0];
    expect(com()).toBeCloseTo(1.575, 5);
    expect(com({ equalMasses: true })).toBeCloseTo(1.55, 5);
    const r = check(pull(), { ...s, massNote: 'masses from the elements' }, { system: 'all-atom' });
    expect(pullStart(r.settings, s).coords[0].value).toBeCloseTo(1.025, 5);
  });

  test('a group reaching further than a quarter of the box from its reference atom', () => {
    // Four atoms spread along x: the middle one by number is 1.2, and the
    // last, 2.0 nm from it, is further than a quarter of the 4 nm box.
    const extra = [0.2, 1.2, 2.2, 3.2].map(x => ({ x, y: 2, z: 5 }));
    const s = structure(1, { extra });
    const wide = (more) => check(pull({ g1: 'Wide', dim: 'Y N N', extra: more }), s);
    const first = issue(wide(''), 'pull-pbcatom');
    expect(first).toMatchObject({ severity: 'error', option: 'pull-group1-name' });
    expect(first.message).toMatch(/Pull group 1 \(Wide\) reaches further than a quarter of the box from its reference atom, the middle one by number \(atom 6\)/);
    expect(first.message).toMatch(/a centrally placed atom should be chosen as pbcatom/);
    // A chosen atom still needs the previous step's centre to follow.
    const chosen = issue(wide('pull-group1-pbcatom = 5\n'), 'pull-pbcatom');
    expect(chosen).toMatchObject({ option: 'pull-pbc-ref-prev-step-com' });
    expect(issue(wide('pull-group1-pbcatom = 5\npull-pbc-ref-prev-step-com = yes\n'), 'pull-pbcatom')).toBeUndefined();
    // Along a dimension it does not reach, no reference is needed.
    expect(issue(check(pull({ g1: 'Wide', dim: 'N N Y' }), s), 'pull-pbcatom')).toBeUndefined();
    // With the previous step's centre, the second sum starts from the first
    // (0.7 nm, from atom 5 at 0.2); grompp still finds the group wide, but
    // lets it pass.
    const r = pullStart(checkMdp(pull({ g1: 'Wide', dim: 'Y N N', extra: 'pull-group1-pbcatom = 5\npull-pbc-ref-prev-step-com = yes\n' })).settings, s);
    expect(r.groups[0]).toMatchObject({ mode: 'prev-step-com', pbcAtom: 5, obeysPbc: false });
    expect(r.groups[0].com[0]).toBeCloseTo(0.7, 5);
  });

  test('nothing is checked without the structure, a group of it, or a box', () => {
    expect(issue(checkMdp(pull()), 'pull-distance')).toBeUndefined();
    expect(pullStart(checkMdp(pull()).settings, null)).toBeNull();
    expect(pullStart(checkMdp(pull()).settings, { ...structure(1.98), box: null })).toBeNull();
    const missing = pullStart(checkMdp(pull({ g2: 'LIG' })).settings, structure(1.98));
    expect(missing.coords[0].checked).toBe(false);
    expect(pullStart(checkMdp(B).settings, structure(1.98))).toBeNull();
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
  let dir;
  const run = (args, input) => spawnSync(GMX, [...args, '-quiet'], { cwd: dir, input, encoding: 'utf8', timeout: 60000 });
  const grompp = (name, text) => {
    fs.writeFileSync(path.join(dir, `${name}.mdp`), text);
    return run(['grompp', '-f', `${name}.mdp`, '-c', 'sys.gro', '-p', 'topol.top', '-o', `${name}.tpr`, '-maxwarn', '0']);
  };
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-mdp-'));
    fs.writeFileSync(path.join(dir, 'topol.top'), '#include "amber99sb-ildn.ff/forcefield.itp"\n#include "amber99sb-ildn.ff/tip3p.itp"\n[ system ]\nwater\n[ molecules ]\n');
    expect(run(['solvate', '-cs', 'spc216.gro', '-box', '3', '3', '3', '-o', 'sys.gro', '-p', 'topol.top']).status).toBe(0);
  }, 60000);
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('accepts generated files for a water box', () => {
    for (const stage of ['em', 'nvt']) {
      const g = generateMdp({ stage, system: 'solution' });
      expect(grompp(stage, g.text).status).toBe(0);
    }
  }, 60000);

  test('agrees with checkMdp where the cross-check found them apart', () => {
    const nvt = generateMdp({ stage: 'nvt', system: 'solution' }).text;
    const cases = [
      // The table's default, written out, is a value grompp takes; the manual's commas are not.
      `${nvt}density-guided-simulation-shift-vector = ${optionInfo('density-guided-simulation-shift-vector').default}\n`,
      `${nvt}density-guided-simulation-shift-vector = 0,0,0\n`,
      `${nvt}pull-print-com1 = yes\n`,
      `${nvt}electric-field-z = 1 0 5 0\n`,
      `${nvt}sc-r-power = 48\n`,
      nvt.replace(/^tc-grps .*$/m, 'tc-grps = System System').replace(/^tau-t .*$/m, 'tau-t = 0.1 0.1').replace(/^ref-t .*$/m, 'ref-t = 300 300')
    ];
    cases.forEach((text, i) => {
      expect([i, grompp(`x${i}`, text).status === 0]).toEqual([i, checkMdp(text, { context: { posres: false } }).grompp.passes]);
    });
  }, 120000);
});
