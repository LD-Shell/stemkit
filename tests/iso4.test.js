import { describe, test, expect } from '@jest/globals';
import {
  parseLTWA, sniffDelimiter, classifyPattern, buildIso4Engine,
  abbreviateWord, abbreviateTitle, matchCase, loadIso4, normLanguage
} from '../src/core/iso4.js';

/*
 * A small stand-in for the ISSN LTWA export. Real downloads carry tens of
 * thousands of rows, but the shapes that matter | exact words, stems, suffix
 * and infix patterns, "n.a." entries and language tags, are all represented
 * here, so the rules can be checked without shipping a large fixture.
 */
const SAMPLE = [
  'WORD\tABBREVIATION\tLANGUAGES',
  'journal\tJ.\teng',
  'americ-\tAm.\teng',
  'chemi-\tChem.\teng, fre',
  'societ-\tSoc.\teng',
  'physi-\tPhys.\teng',
  'review\tRev.\teng',
  'letter-\tLett.\teng',
  'biolog-\tBiol.\teng',
  'environment-\tEnviron.\teng',
  'scien-\tSci.\teng',
  'condens-\tCondens.\teng',
  'applied\tAppl.\teng',
  'material-\tMater.\teng',
  'communicat-\tCommun.\teng',
  'energy\tn.a.\teng',
  'nature\tn.a.\teng',
  'zeitschrift\tZ.\tger',
  '-ologie\t-ol.\tger',
  '-graph-\t-gr.\tmul'
].join('\n');

const engineOf = (text = SAMPLE, opts) => loadIso4(text, opts).engine;

describe('LTWA parsing', () => {
  test('reads a tab-separated export and skips the header', () => {
    const { entries, stats } = parseLTWA(SAMPLE);
    expect(stats.delimiter).toBe('\t');
    expect(entries.length).toBe(19);
    expect(entries.find(e => e.stem === 'journal').abbrev).toBe('J.');
  });

  test('classifies the four pattern shapes', () => {
    expect(classifyPattern('journal')).toEqual({ kind: 'exact', stem: 'journal' });
    expect(classifyPattern('chemi-')).toEqual({ kind: 'prefix', stem: 'chemi' });
    expect(classifyPattern('-ologie')).toEqual({ kind: 'suffix', stem: 'ologie' });
    expect(classifyPattern('-graph-')).toEqual({ kind: 'infix', stem: 'graph' });
  });

  test('treats "n.a." as recognised-but-not-abbreviated', () => {
    const { entries } = parseLTWA(SAMPLE);
    const energy = entries.find(e => e.stem === 'energy');
    expect(energy.noAbbreviation).toBe(true);
    expect(energy.abbrev).toBeNull();
  });

  test('records the languages a rule applies to', () => {
    const { entries } = parseLTWA(SAMPLE);
    // Tags are normalised on the way in, so an ISO code and the spelled-out
    // name the ISSN export actually uses end up as the same key.
    expect(entries.find(e => e.stem === 'chemi').languages).toEqual(['english', 'french']);
    expect(entries.find(e => e.stem === 'graph').languages).toEqual(['multilingual']);
  });

  test('accepts comma-separated and semicolon-separated files too', () => {
    const csv = 'WORD,ABBREVIATION,LANGUAGES\njournal,J.,eng\nchemi-,Chem.,eng';
    const { entries, stats } = parseLTWA(csv);
    expect(stats.delimiter).toBe(',');
    expect(entries.length).toBe(2);

    const scsv = 'WORD;ABBREVIATION;LANGUAGES\njournal;J.;eng\nchemi-;Chem.;eng';
    expect(parseLTWA(scsv).entries.length).toBe(2);
  });

  test('handles quoted fields containing the delimiter', () => {
    const csv = 'WORD,ABBREVIATION,LANGUAGES\n"journal","J.","eng,fre"';
    const { entries } = parseLTWA(csv);
    expect(entries[0].abbrev).toBe('J.');
    expect(entries[0].languages).toEqual(['english', 'french']);
  });

  test('strips a byte-order mark left by spreadsheet exports', () => {
    const { entries } = parseLTWA('\ufeffWORD\tABBREVIATION\tLANGUAGES\njournal\tJ.\teng');
    expect(entries[0].stem).toBe('journal');
  });

  test('counts malformed rows instead of throwing', () => {
    const { entries, stats } = parseLTWA('journal\tJ.\teng\nbroken-row-no-delimiter\n\t\t');
    expect(entries.length).toBe(1);
    expect(stats.skipped).toBeGreaterThan(0);
  });

  test('returns empty results for empty input', () => {
    expect(parseLTWA('').entries).toEqual([]);
    expect(parseLTWA(null).entries).toEqual([]);
  });

  test('sniffDelimiter prefers the consistent separator', () => {
    expect(sniffDelimiter('a\tb\tc\nd\te\tf')).toBe('\t');
    expect(sniffDelimiter('a,b,c\nd,e,f')).toBe(',');
  });
});

describe('word matching', () => {
  const engine = engineOf();

  test('exact entries match the whole word and not an extension of it', () => {
    expect(abbreviateWord('Journal', engine).value).toBe('J.');
    // "journal" is an exact entry, not a stem, so a longer word must not match.
    expect(abbreviateWord('Journalism', engine).matched).toBe(false);
  });

  test('stems match any extension of the stem', () => {
    expect(abbreviateWord('Chemical', engine).value).toBe('Chem.');
    expect(abbreviateWord('Chemistry', engine).value).toBe('Chem.');
    expect(abbreviateWord('Chemi', engine).value).toBe('Chem.');
  });

  test('suffix patterns match word endings', () => {
    // "Radiologie" has no matching stem, so only "-ologie" can fire.
    const r = abbreviateWord('Radiologie', engine);
    expect(r.reason).toBe('suffix');
    expect(r.value).toBe('-ol.');
  });

  test('infix patterns match inside a word', () => {
    const r = abbreviateWord('Bibliographical', engine);
    expect(r.matched).toBe(true);
  });

  test('the longest matching pattern wins', () => {
    // "condens-" (8) must beat nothing shorter, and stay distinct from "chemi-".
    expect(abbreviateWord('Condensed', engine).value).toBe('Condens.');
  });

  test('an "n.a." word is recognised but left in full', () => {
    const r = abbreviateWord('Energy', engine);
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('no-abbreviation');
    expect(r.value).toBe('Energy');
  });

  test('an unknown word is reported as unmatched and left alone', () => {
    const r = abbreviateWord('Imaginary', engine);
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('unmatched');
    expect(r.value).toBe('Imaginary');
  });

  test('language filtering excludes rules from other languages', () => {
    const eng = engineOf(SAMPLE, { languages: ['eng'] });
    expect(abbreviateWord('Zeitschrift', eng).matched).toBe(false);

    const ger = engineOf(SAMPLE, { languages: ['ger'] });
    expect(abbreviateWord('Zeitschrift', ger).value).toBe('Z.');
  });

  test('multilingual rules survive any language filter', () => {
    const eng = engineOf(SAMPLE, { languages: ['eng'] });
    expect(abbreviateWord('Bibliographical', eng).matched).toBe(true);
  });
});

describe('capitalisation', () => {
  test('carries the original word case onto the abbreviation', () => {
    expect(matchCase('Chem.', 'Chemical')).toBe('Chem.');
    expect(matchCase('Chem.', 'chemical')).toBe('chem.');
    expect(matchCase('Chem.', 'CHEMICAL')).toBe('CHEM.');
  });

  test('a single capital letter is not treated as all-caps', () => {
    expect(matchCase('J.', 'J')).toBe('J.');
  });
});

describe('title abbreviation', () => {
  const engine = engineOf();

  test('abbreviates a familiar title correctly', () => {
    expect(abbreviateTitle('Journal of the American Chemical Society', engine).abbreviation)
      .toBe('J. Am. Chem. Soc.');
    expect(abbreviateTitle('Physical Review Letters', engine).abbreviation)
      .toBe('Phys. Rev. Lett.');
  });

  test('drops a leading article but keeps a leading preposition', () => {
    expect(abbreviateTitle('The Journal of Chemical Physics', engine).abbreviation)
      .toBe('J. Chem. Phys.');
    expect(abbreviateTitle('From Energy to Nature', engine).abbreviation)
      .toBe('From Energy Nature');
  });

  test('drops an ampersand standing in for a conjunction', () => {
    expect(abbreviateTitle('Applied Materials & Interfaces', engine).abbreviation)
      .toBe('Appl. Mater. Interfaces');
  });

  test('leaves a single-word title untouched, per ISO 4', () => {
    const r = abbreviateTitle('Nature', engine);
    expect(r.abbreviation).toBe('Nature');
    expect(r.changed).toBe(false);
    expect(r.words[0].reason).toBe('single-word-title');
  });

  test('preserves punctuation around abbreviated words', () => {
    expect(abbreviateTitle('Journal of Physics: Condensed Matter', engine).abbreviation)
      .toBe('J. Phys.: Condens. Matter');
  });

  test('abbreviates each half of a hyphenated compound', () => {
    const r = abbreviateTitle('Chemical Physico-Chemical Review', engine);
    expect(r.abbreviation).toContain('-');
    expect(r.abbreviation.startsWith('Chem.')).toBe(true);
  });

  test('keeps Latin locutions intact', () => {
    const r = abbreviateTitle('Chemical Reviews in Vitro', engine);
    expect(r.abbreviation.toLowerCase()).toContain('in vitro');
  });

  test('reports which words had no LTWA entry', () => {
    const r = abbreviateTitle('Journal of Imaginary Results', engine);
    expect(r.unmatched).toContain('Imaginary');
    expect(r.unmatched).toContain('Results');
    expect(r.abbreviation).toBe('J. Imaginary Results');
  });

  test('reports per-word provenance so a result can be reviewed', () => {
    const r = abbreviateTitle('The Journal of Chemical Physics', engine);
    const dropped = r.words.filter(w => w.dropped).map(w => w.original);
    expect(dropped).toEqual(['The', 'of']);
    expect(r.words.some(w => w.reason === 'prefix')).toBe(true);
  });

  test('keepStopWords disables the drop rules', () => {
    const r = abbreviateTitle('The Journal of Chemical Physics', engine, { keepStopWords: true });
    expect(r.abbreviation).toBe('The J. of Chem. Phys.');
  });

  test('handles empty and non-string input safely', () => {
    expect(abbreviateTitle('', engine).abbreviation).toBe('');
    expect(abbreviateTitle(null, engine).abbreviation).toBe('');
    expect(abbreviateTitle('Journal of Chemistry', null).abbreviation).toBe('');
  });

  test('lowercase input keeps its case', () => {
    expect(abbreviateTitle('energy & environmental science', engine).abbreviation)
      .toBe('energy environ. sci.');
  });
});

describe('engine construction', () => {
  test('reports how many rules were indexed', () => {
    const { engine, stats } = loadIso4(SAMPLE);
    expect(engine.entryCount).toBe(19);
    expect(stats.indexed).toBe(19);
    expect(stats.parsed).toBe(19);
  });

  test('an empty engine abbreviates nothing but does not throw', () => {
    const engine = buildIso4Engine([]);
    const r = abbreviateTitle('Journal of Chemistry', engine);
    expect(r.abbreviation).toBe('Journal Chemistry');
    expect(r.unmatched.length).toBe(2);
  });

  test('scales to a large list', () => {
    const rows = ['WORD\tABBREVIATION\tLANGUAGES'];
    for (let i = 0; i < 20000; i++) rows.push(`word${i}-\tW${i}.\teng`);
    const t0 = Date.now();
    const { engine } = loadIso4(rows.join('\n'));
    const build = Date.now() - t0;
    expect(engine.entryCount).toBe(20000);
    expect(build).toBeLessThan(5000);
    // The longest matching stem must win even across 20k candidates.
    expect(abbreviateWord('Word19999x', engine).value).toBe('W19999.');
  });
});

/*
 * Regression cover for the shape of the actual ISSN export, which differs from
 * the documentation in ways worth pinning down:
 *
 *   - it is comma-separated, not tab-separated;
 *   - "no abbreviation" is an empty column, not the literal "n.a.";
 *   - languages are spelled out in English, not given as ISO codes;
 *   - multilingual rules say "Multiple languages", not "mul";
 *   - multi-language cells are quoted because they contain commas, and some
 *     carry a parenthetical qualifier such as "Greek, Modern (1453- )".
 */
const REAL_SHAPE = [
  'WORD,ABBREVIATION,LANGUAGES',
  'Aabenraa,,Danish',
  'Aachener,Aachen.,German',
  'abdominal,abdom.,"English, French"',
  'abdērit-,abdēr.,"Greek, Modern (1453- )"',
  'biolog-,biol.,Multiple languages',
  'journal,J.,"English, French"',
  'chemi-,chem.,"French, English"'
].join('\n');

describe('real ISSN export format', () => {
  test('an empty abbreviation column means the word is not abbreviated', () => {
    const { entries } = parseLTWA(REAL_SHAPE);
    const aabenraa = entries.find(e => e.stem === 'aabenraa');
    expect(aabenraa.noAbbreviation).toBe(true);
    expect(aabenraa.abbrev).toBeNull();

    const engine = buildIso4Engine(entries);
    const r = abbreviateWord('Aabenraa', engine);
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('no-abbreviation');
    expect(r.value).toBe('Aabenraa');
  });

  test('quoted multi-language cells split on the inner commas', () => {
    const { entries } = parseLTWA(REAL_SHAPE);
    expect(entries.find(e => e.stem === 'abdominal').languages).toEqual(['english', 'french']);
  });

  test('a parenthetical language qualifier still matches the base language', () => {
    const { entries } = parseLTWA(REAL_SHAPE);
    expect(entries.find(e => e.stem === 'abdērit').languages).toContain('greek');
  });

  test('language filtering accepts spelled-out names and ISO codes alike', () => {
    for (const sel of [['English'], ['english'], ['eng'], ['en']]) {
      const engine = buildIso4Engine(parseLTWA(REAL_SHAPE).entries, { languages: sel });
      expect(abbreviateWord('Journal', engine).value).toBe('J.');
    }
  });

  test('"Multiple languages" survives any language filter', () => {
    const engine = buildIso4Engine(parseLTWA(REAL_SHAPE).entries, { languages: ['english'] });
    // Tagged "Multiple languages" only, it must not be filtered away.
    expect(abbreviateWord('Biology', engine).value).toBe('Biol.');
  });

  test('a language filter excludes rules from other languages', () => {
    const engine = buildIso4Engine(parseLTWA(REAL_SHAPE).entries, { languages: ['english'] });
    expect(abbreviateWord('Aachener', engine).matched).toBe(false);
  });

  test('normLanguage maps codes, names and qualifiers onto one key', () => {
    expect(normLanguage('eng')).toBe('english');
    expect(normLanguage('English')).toBe('english');
    expect(normLanguage('Multiple languages')).toBe('multilingual');
    expect(normLanguage('Modern (1453- )')).toBe('modern');
  });

  test('abbreviates a real title from real-shaped rows', () => {
    const engine = buildIso4Engine(parseLTWA(REAL_SHAPE).entries);
    expect(abbreviateTitle('Journal of Chemical Biology', engine).abbreviation)
      .toBe('J. Chem. Biol.');
  });
});
