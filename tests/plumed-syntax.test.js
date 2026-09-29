import { describe, test, expect } from '@jest/globals';
import {
  SYNTAX_VERSIONS, loadSyntax, createSyntax, splitNumbered, plumedDocUrl
} from '../src/core/plumed-syntax.js';

describe('splitNumbered', () => {
  const registered = new Set(['ATOMS', 'KAPPA0', 'R_0', 'MORE_THAN']);
  const has = (n) => registered.has(n);

  test('a registered name that ends in a digit is not split', () => {
    expect(splitNumbered('KAPPA0', has)).toEqual({ name: 'KAPPA0', index: null });
    expect(splitNumbered('R_0', has)).toEqual({ name: 'R_0', index: null });
  });

  test('a numbered instance yields its base name and index', () => {
    expect(splitNumbered('ATOMS12', has)).toEqual({ name: 'ATOMS', index: 12 });
    expect(splitNumbered('MORE_THAN2', has)).toEqual({ name: 'MORE_THAN', index: 2 });
  });

  test('an unknown word is returned whole', () => {
    expect(splitNumbered('NOPE3', has)).toEqual({ name: 'NOPE3', index: null });
  });
});

describe('createSyntax', () => {
  const table = {
    version: '9.9',
    release: '9.9.0',
    doc: { base: 'https://example.org/doc/', mangled: false },
    modules: { colvar: 1, extra: 0 },
    strings: ['a distance', 'the atoms', 'ignore periodicity', 'exponent', 'an odd one', 'the x part'],
    actions: {
      DISTANCE: {
        m: 'colvar', d: 0, doi: ['10.1/abc'],
        k: { ATOMS: ['a', 1, 1], NOPBC: ['f', 2], NN: ['c', 3, 0, '6'], R_0: ['c', 3], STRIDE: ['h', -1] },
        o: { x: ['COMPONENTS', 5] }
      },
      ODD: { m: 'extra', d: 4, k: {} }
    }
  };
  const syntax = createSyntax(table);

  test('rejects something that is not a table', () => {
    expect(() => createSyntax(null)).toThrow();
    expect(() => createSyntax({})).toThrow();
  });

  test('describes an action', () => {
    const a = syntax.action('DISTANCE');
    expect(a.module).toBe('colvar');
    expect(a.description).toBe('a distance');
    expect(a.dois).toEqual(['10.1/abc']);
    expect(a.keywords.map(k => k.name)).toEqual(['ATOMS', 'NOPBC', 'NN', 'R_0', 'STRIDE']);
    expect(a.outputs).toEqual([{ name: 'x', keyword: 'COMPONENTS', description: 'the x part' }]);
    expect(syntax.action('MISSING')).toBeNull();
  });

  test('a compulsory keyword with a default is not required', () => {
    expect(syntax.keyword('DISTANCE', 'NN')).toMatchObject({ required: false, default: '6' });
    expect(syntax.keyword('DISTANCE', 'R_0')).toMatchObject({ required: true });
    expect(syntax.requiredKeywords('DISTANCE')).toEqual(['R_0']);
  });

  test('numbered instances resolve only for numbered keywords', () => {
    expect(syntax.keyword('DISTANCE', 'ATOMS3')).toMatchObject({ name: 'ATOMS', index: 3 });
    expect(syntax.keyword('DISTANCE', 'NOPBC2')).toBeNull();
    expect(syntax.keyword('DISTANCE', 'WHAT')).toBeNull();
    expect(syntax.keyword('MISSING', 'ATOMS')).toBeNull();
  });

  test('reports the module and whether a default build has it', () => {
    expect(syntax.moduleOf('DISTANCE')).toEqual({ name: 'colvar', defaultOn: true });
    expect(syntax.moduleOf('ODD')).toEqual({ name: 'extra', defaultOn: false });
    expect(syntax.moduleDefaultOn('never-heard-of-it')).toBe(true);
  });

  test('search ranks a name match above a description match', () => {
    expect(syntax.search('odd').map(r => r.name)).toEqual(['ODD']);
    expect(syntax.search('dist')[0].name).toBe('DISTANCE');
    expect(syntax.search('zzz')).toEqual([]);
    expect(syntax.search('', { modules: ['extra'] }).map(r => r.name)).toEqual(['ODD']);
  });

  test('builds the documentation link in the table style', () => {
    expect(syntax.docUrl('DISTANCE')).toBe('https://example.org/doc/DISTANCE');
    expect(syntax.docUrl('not an action')).toBe('');
  });
});

describe('plumedDocUrl', () => {
  test('mangles the page name as the doxygen manual does', () => {
    expect(plumedDocUrl('PROJECTION_ON_AXIS', '2.9')).toBe(
      'https://www.plumed.org/doc-v2.9/user-doc/html/_p_r_o_j_e_c_t_i_o_n__o_n__a_x_i_s.html');
    expect(plumedDocUrl('Q6', '2.10')).toBe('https://www.plumed.org/doc-v2.10/user-doc/html/_q6.html');
    expect(plumedDocUrl('', '2.9')).toBe('');
  });
});

describe('the shipped tables', () => {
  test('an unknown version is refused', async () => {
    await expect(loadSyntax('1.0')).rejects.toThrow(/No PLUMED syntax table/);
  });

  test.each(SYNTAX_VERSIONS)('PLUMED %s has the core actions', async (v) => {
    const s = await loadSyntax(v);
    expect(s.version).toBe(v);
    for (const a of ['DISTANCE', 'TORSION', 'COORDINATION', 'METAD', 'PBMETAD', 'OPES_METAD',
      'RESTRAINT', 'MOVINGRESTRAINT', 'UPPER_WALLS', 'COMBINE', 'CUSTOM', 'PRINT', 'GROUP',
      'CENTER', 'WHOLEMOLECULES', 'MOLINFO', 'LOAD', 'INCLUDE', 'RESTART', 'FLUSH']) {
      expect(s.has(a)).toBe(true);
    }
    expect(s.actionNames().every(a => s.moduleOf(a).name !== '')).toBe(true);
    expect(s.keyword('COORDINATION', 'NN').default).toBe('6');
    expect(s.requiredKeywords('COORDINATION')).toEqual(['R_0']);
    expect(s.keyword('MOVINGRESTRAINT', 'KAPPA1')).not.toBeNull();
    expect(s.keyword('COORDINATIONNUMBER', 'MORE_THAN2')).toMatchObject({ name: 'MORE_THAN', index: 2 });
  });

  test('order parameters moved module between 2.9 and 2.10, both off by default', async () => {
    const old = await loadSyntax('2.9');
    const next = await loadSyntax('2.10');
    expect(old.moduleOf('Q6')).toEqual({ name: 'crystallization', defaultOn: false });
    expect(next.moduleOf('Q6')).toEqual({ name: 'symfunc', defaultOn: false });
    expect(old.moduleOf('COORDINATIONNUMBER').defaultOn).toBe(true);
    expect(next.moduleOf('COORDINATIONNUMBER').defaultOn).toBe(false);
  });

  test('secondary structure is in a default build, OPES is not', async () => {
    for (const v of SYNTAX_VERSIONS) {
      const s = await loadSyntax(v);
      expect(s.moduleOf('ALPHARMSD').defaultOn).toBe(true);
      expect(s.moduleOf('OPES_METAD').defaultOn).toBe(false);
    }
  });

  test('keywords that one release has and another lacks', async () => {
    const old = await loadSyntax('2.9');
    const next = await loadSyntax('2.10');
    expect(old.keyword('CONSTANT', 'NODERIV')).not.toBeNull();
    expect(next.keyword('CONSTANT', 'NODERIV')).toBeNull();
    expect(old.keyword('COORDINATIONNUMBER', 'NL_CUTOFF')).toBeNull();
    expect(old.has('COORDINATION_MOMENTS')).toBe(false);
    expect(next.has('COORDINATION_MOMENTS')).toBe(true);
  });
});
