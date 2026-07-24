import { describe, test, expect } from '@jest/globals';
import {
  boxVectorsFromAngles, anglesFromBoxVectors, isTriclinic,
  ATOMIC_WEIGHTS, DEFAULT_MASS, MIN_BOX_NM,
  safeFloat, elementSymbol, atomicMass, massBreakdown, isVirtualSite,
  parsePDB, parseGRO, parseXYZ, parseStructure,
  geometricCentre, centreOfMass, boundingBox, radiusOfGyration,
  rotationMatrix, rotateAtoms, translateAtoms, centreAtoms, scaleAtoms,
  unitFactor, targetUnit, computeBoxFromBounds, boxFitsStructure,
  padStr, formatXYZ, formatPDB, formatGRO, formatStructure,
  structureStats
} from '../src/core/structure.js';

/* Fixtures use real PDB/GRO column layouts, not approximations. */

const WATER_XYZ = `3
water molecule
O   0.000000   0.000000   0.000000
H   0.757000   0.586000   0.000000
H  -0.757000   0.586000   0.000000`;

const MINI_PDB = `CRYST1   20.000   30.000   40.000  90.00  90.00  90.00 P 1           1
ATOM      1  N   ALA A   1      11.104   6.134  -6.504  1.00 20.00           N
ATOM      2  CA  ALA A   1      11.639   6.071  -5.147  1.00 20.00           C
ATOM      3  C   ALA A   1      13.140   6.199  -5.153  1.00 20.00           C
ATOM      4  O   ALA A   1      13.756   6.264  -6.219  1.00 20.00           O
HETATM    5 FE   HEM A   2      10.000  10.000  10.000  1.00 30.00          FE
END`;

const MINI_GRO = `MD system
    3
    1SOL     OW    1   1.000   2.000   3.000  0.1000  0.2000  0.3000
    1SOL    HW1    2   1.100   2.000   3.000 -0.1000  0.0000  0.0000
    1SOL    HW2    3   0.900   2.000   3.000  0.0000 -0.1000  0.0000
   5.00000   6.00000   7.00000`;

describe('safeFloat', () => {
  test('parses padded numeric fields', () => {
    expect(safeFloat('  11.104 ')).toBeCloseTo(11.104, 10);
    expect(safeFloat('-6.504')).toBeCloseTo(-6.504, 10);
  });

  test('returns NaN for blank or non-numeric fields', () => {
    expect(Number.isNaN(safeFloat('   '))).toBe(true);
    expect(Number.isNaN(safeFloat('abc'))).toBe(true);
    expect(Number.isNaN(safeFloat(null))).toBe(true);
  });
});

describe('elementSymbol', () => {
  test('prefers the explicit element column', () => {
    expect(elementSymbol({ element: 'Zn', atomName: 'ZN' })).toBe('Zn');
    expect(elementSymbol({ element: ' fe ', atomName: 'X' })).toBe('Fe');
  });

  test('reads single-letter symbols from the atom name', () => {
    expect(elementSymbol({ atomName: 'N', resName: 'GLY' })).toBe('N');
    expect(elementSymbol({ atomName: 'P', resName: 'DA' })).toBe('P');
  });

  test('resolves CA as carbon in a protein residue', () => {
    expect(elementSymbol({ atomName: 'CA', resName: 'ALA' })).toBe('C');
  });

  test('resolves CA as calcium in its own residue', () => {
    expect(elementSymbol({ atomName: 'CA', resName: 'CA' })).toBe('Ca');
  });

  test('identifies metals inside a host residue', () => {
    // Heme iron and selenomethionine selenium sit in residues of another name.
    expect(elementSymbol({ atomName: 'FE', resName: 'HEM' })).toBe('Fe');
    expect(elementSymbol({ atomName: 'SE', resName: 'MSE' })).toBe('Se');
    expect(elementSymbol({ atomName: 'MO', resName: 'MOO' })).toBe('Mo');
  });

  test('strips a leading hydrogen-count digit', () => {
    expect(elementSymbol({ atomName: '1HB', resName: 'ALA' })).toBe('H');
    expect(elementSymbol({ atomName: '2HG1', resName: 'ILE' })).toBe('H');
    expect(elementSymbol({ atomName: '3HD2', resName: 'LEU' })).toBe('H');
  });

  test('does not mistake remoteness indicators for two-letter elements', () => {
    // CD1 is C-delta-1, not cadmium; ND1 is N-delta-1, not neodymium.
    expect(elementSymbol({ atomName: 'CD1', resName: 'ILE' })).toBe('C');
    expect(elementSymbol({ atomName: 'CE', resName: 'LYS' })).toBe('C');
    expect(elementSymbol({ atomName: 'ND1', resName: 'HIS' })).toBe('N');
    expect(elementSymbol({ atomName: 'SD', resName: 'MET' })).toBe('S');
    expect(elementSymbol({ atomName: 'OG', resName: 'SER' })).toBe('O');
    expect(elementSymbol({ atomName: 'NZ', resName: 'LYS' })).toBe('N');
  });

  test('resolves HG as hydrogen in a protein but holmium-style ions by residue', () => {
    expect(elementSymbol({ atomName: 'HG', resName: 'CYS' })).toBe('H');
    expect(elementSymbol({ atomName: 'HO', resName: 'HO' })).toBe('Ho');
  });

  test('identifies common monatomic ions', () => {
    expect(elementSymbol({ atomName: 'NA', resName: 'NA' })).toBe('Na');
    expect(elementSymbol({ atomName: 'CL', resName: 'CL' })).toBe('Cl');
    expect(elementSymbol({ atomName: 'K', resName: 'K' })).toBe('K');
  });

  test('handles water and nucleic-acid names', () => {
    expect(elementSymbol({ atomName: 'OW', resName: 'SOL' })).toBe('O');
    expect(elementSymbol({ atomName: 'HW1', resName: 'SOL' })).toBe('H');
    expect(elementSymbol({ atomName: "C5'", resName: 'DA' })).toBe('C');
    expect(elementSymbol({ atomName: 'OP1', resName: 'DA' })).toBe('O');
  });

  test('returns X when nothing can be inferred', () => {
    expect(elementSymbol({ atomName: '123', resName: 'UNK' })).toBe('X');
    expect(elementSymbol({})).toBe('X');
    expect(elementSymbol(null)).toBe('X');
  });
});

describe('atomicMass', () => {
  test('returns the standard atomic weight', () => {
    expect(atomicMass({ element: 'C' })).toBeCloseTo(12.011, 6);
    expect(atomicMass({ element: 'Fe' })).toBeCloseTo(55.845, 6);
  });

  test('falls back to carbon and records the unknown symbol', () => {
    const unknown = new Set();
    // An unidentifiable atom contributes nothing rather than a stand-in mass:
    // a silent substitution overstates the total and cannot be spotted in it.
    expect(atomicMass({ element: 'Xx' }, unknown)).toBe(0);
    expect(unknown.has('Xx')).toBe(true);
  });

  test('the weight table covers the biologically common elements', () => {
    for (const e of ['H', 'C', 'N', 'O', 'P', 'S', 'Na', 'Mg', 'Cl', 'K', 'Ca', 'Fe', 'Zn']) {
      expect(ATOMIC_WEIGHTS[e]).toBeGreaterThan(0);
    }
  });
});

describe('parseXYZ', () => {
  test('parses atom count, comment and coordinates', () => {
    const r = parseXYZ(WATER_XYZ);
    expect(r.atoms).toHaveLength(3);
    expect(r.comment).toBe('water molecule');
    expect(r.unit).toBe('A');
    expect(r.atoms[1].x).toBeCloseTo(0.757, 10);
  });

  test('sets the element from a valid symbol token', () => {
    const r = parseXYZ(WATER_XYZ);
    expect(elementSymbol(r.atoms[0])).toBe('O');
    expect(elementSymbol(r.atoms[1])).toBe('H');
  });

  test('honours the declared count over trailing junk', () => {
    const r = parseXYZ(`2\ncomment\nH 0 0 0\nH 1 0 0\nH 2 0 0`);
    expect(r.atoms).toHaveLength(2);
  });

  test('skips malformed records', () => {
    const r = parseXYZ(`3\nc\nO 0 0 0\nH bad 0 0\nH 1 0 0`);
    expect(r.atoms).toHaveLength(2);
  });

  test('returns an empty result for truncated input', () => {
    expect(parseXYZ('').atoms).toEqual([]);
    expect(parseXYZ('3').atoms).toEqual([]);
    expect(parseXYZ(null).atoms).toEqual([]);
  });
});

describe('parsePDB', () => {
  test('parses ATOM and HETATM records', () => {
    const r = parsePDB(MINI_PDB);
    expect(r.atoms).toHaveLength(5);
    expect(r.unit).toBe('A');
  });

  test('reads fields by column position', () => {
    const a = parsePDB(MINI_PDB).atoms[1];
    expect(a.atomName).toBe('CA');
    expect(a.resName).toBe('ALA');
    expect(a.chain).toBe('A');
    expect(a.resSeq).toBe(1);
    expect(a.x).toBeCloseTo(11.639, 10);
    expect(a.z).toBeCloseTo(-5.147, 10);
  });

  test('converts CRYST1 cell lengths from angstrom to nanometre', () => {
    const r = parsePDB(MINI_PDB);
    expect(r.box).toEqual([2, 3, 4]);
  });

  test('distinguishes ATOM from HETATM', () => {
    const r = parsePDB(MINI_PDB);
    expect(r.atoms[0].type).toBe('ATOM');
    expect(r.atoms[4].type).toBe('HETATM');
  });

  test('identifies heme iron via the element column', () => {
    const fe = parsePDB(MINI_PDB).atoms[4];
    expect(elementSymbol(fe)).toBe('Fe');
    expect(atomicMass(fe)).toBeCloseTo(55.845, 6);
  });

  test('ignores non-coordinate records', () => {
    const r = parsePDB('HEADER something\nREMARK 1 note\nEND');
    expect(r.atoms).toEqual([]);
  });

  test('skips records with unparseable coordinates', () => {
    const bad = 'ATOM      1  N   ALA A   1         xx   6.134  -6.504  1.00 20.00           N';
    expect(parsePDB(bad).atoms).toEqual([]);
  });

  test('handles CRLF line endings', () => {
    expect(parsePDB(MINI_PDB.replace(/\n/g, '\r\n')).atoms).toHaveLength(5);
  });
});

describe('parseGRO', () => {
  test('parses title, count and coordinates', () => {
    const r = parseGRO(MINI_GRO);
    expect(r.title).toBe('MD system');
    expect(r.atoms).toHaveLength(3);
    expect(r.unit).toBe('nm');
  });

  test('reads fixed-column residue and atom fields', () => {
    const a = parseGRO(MINI_GRO).atoms[0];
    expect(a.resSeq).toBe(1);
    expect(a.resName).toBe('SOL');
    expect(a.atomName).toBe('OW');
    expect(a.x).toBeCloseTo(1.0, 10);
    expect(a.z).toBeCloseTo(3.0, 10);
  });

  test('preserves velocities when present', () => {
    const a = parseGRO(MINI_GRO).atoms[0];
    expect(a.vx).toBeCloseTo(0.1, 10);
    expect(a.vy).toBeCloseTo(0.2, 10);
    expect(a.vz).toBeCloseTo(0.3, 10);
  });

  test('leaves velocities null when the columns are absent', () => {
    const noVel = `t\n    1\n    1SOL     OW    1   1.000   2.000   3.000\n   5.0   5.0   5.0`;
    expect(parseGRO(noVel).atoms[0].vx).toBeNull();
  });

  test('reads the box vector from the final line', () => {
    expect(parseGRO(MINI_GRO).box).toEqual([5, 6, 7]);
  });

  test('tolerates an empty title line without shifting indices', () => {
    const emptyTitle = `\n    1\n    1SOL     OW    1   1.000   2.000   3.000\n   5.0   5.0   5.0`;
    const r = parseGRO(emptyTitle);
    expect(r.atoms).toHaveLength(1);
    expect(r.atoms[0].atomName).toBe('OW');
  });

  test('returns an empty result for truncated input', () => {
    expect(parseGRO('title\n5').atoms).toEqual([]);
    expect(parseGRO(null).atoms).toEqual([]);
  });
});

describe('parseStructure dispatch', () => {
  test('routes by explicit format', () => {
    expect(parseStructure(MINI_PDB, 'pdb').format).toBe('pdb');
    expect(parseStructure(MINI_GRO, 'gro').format).toBe('gro');
    expect(parseStructure(WATER_XYZ, 'xyz').format).toBe('xyz');
  });

  test('routes by filename extension', () => {
    expect(parseStructure(MINI_PDB, 'protein.pdb').format).toBe('pdb');
    expect(parseStructure(MINI_PDB, '1abc.ent').format).toBe('pdb');
    expect(parseStructure(MINI_GRO, 'conf.gro').format).toBe('gro');
  });

  test('returns null for an unsupported format', () => {
    expect(parseStructure('data', 'file.mol2')).toBeNull();
  });
});

describe('geometry', () => {
  const water = parseXYZ(WATER_XYZ).atoms;

  test('geometric centre is the unweighted mean', () => {
    const c = geometricCentre(water);
    expect(c.x).toBeCloseTo(0, 10);
    expect(c.y).toBeCloseTo(0.586 * 2 / 3, 10);
  });

  test('centre of mass is pulled toward the oxygen', () => {
    // Oxygen carries 16/18 of the mass, so the COM sits far below the centroid.
    const com = centreOfMass(water);
    expect(com.y).toBeCloseTo((2 * 1.008 * 0.586) / 18.015, 8);
    expect(com.y).toBeLessThan(geometricCentre(water).y);
  });

  test('total mass matches the molecular weight of water', () => {
    expect(centreOfMass(water).mass).toBeCloseTo(18.015, 3);
  });

  test('bounding box spans the coordinate extremes', () => {
    const bb = boundingBox(water);
    expect(bb.minX).toBeCloseTo(-0.757, 10);
    expect(bb.maxX).toBeCloseTo(0.757, 10);
    expect(bb.minZ).toBe(0);
  });

  test('radius of gyration is positive and smaller than the extent', () => {
    const rg = radiusOfGyration(water);
    expect(rg).toBeGreaterThan(0);
    expect(rg).toBeLessThan(1.6);
  });

  test('radius of gyration of a single atom is zero', () => {
    expect(radiusOfGyration([{ x: 1, y: 2, z: 3, element: 'C' }])).toBeCloseTo(0, 10);
  });

  test('degenerate input yields the origin rather than NaN', () => {
    expect(geometricCentre([])).toEqual({ x: 0, y: 0, z: 0 });
    expect(centreOfMass([]).mass).toBe(0);
    expect(boundingBox([]).maxX).toBe(0);
  });
});

describe('rotation', () => {
  const point = [{ x: 1, y: 0, z: 0, vx: null }];
  const origin = { x: 0, y: 0, z: 0 };

  test('90 degrees about z maps x onto y', () => {
    const r = rotateAtoms(point, 0, 0, 90, origin)[0];
    expect(r.x).toBeCloseTo(0, 10);
    expect(r.y).toBeCloseTo(1, 10);
    expect(r.z).toBeCloseTo(0, 10);
  });

  test('90 degrees about y maps x onto negative z', () => {
    const r = rotateAtoms(point, 0, 90, 0, origin)[0];
    expect(r.z).toBeCloseTo(-1, 10);
  });

  test('a full turn is the identity', () => {
    const r = rotateAtoms(point, 360, 360, 360, origin)[0];
    expect(r.x).toBeCloseTo(1, 10);
    expect(r.y).toBeCloseTo(0, 10);
  });

  test('zero rotation leaves coordinates untouched', () => {
    const r = rotateAtoms(point, 0, 0, 0, origin)[0];
    expect(r.x).toBeCloseTo(1, 12);
  });

  test('the matrix is orthonormal', () => {
    const m = rotationMatrix(30, 45, 60);
    // Each row must be a unit vector.
    for (let i = 0; i < 3; i++) {
      const norm = m[i * 3] ** 2 + m[i * 3 + 1] ** 2 + m[i * 3 + 2] ** 2;
      expect(norm).toBeCloseTo(1, 10);
    }
  });

  test('rotation preserves interatomic distances', () => {
    const water = parseXYZ(WATER_XYZ).atoms;
    const d0 = Math.hypot(
      water[0].x - water[1].x, water[0].y - water[1].y, water[0].z - water[1].z
    );
    const rot = rotateAtoms(water, 37, -22, 88, origin);
    const d1 = Math.hypot(
      rot[0].x - rot[1].x, rot[0].y - rot[1].y, rot[0].z - rot[1].z
    );
    expect(d1).toBeCloseTo(d0, 10);
  });

  test('rotation about a pivot leaves the pivot fixed', () => {
    const pivot = { x: 5, y: 5, z: 5 };
    const at = [{ x: 5, y: 5, z: 5, vx: null }];
    const r = rotateAtoms(at, 45, 45, 45, pivot)[0];
    expect(r.x).toBeCloseTo(5, 10);
    expect(r.y).toBeCloseTo(5, 10);
  });

  test('velocities rotate but are not translated', () => {
    const moving = [{ x: 10, y: 0, z: 0, vx: 1, vy: 0, vz: 0 }];
    const r = rotateAtoms(moving, 0, 0, 90, { x: 5, y: 0, z: 0 })[0];
    expect(r.vx).toBeCloseTo(0, 10);
    expect(r.vy).toBeCloseTo(1, 10);
  });

  test('does not mutate the input array', () => {
    const at = [{ x: 1, y: 0, z: 0, vx: null }];
    rotateAtoms(at, 0, 0, 90, origin);
    expect(at[0].x).toBe(1);
  });
});

describe('translation and scaling', () => {
  const atoms = [{ x: 1, y: 2, z: 3, vx: null }, { x: 4, y: 5, z: 6, vx: null }];

  test('translation shifts every atom', () => {
    const t = translateAtoms(atoms, 10, 20, 30);
    expect(t[0].x).toBe(11);
    expect(t[1].z).toBe(36);
  });

  test('centring puts the geometric centre at the origin', () => {
    const c = centreAtoms(atoms, 'geometric');
    const g = geometricCentre(c);
    expect(g.x).toBeCloseTo(0, 10);
    expect(g.y).toBeCloseTo(0, 10);
  });

  test('mass centring puts the centre of mass at the origin', () => {
    const water = parseXYZ(WATER_XYZ).atoms;
    const c = centreAtoms(water, 'mass');
    expect(centreOfMass(c).y).toBeCloseTo(0, 10);
  });

  test('scaling multiplies coordinates and velocities alike', () => {
    const moving = [{ x: 1, y: 2, z: 3, vx: 1, vy: 1, vz: 1 }];
    const s = scaleAtoms(moving, 10);
    expect(s[0].x).toBe(10);
    expect(s[0].vx).toBe(10);
  });

  test('transforms do not mutate their input', () => {
    translateAtoms(atoms, 1, 1, 1);
    scaleAtoms(atoms, 5);
    expect(atoms[0].x).toBe(1);
  });
});

describe('units and boxes', () => {
  test('conversion factors are reciprocal', () => {
    expect(unitFactor('nm', 'A')).toBe(10);
    expect(unitFactor('A', 'nm')).toBeCloseTo(0.1, 12);
    expect(unitFactor('A', 'A')).toBe(1);
  });

  test('gro is nanometre and the others are angstrom', () => {
    expect(targetUnit('gro')).toBe('nm');
    expect(targetUnit('pdb')).toBe('A');
    expect(targetUnit('xyz')).toBe('A');
  });

  test('box from bounds applies padding and converts to nm', () => {
    const atoms = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 20, z: 30 }];
    const box = computeBoxFromBounds(atoms, 'A', 10);
    // 10 A = 1 nm, plus 10% padding.
    expect(box[0]).toBeCloseTo(1.1, 10);
    expect(box[2]).toBeCloseTo(3.3, 10);
  });

  test('a planar system still yields a valid minimum box', () => {
    const flat = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }];
    expect(computeBoxFromBounds(flat, 'A', 10)[2]).toBe(MIN_BOX_NM);
  });

  test('detects a structure overflowing its box', () => {
    const atoms = [{ x: 0, y: 0, z: 0 }, { x: 100, y: 1, z: 1 }];
    const fit = boxFitsStructure(atoms, 'A', [1, 5, 5]);
    expect(fit.fits).toBe(false);
    expect(fit.overflow).toContain('x');
  });

  test('accepts a structure that fits', () => {
    const atoms = [{ x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 }];
    expect(boxFitsStructure(atoms, 'A', [5, 5, 5]).fits).toBe(true);
  });
});

describe('output formatting', () => {
  test('padStr pads and truncates to an exact width', () => {
    expect(padStr('ab', 5)).toBe('   ab');
    expect(padStr('ab', 5, true)).toBe('ab   ');
    expect(padStr('abcdefg', 3)).toBe('abc');
  });

  test('XYZ output round-trips through the parser', () => {
    const atoms = parseXYZ(WATER_XYZ).atoms;
    const out = formatXYZ(atoms);
    const back = parseXYZ(out);
    expect(back.atoms).toHaveLength(3);
    expect(back.atoms[1].x).toBeCloseTo(0.757, 5);
  });

  test('PDB output round-trips and preserves residue identity', () => {
    const r = parsePDB(MINI_PDB);
    const back = parsePDB(formatPDB(r.atoms, { box: r.box }));
    expect(back.atoms).toHaveLength(5);
    expect(back.atoms[1].atomName).toBe('CA');
    expect(back.atoms[1].resName).toBe('ALA');
    expect(back.atoms[1].x).toBeCloseTo(11.639, 3);
  });

  test('PDB output writes CRYST1 back in angstrom', () => {
    const out = formatPDB([], { box: [2, 3, 4] });
    expect(out).toContain('CRYST1');
    expect(parsePDB(out).box).toEqual([2, 3, 4]);
  });

  test('GRO output round-trips including velocities and box', () => {
    const r = parseGRO(MINI_GRO);
    const back = parseGRO(formatGRO(r.atoms, { box: r.box }));
    expect(back.atoms).toHaveLength(3);
    expect(back.atoms[0].vx).toBeCloseTo(0.1, 4);
    expect(back.box).toEqual([5, 6, 7]);
  });

  test('GRO omits velocities when they are not present on every atom', () => {
    const mixed = [
      { resSeq: 1, resName: 'A', atomName: 'X', serial: 1, x: 0, y: 0, z: 0, vx: 1, vy: 1, vz: 1 },
      { resSeq: 1, resName: 'A', atomName: 'Y', serial: 2, x: 1, y: 1, z: 1, vx: null }
    ];
    const lines = formatGRO(mixed, { box: [1, 1, 1] }).split('\n');
    expect(lines[2].length).toBeLessThan(50);
  });

  test('formatStructure converts units between formats', () => {
    // A GRO structure (nm) exported as PDB must be scaled to angstrom.
    const gro = parseGRO(MINI_GRO);
    const pdb = parsePDB(formatStructure(gro.atoms, 'pdb', { sourceUnit: 'nm' }));
    expect(pdb.atoms[0].x).toBeCloseTo(10.0, 3);
  });

  test('formatStructure leaves matching units unscaled', () => {
    const xyz = parseXYZ(WATER_XYZ);
    const out = parseXYZ(formatStructure(xyz.atoms, 'xyz', { sourceUnit: 'A' }));
    expect(out.atoms[1].x).toBeCloseTo(0.757, 5);
  });

  test('formatStructure returns an empty string for an unknown format', () => {
    expect(formatStructure([], 'mol2')).toBe('');
  });
});

describe('structureStats', () => {
  test('counts atoms, residues and chains', () => {
    const s = structureStats(parsePDB(MINI_PDB).atoms);
    expect(s.nAtoms).toBe(5);
    expect(s.nResidues).toBe(2);
    expect(s.nChains).toBe(1);
  });

  test('tallies element composition', () => {
    const s = structureStats(parsePDB(MINI_PDB).atoms);
    expect(s.elements.C).toBe(2);
    expect(s.elements.N).toBe(1);
    expect(s.elements.Fe).toBe(1);
  });

  test('reports total mass including the metal', () => {
    const s = structureStats(parsePDB(MINI_PDB).atoms);
    expect(s.totalMass).toBeGreaterThan(55.845);
  });

  test('handles an empty structure', () => {
    const s = structureStats([]);
    expect(s.nAtoms).toBe(0);
    expect(s.totalMass).toBe(0);
  });
});

/*
 * Triclinic cells. A solvated system is normally built in a rhombic
 * dodecahedron or truncated octahedron rather than a rectangular box, and
 * both are triclinic: a `.gro` file then carries nine box components and a
 * PDB CRYST1 record carries angles other than 90. Reading only the diagonal
 * silently converts the cell to a rectangular one, which changes the system
 * rather than just how it is described.
 */
describe('triclinic cells', () => {
  const DODEC = [5, 5, 5, 60, 60, 90];   // a, b, c, alpha, beta, gamma

  test('converts lengths and angles to GROMACS vectors', () => {
    const v = boxVectorsFromAngles(...DODEC);
    expect(v).toHaveLength(9);
    // GROMACS requires a lower-triangular cell: v1y, v1z and v2z are zero.
    expect(v[3]).toBeCloseTo(0, 10);
    expect(v[4]).toBeCloseTo(0, 10);
    expect(v[6]).toBeCloseTo(0, 10);
    expect(v[0]).toBeCloseTo(5, 10);
  });

  test('recovers the lengths and angles again', () => {
    const back = anglesFromBoxVectors(boxVectorsFromAngles(...DODEC));
    expect(back.a).toBeCloseTo(5, 6);
    expect(back.b).toBeCloseTo(5, 6);
    expect(back.c).toBeCloseTo(5, 6);
    expect(back.alpha).toBeCloseTo(60, 6);
    expect(back.beta).toBeCloseTo(60, 6);
    expect(back.gamma).toBeCloseTo(90, 6);
  });

  test('recognises a rectangular cell as not triclinic', () => {
    expect(isTriclinic(boxVectorsFromAngles(4, 4, 4, 90, 90, 90))).toBe(false);
    expect(isTriclinic(boxVectorsFromAngles(...DODEC))).toBe(true);
    expect(isTriclinic([4, 4, 4])).toBe(false);
    expect(isTriclinic(null)).toBe(false);
  });

  test('keeps all nine components when reading a .gro file', () => {
    const v = boxVectorsFromAngles(...DODEC).map(x => x.toFixed(5)).join(' ');
    const gro = ['sys', '1', '    1ALA      N    1   1.000   1.000   1.000', '  ' + v].join('\n');
    const r = parseStructure(gro, 't.gro');
    expect(isTriclinic(r.boxVectors)).toBe(true);
    expect(r.boxVectors[8]).toBeCloseTo(2.5, 4);
  });

  test('writes nine components back out to .gro', () => {
    const v = boxVectorsFromAngles(...DODEC).map(x => x.toFixed(5)).join(' ');
    const gro = ['sys', '1', '    1ALA      N    1   1.000   1.000   1.000', '  ' + v].join('\n');
    const r = parseStructure(gro, 't.gro');
    const out = formatStructure(r.atoms, 'gro', {
      sourceUnit: r.unit, box: r.box, boxVectors: r.boxVectors, title: r.title
    });
    expect(out.trim().split('\n').pop().trim().split(/\s+/)).toHaveLength(9);
  });

  test('a rectangular cell still writes only three components', () => {
    const gro = ['sys', '1', '    1ALA      N    1   1.0   1.0   1.0', '   4.0 4.0 4.0'].join('\n');
    const r = parseStructure(gro, 't.gro');
    const out = formatStructure(r.atoms, 'gro', {
      sourceUnit: r.unit, box: r.box, boxVectors: r.boxVectors, title: r.title
    });
    expect(out.trim().split('\n').pop().trim().split(/\s+/)).toHaveLength(3);
  });

  test('CRYST1 carries the true edge lengths and angles', () => {
    const v = boxVectorsFromAngles(...DODEC).map(x => x.toFixed(5)).join(' ');
    const gro = ['sys', '1', '    1ALA      N    1   1.000   1.000   1.000', '  ' + v].join('\n');
    const r = parseStructure(gro, 't.gro');
    const cryst = formatStructure(r.atoms, 'pdb', {
      sourceUnit: r.unit, box: r.box, boxVectors: r.boxVectors
    }).split('\n')[0];
    // The third edge is 50 A long even though the cell is only 35.4 A deep.
    expect(cryst).toMatch(/^CRYST1\s+50\.000\s+50\.000\s+50\.000\s+60\.00\s+60\.00\s+90\.00/);
  });

  test('a triclinic cell survives gro to pdb and back', () => {
    const v = boxVectorsFromAngles(...DODEC).map(x => x.toFixed(5)).join(' ');
    const gro = ['sys', '1', '    1ALA      N    1   1.000   1.000   1.000', '  ' + v].join('\n');
    const first = parseStructure(gro, 't.gro');
    const pdb = formatStructure(first.atoms, 'pdb', {
      sourceUnit: first.unit, box: first.box, boxVectors: first.boxVectors
    });
    const second = parseStructure(pdb, 't.pdb');
    expect(isTriclinic(second.boxVectors)).toBe(true);
    for (let i = 0; i < 9; i++) {
      expect(second.boxVectors[i]).toBeCloseTo(first.boxVectors[i], 3);
    }
  });

  test('a rectangular CRYST1 does not become triclinic', () => {
    const pdb = 'CRYST1   40.000   40.000   40.000  90.00  90.00  90.00 P 1           1\n' +
                'ATOM      1  N   ALA A   1      10.000  10.000  10.000  1.00  0.00           N\nEND';
    const r = parseStructure(pdb, 't.pdb');
    expect(r.boxVectors).toBeNull();
  });
});

/*
 * Mass accounting. A coordinate file contains entries that are not nuclei , 
 * TIP4P and TIP5P water carry a massless charge site, dummy-mass constructions
 * add others, and it may contain atoms whose element cannot be determined.
 * Neither should quietly contribute a made-up mass to the total.
 */
describe('mass accounting', () => {
  const tip4p = [
    { atomName: 'OW', resName: 'SOL', x: 0, y: 0, z: 0 },
    { atomName: 'HW1', resName: 'SOL', x: 0.1, y: 0, z: 0 },
    { atomName: 'HW2', resName: 'SOL', x: 0, y: 0.1, z: 0 },
    { atomName: 'MW', resName: 'SOL', x: 0.02, y: 0.02, z: 0 }
  ];

  test('a virtual site is recognised and weighs nothing', () => {
    expect(isVirtualSite({ atomName: 'MW' })).toBe(true);
    expect(isVirtualSite({ atomName: 'LP' })).toBe(true);
    expect(isVirtualSite({ atomName: 'CA' })).toBe(false);
    expect(atomicMass({ atomName: 'MW', resName: 'SOL' })).toBe(0);
  });

  test('TIP4P water weighs what water weighs', () => {
    expect(centreOfMass(tip4p).mass).toBeCloseTo(18.015, 3);
  });

  test('an unidentifiable atom contributes nothing and is reported', () => {
    const unknown = new Set();
    expect(atomicMass({ element: 'Zq' }, unknown)).toBe(0);
    expect([...unknown]).toContain('Zq');
  });

  test('the breakdown accounts for every atom', () => {
    const b = massBreakdown(tip4p);
    const counted = b.rows.reduce((s, r) => s + r.count, 0);
    expect(counted + b.virtualSites +
           b.unidentified.reduce((s, u) => s + u.count, 0)).toBe(b.atoms);
  });

  test('the breakdown subtotals sum to the reported total', () => {
    const b = massBreakdown(tip4p);
    expect(b.rows.reduce((s, r) => s + r.subtotal, 0)).toBeCloseTo(b.total, 9);
    expect(b.total).toBeCloseTo(centreOfMass(tip4p).mass, 9);
  });

  test('the breakdown names the weight used for each element', () => {
    const o = massBreakdown(tip4p).rows.find(r => r.symbol === 'O');
    expect(o.count).toBe(1);
    expect(o.weight).toBeCloseTo(15.999, 3);
    expect(o.subtotal).toBeCloseTo(15.999, 3);
  });

  test('virtual sites and unknowns are counted separately', () => {
    const b = massBreakdown([...tip4p, { atomName: 'ZZ', resName: 'XXX' }]);
    expect(b.virtualSites).toBe(1);
    expect(b.unidentified.length).toBe(1);
  });

  test('an empty structure yields an empty breakdown', () => {
    const b = massBreakdown([]);
    expect(b.rows).toEqual([]);
    expect(b.total).toBe(0);
    expect(b.atoms).toBe(0);
  });
});

/*
 * The weights table is a published dataset, not a convenience list, so a few
 * values are pinned. Zirconium, gadolinium and lutetium were revised by CIAAW
 * in 2024, and argon's abridged value of 39.95 replaced the 39.948 that older
 * tables carry; each is easy to reintroduce from a stale source.
 */
describe('atomic weights follow CIAAW 2024', () => {
  test('carries the 2024 revisions', () => {
    expect(ATOMIC_WEIGHTS.Zr).toBeCloseTo(91.222, 6);
    expect(ATOMIC_WEIGHTS.Gd).toBeCloseTo(157.249, 6);
    expect(ATOMIC_WEIGHTS.Lu).toBeCloseTo(174.96669, 6);
  });

  test('argon uses the abridged interval value, not the pre-2021 figure', () => {
    expect(ATOMIC_WEIGHTS.Ar).toBeCloseTo(39.95, 6);
    expect(ATOMIC_WEIGHTS.Ar).not.toBeCloseTo(39.948, 6);
  });

  test('the biologically common elements match the published values', () => {
    expect(ATOMIC_WEIGHTS.H).toBeCloseTo(1.008, 6);
    expect(ATOMIC_WEIGHTS.C).toBeCloseTo(12.011, 6);
    expect(ATOMIC_WEIGHTS.N).toBeCloseTo(14.007, 6);
    expect(ATOMIC_WEIGHTS.O).toBeCloseTo(15.999, 6);
    expect(ATOMIC_WEIGHTS.P).toBeCloseTo(30.973761998, 9);
    expect(ATOMIC_WEIGHTS.S).toBeCloseTo(32.06, 6);
  });

  test('elements with no standard weight are absent rather than invented', () => {
    // Technetium is the deliberate exception: no stable isotope, so the mass
    // number of the longest-lived one stands in.
    expect(ATOMIC_WEIGHTS.Tc).toBe(98);
    for (const sym of ['Pm', 'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Np', 'Pu']) {
      expect(ATOMIC_WEIGHTS[sym]).toBeUndefined();
    }
  });
});
