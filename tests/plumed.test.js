import { describe, test, expect } from '@jest/globals';
import {
  PLUMED_VERSIONS, DEFAULT_PLUMED_VERSION, BIAS_REDUNDANCY,
  versionAtLeast, cvAvailable, resolveAction,
  pushFieldToken, hiddenFieldsForBias,
  buildCVLine, buildSwitchBlock, buildBiasLine, buildPrintLine,
  validateLabels, generatePlumedInput
} from '../src/core/plumed.js';

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

  test('hides reduction keys under OPES', () => {
    const h = hiddenFieldsForBias({ type: 'COORDINATION', bias: true }, 'opes', CAT);
    expect(h.has('MORE_THAN')).toBe(true);
  });

  test('hides nothing under an unrecognised bias', () => {
    expect(hiddenFieldsForBias({ type: 'COORDINATION', bias: true }, 'none', CAT).size).toBe(0);
  });

  test('the redundancy map is declared for the documented methods', () => {
    expect(Object.keys(BIAS_REDUNDANCY)).toContain('wt_metad');
    expect(Object.keys(BIAS_REDUNDANCY)).toContain('opes');
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
    expect(r.lines[0]).toContain('METAD');
    expect(r.lines[0]).toContain('ARG=d1,phi');
    expect(r.lines[0]).toContain('BIASFACTOR=10');
  });

  test('omits the bias factor for non-tempered metadynamics', () => {
    const r = buildBiasLine('metad', cvs, { sigma: '0.05,0.35', gridMin: '0', gridMax: '2' });
    expect(r.lines[0]).not.toContain('BIASFACTOR');
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
    expect(r.lines[0]).toContain('BARRIER=40');
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
