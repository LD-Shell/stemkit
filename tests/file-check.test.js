/**
 * Which files a page reads (js/file-check.js): the extensions it names, and
 * text only. A workbook opened in the Curve Fitter used to be read as text,
 * which put the bytes of a zip archive in the data box; these are the checks
 * that refuse it, and the ones that hold every page to the same rule. What a
 * page shows when it refuses a file is checked in a browser.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extensionOf, listExtensions, looksBinary, whyNotRead, fileRefusal, decodeText, encodingName, readTextFile
} from '../js/file-check.js';
import { buildZip } from '../src/core/zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const bytes = (...parts) => Uint8Array.from(parts.flatMap(p => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)));
const utf8 = text => new TextEncoder().encode(text);
const utf16 = (text, big = false) => {
  const out = new Uint8Array(2 + text.length * 2);
  out.set(big ? [0xfe, 0xff] : [0xff, 0xfe]);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out.set(big ? [c >> 8, c & 0xff] : [c & 0xff, c >> 8], 2 + 2 * i);
  }
  return out;
};

const TABLE = 'Time (s),Signal (mV)\r\n0,3.59\r\n0.25,3.2\r\n';
// The parts every .xlsx has, zipped by the core's own writer.
const WORKBOOK = buildZip([
  { path: '[Content_Types].xml', text: '<Types/>' },
  { path: 'xl/workbook.xml', text: '<workbook/>' },
  { path: 'xl/worksheets/sheet1.xml', text: '<worksheet><sheetData/></worksheet>' }
]);
// How an Excel 97-2003 file starts: the compound-file signature, then a zeroed class id.
const OLD_WORKBOOK = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], new Array(16).fill(0), [0x3e, 0x00, 0x03, 0x00]);
const PNG = bytes([0x89], 'PNG\r\n', [0x1a, 0x0a, 0, 0, 0, 0x0d], 'IHDR');

describe('extensionOf', () => {
  test('lower case, the last one, without the dot', () => {
    expect(extensionOf('decay.csv')).toBe('csv');
    expect(extensionOf('DECAY.XLSX')).toBe('xlsx');
    expect(extensionOf('run.1.dat')).toBe('dat');
    expect(extensionOf('C:\\data\\run 2.TXT')).toBe('txt');
  });

  test('a name with no extension has none', () => {
    for (const name of ['COLVAR', '.bashrc', 'in.d/data', '', null, undefined]) expect(extensionOf(name)).toBe('');
  });
});

test('listExtensions names them as a page does', () => {
  expect(listExtensions(['csv'])).toBe('.csv');
  expect(listExtensions(['bib', 'txt'])).toBe('.bib or .txt');
  expect(listExtensions(['csv', 'tsv', 'txt', 'dat'])).toBe('.csv, .tsv, .txt or .dat');
});

describe('looksBinary', () => {
  test('a workbook, an old workbook, an image and a PDF are not text', () => {
    expect(looksBinary(WORKBOOK)).toBe(true);
    expect(looksBinary(OLD_WORKBOOK)).toBe(true);
    expect(looksBinary(PNG)).toBe(true);
    // No NUL byte in sight: a PDF is known by how it starts.
    expect(looksBinary(utf8('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'))).toBe(true);
  });

  test('text is text in every encoding a spreadsheet saves', () => {
    expect(looksBinary(utf8(TABLE))).toBe(false);
    expect(looksBinary(bytes([0xef, 0xbb, 0xbf], TABLE))).toBe(false);                 // CSV UTF-8
    expect(looksBinary(bytes('Signal (', [0xb5], 'V),Temp (', [0xb0], 'C)\r\n1,2\r\n'))).toBe(false);  // Windows-1252
    expect(looksBinary(utf16('Time (s)\tSignal (\u00b5V)\r\n0\t3.59\r\n'))).toBe(false);        // Unicode Text
    expect(looksBinary(utf16('Time (s)\tSignal (\u00b5V)\r\n0\t3.59\r\n', true))).toBe(false);
    expect(looksBinary(utf8('0;1,5\n1;2,25\n'))).toBe(false);
    expect(looksBinary(utf8('# t y\n0 1\n\f1 2\n\x1a'))).toBe(false);                    // a form feed, a DOS end-of-file mark
  });

  test('nothing at all is not binary, and an ArrayBuffer is read as its bytes', () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false);
    expect(looksBinary(null)).toBe(false);
    expect(looksBinary(WORKBOOK.buffer.slice(WORKBOOK.byteOffset, WORKBOOK.byteOffset + WORKBOOK.byteLength))).toBe(true);
  });

  test('a byte-order mark does not excuse a NUL character', () => {
    expect(looksBinary(bytes([0xff, 0xfe], 'a', [0], [0, 0], 'b', [0]))).toBe(true);
  });

  test('only the start of the file is judged', () => {
    const long = new Uint8Array(9000).fill(0x31);
    long[8500] = 0;
    expect(looksBinary(long)).toBe(false);
    long[100] = 0;
    expect(looksBinary(long)).toBe(true);
  });
});

describe('whyNotRead', () => {
  const fitter = { extensions: ['csv', 'tsv', 'txt', 'dat', 'xvg'], sheet: 'paste' };

  test('a workbook is named for what it is, with what to do instead', () => {
    expect(whyNotRead('decay.xlsx', null, fitter))
      .toBe('decay.xlsx is an Excel workbook, not a text file. Save the sheet as CSV and open that, or copy its cells and paste them here.');
    expect(whyNotRead('Decay.XLS', null, { extensions: ['xvg', 'csv'], sheet: 'open' }))
      .toBe('Decay.XLS is an Excel workbook, not a text file. Save the sheet as CSV and open that.');
    expect(whyNotRead('decay.ods', null, fitter)).toMatch(/^decay\.ods is an OpenDocument spreadsheet, not a text file\. Save/);
    expect(whyNotRead('decay.numbers', null, fitter)).toMatch(/^decay\.numbers is a Numbers spreadsheet, not a text file\. Save/);
  });

  test('where a sheet is not what the page reads, it names what the page does read', () => {
    expect(whyNotRead('refs.xlsx', null, { extensions: ['bib', 'txt'] }))
      .toBe('refs.xlsx is an Excel workbook, not a text file. Choose a .bib or .txt file.');
    expect(whyNotRead('refs.xlsx', null)).toBe('refs.xlsx is an Excel workbook, not a text file.');
  });

  test('any other extension the page does not name is refused, and one it names is not', () => {
    for (const name of ['photo.png', 'report.pdf', 'notes.docx', 'recipe.json', 'run.out', 'COLVAR']) {
      expect(whyNotRead(name, null, fitter)).toBe(`${name} was not opened. Choose a .csv, .tsv, .txt, .dat or .xvg file.`);
    }
    for (const name of ['decay.csv', 'decay.TSV', 'run.1.txt', 'fes.dat', 'rmsd.xvg']) expect(whyNotRead(name, null, fitter)).toBe('');
  });

  test('a workbook under a text file\u2019s name is refused by its bytes', () => {
    expect(whyNotRead('decay.csv', WORKBOOK, fitter))
      .toBe('decay.csv holds a workbook or another zip archive, not text. Save the sheet as CSV and open that, or copy its cells and paste them here.');
    expect(whyNotRead('decay.txt', OLD_WORKBOOK, { extensions: ['csv', 'txt'], sheet: 'open' }))
      .toBe('decay.txt holds an Excel 97\u20132003 workbook or another old Office file, not text. Save the sheet as CSV and open that.');
    expect(whyNotRead('decay.csv', utf8(TABLE), fitter)).toBe('');
    expect(whyNotRead('decay.txt', utf16(TABLE), fitter)).toBe('');
  });

  test('with no list of extensions only the bytes are judged', () => {
    // A LAMMPS input has no settled name; a binary restart file beside it is not one.
    expect(whyNotRead('in.melt', utf8('units lj\natom_style atomic\n'))).toBe('');
    expect(whyNotRead('restart.equil', bytes('LammpS RestartT', [0, 1, 0, 0, 0]))).toBe('restart.equil is not a text file, so it was not opened.');
    expect(whyNotRead('em.mdp', WORKBOOK)).toBe('em.mdp holds a workbook or another zip archive, not text.');
    expect(whyNotRead('plumed.dat', utf8('%PDF-1.4\n'))).toBe('plumed.dat is a PDF, not a text file.');
  });

  test('a file with no name is still told apart', () => {
    expect(whyNotRead('', PNG)).toBe('The file is not a text file, so it was not opened.');
    expect(whyNotRead(undefined, utf8('1 2\n'))).toBe('');
  });
});

describe('fileRefusal', () => {
  const fitter = { extensions: ['csv', 'tsv', 'txt', 'dat', 'xvg'], sheet: 'paste' };

  test('reads the start of a file whose name passes, and nothing of one whose name does not', async () => {
    const seen = [];
    const file = (name, data) => ({
      name,
      slice: (from, to) => { seen.push([name, from, to]); return { arrayBuffer: async () => data.slice(from, to).buffer }; }
    });
    await expect(fileRefusal(file('decay.csv', utf8(TABLE)), fitter)).resolves.toBe('');
    await expect(fileRefusal(file('renamed.csv', WORKBOOK), fitter)).resolves.toMatch(/^renamed\.csv holds a workbook/);
    await expect(fileRefusal(file('decay.xlsx', WORKBOOK), fitter)).resolves.toMatch(/^decay\.xlsx is an Excel workbook/);
    expect(seen).toEqual([['decay.csv', 0, 8000], ['renamed.csv', 0, 8000]]);
  });

  test('a File as the browser hands it over', async () => {
    await expect(fileRefusal(new File([WORKBOOK], 'decay.xlsx'), fitter)).resolves.toMatch(/Excel workbook/);
    await expect(fileRefusal(new File([WORKBOOK], 'decay.dat'), fitter)).resolves.toMatch(/zip archive/);
    await expect(fileRefusal(new File([TABLE], 'decay.dat'), fitter)).resolves.toBe('');
    await expect(fileRefusal(new File([utf16(TABLE)], 'decay.txt'), fitter)).resolves.toBe('');
    await expect(fileRefusal(new File([], 'empty.csv'), fitter)).resolves.toBe('');
  });

  test('a file that cannot be read is left to the page\u2019s own reader', async () => {
    const broken = { name: 'gone.csv', slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }) };
    await expect(fileRefusal(broken, fitter)).resolves.toBe('');
    // A browser too old to hand over a slice's bytes: the check steps aside.
    await expect(fileRefusal({ name: 'old.csv', slice: () => ({}) }, fitter)).resolves.toBe('');
    await expect(fileRefusal(null, fitter)).resolves.toBe('The file was not opened. Choose a .csv, .tsv, .txt, .dat or .xvg file.');
  });
});

/*
 * The text of a file. A spreadsheet does not always save UTF-8: its plain
 * "CSV" is in the Windows code page and its "Unicode Text" in UTF-16, and a
 * page that let the browser guess showed U+FFFD where a micro sign had been.
 */
describe('decodeText', () => {
  const NAMES = 'Signal (µV),Température (°C)\r\n1,2\r\n';

  test('UTF-8, with a byte-order mark or without, which is dropped', () => {
    expect(decodeText(utf8(NAMES))).toEqual({ text: NAMES, encoding: 'utf-8' });
    expect(decodeText(bytes([0xef, 0xbb, 0xbf], [...utf8(NAMES)]))).toEqual({ text: NAMES, encoding: 'utf-8' });
    expect(decodeText(new Uint8Array(0))).toEqual({ text: '', encoding: 'utf-8' });
    expect(decodeText(utf8(TABLE).buffer)).toEqual({ text: TABLE, encoding: 'utf-8' });
  });

  test('the Windows code page, where the bytes are not UTF-8', () => {
    // 0xb5 and 0xb0 alone are not UTF-8: the micro sign and the degree sign of Windows-1252.
    expect(decodeText(Buffer.from(NAMES, 'latin1'))).toEqual({ text: NAMES, encoding: 'windows-1252' });
  });

  test('UTF-16 by its byte-order mark, either way round', () => {
    expect(decodeText(utf16(NAMES))).toEqual({ text: NAMES, encoding: 'utf-16le' });
    expect(decodeText(utf16(NAMES, true))).toEqual({ text: NAMES, encoding: 'utf-16be' });
  });

  test('an encoding is named to the person only when it is not UTF-8', () => {
    expect(['utf-8', 'windows-1252', 'utf-16le', 'utf-16be', undefined].map(encodingName)).toEqual(['', 'Windows-1252', 'UTF-16', 'UTF-16', '']);
  });

  test('a file is read whole and decoded', async () => {
    await expect(readTextFile(new File([Buffer.from(NAMES, 'latin1')], 'names.csv'))).resolves.toEqual({ text: NAMES, encoding: 'windows-1252' });
    await expect(readTextFile(new File([utf16(TABLE)], 'table.txt'))).resolves.toEqual({ text: TABLE, encoding: 'utf-16le' });
    const gone = { arrayBuffer: () => Promise.reject(new Error('NotReadableError')) };
    await expect(readTextFile(gone)).rejects.toThrow('NotReadableError');
    await expect(readTextFile({})).rejects.toThrow();
  });
});

/*
 * The picker and the page agree. An input's accept list is what the picker
 * offers, and the page script holds the list it opens: a file the picker
 * offers must be one the page reads. A page may read more than its picker
 * offers (.tsv beside .csv), never less.
 */
const PAGES = [
  ['curve-fitter.html', 'cfFile', 'js/curve-fitter.js'],
  ['xvg-visualizer.html', 'fileInput', 'js/xvg-visualizer.js'],
  ['error-bar-generator.html', 'fileInput', 'js/error-bar-generator.js'],
  ['stats-calculator.html', 'fileInput', 'js/stats-calculator.js'],
  ['bibtex-deduplicator.html', 'fileInput', 'js/bibtex-deduplicator.js']
];

describe.each(PAGES)('the files %s opens', (page, id, script) => {
  const input = read(page).match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))[0];
  const offered = input.match(/accept="([^"]*)"/)[1].split(',').map(s => s.trim()).filter(s => s.startsWith('.')).map(s => s.slice(1));
  const asked = read(script).match(/fileRefusal\(file, \{ extensions: \[([^\]]*)\]/);

  test('the page script holds a chosen file to a list of extensions', () => {
    expect(asked).not.toBeNull();
  });

  test('every extension the picker offers is on that list', () => {
    const opened = asked[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
    expect(offered.length).toBeGreaterThan(0);
    expect(opened).toEqual(expect.arrayContaining(offered));
    // No workbook among them: the page would refuse what its own list allows.
    for (const ext of opened) expect(whyNotRead(`data.${ext}`, null, { extensions: opened })).toBe('');
  });
});

/* Where the files have no settled extension, or the page has its own rule for them, the bytes are still judged. */
test.each([
  'js/script-generator-gromacs-options.js', 'js/script-generator-lammps-check.js', 'js/script-generator-plumed-check.js',
  'js/script-generator-lammps-data.js', 'js/script-generator-plumed-analyse.js',
  'js/plot-builder.js', 'js/data-cleaner.js', 'js/outlier-detector.js'
])('%s asks whether a file is text before it reads it', (script) => {
  expect(read(script)).toMatch(/\b(?:fileRefusal|whyNotRead)\(/);
});
