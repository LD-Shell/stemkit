/**
 * @module core/bibtex
 *
 * BibTeX parsing, duplicate detection, and field sanitising, extracted from
 * STEMKit's BibTeX Deduplicator and Sanitizer.
 *
 * Duplicate detection uses a union-find (disjoint-set) structure keyed on
 * normalised DOI and normalised title. The transitive closure matters: if
 * entry A shares a DOI with B, and B shares a title with C, then all three
 * describe the same work even though A and C have nothing directly in common.
 * Pairwise comparison would report two separate conflicts and leave a
 * duplicate in the output.
 *
 * Field values are decoded by the vendored bibtex-parse-js bundle via the
 * injection layer. The document structure is read here first: the bundle
 * cannot read `@string` blocks or bare macro values (`month = jul`,
 * `journal = jcp`), so each entry is located, its macros are expanded, and it
 * is handed to the bundle on its own. The source text of each entry is
 * remembered, so an entry that has not been edited is written back exactly as
 * it was read.
 */

import { requireVendor } from './vendor.js';

/**
 * Normalise a DOI for comparison.
 *
 * Strips any resolver prefix, lowercases (DOIs are case-insensitive by
 * specification), and removes whitespace.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normaliseDoi(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/\s+/g, '');
}

/**
 * Normalise a title for comparison.
 *
 * Removes inline maths and LaTeX commands, then grouping braces, punctuation,
 * and redundant whitespace. This lets `{The} Structure of DNA` and
 * `The structure of DNA.` compare equal, which is the common case when the
 * same work is exported from two different databases.
 *
 * Order matters: commands are stripped *before* braces, but the command regex
 * deliberately does not consume a following brace group. Removing `\emph{...}`
 * wholesale would delete the title text it wraps, so `\emph{Important} work`
 * must normalise to `important work`, not `work`.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normaliseTitle(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/\$[^$]*\$/g, ' ')     // inline maths
    .replace(/\\[a-z]+\s*/gi, ' ')  // commands, keeping any braced argument
    .replace(/[{}]/g, '')           // grouping braces
    .replace(/[^\w\s]/g, ' ')       // punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Reading the source text
 * ------------------------------------------------------------------ */

// The month macros every standard bibliography style defines (`jan` expands
// to "January" in plain.bst and its descendants).
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// A bare word: a macro name, a number or a field name. BibTeX ends one at
// whitespace or at any of these characters.
const WORD = /[^\s"#%'(),={}]+/y;

// The head of a block: `@article{`, `@string (`, and so on.
const BLOCK_HEAD = /@\s*([A-Za-z][\w.:+-]*)\s*([{(])/y;

const NON_ENTRY = new Set(['string', 'comment', 'preamble']);

/** The bare word starting at `i`, or '' when there is none. */
function wordAt(src, i) {
  WORD.lastIndex = i;
  const m = WORD.exec(src);
  return m ? m[0] : '';
}

/**
 * Expand a bare month such as `jul` to its name.
 *
 * The styles define only `jan` to `dec`, but exporters also write `Sept`,
 * `June` or `July`, so any case-insensitive prefix of a month name of three
 * or more letters is accepted.
 *
 * @param {string} word
 * @returns {string} The month name, or '' when the word is not a month.
 */
function monthName(word) {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return '';
  return MONTHS.find(m => m.toLowerCase().startsWith(w)) || '';
}

/**
 * The text a bare value stands for.
 *
 * A number is itself. A name defined by `@string` takes that definition,
 * which overrides a month as it does in BibTeX. Otherwise a month name
 * expands, and any other word is kept as its own text, so an undefined macro
 * still reads as something rather than failing the whole library.
 *
 * @param {string} word
 * @param {Map<string,string>} macros - Lowercased name to value.
 * @returns {string}
 */
function resolveMacro(word, macros) {
  if (/^\d+$/.test(word)) return word;
  const defined = macros.get(word.toLowerCase());
  if (defined !== undefined) return defined;
  return monthName(word) || word;
}

/**
 * Read one field value: a braced string, a quoted string or a bare word (a
 * number or macro name), or several of these joined with `#`.
 *
 * Braces are counted inside quoted strings as well, as BibTeX does, so
 * `"Outer {"} text"` is one value.
 *
 * @param {string} src
 * @param {number} i - Index just after the `=`.
 * @returns {{parts:Array<{kind:'braced'|'quoted'|'bare', start:number,
 *            end:number, text:string}>, end:number}} Each part's `text` is
 *          without its delimiters; `end` is the index after the last part.
 */
function readValue(src, i) {
  const n = src.length;
  const parts = [];
  let end = i;

  for (;;) {
    while (i < n && /\s/.test(src[i])) i++;
    const start = i;

    if (src[i] === '{') {
      let depth = 0;
      for (; i < n; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { i++; break; }
      }
      parts.push({ kind: 'braced', start, end: i, text: src.slice(start + 1, depth === 0 ? i - 1 : i) });
    } else if (src[i] === '"') {
      let depth = 0;
      let closed = false;
      for (i++; i < n; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '"' && depth === 0) { closed = true; i++; break; }
      }
      parts.push({ kind: 'quoted', start, end: i, text: src.slice(start + 1, closed ? i - 1 : i) });
    } else {
      const word = wordAt(src, i);
      if (!word) break;
      i += word.length;
      parts.push({ kind: 'bare', start, end: i, text: word });
    }

    end = i;
    let j = i;
    while (j < n && /\s/.test(src[j])) j++;
    if (src[j] !== '#') break;
    i = j + 1;
  }

  return { parts, end };
}

/**
 * Index just past the delimiter that closes the block opened at `open`, or -1
 * when the block is never closed.
 *
 * A `(` block also skips `)` inside braces or quotes, since a title such as
 * "A (short) note" is common and would otherwise end the entry early.
 */
function closeOf(src, open) {
  let depth = 0;
  if (src[open] === '{') {
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return j + 1;
    }
    return -1;
  }
  let quoted = false;
  for (let j = open + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '"' && depth === 0) quoted = !quoted;
    else if (c === ')' && depth === 0 && !quoted) return j + 1;
  }
  return -1;
}

/**
 * Find the top-level blocks of a BibTeX document.
 *
 * Text between blocks is not listed; BibTeX ignores it. An `@` that does not
 * start a block (an address in a comment line, say) is skipped over.
 *
 * @param {string} src
 * @returns {Array<{kind:'entry'|'string'|'comment'|'preamble', type:string,
 *            start:number, open:number, end:number, closed:boolean}>}
 *          `open` is the index of the opening delimiter; `end` is the index
 *          after the closing one, or the end of the text when it is missing.
 */
function scanDocument(src) {
  const blocks = [];
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf('@', i);
    if (at === -1) break;
    BLOCK_HEAD.lastIndex = at;
    const m = BLOCK_HEAD.exec(src);
    if (!m) { i = at + 1; continue; }

    const type = m[1];
    const open = at + m[0].length - 1;
    const close = closeOf(src, open);
    blocks.push({
      kind: NON_ENTRY.has(type.toLowerCase()) ? type.toLowerCase() : 'entry',
      type,
      start: at,
      open,
      end: close === -1 ? src.length : close,
      closed: close !== -1
    });
    i = close === -1 ? src.length : close;
  }
  return blocks;
}

/**
 * Read the citation key and fields of an entry block.
 *
 * Reading stops at the first thing that is not a field; `complete` is then
 * false and the fields before it are still returned.
 *
 * @returns {{key:string, fields:Array<{name:string, valueStart:number,
 *            valueEnd:number, parts:object[]}>, complete:boolean}}
 */
function readEntry(src, block) {
  const limit = block.closed ? block.end - 1 : block.end;
  let k = block.open + 1;
  while (k < limit && src[k] !== ',') k++;
  const key = src.slice(block.open + 1, k).trim();

  const fields = [];
  let complete = true;
  let i = k + 1;
  while (i < limit) {
    const c = src[i];
    if (/[\s,]/.test(c)) { i++; continue; }
    // bibtex-parse-js skips % comment lines between fields, so this does too.
    if (c === '%') { while (i < limit && src[i] !== '\n') i++; continue; }

    const name = wordAt(src, i);
    if (!name) { complete = false; break; }
    i += name.length;
    while (i < limit && /\s/.test(src[i])) i++;
    if (src[i] !== '=') { complete = false; break; }

    const { parts, end } = readValue(src, i + 1);
    if (parts.length === 0 || end > limit) { complete = false; break; }
    fields.push({ name, valueStart: parts[0].start, valueEnd: end, parts });

    i = end;
    while (i < limit && /\s/.test(src[i])) i++;
    if (i < limit && src[i] !== ',') { complete = false; break; }
  }
  return { key, fields, complete };
}

/** Record the definition in a `@string` block, expanding any macro it uses. */
function defineMacro(src, block, macros) {
  if (!block.closed) return;
  let i = block.open + 1;
  while (i < block.end && /\s/.test(src[i])) i++;
  const name = wordAt(src, i);
  if (!name) return;
  i += name.length;
  while (i < block.end && /\s/.test(src[i])) i++;
  if (src[i] !== '=') return;

  const { parts } = readValue(src, i + 1);
  if (parts.length === 0) return;
  macros.set(name.toLowerCase(),
    parts.map(p => (p.kind === 'bare' ? resolveMacro(p.text, macros) : p.text)).join(''));
}

/**
 * The text of an entry block, rewritten into the form bibtex-parse-js reads.
 *
 * The bundle accepts a bare value only when it is a number, and in a `#`
 * concatenation it drops the leading space of each part, so a value that
 * uses a macro or `#` is replaced by the braced text it stands for (see
 * `resolveMacro`). The bundle also reads only `{...}` entries, so a `(...)`
 * entry has its outer delimiters swapped. Anything the reader cannot follow
 * is left as it is, for the bundle to report.
 */
function entryForParser(src, block, macros) {
  const edits = [];
  for (const f of readEntry(src, block).fields) {
    const plain = f.parts.length === 1 &&
      (f.parts[0].kind !== 'bare' || /^\d+$/.test(f.parts[0].text));
    if (plain) continue;
    const value = f.parts
      .map(p => (p.kind === 'bare' ? resolveMacro(p.text, macros) : p.text))
      .join('');
    edits.push([f.valueStart, f.valueEnd, `{${value}}`]);
  }
  if (block.closed && src[block.open] === '(') {
    edits.push([block.open, block.open + 1, '{'], [block.end - 1, block.end, '}']);
  }
  edits.sort((a, b) => a[0] - b[0]);

  let out = '';
  let pos = block.start;
  for (const [s, e, text] of edits) {
    out += src.slice(pos, s) + text;
    pos = e;
  }
  return out + src.slice(pos, block.end);
}

// Where each parsed entry was read from, so it can be written back as it was.
// Keyed by the entry object itself: a copy (`{...entry}`) is not in the map,
// and an entry edited in place no longer matches its stamp, so both are
// written from their fields instead.
const ORIGIN = new WeakMap();

const stampOf = (entry) =>
  JSON.stringify([entry.entryType, entry.citationKey, entry.entryTags]);

/** The origin of an entry that is unchanged since it was parsed, else null. */
function originOf(entry) {
  const origin = entry && typeof entry === 'object' ? ORIGIN.get(entry) : undefined;
  return origin && origin.stamp === stampOf(entry) ? origin : null;
}

/**
 * Remove `@string`, `@comment`, and `@preamble` blocks from a BibTeX document.
 *
 * These are legal and common (Zotero, Mendeley, and JabRef all emit them),
 * but the vendored bibtex-parse-js cannot parse them and aborts the *entire*
 * document with a token-mismatch error when one is present. `parseBibtex`
 * reads each entry separately and so never needs this; it is kept for
 * callers that hand a document to the bundle directly.
 *
 * Brace depth is tracked so that a block containing nested braces (a
 * `@comment` wrapping a full entry, as JabRef writes) is removed in full.
 *
 * @param {string} text
 * @returns {{text:string, removed:number}}
 */
export function stripNonEntryBlocks(text) {
  const src = String(text || '');
  let out = '';
  let pos = 0;
  let removed = 0;

  for (const block of scanDocument(src)) {
    if (block.kind === 'entry') continue;
    out += src.slice(pos, block.start);
    pos = block.end;
    removed++;
  }

  return { text: out + src.slice(pos), removed };
}

/**
 * Parse a BibTeX document into entry objects.
 *
 * `@string` definitions are read and applied: a bare value such as
 * `journal = jcp` takes the text its `@string` gives it, a month macro such
 * as `month = jul` or `month = Sept` becomes the month's name, and any other
 * bare word is kept as its own text. As in BibTeX, a macro applies to the
 * entries after its definition. `#` concatenation is supported. `@comment`
 * and `@preamble` blocks are skipped; `strippedBlocks` counts them together
 * with the `@string` blocks.
 *
 * A syntax error in any entry is reported, naming the entry, and no entries
 * are returned; nothing throws.
 *
 * @param {string} text
 * @returns {{entries:object[], error:string|null, strippedBlocks:number}}
 */
export function parseBibtex(text) {
  const bibtexParse = requireVendor('bibtexParse');
  if (typeof text !== 'string' || text.trim() === '') {
    return { entries: [], error: null, strippedBlocks: 0 };
  }

  const blocks = scanDocument(text);
  const strippedBlocks = blocks.filter(b => b.kind !== 'entry').length;
  const macros = new Map();
  const doc = { text, entries: [], definitions: [] };
  let seen = 0;

  for (const block of blocks) {
    if (block.kind !== 'entry') {
      if (block.kind === 'string') defineMacro(text, block, macros);
      if (block.kind !== 'comment') doc.definitions.push(text.slice(block.start, block.end));
      continue;
    }

    seen++;
    let parsed;
    try {
      parsed = bibtexParse.toJSON(entryForParser(text, block, macros));
    } catch (err) {
      // bibtex-parse-js throws bare strings rather than Error objects, so the
      // usual err.message access would itself throw here. Its messages quote
      // the rest of the input, so they are cut short.
      let detail = (err && err.message) ? err.message : String(err);
      if (detail.length > 120) detail = detail.slice(0, 120) + '…';
      const key = readEntry(text, block).key.slice(0, 60);
      return {
        entries: [],
        error: `Syntax error in BibTeX entry ${seen}${key ? ` (${key})` : ''}: ${detail}`,
        strippedBlocks
      };
    }

    const entry = (parsed || [])[0];
    if (!entry || !entry.entryTags || !entry.citationKey) continue;
    ORIGIN.set(entry, { doc, start: block.start, end: block.end, stamp: stampOf(entry) });
    doc.entries.push(entry);
  }

  return { entries: doc.entries.slice(), error: null, strippedBlocks };
}

/**
 * Read a field case-insensitively.
 *
 * BibTeX field names are case-insensitive, and exporters disagree: Web of
 * Science writes `DOI`, Zotero writes `doi`, and some styles write `Doi`.
 *
 * @param {object} tags
 * @param {string} name
 * @returns {string} The value, or an empty string when absent.
 */
export function getField(tags, name) {
  if (!tags || typeof tags !== 'object') return '';
  const want = String(name).toLowerCase();
  for (const [k, v] of Object.entries(tags)) {
    if (String(k).toLowerCase() === want) return v === undefined ? '' : String(v);
  }
  return '';
}

/**
 * Group entries into duplicate sets.
 *
 * Two entries are linked when they share a normalised DOI or a normalised
 * title; groups are the connected components of that relation.
 *
 * @param {object[]} entries
 * @returns {{groups:Array<{members:Array<{originalIndex:number, data:object}>}>,
 *            singletons:object[], duplicateCount:number}}
 */
export function findDuplicates(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const n = list.length;
  if (n === 0) return { groups: [], singletons: [], duplicateCount: 0 };

  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  // Path-halving find keeps the structure near-flat without recursion.
  const find = (x) => {
    let v = x;
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const doiOwner = new Map();
  const titleOwner = new Map();

  list.forEach((entry, i) => {
    const tags = entry.entryTags || {};
    const doi = normaliseDoi(getField(tags, 'doi'));
    const title = normaliseTitle(getField(tags, 'title'));

    if (doi) {
      if (doiOwner.has(doi)) union(doiOwner.get(doi), i);
      else doiOwner.set(doi, i);
    }
    if (title) {
      if (titleOwner.has(title)) union(titleOwner.get(title), i);
      else titleOwner.set(title, i);
    }
  });

  const components = new Map();
  list.forEach((entry, i) => {
    const root = find(i);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(i);
  });

  const groups = [];
  const singletons = [];
  let duplicateCount = 0;

  for (const members of components.values()) {
    if (members.length > 1) {
      groups.push({
        members: members.map(i => ({ originalIndex: i, data: list[i] }))
      });
      duplicateCount += members.length - 1;
    } else {
      singletons.push(list[members[0]]);
    }
  }

  // Stable ordering by first appearance in the source file.
  groups.sort((a, b) => a.members[0].originalIndex - b.members[0].originalIndex);

  return { groups, singletons, duplicateCount };
}

/**
 * Score an entry by completeness, for choosing a group representative.
 *
 * A DOI is weighted most heavily because it is the only globally unique
 * identifier present; the remaining fields contribute equally.
 *
 * @param {object} entry
 * @returns {number}
 */
export function completenessScore(entry) {
  if (!entry || !entry.entryTags) return 0;
  const tags = entry.entryTags;
  let score = 0;

  if (getField(tags, 'doi')) score += 10;
  for (const f of ['author', 'title', 'year', 'journal', 'volume',
                   'pages', 'number', 'publisher', 'abstract']) {
    if (getField(tags, f)) score += 1;
  }
  return score;
}

/**
 * Pick the most complete entry from a duplicate group.
 *
 * Ties are broken by original order, so the choice is deterministic.
 *
 * @param {Array<{originalIndex:number, data:object}>} members
 * @returns {object|null}
 */
export function chooseBest(members) {
  if (!Array.isArray(members) || members.length === 0) return null;
  let best = members[0];
  let bestScore = completenessScore(best.data);

  for (let i = 1; i < members.length; i++) {
    const s = completenessScore(members[i].data);
    if (s > bestScore) {
      best = members[i];
      bestScore = s;
    }
  }
  return best.data;
}

/**
 * Deduplicate a library automatically, keeping the most complete entry of each
 * group.
 *
 * @param {object[]} entries
 * @returns {{entries:object[], removed:number, groups:number}}
 */
export function deduplicateAuto(entries) {
  const { groups, singletons, duplicateCount } = findDuplicates(entries);
  const chosen = groups.map(g => chooseBest(g.members)).filter(Boolean);

  // Restore source order so the output reads like the input.
  const indexOf = new Map();
  (entries || []).forEach((e, i) => indexOf.set(e, i));
  const merged = [...singletons, ...chosen].sort(
    (a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0)
  );

  return { entries: merged, removed: duplicateCount, groups: groups.length };
}

/**
 * Serialise an entry back to BibTeX.
 *
 * An entry returned by `parseBibtex` and not changed since is written exactly
 * as it appeared in the source, so protective braces (`{NumPy}`), macros
 * (`month = jul`) and the original layout survive. Any other entry is written
 * from its fields, which hold the parser's decoded values.
 *
 * @param {object} entry
 * @returns {string}
 */
export function serialiseEntry(entry) {
  if (!entry) return '';
  const origin = originOf(entry);
  if (origin) return origin.doc.text.slice(origin.start, origin.end) + '\n\n';

  const type = entry.entryType || 'misc';
  const key = entry.citationKey || '';
  const tags = entry.entryTags || {};
  const keys = Object.keys(tags);

  let out = `@${type}{${key},\n`;
  keys.forEach((k, i) => {
    out += `  ${k} = {${tags[k]}}${i < keys.length - 1 ? ',' : ''}\n`;
  });
  out += '}\n\n';
  return out;
}

/**
 * Serialise a list of entries.
 *
 * When every entry comes unchanged from one `parseBibtex` call, in source
 * order (as `deduplicateAuto` returns them), the result is that source with
 * the other entries cut out. Kept entries are exactly as written, and the
 * `@string`, `@preamble` and `@comment` blocks and any text between entries
 * stay where they were.
 *
 * Otherwise each entry is written by `serialiseEntry`, after the `@string`
 * and `@preamble` blocks of any source whose entries are written as they
 * were, so the macros those entries use are still defined.
 *
 * @param {object[]} entries
 * @returns {string}
 */
export function serialiseLibrary(entries) {
  if (!Array.isArray(entries)) return '';

  const origins = entries.map(originOf);
  const doc = origins.length > 0 && origins[0] ? origins[0].doc : null;
  const fromOneSource = doc !== null && origins.every((o, i) =>
    o && o.doc === doc && (i === 0 || o.start > origins[i - 1].start));

  if (fromOneSource) {
    const keep = new Set(entries);
    let out = '';
    let pos = 0;
    for (const e of doc.entries) {
      if (keep.has(e)) continue;
      const { start, end } = ORIGIN.get(e);
      out += doc.text.slice(pos, start);
      // Take the blank lines after a dropped entry with it.
      pos = end;
      while (pos < doc.text.length && /\s/.test(doc.text[pos])) pos++;
    }
    return (out + doc.text.slice(pos)).trim() + '\n';
  }

  let head = '';
  for (const d of new Set(origins.filter(Boolean).map(o => o.doc))) {
    for (const block of d.definitions) head += block + '\n\n';
  }
  return head + entries.map(serialiseEntry).join('');
}

/* ------------------------------------------------------------------ *
 * Sanitising
 * ------------------------------------------------------------------ */

/**
 * Convert a hyphen or en/em dash between digits into a LaTeX en dash.
 *
 * Page ranges are conventionally typeset with `--`; a single hyphen renders as
 * a hyphen, which is typographically wrong in a bibliography.
 *
 * @param {string} value
 * @returns {string}
 */
export function fixPageRange(value) {
  return String(value || '').replace(/(\d)\s*[-\u2013\u2014]+\s*(\d)/g, '$1--$2');
}

/**
 * Remove redundant outer braces from a field value.
 *
 * @param {string} value
 * @returns {string}
 */
export function stripOuterBraces(value) {
  return String(value || '')
    .replace(/^\s*\{+\s*/, '')
    .replace(/\s*\}+\s*$/, '')
    .trim();
}

/**
 * Protect capitalised words in a title with braces.
 *
 * Most bibliography styles lowercase titles, so acronyms and proper nouns must
 * be brace-protected or `DNA` silently renders as `dna`.
 *
 * Three patterns are protected:
 *
 *   - all-caps runs of two or more letters (`DNA`, `NMR`, `XVG`);
 *   - internal capitals after an initial capital (`McMurry`, `NaCl`);
 *   - a lowercase initial followed by capitals (`pH`, `mRNA`, `pKa`), these
 *     are common in chemistry and are missed entirely by a rule that requires
 *     the first letter to be uppercase.
 *
 * Words already inside braces are left untouched, so the function is
 * idempotent and safe to apply to a partly-cleaned library.
 *
 * @param {string} title
 * @returns {string}
 */
export function protectCapitals(title) {
  const s = String(title || '');
  if (!s) return '';

  // Split on existing brace groups so their contents are never re-processed.
  const parts = s.split(/(\{[^{}]*\})/);
  return parts.map(part => {
    if (part.startsWith('{')) return part;
    return part.replace(
      /\b([A-Z]{2,}[A-Za-z0-9]*|[A-Z][a-z0-9]*[A-Z][A-Za-z0-9]*|[a-z][A-Z][A-Za-z0-9]*)\b/g,
      '{$1}'
    );
  }).join('');
}

/**
 * Remove fields from an entry.
 *
 * Abstracts and file paths bloat a `.bib` file and leak local directory
 * structure into a shared repository, so they are common removal targets.
 *
 * @param {object} entry
 * @param {string[]} fields - Field names, matched case-insensitively.
 * @returns {object} A new entry.
 */
export function removeFields(entry, fields) {
  if (!entry) return entry;
  const drop = new Set((fields || []).map(f => String(f).toLowerCase()));
  const tags = {};
  for (const [k, v] of Object.entries(entry.entryTags || {})) {
    if (!drop.has(String(k).toLowerCase())) tags[k] = v;
  }
  return { ...entry, entryTags: tags };
}

/**
 * Apply a set of sanitising operations to a library.
 *
 * @param {object[]} entries
 * @param {{
 *   fixPages?: boolean, stripBraces?: boolean, protectCaps?: boolean,
 *   removeFields?: string[], lowercaseKeys?: boolean
 * }} [options]
 * @returns {{entries:object[], changes:number}}
 */
export function sanitiseLibrary(entries, options = {}) {
  const {
    fixPages = false,
    stripBraces = false,
    protectCaps = false,
    removeFields: toRemove = [],
    lowercaseKeys = false
  } = options;

  if (!Array.isArray(entries)) return { entries: [], changes: 0 };
  let changes = 0;

  const out = entries.map(entry => {
    let e = toRemove.length ? removeFields(entry, toRemove) : { ...entry };
    const before = JSON.stringify(e.entryTags);
    const tags = {};

    for (const [k, rawV] of Object.entries(e.entryTags || {})) {
      let v = String(rawV);
      const lower = k.toLowerCase();

      if (stripBraces) v = stripOuterBraces(v);
      if (fixPages && lower === 'pages') v = fixPageRange(v);
      if (protectCaps && lower === 'title') v = protectCapitals(v);

      tags[lowercaseKeys ? lower : k] = v;
    }

    e = { ...e, entryTags: tags };
    if (JSON.stringify(e.entryTags) !== before) changes++;
    return e;
  });

  return { entries: out, changes };
}

/**
 * Read the fields of one entry body, tracking brace depth.
 *
 * This exists alongside `parseBibtex` because the two answer different
 * questions. `parseBibtex` uses the vendored bibtex-parse-js, which is
 * convenient for identity work (deduplication, missing-field checks) but is
 * *lossy*: it strips nested braces, so
 *
 *   title = {An analysis of {NaCl} crystals}
 *
 * round-trips as `An analysis of NaCl crystals`. Those braces are the only
 * thing stopping a bibliography style from lowercasing NaCl to "nacl", so
 * losing them silently corrupts every protected title in a library.
 *
 * This reader preserves the value byte-for-byte, which is what a sanitiser
 * needs. A naive regex cannot do it: `\{([^}]*)\}` truncates at the first
 * inner brace.
 *
 * Handles the three BibTeX value forms, braced, quoted, and bare (a number or
 * string macro), and `#` concatenations of them.
 *
 * @param {string} content - The body of an entry, between the citation key and
 *        the closing brace.
 * @returns {Array<{key:string, name:string, value:string, raw:string,
 *            delimiter:string}>} `key` is the field name lowercased and
 *          `name` as written. `raw` is the value exactly as written, from
 *          after the `=` to before the next comma. `delimiter` is `{` or `"`
 *          when the value is one braced or quoted string, and `value` is then
 *          its contents; otherwise (a number, a macro name, a concatenation)
 *          `delimiter` is '' and `value` is `raw`.
 */
export function readFieldsPreservingBraces(content) {
  const fields = [];
  const src = String(content || '');
  const n = src.length;
  let i = 0;

  const isKeyChar = (c) => /[A-Za-z0-9_:\-.]/.test(c);

  while (i < n) {
    while (i < n && /[\s,]/.test(src[i])) i++;
    if (i >= n) break;

    let name = '';
    while (i < n && isKeyChar(src[i])) { name += src[i]; i++; }
    if (!name) { i++; continue; }

    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] !== '=') {
      // Malformed field: skip to the next separator rather than derailing.
      while (i < n && src[i] !== ',') i++;
      continue;
    }
    i++;

    const { parts, end } = readValue(src, i);

    // Anything after the value, up to the next comma, stays with it, so an
    // unusual value such as `100 - 110` is carried over whole.
    let stop = end;
    let depth = 0;
    for (; stop < n; stop++) {
      const c = src[stop];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ',' && depth <= 0) break;
    }

    const raw = src.slice(i, stop).trim();
    const single = parts.length === 1 && parts[0].kind !== 'bare' &&
      src.slice(end, stop).trim() === '';
    fields.push({
      key: name.toLowerCase(),
      name,
      value: single ? parts[0].text : raw,
      raw,
      delimiter: single ? (parts[0].kind === 'braced' ? '{' : '"') : ''
    });
    i = stop;
  }
  return fields;
}

/**
 * Sanitise a BibTeX document in place, preserving everything not targeted.
 *
 * Unlike `sanitiseLibrary`, which reformats through the parser, this operates
 * on the source text: `@string`, `@preamble`, and `@comment` blocks pass
 * through untouched, nested braces survive, every value keeps the form it was
 * written in (braced, quoted, or a bare number or macro name), and an entry
 * that no rule changes comes out exactly as it went in unless `alignEquals`
 * asks for its layout to be redone. That matters for a library under version
 * control, where a reformatting pass produces a diff touching every line and
 * hides the changes that were actually intended.
 *
 * @param {string} text
 * @param {{
 *   stripFields?: string[], fixPages?: boolean,
 *   protectTitle?: boolean, alignEquals?: boolean
 * }} [options]
 * @returns {{text:string, entriesProcessed:number, fieldsRemoved:number}}
 */
export function sanitiseText(text, options = {}) {
  const {
    stripFields = [],
    fixPages = false,
    protectTitle = false,
    alignEquals = false
  } = options;

  const src = String(text || '');
  if (!src.trim()) return { text: '', entriesProcessed: 0, fieldsRemoved: 0 };

  const strip = new Set(stripFields.map(f => String(f).toLowerCase()));
  let entriesProcessed = 0;
  let fieldsRemoved = 0;
  let out = '';

  for (const block of src.split(/(?=@\w+\s*[{(])/g)) {
    if (!block.trim().startsWith('@')) {
      out += block;
      continue;
    }

    const typeMatch = block.match(/^@(\w+)/);
    const entryType = typeMatch ? typeMatch[1].toLowerCase() : '';
    // Non-reference constructs carry no fields to clean.
    if (['string', 'preamble', 'comment'].includes(entryType)) {
      out += block;
      continue;
    }

    const headerMatch = block.match(/^(@\w+\s*([{(])\s*[^,]+,)/);
    if (!headerMatch) {
      out += block;
      continue;
    }

    entriesProcessed++;
    const header = headerMatch[1];
    // An entry may be written @article(...) as well as @article{...}.
    const close = headerMatch[2] === '(' ? ')' : '}';
    const body = block.slice(header.length);
    const lastBrace = body.lastIndexOf(close);
    const content = lastBrace >= 0 ? body.slice(0, lastBrace) : body;
    const tail = lastBrace >= 0 ? body.slice(lastBrace) : close;

    let fields = readFieldsPreservingBraces(content);
    let changed = false;

    fields = fields.filter(f => {
      if (strip.has(f.key)) { fieldsRemoved++; changed = true; return false; }
      return true;
    });

    for (const f of fields) {
      const isPages = f.key === 'pages' || f.key === 'page';
      // A value without delimiters is a number, a macro name or a
      // concatenation. The rules are for text, and applying them to a macro
      // name would change what it refers to, so such a value is kept as is.
      // The exception is a page range typed without braces (`100-110`): it
      // is no macro, and BibTeX cannot read it bare, so it is braced.
      if (!f.delimiter) {
        if (fixPages && isPages && /^\d+\s*[-–—]+\s*\d+$/.test(f.raw)) {
          f.raw = `{${fixPageRange(f.raw)}}`;
          changed = true;
        }
        continue;
      }
      let v = f.value;
      if (fixPages && isPages) v = fixPageRange(v);
      if (protectTitle && f.key === 'title') v = protectCapitals(v);
      if (v !== f.value) {
        f.raw = f.delimiter === '"' ? `"${v}"` : `{${v}}`;
        changed = true;
      }
    }

    if (!changed && !alignEquals) {
      out += block;
      continue;
    }

    const width = alignEquals
      ? Math.max(0, ...fields.map(f => f.name.length))
      : 0;

    // Every value is written in the form it was read in: braced, quoted, or
    // bare, so `month = jul` and `journal = jcp` still use their macros.
    const rendered = fields.map((f, idx) => {
      const pad = alignEquals ? ' '.repeat(width - f.name.length) : '';
      const comma = idx < fields.length - 1 ? ',' : '';
      return `  ${f.name}${pad} = ${f.raw}${comma}`;
    }).join('\n');

    out += `${header}\n${rendered}\n${tail}`;
  }

  return { text: out, entriesProcessed, fieldsRemoved };
}

/**
 * Normalise a list of DOIs pasted as text.
 *
 * Accepts the forms people actually paste: newline-separated, comma- or
 * semicolon-separated, or full resolver URLs. Duplicates are removed
 * case-insensitively, since a DOI is case-insensitive by specification and
 * fetching the same record twice wastes a request and produces a duplicate
 * entry.
 *
 * @param {string} text
 * @param {'auto'|'comma'|'semicolon'|'space'|'newline'} [delimiter='auto']
 * @returns {{dois:string[], duplicates:number}}
 */
export function parseDoiList(text, delimiter = 'auto') {
  const src = String(text || '');
  if (!src.trim()) return { dois: [], duplicates: 0 };

  let parts;
  switch (delimiter) {
    case 'comma': parts = src.split(','); break;
    case 'semicolon': parts = src.split(';'); break;
    case 'space': parts = src.split(/\s+/); break;
    case 'newline': parts = src.split(/\r?\n/); break;
    default:
      // Semicolons and commas both appear inside DOIs only rarely, but a
      // newline never does, so prefer an explicit separator when one is
      // present and fall back to lines otherwise.
      if (src.includes(';')) parts = src.split(';');
      else if (src.includes(',')) parts = src.split(',');
      else parts = src.split(/\r?\n/);
  }

  const cleaned = parts
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '').trim())
    .filter(Boolean);

  const seen = new Set();
  const dois = [];
  let duplicates = 0;

  for (const d of cleaned) {
    const key = d.toLowerCase();
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    dois.push(d);
  }

  return { dois, duplicates };
}

/**
 * Rewrite each entry of a raw BibTeX document with only the fields `keep`
 * accepts, one field per line. Values are copied exactly as written.
 * `@string`, `@preamble` and `@comment` blocks, and text between entries,
 * pass through untouched.
 */
function rewriteFields(bib, keep) {
  const text = String(bib || '');
  let out = '';
  let pos = 0;

  for (const block of scanDocument(text)) {
    out += text.slice(pos, block.start);
    pos = block.end;
    if (block.kind !== 'entry') {
      out += text.slice(block.start, block.end);
      continue;
    }

    const { key, fields } = readEntry(text, block);
    const kept = fields
      .filter(f => keep(f.name.toLowerCase()))
      .map(f => `  ${f.name} = ${text.slice(f.valueStart, f.valueEnd)}`);
    out += `@${block.type}{${key}${kept.length ? ',\n' + kept.join(',\n') + '\n' : '\n'}}`;
  }

  out += text.slice(pos);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

const fieldSet = (fields) => new Set([...(fields || [])].map(f => String(f).toLowerCase()));

/**
 * Keep only the named fields in a raw BibTeX entry.
 *
 * Scans the entry rather than its lines. That distinction matters: the DOI
 * content-negotiation service frequently returns a whole entry on a single
 * line, and several providers put two or three fields on one line. A
 * line-oriented filter cannot see those fields at all, so it silently returns
 * the input unchanged, filtering appears to do nothing.
 *
 * Values may be brace-delimited (with nesting, as in `{A study of {NaCl}}`),
 * quoted, bare (`year = 2020`, `month = jul`), or joined with `#`, and all are
 * copied exactly as written. `@string`, `@preamble` and `@comment` blocks and
 * text between entries are passed through untouched.
 *
 * Output is normalised to one field per line, which is the conventional
 * layout and keeps a filtered single-line entry readable.
 *
 * @param {string} bib - One entry, or a whole document.
 * @param {string[]|Set<string>} keepFields - Field names, case-insensitive.
 * @returns {string}
 */
export function filterBibtexFields(bib, keepFields) {
  const keep = fieldSet(keepFields);
  return rewriteFields(bib, name => keep.has(name));
}

/**
 * Remove the named fields from a raw BibTeX entry, keeping every other field.
 *
 * The complement of `filterBibtexFields`, for a caller that offers a fixed
 * list of fields to remove: a field that is not on the list, such as
 * `address` or `school`, is kept rather than silently lost. Layout and value
 * handling are the same as in `filterBibtexFields`.
 *
 * @param {string} bib - One entry, or a whole document.
 * @param {string[]|Set<string>} dropFields - Field names, case-insensitive.
 * @returns {string}
 */
export function dropBibtexFields(bib, dropFields) {
  const drop = fieldSet(dropFields);
  return rewriteFields(bib, name => !drop.has(name));
}

/**
 * Report which recommended fields an entry is missing.
 *
 * Requirements vary by entry type; these are the fields most styles need in
 * order to render a complete reference.
 *
 * @param {object} entry
 * @returns {string[]}
 */
export function missingFields(entry) {
  if (!entry) return [];
  const required = {
    article: ['author', 'title', 'journal', 'year'],
    book: ['author', 'title', 'publisher', 'year'],
    inproceedings: ['author', 'title', 'booktitle', 'year'],
    phdthesis: ['author', 'title', 'school', 'year'],
    techreport: ['author', 'title', 'institution', 'year']
  };

  const type = String(entry.entryType || '').toLowerCase();
  const want = required[type] || ['author', 'title', 'year'];
  return want.filter(f => !getField(entry.entryTags, f));
}
