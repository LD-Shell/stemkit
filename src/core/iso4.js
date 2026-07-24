/**
 * @module core/iso4
 *
 * ISO 4 serial-title abbreviation, driven by the ISSN List of Title Word
 * Abbreviations (LTWA).
 *
 * This is a different kind of resource from the whole-title dictionary in
 * `core/journals`. That module maps a complete journal name to its complete
 * abbreviation, which is exact but only covers titles someone has entered.
 * LTWA instead maps individual *title words* (usually as stems) to their
 * abbreviations, so any title can be abbreviated by applying the ISO 4 rules
 * word by word. The two complement each other: the dictionary is authoritative
 * where it has an entry, and this module generalises to everything else.
 *
 * ## LTWA entry shape
 *
 * Each LTWA row is a word pattern, an abbreviation, and the languages the rule
 * applies to. The word pattern uses a leading and/or trailing hyphen to mark
 * where it may be extended:
 *
 *   `journal`    exact , matches only "journal"
 *   `chemi-`     prefix, matches "chemi", "chemical", "chemistry", ...
 *   `-ology`     suffix, matches "biology", "geology", ...
 *   `-graph-`    infix , matches "biographical", ...
 *
 * An abbreviation of `n.a.` ("no abbreviation") means the word is recognised
 * but deliberately left in full. That is a real answer, not a lookup miss, and
 * is tracked separately from words LTWA simply does not know.
 *
 * ## Rules implemented
 *
 * - A single-word title is not abbreviated (ISO 4).
 * - Articles, conjunctions and prepositions are dropped, except as the first
 *   word of the title, where they are kept.
 * - Hyphenated compounds are abbreviated part by part.
 * - The longest matching LTWA pattern wins; an exact match beats a stem of the
 *   same length.
 * - Words with no match are left unchanged.
 * - The original word's capitalisation is carried onto the abbreviation.
 *
 * ## What this deliberately does not do
 *
 * ISO 4 leaves some judgement to the cataloguer, and a few rules need
 * information a word list cannot supply. Personal and place names should not
 * be abbreviated even when they match a stem, and this module cannot tell that
 * "Bell" is a surname rather than the noun. Callers that care should prefer a
 * dictionary hit, and `abbreviateTitle` reports every substitution it made so
 * the result can be reviewed rather than trusted blindly.
 */

/** Marker used by LTWA for a word that is recognised but never abbreviated. */
const NO_ABBREVIATION = 'n.a.';

/**
 * Words dropped from titles under ISO 4.
 *
 * ISO 4 omits articles, conjunctions and prepositions, but they are not all
 * treated alike: a preposition that opens a title is kept, because dropping it
 * would change the sense ("From Zero to Hero"), whereas a leading article
 * carries no information and always goes. LTWA does not record part of speech,
 * so the classification lives here. It covers the languages most common in the
 * serial literature; a title in an unlisted language simply keeps more words,
 * which is a safe way to fail.
 */
const ARTICLES = new Set([
  'a', 'an', 'the',
  'le', 'la', 'les', 'un', 'une', 'des', 'du',
  'der', 'die', 'das', 'den', 'dem', 'ein', 'eine', 'einer',
  'el', 'los', 'las', 'una', 'unos', 'unas', 'os', 'as', 'um', 'uma',
  'il', 'lo', 'gli', 'i',
  'het', 'een'
]);

const CONJUNCTIONS = new Set([
  'and', 'or', 'nor', 'but',
  'et', 'ou',
  'und', 'oder',
  'y', 'e', 'ed',
  'en'
]);

const PREPOSITIONS = new Set([
  'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'as',
  'into', 'onto', 'per', 'via', 'über',
  'de', 'dans', 'sur', 'pour', 'par', 'aux', 'au',
  'für', 'von', 'zur', 'zum', 'im',
  'para', 'por', 'do', 'da', 'dos', 'das',
  'nel', 'della', 'delle', 'degli', 'dei', 'con',
  'van', 'voor'
]);

/** Symbols standing in for a conjunction, dropped along with one. */
const CONJUNCTION_SYMBOLS = new Set(['&', '+']);

/**
 * ISO 639 codes mapped to the language names the LTWA actually uses.
 *
 * The ISSN export spells languages out in English ("German", "French") rather
 * than tagging them with codes, and a few carry a parenthetical qualifier such
 * as "Greek, Modern (1453- )". Callers should not have to know that, so both
 * spellings are accepted and normalised to the same key.
 */
const LANGUAGE_ALIASES = new Map([
  ['en', 'english'], ['eng', 'english'],
  ['de', 'german'], ['ger', 'german'], ['deu', 'german'],
  ['fr', 'french'], ['fre', 'french'], ['fra', 'french'],
  ['es', 'spanish'], ['spa', 'spanish'],
  ['it', 'italian'], ['ita', 'italian'],
  ['ru', 'russian'], ['rus', 'russian'],
  ['nl', 'dutch'], ['dut', 'dutch'], ['nld', 'dutch'],
  ['pt', 'portuguese'], ['por', 'portuguese'],
  ['sv', 'swedish'], ['swe', 'swedish'],
  ['hu', 'hungarian'], ['hun', 'hungarian'],
  ['pl', 'polish'], ['pol', 'polish'],
  ['cs', 'czech'], ['cze', 'czech'], ['ces', 'czech'],
  ['da', 'danish'], ['dan', 'danish'],
  ['no', 'norwegian'], ['nor', 'norwegian'],
  ['fi', 'finnish'], ['fin', 'finnish'],
  ['la', 'latin'], ['lat', 'latin'],
  ['el', 'greek'], ['gre', 'greek'], ['ell', 'greek'],
  ['ja', 'japanese'], ['jpn', 'japanese'],
  ['zh', 'chinese'], ['chi', 'chinese'], ['zho', 'chinese'],
  ['ar', 'arabic'], ['ara', 'arabic'],
  ['tr', 'turkish'], ['tur', 'turkish'],
  ['ro', 'romanian'], ['rum', 'romanian'], ['ron', 'romanian'],
  ['sk', 'slovak'], ['slo', 'slovak'], ['slk', 'slovak'],
  ['sl', 'slovenian'], ['slv', 'slovenian'],
  ['uk', 'ukrainian'], ['ukr', 'ukrainian'],
  ['ca', 'catalan'], ['cat', 'catalan'],
  ['he', 'hebrew'], ['heb', 'hebrew'],
  ['ko', 'korean'], ['kor', 'korean'],
  ['hr', 'croatian'], ['hrv', 'croatian'],
  ['sr', 'serbian'], ['srp', 'serbian'],
  ['bg', 'bulgarian'], ['bul', 'bulgarian'],
  ['mul', 'multilingual'],
  // The ISSN export spells this out rather than using the ISO code.
  ['multiple languages', 'multilingual'], ['multiple', 'multilingual']
]);

/**
 * Reduce a language tag to a comparable key.
 *
 * Parenthetical qualifiers are dropped, so "Greek, Modern (1453- )", which
 * the export splits into "Greek" and "Modern (1453- )", still matches a
 * request for Greek.
 *
 * @param {string} value
 * @returns {string}
 */
export function normLanguage(value) {
  const v = String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return LANGUAGE_ALIASES.get(v) || v;
}

/**
 * Latin locutions kept intact rather than treated as separate words.
 *
 * "in vivo" and friends read as single terms; dropping the preposition would
 * mangle them.
 */
const LOCUTIONS = [
  'in vivo', 'in vitro', 'in situ', 'in silico', 'ex vivo', 'in utero',
  'in press', 'de novo', 'post mortem', 'ad hoc'
];

/* ------------------------------------------------------------------ */
/* LTWA parsing                                                        */
/* ------------------------------------------------------------------ */

/** Strip a UTF-8 byte-order mark, which survives some spreadsheet exports. */
function stripBOM(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Guess the column delimiter.
 *
 * The ISSN download is named `.csv` but has historically shipped tab
 * separated, and abbreviations themselves contain periods and occasionally
 * commas. Counting candidates on the first few lines is more reliable than
 * trusting the file extension.
 *
 * @param {string} text
 * @returns {string} One of `\t`, `,` or `;`.
 */
export function sniffDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 20).filter(Boolean);
  if (!sample.length) return '\t';

  let best = '\t';
  let bestScore = -1;
  for (const d of ['\t', ';', ',']) {
    const counts = sample.map(line => line.split(d).length - 1);
    if (counts.every(c => c === 0)) continue;
    // Prefer the delimiter that yields a consistent column count.
    const first = counts[0];
    const consistent = counts.filter(c => c === first).length / counts.length;
    const score = consistent * 10 + Math.min(first, 3);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/**
 * Split one delimited line, honouring double-quoted fields.
 *
 * @param {string} line
 * @param {string} delim
 * @returns {string[]}
 */
function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/**
 * Classify an LTWA word pattern.
 *
 * @param {string} pattern
 * @returns {{kind:'exact'|'prefix'|'suffix'|'infix', stem:string}}
 */
export function classifyPattern(pattern) {
  const lead = pattern.startsWith('-');
  const tail = pattern.endsWith('-');
  const stem = pattern.replace(/^-/, '').replace(/-$/, '');
  if (lead && tail) return { kind: 'infix', stem };
  if (lead) return { kind: 'suffix', stem };
  if (tail) return { kind: 'prefix', stem };
  return { kind: 'exact', stem };
}

/**
 * Parse an LTWA export into structured entries.
 *
 * Tolerant by design: the delimiter is sniffed, a header row is detected and
 * skipped, quoted fields are handled, and malformed rows are counted rather
 * than thrown. A partially readable list is more useful than an exception.
 *
 * @param {string} text - Raw file contents, UTF-8.
 * @param {{delimiter?:string}} [options]
 * @returns {{entries:Array<object>, stats:{rows:number, parsed:number, skipped:number, delimiter:string}}}
 */
export function parseLTWA(text, options = {}) {
  const entries = [];
  const stats = { rows: 0, parsed: 0, skipped: 0, delimiter: '\t' };
  if (typeof text !== 'string' || !text.trim()) return { entries, stats };

  const clean = stripBOM(text);
  const delim = options.delimiter || sniffDelimiter(clean);
  stats.delimiter = delim;

  const lines = clean.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    stats.rows++;

    const cols = splitLine(raw, delim);
    if (cols.length < 2) { stats.skipped++; continue; }

    const [word, abbrev, langsRaw] = cols;
    if (!word) { stats.skipped++; continue; }

    // Skip the header wherever it appears.
    if (/^word$/i.test(word) || /^abbreviation$/i.test(abbrev || '')) continue;

    const { kind, stem } = classifyPattern(word);
    if (!stem) { stats.skipped++; continue; }

    const languages = (langsRaw || '')
      .split(/[,;/]/).map(normLanguage).filter(Boolean);

    const isNA = !abbrev || abbrev.toLowerCase() === NO_ABBREVIATION;

    entries.push({
      pattern: word,
      kind,
      stem: stem.toLowerCase(),
      abbrev: isNA ? null : abbrev,
      noAbbreviation: isNA,
      languages
    });
    stats.parsed++;
  }

  return { entries, stats };
}

/* ------------------------------------------------------------------ */
/* Trie                                                                */
/* ------------------------------------------------------------------ */

function newNode() {
  return { next: new Map(), entry: null };
}

/** Insert `key`, keeping the entry already stored if one exists. */
function trieInsert(root, key, entry) {
  let node = root;
  for (const ch of key) {
    let child = node.next.get(ch);
    if (!child) { child = newNode(); node.next.set(ch, child); }
    node = child;
  }
  // Exact patterns are more specific than stems of identical length.
  if (!node.entry || (entry.kind === 'exact' && node.entry.kind !== 'exact')) {
    node.entry = entry;
  }
}

/**
 * Longest stored key that is a prefix of `word`.
 *
 * @returns {{entry:object, length:number}|null}
 */
function trieLongestPrefix(root, word) {
  let node = root;
  let best = null;
  for (let i = 0; i < word.length; i++) {
    node = node.next.get(word[i]);
    if (!node) break;
    if (node.entry) best = { entry: node.entry, length: i + 1 };
  }
  return best;
}

function reverse(s) {
  return [...s].reverse().join('');
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

/**
 * Build a matcher from parsed LTWA entries.
 *
 * Entries are indexed by match kind so a lookup is a handful of trie walks
 * rather than a scan of tens of thousands of rows.
 *
 * @param {Array<object>} entries - From {@link parseLTWA}.
 * @param {{languages?:string[]}} [options] - Restrict to these language codes;
 *   entries tagged `mul` (multilingual) always apply. Omit to accept all.
 * @returns {object} Engine handle for {@link abbreviateWord} / {@link abbreviateTitle}.
 */
export function buildIso4Engine(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const langFilter = Array.isArray(options.languages) && options.languages.length
    ? new Set(options.languages.map(normLanguage))
    : null;

  const applies = (e) => {
    if (!langFilter) return true;
    if (!e.languages.length) return true;          // untagged rules are general
    return e.languages.some(l => l === 'multilingual' || langFilter.has(l));
  };

  const exact = new Map();
  const prefixTrie = newNode();
  const suffixTrie = newNode();
  const infixes = [];
  let count = 0;

  for (const e of list) {
    if (!applies(e)) continue;
    count++;
    if (e.kind === 'exact') {
      if (!exact.has(e.stem)) exact.set(e.stem, e);
    } else if (e.kind === 'prefix') {
      trieInsert(prefixTrie, e.stem, e);
    } else if (e.kind === 'suffix') {
      trieInsert(suffixTrie, reverse(e.stem), e);
    } else {
      infixes.push(e);
    }
  }

  // Longest first so the most specific infix wins without a full scan order
  // dependency.
  infixes.sort((a, b) => b.stem.length - a.stem.length);

  return {
    exact,
    prefixTrie,
    suffixTrie,
    infixes,
    entryCount: count,
    languages: langFilter ? [...langFilter] : null
  };
}

/**
 * Copy the capitalisation of `source` onto `target`.
 *
 * ISO 4 does not prescribe case, so the sanest behaviour is to leave the
 * author's styling alone: a capitalised word stays capitalised, an all-caps
 * word stays all-caps.
 *
 * @param {string} target
 * @param {string} source
 * @returns {string}
 */
export function matchCase(target, source) {
  if (!target) return target;
  const letters = source.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters && letters === letters.toUpperCase() && letters.length > 1) {
    return target.toUpperCase();
  }
  if (source[0] && source[0] === source[0].toUpperCase()) {
    return target[0].toUpperCase() + target.slice(1);
  }
  return target[0].toLowerCase() + target.slice(1);
}

/**
 * Abbreviate a single title word.
 *
 * @param {string} word - One word, without surrounding punctuation.
 * @param {object} engine - From {@link buildIso4Engine}.
 * @returns {{value:string, matched:boolean, rule:object|null, reason:string}}
 *   `reason` is one of `exact`, `prefix`, `suffix`, `infix`, `no-abbreviation`
 *   or `unmatched`.
 */
export function abbreviateWord(word, engine) {
  const out = { value: word, matched: false, rule: null, reason: 'unmatched' };
  if (!word || !engine) return out;

  const lower = word.toLowerCase();

  const candidates = [];

  const ex = engine.exact.get(lower);
  if (ex) candidates.push({ entry: ex, length: lower.length + 0.5 });

  const pre = trieLongestPrefix(engine.prefixTrie, lower);
  if (pre) candidates.push(pre);

  const suf = trieLongestPrefix(engine.suffixTrie, reverse(lower));
  if (suf) candidates.push(suf);

  if (!candidates.length) {
    for (const e of engine.infixes) {
      if (e.stem.length < lower.length && lower.includes(e.stem)) {
        candidates.push({ entry: e, length: e.stem.length });
        break;                       // list is longest-first
      }
    }
  }

  if (!candidates.length) return out;

  candidates.sort((a, b) => b.length - a.length);
  const win = candidates[0].entry;

  out.rule = win;
  out.matched = true;

  if (win.noAbbreviation) {
    out.reason = 'no-abbreviation';
    return out;                       // recognised, deliberately left in full
  }

  out.reason = win.kind;
  out.value = matchCase(win.abbrev, word);
  return out;
}

/**
 * Decide whether a word is dropped from the abbreviated title.
 *
 * Articles and conjunctions always go. A preposition goes too, unless it opens
 * the title, where ISO 4 keeps it so the sense survives.
 *
 * @param {string} token - The bare word, punctuation already stripped.
 * @param {number} index - Position in the title, 0 for the first word.
 * @returns {boolean}
 */
function isDropped(token, index) {
  const w = token.toLowerCase();
  if (ARTICLES.has(w)) return true;
  if (CONJUNCTIONS.has(w)) return true;
  if (PREPOSITIONS.has(w)) return index > 0;
  return false;
}

/**
 * Abbreviate a complete serial title under ISO 4.
 *
 * @param {string} title
 * @param {object} engine - From {@link buildIso4Engine}.
 * @param {{keepStopWords?:boolean}} [options]
 * @returns {{
 *   abbreviation: string,
 *   changed: boolean,
 *   words: Array<{original:string, value:string, dropped:boolean, reason:string}>,
 *   unmatched: string[]
 * }}
 */
export function abbreviateTitle(title, engine, options = {}) {
  const empty = { abbreviation: '', changed: false, words: [], unmatched: [] };
  if (typeof title !== 'string' || !title.trim() || !engine) return empty;

  const trimmed = title.trim();

  // A one-word title is left alone, per ISO 4.
  const bare = trimmed.split(/\s+/);
  if (bare.length === 1) {
    return {
      abbreviation: trimmed,
      changed: false,
      words: [{ original: trimmed, value: trimmed, dropped: false, reason: 'single-word-title' }],
      unmatched: []
    };
  }

  // Protect Latin locutions so their prepositions survive the stop-word pass.
  let working = trimmed;
  const held = [];
  for (const loc of LOCUTIONS) {
    const re = new RegExp(`\\b${loc.replace(/ /g, '\\s+')}\\b`, 'gi');
    working = working.replace(re, (m) => {
      held.push(m);
      return `\u0000${held.length - 1}\u0000`;
    });
  }

  const tokens = working.split(/\s+/).filter(Boolean);
  const words = [];
  const unmatched = [];
  let changed = false;

  tokens.forEach((token, index) => {
    const holdMatch = token.match(/^\u0000(\d+)\u0000([^\w]*)$/);
    if (holdMatch) {
      const text = held[Number(holdMatch[1])];
      words.push({ original: text, value: text + (holdMatch[2] || ''), dropped: false, reason: 'locution' });
      return;
    }

    // Peel punctuation so it can be restored around the abbreviation.
    const m = token.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
    const lead = m ? m[1] : '';
    const core = m ? m[2] : token;
    const trail = m ? m[3] : '';

    if (!core) {
      // A lone "&" is standing in for "and", so it goes the same way.
      if (!options.keepStopWords && CONJUNCTION_SYMBOLS.has(token.trim())) {
        words.push({ original: token, value: '', dropped: true, reason: 'conjunction' });
        changed = true;
        return;
      }
      words.push({ original: token, value: token, dropped: false, reason: 'punctuation' });
      return;
    }

    if (!options.keepStopWords && isDropped(core, index)) {
      words.push({ original: token, value: '', dropped: true, reason: 'stop-word' });
      changed = true;
      return;
    }

    // Hyphenated compounds abbreviate part by part.
    if (core.includes('-')) {
      const parts = core.split('-');
      const done = parts.map(p => {
        if (!p) return p;
        const r = abbreviateWord(p, engine);
        if (r.value !== p) changed = true;
        if (!r.matched) unmatched.push(p);
        return r.value;
      });
      words.push({
        original: token,
        value: lead + done.join('-') + trail,
        dropped: false,
        reason: 'compound'
      });
      return;
    }

    const r = abbreviateWord(core, engine);
    if (r.value !== core) changed = true;
    if (!r.matched) unmatched.push(core);

    words.push({
      original: token,
      value: lead + r.value + trail,
      dropped: false,
      reason: r.reason
    });
  });

  const abbreviation = words
    .filter(w => !w.dropped && w.value)
    .map(w => w.value)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { abbreviation, changed, words, unmatched };
}

/**
 * Convenience wrapper: parse a raw LTWA file and build the engine in one step.
 *
 * @param {string} text - Raw LTWA export.
 * @param {{languages?:string[], delimiter?:string}} [options]
 * @returns {{engine:object, stats:object}}
 */
export function loadIso4(text, options = {}) {
  const { entries, stats } = parseLTWA(text, options);
  const engine = buildIso4Engine(entries, options);
  return { engine, stats: { ...stats, indexed: engine.entryCount } };
}

/**
 * Turn titles the dictionary did not recognise into synthetic rules.
 *
 * This is the join between the two tiers. `core/journals` already knows how to
 * replace, highlight and count whole-title substitutions; rather than
 * duplicating that, ISO 4 results are handed back in the same
 * `[title, abbreviation]` shape the dictionary uses, so the caller can fold
 * them into a normal engine and the rest of the pipeline is unchanged.
 *
 * Titles ISO 4 leaves untouched, a single word, or one where nothing matched , 
 * are omitted, so they keep being reported as unknown rather than appearing as
 * a substitution that changed nothing.
 *
 * @param {string[]} titles - Candidates, e.g. from `findUnknownTitles`.
 * @param {object} engine - From {@link buildIso4Engine}.
 * @returns {Array<[string, string]>} Rules in dictionary order.
 */
export function deriveRulesForUnknowns(titles, engine) {
  const rules = [];
  if (!Array.isArray(titles) || !engine) return rules;

  const seen = new Set();
  for (const title of titles) {
    if (typeof title !== 'string') continue;
    const key = title.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const r = abbreviateTitle(key, engine);
    if (r.changed && r.abbreviation && r.abbreviation !== key) {
      rules.push([key, r.abbreviation]);
    }
  }
  return rules;
}
