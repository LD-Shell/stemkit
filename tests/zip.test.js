import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { crc32, buildZip } from '../src/core/zip.js';

const HAVE_UNZIP = spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0;

describe('crc32', () => {
  test('known values', () => {
    expect(crc32(new TextEncoder().encode(''))).toBe(0);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xCBF43926);
    expect(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414FA339);
  });
});

describe('buildZip', () => {
  const files = [
    { path: 'job.sh', text: '#!/bin/bash\necho hi\n', executable: true },
    { path: 'w0/plumed.dat', text: 'd: DISTANCE ATOMS=1,2\n' },
    { path: 'README.md', text: '# Notes\n\nÅngström.\n' }
  ];

  test('is a zip with one entry per file', () => {
    const z = buildZip(files, { date: new Date(2026, 0, 2, 3, 4, 6) });
    expect(z[0]).toBe(0x50);
    expect(z[1]).toBe(0x4B);
    const dv = new DataView(z.buffer, z.length - 22);
    expect(dv.getUint32(0, true)).toBe(0x06054B50);
    expect(dv.getUint16(10, true)).toBe(3);
  });

  test('drops an empty or repeated path', () => {
    const z = buildZip([{ path: 'a', text: '1' }, { path: 'a', text: '2' }, { path: '', text: '3' }]);
    const dv = new DataView(z.buffer, z.length - 22);
    expect(dv.getUint16(10, true)).toBe(1);
    expect(buildZip([]).length).toBe(22);
  });

  test('unzip reads it back, with the script executable', () => {
    if (!HAVE_UNZIP) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-zip-'));
    const file = path.join(dir, 'kit.zip');
    fs.writeFileSync(file, buildZip(files));
    const t = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    expect(t.stdout).toContain('No errors detected');
    const x = spawnSync('unzip', ['-o', '-q', file, '-d', dir], { encoding: 'utf8' });
    expect(x.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'w0', 'plumed.dat'), 'utf8')).toBe('d: DISTANCE ATOMS=1,2\n');
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toContain('Ångström');
    expect(fs.statSync(path.join(dir, 'job.sh')).mode & 0o111).toBe(0o111);
    expect(fs.statSync(path.join(dir, 'README.md')).mode & 0o111).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
