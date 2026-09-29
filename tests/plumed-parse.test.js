import { describe, test, expect } from '@jest/globals';
import {
  stripComment, splitWords, splitKeyword, parsePlumedInput, keywordValue, hasFlag,
  resolveReference, lintPlumedInput, editDistance, explainPlumedInput, importPlumedInput
} from '../src/core/plumed-parse.js';
import { generatePlumedInput } from '../src/core/plumed.js';
import { loadSyntax } from '../src/core/plumed-syntax.js';

/* Modelled on the urea nucleation input of arXiv:2210.04822. */
const NUCLEATION = `
# Restart simulation
#RESTART

LOAD FILE=PairEntropy.cpp
LOAD FILE=ManyAngle.cpp

INCLUDE FILE=centers.dat
C: GROUP ATOMS=1-2400:8
O: GROUP ATOMS=2-2400:8

MANY_ANGLE ...
 LABEL=ma1
 CENTER=C
 START=Ncenter
 END=O
 RCUT=1.0
 NOPBC
 MEAN
 MOMENT2
... MANY_ANGLE

COORDINATIONNUMBER ...
 LABEL=cn SPECIES=Ncenter
 SWITCH={RATIONAL R_0=0.6 D_MAX=0.8}
 MORE_THAN1={RATIONAL R_0=8.0 D_MAX=9.0}
 MORE_THAN2={RATIONAL R_0=11.0 D_MAX=12.0}
 MOMENTS=2
 LOWMEM
... COORDINATIONNUMBER

PAIRENTROPY ...
 LABEL=s
 ATOMS=C
 MAXR=0.6
 SIGMA=0.05
... PAIRENTROPY

l1_1: COMBINE ARG=ma1.mean,ma1.moment2,cn.morethan-1,cn.morethan-2,cn.moment-2,s COEFFICIENTS=1.19,0.035,0.0026,0.011,-0.02,0.14 PERIODIC=NO
l1r_1: MATHEVAL ARG=l1_1 FUNC=x+2.238606452942 PERIODIC=NO

METAD ...
LABEL=metad
ARG=l1r_1 SIGMA=0.2 HEIGHT=10 BIASFACTOR=150 TEMP=300.0 PACE=2000
GRID_MIN=-5 GRID_MAX=5 GRID_BIN=1000
CALC_RCT
... METAD

PRINT ARG=ma1.mean,ma1.moment2,cn.morethan-1,cn.morethan-2,cn.moment-2,s,l1r_1,metad.bias,metad.rbias STRIDE=500 FILE=COLVAR
`;

describe('words', () => {
  test('a comment runs to the end of the line', () => {
    expect(stripComment('d: DISTANCE ATOMS=1,2 # the pair')).toEqual({
      code: 'd: DISTANCE ATOMS=1,2 ', comment: 'the pair'
    });
    expect(stripComment('no comment')).toEqual({ code: 'no comment', comment: '' });
    expect(stripComment(null)).toEqual({ code: '', comment: '' });
  });

  test('braces keep a value together, and may nest', () => {
    expect(splitWords('A SWITCH={RATIONAL R_0=0.3 NN=6} B').words)
      .toEqual(['A', 'SWITCH={RATIONAL R_0=0.3 NN=6}', 'B']);
    expect(splitWords('X={a {b c} d}').words).toEqual(['X={a {b c} d}']);
    expect(splitWords('  ').words).toEqual([]);
  });

  test('reports braces that do not match', () => {
    expect(splitWords('X={a b').unbalanced).toBe(true);
    expect(splitWords('X=a}').unbalanced).toBe(true);
    expect(splitWords('X={a}').unbalanced).toBe(false);
  });

  test('a keyword is a flag or a key and a value', () => {
    expect(splitKeyword('NOPBC')).toEqual({ key: 'NOPBC', value: null, braced: false });
    expect(splitKeyword('ATOMS=1,2')).toEqual({ key: 'ATOMS', value: '1,2', braced: false });
    expect(splitKeyword('SWITCH={RATIONAL R_0=0.3}'))
      .toEqual({ key: 'SWITCH', value: 'RATIONAL R_0=0.3', braced: true });
    expect(splitKeyword('FUNC=x=y')).toMatchObject({ key: 'FUNC', value: 'x=y' });
  });
});

describe('parsePlumedInput', () => {
  test('reads both ways of labelling', () => {
    const { actions, errors } = parsePlumedInput('d1: DISTANCE ATOMS=1,2\nDISTANCE ATOMS=3,4 LABEL=d2');
    expect(errors).toEqual([]);
    expect(actions.map(a => [a.label, a.action, a.line])).toEqual([
      ['d1', 'DISTANCE', 1], ['d2', 'DISTANCE', 2]
    ]);
    expect(keywordValue(actions[1], 'ATOMS')).toBe('3,4');
    expect(actions[1].keywords.some(k => k.key === 'LABEL')).toBe(false);
  });

  test('reads a block over several lines', () => {
    const { actions, errors } = parsePlumedInput(
      'METAD ...\n LABEL=m # the bias\n ARG=d1\n\n SIGMA=0.1 CALC_RCT\n... METAD\nPRINT ARG=d1');
    expect(errors).toEqual([]);
    expect(actions[0]).toMatchObject({ label: 'm', action: 'METAD', line: 1, endLine: 6, block: true });
    expect(hasFlag(actions[0], 'CALC_RCT')).toBe(true);
    expect(actions[1]).toMatchObject({ action: 'PRINT', line: 7 });
  });

  test('a labelled block closes with the dots alone, or with its first word', () => {
    expect(parsePlumedInput('m: METAD ...\n ARG=d\n...').errors).toEqual([]);
    expect(parsePlumedInput('m: METAD ...\n ARG=d\n... m:').errors).toEqual([]);
    const bad = parsePlumedInput('m: METAD ...\n ARG=d\n... METAD');
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]).toMatchObject({ line: 3 });
    expect(bad.errors[0].text).toContain('must repeat the first word');
  });

  test('a block that is never closed, and dots with no block', () => {
    expect(parsePlumedInput('METAD ...\n ARG=d').errors[0].text).toContain('never closed');
    expect(parsePlumedInput('... METAD').errors[0].text).toContain('no block is open');
  });

  test('a brace may stay open over several lines', () => {
    const { actions, errors } = parsePlumedInput('c: COORDINATION ...\nGROUPA={\n1\n2\n}\nR_0=0.3\n...');
    expect(errors).toEqual([]);
    expect(keywordValue(actions[0], 'GROUPA')).toBe('1 2');
    const bare = parsePlumedInput('g: GROUP ATOMS={1\n2 3}\nd: DISTANCE ATOMS=1,2');
    expect(bare.errors).toEqual([]);
    expect(bare.actions).toHaveLength(2);
  });

  test('names and keywords may be written in either case', () => {
    const { actions, errors } = parsePlumedInput('angle atoms=2,6,3 label=ang1');
    expect(errors).toEqual([]);
    expect(actions[0]).toMatchObject({ action: 'ANGLE', label: 'ang1' });
    expect(keywordValue(actions[0], 'ATOMS')).toBe('2,6,3');
  });

  test('stops at ENDPLUMED', () => {
    const r = parsePlumedInput('d: DISTANCE ATOMS=1,2\nENDPLUMED\nthis is not read');
    expect(r.actions).toHaveLength(1);
    expect(r.ended).toBe(2);
  });

  test('keeps the comments above an action', () => {
    const { actions } = parsePlumedInput('# end to end\n# of the chain\nd: DISTANCE ATOMS=1,2\n\n# lost\n\nPRINT ARG=d');
    expect(actions[0].comments).toEqual(['end to end', 'of the chain']);
    expect(actions[1].comments).toEqual([]);
  });

  test('reports a double label and a missing action', () => {
    expect(parsePlumedInput('d: DISTANCE ATOMS=1,2 LABEL=e').errors[0].text).toContain('labelled twice');
    expect(parsePlumedInput('d:').errors[0].text).toContain('not followed by an action');
    expect(parsePlumedInput('1DIST ATOMS=1,2').errors[0].text).toContain('cannot be an action name');
  });

  test('handles nothing at all', () => {
    expect(parsePlumedInput('').actions).toEqual([]);
    expect(parsePlumedInput(null).actions).toEqual([]);
    expect(parsePlumedInput('d: DISTANCE ATOMS=1,2\r\nPRINT ARG=d\r\n').actions).toHaveLength(2);
  });
});

describe('resolveReference', () => {
  const labels = new Set(['cn', 'd', 'pamm']);
  test('finds the action a value belongs to', () => {
    expect(resolveReference('d', labels)).toBe('d');
    expect(resolveReference('cn.morethan-1', labels)).toBe('cn');
    expect(resolveReference('cn_mean', labels)).toBe('cn');
    expect(resolveReference('pamm-1_mean', labels)).toBe('pamm');
  });
  test('returns null for something undefined', () => {
    expect(resolveReference('x.mean', labels)).toBeNull();
    expect(resolveReference('dist', labels)).toBeNull();
    expect(resolveReference('', labels)).toBeNull();
  });
});

describe('lintPlumedInput', () => {
  const texts = (r, level) => r.issues.filter(i => !level || i.level === level).map(i => i.text);

  test('a sound input has no errors or warnings', async () => {
    const syntax = await loadSyntax('2.9');
    const r = lintPlumedInput(
      'phi: TORSION ATOMS=5,7,9,15\npsi: TORSION ATOMS=7,9,15,17\n' +
      'metad: METAD ARG=phi,psi SIGMA=0.35,0.35 HEIGHT=1.2 PACE=500 BIASFACTOR=10 TEMP=300 ' +
      'GRID_MIN=-pi,-pi GRID_MAX=pi,pi GRID_BIN=200,200\n' +
      'PRINT ARG=phi,psi,metad.bias STRIDE=500 FILE=COLVAR', { syntax, natoms: 22 });
    expect(r.issues).toEqual([]);
    expect(r.summary).toEqual({ actions: 4, errors: 0, warnings: 0, notes: 0 });
  });

  test('the published nucleation input is sound', async () => {
    const r = lintPlumedInput(NUCLEATION, { syntax: await loadSyntax('2.9'), natoms: 11655 });
    expect(r.summary.errors).toBe(0);
    expect(r.summary.warnings).toBe(0);
    expect(texts(r, 'note').some(t => t.includes('`MANY_ANGLE` is not part of PLUMED 2.9'))).toBe(true);
  });

  test('an unknown action, with a suggestion when one is near', async () => {
    const syntax = await loadSyntax('2.10');
    const typo = lintPlumedInput('d: DISTANSE ATOMS=1,2', { syntax });
    expect(typo.issues[0]).toMatchObject({ level: 'error', line: 1 });
    expect(typo.issues[0].text).toContain('Did you mean `DISTANCE`?');
    const far = lintPlumedInput('d: SOMETHING_ELSE ATOMS=1,2', { syntax });
    expect(far.issues[0].level).toBe('warning');
    // A LOAD file explains a name that is new, not one that is a letter off.
    const loaded = lintPlumedInput('LOAD FILE=a.cpp\nd: DISTANSE ATOMS=1,2\ne: MANY_ANGLE CENTER=1-9', { syntax });
    expect(loaded.issues.map(i => i.level)).toEqual(['error', 'note']);
  });

  test('an unknown keyword, and numbered ones that are known', async () => {
    const syntax = await loadSyntax('2.10');
    const r = lintPlumedInput('d: DISTANCE ATOM=1,2', { syntax });
    expect(texts(r, 'warning')[0]).toContain('Did you mean `ATOMS`?');
    const ok = lintPlumedInput(
      'c: COORDINATIONNUMBER SPECIES=1-10 SWITCH={RATIONAL R_0=0.3} MORE_THAN1={RATIONAL R_0=2} MORE_THAN2={RATIONAL R_0=4}',
      { syntax });
    expect(texts(ok, 'warning')).toEqual([]);
  });

  test('a keyword one release has and another lacks', async () => {
    const line = 'k: CONSTANT VALUE=1.0 NODERIV';
    expect(lintPlumedInput(line, { syntax: await loadSyntax('2.9') }).summary.warnings).toBe(0);
    expect(lintPlumedInput(line, { syntax: await loadSyntax('2.10') }).summary.warnings).toBe(1);
  });

  test('a flag given a value, a value missing', async () => {
    const syntax = await loadSyntax('2.10');
    expect(texts(lintPlumedInput('d: DISTANCE ATOMS=1,2 NOPBC=yes', { syntax }))[0]).toContain('is a flag');
    expect(texts(lintPlumedInput('d: DISTANCE ATOMS', { syntax }))[0]).toContain('needs a value');
  });

  test('labels: twice, with a dot', () => {
    const r = lintPlumedInput('d: DISTANCE ATOMS=1,2\nd: DISTANCE ATOMS=3,4\na.b: DISTANCE ATOMS=1,2');
    expect(texts(r, 'error').some(t => t.includes('used twice, first on line 1'))).toBe(true);
    expect(texts(r, 'error').some(t => t.includes('contains a dot'))).toBe(true);
  });

  test('an argument nothing defines, or defined too late', () => {
    const missing = lintPlumedInput('d: DISTANCE ATOMS=1,2\nPRINT ARG=d,e FILE=C STRIDE=10');
    expect(texts(missing, 'error')).toEqual(['`PRINT` uses `e`, which nothing in the file defines.']);
    const late = lintPlumedInput('PRINT ARG=d FILE=C STRIDE=10\nd: DISTANCE ATOMS=1,2');
    expect(texts(late, 'error')[0]).toContain('only defined on line 2');
  });

  test('wildcards and included files are trusted', () => {
    expect(lintPlumedInput('m: METAD ARG=d SIGMA=1 PACE=1 HEIGHT=1\nPRINT ARG=m.*,* FILE=C STRIDE=1')
      .issues.filter(i => i.text.includes('m.*'))).toEqual([]);
    const inc = lintPlumedInput('INCLUDE FILE=cvs.dat\nPRINT ARG=d FILE=C STRIDE=10');
    expect(inc.summary.errors).toBe(0);
  });

  test('atoms: zero, beyond the system, an undefined group', async () => {
    const syntax = await loadSyntax('2.10');
    expect(texts(lintPlumedInput('d: DISTANCE ATOMS=0,1', { syntax }))[0]).toContain('counts atoms from 1');
    expect(texts(lintPlumedInput('d: DISTANCE ATOMS=1,500', { syntax, natoms: 100 }))[0])
      .toContain('names atom 500, but the system has 100 atoms');
    expect(texts(lintPlumedInput('d: DISTANCE ATOMS=1-2400:8', { syntax, natoms: 2400 }))).toEqual([]);
    expect(texts(lintPlumedInput('d: DISTANCE ATOMS=c1,2', { syntax }))[0]).toContain('not a group or a centre');
    expect(texts(lintPlumedInput('c1: CENTER ATOMS=1-5\nd: DISTANCE ATOMS=c1,20', { syntax }))).toEqual([]);
  });

  test('an @ selection needs MOLINFO', async () => {
    const syntax = await loadSyntax('2.10');
    expect(texts(lintPlumedInput('t: TORSION ATOMS=@phi-2', { syntax }))[0]).toContain('needs a `MOLINFO`');
    expect(texts(lintPlumedInput('MOLINFO STRUCTURE=a.pdb\nt: TORSION ATOMS=@phi-2', { syntax }), 'error')).toEqual([]);
  });

  test('one value per argument', () => {
    const r = lintPlumedInput(
      'a: DISTANCE ATOMS=1,2\nb: DISTANCE ATOMS=3,4\n' +
      'm: METAD ARG=a,b SIGMA=0.1 HEIGHT=1 PACE=500 GRID_MIN=0,0 GRID_MAX=3,3\n' +
      'f: COMBINE ARG=a,b COEFFICIENTS=1,2,3 PERIODIC=NO');
    const e = texts(r, 'error');
    expect(e.some(t => t.includes('`METAD` has 2 arguments but `SIGMA` has 1 value'))).toBe(true);
    expect(e.some(t => t.includes('`COMBINE` has 2 arguments but `COEFFICIENTS` has 3 values'))).toBe(true);
  });

  test('adaptive hills take one width', () => {
    const r = lintPlumedInput('a: DISTANCE ATOMS=1,2\nb: DISTANCE ATOMS=3,4\n' +
      'm: METAD ARG=a,b ADAPTIVE=GEOM SIGMA=0.1 HEIGHT=1 PACE=500');
    expect(texts(r, 'error')).toEqual([]);
  });

  test('metadynamics: grid, bias factor, walkers', () => {
    const base = 'a: DISTANCE ATOMS=1,2\n';
    const t = (line) => texts(lintPlumedInput(`${base}m: METAD ARG=a SIGMA=0.1 HEIGHT=1 PACE=500 ${line}`));
    expect(t('GRID_MIN=0').some(x => x.includes('both `GRID_MIN` and `GRID_MAX`'))).toBe(true);
    expect(t('GRID_MIN=3 GRID_MAX=0').some(x => x.includes('is not above'))).toBe(true);
    expect(t('').some(x => x.includes('has no grid'))).toBe(true);
    expect(t('GRID_MIN=0 GRID_MAX=3 GRID_BIN=10').some(x => x.includes('use at least 60 bins'))).toBe(true);
    expect(t('BIASFACTOR=1').some(x => x.includes('must be larger than 1'))).toBe(true);
    expect(t('BIASFACTOR=10').some(x => x.includes('without `TEMP`'))).toBe(true);
    expect(t('CALC_RCT').some(x => x.includes('needs the bias on a grid'))).toBe(true);
    expect(t('WALKERS_N=4 WALKERS_ID=4').some(x => x.includes('must be below'))).toBe(true);
    expect(t('WALKERS_N=4 WALKERS_MPI').some(x => x.includes('Keep one'))).toBe(true);
  });

  test('setup actions come first', () => {
    const r = lintPlumedInput('d: DISTANCE ATOMS=1,2\nUNITS LENGTH=A');
    expect(texts(r, 'error')[0]).toContain('must come before every other action');
    expect(lintPlumedInput('MOLINFO STRUCTURE=a.pdb\nUNITS LENGTH=A').summary.errors).toBe(0);
    expect(lintPlumedInput('d: DISTANCE ATOMS=1,2\nLOAD FILE=a.cpp').summary.errors).toBe(0);
  });

  test('a cutoff that reads as reduced units', () => {
    const r = lintPlumedInput('c: COORDINATION GROUPA=1-10 GROUPB=11-20 SWITCH={RATIONAL R_0=3.0 D_MAX=6.0}');
    expect(texts(r, 'note').some(t => t.includes('reduced'))).toBe(true);
    const ang = lintPlumedInput('UNITS LENGTH=A\nc: COORDINATION GROUPA=1-10 GROUPB=11-20 SWITCH={RATIONAL R_0=3.0 D_MAX=6.0}');
    expect(texts(ang, 'note').some(t => t.includes('reduced'))).toBe(false);
    const thr = lintPlumedInput('c: COORDINATIONNUMBER SPECIES=1-10 SWITCH={RATIONAL R_0=0.3} MORE_THAN={RATIONAL R_0=8.0}');
    expect(texts(thr, 'note').some(t => t.includes('reduced'))).toBe(false);
  });

  test('functions need PERIODIC', () => {
    expect(texts(lintPlumedInput('a: DISTANCE ATOMS=1,2\nf: CUSTOM ARG=a FUNC=x'), 'error')[0])
      .toContain('needs `PERIODIC`');
  });

  test('output: a stride, a file of its own, and something printed', () => {
    const r = lintPlumedInput('a: DISTANCE ATOMS=1,2\nPRINT ARG=a FILE=C\nPRINT ARG=a FILE=C STRIDE=5');
    expect(texts(r, 'note').some(t => t.includes('writes at every step'))).toBe(true);
    expect(texts(r, 'warning').some(t => t.includes('already writes to'))).toBe(true);
    const silent = lintPlumedInput('a: DISTANCE ATOMS=1,2\nm: METAD ARG=a SIGMA=0.1 HEIGHT=1 PACE=1 GRID_MIN=0 GRID_MAX=3');
    expect(texts(silent, 'note').some(t => t.includes('prints nothing'))).toBe(true);
  });

  test('names the module an action needs', async () => {
    const r = lintPlumedInput('q: Q6 SPECIES=1-64 SWITCH={RATIONAL R_0=0.3} MEAN', { syntax: await loadSyntax('2.10') });
    expect(texts(r, 'note').some(t => t.includes('**symfunc** module'))).toBe(true);
  });

  test('issues come in file order, errors first on a line', () => {
    const r = lintPlumedInput('PRINT ARG=x\nd: DISTANCE ATOMS=1,2\nd: DISTANCE ATOMS=1,2');
    const lines = r.issues.map(i => i.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(r.issues[0].level).toBe('error');
  });

  test('structure is checked even without a keyword table', () => {
    expect(lintPlumedInput('m: METAD ...\n ARG=d\n... METAD').summary.errors).toBeGreaterThan(0);
    expect(lintPlumedInput('').summary).toEqual({ actions: 0, errors: 0, warnings: 0, notes: 0 });
  });
});

describe('editDistance', () => {
  test('counts the edits between two words', () => {
    expect(editDistance('DISTANCE', 'DISTANCE')).toBe(0);
    expect(editDistance('DISTANSE', 'DISTANCE')).toBe(1);
    expect(editDistance('', 'ABC')).toBe(3);
    expect(editDistance('ATOM', 'ATOMS')).toBe(1);
  });
});

describe('explainPlumedInput', () => {
  test('says what each action does and who uses it', async () => {
    const e = explainPlumedInput(NUCLEATION, { syntax: await loadSyntax('2.9') });
    const by = Object.fromEntries(e.map(x => [x.label || `${x.action}@${x.line}`, x]));
    expect(by.C.summary).toContain('Names a list of atoms');
    expect(by.cn.outputs).toContain('`cn.morethan-1`');
    expect(by.cn.outputs).toContain('by `l1_1`');
    expect(by.metad.summary).toContain('Metadynamics');
    expect(by.metad.keywords.find(k => k.key === 'BIASFACTOR').meaning).toMatch(/bias factor/i);
    expect(by.ma1.summary).toContain('may come from a LOAD file');
    expect(by.metad.link).toContain('doc-v2.9');
    expect(by.metad).toMatchObject({ line: 42, endLine: 47 });
  });

  test('works without a table', () => {
    const e = explainPlumedInput('d: DISTANCE ATOMS=1,2\nPRINT ARG=d');
    expect(e).toHaveLength(2);
    expect(e[1].summary).toContain('Writes the listed values');
    expect(e[0].keywords[0]).toEqual({ key: 'ATOMS', value: '1,2', meaning: '' });
  });
});

describe('importPlumedInput', () => {
  test('carries a published input into the builder and back', async () => {
    const { config, notes, fields } = importPlumedInput(NUCLEATION);
    expect(notes).toEqual([]);
    expect(config.preamble).toMatchObject({ load: ['PairEntropy.cpp', 'ManyAngle.cpp'], include: ['centers.dat'] });
    expect(config.cvs.map(c => [c.label, c.type])).toEqual([
      ['C', 'GROUP'], ['O', 'GROUP'], ['ma1', 'CUSTOM'], ['cn', 'COORDINATIONNUMBER_ADV'], ['s', 'CUSTOM']
    ]);
    expect(config.cvs[2].values.__components).toBe('mean,moment2');
    expect(config.cvs[3].values).toMatchObject({
      SPECIES: 'Ncenter', R_0: '0.6', D_MAX: '0.8', MOMENTS: '2', LOWMEM: true,
      MORE_THAN: '{RATIONAL R_0=8.0 D_MAX=9.0}; {RATIONAL R_0=11.0 D_MAX=12.0}'
    });
    expect(config.functions.map(f => [f.label, f.type, f.bias])).toEqual([
      ['l1_1', 'COMBINE', false], ['l1r_1', 'CUSTOM', true]
    ]);
    expect(config.functions[1].biasValues).toMatchObject({ min: '-5', max: '5', bin: '1000', sigma: '0.2' });
    expect(config.bias).toMatchObject({ method: 'wt_metad', temp: '300.0', stride: '2000', grid: true, rct: true });
    expect(config.bias.params).toMatchObject({ HEIGHT: '10', BIASFACTOR: '150', PACE: '2000' });
    expect(fields).toMatchObject({ plumedBias: 'wt_metad', plumedTemp: '300.0', plumedRct: true });

    const out = generatePlumedInput({ ...config, version: '2.9' }).input;
    expect(out).toContain('ma1: MANY_ANGLE CENTER=C START=Ncenter END=O RCUT=1.0 NOPBC MEAN MOMENT2');
    expect(out).toContain('l1r_1: CUSTOM ARG=l1_1 FUNC=x+2.238606452942 PERIODIC=NO');
    expect(out).toContain('    ARG=l1r_1\n    PACE=2000\n    HEIGHT=10\n    SIGMA=0.2\n    BIASFACTOR=150\n    TEMP=300.0');
    expect(out).toContain(
      'PRINT ARG=ma1.mean,ma1.moment2,cn.morethan-1,cn.morethan-2,cn.moment-2,s,l1r_1,metad.bias,metad.rbias FILE=COLVAR STRIDE=500');

    // What is written back says the same thing as what was read.
    const again = importPlumedInput(out);
    expect(again.config.cvs.map(c => c.values)).toEqual(config.cvs.map(c => c.values));
    expect(again.config.functions.map(f => [f.args, f.values])).toEqual(config.functions.map(f => [f.args, f.values]));
    expect(lintPlumedInput(out, { syntax: await loadSyntax('2.9') }).summary.errors).toBe(0);
  });

  test('setup lines', () => {
    const { config, fields } = importPlumedInput(
      'RESTART\nUNITS LENGTH=A ENERGY=kcal/mol\nMOLINFO STRUCTURE=ref.pdb\n' +
      'WHOLEMOLECULES ENTITY0=1-100 ENTITY1=101-150\nd: DISTANCE ATOMS=1,2\nFLUSH STRIDE=1000\nPRINT ARG=d FILE=C STRIDE=50');
    expect(config.units).toEqual({ length: 'A', energy: 'kcal/mol', time: 'ps' });
    expect(config.preamble).toMatchObject({ restart: true, flush: '1000' });
    expect(config.whole).toMatchObject({ enabled: true, entities: '1-100\n101-150' });
    expect(fields).toMatchObject({ plumedUnitLength: 'A', plumedMolinfo: 'ref.pdb', plumedRestart: true });
    expect(config.prints).toEqual([{ file: 'C', stride: '50', extra: '', all: false, args: ['d'], only: true }]);
  });

  test('walls beside a bias become restraints, one per value', () => {
    const { config, notes } = importPlumedInput(
      'a: DISTANCE ATOMS=1,2\nb: DISTANCE ATOMS=3,4\n' +
      'm: METAD ARG=a SIGMA=0.1 HEIGHT=1.2 PACE=500 GRID_MIN=0 GRID_MAX=3\n' +
      'uw: UPPER_WALLS ARG=a,b AT=2.5,3.0 KAPPA=150\nlw: LOWER_WALLS ARG=a AT=0.2 KAPPA=100 EXP=4');
    expect(config.bias.method).toBe('metad');
    expect(config.restraints.map(r => [r.type, r.label, r.arg, r.at, r.kappa, r.exp])).toEqual([
      ['upper', 'uw_1', 'a', '2.5', '150', ''], ['upper', 'uw_2', 'b', '3.0', '150', ''],
      ['lower', 'lw', 'a', '0.2', '100', '4']
    ]);
    expect(notes.some(n => n.includes('split into one wall per value'))).toBe(true);
    expect(config.cvs.map(c => c.bias)).toEqual([true, false]);
  });

  test('a wall alone is the method', () => {
    const { config } = importPlumedInput('a: DISTANCE ATOMS=1,2\nuw: UPPER_WALLS ARG=a AT=2.5 KAPPA=150');
    expect(config.bias.method).toBe('upper');
    expect(config.bias.params).toMatchObject({ AT: '2.5', KAPPA: '150' });
    expect(config.restraints).toEqual([]);
  });

  test('biases the right component and keeps its grid', () => {
    const { config } = importPlumedInput(
      'q: Q6 SPECIES=1-64 SWITCH={RATIONAL R_0=0.3 D_MAX=0.6} MEAN\n' +
      'opes: OPES_METAD ARG=q.mean PACE=500 BARRIER=40 TEMP=300');
    expect(config.cvs[0]).toMatchObject({ type: 'Q6', bias: true });
    expect(config.cvs[0].values).toMatchObject({ R_0: '0.3', D_MAX: '0.6', MEAN: true });
    expect(config.cvs[0].biasValues.comp).toBe('.mean');
    expect(config.bias).toMatchObject({ method: 'opes', params: { BARRIER: '40', PACE: '500', TEMP: '300' } });
  });

  test('what the builder cannot hold stays as written', () => {
    const { config, notes } = importPlumedInput(
      'c: COORDINATION GROUPA=1-10 GROUPB=11-20 SWITCH={EXP R_0=0.3 D_0=0.1}\n' +
      'DUMPATOMS ATOMS=1-10 FILE=a.xyz STRIDE=100\n' +
      'm: METAD ARG=c SIGMA=0.1 HEIGHT=1 PACE=1 GRID_MIN=0 GRID_MAX=9 ACCELERATION TAU=5');
    expect(config.cvs[0]).toMatchObject({ type: 'CUSTOM', label: 'c', bias: true });
    expect(config.cvs[0].values.__raw).toBe('COORDINATION GROUPA=1-10 GROUPB=11-20 SWITCH={EXP R_0=0.3 D_0=0.1}');
    expect(config.cvs[1].values.__raw).toBe('DUMPATOMS ATOMS=1-10 FILE=a.xyz STRIDE=100');
    expect(notes.some(n => n.includes('had no label'))).toBe(true);
    expect(notes.some(n => n.includes('`ACCELERATION`') && n.includes('`TAU=5`'))).toBe(true);
  });

  test('numbered atoms of a family are kept together', () => {
    const { config } = importPlumedInput('t: XYTORSIONS ATOMS1=3,5 ATOMS2=1,2 BETWEEN={GAUSSIAN LOWER=0 UPPER=1 SMEAR=0.1}');
    expect(config.cvs[0]).toMatchObject({ type: 'XYTORSIONS' });
    expect(config.cvs[0].values).toMatchObject({
      __variant: 'XYTORSIONS', ATOMS: 'ATOMS1=3,5 ATOMS2=1,2', BETWEEN: '{GAUSSIAN LOWER=0 UPPER=1 SMEAR=0.1}'
    });
  });

  test('a second sampling method is kept, and said so', () => {
    const { config, notes } = importPlumedInput(
      'a: DISTANCE ATOMS=1,2\nm1: METAD ARG=a SIGMA=0.1 HEIGHT=1 PACE=1\nm2: METAD ARG=a SIGMA=0.2 HEIGHT=1 PACE=1 FILE=H2');
    expect(config.cvs.map(c => c.type)).toEqual(['DISTANCE', 'CUSTOM']);
    expect(notes.some(n => n.includes('one sampling method at a time'))).toBe(true);
  });

  test('an empty file gives an empty description', () => {
    const { config, notes } = importPlumedInput('');
    expect(config.cvs).toEqual([]);
    expect(config.bias.method).toBe('none');
    expect(config.prints).toHaveLength(1);
    expect(notes).toEqual([]);
  });
});
