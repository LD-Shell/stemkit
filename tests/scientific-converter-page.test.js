/**
 * The pure helpers behind the Scientific Converter page
 * (js/scientific-converter.js): reading what was typed into a field, the
 * sentence shown when it is not a number, and how a result is written. The
 * page itself is checked in a browser; these are the parts that decide what
 * it shows.
 */

import { describe, test, expect } from '@jest/globals';
import { parseInput, inputMessage, formatResult } from '../js/scientific-converter.js';

const value = text => {
  const parsed = parseInput(text);
  return parsed.ok ? parsed.value : parsed.reason;
};

describe('parseInput', () => {
  test('ordinary decimals', () => {
    expect(value('1.5')).toBe(1.5);
    expect(value('42')).toBe(42);
    expect(value('-273.15')).toBe(-273.15);
    expect(value('+7')).toBe(7);
    expect(value('0')).toBe(0);
    expect(value('-0.0')).toBe(-0);
    expect(value('007')).toBe(7);
  });

  test('a point with digits on one side only', () => {
    expect(value('5.')).toBe(5);
    expect(value('.5')).toBe(0.5);
    expect(value('-.25')).toBe(-0.25);
  });

  test('exponents, in either case, with or without a sign', () => {
    expect(value('-2e-3')).toBe(-0.002);
    expect(value('1.5E3')).toBe(1500);
    expect(value('1e+3')).toBe(1000);
    expect(value('6.02214076e23')).toBe(6.02214076e23);
    expect(value('.5e1')).toBe(5);
  });

  test('white space around the number is ignored', () => {
    expect(value('  1.5\t')).toBe(1.5);
    expect(value('\n298.15 ')).toBe(298.15);
  });

  test('the typographic minus of a pasted number is a minus', () => {
    expect(value('\u22122.5')).toBe(-2.5);
    expect(value('1.5e\u22123')).toBe(0.0015);
  });

  test('thousands separators, where they can be nothing else', () => {
    expect(value('1,234,567')).toBe(1234567);
    expect(value('1,234.5')).toBe(1234.5);
    expect(value('12,345.')).toBe(12345);
    expect(value('-1,234,567.25')).toBe(-1234567.25);
    expect(value('1,234,567e2')).toBe(123456700);
    expect(value('1,234.5e-1')).toBe(123.45);
  });

  test('one comma and no point could be a decimal comma: refused, with both readings', () => {
    // The page used to drop every comma, so 1,5 became 15.
    expect(parseInput('1,5')).toEqual({ ok: false, reason: 'comma', readings: ['1.5', '15'] });
    expect(parseInput('1,500')).toEqual({ ok: false, reason: 'comma', readings: ['1.500', '1500'] });
    expect(parseInput('-0,25')).toEqual({ ok: false, reason: 'comma', readings: ['-0.25', '-25'] });
    expect(parseInput('1,234')).toEqual({ ok: false, reason: 'comma', readings: ['1.234', '1234'] });
  });

  test('commas anywhere else are refused', () => {
    for (const text of ['1,23,456', '12,34.5', '1234,567.5', '1,234,56', '0,123,456', '1.234,5', '1,,234.5',
      ',5', '5,', '1,234e5', '1.5,000', '1,234.5,6', '1e1,000']) {
      expect(parseInput(text).ok).toBe(false);
      expect(parseInput(text).reason).toBe('comma');
    }
  });

  test('what Number() would have taken, but is not a decimal number', () => {
    for (const text of ['0x10', '0b11', '0o17', 'Infinity', '-Infinity', 'NaN', '1e', '1e-', '1e+', 'e5',
      '-', '+', '.', '-.', '1.2.3', '1 000', '1.5 e3', '--1', '1e5.5', '1_000', 'abc', '12abc', '1.5e3e2']) {
      expect(value(text)).toBe('format');
    }
  });

  test('nothing typed is empty, not an error', () => {
    expect(value('')).toBe('empty');
    expect(value('   ')).toBe('empty');
  });

  test('a number a double cannot hold is out of range', () => {
    expect(value('1e999')).toBe('range');
    expect(value('-1e999')).toBe('range');
    expect(value('1e-999')).toBe('range');
    expect(value('1,000,000e999')).toBe('range');
    // Zero is zero whatever its exponent.
    expect(value('0e999')).toBe(0);
    expect(value('0.000e-999')).toBe(0);
  });
});

describe('inputMessage', () => {
  test('nothing to say about a number or an empty field', () => {
    expect(inputMessage(parseInput('1.5'))).toBe('');
    expect(inputMessage(parseInput(''))).toBe('');
  });

  test('an ambiguous comma is answered with the two readings', () => {
    expect(inputMessage(parseInput('1,5'))).toBe('A comma here could mean 1.5 or 15. Type the one you mean.');
  });

  test('each other reason says how to type the number', () => {
    expect(inputMessage(parseInput('1,23,456'))).toBe('Commas only work between groups of three digits, as in 1,234,567 or 1,234.5.');
    expect(inputMessage(parseInput('0x10'))).toBe('Type a number such as 1234.5 or 1.5e-3.');
    expect(inputMessage(parseInput('1e999'))).toBe('This number is too large or too small to convert.');
  });
});

describe('formatResult', () => {
  test('zero is shown as 0', () => {
    // 273.15 K is 0 degC; the field used to be left blank.
    expect(formatResult(0)).toBe('0');
    expect(formatResult(-0)).toBe('0');
  });

  test('a value with no finite answer is blank', () => {
    expect(formatResult(NaN)).toBe('');
    expect(formatResult(Infinity)).toBe('');
  });

  test('up to eight decimal places, trailing zeros trimmed', () => {
    expect(formatResult(27.211386245988)).toBe('27.21138625');
    expect(formatResult(219474.6313632)).toBe('219474.6313632');
    expect(formatResult(100)).toBe('100');
    expect(formatResult(-40)).toBe('-40');
    expect(formatResult(99.99999999999999)).toBe('100');
  });

  test('exponential notation above 1e7 and below 1e-4', () => {
    expect(formatResult(4.3597447222071e-18)).toBe('4.359745e-18');
    expect(formatResult(1e9)).toBe('1.000000e+9');
    expect(formatResult(1e7)).toBe('10000000');
    expect(formatResult(0.0001)).toBe('0.0001');
    expect(formatResult(-0.00009)).toBe('-9.000000e-5');
  });
});
