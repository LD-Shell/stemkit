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
 * References. Clause numbers below are those of ISO 4:1997, "Information and
 * documentation: Rules for the abbreviation of title words and titles of
 * publications" (third edition). The ISSN International Centre is its
 * registration authority and publishes the LTWA (https://portal.issn.org/ltwa;
 * the dated PDF edition, e.g. https://www.issn.org/wp-content/uploads/2024/02/ltwa_current.pdf,
 * prints the same rows).
 *
 * ## LTWA entry shape
 *
 * Each row is a word pattern, an abbreviation, and the languages the rule was
 * written for. A hyphen marks where the pattern may be extended:
 *
 *   `journal`      exact  , "journal" (and its inflected forms, see below)
 *   `chemi-`       stem   , "chemical", "chemistry", ... (truncation, 2.22)
 *   `-forschung`   final  , the last component of a compound:
 *                           "Naturforschung" = "Natur" + "forsch."
 *   `-graph-`      inner  , a component inside a compound:
 *                           "Bibliographical" = "Biblio" + "gr."
 *
 * A leading hyphen is repeated on the abbreviation ("-forschung" = "-forsch.")
 * and means "the part of the word before this component is kept". It is not a
 * character of the output: printing it is what used to turn "Zeitschrift für
 * Naturforschung" into "Z. -forsch.". A pattern with a leading hyphen only
 * describes a component, so it never applies to a word that *is* that
 * component on its own ("Phase" is not a compound of "-phas-"), nor to a word
 * whose remaining head is too short to be a component ("Dalton" is not
 * "Dal" + "-ton"; 3.8 forbids abbreviating personal names).
 *
 * Other row shapes in the real export: multi-word entries ("United States of
 * America" = "U. S. A.", "Los alamos" = not abbreviated, 3.10), a sense note in
 * parentheses ("Band (book)", "real (royal)"), an optional letter
 * ("Wachst(h)um"), and an empty abbreviation (or `n.a.`) for a word that is
 * recognised but deliberately left in full. A not-abbreviated word is a real
 * answer, not a lookup miss, and is reported separately from words LTWA does
 * not know.
 *
 * ## Word rules
 *
 * - 3.1  At least two letters must be dropped, or the word stays in full
 *        ("Alloys" is not "Alloy."; "Chemi" is not "Chem.").
 * - 3.2  Diacritics are kept as written in the title, and a title spelled
 *        without them still matches ("Electronic" matches "electróni-" and
 *        becomes "Electron.").
 * - 3.3  Artificial words keep their form (CrystEngComm, eLife, AIChE).
 * - 3.4  Plurals and other inflected forms take the singular's abbreviation
 *        when its spelling survives ("Reports" = "Rep.", "Equilibria" =
 *        "Equilib.", "Jahrbücher" = "Jahrb.").
 * - 3.7  Compound words: hyphenated compounds are abbreviated part by part and
 *        keep their hyphens; in a closed compound the leading components may
 *        stay in full (NOTE to 3.7), so "Electrochimica" = "Electro" + "chim.".
 * - 3.12 An abbreviation never contains a character absent from the word, so
 *        every output letter is copied from the title itself (this also
 *        carries the title's capitalisation, 4.5).
 *
 * ## Title rules
 *
 * - 4.2  A title of one word, not counting articles, prepositions, letter or
 *        number designators, or a parenthesised qualifier, is not abbreviated.
 * - 4.3  Articles, conjunctions and prepositions are dropped, except a
 *        preposition that opens the title, and words inside a locution
 *        ("in vivo") or a name the LTWA lists as a phrase ("Los Alamos").
 * - 4.4  Acronyms, initialisms and letter designators are kept: "Journal of
 *        Physics A" is "J. Phys. A", not "J. Phys.", and section letters,
 *        numbers and roman numerals survive. A word that only looks like a
 *        function word because of its spelling ("Au" in "JACS Au", "E" in
 *        "Physical Review E") is kept when it closes the title or a section,
 *        since an article or preposition cannot.
 * - 4.6  Commas are dropped and a full stop between title parts becomes a
 *        comma; an ellipsis is dropped; other punctuation is kept.
 * - 4.7  "&" and "+" standing for "and" are dropped.
 * - 4.8  Section and part designations are kept with their generic term
 *        abbreviated ("Section A" = "Sect. A"), one of the two forms 4.8 allows.
 *
 * ## What this deliberately does not do
 *
 * ISO 4 leaves some judgement to the cataloguer, and a few rules need
 * information a word list cannot supply. Personal and place names should not
 * be abbreviated even when they match a stem (3.8), and this module cannot
 * tell that "Bell" is a surname rather than the noun. Publishers' registered
 * abbreviations also depart from ISO 4 on purpose (CASSI's comma before a
 * section letter, "Hydrogen" left in full). Callers that care should prefer a
 * dictionary hit, and `abbreviateTitle` reports every substitution it made so
 * the result can be reviewed rather than trusted blindly.
 */

/** Marker used by LTWA for a word that is recognised but never abbreviated. */
const NO_ABBREVIATION = 'n.a.';

/**
 * Shortest head a final or inner component (a pattern with a leading hyphen)
 * may leave in front of it. "Natur|forschung" and "Southamp|ton" (the 3.10
 * example) qualify; "Dal|ton" and "Ph|ase" do not.
 */
const MIN_COMPOUND_HEAD = 4;

/**
 * Shortest combining form ("bio-", "geo-", "electro-") read in front of a
 * known word when the list has no row for the whole compound (3.7):
 * "Bioorganic" is "Bio" + "org.", "Geosystems" is "Geo" + "syst.".
 */
const MIN_COMBINING_HEAD = 3;

/**
 * Words dropped from titles under ISO 4 (4.3).
 *
 * A preposition that opens a title is kept, because dropping it would change
 * the sense ("From Zero to Hero"), whereas a leading article carries no
 * information and always goes. LTWA does not record part of speech, so the
 * classification lives here. It covers the languages most common in the
 * serial literature; a title in an unlisted language simply keeps more words,
 * which is a safe way to fail. Two-letter words that double as chemical
 * symbols or English abbreviations ("Al", "Na", "No", "Op") are left out.
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
  'into', 'onto', 'per', 'via', 'about', 'among', 'between', 'through',
  'toward', 'towards', 'under', 'upon', 'within', 'without', 'versus', 'vs',
  'de', 'dans', 'sur', 'pour', 'par', 'aux', 'au', 'à', 'chez', 'avec', 'entre', 'sous', 'vers',
  'für', 'über', 'von', 'vom', 'zur', 'zum', 'im', 'aus', 'bei', 'beim', 'mit', 'nach', 'zu', 'auf',
  'para', 'por', 'do', 'da', 'dos', 'del', 'con', 'sobre', 'sin',
  'di', 'nel', 'nella', 'nelle', 'della', 'delle', 'dello', 'degli', 'dei', 'sul', 'sulla', 'tra', 'fra',
  'van', 'voor', 'met', 'uit', 'bij', 'tot'
]);

/** Symbols standing in for a conjunction, dropped along with one (4.7). */
const CONJUNCTION_SYMBOLS = new Set(['&', '+']);

/**
 * Generic terms that introduce a section, part, series or supplement (4.2,
 * 4.8). A letter or numeral after one is a designator, and the term itself
 * does not count as a title word when deciding whether a title is "one word".
 */
const GENERIC_TERMS = new Set([
  'part', 'parts', 'pt', 'section', 'sect', 'sec', 'series', 'ser', 'serie',
  'supplement', 'suppl', 'teil', 'reihe', 'abteilung', 'beiheft', 'partie',
  'seccion', 'sezione', 'seccao', 'secao', 'parte'
]);   // folded: compared with fold(word)

/** French and Italian elided articles and prepositions: l'éducation, dell'arte. */
const ELISION = /^(?:l|d|dell|nell|all|dall|sull|un)['’](?=\p{L})/iu;

/**
 * Common abbreviations that end in a full stop of their own, which 4.6 keeps
 * ("Mr. Rodger's journal" is "Mr. Rodger's j.").
 */
const COMMON_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'st', 'prof', 'jr', 'sr', 'vs', 'vol', 'no', 'ed', 'eds'
]);

/** Characters joining the parts of a compound word (3.7). */
const SEPARATOR = /[-‐–—/]/;

/** A valid roman numeral (I to MMMCMXCIX). */
const ROMAN = /^(?=[IVXLCDM])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

/**
 * Inflected forms tried against exact entries (3.4): strip the first ending,
 * add the second, and look the result up. "Equilibria" finds "equilibrium",
 * "Studies" finds "study", "Jahrbücher" (diacritics folded) finds "Jahrbuch".
 * A form is only used when the singular's abbreviation can still be spelled
 * from the inflected word's own letters (3.4.1, 3.12), so "countries" never
 * borrows "ctry." from "country".
 */
const INFLECTIONS = [
  ['s', ''], ['es', ''], ['ies', 'y'], ["'s", ''], ['’s', ''],
  ['e', ''], ['en', ''], ['n', ''], ['er', ''], ['ern', ''],
  ['x', ''], ['aux', 'al'],
  ['a', 'um'], ['a', 'on'], ['i', 'us'], ['ae', 'a'], ['es', 'is'], ['ices', 'ex'], ['ices', 'ix'],
  ['a', ''], ['a', 'us'], ['um', 'us'], ['ae', 'us'],
  ['i', 'o'], ['i', 'e'], ['e', 'a']
];

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
 * Latin locutions kept intact rather than treated as separate words (4.3).
 *
 * "in vivo" and friends read as single terms; dropping the preposition would
 * mangle them.
 */
const LOCUTIONS = [
  'in vivo', 'in vitro', 'in situ', 'in silico', 'ex vivo', 'in utero',
  'in press', 'de novo', 'post mortem', 'ad hoc'
];

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Fold one character for matching: base letter, lower case.
 *
 * Always one UTF-16 unit in, one out, so a folded string lines up index for
 * index with the original and abbreviations can be copied from the title's
 * own characters (3.2, 3.12).
 */
function foldChar(c) {
  const base = c.normalize('NFD').charAt(0).toLowerCase();
  if (base.length !== 1) return c;
  return UNDECOMPOSED[base] || base;
}

/** Letters with a stroke or bar that Unicode does not decompose. */
const UNDECOMPOSED = { 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ħ': 'h', 'ı': 'i', 'ŀ': 'l', 'ŧ': 't' };

/**
 * Fold a string for matching: diacritics removed, lower case, same length.
 *
 * @param {string} s
 * @returns {string}
 */
export function fold(s) {
  let out = '';
  for (const c of String(s || '').normalize('NFC')) out += c.length === 1 ? foldChar(c) : c;
  return out;
}

/** Letters only, folded: "U. S. A." -> "usa". */
function letters(s) {
  return fold(s).replace(/[^\p{L}]/gu, '');
}

/** Strip a UTF-8 byte-order mark, which survives some spreadsheet exports. */
function stripBOM(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/* ------------------------------------------------------------------ */
/* LTWA parsing                                                        */
/* ------------------------------------------------------------------ */

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
 * Split a pattern cell into the word forms it stands for.
 *
 * "Band (book)" is the word "Band" with a sense note, and "Wachst(h)um" is
 * both "Wachstum" and "Wachsthum".
 *
 * @returns {{forms:string[], sense:string|null}}
 */
function expandPattern(word) {
  const sense = word.match(/\s+\(([^)]*)\)\s*$/);
  if (sense) return { forms: [word.slice(0, sense.index).trim()], sense: sense[1].trim() };
  const optional = word.match(/^(.*\p{L})\((\p{L}{1,3})\)(.*)$/u);
  if (optional) {
    const [, a, b, c] = optional;
    return { forms: [a + c, a + b + c], sense: null };
  }
  return { forms: [word], sense: null };
}

/** Spell out the ligatures œ and æ, which titles often write as two letters. */
function unligature(s) {
  return s.replace(/œ/g, 'oe').replace(/Œ/g, 'Oe').replace(/æ/g, 'ae').replace(/Æ/g, 'Ae');
}

/**
 * Normalise an abbreviation cell.
 *
 * The leading hyphen of a component's abbreviation ("-forsch.") is dropped,
 * because the engine re-attaches the word's own head itself. A few rows end
 * the abbreviation with the pattern's hyphen ("confinam-") or omit the full
 * stop ("lekt"); both are repaired, since 3.1 marks every abbreviation with
 * one. A one-word "abbreviation" that is the word itself is a not-abbreviated
 * entry in disguise.
 *
 * @returns {string|null} The abbreviation, or null for "not abbreviated".
 */
function cleanAbbreviation(raw, kind, stem) {
  let a = String(raw || '').trim();
  if (!a || a.toLowerCase() === NO_ABBREVIATION || /^[-–—]$/.test(a)) return null;
  a = a.replace(/^-+/, '').replace(/\s+(?=\.)/g, '').replace(/\.{2,}/g, '.');   // "tom. ." is "tom."
  if (/\p{L}-$/u.test(a)) a = a.slice(0, -1) + '.';
  if (!a) return null;
  if (kind === 'exact' && !/\s/.test(stem) && letters(a) === letters(stem)) return null;
  if (!a.includes('.') && !/[\s-]/.test(a) && letters(a).length < letters(stem).length) a += '.';
  return a;
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
 *   Each entry: `pattern` (the cell as written), `kind`, `stem` (lower case),
 *   `abbrev` (null when not abbreviated), `noAbbreviation`, `languages`, and
 *   for multi-word rows `words` (the folded words of the phrase).
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

    const [word, abbrevRaw, langsRaw] = cols;
    if (!word) { stats.skipped++; continue; }

    // Skip the header wherever it appears.
    if (/^word$/i.test(word) || /^abbreviation$/i.test(abbrevRaw || '')) continue;

    const languages = (langsRaw || '')
      .split(/[,;/]/).map(normLanguage).filter(Boolean);

    const { forms, sense } = expandPattern(word.normalize('NFC'));
    // "œcolog-" also matches "Oecologica", "dyrlæge" also "dyrlaege".
    const variants = [];
    for (const form of forms) {
      variants.push([form, abbrevRaw]);
      if (/[œŒæÆ]/.test(form)) variants.push([unligature(form), unligature(abbrevRaw || '')]);
    }
    let added = false;
    for (const [form, abbrevText] of variants) {
      const { kind, stem } = classifyPattern(form);
      if (!stem || !/\p{L}/u.test(stem)) continue;
      const abbrev = cleanAbbreviation(abbrevText, kind, stem);
      const entry = {
        pattern: form,
        kind,
        stem: stem.toLowerCase(),
        abbrev,
        noAbbreviation: abbrev === null,
        languages
      };
      if (sense) entry.sense = sense;
      if (/\s/.test(stem)) entry.words = fold(stem).split(/\s+/);
      entries.push(entry);
      added = true;
    }
    if (added) stats.parsed++;
    else stats.skipped++;
  }

  return { entries, stats };
}

/* ------------------------------------------------------------------ */
/* Trie                                                                */
/* ------------------------------------------------------------------ */

function newNode() {
  return { next: new Map(), entries: null };
}

function trieInsert(root, key, entry) {
  let node = root;
  for (const ch of key) {
    let child = node.next.get(ch);
    if (!child) { child = newNode(); node.next.set(ch, child); }
    node = child;
  }
  (node.entries ||= []).push(entry);
}

/**
 * Every stored key that is a prefix of `word`, longest first.
 *
 * @returns {Array<{entries:object[], length:number}>}
 */
function triePrefixes(root, word) {
  const hits = [];
  let node = root;
  for (let i = 0; i < word.length; i++) {
    node = node.next.get(word[i]);
    if (!node) break;
    if (node.entries) hits.push({ entries: node.entries, length: i + 1 });
  }
  return hits.reverse();
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
 * Entries are indexed by match kind on their folded form, so a lookup is a
 * handful of trie walks rather than a scan of tens of thousands of rows.
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
    if (!e.languages || !e.languages.length) return true;   // untagged rules are general
    return e.languages.some(l => l === 'multilingual' || langFilter.has(l));
  };

  const exact = new Map();
  const prefixTrie = newNode();
  const suffixTrie = newNode();
  const infixes = [];
  const phrases = new Map();
  const abbreviations = new Set();
  let count = 0;

  for (const e of list) {
    if (!e || !e.stem || !applies(e)) continue;
    count++;
    const key = fold(e.stem);
    if (e.abbrev && !/\s/.test(e.abbrev)) abbreviations.add(fold(e.abbrev));

    if (e.words && e.words.length > 1) {
      const first = e.words[0];
      if (!phrases.has(first)) phrases.set(first, []);
      phrases.get(first).push(e);
    } else if (e.kind === 'exact') {
      if (!exact.has(key)) exact.set(key, []);
      exact.get(key).push(e);
    } else if (e.kind === 'prefix') {
      trieInsert(prefixTrie, key, e);
    } else if (e.kind === 'suffix') {
      trieInsert(suffixTrie, reverse(key), e);
    } else {
      infixes.push({ entry: e, key });
    }
  }

  // Most specific first: longer phrases, longer inner components.
  for (const group of phrases.values()) {
    group.sort((a, b) => b.words.length - a.words.length || b.stem.length - a.stem.length);
  }
  infixes.sort((a, b) => b.key.length - a.key.length);

  return {
    exact,
    prefixTrie,
    suffixTrie,
    infixes,
    phrases,
    abbreviations,
    entryCount: count,
    languages: langFilter ? [...langFilter] : null
  };
}

/**
 * Copy the capitalisation of `source` onto `target`.
 *
 * ISO 4 leaves capitalisation to national practice (4.5), so the sanest
 * behaviour is to leave the author's styling alone: a capitalised word stays
 * capitalised, an all-caps word stays all-caps.
 *
 * @param {string} target
 * @param {string} source
 * @returns {string}
 */
export function matchCase(target, source) {
  if (!target) return target;
  const lettersOnly = source.replace(/[^\p{L}]/gu, '');
  if (lettersOnly && lettersOnly === lettersOnly.toUpperCase() && lettersOnly.length > 1) {
    return target.toUpperCase();
  }
  if (source[0] && source[0] === source[0].toUpperCase()) {
    return target[0].toUpperCase() + target.slice(1);
  }
  return target[0].toLowerCase() + target.slice(1);
}

/**
 * Spell an abbreviation with the word's own characters (3.2, 3.12, 4.5).
 *
 * Each letter of the LTWA abbreviation is found, in order, in the word, and
 * the word's character is used, so diacritics and capitalisation come from
 * the title. Full stops, spaces and hyphens are copied as given.
 *
 * @param {string} word - The part of the title word being abbreviated.
 * @param {string} abbrev - The LTWA abbreviation.
 * @returns {string|null} Null when a letter of the abbreviation is not in the
 *   word, which 3.12 forbids (and which also catches typos in the list).
 */
function spellFrom(word, abbrev) {
  const chars = [...word];
  let out = '';
  let i = 0;
  for (const a of abbrev) {
    if (!/\p{L}/u.test(a)) {
      if (/[-'’]/.test(a) && chars[i] === a) i++;
      out += a;
      continue;
    }
    const fa = foldChar(a);
    while (i < chars.length && foldChar(chars[i]) !== fa) i++;
    if (i >= chars.length) return null;
    out += chars[i];
    i++;
  }
  return out;
}

/** Pick one entry among several sharing a folded key. */
function pickEntry(list, original, isPrefix) {
  if (list.length === 1) return list[0];
  const lower = original.toLowerCase();
  const sameSpelling = list.filter(e => (isPrefix ? lower.startsWith(e.stem) : lower === e.stem));
  let pool = sameSpelling.length ? sameSpelling : list;
  // "Canton" (the place, not abbreviated) against "canton" (cant.).
  const sameCase = pool.filter(e => (isPrefix ? original.startsWith(e.pattern.replace(/-$/, '')) : original === e.pattern));
  if (sameCase.length) pool = sameCase;
  // Still ambiguous ("real (royal)" against "real (actual)"): leaving the
  // word in full is the safe reading.
  return pool.find(e => e.noAbbreviation) || pool[0];
}

/**
 * Every way the LTWA can read `word` from its first letter.
 *
 * @returns {Array<{entry:object, reason:string, cover:number, rank:number, spelled:boolean}>}
 *   `cover` is how many letters of the word the row accounts for; `spelled`
 *   says whether it matches with the word's own diacritics.
 */
function startCandidates(word, key, engine) {
  const out = [];
  const lower = word.toLowerCase();
  const ex = engine.exact.get(key);
  if (ex) {
    const entry = pickEntry(ex, word, false);
    out.push({ entry, reason: 'exact', cover: key.length, rank: 3, spelled: lower === entry.stem });
  }

  for (const [strip, add] of INFLECTIONS) {
    if (key.length - strip.length < 3 || !key.endsWith(strip)) continue;
    const base = key.slice(0, key.length - strip.length) + add;
    if (base.length < 4 || base === key) continue;
    const hit = engine.exact.get(base);
    if (!hit) continue;
    const stemPart = word.slice(0, key.length - strip.length);
    const entry = pickEntry(hit, stemPart + add, false);
    out.push({
      entry,
      reason: 'inflected',
      cover: key.length - strip.length,
      rank: 2,
      spelled: (stemPart + add).toLowerCase() === entry.stem
    });
  }

  for (const hit of triePrefixes(engine.prefixTrie, key)) {
    const entry = pickEntry(hit.entries, word, true);
    out.push({ entry, reason: 'prefix', cover: hit.length, rank: 1, spelled: lower.startsWith(entry.stem) });
  }
  return out;
}

/**
 * Order candidates: a row spelled like the word first, then the one covering
 * most of the word, then exact over inflected over stem.
 */
function byStrength(a, b) {
  // A row spelled exactly as the word (diacritics included) beats one that
  // only matches once accents are ignored: Latin "Botanica" is "botan-"
  // (bot.), not Spanish "botánica" (botán.).
  return (b.spelled ? 1 : 0) - (a.spelled ? 1 : 0) || b.cover - a.cover || b.rank - a.rank;
}

/**
 * Apply one candidate to a word, or explain why it does not apply.
 *
 * @returns {{value:string, reason:string}|null} Null when the candidate's
 *   abbreviation cannot be spelled from the word (3.12).
 */
function applyCandidate(word, cand) {
  const { entry } = cand;
  if (entry.noAbbreviation) return { value: word, reason: 'no-abbreviation' };
  const head = cand.head || '';
  const tail = word.slice(head.length);
  const spelled = spellFrom(tail, entry.abbrev);
  if (spelled === null) return null;
  const value = head + spelled;
  // 3.1: dropping a single letter is not abbreviating.
  if (letters(word).length - letters(value).length < 2) return { value: word, reason: 'too-short' };
  return { value, reason: cand.reason };
}

/**
 * Components with a leading hyphen ("-forschung", "-graph-") inside a
 * compound word, keeping the head in full (3.7).
 */
function componentCandidates(word, key, engine) {
  const out = [];
  // A final component, allowing the same inflected endings as a whole word.
  const endings = [''].concat(INFLECTIONS.filter(([, add]) => add === '').map(([s]) => s));
  for (const ending of endings) {
    if (ending && !key.endsWith(ending)) continue;
    const body = key.slice(0, key.length - ending.length);
    for (const hit of triePrefixes(engine.suffixTrie, reverse(body))) {
      const headLength = body.length - hit.length;
      if (headLength < MIN_COMPOUND_HEAD) continue;
      const entry = pickEntry(hit.entries, word.slice(headLength), true);
      out.push({
        entry,
        head: word.slice(0, headLength),
        reason: 'suffix',
        cover: hit.length,
        rank: 1,
        spelled: word.slice(headLength).toLowerCase().startsWith(entry.stem)
      });
    }
  }
  // An inner component: the rest of the word after it is truncated.
  for (const { entry, key: stem } of engine.infixes) {
    const at = key.indexOf(stem, MIN_COMPOUND_HEAD);
    if (at < 0) continue;
    out.push({
      entry,
      head: word.slice(0, at),
      reason: 'infix',
      cover: stem.length,
      rank: 0,
      spelled: word.slice(at).toLowerCase().startsWith(entry.stem)
    });
  }
  return out;
}

/**
 * A closed compound the list has no row for, read as a combining form kept in
 * full plus a word the list knows: "Electro|chimica" = "Electro" + "chim.".
 * 3.7 asks for the final component to be abbreviated and lets the leading
 * ones stay in full. Only heads that end like a classical combining form
 * (-o, -i) are tried, so a surname such as "Beilstein" is never split.
 */
function compoundCandidates(word, key, engine) {
  const out = [];
  for (let at = MIN_COMBINING_HEAD; at <= key.length - 4; at++) {
    if (!/[oi]/.test(key[at - 1])) continue;
    const tailKey = key.slice(at);
    const tail = word.slice(at);
    for (const c of startCandidates(tail, tailKey, engine)) {
      // A guess, so only a row spelled exactly like the tail will do.
      if (c.entry.noAbbreviation || c.cover < 4 || !c.spelled) continue;
      out.push({ ...c, head: word.slice(0, at), reason: 'compound', rank: c.rank - 4 });
    }
  }
  return out;
}

/**
 * Abbreviate a single title word.
 *
 * @param {string} word - One word, without surrounding punctuation.
 * @param {object} engine - From {@link buildIso4Engine}.
 * @returns {{value:string, matched:boolean, rule:object|null, reason:string}}
 *   `reason` is one of `exact`, `inflected`, `prefix`, `suffix`, `infix`,
 *   `compound`, `no-abbreviation`, `too-short` (recognised, but abbreviating
 *   would drop fewer than two letters) or `unmatched`.
 */
export function abbreviateWord(word, engine) {
  const out = { value: word, matched: false, rule: null, reason: 'unmatched' };
  if (!word || !engine || !engine.exact) return out;

  const w = String(word).normalize('NFC');
  const key = fold(w);

  // Readings from the start of the word win over components inside it, as in
  // the list itself: a stem is the general rule, a component the special case.
  const tiers = [
    () => startCandidates(w, key, engine),
    () => componentCandidates(w, key, engine),
    () => compoundCandidates(w, key, engine)
  ];

  for (const tier of tiers) {
    for (const cand of tier().sort(byStrength)) {
      const applied = applyCandidate(w, cand);
      if (!applied) continue;                       // not spellable from this word
      // A known word inside an unknown compound recognises nothing by itself.
      if (cand.reason === 'compound' && applied.reason === 'too-short') continue;
      // The strongest reading wins, including "recognised, left in full" (a
      // not-abbreviated row, or one that would drop a single letter).
      const value = applied.reason === 'too-short' || applied.reason === 'no-abbreviation'
        ? w : applied.value;
      return { value, matched: true, rule: cand.entry, reason: applied.reason };
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Titles                                                              */
/* ------------------------------------------------------------------ */

function isFunctionWord(w) {
  return ARTICLES.has(w) || CONJUNCTIONS.has(w) || PREPOSITIONS.has(w);
}

/** A section designator by form alone: a numeral or anything with a digit. */
function hasDigit(core) {
  return /\p{N}/u.test(core);
}

/** One letter or a roman numeral, upper case: a possible designator. */
function isLetterOrRoman(core) {
  return /^\p{Lu}$/u.test(core) || ROMAN.test(core);
}

/** Punctuation-only token that opens a subtitle: "Chemistry - A European Journal". */
function opensSubtitle(prev) {
  if (!prev) return false;
  if (!prev.core) return /[-–—:]/.test(prev.original);
  return /[:.–—-]$/.test(prev.trail);
}

/**
 * Abbreviate one token's word, compound parts included.
 *
 * @returns {{value:string, reason:string, matched:boolean}}
 */
function abbreviateCore(core, engine) {
  const whole = abbreviateWord(core, engine);
  if (!SEPARATOR.test(core)) {
    return { value: whole.value, reason: whole.reason, matched: whole.matched };
  }
  // A hyphenated row ("anti-inflammato-", "audio-visual") reads the compound
  // whole; any other row would swallow the parts after the hyphen.
  if (whole.matched && whole.rule && SEPARATOR.test(whole.rule.stem)) {
    return { value: whole.value, reason: whole.reason, matched: true };
  }
  // 3.7: a hyphenated compound is abbreviated part by part, hyphens kept.
  const pieces = core.split(/([-‐–—/])/);
  let matched = false;
  const value = pieces.map((p, i) => {
    if (i % 2 === 1 || !p) return p;
    if (hasDigit(p) || /\p{Lu}.*\p{Lu}/u.test(p) && p === p.toUpperCase()) return p;
    const r = abbreviateWord(p, engine);
    if (r.matched) matched = true;
    return r.value;
  }).join('');
  return { value, reason: 'compound', matched };
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

  const trimmed = title.normalize('NFC').trim().replace(/\s+/g, ' ');

  // A one-word title is left alone (4.2). A hyphenated compound is several
  // words: the 4.4 example "AEG-Mitteilungen" becomes "AEG-Mitt.".
  if (!trimmed.includes(' ') && !/\p{L}[-‐–—/]\p{L}/u.test(trimmed)) {
    // Only the punctuation 4.6 removes changes: commas, a closing full stop.
    const kept = trimmed.replace(/,/g, '').replace(/(\p{L}{2,})\.$/u, '$1') || trimmed;
    return {
      abbreviation: kept,
      changed: kept !== trimmed,
      words: [{ original: trimmed, value: kept, dropped: false, reason: 'single-word-title' }],
      unmatched: []
    };
  }

  // 4.6: the mark of omission goes.
  let working = trimmed.replace(/\s*(?:\.\.\.|…)\s*/g, ' ').trim();

  // Protect Latin locutions so their prepositions survive the stop-word pass.
  const held = [];
  for (const loc of LOCUTIONS) {
    // No lookbehind: Safari only has it from 16.4.
    const re = new RegExp(`(^|[^\\p{L}])(${loc.replace(/ /g, '\\s+')})(?![\\p{L}])`, 'giu');
    working = working.replace(re, (m, before, body) => {
      held.push(body);
      return `${before}\u0000${held.length - 1}\u0000`;
    });
  }

  // Tokens with their punctuation peeled off, so it can be put back.
  const tokens = working.split(/\s+/).filter(Boolean).map((original) => {
    const hold = original.match(/^([^\p{L}\p{N}\u0000]*)\u0000(\d+)\u0000(.*)$/u);
    if (hold) {
      const text = held[Number(hold[2])];
      return { original: hold[1] + text + hold[3], lead: hold[1], core: text, trail: hold[3], locution: true };
    }
    const m = original.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
    return { original, lead: m[1], core: m[2], trail: m[3], locution: false };
  });

  const letterChars = trimmed.replace(/[^\p{L}]/gu, '');
  const allCaps = letterChars.length >= 4 && letterChars === letterChars.toUpperCase();

  // Phrases the list knows as a whole: "United States of America" (U. S. A.),
  // "Los alamos" (kept, 4.3).
  const units = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const phrase = t.core && !t.locution ? matchPhrase(tokens, i, engine) : null;
    if (phrase) {
      units.push(phrase);
      i += phrase.span - 1;
    } else {
      units.push({ ...t, span: 1 });
    }
  }

  const contentIdx = units.map((u, i) => (u.core ? i : -1)).filter(i => i >= 0);
  const firstContent = contentIdx[0];
  const lastContent = contentIdx[contentIdx.length - 1];

  // Classify every unit before deciding what to drop.
  let depth = 0;
  units.forEach((u, i) => {
    const inParens = depth > 0 || u.lead.includes('(');
    depth += (u.lead.match(/\(/g) || []).length + (u.trail.match(/\(/g) || []).length;
    depth -= (u.lead.match(/\)/g) || []).length + (u.trail.match(/\)/g) || []).length;
    if (depth < 0) depth = 0;
    u.inParens = inParens;
    if (!u.core) { u.kind = 'punctuation'; return; }
    if (u.phrase) { u.kind = 'phrase'; return; }
    if (u.locution) { u.kind = 'locution'; return; }

    const prev = units[i - 1];
    const prevContent = units.slice(0, i).reverse().find(x => x.core);
    const lower = u.core.toLowerCase();

    const afterGeneric = Boolean(prevContent && GENERIC_TERMS.has(fold(prevContent.core)));
    const closes = i === lastContent || /[:;,.)]/.test(u.trail);

    // A number is a designator after a generic term or closing a section
    // ("Part 2", "Series B12:"); elsewhere it is a title word ("2D Materials").
    if (hasDigit(u.core)) {
      u.kind = i !== firstContent && (afterGeneric || closes) ? 'designator' : 'numeric';
      return;
    }

    // Already abbreviated ("J.", "Chem.") or an initialism ("U.S.A.").
    if (u.trail.startsWith('.') && (u.core.length === 1 || /\p{L}\.\p{L}/u.test(u.core)
        || COMMON_ABBREVIATIONS.has(lower) || engine.abbreviations.has(fold(u.core + '.')))) {
      u.kind = 'abbreviated';
      return;
    }

    if (!options.keepStopWords) {
      // A lone elided article ("Impartial, L'") and an article moved behind
      // the title after a comma ("Italia forestale e montana, L'",
      // "Lancet, The") are articles all the same (4.3).
      const loneElision = /^[ld]$/i.test(u.core) && /^['’]/.test(u.trail);
      const inverted = i === lastContent && lower.length > 1 && ARTICLES.has(lower)
        && prevContent && prevContent.trail.includes(',');
      if (loneElision || inverted) { u.kind = 'stop-word'; return; }
    }

    if (isLetterOrRoman(u.core) && i !== firstContent) {
      const subtitleStart = opensSubtitle(prev);
      if (afterGeneric || closes || (!allCaps && !(subtitleStart && isFunctionWord(lower)))) {
        u.kind = 'designator';
        return;
      }
    }

    if (!allCaps && /\p{Lu}.*\p{Lu}/u.test(u.core) && u.core === u.core.toUpperCase()) {
      u.kind = 'acronym';                        // 4.4: ACS, JACS, AIP
      return;
    }
    if (/\p{Ll}\p{Lu}/u.test(u.core)) { u.kind = 'artificial'; return; }   // 3.3

    if (!options.keepStopWords && isFunctionWord(lower)) {
      const leadingPreposition = i === firstContent && PREPOSITIONS.has(lower) && !ARTICLES.has(lower);
      // A word can only be an article or preposition if something follows it.
      if (!leadingPreposition && i !== lastContent) { u.kind = 'stop-word'; return; }
    }
    u.kind = 'word';
  });

  // 4.2: one title word, not counting function words, designators,
  // qualifiers in parentheses or generic part terms, stays in full.
  const titleWords = units.filter(u =>
    (u.kind === 'word' || u.kind === 'phrase' || u.kind === 'acronym' || u.kind === 'artificial'
      || u.kind === 'locution' || u.kind === 'abbreviated' || u.kind === 'numeric')
    && !u.inParens && !(u.kind === 'word' && GENERIC_TERMS.has(fold(u.core))));
  const singleWord = titleWords.length === 1 && !SEPARATOR.test(titleWords[0].core)
    ? titleWords[0] : null;

  const words = [];
  const unmatched = [];
  const emitted = [];

  units.forEach((u) => {
    if (u.kind === 'punctuation') {
      if (!options.keepStopWords && CONJUNCTION_SYMBOLS.has(u.original.trim())) {
        words.push({ original: u.original, value: '', dropped: true, reason: 'conjunction' });
        return;
      }
      // 4.6: a stray comma or full stop standing alone goes.
      if (/^[.,]+$/.test(u.original)) {
        words.push({ original: u.original, value: '', dropped: true, reason: 'punctuation' });
        return;
      }
      words.push({ original: u.original, value: u.original, dropped: false, reason: 'punctuation' });
      emitted.push({ unit: u, value: u.original });
      return;
    }
    if (u.kind === 'stop-word') {
      words.push({ original: u.original, value: '', dropped: true, reason: 'stop-word' });
      return;
    }

    let value = u.core;
    let reason = u.kind;

    if (u.kind === 'phrase') {
      value = u.value;
    } else if (u.kind === 'word' && u !== singleWord) {
      // 4.3: an elided article or preposition goes with its apostrophe.
      const elided = !options.keepStopWords && u.core.match(ELISION);
      const core = elided ? u.core.slice(elided[0].length) : u.core;
      const r = abbreviateCore(core, engine);
      value = r.value;
      reason = r.reason;
      if (!r.matched) unmatched.push(core);
    } else if (u.kind === 'artificial' && u !== singleWord) {
      // 3.3 keeps an artificial word as printed (CrystEngComm, AIChE), but a
      // real word written with inner capitals (OptoElectronics,
      // ImmunoTherapy) is abbreviated when one row spans all its capitals.
      const r = abbreviateWord(u.core, engine);
      let lastCap = 0;
      for (const m of u.core.matchAll(/\p{Ll}\p{Lu}/gu)) lastCap = m.index + 1;
      if (r.rule && r.value !== u.core && ['exact', 'inflected', 'prefix'].includes(r.reason)
          && fold(r.rule.stem).length > lastCap) {
        value = r.value;
        reason = r.reason;
      }
    } else if (u === singleWord) {
      reason = 'single-word-title';
    }

    const lead = u.lead.replace(/,/g, '');
    // 4.6 drops commas, but 4.8 keeps the one between a section designation
    // and its section title: "Part A-1, Polymer chemistry".
    let trail = u.kind === 'designator' ? u.trail : u.trail.replace(/,/g, '');
    // A possessive apostrophe goes with the letters it followed:
    // "Ornithologists' Club" is "Ornithol. Club".
    if (value.endsWith('.') && value !== u.core && /^['’]/.test(trail)) trail = trail.slice(1);
    words.push({ original: u.original, value: lead + value + trail, dropped: false, reason });
    emitted.push({ unit: u, value, lead, trail });
  });

  // 4.6: a full stop between title parts becomes a comma; one closing the
  // title goes. Initials and words already abbreviated keep theirs.
  const pieces = emitted.map((e, n) => {
    if (e.unit.kind === 'punctuation') return e.value;
    let { lead, trail } = e;
    const last = !emitted.slice(n + 1).some(x => x.unit.core);
    // 4.6 keeps the full stop of an ordinal number ("2. Folge").
    if (trail.startsWith('.') && e.unit.kind !== 'abbreviated' && !/^\p{N}+$/u.test(e.unit.core)) {
      const rest = trail.slice(1);
      trail = (last ? '' : ',') + rest;
    }
    // Never print an abbreviation's full stop twice.
    if (e.value.endsWith('.') && trail.startsWith('.')) trail = trail.slice(1);
    return lead + e.value + trail;
  });

  const abbreviation = pieces
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { abbreviation, changed: abbreviation !== trimmed, words, unmatched };
}

/**
 * Match a multi-word LTWA entry starting at token `i`.
 *
 * Only the phrase's last word may be a stem, and only its first and last
 * tokens may carry punctuation, so "United States, of America" is not read as
 * one name.
 *
 * @returns {object|null} A unit covering the phrase's tokens.
 */
function matchPhrase(tokens, i, engine) {
  if (!engine.phrases || !engine.phrases.size) return null;
  const group = engine.phrases.get(fold(tokens[i].core));
  if (!group) return null;
  for (const e of group) {
    const n = e.words.length;
    if (i + n > tokens.length) continue;
    const prefixLast = e.kind === 'prefix';
    let ok = true;
    for (let k = 0; k < n && ok; k++) {
      const t = tokens[i + k];
      if (!t.core || t.locution) { ok = false; break; }
      if (k > 0 && t.lead) ok = false;
      if (k < n - 1 && t.trail) ok = false;
      const key = fold(t.core);
      const want = e.words[k];
      if (k === n - 1 && prefixLast) { if (!key.startsWith(want)) ok = false; }
      else if (key !== want) ok = false;
    }
    if (!ok) continue;
    const slice = tokens.slice(i, i + n);
    const text = slice.map(t => t.core).join(' ');
    let value = text;
    if (!e.noAbbreviation) {
      // The letters must be the phrase's own (3.12), but the list's spacing
      // and capitals are kept: "U. S. A.", "N. Y.".
      if (spellFrom(text, e.abbrev) === null) continue;
      const caps = text.replace(/[^\p{L}]/gu, '');
      value = caps === caps.toUpperCase() ? e.abbrev.toUpperCase()
        : /^\p{Lu}/u.test(text) ? e.abbrev.charAt(0).toUpperCase() + e.abbrev.slice(1)
          : e.abbrev;
    }
    return {
      original: slice.map(t => t.original).join(' '),
      lead: slice[0].lead,
      core: text,
      trail: slice[n - 1].trail,
      value,
      span: n,
      phrase: e,
      locution: false
    };
  }
  return null;
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
 * Titles ISO 4 leaves untouched, a single word, or one where nothing matched,
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
