/**
 * Which files a page reads, and the text in them.
 *
 * The tools read plain text. An input's `accept` list keeps other files out
 * of the picker, but not a file that is dropped on the page, nor one chosen
 * with the picker set to "All files"; and a workbook read as text is the
 * bytes of a zip archive in the data box. So a page asks here before it reads
 * a file: is the extension one it names, and do the first bytes hold text.
 * The answer is a sentence for the person, or '' to go ahead.
 *
 * The text is then decoded here too (decodeText, readTextFile), because a
 * spreadsheet does not always save UTF-8: Excel's plain "CSV" is in the
 * Windows code page, where a micro sign or an accent read as UTF-8 comes out
 * as U+FFFD.
 *
 * No DOM, so the tests run it in Node.
 */

/* The files most often opened by mistake, since the data are in them. */
const WORKBOOK = 'an Excel workbook';
const SHEETS = {
  xlsx: WORKBOOK, xlsm: WORKBOOK, xlsb: WORKBOOK, xls: WORKBOOK, xltx: WORKBOOK, xlt: WORKBOOK,
  ods: 'an OpenDocument spreadsheet',
  numbers: 'a Numbers spreadsheet'
};

/* What to do with a sheet instead, where the page has a box to paste into and where it has none. */
const FROM_A_SHEET = {
  open: 'Save the sheet as CSV and open that.',
  paste: 'Save the sheet as CSV and open that, or copy its cells and paste them here.'
};

/* As git does: a NUL byte this early means the file is not text. */
const HEAD_BYTES = 8000;

const starts = (bytes, signature) => signature.every((b, i) => bytes[i] === b);
const ZIP = [0x50, 0x4b, 0x03, 0x04];                                // .xlsx, .ods, .docx
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];        // .xls, .doc
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];                          // %PDF-

/**
 * The extension of a file name: lower case, without the dot, and '' when the
 * name has none (`COLVAR`, `.bashrc`).
 *
 * @param {string} name
 * @returns {string}
 */
export function extensionOf(name) {
  const base = String(name ?? '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Extensions as a page names them: ".csv, .tsv or .txt".
 *
 * @param {string[]} extensions - Without dots.
 * @returns {string}
 */
export function listExtensions(extensions) {
  const names = (extensions || []).map((e) => `.${e}`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] || '';
}

/**
 * True when bytes are not text.
 *
 * Text has no NUL byte in any encoding the pages read, except UTF-16, which
 * starts with a byte-order mark (Excel's "Unicode Text") and then has no NUL
 * character. Workbooks, Office files, images and archives all have a NUL in
 * their first few bytes. A PDF may not, so it is known by how it starts.
 *
 * @param {Uint8Array|ArrayBuffer} bytes - The start of the file is enough.
 * @returns {boolean}
 */
export function looksBinary(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const n = Math.min(b.length, HEAD_BYTES);
  if (n >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) {
    for (let i = 2; i + 1 < n; i += 2) if (b[i] === 0 && b[i + 1] === 0) return true;
    return false;
  }
  if (starts(b, PDF)) return true;
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

/* What binary bytes are, when they start like a format a person may have meant to open. */
function contents(bytes) {
  if (starts(bytes, ZIP)) return { sheet: true, text: 'a workbook or another zip archive' };
  if (starts(bytes, OLE)) return { sheet: true, text: 'an Excel 97–2003 workbook or another old Office file' };
  if (starts(bytes, PDF)) return { sheet: false, text: 'a PDF' };
  return null;
}

/**
 * Why a page does not read a file, as a sentence for the person, or '' when
 * it does.
 *
 * @param {string} name - The file's name.
 * @param {Uint8Array|null} head - Its first bytes, or null to judge by the name alone.
 * @param {{extensions?: string[], sheet?: 'open'|'paste'}} [options]
 *   extensions: the ones the page reads, without dots; leave out where the
 *   files have no settled extension, and only the bytes are judged.
 *   sheet: the page reads tables, so a workbook is met with what to do
 *   instead; 'paste' where the page has a box to paste cells into.
 * @returns {string}
 */
export function whyNotRead(name, head, options = {}) {
  const { extensions = null, sheet = '' } = options;
  const file = String(name || 'The file');
  const ext = extensionOf(file);
  const choose = extensions ? `Choose a ${listExtensions(extensions)} file.` : '';
  const advice = FROM_A_SHEET[sheet] || choose;
  if (Object.hasOwn(SHEETS, ext)) return `${file} is ${SHEETS[ext]}, not a text file.${advice ? ` ${advice}` : ''}`;
  if (extensions && !extensions.includes(ext)) return `${file} was not opened. ${choose}`;
  if (!head || !looksBinary(head)) return '';
  const what = contents(head);
  if (what && what.sheet) return `${file} holds ${what.text}, not text.${FROM_A_SHEET[sheet] ? ` ${FROM_A_SHEET[sheet]}` : ''}`;
  if (what) return `${file} is ${what.text}, not a text file.`;
  return `${file} is not a text file, so it was not opened.`;
}

/**
 * The same for a file a person chose or dropped. Its first bytes are read
 * only when the name passes. A file whose bytes cannot be had passes too,
 * whether it cannot be read or the browser has no way to hand them over: the
 * page's own reader then says what is wrong.
 *
 * @param {File} file
 * @param {{extensions?: string[], sheet?: 'open'|'paste'}} [options]
 * @returns {Promise<string>}
 */
export function fileRefusal(file, options = {}) {
  const name = file && file.name;
  const byName = whyNotRead(name, null, options);
  if (byName || !file) return Promise.resolve(byName);
  return Promise.resolve()
    .then(() => file.slice(0, HEAD_BYTES).arrayBuffer())
    .then((buffer) => whyNotRead(name, new Uint8Array(buffer), options))
    .catch(() => '');
}

/**
 * The text of a file's bytes, in the encoding a spreadsheet may have saved:
 * UTF-16 when it starts with that byte-order mark (Excel's "Unicode Text"),
 * UTF-8 when the bytes are valid UTF-8 (a byte-order mark is dropped), and
 * otherwise Windows-1252, the code page of Excel's plain "CSV" in western
 * Europe and the Americas. Every byte is a character there, so that last
 * reading cannot fail; a file in another old code page comes out with the
 * wrong letters, never with an error.
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {{text: string, encoding: 'utf-8'|'utf-16le'|'utf-16be'|'windows-1252'}}
 */
export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b), encoding: 'utf-16le' };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' };
  } catch (e) {
    return { text: new TextDecoder('windows-1252').decode(b), encoding: 'windows-1252' };
  }
}

/** An encoding as a page names it to the person, or '' for UTF-8, which needs no saying. */
export function encodingName(encoding) {
  return { 'windows-1252': 'Windows-1252', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16' }[encoding] || '';
}

/**
 * The text of a file a person chose or dropped, decoded by decodeText.
 *
 * @param {File} file
 * @returns {Promise<{text: string, encoding: string}>} Rejects when the file cannot be read.
 */
export function readTextFile(file) {
  return Promise.resolve().then(() => file.arrayBuffer()).then(decodeText);
}
