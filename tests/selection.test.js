import { describe, test, expect } from '@jest/globals';
import {
  SOLVENT_RESIDUES, ION_RESIDUES, PROTEIN_RESIDUES, BACKBONE_ATOMS,
  SpatialGrid, distanceSquared, distance,
  parseComparison, namedGroupPredicate, atomField,
  compileSelection, selectAtoms, expandToResidues,
  findContacts, selectionSummary
} from '../src/core/selection.js';

/* A small structure: two protein chains, two waters, one ion. */
function buildStructure() {
  const atoms = [];
  let serial = 1;
  const push = (chain, resi, resn, atom, elem, x, y, z, b = 20) =>
    atoms.push({ chain, resi, resn, atom, elem, x, y, z, serial: serial++, b });

  for (let r = 1; r <= 3; r++) {
    push('A', r, 'ALA', 'N', 'N', r * 3.8, 0, 0);
    push('A', r, 'ALA', 'CA', 'C', r * 3.8 + 1.0, 0, 0);
    push('A', r, 'ALA', 'CB', 'C', r * 3.8 + 1.5, 1.5, 0);
    push('A', r, 'ALA', 'O', 'O', r * 3.8 + 2.0, 0, 0);
  }
  for (let r = 1; r <= 2; r++) {
    push('B', r, 'GLY', 'CA', 'C', r * 3.8, 6.0, 0);
  }
  push('W', 1, 'HOH', 'OW', 'O', 5, 5, 0);
  push('W', 2, 'HOH', 'OW', 'O', 50, 50, 50);
  push('I', 1, 'NA', 'NA', 'Na', 4.0, 2.0, 0);
  return atoms;
}

const ATOMS = buildStructure();

describe('distance helpers', () => {
  test('squared distance avoids the square root', () => {
    expect(distanceSquared({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(25);
  });

  test('distance is the square root of it', () => {
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBeCloseTo(5, 12);
  });

  test('distance from a point to itself is zero', () => {
    const a = { x: 1, y: 2, z: 3 };
    expect(distance(a, a)).toBe(0);
  });
});

describe('SpatialGrid', () => {
  const targets = [
    { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }
  ];

  test('finds a neighbour inside the radius', () => {
    const g = new SpatialGrid(targets, 5);
    expect(g.hasNeighbourWithin(1, 1, 0, 5)).toBe(true);
  });

  test('reports none outside the radius', () => {
    const g = new SpatialGrid(targets, 5);
    expect(g.hasNeighbourWithin(50, 50, 50, 5)).toBe(false);
  });

  test('includes a point exactly at the radius', () => {
    const g = new SpatialGrid([{ x: 0, y: 0, z: 0 }], 5);
    expect(g.hasNeighbourWithin(5, 0, 0, 5)).toBe(true);
  });

  test('agrees with brute force across radii and cell sizes', () => {
    // A cell much smaller or much larger than the radius must not change the
    // answer, only the work done. An off-by-one in the cell span would show
    // up here and nowhere else.
    let seed = 12345;
    const rnd = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
    const cloud = Array.from({ length: 400 }, () => ({
      x: rnd() * 50, y: rnd() * 50, z: rnd() * 50
    }));
    const pool = cloud.slice(0, 40);

    for (const radius of [1, 5, 12]) {
      for (const cell of [0.5, radius, radius * 3]) {
        const g = new SpatialGrid(pool, cell);
        for (const a of cloud) {
          const viaGrid = g.hasNeighbourWithin(a.x, a.y, a.z, radius);
          const brute = pool.some(t => distanceSquared(t, a) <= radius * radius);
          expect(viaGrid).toBe(brute);
        }
      }
    }
  });

  test('neighboursWithin returns every neighbour, not just one', () => {
    const g = new SpatialGrid(targets, 5);
    expect(g.neighboursWithin(0, 0, 0, 11)).toHaveLength(3);
    expect(g.neighboursWithin(0, 0, 0, 1)).toHaveLength(1);
  });

  test('skips atoms with non-finite coordinates', () => {
    const g = new SpatialGrid([{ x: NaN, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }], 5);
    expect(g.cellCount).toBe(1);
  });

  test('handles a negative or zero radius safely', () => {
    const g = new SpatialGrid(targets, 5);
    expect(g.hasNeighbourWithin(0, 0, 0, -1)).toBe(false);
    expect(g.neighboursWithin(0, 0, 0, -1)).toEqual([]);
  });

  test('handles empty and invalid input', () => {
    expect(new SpatialGrid([], 5).cellCount).toBe(0);
    expect(new SpatialGrid(null, 5).cellCount).toBe(0);
  });
});

describe('parseComparison', () => {
  test('parses comparison operators', () => {
    expect(parseComparison('>50')).toEqual({ kind: 'compare', op: '>', val: 50 });
    expect(parseComparison('<=2.5')).toEqual({ kind: 'compare', op: '<=', val: 2.5 });
  });

  test('parses a range', () => {
    expect(parseComparison('10-20')).toEqual({ kind: 'range', lo: 10, hi: 20 });
  });

  test('orders a reversed range', () => {
    expect(parseComparison('20-10')).toEqual({ kind: 'range', lo: 10, hi: 20 });
  });

  test('does not mistake a leading minus for a range separator', () => {
    expect(parseComparison('-10--5')).toEqual({ kind: 'range', lo: -10, hi: -5 });
    expect(parseComparison('>-5')).toEqual({ kind: 'compare', op: '>', val: -5 });
  });

  test('treats a bare number as equality', () => {
    expect(parseComparison('42')).toEqual({ kind: 'compare', op: '=', val: 42 });
  });

  test('rejects nonsense', () => {
    expect(parseComparison('abc')).toBeNull();
    expect(parseComparison('')).toBeNull();
    expect(parseComparison(null)).toBeNull();
  });
});

describe('namedGroupPredicate', () => {
  const ala = { resn: 'ALA', atom: 'CA' };
  const alaSide = { resn: 'ALA', atom: 'CB' };
  const water = { resn: 'HOH', atom: 'OW' };
  const ion = { resn: 'NA', atom: 'NA' };
  const dna = { resn: 'DA', atom: 'P' };

  test('identifies protein, nucleic, solvent and ion', () => {
    expect(namedGroupPredicate('protein')(ala)).toBe(true);
    expect(namedGroupPredicate('nucleic')(dna)).toBe(true);
    expect(namedGroupPredicate('solvent')(water)).toBe(true);
    expect(namedGroupPredicate('ion')(ion)).toBe(true);
  });

  test('separates backbone from side chain', () => {
    expect(namedGroupPredicate('backbone')(ala)).toBe(true);
    expect(namedGroupPredicate('backbone')(alaSide)).toBe(false);
    expect(namedGroupPredicate('sidechain')(alaSide)).toBe(true);
    expect(namedGroupPredicate('sidechain')(ala)).toBe(false);
  });

  test('does not treat water as protein backbone', () => {
    expect(namedGroupPredicate('backbone')(water)).toBe(false);
  });

  test('classes non-polymer residues as hetero', () => {
    expect(namedGroupPredicate('hetero')({ resn: 'HEM' })).toBe(true);
    expect(namedGroupPredicate('hetero')(ala)).toBe(false);
    expect(namedGroupPredicate('hetero')(water)).toBe(false);
  });

  test('returns null for an unknown group', () => {
    expect(namedGroupPredicate('nonsense')).toBeNull();
  });

  test('the residue tables cover the standard sets', () => {
    expect(PROTEIN_RESIDUES.size).toBeGreaterThan(20);
    expect(SOLVENT_RESIDUES.has('SOL')).toBe(true);
    expect(ION_RESIDUES.has('NA')).toBe(true);
    expect(BACKBONE_ATOMS.has('CA')).toBe(true);
  });
});

describe('atomField', () => {
  test('reads 3Dmol-style names', () => {
    expect(atomField({ resn: 'ALA' }, 'resn')).toBe('ALA');
    expect(atomField({ resi: 5 }, 'resi')).toBe(5);
  });

  test('reads core/structure-style names for the same fields', () => {
    // The two parsers disagree on naming; a selection must work against both.
    expect(atomField({ resName: 'ALA' }, 'resn')).toBe('ALA');
    expect(atomField({ resSeq: 5 }, 'resi')).toBe(5);
    expect(atomField({ atomName: 'CA' }, 'atom')).toBe('CA');
    expect(atomField({ element: 'C' }, 'elem')).toBe('C');
  });

  test('returns undefined for a missing field', () => {
    expect(atomField({}, 'resn')).toBeUndefined();
    expect(atomField(null, 'resn')).toBeUndefined();
  });
});

describe('selectAtoms | attribute terms', () => {
  test('selects by chain', () => {
    expect(selectAtoms(ATOMS, 'chain:A').count).toBe(12);
  });

  test('combines terms with AND', () => {
    expect(selectAtoms(ATOMS, 'chain:A resi:1').count).toBe(4);
  });

  test('selects a residue range', () => {
    expect(selectAtoms(ATOMS, 'chain:A resi:1-2').count).toBe(8);
  });

  test('accepts a comma-separated list of alternatives', () => {
    expect(selectAtoms(ATOMS, 'resn:ALA,GLY').count).toBe(14);
  });

  test('is case-insensitive on attribute values', () => {
    expect(selectAtoms(ATOMS, 'resn:ala').count)
      .toBe(selectAtoms(ATOMS, 'resn:ALA').count);
  });

  test('negates with a leading bang', () => {
    const all = ATOMS.length;
    const carbon = selectAtoms(ATOMS, 'elem:C').count;
    expect(selectAtoms(ATOMS, '!elem:C').count).toBe(all - carbon);
  });

  test('negates with the not: prefix identically', () => {
    expect(selectAtoms(ATOMS, 'not:elem:C').count)
      .toBe(selectAtoms(ATOMS, '!elem:C').count);
  });

  test('an empty query selects everything', () => {
    expect(selectAtoms(ATOMS, '').count).toBe(ATOMS.length);
    expect(selectAtoms(ATOMS, '   ').count).toBe(ATOMS.length);
  });

  test('reports a malformed term rather than silently ignoring it', () => {
    const r = selectAtoms(ATOMS, 'chain');
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('selectAtoms | named groups', () => {
  test('selects protein, solvent and ions', () => {
    expect(selectAtoms(ATOMS, 'protein:').count).toBe(14);
    expect(selectAtoms(ATOMS, 'solvent:').count).toBe(2);
    expect(selectAtoms(ATOMS, 'ion:').count).toBe(1);
  });

  test('backbone and sidechain partition the protein exactly', () => {
    // Every protein atom is one or the other, with no overlap and no gap.
    const protein = selectAtoms(ATOMS, 'protein:').count;
    const bb = selectAtoms(ATOMS, 'backbone:').count;
    const sc = selectAtoms(ATOMS, 'sidechain:').count;
    expect(bb + sc).toBe(protein);
  });

  test('the two groups do not overlap', () => {
    const bb = new Set(selectAtoms(ATOMS, 'backbone:').atoms.map(a => a.serial));
    const sc = selectAtoms(ATOMS, 'sidechain:').atoms;
    expect(sc.some(a => bb.has(a.serial))).toBe(false);
  });

  test('named groups negate', () => {
    expect(selectAtoms(ATOMS, '!solvent:').count).toBe(ATOMS.length - 2);
  });
});

describe('selectAtoms | numeric terms', () => {
  test('compares a B-factor', () => {
    expect(selectAtoms(ATOMS, 'b:>10').count).toBe(ATOMS.length);
    expect(selectAtoms(ATOMS, 'b:>50').count).toBe(0);
  });

  test('selects a coordinate range', () => {
    const r = selectAtoms(ATOMS, 'x:0-10');
    expect(r.count).toBeGreaterThan(0);
    expect(r.atoms.every(a => a.x >= 0 && a.x <= 10)).toBe(true);
  });

  test('rejects a non-numeric comparison with an error', () => {
    expect(selectAtoms(ATOMS, 'b:abc').errors.length).toBeGreaterThan(0);
  });
});

describe('selectAtoms | union', () => {
  test('takes the union of pipe-separated clauses', () => {
    const a = selectAtoms(ATOMS, 'chain:A').count;
    const b = selectAtoms(ATOMS, 'chain:B').count;
    expect(selectAtoms(ATOMS, 'or:chain:A|chain:B').count).toBe(a + b);
  });

  test('a union of one clause equals the clause', () => {
    expect(selectAtoms(ATOMS, 'or:chain:A').count)
      .toBe(selectAtoms(ATOMS, 'chain:A').count);
  });
});

describe('selectAtoms | within', () => {
  test('matches a brute-force neighbour search exactly', () => {
    const r = selectAtoms(ATOMS, 'within:5,chain:B');
    const targets = ATOMS.filter(a => a.chain === 'B');
    const brute = ATOMS.filter(a =>
      targets.some(t => distanceSquared(t, a) <= 25));
    expect(r.count).toBe(brute.length);
  });

  test('a larger radius selects at least as many atoms', () => {
    const near = selectAtoms(ATOMS, 'within:3,chain:B').count;
    const far = selectAtoms(ATOMS, 'within:10,chain:B').count;
    expect(far).toBeGreaterThanOrEqual(near);
  });

  test('negation selects the complement', () => {
    const inside = selectAtoms(ATOMS, 'within:5,chain:B').count;
    const outside = selectAtoms(ATOMS, '!within:5,chain:B').count;
    expect(inside + outside).toBe(ATOMS.length);
  });

  test('an empty target set selects nothing', () => {
    expect(selectAtoms(ATOMS, 'within:5,chain:Z').count).toBe(0);
  });

  test('a negated empty target set selects everything', () => {
    expect(selectAtoms(ATOMS, '!within:5,chain:Z').count).toBe(ATOMS.length);
  });

  test('reports a malformed within term', () => {
    expect(selectAtoms(ATOMS, 'within:5').errors.length).toBeGreaterThan(0);
    expect(selectAtoms(ATOMS, 'within:abc,chain:A').errors.length).toBeGreaterThan(0);
  });
});

describe('unit conversion', () => {
  test('a radius in angstrom applies correctly to nanometre coordinates', () => {
    // The same physical query against the same structure in two unit systems
    // must select the same atoms. Getting this wrong is a factor of ten.
    const nmAtoms = ATOMS.map(a => ({ ...a, x: a.x / 10, y: a.y / 10, z: a.z / 10 }));
    const inAngstrom = selectAtoms(ATOMS, 'within:5,chain:B');
    const inNanometre = selectAtoms(nmAtoms, 'within:5,chain:B',
      { unit: 'A', coordinateUnit: 'nm' });
    expect(inNanometre.count).toBe(inAngstrom.count);
  });

  test('coordinate ranges are converted too', () => {
    const nmAtoms = ATOMS.map(a => ({ ...a, x: a.x / 10, y: a.y / 10, z: a.z / 10 }));
    const a = selectAtoms(ATOMS, 'x:0-10').count;
    const nm = selectAtoms(nmAtoms, 'x:0-10', { unit: 'A', coordinateUnit: 'nm' }).count;
    expect(nm).toBe(a);
  });

  test('a B-factor is not scaled by the length unit', () => {
    const a = selectAtoms(ATOMS, 'b:>10').count;
    const nm = selectAtoms(ATOMS, 'b:>10', { unit: 'nm', coordinateUnit: 'A' }).count;
    expect(nm).toBe(a);
  });
});

describe('expandToResidues', () => {
  test('expands a partial selection to whole residues', () => {
    const partial = selectAtoms(ATOMS, 'atom:CA chain:A');
    expect(partial.count).toBe(3);
    expect(expandToResidues(ATOMS, partial.atoms)).toHaveLength(12);
  });

  test('the byres option applies it', () => {
    expect(selectAtoms(ATOMS, 'atom:CA chain:A', { byres: true }).count).toBe(12);
  });

  test('distinguishes residues with the same number in different chains', () => {
    // Chain A residue 1 and chain B residue 1 are different residues; keying
    // on the number alone would silently merge them.
    const one = selectAtoms(ATOMS, 'chain:A resi:1', { byres: true });
    expect(one.atoms.every(a => a.chain === 'A')).toBe(true);
  });

  test('handles empty input', () => {
    expect(expandToResidues(ATOMS, [])).toEqual([]);
    expect(expandToResidues(null, [])).toEqual([]);
  });
});

describe('findContacts', () => {
  test('finds pairs within the cutoff', () => {
    const a = selectAtoms(ATOMS, 'chain:A').atoms;
    const b = selectAtoms(ATOMS, 'chain:B').atoms;
    const contacts = findContacts(a, b, 8);
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts.every(c => c.distance <= 8)).toBe(true);
  });

  test('sorts contacts by distance', () => {
    const a = selectAtoms(ATOMS, 'chain:A').atoms;
    const b = selectAtoms(ATOMS, 'chain:B').atoms;
    const contacts = findContacts(a, b, 15);
    for (let i = 1; i < contacts.length; i++) {
      expect(contacts[i].distance).toBeGreaterThanOrEqual(contacts[i - 1].distance);
    }
  });

  test('returns nothing for an impossible cutoff', () => {
    const a = selectAtoms(ATOMS, 'chain:A').atoms;
    const b = selectAtoms(ATOMS, 'chain:B').atoms;
    expect(findContacts(a, b, 0.01)).toEqual([]);
  });

  test('handles invalid input', () => {
    expect(findContacts(null, [], 5)).toEqual([]);
    expect(findContacts([], [], -1)).toEqual([]);
  });
});

describe('selectionSummary', () => {
  test('counts atoms, residues and chains', () => {
    const s = selectionSummary(selectAtoms(ATOMS, 'chain:A').atoms);
    expect(s.nAtoms).toBe(12);
    expect(s.nResidues).toBe(3);
    expect(s.nChains).toBe(1);
  });

  test('tallies elements and residue names', () => {
    const s = selectionSummary(selectAtoms(ATOMS, 'chain:A').atoms);
    expect(s.elements.C).toBe(6);
    expect(s.residues.ALA).toBe(12);
  });

  test('handles an empty selection', () => {
    const s = selectionSummary([]);
    expect(s.nAtoms).toBe(0);
    expect(s.nResidues).toBe(0);
  });
});

describe('compileSelection', () => {
  test('exposes the predicate for reuse across frames', () => {
    const { predicate } = compileSelection('chain:A', ATOMS);
    expect(ATOMS.filter(predicate)).toHaveLength(12);
  });

  test('counts the terms it parsed', () => {
    expect(compileSelection('chain:A resi:1', ATOMS).terms).toBe(2);
  });

  test('an empty query compiles to a permissive predicate', () => {
    expect(compileSelection('', ATOMS).predicate({})).toBe(true);
  });
});
