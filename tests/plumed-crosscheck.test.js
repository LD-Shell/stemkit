/*
 * The builder against what PLUMED 2.9, 2.10 and 2.11 do with what it writes:
 * one test per finding of the cross-check with the real programs. Each states
 * the behaviour PLUMED showed, so that a change that brings a finding back
 * fails here without PLUMED installed. tests/plumed-program.test.js runs the
 * same inputs through PLUMED when it is there.
 */
import { describe, test, expect } from '@jest/globals';
import {
  CV_DEFS, BIAS_DEFS, KEY_HELP, PREREQS, createCV, createFunction, buildCVLine, buildBiasLine,
  componentsForCV, availableArguments, defaultBiasValues, valueDomain, resolveAction,
  generatePlumedInput, checkCV, parseAtomList, weightedAngleShortcut, biasLabelFor, messageToText
} from '../src/core/plumed.js';
import { loadSyntax } from '../src/core/plumed-syntax.js';

const text = (ws) => ws.map(messageToText);
const lines = (g) => g.input.split('\n').filter(l => l && !l.startsWith('#'));
const gen = async (version, config) => generatePlumedInput({
  version, syntax: await loadSyntax(version), prints: [{ file: 'COLVAR', stride: 1 }], ...config
});
const cv = async (version, type, label, values) =>
  createCV(type, 1, { version, syntax: await loadSyntax(version), label, values });

describe('secondary structure and whole molecules (#1)', () => {
  test('from 2.10 a DRMSD element needs WHOLEMOLECULES too', async () => {
    // PLUMED 2.10 and 2.11 align the strands of every structure, which skips
    // making each segment whole: a helix split by the box reads about zero.
    for (const version of ['2.10', '2.11']) {
      const a = await cv(version, 'ALPHARMSD', 'a');
      expect(a.values.TYPE).toBe('DRMSD');
      const g = await gen(version, { molinfo: { structure: 'helix.pdb' }, cvs: [a], bias: { method: 'none' } });
      expect(text(g.warnings).some(w => w.includes('WHOLEMOLECULES'))).toBe(true);
      const whole = await gen(version, {
        molinfo: { structure: 'helix.pdb' }, whole: { enabled: true, residues: true }, cvs: [a], bias: { method: 'none' }
      });
      expect(text(whole.warnings).some(w => w.includes('WHOLEMOLECULES'))).toBe(false);
    }
  });

  test('2.9 makes the segments whole itself for DRMSD', async () => {
    const a = await cv('2.9', 'ALPHARMSD', 'a');
    const g = await gen('2.9', { molinfo: { structure: 'helix.pdb' }, cvs: [a], bias: { method: 'none' } });
    expect(g.warnings).toEqual([]);
    expect(CV_DEFS.ANTIBETARMSD.prereqSkipIf({ values: { TYPE: 'DRMSD' } }, '2.9')).toBe(true);
    expect(CV_DEFS.PARABETARMSD.prereqSkipIf({ values: { TYPE: 'DRMSD' } }, '2.11')).toBe(false);
    expect(PREREQS.wholemolecules.note).not.toContain('Not needed if you use TYPE=DRMSD');
  });
});

describe('fields that replace one another (#2, #20)', () => {
  test('SPECIESA and SPECIESB replace SPECIES, which is then not missing', async () => {
    // PLUMED reads SPECIES first and ignores the pair (2.11: 11.82 for 6.45).
    const c = await cv('2.11', 'COORDINATIONNUMBER_ADV', 'cn', { SPECIESA: '1-10', SPECIESB: '11-100' });
    const r = buildCVLine(c, CV_DEFS, { version: '2.11', syntax: await loadSyntax('2.11') });
    expect(r.line).toMatch(/^cn: COORDINATIONNUMBER SPECIESA=1-10 SPECIESB=11-100 /);
    expect(r.line).not.toMatch(/ SPECIES=/);
    const blank = buildCVLine({ ...c, values: { ...c.values, SPECIES: '' } }, CV_DEFS, { version: '2.11' });
    expect(blank.warnings.join(' ')).not.toContain('missing required `SPECIES`');
  });

  test('one of the pair alone is reported', () => {
    const r = buildCVLine({ type: 'COORDINATIONNUMBER_ADV', label: 'cn', values: { SPECIESA: '1-10' } });
    expect(r.warnings.some(w => w.includes('`SPECIESA` without `SPECIESB`'))).toBe(true);
  });

  test('ALLATOMS leaves ATOMS1 and ATOMS2 out', async () => {
    const d = await cv('2.11', 'DIMER', 'dim', { ALLATOMS: true });
    expect(buildCVLine(d, CV_DEFS, { version: '2.11' }).line)
      .toBe('dim: DIMER TEMP=300 Q=0.5 DSIGMA=0.002 ALLATOMS');
    expect(buildCVLine({ ...d, values: { ...d.values, ALLATOMS: false } }).line).toContain('ATOMS1=1,5,7');
  });
});

describe('numbered MORE_THAN of weighted angles (#3)', () => {
  test('2.10 and 2.11 get one threshold, written unnumbered', async () => {
    for (const version of ['2.10', '2.11']) {
      const x = await cv(version, 'ANGLES', 'x', { MEAN: false, MORE_THAN: '{RATIONAL R_0=0.5}; {RATIONAL R_0=0.8}' });
      expect(weightedAngleShortcut(x, CV_DEFS.ANGLES, version)).toBe(true);
      const r = buildCVLine(x, CV_DEFS, { version });
      expect(r.line).toContain('MORE_THAN={RATIONAL R_0=0.5}');
      expect(r.line).not.toContain('MORE_THAN1');
      expect(r.warnings.some(w => w.includes('upstream bug'))).toBe(true);
      expect(componentsForCV(x, CV_DEFS, { version })).toEqual(['_morethan']);
    }
  });

  test('LESS_THAN, 2.9, and angles without SWITCH keep their numbered blocks', async () => {
    const x = await cv('2.11', 'ANGLES', 'x', {
      MEAN: false, LESS_THAN: '{RATIONAL R_0=0.5}; {RATIONAL R_0=0.8}', SWITCH: '', GROUP: '1-5', GROUPA: '', GROUPB: ''
    });
    expect(weightedAngleShortcut(x, CV_DEFS.ANGLES, '2.11')).toBe(false);
    expect(componentsForCV(x, CV_DEFS, { version: '2.11' })).toEqual(['_lessthan-1', '_lessthan-2']);
    const old = await cv('2.9', 'ANGLES', 'x', { MEAN: false, MORE_THAN: '{RATIONAL R_0=0.5}; {RATIONAL R_0=0.8}' });
    expect(buildCVLine(old, CV_DEFS, { version: '2.9' }).line).toContain('MORE_THAN2=');
  });
});

describe('help that said the wrong thing (#4, #15, #23)', () => {
  test('LAMBDA follows the mean-square displacement', () => {
    expect(KEY_HELP.LAMBDA).toContain('mean-square displacement');
    expect(KEY_HELP.LAMBDA).not.toMatch(/2\.3\/\(RMSD/);
  });

  test('COORDINATION has no linked cells', () => {
    const dmax = CV_DEFS.COORDINATION.fields.find(f => f.k === 'D_MAX');
    expect(dmax.help).toContain('no linked cells');
    expect(KEY_HELP.D_MAX).toContain('COORDINATION has no linked cells');
    const w = checkCV(createCV('COORDINATION', 1, { values: { GROUPA: '1-500', GROUPB: '501-1000', D_MAX: '0.6' } }));
    expect(w.some(x => x.includes('only truncates the switching function'))).toBe(true);
    // A handful of pairs is no reason to reach for a neighbour list.
    expect(checkCV(createCV('COORDINATION', 1)).some(x => x.includes('visits every'))).toBe(false);
  });

  test('an upper wall starts at AT - OFFSET, a lower one at AT + OFFSET', () => {
    const offset = (m) => BIAS_DEFS[m].params.find(p => p.k === 'OFFSET').help;
    expect(offset('upper')).toContain('AT − OFFSET');
    expect(offset('lower')).toContain('AT + OFFSET');
    expect(KEY_HELP.OFFSET).toContain('AT − OFFSET');
  });
});

describe('neighbour lists under metadynamics (#5, #51)', () => {
  test('NL_CUTOFF and NL_STRIDE are written whatever the bias', async () => {
    for (const method of ['metad', 'wt_metad', 'opes', 'none']) {
      const c = await cv('2.11', 'COORDINATION', 'c', { NLIST: true, NL_CUTOFF: '0.8', NL_STRIDE: '10' });
      const g = await gen('2.11', { cvs: [c], bias: { method, temp: '300', grid: true } });
      expect(g.cvLines[0]).toMatch(/NLIST NL_CUTOFF=0\.8 NL_STRIDE=10$/);
    }
  });
});

describe('ABMD names its components after the value (#6)', () => {
  test('from 2.10 cn.mean of a shortcut is the value cn_mean', async () => {
    const at = async (version) => {
      const g = await gen(version, { cvs: [await cv(version, 'COORDINATIONNUMBER', 'cn')], bias: { method: 'abmd' } });
      return g.printable;
    };
    expect(await at('2.9')).toContain('abmd.cn.mean_min');
    expect(await at('2.10')).toContain('abmd.cn_mean_min');
    expect(await at('2.11')).toContain('abmd.cn_mean_min');
    const p = await gen('2.11', { cvs: [await cv('2.11', 'PATHMSD', 'p')], bias: { method: 'abmd' } });
    expect(p.printable).toContain('abmd.p.sss_min');
  });
});

describe('forms PLUMED computes (#7, #8, #56)', () => {
  test('PLANE and DIHEDRAL_CORRELATION are written with ATOMS1', async () => {
    // The ATOMS= form aborts (PLANE) or segfaults (DIHEDRAL_CORRELATION) on
    // the first step of PLUMED 2.11.0-dev.
    const p = await cv('2.11', 'PLANE', 'p');
    expect(buildCVLine(p, CV_DEFS, { version: '2.11', syntax: await loadSyntax('2.11') }).line).toBe('p: PLANE ATOMS1=1,2,3');
    const d = await cv('2.11', 'DIHEDRAL_CORRELATION', 'd', { NOPBC: true });
    expect(buildCVLine(d, CV_DEFS, { version: '2.11' }).line).toBe('d: DIHEDRAL_CORRELATION ATOMS1=1,2,3,4,5,6,7,8 NOPBC');
    expect(checkCV({ ...p, values: { ATOMS: '1,2' } }).some(w => w.includes('takes 3 or 4 atoms'))).toBe(true);
  });

  test('the components of PLANE have a sign, and so does their grid', () => {
    expect(defaultBiasValues('PLANE', '.x')).toMatchObject({ min: '-1.0', max: '1.0' });
  });
});

describe('ERMSD (#9)', () => {
  test('has the atoms it needs and asks for MOLINFO', async () => {
    const e = await cv('2.11', 'ERMSD', 'e');
    expect(CV_DEFS.ERMSD.needsMolinfo).toBe(true);
    expect(buildCVLine(e, CV_DEFS, { version: '2.11', syntax: await loadSyntax('2.11') }).line)
      .toBe('e: ERMSD ATOMS=@lcs-1,@lcs-2,@lcs-3,@lcs-4 REFERENCE=ref.pdb CUTOFF=2.4');
  });
});

describe('PCARMSD components follow the eigenvectors in the file (#10)', () => {
  test('one per frame, counted from zero, and the count is not written', async () => {
    const one = await cv('2.11', 'PCARMSD', 'pca', { EIGENVECTORS: 'eigenvec1.pdb' });
    expect(componentsForCV(one)).toEqual(['.eig-0', '.residual']);
    expect(buildCVLine(one).line).toBe('pca: PCARMSD AVERAGE=average.pdb EIGENVECTORS=eigenvec1.pdb');
    one.values.__eigenvectors = '3';
    expect(componentsForCV(one)).toEqual(['.eig-0', '.eig-1', '.eig-2', '.residual']);
  });
});

describe('what a biased value is (#11, #12, #13, #14)', () => {
  test('only phs and phi of PUCKERING are periodic, each on its own period', () => {
    expect(valueDomain('PUCKERING', '.phs').periodic).toEqual(['-pi', 'pi']);
    expect(valueDomain('PUCKERING', '.phi').periodic).toEqual(['0', '2pi']);
    expect(valueDomain('PUCKERING', '.theta').periodic).toBeNull();
    expect(valueDomain('PUCKERING', '.amplitude').periodic).toBeNull();
    expect(defaultBiasValues('PUCKERING', '.phi')).toMatchObject({ min: '0', max: '2pi' });
    const x = createCV('PUCKERING', 1, { label: 'x' });
    const phi = { ...x, biasValues: { ...x.biasValues, ...defaultBiasValues('PUCKERING', '.phi') } };
    const ok = generatePlumedInput({ cvs: [phi], bias: { method: 'wt_metad', temp: '300', grid: true } });
    expect(ok.input).toContain('GRID_MIN=0\n');
    expect(ok.warnings.some(w => w.includes('periodic'))).toBe(false);
    const amp = { ...x, biasValues: { ...x.biasValues, comp: '.amplitude', min: '0', max: '0.3' } };
    expect(generatePlumedInput({ cvs: [amp], bias: { method: 'wt_metad', temp: '300', grid: true } })
      .warnings.some(w => w.includes('periodic'))).toBe(false);
  });

  test('TORSIONS counts torsions in a range; its grid runs from 0 to their number', () => {
    const atoms = 'ATOMS1=1,2,3,4 ATOMS2=5,6,7,8 ATOMS3=9,10,11,12 ATOMS4=13,14,15,16 ATOMS5=17,18,19,20';
    const t = createCV('TORSIONS', 1, { version: '2.11', label: 'x', values: { ATOMS: atoms } });
    expect(t.biasValues).toMatchObject({ comp: '_between', min: '0.0', max: '5' });
    const g = generatePlumedInput({ version: '2.11', cvs: [t], bias: { method: 'wt_metad', temp: '300', grid: true } });
    expect(g.warnings.some(w => /periodic|0\.\.pi/.test(w))).toBe(false);
    t.biasValues.max = '2';
    expect(generatePlumedInput({ version: '2.11', cvs: [t], bias: { method: 'wt_metad', temp: '300', grid: true } })
      .warnings.some(w => w.includes('counts up to 5'))).toBe(true);
    // A count of angles is no angle either.
    expect(valueDomain('ANGLES', '_morethan').angle).toBe(false);
    expect(valueDomain('ANGLES', '_mean').angle).toBe(true);
  });

  test('a periodic grid must read exactly as its period', () => {
    const phi = createCV('TORSION', 1, { label: 'phi' });
    phi.biasValues = { ...phi.biasValues, min: '-3.14159265', max: '3.14159265' };
    const g = generatePlumedInput({ cvs: [phi], bias: { method: 'wt_metad', temp: '300', grid: true } });
    expect(g.warnings.some(w => w.includes('read exactly as its period'))).toBe(true);
    // OPES has no grid, so there is nothing to check.
    expect(generatePlumedInput({ cvs: [phi], bias: { method: 'opes', temp: '300', grid: true } })
      .warnings.some(w => w.includes('period'))).toBe(false);
  });

  test('a function declared periodic is checked against its PERIODIC', () => {
    const a = createCV('TORSION', 1, { label: 'phi' });
    const b = createCV('TORSION', 2, { label: 'psi', values: { ATOMS: '2,3,4,5' } });
    a.bias = false; b.bias = false;
    const f = createFunction('COMBINE', 1, { label: 'dphi', args: ['phi', 'psi'], values: { COEFFICIENTS: '1,-1', PERIODIC: '-pi,pi' } });
    f.bias = true;
    const cfg = { cvs: [a, b], functions: [f], bias: { method: 'wt_metad', temp: '300', grid: true } };
    expect(generatePlumedInput(cfg).warnings.some(w => w.includes('`dphi` is periodic on `-pi..pi`'))).toBe(true);
    f.biasValues = { ...f.biasValues, min: '-pi', max: 'pi' };
    expect(generatePlumedInput(cfg).warnings.some(w => w.includes('periodic'))).toBe(false);
  });

  test('TETRAHEDRAL reaches 8/sqrt(3) = 4.62 for a perfect tetrahedron', () => {
    const t = createCV('TETRAHEDRAL', 1, { label: 't' });
    expect(t.biasValues).toMatchObject({ min: '-5.0', max: '5.0' });
    const g = generatePlumedInput({ cvs: [t], bias: { method: 'wt_metad', temp: '300', grid: true } });
    expect(g.warnings.some(w => w.includes('normally lies in'))).toBe(false);
    // Q6 still lies in 0..1.
    const q = createCV('Q6', 1, { label: 'q' });
    q.biasValues.max = '5';
    expect(generatePlumedInput({ cvs: [q], bias: { method: 'wt_metad', temp: '300', grid: true } })
      .warnings.some(w => w.includes('normally lies in `0..1`'))).toBe(true);
  });
});

describe('a CV the target cannot write (#17, #55)', () => {
  test('a hint about older releases is never written as an action', async () => {
    expect(resolveAction('COORD_ANGLES', CV_DEFS.COORD_ANGLES, '2.9').available).toBe(false);
    expect(resolveAction('X', { minVersion: '2.10', fallback: 'ANGLES with GROUP' }, '2.9').available).toBe(false);
    expect(resolveAction('X', { minVersion: '2.10', fallback: 'DIHCOR' }, '2.9').action).toBe('DIHCOR');
  });

  test('it is left out of PRINT and the bias as well as the CV lines', async () => {
    const s11 = await loadSyntax('2.11');
    const a = createCV('COORD_ANGLES', 1, { version: '2.11', syntax: s11, label: 'ca' });
    const b = createCV('TETRA_RADIAL', 2, { version: '2.11', syntax: s11, label: 'tr' });
    const p = createCV('PLANES', 3, { version: '2.11', syntax: s11, label: 'pl' });
    const d = createCV('DISTANCE', 4, { version: '2.11', syntax: s11, label: 'd' });
    const g = await gen('2.9', { cvs: [a, b, p, d], bias: { method: 'wt_metad', temp: '300', grid: true } });
    const body = lines(g).join('\n');
    expect(body).not.toMatch(/\bca\b|\btr\b|\bpl_/);
    expect(body).not.toContain('with GROUP');
    expect(body).toContain('PRINT ARG=d,metad.bias');
    expect(text(g.warnings).some(w => w.includes('In PLUMED 2.9 write ANGLES with GROUPA, GROUPB and SWITCH instead'))).toBe(true);
    expect(availableArguments({ version: '2.9', cvs: [a, d] }).map(x => x.arg)).toEqual(['d']);
  });
});

describe('small fixes to what is written (#18, #19, #21, #22, #43, #49)', () => {
  test('one number in VALUES is a plain value in 2.9', () => {
    const k = createCV('CONSTANT', 1, { version: '2.9', label: 'c', values: { VALUES: '5.0' } });
    expect(componentsForCV(k, CV_DEFS, { version: '2.9' })).toEqual([]);
    expect(generatePlumedInput({ version: '2.9', cvs: [k], bias: { method: 'none' } }).input)
      .toContain('PRINT ARG=c FILE=COLVAR');
  });

  test('MASS and CHARGE are not bias targets', () => {
    expect(createCV('MASS', 1, { version: '2.11' }).bias).toBe(false);
    expect(createCV('CHARGE', 1, { version: '2.11' }).bias).toBe(false);
  });

  test('a variable named like the bias line is a duplicate label', () => {
    const d = createCV('DISTANCE', 1, { label: 'metad' });
    const g = generatePlumedInput({ cvs: [d], bias: { method: 'wt_metad', temp: '300', grid: true } });
    expect(g.warnings.some(w => w.includes('Duplicate label "metad"'))).toBe(true);
    expect(generatePlumedInput({ cvs: [d], bias: { method: 'wt_metad', temp: '300', grid: true, params: { LABEL: 'mtd' } } })
      .warnings.some(w => w.includes('Duplicate label'))).toBe(false);
  });

  test('EEFSOLV starts with the heavy atoms of the MOLINFO structure', () => {
    expect(createCV('EEFSOLV', 1).values.ATOMS).toBe('@nonhydrogens');
  });

  test('OPES writes its state at a stride of its own, a hundred kernels by default', () => {
    const d = createCV('DISTANCE', 1, { label: 'd' });
    const g = generatePlumedInput({ cvs: [d], bias: { method: 'opes', temp: '300', params: { PACE: '100', BARRIER: '15' } } });
    expect(g.input).toMatch(/STATE_WSTRIDE=10000\b/);
    expect(g.input).not.toContain('checkpoint of the MD engine');
    const run = generatePlumedInput({ cvs: [d], bias: { method: 'opes', temp: '300', stateStride: 12500 } });
    expect(run.input).toMatch(/STATE_WSTRIDE=12500\b/);
  });

  test('a range that runs down takes a negative stride', () => {
    expect(parseAtomList('10-1:-3').indices).toEqual([10, 7, 4, 1]);
    expect(parseAtomList('10-1:-3').errors).toEqual([]);
    expect(checkCV({ type: 'TORSION', label: 't', values: { ATOMS: '10-1:-3' } }, undefined, { natoms: 760 })).toEqual([]);
    expect(parseAtomList('10-1').errors[0]).toContain('negative stride');
    expect(parseAtomList('1-10:-3').errors).toHaveLength(1);
  });
});

describe('the bias keeps its label and its files', () => {
  test('LABEL and FILE are parameters the page carries', () => {
    expect(BIAS_DEFS.wt_metad.params.find(p => p.k === 'FILE').def).toBe('HILLS');
    expect(biasLabelFor('wt_metad', {}, '')).toBe('metad');
    expect(biasLabelFor('wt_metad', { LABEL: 'mtd' })).toBe('mtd');
    const r = buildBiasLine('restraint', [{ arg: 'd', label: 'd' }], { LABEL: 'r', AT: '1', KAPPA: '10' }, { grid: false });
    expect(r.lines[0]).toMatch(/^r: RESTRAINT /);
    expect(r.components).toEqual(['r.bias']);
  });

  test('PRINT keeps a number format', () => {
    const d = createCV('DISTANCE', 1, { label: 'd' });
    const g = generatePlumedInput({ cvs: [d], bias: { method: 'none' }, prints: [{ file: 'C', stride: 1, fmt: '%10.5f' }] });
    expect(g.input).toContain('PRINT ARG=d FILE=C STRIDE=1 FMT=%10.5f');
  });
});

describe('INPLANEDISTANCES', () => {
  test('counts atoms in a cylinder, and PLUMED 2.9 is warned about', () => {
    const i = createCV('INPLANEDISTANCES', 1, { version: '2.11', label: 'i' });
    expect(i.values.LESS_THAN).toBe('{RATIONAL R_0=0.5 D_MAX=1.0}');
    expect(i.values.MEAN).toBeFalsy();
    expect(checkCV(i, CV_DEFS, { version: '2.9' }).some(w => w.includes('PLUMED 2.9 can abort'))).toBe(true);
    expect(checkCV(i, CV_DEFS, { version: '2.11' })).toEqual([]);
  });
});
