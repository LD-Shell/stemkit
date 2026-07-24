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
 * Parsing is delegated to the vendored bibtex-parse-js bundle via the
 * injection layer.
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

/**
 * Remove `@string`, `@comment`, and `@preamble` blocks from a BibTeX document.
 *
 * These are legal and common, Zotero, Mendeley, and JabRef all emit them , 
 * but the vendored bibtex-parse-js cannot parse them and aborts the *entire*
 * document with a token-mismatch error when one is present. Since they carry
 * no bibliographic identity, stripping them first preserves every real entry
 * instead of losing the whole library to one `@string` line.
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
  let removed = 0;
  let i = 0;

  while (i < src.length) {
    const at = src.indexOf('@', i);
    if (at === -1) {
      out += src.slice(i);
      break;
    }

    const header = src.slice(at).match(/^@\s*(string|comment|preamble)\s*[{(]/i);
    if (!header) {
      out += src.slice(i, at + 1);
      i = at + 1;
      continue;
    }

    out += src.slice(i, at);

    // Walk forward to the matching close brace.
    const openIdx = at + header[0].length - 1;
    const open = src[openIdx];
    const close = open === '{' ? '}' : ')';
    let depth = 0;
    let j = openIdx;
    for (; j < src.length; j++) {
      if (src[j] === open) depth++;
      else if (src[j] === close) {
        depth--;
        if (depth === 0) { j++; break; }
      }
    }
    removed++;
    i = j;
  }

  return { text: out, removed };
}

/**
 * Parse a BibTeX document into entry objects.
 *
 * Non-reference constructs are removed before parsing (see
 * `stripNonEntryBlocks`), and anything the parser still rejects is reported
 * without throwing.
 *
 * @param {string} text
 * @returns {{entries:object[], error:string|null, strippedBlocks:number}}
 */
export function parseBibtex(text) {
  const bibtexParse = requireVendor('bibtexParse');
  if (typeof text !== 'string' || text.trim() === '') {
    return { entries: [], error: null, strippedBlocks: 0 };
  }

  const { text: cleaned, removed } = stripNonEntryBlocks(text);
  if (cleaned.trim() === '') {
    return { entries: [], error: null, strippedBlocks: removed };
  }

  let parsed;
  try {
    parsed = bibtexParse.toJSON(cleaned.trim());
  } catch (err) {
    // bibtex-parse-js throws bare strings rather than Error objects, so the
    // usual err.message access would itself throw here.
    const detail = (err && err.message) ? err.message : String(err);
    return {
      entries: [],
      error: `Syntax error in BibTeX: ${detail}`,
      strippedBlocks: removed
    };
  }

  const entries = (parsed || []).filter(e => e && e.entryTags && e.citationKey);
  return { entries, error: null, strippedBlocks: removed };
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
 * @param {object} entry
 * @returns {string}
 */
export function serialiseEntry(entry) {
  if (!entry) return '';
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
 * @param {object[]} entries
 * @returns {string}
 */
export function serialiseLibrary(entries) {
  if (!Array.isArray(entries)) return '';
  return entries.map(serialiseEntry).join('');
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
 * string macro).
 *
 * @param {string} content - The body of an entry, between the citation key and
 *        the closing brace.
 * @returns {Array<{key:string, value:string}>} Keys lowercased; values verbatim.
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

    let key = '';
    while (i < n && isKeyChar(src[i])) { key += src[i]; i++; }
    if (!key) { i++; continue; }

    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] !== '=') {
      // Malformed field: skip to the next separator rather than derailing.
      while (i < n && src[i] !== ',') i++;
      continue;
    }
    i++;
    while (i < n && /\s/.test(src[i])) i++;

    let value = '';
    if (src[i] === '{') {
      let depth = 0;
      for (; i < n; i++) {
        const c = src[i];
        if (c === '{') { depth++; if (depth === 1) continue; }
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
        value += c;
      }
    } else if (src[i] === '"') {
      i++;
      let depth = 0;
      for (; i < n; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '"' && depth === 0) { i++; break; }
        value += c;
      }
    } else {
      while (i < n && src[i] !== ',') { value += src[i]; i++; }
      value = value.trim();
    }

    fields.push({ key: key.toLowerCase(), value });
  }
  return fields;
}

/**
 * Sanitise a BibTeX document in place, preserving everything not targeted.
 *
 * Unlike `sanitiseLibrary`, which reformats through the parser, this operates
 * on the source text: `@string`, `@preamble`, and `@comment` blocks pass
 * through untouched, nested braces survive, and an entry with no applicable
 * rule comes out exactly as it went in. That matters for a library under
 * version control, where a reformatting pass produces a diff touching every
 * line and hides the changes that were actually intended.
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

  for (const block of src.split(/(?=@\w+\s*\{)/g)) {
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

    const headerMatch = block.match(/(@\w+\s*\{\s*[^,]+,)/);
    if (!headerMatch) {
      out += block;
      continue;
    }

    entriesProcessed++;
    const header = headerMatch[1];
    const body = block.slice(header.length);
    const lastBrace = body.lastIndexOf('}');
    const content = lastBrace >= 0 ? body.slice(0, lastBrace) : body;
    const tail = lastBrace >= 0 ? body.slice(lastBrace) : '}';

    let fields = readFieldsPreservingBraces(content);

    fields = fields.filter(f => {
      if (strip.has(f.key)) { fieldsRemoved++; return false; }
      return true;
    });

    for (const f of fields) {
      if (fixPages && (f.key === 'pages' || f.key === 'page')) {
        f.value = fixPageRange(f.value);
      }
      if (protectTitle && f.key === 'title') {
        f.value = protectCapitals(f.value);
      }
    }

    const width = alignEquals
      ? Math.max(0, ...fields.map(f => f.key.length))
      : 0;

    const rendered = fields.map((f, idx) => {
      const pad = alignEquals ? ' '.repeat(width - f.key.length) : '';
      const comma = idx < fields.length - 1 ? ',' : '';
      return `  ${f.key}${pad} = {${f.value}}${comma}`;
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
 * Keep only the named fields in a raw BibTeX entry.
 *
 * Scans the entry rather than its lines. That distinction matters: the DOI
 * content-negotiation service frequently returns a whole entry on a single
 * line, and several providers put two or three fields on one line. A
 * line-oriented filter cannot see those fields at all, so it silently returns
 * the input unchanged, filtering appears to do nothing.
 *
 * Values may be brace-delimited (with nesting, as in `{A study of {NaCl}}`),
 * quoted, or bare (`year = 2020`, `month = jul`), and all three are handled.
 * Text outside an entry (comments, `@string` definitions) is passed through
 * untouched.
 *
 * Output is normalised to one field per line, which is the conventional
 * layout and keeps a filtered single-line entry readable.
 *
 * @param {string} bib - One entry, or a whole document.
 * @param {string[]|Set<string>} keepFields - Field names, case-insensitive.
 * @returns {string}
 */
export function filterBibtexFields(bib, keepFields) {
  const keep = keepFields instanceof Set
    ? new Set([...keepFields].map(f => String(f).toLowerCase()))
    : new Set((keepFields || []).map(f => String(f).toLowerCase()));

  const text = String(bib || '');
  let out = '';
  let i = 0;

  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at === -1) { out += text.slice(i); break; }

    out += text.slice(i, at);

    const open = text.indexOf('{', at);
    if (open === -1) { out += text.slice(at); break; }

    const type = text.slice(at + 1, open).trim();
    // `@string{...}` and friends are not reference entries; leave them be.
    if (!/^[A-Za-z]+$/.test(type)) { out += text.slice(at, open + 1); i = open + 1; continue; }

    let j = open + 1;

    // Citation key runs to the first comma at brace depth zero.
    let depth = 0;
    let keyEnd = j;
    while (keyEnd < text.length) {
      const c = text[keyEnd];
      if (c === '{') depth++;
      else if (c === '}') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
      keyEnd++;
    }
    const key = text.slice(j, keyEnd).trim();
    j = text[keyEnd] === ',' ? keyEnd + 1 : keyEnd;

    const kept = [];
    let closed = false;

    while (j < text.length) {
      while (j < text.length && /[\s,]/.test(text[j])) j++;
      if (text[j] === '}') { j++; closed = true; break; }

      const nameMatch = /^([A-Za-z][\w-]*)\s*=\s*/.exec(text.slice(j));
      if (!nameMatch) break;                       // malformed; stop cleanly
      const name = nameMatch[1];
      j += nameMatch[0].length;

      const valueStart = j;
      if (text[j] === '{') {
        let d = 0;
        while (j < text.length) {
          const c = text[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '{') d++;
          else if (c === '}') { d--; if (d === 0) { j++; break; } }
          j++;
        }
      } else if (text[j] === '"') {
        j++;
        while (j < text.length) {
          const c = text[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '"') { j++; break; }
          j++;
        }
      } else {
        let d = 0;
        while (j < text.length) {
          const c = text[j];
          if (c === '{') d++;
          else if (c === '}') { if (d === 0) break; d--; }
          else if (c === ',' && d === 0) break;
          j++;
        }
      }

      const value = text.slice(valueStart, j).trim();
      if (keep.has(name.toLowerCase())) kept.push(`  ${name} = ${value}`);
    }

    if (!closed) {
      const brace = text.indexOf('}', j);
      j = brace === -1 ? text.length : brace + 1;
    }

    out += `@${type}{${key}${kept.length ? ',\n' + kept.join(',\n') + '\n' : '\n'}}`;
    i = j;
  }

  return out.replace(/\n{3,}/g, '\n\n').trim();
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
