/**
 * @module core/journals
 *
 * Journal-title abbreviation, extracted from STEMKit's Journal Abbreviator.
 *
 * Abbreviating references by hand is error-prone because journal titles vary
 * in ways that should not affect matching: "Journal of the American Chemical
 * Society" and "Journal of The American Chemical Soc." are the same journal,
 * and an ampersand may be spelled "and". Two mechanisms handle this:
 *
 *   - **Normalisation** collapses case, punctuation, dashes, ampersands, and a
 *     leading "The" into a canonical key for dictionary lookup.
 *   - **Pattern matching** compiles each known title into a regex that tolerates
 *     the same variations *in place*, so titles can be found and replaced
 *     inside running prose rather than only as whole strings.
 *
 * Titles are compiled longest-first, so "Journal of Physical Chemistry Letters"
 * is matched before the shorter "Journal of Physical Chemistry" that it
 * contains. Without that ordering the longer title would be abbreviated as if
 * it were the shorter one, silently changing the citation.
 */

/**
 * Normalise a journal title into a lookup key.
 *
 * @param {string} s
 * @returns {string}
 */
export function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\u2013\u2014-]/g, ' ')
    .replace(/[:,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

/**
 * Compile one journal name into a regex fragment.
 *
 * Placeholder control characters are used as an intermediate step so that the
 * separators inserted by one replacement are not re-processed by the next, the
 * same single-pass concern that affects LaTeX escaping.
 *
 * @param {string} name
 * @returns {string} A regex source fragment.
 */
export function toPatternPart(name) {
  const canonical = String(name || '').replace(/^the\s+/i, '');
  return canonical
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s*[-\u2013\u2014]\s*/g, '\x01')
    .replace(/\s*&\s*/g, '\x02')
    .replace(/[:,]/g, '\x03')
    .replace(/\s+/g, '\\s+')
    .replace(/\x01/g, '(?:\\s*[-\\u2013\\u2014]\\s*|\\s+)')
    .replace(/\x02/g, '\\s+(?:&|and)\\s+')
    .replace(/\x03/g, '[:,]?');
}

/**
 * Parse user-supplied abbreviation rules.
 *
 * Format is `Full Journal Name = Abbrev.` per line; `#` starts a comment.
 *
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
export function parseCustomRules(text) {
  const rules = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const name = t.slice(0, i).trim();
    const abbr = t.slice(i + 1).trim();
    if (name && abbr) rules.push([name, abbr]);
  }
  return rules;
}

/**
 * Build an abbreviation engine from a dictionary and optional custom rules.
 *
 * Custom rules are applied after the built-in dictionary, so a user can
 * override any bundled entry.
 *
 * @param {Array<[string, string]>} builtin
 * @param {Array<[string, string]>} [custom]
 * @returns {{
 *   lookup: Object<string, string>,
 *   pattern: RegExp|null,
 *   builtinCount: number,
 *   customCount: number,
 *   entryCount: number
 * }}
 */
export function buildEngine(builtin, custom = []) {
  const base = Array.isArray(builtin) ? builtin : [];
  const extra = Array.isArray(custom) ? custom : [];

  const lookup = {};
  const displayNames = new Map();

  for (const [name, abbr] of [...base, ...extra]) {
    if (!name || !abbr) continue;
    const key = normKey(name);
    if (!key) continue;
    lookup[key] = abbr;
    displayNames.set(key, name);
  }

  // Longest first, so a full title beats any shorter title embedded in it.
  const parts = [...displayNames.values()]
    .sort((a, b) => b.length - a.length)
    .map(toPatternPart);

  const pattern = parts.length
    ? new RegExp(`\\b(?:the\\s+)?(?:${parts.join('|')})\\b`, 'gi')
    : null;

  return {
    lookup,
    pattern,
    builtinCount: base.length,
    customCount: extra.length,
    entryCount: displayNames.size
  };
}

/**
 * Look up a title's abbreviation.
 *
 * @param {string} title
 * @param {Object<string, string>} lookup
 * @returns {string|null}
 */
export function abbreviate(title, lookup) {
  if (!lookup) return null;
  const key = normKey(title);
  return Object.prototype.hasOwnProperty.call(lookup, key) ? lookup[key] : null;
}

/**
 * Heuristic for spotting titles that *look* like journals but are not in the
 * dictionary.
 *
 * Reporting these matters: a reference list where two titles were abbreviated
 * and one was silently left alone is worse than one where nothing was, because
 * the inconsistency is easy to miss on proofreading.
 */
export const SUSPECT_TITLE = new RegExp(
  '\\b(?:(?:International|European|American|Annual|Canadian|Australian|' +
  'Applied|Russian|Chinese|Japanese)\\s+)?' +
  '(?:Journal|Proceedings|Transactions|Annals|Reviews?)\\s+(?:of|in|on)\\s+' +
  '(?:the\\s+)?[A-Z][\\w&-]*(?:\\s+(?:(?:of|and|in|for|the)\\s+)?[A-Z][\\w&-]*){0,6}',
  'g'
);

/**
 * Abbreviate every known journal title in a block of text.
 *
 * @param {string} text
 * @param {{lookup:Object, pattern:RegExp|null}} engine
 * @returns {{
 *   text: string,
 *   replacements: Array<{from:string, to:string, index:number}>,
 *   unknown: string[]
 * }}
 */
export function processText(text, engine) {
  const src = String(text || '');
  const replacements = [];

  if (!engine || !engine.pattern) {
    return { text: src, replacements, unknown: findUnknownTitles(src, engine) };
  }

  // A fresh regex each call: a /g regex carries lastIndex between uses, and
  // reusing the compiled one would skip matches on the second invocation.
  const re = new RegExp(engine.pattern.source, engine.pattern.flags);

  const out = src.replace(re, (match, offset) => {
    const abbr = abbreviate(match, engine.lookup);
    if (abbr === null) return match;

    // An identity entry (Nature -> Nature) is a real dictionary hit even
    // though the text is unchanged: several journals are not abbreviated at
    // all. Recording it lets a caller say "6 titles recognised" honestly,
    // while `changed` distinguishes the ones that were actually rewritten.
    const changed = abbr.toLowerCase() !== match.toLowerCase();
    replacements.push({ from: match, to: abbr, index: offset, changed });
    return abbr;
  });

  return { text: out, replacements, unknown: findUnknownTitles(out, engine) };
}

/**
 * Find journal-like titles absent from the dictionary.
 *
 * @param {string} text
 * @param {{lookup:Object}} engine
 * @returns {string[]} Unique titles, in order of first appearance.
 */
export function findUnknownTitles(text, engine) {
  const src = String(text || '');
  const lookup = (engine && engine.lookup) || {};
  const re = new RegExp(SUSPECT_TITLE.source, SUSPECT_TITLE.flags);

  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const candidate = m[0].trim();
    if (abbreviate(candidate, lookup) !== null) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

/**
 * Segment text into replaced and untouched runs, for highlighted display.
 *
 * Returning segments rather than HTML keeps the core free of markup and lets
 * the caller decide how to render.
 *
 * An *identity* entry, a journal whose abbreviation equals its full name, such
 * as "Nature" or "Small", is emitted as untouched text rather than as a
 * replacement. Counting it as a change would inflate the reported edit count
 * with substitutions the reader cannot see, and highlighting it would draw the
 * eye to text that did not move.
 *
 * @param {string} text
 * @param {{lookup:Object, pattern:RegExp|null}} engine
 * @returns {Array<{type:'text'|'replaced', value:string, original?:string}>}
 */
export function segmentText(text, engine) {
  const src = String(text || '');
  if (!engine || !engine.pattern) return [{ type: 'text', value: src }];

  const re = new RegExp(engine.pattern.source, engine.pattern.flags);
  const segments = [];
  let last = 0;
  let m;

  while ((m = re.exec(src)) !== null) {
    const abbr = abbreviate(m[0], engine.lookup);

    if (abbr === null) {
      // Not in the dictionary; leave it as plain text. The loop still advances
      // so a zero-length match cannot stall it.
      if (m[0].length === 0) re.lastIndex++;
      continue;
    }

    if (m.index > last) {
      segments.push({ type: 'text', value: src.slice(last, m.index) });
    }
    // An identity entry is still a recognised title, so it is segmented and
    // can be highlighted; `changed` tells the caller whether the text differs.
    segments.push({
      type: 'replaced',
      value: abbr,
      original: m[0],
      changed: abbr.toLowerCase() !== m[0].toLowerCase()
    });
    last = m.index + m[0].length;

    if (m[0].length === 0) re.lastIndex++;
  }

  if (last < src.length) segments.push({ type: 'text', value: src.slice(last) });
  return segments;
}
