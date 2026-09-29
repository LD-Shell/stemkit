import { describe, test, expect } from '@jest/globals';
import {
  PLUMED_VERSIONS, DEFAULT_PLUMED_VERSION, BIAS_REDUNDANCY, CV_DEFS, BIAS_DEFS,
  versionAtLeast, cvAvailable, fieldAvailable, resolveAction, actionNameFor,
  pushFieldToken, hiddenFieldsForBias, fieldsFor, reductionBlocks, expandMoments,
  componentsForCV, availableArguments, defaultBiasValues, createCV, createFunction,
  buildCVLine, buildSwitchBlock, rationalSwitch, buildFunctionLine, buildBiasLine,
  buildRestraintLine, buildPrintLine, validateLabels, parseAtomList, checkCV,
  generatePlumedInput, messageToHtml, messageToText
} from '../src/core/plumed.js';
import { loadSyntax } from '../src/core/plumed-syntax.js';

/* A catalogue mirroring the shape of the production one. */
const CAT = {
  DISTANCE: {
    cat: 'geometry',
    fields: [
      { k: 'ATOMS', type: 'atoms', def: '1,2', required: true },
      { k: 'COMPONENTS', type: 'flag', def: false },
      { k: 'NOPBC', type: 'flag', def: false }
    ]
  },
  TORSION: {
    cat: 'angles',
    fields: [{ k: 'ATOMS', type: 'atoms', def: '1,2,3,4', required: true }]
  },
  COORDINATION: {
    cat: 'contacts',
    fields: [
      { k: 'GROUPA', type: 'atoms', def: '1-10', required: true },
      { k: 'GROUPB', type: 'atoms', def: '11-20' },
      { k: 'SWITCH', type: 'text', def: '' },
      { k: 'NL_CUTOFF', type: 'num', def: '' },
      { k: 'NL_STRIDE', type: 'num', def: '' }
    ]
  },
  DIHEDRAL_CORRELATION: {
    cat: 'angles', minVersion: '2.10', fallback: 'DIHCOR',
    fields: [{ k: 'ATOMS', type: 'atoms', def: '1,2,3,4,5,6,7,8', required: true }]
  },
  FUTURE_CV: {
    cat: 'shape', minVersion: '2.11',
    fields: [{ k: 'ATOMS', type: 'atoms', def: '1-100' }]
  }
};

describe('versionAtLeast', () => {
  test('compares dotted versions numerically', () => {
    expect(versionAtLeast('2.10', '2.9')).toBe(true);
    expect(versionAtLeast('2.9', '2.10')).toBe(false);
  });

  test('does not compare versions as strings', () => {
    // Lexicographically "2.10" < "2.9"; numerically it is greater.
    expect(versionAtLeast('2.10', '2.9')).toBe(true);
  });

  test('treats an equal version as satisfying the requirement', () => {
    expect(versionAtLeast('2.9', '2.9')).toBe(true);
  });

  test('handles differing component counts', () => {
    expect(versionAtLeast('2.9.1', '2.9')).toBe(true);
    expect(versionAtLeast('2.9', '2.9.1')).toBe(false);
    expect(versionAtLeast('3', '2.10')).toBe(true);
  });
});

describe('cvAvailable and resolveAction', () => {
  test('a CV without a minimum version is always available', () => {
    expect(cvAvailable(CAT.DISTANCE, '2.9')).toBe(true);
  });

  test('a versioned CV is gated on the target', () => {
    expect(cvAvailable(CAT.DIHEDRAL_CORRELATION, '2.10')).toBe(true);
    expect(cvAvailable(CAT.DIHEDRAL_CORRELATION, '2.9')).toBe(false);
  });

  test('emits the modern action name on a new enough target', () => {
    const r = resolveAction('DIHEDRAL_CORRELATION', CAT.DIHEDRAL_CORRELATION, '2.10');
    expect(r.action).toBe('DIHEDRAL_CORRELATION');
    expect(r.usedFallback).toBe(false);
  });

  test('falls back to the older action name on an older target', () => {
    const r = resolveAction('DIHEDRAL_CORRELATION', CAT.DIHEDRAL_CORRELATION, '2.9');
    expect(r.action).toBe('DIHCOR');
    expect(r.usedFallback).toBe(true);
    expect(r.available).toBe(true);
  });

  test('reports a CV as unavailable when no fallback exists', () => {
    const r = resolveAction('FUTURE_CV', CAT.FUTURE_CV, '2.9');
    expect(r.available).toBe(false);
    expect(r.action).toBeNull();
  });

  test('uses an explicit act name when the catalogue provides one', () => {
    const def = { act: 'REAL_ACTION', fields: [] };
    expect(resolveAction('ALIAS', def, '2.9').action).toBe('REAL_ACTION');
  });
});

describe('pushFieldToken', () => {
  test('emits KEY=value for an ordinary field', () => {
    const parts = [];
    pushFieldToken(parts, { k: 'ATOMS', type: 'atoms' }, '1,2');
    expect(parts).toEqual(['ATOMS=1,2']);
  });

  test('emits a bare keyword for a truthy flag', () => {
    const parts = [];
    pushFieldToken(parts, { k: 'NOPBC', type: 'flag' }, true);
    expect(parts).toEqual(['NOPBC']);
  });

  test('emits nothing for a falsy flag', () => {
    const parts = [];
    pushFieldToken(parts, { k: 'NOPBC', type: 'flag' }, false);
    expect(parts).toEqual([]);
  });

  test('emits a brace block as KEY={...}', () => {
    const parts = [];
    pushFieldToken(parts, { k: 'SWITCH', type: 'text' }, '{RATIONAL R_0=0.3}');
    expect(parts).toEqual(['SWITCH={RATIONAL R_0=0.3}']);
  });

  test('passes a raw KEY=VALUE fragment through verbatim', () => {
    const parts = [];
    pushFieldToken(parts, { k: 'EXTRA', type: 'text' }, 'NN=6 MM=12');
    expect(parts).toEqual(['NN=6 MM=12']);
  });

  test('does not mistake a numeric list for a raw fragment', () => {
    const parts = [];
    pushFieldToken(parts, { k: 'AT', type: 'text' }, '1.5,2.5');
    expect(parts).toEqual(['AT=1.5,2.5']);
  });

  test('skips empty and undefined values', () => {
    const parts = [];
    pushFieldToken(parts, { k: 'A', type: 'num' }, '');
    pushFieldToken(parts, { k: 'B', type: 'num' }, undefined);
    pushFieldToken(parts, { k: 'C', type: 'num' }, '   ');
    expect(parts).toEqual([]);
  });

  test('skips a variant selector, which only chooses the action name', () => {
    const parts = [];
    pushFieldToken(parts, { k: '__variant', variant: true }, 'X');
    expect(parts).toEqual([]);
  });
});

describe('hiddenFieldsForBias', () => {
  test('hides neighbour-list keys for a biased CV under metadynamics', () => {
    const h = hiddenFieldsForBias({ type: 'COORDINATION', bias: true }, 'wt_metad', CAT);
    expect(h.has('NL_CUTOFF')).toBe(true);
    expect(h.has('NL_STRIDE')).toBe(true);
  });

  test('hides nothing for an unbiased CV', () => {
    const h = hiddenFieldsForBias({ type: 'COORDINATION', bias: false }, 'wt_metad', CAT);
    expect(h.size).toBe(0);
  });

  test('keeps the reductions under OPES, which may bias one of them', () => {
    const h = hiddenFieldsForBias({ type: 'COORDINATION', bias: true }, 'opes', CAT);
    expect(h.has('MORE_THAN')).toBe(false);
  });

  test('hides nothing under an unrecognised bias', () => {
    expect(hiddenFieldsForBias({ type: 'COORDINATION', bias: true }, 'none', CAT).size).toBe(0);
  });

  test('the redundancy map is declared for the documented methods', () => {
    expect(Object.keys(BIAS_REDUNDANCY)).toContain('wt_metad');
    expect(Object.keys(BIAS_REDUNDANCY)).toContain('metad');
  });
});

describe('buildCVLine', () => {
  test('builds a labelled action line', () => {
    const r = buildCVLine({ type: 'DISTANCE', label: 'd1', values: { ATOMS: '1,2' } }, CAT);
    expect(r.line).toBe('d1: DISTANCE ATOMS=1,2');
  });

  test('falls back to catalogue defaults for unset fields', () => {
    const r = buildCVLine({ type: 'TORSION', label: 'phi' }, CAT);
    expect(r.line).toContain('ATOMS=1,2,3,4');
  });

  test('includes flags only when enabled', () => {
    const on = buildCVLine({ type: 'DISTANCE', label: 'd', values: { NOPBC: true } }, CAT);
    expect(on.line).toContain('NOPBC');
    const off = buildCVLine({ type: 'DISTANCE', label: 'd', values: { NOPBC: false } }, CAT);
    expect(off.line).not.toContain('NOPBC');
  });

  test('emits the fallback action and warns on an older target', () => {
    const r = buildCVLine(
      { type: 'DIHEDRAL_CORRELATION', label: 'dc' }, CAT, { version: '2.9' }
    );
    expect(r.line).toContain('DIHCOR');
    expect(r.usedFallback).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test('refuses a CV unavailable on the target with no fallback', () => {
    const r = buildCVLine({ type: 'FUTURE_CV', label: 'x' }, CAT, { version: '2.9' });
    expect(r.line).toBeNull();
    expect(r.warnings[0]).toContain('2.11');
  });

  test('suppresses redundant keys for a biased CV', () => {
    const r = buildCVLine(
      { type: 'COORDINATION', label: 'cn', bias: true,
        values: { GROUPA: '1-10', NL_CUTOFF: '0.6' } },
      CAT, { biasMethod: 'wt_metad' }
    );
    expect(r.line).not.toContain('NL_CUTOFF');
  });

  test('keeps those keys for an unbiased CV', () => {
    const r = buildCVLine(
      { type: 'COORDINATION', label: 'cn', bias: false,
        values: { GROUPA: '1-10', NL_CUTOFF: '0.6' } },
      CAT, { biasMethod: 'wt_metad' }
    );
    expect(r.line).toContain('NL_CUTOFF=0.6');
  });

  test('warns when a required field is empty', () => {
    const r = buildCVLine({ type: 'DISTANCE', label: 'd', values: { ATOMS: '' } }, CAT);
    expect(r.warnings.some(w => w.includes('ATOMS'))).toBe(true);
  });

  test('reports an unknown CV type rather than emitting nonsense', () => {
    const r = buildCVLine({ type: 'NOT_A_CV', label: 'x' }, CAT);
    expect(r.line).toBeNull();
    expect(r.warnings[0]).toContain('Unknown CV type');
  });

  test('defaults the label to the lowercased type', () => {
    const r = buildCVLine({ type: 'DISTANCE', values: { ATOMS: '1,2' } }, CAT);
    expect(r.line.startsWith('distance:')).toBe(true);
  });
});

describe('buildSwitchBlock', () => {
  test('builds a rational switching block', () => {
    expect(buildSwitchBlock({ r0: 0.3, dmax: 1.0 }).block)
      .toBe('{RATIONAL R_0=0.3 D_MAX=1}');
  });

  test('includes non-default exponents and offset', () => {
    const b = buildSwitchBlock({ r0: 0.3, d0: 0.1, nn: 8, mm: 16, dmax: 1.0 }).block;
    expect(b).toContain('D_0=0.1');
    expect(b).toContain('NN=8');
    expect(b).toContain('MM=16');
  });

  test('omits the default exponent', () => {
    expect(buildSwitchBlock({ r0: 0.3, nn: 6, dmax: 1 }).block).not.toContain('NN=');
  });

  test('warns when D_MAX is absent, since it enables linked cells', () => {
    const r = buildSwitchBlock({ r0: 0.3 });
    expect(r.warnings.some(w => w.includes('D_MAX'))).toBe(true);
  });

  test('warns when D_MAX truncates a still-appreciable switch', () => {
    const r = buildSwitchBlock({ r0: 0.3, dmax: 0.35 });
    expect(r.warnings.some(w => w.includes('truncated'))).toBe(true);
  });

  test('accepts a comfortably large D_MAX without complaint', () => {
    expect(buildSwitchBlock({ r0: 0.3, dmax: 1.0 }).warnings).toEqual([]);
  });

  test('rejects a non-positive R_0', () => {
    expect(buildSwitchBlock({ r0: 0 }).block).toBe('');
    expect(buildSwitchBlock({}).warnings[0]).toContain('R_0');
  });
});

describe('buildBiasLine', () => {
  const cvs = [{ label: 'd1' }, { label: 'phi' }];

  test('builds a well-tempered metadynamics line', () => {
    const r = buildBiasLine('wt_metad', cvs, {
      sigma: '0.05,0.35', gridMin: '0,-pi', gridMax: '2,pi', gridBin: '200,200'
    });
    const block = r.lines.join('\n');
    expect(r.lines[0]).toBe('metad: METAD ...');
    expect(block).toContain('ARG=d1,phi');
    expect(block).toContain('BIASFACTOR=10');
    expect(block).toContain('GRID_MIN=0,-pi');
  });

  test('closes a labelled block with the dots alone', () => {
    // "label: METAD ..." ends with "...": PLUMED compares a word after the
    // dots with the first word of the block, which is the label.
    for (const m of ['metad', 'wt_metad', 'pbmetad', 'opes', 'moving']) {
      const r = buildBiasLine(m, cvs, { sigma: '0.05,0.35', at0: '1', at1: '2' });
      expect(r.lines[0]).toMatch(/^\w+: [A-Z_]+ \.\.\.$/);
      expect(r.lines[r.lines.length - 1]).toBe('...');
    }
  });

  test('omits the bias factor for non-tempered metadynamics', () => {
    const r = buildBiasLine('metad', cvs, { sigma: '0.05,0.35', gridMin: '0', gridMax: '2' });
    expect(r.lines.join('\n')).not.toContain('BIASFACTOR');
  });

  test('warns when SIGMA is unset', () => {
    const r = buildBiasLine('wt_metad', cvs, { gridMin: '0', gridMax: '2' });
    expect(r.warnings.some(w => w.includes('SIGMA'))).toBe(true);
  });

  test('warns when no grid bounds are given', () => {
    const r = buildBiasLine('wt_metad', cvs, { sigma: '0.05,0.35' });
    expect(r.warnings.some(w => w.includes('GRID_MIN'))).toBe(true);
  });

  test('builds an OPES line', () => {
    const r = buildBiasLine('opes', cvs, { barrier: 40 });
    expect(r.lines[0]).toContain('OPES_METAD');
    expect(r.lines.join('\n')).toContain('BARRIER=40');
    expect(r.lines.join('\n')).not.toContain('BIASFACTOR');
  });

  test('warns on a non-positive OPES barrier', () => {
    expect(buildBiasLine('opes', cvs, { barrier: 0 }).warnings.length).toBeGreaterThan(0);
  });

  test('builds restraint, wall, and steered lines', () => {
    expect(buildBiasLine('restraint', cvs, { at: '1.0,2.0' }).lines[0]).toContain('RESTRAINT');
    expect(buildBiasLine('upper', cvs, { at: '2.0' }).lines[0]).toContain('UPPER_WALLS');
    expect(buildBiasLine('lower', cvs, { at: '0.5' }).lines[0]).toContain('LOWER_WALLS');
    expect(buildBiasLine('moving', cvs, { at0: '1', at1: '3' }).lines[0])
      .toContain('MOVINGRESTRAINT');
  });

  test('warns when a bias is selected but nothing is biased', () => {
    const r = buildBiasLine('wt_metad', [], {});
    expect(r.lines).toEqual([]);
    expect(r.warnings[0]).toContain('no CV');
  });

  test('emits nothing for no bias', () => {
    expect(buildBiasLine('none', cvs, {}).lines).toEqual([]);
  });

  test('reports an unknown bias method', () => {
    expect(buildBiasLine('mystery', cvs, {}).warnings[0]).toContain('Unknown bias');
  });
});

describe('buildPrintLine', () => {
  test('prints every CV label', () => {
    expect(buildPrintLine([{ label: 'a' }, { label: 'b' }]))
      .toBe('PRINT ARG=a,b STRIDE=500 FILE=COLVAR');
  });

  test('appends extra arguments such as the bias', () => {
    expect(buildPrintLine([{ label: 'a' }], { extra: ['metad.bias'] }))
      .toContain('ARG=a,metad.bias');
  });

  test('honours a custom stride and file', () => {
    const l = buildPrintLine([{ label: 'a' }], { stride: 100, file: 'OUT' });
    expect(l).toContain('STRIDE=100');
    expect(l).toContain('FILE=OUT');
  });

  test('returns an empty string when there is nothing to print', () => {
    expect(buildPrintLine([])).toBe('');
    expect(buildPrintLine(null)).toBe('');
  });
});

describe('validateLabels', () => {
  test('accepts valid identifiers', () => {
    expect(validateLabels([{ label: 'd1' }, { label: 'phi_2' }])).toEqual([]);
  });

  test('rejects duplicates, which PLUMED will not accept', () => {
    const w = validateLabels([{ label: 'd1' }, { label: 'd1' }]);
    expect(w.some(x => x.includes('Duplicate'))).toBe(true);
  });

  test('rejects a leading digit', () => {
    expect(validateLabels([{ label: '2bad' }]).length).toBeGreaterThan(0);
  });

  test('rejects a dot, which reads as a component reference', () => {
    const w = validateLabels([{ label: 'has.dot' }]);
    expect(w.some(x => x.includes('component reference'))).toBe(true);
  });

  test('reports a missing label', () => {
    expect(validateLabels([{}]).length).toBeGreaterThan(0);
  });

  test('handles non-array input', () => {
    expect(validateLabels(null)).toEqual([]);
  });
});

describe('generatePlumedInput', () => {
  const config = {
    cvs: [
      { type: 'DISTANCE', label: 'd1', values: { ATOMS: '1,2' }, bias: true },
      { type: 'TORSION', label: 'phi', values: { ATOMS: '5,7,9,15' }, bias: true }
    ],
    biasMethod: 'wt_metad',
    biasParams: {
      sigma: '0.05,0.35', gridMin: '0,-pi', gridMax: '2,pi', gridBin: '200,200'
    },
    catalogue: CAT,
    version: '2.9'
  };

  test('emits CV lines before the bias line', () => {
    const { input } = generatePlumedInput(config);
    expect(input.indexOf('d1: DISTANCE')).toBeLessThan(input.indexOf('METAD'));
  });

  test('emits the bias line before the PRINT line', () => {
    const { input } = generatePlumedInput(config);
    expect(input.indexOf('METAD')).toBeLessThan(input.indexOf('PRINT'));
  });

  test('adds the bias component to the PRINT arguments automatically', () => {
    expect(generatePlumedInput(config).input).toContain('metad.bias');
  });

  test('names the correct bias component for OPES', () => {
    const { input } = generatePlumedInput({
      ...config, biasMethod: 'opes', biasParams: { barrier: 30 }
    });
    expect(input).toContain('opes.bias');
    expect(input).not.toContain('metad.bias');
  });

  test('includes UNITS and MOLINFO when supplied', () => {
    const { input } = generatePlumedInput({
      ...config,
      units: { length: 'nm', energy: 'kj/mol' },
      molinfo: { structure: 'ref.pdb', moltype: 'protein' }
    });
    expect(input).toContain('UNITS LENGTH=nm ENERGY=kj/mol');
    expect(input).toContain('MOLINFO STRUCTURE=ref.pdb MOLTYPE=protein');
  });

  test('omits UNITS and MOLINFO when absent', () => {
    const { input } = generatePlumedInput(config);
    expect(input).not.toContain('UNITS');
    expect(input).not.toContain('MOLINFO');
  });

  test('records the target version as a comment', () => {
    expect(generatePlumedInput(config).input).toContain('Target: PLUMED 2.9');
  });

  test('produces a clean file with no warnings for a valid configuration', () => {
    expect(generatePlumedInput(config).warnings).toEqual([]);
  });

  test('aggregates warnings from CVs, labels and bias', () => {
    const { warnings } = generatePlumedInput({
      ...config,
      cvs: [
        { type: 'DISTANCE', label: 'dup', values: { ATOMS: '1,2' }, bias: true },
        { type: 'DISTANCE', label: 'dup', values: { ATOMS: '3,4' }, bias: true }
      ],
      biasParams: {}
    });
    expect(warnings.some(w => w.includes('Duplicate'))).toBe(true);
    expect(warnings.some(w => w.includes('SIGMA'))).toBe(true);
  });

  test('omits an unavailable CV but keeps the rest of the file', () => {
    const { input, cvLines } = generatePlumedInput({
      ...config,
      cvs: [
        { type: 'DISTANCE', label: 'd1', values: { ATOMS: '1,2' }, bias: true },
        { type: 'FUTURE_CV', label: 'x' }
      ]
    });
    expect(cvLines).toHaveLength(1);
    expect(input).toContain('d1: DISTANCE');
  });

  test('handles an empty configuration without throwing', () => {
    const r = generatePlumedInput({});
    expect(typeof r.input).toBe('string');
    expect(r.cvLines).toEqual([]);
  });

  test('exposes the supported version list', () => {
    expect(PLUMED_VERSIONS).toContain('2.9');
    expect(PLUMED_VERSIONS).toContain('2.10');
    expect(PLUMED_VERSIONS).toContain(DEFAULT_PLUMED_VERSION);
  });
});

/* ------------------------------------------------------------------ *
 * The shipped catalogue
 * ------------------------------------------------------------------ */

describe('fieldAvailable and cvAvailable', () => {
  test('a field may be bounded below or above', () => {
    expect(fieldAvailable({ k: 'A' }, '2.9')).toBe(true);
    expect(fieldAvailable({ k: 'A', since: '2.10' }, '2.9')).toBe(false);
    expect(fieldAvailable({ k: 'A', since: '2.10' }, '2.11')).toBe(true);
    expect(fieldAvailable({ k: 'A', until: '2.9' }, '2.9')).toBe(true);
    expect(fieldAvailable({ k: 'A', until: '2.9' }, '2.10')).toBe(false);
    expect(fieldAvailable(null, '2.9')).toBe(false);
  });

  test('an entry can be absent from one release', () => {
    expect(cvAvailable(CV_DEFS.TORSIONS, '2.9')).toBe(true);
    expect(cvAvailable(CV_DEFS.TORSIONS, '2.10')).toBe(false);
    expect(cvAvailable(CV_DEFS.TORSIONS, '2.11')).toBe(true);
  });
});

describe('actionNameFor', () => {
  test('takes the variant a selector picks', () => {
    const cv = createCV('XANGLES', 1);
    expect(actionNameFor(cv, CV_DEFS.XANGLES)).toBe('XANGLES');
    cv.values.__variant = 'ZANGLES';
    expect(actionNameFor(cv, CV_DEFS.XANGLES)).toBe('ZANGLES');
  });

  test('reads the action from a hand-written line', () => {
    const cv = createCV('CUSTOM', 1, { values: { __raw: 'PAIRENTROPY ATOMS=1-10 MAXR=0.6' } });
    expect(actionNameFor(cv, CV_DEFS.CUSTOM)).toBe('PAIRENTROPY');
    expect(actionNameFor(null, null)).toBe('');
  });
});

describe('reductions and components', () => {
  test('a reduction value is nothing, one block or several', () => {
    expect(reductionBlocks('')).toEqual([]);
    expect(reductionBlocks('{RATIONAL R_0=8}')).toEqual(['{RATIONAL R_0=8}']);
    expect(reductionBlocks('{RATIONAL R_0=8}; {RATIONAL R_0=11}')).toHaveLength(2);
    expect(reductionBlocks(['a', '', 'b'])).toEqual(['a', 'b']);
  });

  test('expands a moments list', () => {
    expect(expandMoments('2')).toEqual([2]);
    expect(expandMoments('2-4,6')).toEqual([2, 3, 4, 6]);
    expect(expandMoments('')).toEqual([]);
  });

  test('a scalar CV has no components', () => {
    expect(componentsForCV(createCV('TORSION', 1))).toEqual([]);
    expect(componentsForCV(null)).toEqual([]);
  });

  test('COMPONENTS turns a distance into x, y and z', () => {
    const cv = createCV('DISTANCE', 1);
    expect(componentsForCV(cv)).toEqual([]);
    cv.values.COMPONENTS = true;
    expect(componentsForCV(cv)).toEqual(['.x', '.y', '.z']);
  });

  test('actions that never output a single value', () => {
    expect(componentsForCV(createCV('POSITION', 1))).toEqual(['.x', '.y', '.z']);
    expect(componentsForCV(createCV('CELL', 1))).toHaveLength(9);
    expect(componentsForCV(createCV('PATHMSD', 1))).toEqual(['.sss', '.zzz']);
    expect(componentsForCV(createCV('PROPERTYMAP', 1))).toEqual(['.X', '.Y', '.zzz']);
  });

  test('a ring of five and a ring of six pucker differently', () => {
    const six = createCV('PUCKERING', 1);
    expect(componentsForCV(six)).toContain('.amplitude');
    const five = createCV('PUCKERING', 2, { values: { ATOMS: '1,2,3,4,5' } });
    expect(componentsForCV(five)).toEqual(['.phs', '.amp', '.Zx', '.Zy']);
  });

  test('a contact map outputs one value per contact unless summed', () => {
    const cv = createCV('CONTACTMAP', 1, {
      values: { ATOMS: 'ATOMS1=1,2 SWITCH1={RATIONAL R_0=0.3} ATOMS2=3,4 SWITCH2={RATIONAL R_0=0.3}' }
    });
    expect(componentsForCV(cv)).toEqual(['.contact-1', '.contact-2']);
    cv.values.SUM = true;
    expect(componentsForCV(cv)).toEqual([]);
  });

  test('a multicolvar exposes the reductions switched on', () => {
    const cv = createCV('COORDINATIONNUMBER_ADV', 1);
    expect(componentsForCV(cv)).toEqual(['.mean']);
    cv.values.MORE_THAN = '{RATIONAL R_0=8.0 D_MAX=9.0}';
    expect(componentsForCV(cv)).toEqual(['.mean', '.morethan']);
  });

  test('a reduction given twice is numbered from one', () => {
    const cv = createCV('COORDINATIONNUMBER_ADV', 1, {
      values: { MEAN: false, MORE_THAN: '{RATIONAL R_0=8.0}; {RATIONAL R_0=11.0}', MOMENTS: '2' }
    });
    expect(componentsForCV(cv)).toEqual(['.morethan-1', '.morethan-2', '.moment-2']);
    const { line } = buildCVLine(cv);
    expect(line).toContain('MORE_THAN1={RATIONAL R_0=8.0}');
    expect(line).toContain('MORE_THAN2={RATIONAL R_0=11.0}');
    expect(line).toContain('MOMENTS=2');
    expect(line).not.toContain('MORE_THAN=');
  });

  test('the shortcut families name their values with an underscore from 2.10', () => {
    const cv = createCV('ANGLES', 1);
    expect(componentsForCV(cv, CV_DEFS, { version: '2.9' })).toEqual(['.mean']);
    expect(componentsForCV(cv, CV_DEFS, { version: '2.10' })).toEqual(['_mean']);
  });

  test('a torsion family starts with a range, since an angle has no mean', () => {
    const cv = createCV('XYTORSIONS', 1, { version: '2.11' });
    expect(cv.values.MEAN).toBeUndefined();
    expect(componentsForCV(cv, CV_DEFS, { version: '2.11' })).toEqual(['_between']);
    expect(cv.biasValues.comp).toBe('_between');
  });

  test('a list of constants is one vector from 2.10', () => {
    const cv = createCV('CONSTANT', 1);
    expect(componentsForCV(cv, CV_DEFS, { version: '2.9' })).toEqual(['.v-0', '.v-1']);
    expect(componentsForCV(cv, CV_DEFS, { version: '2.11' })).toEqual([]);
  });

  test('a hand-written action declares its own components', () => {
    const cv = createCV('CUSTOM', 1, {
      label: 'ma1', values: { __raw: 'MANY_ANGLE CENTER=C START=N END=O RCUT=1.0 MEAN MOMENT2', __components: 'mean, moment2' }
    });
    expect(componentsForCV(cv)).toEqual(['.mean', '.moment2']);
    expect(buildCVLine(cv).line).toBe('ma1: MANY_ANGLE CENTER=C START=N END=O RCUT=1.0 MEAN MOMENT2');
  });

  test('lists every argument a configuration offers', () => {
    const d = createCV('DISTANCE', 1, { label: 'd' });
    const g = createCV('GROUP', 2, { label: 'g' });
    const p = createCV('POSITION', 3, { label: 'p' });
    const f = createFunction('COMBINE', 1, { label: 'rc', args: ['d', 'p.x'] });
    const args = availableArguments({ cvs: [d, g, p], functions: [f] }).map(a => a.arg);
    expect(args).toEqual(['d', 'p.x', 'p.y', 'p.z', 'rc']);
    expect(availableArguments()).toEqual([]);
  });
});

describe('createCV', () => {
  test('seeds the catalogue values and a grid that suits the type', () => {
    const t = createCV('TORSION', 3);
    expect(t).toMatchObject({ id: 'cv3', label: 'cv3', type: 'TORSION', bias: true });
    expect(t.values.ATOMS).toBe('1,2,3,4');
    expect(t.biasValues).toMatchObject({ min: '-pi', max: 'pi' });
    expect(defaultBiasValues('Q6')).toMatchObject({ min: '0.0', max: '1.0' });
    expect(defaultBiasValues('NEVER_HEARD_OF')).toMatchObject({ min: '0.0', max: '10.0' });
  });

  test('a group or a centre is never a bias target', () => {
    expect(createCV('GROUP', 1).bias).toBe(false);
    expect(createCV('CENTER', 1).bias).toBe(false);
    expect(createCV('CONSTANT', 1).bias).toBe(false);
  });

  test('biases the first component of a CV that has several', () => {
    expect(createCV('POSITION', 1).biasValues.comp).toBe('.x');
    expect(createCV('PATHMSD', 1).biasValues.comp).toBe('.sss');
    expect(createCV('Q6', 1).biasValues.comp).toBe('.mean');
  });

  test('returns null for an unknown type', () => {
    expect(createCV('NOPE', 1)).toBeNull();
    expect(createFunction('NOPE', 1)).toBeNull();
  });
});

describe('buildCVLine with the shipped catalogue', () => {
  test('folds the switching parameters of an order parameter into SWITCH', () => {
    const { line } = buildCVLine(createCV('Q6', 1, { label: 'q6' }));
    expect(line).toBe('q6: Q6 SPECIES=1-64 MEAN SWITCH={RATIONAL R_0=0.25 D_0=0.0 D_MAX=0.5}');
  });

  test('COORDINATION uses SWITCH only when D_MAX is given', () => {
    const cv = createCV('COORDINATION', 1, { label: 'c' });
    cv.bias = false;
    expect(buildCVLine(cv).line).toBe('c: COORDINATION GROUPA=1-10 GROUPB=11-20 R_0=0.3 D_0=0.0 NN=6 MM=0');
    cv.values.D_MAX = '0.8';
    expect(buildCVLine(cv).line).toBe(
      'c: COORDINATION GROUPA=1-10 GROUPB=11-20 SWITCH={RATIONAL R_0=0.3 D_0=0.0 NN=6 MM=0 D_MAX=0.8}');
  });

  test('leaves out a keyword the target release does not have', () => {
    const cv = createCV('CONSTANT', 1, { label: 'k', values: { VALUES: '', VALUE: '1.0', NODERIV: true } });
    expect(buildCVLine(cv, CV_DEFS, { version: '2.9' }).line).toBe('k: CONSTANT VALUE=1.0 NODERIV');
    expect(buildCVLine(cv, CV_DEFS, { version: '2.10' }).line).toBe('k: CONSTANT VALUE=1.0');
  });

  test('no starting value is in reduced units', () => {
    for (const [type, def] of Object.entries(CV_DEFS)) {
      for (const f of def.fields || []) {
        if (!['R_0', 'D_0', 'D_MAX'].includes(f.k) || f.def === '') continue;
        expect([type, f.k, Number(f.def) <= 1.0]).toEqual([type, f.k, true]);
      }
    }
  });

  test('the keyword table removes what a release does not register', async () => {
    const old = await loadSyntax('2.9');
    const next = await loadSyntax('2.10');
    const q = createCV('Q6', 1, { version: '2.9', syntax: old });
    expect(Object.keys(q.values)).not.toContain('SUM');
    expect(fieldsFor(CV_DEFS.Q6, { version: '2.10', syntax: next }).map(f => f.k)).toContain('SUM');
    expect(fieldsFor(CV_DEFS.Q6, { version: '2.9', syntax: old }).map(f => f.k)).toContain('R_0');
  });
});

describe('rationalSwitch', () => {
  test('is one at contact, a half near r0 and zero past D_MAX', () => {
    expect(rationalSwitch(0, { r0: 0.3 })).toBe(1);
    expect(rationalSwitch(0.3, { r0: 0.3 })).toBeCloseTo(0.5, 10);
    expect(rationalSwitch(0.9, { r0: 0.3, dmax: 0.8 })).toBe(0);
    expect(rationalSwitch(0.6, { r0: 0.3 })).toBeCloseTo((1 - 64) / (1 - 4096), 10);
    expect(rationalSwitch(0.5, { r0: 0 })).toBeNaN();
  });

  test('d0 shifts the function', () => {
    expect(rationalSwitch(0.4, { r0: 0.3, d0: 0.5 })).toBe(1);
    expect(rationalSwitch(0.8, { r0: 0.3, d0: 0.5 })).toBeCloseTo(0.5, 10);
  });
});

describe('buildFunctionLine', () => {
  test('writes a weighted sum', () => {
    const f = createFunction('COMBINE', 1, {
      label: 'rc', args: ['a.mean', 'b'], values: { COEFFICIENTS: '1.19,-4.75' }
    });
    const r = buildFunctionLine(f);
    expect(r.line).toBe('rc: COMBINE ARG=a.mean,b COEFFICIENTS=1.19,-4.75 PERIODIC=NO');
    expect(r.warnings).toEqual([]);
  });

  test('needs one coefficient per argument', () => {
    const f = createFunction('COMBINE', 1, { args: ['a', 'b', 'c'], values: { COEFFICIENTS: '1,2' } });
    expect(buildFunctionLine(f).warnings[0]).toContain('2 values for 3 arguments');
  });

  test('writes an expression without spaces', () => {
    const f = createFunction('CUSTOM', 1, { label: 'd', args: ['a', 'b'], values: { FUNC: 'x - y + 2.5' } });
    expect(buildFunctionLine(f).line).toBe('d: CUSTOM ARG=a,b FUNC=x-y+2.5 PERIODIC=NO');
  });

  test('more than three arguments need names', () => {
    const f = createFunction('CUSTOM', 1, { args: ['a', 'b', 'c', 'd'], values: { FUNC: 'x' } });
    expect(buildFunctionLine(f).warnings.some(w => w.includes('VAR'))).toBe(true);
    f.values.VAR = 'p,q,r,s';
    expect(buildFunctionLine(f).warnings).toEqual([]);
    expect(buildFunctionLine(f).line).toContain('VAR=p,q,r,s');
  });

  test('reports an argument nothing defines', () => {
    const f = createFunction('COMBINE', 1, { args: ['a', 'ghost'] });
    const r = buildFunctionLine(f, { known: new Set(['a']) });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('ghost');
  });

  test('checks the period', () => {
    const f = createFunction('CUSTOM', 1, { args: ['a'], values: { FUNC: 'x', PERIODIC: 'yes' } });
    expect(buildFunctionLine(f).warnings.some(w => w.includes('PERIODIC'))).toBe(true);
    f.values.PERIODIC = '-pi,pi';
    expect(buildFunctionLine(f).warnings).toEqual([]);
  });

  test('rejects an empty or unknown function', () => {
    expect(buildFunctionLine(null).line).toBeNull();
    expect(buildFunctionLine({ type: 'NOPE' }).line).toBeNull();
    expect(buildFunctionLine(createFunction('COMBINE', 1)).warnings[0]).toContain('no arguments');
  });
});

describe('buildBiasLine with per-argument grids', () => {
  const targets = [
    { arg: 'd1', type: 'DISTANCE', min: '0.0', max: '3.0', bin: '300', sigma: '0.05' },
    { arg: 'phi', type: 'TORSION', min: '-pi', max: 'pi', bin: '200', sigma: '0.2' }
  ];
  const options = { grid: true, temp: '300', stride: '500', walkers: { mode: 'none' } };

  test('writes a clean well-tempered block', () => {
    const r = buildBiasLine('wt_metad', targets, {}, options);
    expect(r.warnings).toEqual([]);
    expect(r.lines).toEqual([
      'metad: METAD ...', '    ARG=d1,phi', '    PACE=500', '    HEIGHT=1.2', '    SIGMA=0.05,0.2',
      '    BIASFACTOR=10', '    TEMP=300', '    FILE=HILLS', '    GRID_MIN=0.0,-pi',
      '    GRID_MAX=3.0,pi', '    GRID_BIN=300,200', '...'
    ]);
    expect(r.components).toEqual(['metad.bias']);
  });

  test('the reweighting factor adds its components', () => {
    const r = buildBiasLine('wt_metad', targets, {}, { ...options, rct: true });
    expect(r.lines).toContain('    CALC_RCT RCT_USTRIDE=10');
    expect(r.components).toEqual(['metad.bias', 'metad.rbias', 'metad.rct']);
    const off = buildBiasLine('wt_metad', targets, {}, { ...options, grid: false, rct: true });
    expect(off.warnings.some(w => w.includes('CALC_RCT'))).toBe(true);
  });

  test('a periodic variable must have its period as the grid', () => {
    const bad = [{ ...targets[1], min: '0.0', max: '10.0' }];
    const r = buildBiasLine('wt_metad', bad, {}, options);
    expect(r.warnings.some(w => w.includes('periodic'))).toBe(true);
  });

  test('reports a grid that cannot resolve a hill', () => {
    const coarse = [{ ...targets[0], bin: '20' }];
    const r = buildBiasLine('wt_metad', coarse, {}, options);
    expect(r.warnings.some(w => w.includes('Use at least 120 bins'))).toBe(true);
  });

  test('reports a reversed or non-numeric grid', () => {
    expect(buildBiasLine('metad', [{ ...targets[0], min: '3', max: '1' }], {}, options)
      .warnings.some(w => w.includes('Grid error'))).toBe(true);
    expect(buildBiasLine('metad', [{ ...targets[0], min: 'low' }], {}, options)
      .warnings.some(w => w.includes('not numeric'))).toBe(true);
  });

  test('a blank temperature is reported, not invented', () => {
    const r = buildBiasLine('wt_metad', targets, {}, { ...options, temp: '' });
    expect(r.warnings.some(w => w.startsWith('TEMP is blank'))).toBe(true);
    expect(r.lines.join('\n')).not.toContain('TEMP=');
  });

  test('parallel-bias metadynamics writes one hills file per argument', () => {
    const r = buildBiasLine('pbmetad', targets, {}, options);
    expect(r.lines).toContain('    FILE=HILLS.d1,HILLS.phi');
    expect(r.components).toEqual(['pb.bias']);
  });

  test('OPES leaves the kernel width to the method unless one is given', () => {
    const r = buildBiasLine('opes', targets, {}, options);
    expect(r.lines.join('\n')).toContain('SIGMA is ADAPTIVE');
    expect(r.lines).toContain('    NLIST   # neighbour list over kernels speeds up multi-CV OPES');
    const fixed = buildBiasLine('opes', targets, { SIGMA: '0.1,0.3' }, options);
    expect(fixed.lines).toContain('    SIGMA=0.1,0.3');
  });

  test('walkers sharing a directory', () => {
    const walkers = { mode: 'disk', n: 4, id: 2, dir: '../hills', rstride: 100 };
    const r = buildBiasLine('wt_metad', targets, {}, { ...options, walkers });
    expect(r.lines).toContain('    WALKERS_ID=2');
    expect(r.warnings.some(w => w.includes('different'))).toBe(true);
    const silent = buildBiasLine('wt_metad', targets, {},
      { ...options, walkers: { ...walkers, perWalkerFiles: true } });
    expect(silent.warnings.some(w => w.includes('different'))).toBe(false);
    const over = buildBiasLine('wt_metad', targets, {}, { ...options, walkers: { ...walkers, id: 4 } });
    expect(over.warnings.some(w => w.includes('out of range'))).toBe(true);
  });

  test('OPES takes MPI walkers only', () => {
    const r = buildBiasLine('opes', targets, {},
      { ...options, walkers: { mode: 'disk', n: 4, id: 0 } });
    expect(r.lines).toContain('    WALKERS_MPI');
    expect(r.lines.join('\n')).not.toContain('WALKERS_DIR');
  });

  test('a per-argument parameter is repeated or listed', () => {
    const one = buildBiasLine('restraint', targets, { AT: '1.0', KAPPA: '200' }, options);
    expect(one.lines[0]).toBe('restraint: RESTRAINT ARG=d1,phi AT=1.0,1.0 KAPPA=200,200');
    const wrong = buildBiasLine('restraint', targets, { AT: '1,2,3' }, options);
    expect(wrong.warnings.some(w => w.includes('3 values for 2'))).toBe(true);
  });

  test('every method names its PLUMED action', () => {
    for (const [k, def] of Object.entries(BIAS_DEFS)) {
      if (k !== 'none') expect(def.action).toMatch(/^[A-Z_]+$/);
    }
  });

  test('warns about dimensionality', () => {
    const three = [...targets, { arg: 'x', type: 'DISTANCE', min: '0.0', max: '3.0', bin: '300', sigma: '0.05' }];
    expect(buildBiasLine('wt_metad', three, {}, options).warnings.some(w => w.includes('> 2 CVs'))).toBe(true);
  });
});

describe('buildRestraintLine', () => {
  test('writes a wall and names its bias', () => {
    const r = buildRestraintLine({ type: 'upper', label: 'uw', arg: 'd1', at: '3.0', kappa: '150' });
    expect(r.line).toBe('uw: UPPER_WALLS ARG=d1 AT=3.0 KAPPA=150');
    expect(r.component).toBe('uw.bias');
    expect(r.warnings).toEqual([]);
  });

  test('writes only the parameters that differ from the defaults', () => {
    const r = buildRestraintLine({
      type: 'lower', label: 'lw', arg: 'd1', at: '0.2', kappa: '150', exp: '4', eps: '1', offset: '0'
    });
    expect(r.line).toBe('lw: LOWER_WALLS ARG=d1 AT=0.2 KAPPA=150 EXP=4');
  });

  test('reports what is missing', () => {
    const r = buildRestraintLine({ type: 'restraint', arg: '', at: '', kappa: '-1' });
    expect(r.warnings).toHaveLength(3);
    expect(buildRestraintLine({ type: 'nope' }).line).toBeNull();
    const ghost = buildRestraintLine({ type: 'upper', arg: 'ghost', at: '1', kappa: '1' },
      { known: new Set(['d1']) });
    expect(ghost.warnings[0]).toContain('ghost');
  });
});

describe('parseAtomList', () => {
  test('expands indices, ranges and strides', () => {
    expect(parseAtomList('1,2').indices).toEqual([1, 2]);
    expect(parseAtomList('1-5').indices).toEqual([1, 2, 3, 4, 5]);
    expect(parseAtomList('1-17:8').indices).toEqual([1, 9, 17]);
    expect(parseAtomList('1-2400:8').count).toBe(300);
  });

  test('keeps labels and selections apart', () => {
    const r = parseAtomList('1,c1,@phi-2');
    expect(r.indices).toEqual([1]);
    expect(r.labels).toEqual(['c1', '@phi-2']);
  });

  test('reports what it cannot read', () => {
    expect(parseAtomList('5-1').errors).toHaveLength(1);
    expect(parseAtomList('1-5:0').errors).toHaveLength(1);
    expect(parseAtomList('1;2').errors).toHaveLength(1);
    expect(parseAtomList('').indices).toEqual([]);
  });
});

describe('checkCV', () => {
  test('an atom beyond the structure', () => {
    const cv = createCV('DISTANCE', 1, { values: { ATOMS: '1,5000' } });
    expect(checkCV(cv, CV_DEFS, { natoms: 4321 })[0]).toContain('atom 5000 does not exist');
    expect(checkCV(cv, CV_DEFS, { natoms: 5000 })).toEqual([]);
  });

  test('PLUMED counts from one', () => {
    const cv = createCV('DISTANCE', 1, { values: { ATOMS: '0,1' } });
    expect(checkCV(cv).some(w => w.includes('no atom 0'))).toBe(true);
  });

  test('the wrong number of atoms', () => {
    const cv = createCV('TORSION', 1, { values: { ATOMS: '1,2,3' } });
    expect(checkCV(cv).some(w => w.includes('takes 4 atoms'))).toBe(true);
    const sel = createCV('TORSION', 2, { values: { ATOMS: '@phi-2' } });
    expect(checkCV(sel)).toEqual([]);
  });

  test('a label that nothing defines', () => {
    const cv = createCV('DISTANCE', 1, { values: { ATOMS: 'c1,c2' } });
    expect(checkCV(cv, CV_DEFS, { known: new Set(['c1']) })).toHaveLength(1);
    expect(checkCV(cv, CV_DEFS, { known: new Set(['c1', 'c2']) })).toEqual([]);
  });

  test('a cutoff that reads as reduced units', () => {
    const cv = createCV('COORDINATION', 1, { values: { R_0: '3.0', D_MAX: '6.0' } });
    expect(checkCV(cv).some(w => w.includes('reduced units'))).toBe(true);
    expect(checkCV(cv, CV_DEFS, { units: { length: 'A' } }).some(w => w.includes('reduced units'))).toBe(false);
  });

  test('a D_MAX inside R_0 reshapes the switching function', () => {
    const cv = createCV('COORDINATION', 1, { values: { R_0: '0.3', D_MAX: '0.25' } });
    expect(checkCV(cv).some(w => w.includes('is inside `R_0`'))).toBe(true);
    cv.values.D_MAX = '0.4';
    expect(checkCV(cv)).toEqual([]);
    cv.values.D_0 = '0.5';
    expect(checkCV(cv).some(w => w.includes('must be larger than `D_0`'))).toBe(true);
  });

  test('a neighbour list needs its two parameters', () => {
    const cv = createCV('COORDINATION', 1, { values: { NLIST: true } });
    expect(checkCV(cv).some(w => w.includes('NL_CUTOFF'))).toBe(true);
  });

  test('CONSTANT takes one form of value', () => {
    expect(checkCV(createCV('CONSTANT', 1, { values: { VALUE: '1', VALUES: '1,2' } }))[0]).toContain('both');
    expect(checkCV(createCV('CONSTANT', 1, { values: { VALUE: '', VALUES: '' } }))[0]).toContain('needs');
  });
});

describe('generatePlumedInput, the full description', () => {
  const d1 = () => createCV('DISTANCE', 1, { label: 'd1', values: { ATOMS: '10,250' } });
  const phi = () => createCV('TORSION', 2, { label: 'phi', values: { ATOMS: '5,7,9,15' } });
  const bias = { method: 'wt_metad', temp: '300', stride: '500', grid: true };

  test('writes the file the page shows', () => {
    const d = d1();
    d.biasValues = { comp: '', min: '0.0', max: '3.0', bin: '300', sigma: '0.05' };
    const r = generatePlumedInput({ version: '2.10', cvs: [d, phi()], bias });
    expect(r.warnings).toEqual([]);
    expect(r.input).toBe([
      '# ==================================================================',
      '# PLUMED input (plumed.dat)  -  generated by stemkit.net',
      '# Target: PLUMED 2.10',
      '# Check it before the run:  plumed driver --natoms N --parse-only --plumed plumed.dat',
      '# ==================================================================',
      '',
      '# --- Collective variables ---',
      'd1: DISTANCE ATOMS=10,250',
      'phi: TORSION ATOMS=5,7,9,15',
      '',
      '# --- Well-Tempered Metadynamics ---',
      'metad: METAD ...',
      '    ARG=d1,phi',
      '    PACE=500',
      '    HEIGHT=1.2',
      '    SIGMA=0.05,0.1',
      '    BIASFACTOR=10',
      '    TEMP=300',
      '    FILE=HILLS',
      '    GRID_MIN=0.0,-pi',
      '    GRID_MAX=3.0,pi',
      '    GRID_BIN=300,200',
      '...',
      '',
      '# --- Output ---',
      'PRINT ARG=d1,phi,metad.bias FILE=COLVAR STRIDE=500',
      ''
    ].join('\n'));
    expect(r.biased).toEqual(['d1', 'phi']);
    expect(r.actions).toEqual(['DISTANCE', 'TORSION', 'METAD', 'PRINT']);
  });

  test('setup actions lead, in the order PLUMED requires', () => {
    const { input } = generatePlumedInput({
      cvs: [d1()], bias: { method: 'none' },
      units: { length: 'A', energy: 'kcal/mol', time: 'ps' },
      preamble: { restart: true, load: ['PairEntropy.cpp', 'ManyAngle.cpp'], include: 'centers.dat', flush: 1000 },
      molinfo: { structure: 'ref.pdb' }
    });
    const at = (t) => input.indexOf(t);
    expect(at('RESTART')).toBeGreaterThan(-1);
    expect(at('RESTART')).toBeLessThan(at('UNITS LENGTH=A ENERGY=kcal/mol'));
    expect(at('UNITS')).toBeLessThan(at('LOAD FILE=PairEntropy.cpp'));
    expect(at('LOAD FILE=ManyAngle.cpp')).toBeLessThan(at('MOLINFO STRUCTURE=ref.pdb'));
    expect(at('MOLINFO')).toBeLessThan(at('INCLUDE FILE=centers.dat'));
    expect(at('INCLUDE')).toBeLessThan(at('d1: DISTANCE'));
    expect(at('d1: DISTANCE')).toBeLessThan(at('FLUSH STRIDE=1000'));
    expect(at('FLUSH')).toBeLessThan(at('PRINT'));
    expect(input).not.toContain('TIME=ps');
  });

  test('a function of several CVs can be the biased variable', () => {
    const a = d1(); a.bias = false;
    const b = phi(); b.bias = false;
    const rc = createFunction('COMBINE', 1, { label: 'rc', args: ['d1', 'phi'], values: { COEFFICIENTS: '0.5,-1.5' } });
    rc.bias = true;
    rc.biasValues = { comp: '', min: '-5', max: '5', bin: '400', sigma: '0.1' };
    const r = generatePlumedInput({ cvs: [a, b], functions: [rc], bias });
    expect(r.input).toContain('rc: COMBINE ARG=d1,phi COEFFICIENTS=0.5,-1.5 PERIODIC=NO');
    expect(r.input).toContain('    ARG=rc\n');
    expect(r.input).toContain('PRINT ARG=d1,phi,rc,metad.bias');
    expect(r.biased).toEqual(['rc']);
    expect(r.warnings).toEqual([]);
  });

  test('walls stand beside the bias and are printed', () => {
    const d = d1();
    d.biasValues = { comp: '', min: '0.0', max: '3.0', bin: '300', sigma: '0.05' };
    const r = generatePlumedInput({
      cvs: [d], bias,
      restraints: [{ type: 'upper', arg: 'd1', at: '2.5', kappa: '150' }]
    });
    expect(r.input).toContain('uw1: UPPER_WALLS ARG=d1 AT=2.5 KAPPA=150');
    expect(r.input).toContain('PRINT ARG=d1,metad.bias,uw1.bias');
    expect(r.input.indexOf('...')).toBeLessThan(r.input.indexOf('uw1:'));
  });

  test('several output files, each with its own stride', () => {
    const r = generatePlumedInput({
      cvs: [d1()], bias: { method: 'none' },
      prints: [{ file: 'COLVAR', stride: 500 }, { file: 'FAST', stride: 10, args: ['d1'] }]
    });
    expect(r.input).toContain('PRINT ARG=d1 FILE=COLVAR STRIDE=500');
    expect(r.input).toContain('PRINT ARG=d1 FILE=FAST STRIDE=10');
    const empty = generatePlumedInput({
      cvs: [d1()], bias: { method: 'none' },
      prints: [{ file: 'COLVAR' }, { file: 'EMPTY', args: [], only: true }]
    });
    expect(empty.input).not.toContain('FILE=EMPTY');
    expect(empty.warnings.some(w => w.includes('nothing to write'))).toBe(true);
    const same = generatePlumedInput({
      cvs: [d1()], bias: { method: 'none' }, prints: [{ file: 'A' }, { file: 'A' }]
    });
    expect(same.warnings.some(w => w.includes('same file'))).toBe(true);
  });

  test('an argument that nothing defines is reported', () => {
    const r = generatePlumedInput({
      cvs: [d1()], bias: { method: 'none' }, prints: [{ file: 'COLVAR', extra: 'metad.rbias, d1' }]
    });
    expect(r.warnings.some(w => w.includes('`metad.rbias`'))).toBe(true);
    const included = generatePlumedInput({
      cvs: [d1()], bias: { method: 'none' }, preamble: { include: 'more.dat' },
      prints: [{ file: 'COLVAR', extra: 'x1' }]
    });
    expect(included.warnings).toEqual([]);
  });

  test('WHOLEMOLECULES takes one entity per line', () => {
    const r = generatePlumedInput({
      cvs: [d1()], bias: { method: 'none' },
      whole: { enabled: true, entities: '1-100\n101-150, 160' }
    });
    expect(r.input).toContain('WHOLEMOLECULES ENTITY0=1-100 ENTITY1=101-150,160');
    const none = generatePlumedInput({ cvs: [d1()], whole: { enabled: true, entities: '' } });
    expect(none.warnings.some(w => w.includes('no entities'))).toBe(true);
    const res = generatePlumedInput({ cvs: [d1()], whole: { enabled: true, residues: true } });
    expect(res.warnings.some(w => w.includes('needs a MOLINFO'))).toBe(true);
  });

  test('secondary structure needs MOLINFO and whole molecules', () => {
    const cv = createCV('ALPHARMSD', 1, { values: { TYPE: 'OPTIMAL' } });
    const r = generatePlumedInput({ cvs: [cv], bias: { method: 'none' } });
    expect(r.warnings.some(w => w.includes('MOLINFO'))).toBe(true);
    expect(r.warnings.some(w => w.includes('WHOLEMOLECULES'))).toBe(true);
    cv.values.TYPE = 'DRMSD';
    const ok = generatePlumedInput({
      cvs: [cv], bias: { method: 'none' }, molinfo: { structure: 'ref.pdb' }
    });
    expect(ok.warnings).toEqual([]);
  });

  test('a module a default build leaves out is named, for the target release', async () => {
    const q = createCV('Q6', 1, { label: 'q6' });
    q.bias = false;
    const old = generatePlumedInput({ version: '2.9', syntax: await loadSyntax('2.9'), cvs: [q] });
    expect(old.modules).toEqual(['crystallization']);
    expect(old.input).toContain('# Needs PLUMED built with: --enable-modules=crystallization');
    const next = generatePlumedInput({ version: '2.10', syntax: await loadSyntax('2.10'), cvs: [q] });
    expect(next.modules).toEqual(['symfunc']);
    expect(next.warnings.some(w => w.includes('**symfunc** module'))).toBe(true);
  });

  test('secondary structure is part of a default build', async () => {
    const cv = createCV('ALPHARMSD', 1);
    const r = generatePlumedInput({
      version: '2.9', syntax: await loadSyntax('2.9'), cvs: [cv], bias: { method: 'none' },
      molinfo: { structure: 'ref.pdb' }
    });
    expect(r.modules).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('OPES names its module', async () => {
    const r = generatePlumedInput({
      version: '2.9', syntax: await loadSyntax('2.9'), cvs: [phi()],
      bias: { method: 'opes', temp: '300', stride: '500', grid: true }
    });
    expect(r.modules).toEqual(['opes']);
  });

  test('says so when nothing has been added yet', () => {
    const r = generatePlumedInput({ bias: { method: 'wt_metad' } });
    expect(r.input).toContain('No collective variables added yet');
    expect(r.cvLines).toEqual([]);
  });

  test('reproduces the structure of a published nucleation input', () => {
    // Urea nucleation, arXiv:2210.04822: custom CVs from LOAD, centres from
    // INCLUDE, numbered reductions, and metadynamics on two fitted coordinates.
    const group = (label, atoms) => createCV('GROUP', label, { label, values: { ATOMS: atoms } });
    const ma1 = createCV('CUSTOM', 1, {
      label: 'ma1',
      values: { __raw: 'MANY_ANGLE CENTER=C START=Ncenter END=O RCUT=1.0 NOPBC MEAN MOMENT2', __components: 'mean,moment2' }
    });
    const cn = createCV('COORDINATIONNUMBER_ADV', 2, {
      label: 'cn',
      values: {
        SPECIES: 'Ncenter', R_0: '0.6', D_0: '', NN: '', MM: '', D_MAX: '0.8', MEAN: false,
        MORE_THAN: '{RATIONAL R_0=8.0 D_MAX=9.0}; {RATIONAL R_0=11.0 D_MAX=12.0}', MOMENTS: '2'
      }
    });
    const q6 = createCV('Q6', 3, { label: 'q6', values: { SPECIES: 'C', R_0: '0.60', D_0: '', D_MAX: '' } });
    [ma1, cn, q6].forEach(c => { c.bias = false; });
    const args = ['ma1.mean', 'ma1.moment2', 'cn.morethan-1', 'cn.morethan-2', 'cn.moment-2', 'q6.mean'];
    const rc = (n, coeff) => {
      const f = createFunction('COMBINE', n, { label: `l1_${n}`, args, values: { COEFFICIENTS: coeff } });
      return f;
    };
    const shift = (n, by) => {
      const f = createFunction('CUSTOM', n + 2, { label: `l1r_${n}`, args: [`l1_${n}`], values: { FUNC: `x+${by}` } });
      f.bias = true;
      f.biasValues = { comp: '', min: '-5', max: n === 1 ? '5' : '20', bin: '1000', sigma: '0.2' };
      return f;
    };
    const r = generatePlumedInput({
      version: '2.9',
      preamble: { load: ['InterFace.cpp', 'PairEntropy.cpp', 'ManyAngle.cpp'], include: ['centers.dat'] },
      cvs: [group('C', '1-2400:8'), group('O', '2-2400:8'), ma1, cn, q6],
      functions: [rc(1, '1.19,-4.75,0.035,-0.367,0.0027,0.011'), rc(2, '-4.17,-0.25,0.25,-0.52,-0.0065,0.10'),
        shift(1, '2.238606452942'), shift(2, '2.579712629318')],
      bias: { method: 'wt_metad', temp: '300.0', stride: '500', grid: true, rct: true,
        params: { HEIGHT: '10', BIASFACTOR: '150', PACE: '2000' } }
    });
    expect(r.input).toContain('LOAD FILE=ManyAngle.cpp');
    expect(r.input).toContain('INCLUDE FILE=centers.dat');
    expect(r.input).toContain('C: GROUP ATOMS=1-2400:8');
    expect(r.input).toContain(
      'cn: COORDINATIONNUMBER SPECIES=Ncenter MOMENTS=2 MORE_THAN1={RATIONAL R_0=8.0 D_MAX=9.0} ' +
      'MORE_THAN2={RATIONAL R_0=11.0 D_MAX=12.0} SWITCH={RATIONAL R_0=0.6 D_MAX=0.8}');
    expect(r.input).toContain('l1r_1: CUSTOM ARG=l1_1 FUNC=x+2.238606452942 PERIODIC=NO');
    expect(r.input).toContain('    ARG=l1r_1,l1r_2\n');
    expect(r.input).toContain('    GRID_MIN=-5,-5\n    GRID_MAX=5,20\n    GRID_BIN=1000,1000');
    expect(r.input).toContain('    CALC_RCT RCT_USTRIDE=10');
    expect(r.input).toContain(
      'PRINT ARG=ma1.mean,ma1.moment2,cn.morethan-1,cn.morethan-2,cn.moment-2,q6.mean,' +
      'l1_1,l1_2,l1r_1,l1r_2,metad.bias,metad.rbias,metad.rct');
    expect(r.biased).toEqual(['l1r_1', 'l1r_2']);
  });
});

describe('messages', () => {
  test('typesets the two marks and escapes the rest', () => {
    expect(messageToHtml('Set `D_MAX` on <b>; it is **large**.'))
      .toBe('Set <code>D_MAX</code> on &lt;b&gt;; it is <strong>large</strong>.');
    expect(messageToHtml(null)).toBe('');
  });

  test('strips the marks for plain text', () => {
    expect(messageToText('Set `D_MAX`; it is **large**.')).toBe('Set D_MAX; it is large.');
  });
});
