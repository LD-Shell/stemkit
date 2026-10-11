import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A number typed into a style field ("2.6", "10", "123") must not be written
 * over while it is being typed. Typing is checked in a browser; here the
 * handler is held to the two rules that make it so: nothing is applied while
 * what is typed is outside the field's limits, and a field with focus is not
 * redrawn until Enter or leaving it.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'figure-plot.js'), 'utf8');
const body = src.slice(src.indexOf('function number(path, label'), src.indexOf('function text(path, label'));

describe('numeric style fields', () => {
  test('a value outside the limits is not applied while it is typed', () => {
    expect(body).toMatch(/const inRange = \(\) =>/);
    expect(body).toMatch(/listen\(input, 'input', \(\) => \{ if \(inRange\(\)\) later\(path, apply\)/);
  });
  test('a field with focus is left alone until it is committed', () => {
    expect(body).toMatch(/if \(!force && document\.activeElement === input\) return;/);
    expect(body).toMatch(/apply\(\); show\(true\);/);
  });
});
