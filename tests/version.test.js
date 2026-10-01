import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEMKIT_VERSION, RELEASE_DATE } from '../src/core/version.js';
import * as core from '../src/core/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('release version', () => {
  test('matches package.json', () => {
    expect(STEMKIT_VERSION).toBe(JSON.parse(read('package.json')).version);
  });

  test('release date is a real ISO date', () => {
    expect(RELEASE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${RELEASE_DATE}T00:00:00Z`).toISOString().slice(0, 10)).toBe(RELEASE_DATE);
  });

  test('matches CITATION.cff', () => {
    const cff = read('CITATION.cff');
    expect(cff).toMatch(new RegExp(`^version: v?${STEMKIT_VERSION.replace(/\./g, '\\.')}\\s*$`, 'm'));
    expect(cff).toMatch(new RegExp(`^date-released: "?${RELEASE_DATE}"?\\s*$`, 'm'));
  });

  test('the changelog has a section for it', () => {
    const heading = new RegExp(`^## v${STEMKIT_VERSION.replace(/\./g, '\\.')} — ${RELEASE_DATE}\\s*$`, 'm');
    expect(read('CHANGELOG.md')).toMatch(heading);
  });

  test('exported by the core, flat and as a namespace', () => {
    expect(core.STEMKIT_VERSION).toBe(STEMKIT_VERSION);
    expect(core.RELEASE_DATE).toBe(RELEASE_DATE);
    expect(core.Version.STEMKIT_VERSION).toBe(STEMKIT_VERSION);
    expect(core.Version.RELEASE_DATE).toBe(RELEASE_DATE);
  });
});
