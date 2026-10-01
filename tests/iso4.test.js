import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  parseLTWA, sniffDelimiter, classifyPattern, buildIso4Engine,
  abbreviateWord, abbreviateTitle, matchCase, loadIso4, normLanguage, fold
} from '../src/core/iso4.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');

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
  });

  test('a word that would lose only one letter stays in full (ISO 4, 3.1)', () => {
    const r = abbreviateWord('Chemi', engine);
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('too-short');
    expect(r.value).toBe('Chemi');
  });

  test('a final component keeps the head of the word, without a hyphen', () => {
    // "Radiologie" has no matching stem, so only "-ologie" can fire, and the
    // abbreviation's leading hyphen stands for "Radi", not for itself.
    const r = abbreviateWord('Radiologie', engine);
    expect(r.reason).toBe('suffix');
    expect(r.value).toBe('Radiol.');
  });

  test('an inner component keeps the head and truncates the rest', () => {
    const r = abbreviateWord('Bibliographical', engine);
    expect(r.reason).toBe('infix');
    expect(r.value).toBe('Bibliogr.');
  });

  test('a component pattern never applies to the bare component', () => {
    expect(abbreviateWord('Ologie', engine).matched).toBe(false);
    expect(abbreviateWord('Graphic', engine).matched).toBe(false);
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

describe('LTWA row shapes beyond word and stem', () => {
  const ROWS = [
    'WORD,ABBREVIATION,LANGUAGES',
    'Band (book),Bd.,German',
    'labor (work),,English',
    'Labor (laboratory),Lab.,German',
    'Wachst(h)um,Wachst.,German',
    'United States of America,U. S. A.,English',
    'Los alamos,,English',
    'tomejas,tom. .,Latvian',
    'confinamento,confinam-,Italian',
    'lektira,lekt,Serbian',
    'katoen,katoen,Dutch',
    'œcolog-,œcol.,English',
    '-forschung,-forsch.,German',
    '-mægling,mægl.,Danish'
  ].join('\n');
  const { entries } = parseLTWA(ROWS);
  const find = (p) => entries.find(e => e.pattern === p);

  test('a sense note in parentheses is not part of the word', () => {
    expect(find('Band').abbrev).toBe('Bd.');
    expect(find('Band').sense).toBe('book');
  });

  test('an optional letter yields both spellings', () => {
    expect(find('Wachstum').abbrev).toBe('Wachst.');
    expect(find('Wachsthum').abbrev).toBe('Wachst.');
  });

  test('multi-word rows are kept as phrases', () => {
    expect(find('United States of America').words).toEqual(['united', 'states', 'of', 'america']);
    expect(find('Los alamos').noAbbreviation).toBe(true);
  });

  test('typos in the abbreviation column are repaired', () => {
    expect(find('tomejas').abbrev).toBe('tom.');
    expect(find('confinamento').abbrev).toBe('confinam.');
    expect(find('lektira').abbrev).toBe('lekt.');
    // An "abbreviation" equal to the word means it is not abbreviated.
    expect(find('katoen').noAbbreviation).toBe(true);
  });

  test('a component row drops the hyphen from its abbreviation', () => {
    expect(find('-forschung').abbrev).toBe('forsch.');
    expect(find('-mægling').abbrev).toBe('mægl.');
  });

  test('a ligature row also matches the spelled-out form', () => {
    expect(find('oecolog-').abbrev).toBe('oecol.');
  });

  test('ambiguous senses fall back to leaving the word in full', () => {
    const engine = buildIso4Engine(entries);
    expect(abbreviateWord('labor', engine).value).toBe('labor');
  });

  test('fold removes diacritics but keeps the length', () => {
    expect(fold('Überwachung')).toBe('uberwachung');
    expect(fold('Przemysł').length).toBe('Przemysł'.length);
  });
});

/*
 * Everything below runs on the ISSN list shipped in abbr/, the file the
 * Journal Abbreviator loads, so the rules are checked against real data.
 */
const LTWA = fs.readFileSync(path.join(repo, 'abbr', 'abbreviation.csv'), 'utf8');
const REAL = loadIso4(LTWA).engine;
const iso4 = (title) => abbreviateTitle(title, REAL).abbreviation;

describe('ISO 4 on the real LTWA: reported regressions', () => {
  test('a section letter is kept', () => {
    expect(iso4('Journal of Physics A')).toBe('J. Phys. A');
  });

  test('a component row does not turn a whole word into "-ph."', () => {
    expect(iso4('Phase Transitions')).toBe('Phase Transit.');
    expect(iso4('Fluid Phase Equilibria')).toBe('Fluid Phase Equilib.');
  });

  test('a final component keeps the head of its compound', () => {
    expect(iso4('Zeitschrift für Naturforschung')).toBe('Z. Naturforsch.');
    expect(iso4('Zeitschrift für Naturforschung A')).toBe('Z. Naturforsch. A');
  });
});

describe('ISO 4 on the real LTWA: the standard\'s own examples', () => {
  // Title and abbreviation pairs printed in ISO 4:1997, by clause.
  test.each([
    ['4.2', 'The Magistrate', 'Magistrate'],
    ['4.2', 'Medicina. Supplement', 'Medicina, Suppl.'],
    ['4.2', 'Forum (Düsseldorf)', 'Forum (Düsseld.)'],
    ['4.3', 'The New Hungarian Quarterly', 'New Hung. Q.'],
    ['4.3', 'Los Alamos science', 'Los Alamos sci.'],
    ['4.3', 'Journal of in vitro fertilization and embryo transfer', 'J. in vitro fertil. embryo transf.'],
    ['4.3', 'Vom Abenberger Land', 'Vom Abenb. Land'],
    ['4.3', "Vers l'éducation permanente", 'Vers éduc. perm.'],
    ['4.4', 'AEG-Mitteilungen', 'AEG-Mitt.'],
    ['4.4', 'Revue du CETHEDEC', 'Rev. CETHEDEC'],
    ['4.5', 'Archives of internal medicine', 'Arch. intern. med.'],
    ['4.6', 'Acta mineralogica, petrografica', 'Acta mineral. petrogr.'],
    ['4.6', 'Soviet physics. Technical physics', 'Sov. phys., Tech. phys.'],
    ['4.6', 'E.S.A. bulletin', 'E.S.A. bull.'],
    ['4.6', "Mr. Rodger's journal", "Mr. Rodger's j."],
    ['4.6', 'Proceedings of the ... annual meeting of the Acadian Entomological Society',
      'Proc. annu. meet. Acadian Entomol. Soc.'],
    ['4.7', 'Europe on $ ... a day', 'Eur. $ day'],
    ['4.7', 'Metall-Reinigung + Vorbehandlung', 'Met.-Reinig. Vorbehandl.'],
    ['4.7', 'Computer & control abstracts', 'Comput. control abstr.'],
    ['4.8', 'Journal of botany. Section A', 'J. bot., Sect. A'],
    ['4.8', "Annales scientifiques de l'Université de Besançon. Géologie", 'Ann. sci. Univ. Besançon, Géol.'],
    ['3.9', 'Proceedings of the International Seed Testing Association', 'Proc. Int. Seed Test. Assoc.']
  ])('%s: %s', (_clause, title, expected) => {
    expect(iso4(title)).toBe(expected);
  });
});

describe('ISO 4 on the real LTWA: word rules', () => {
  const word = (w) => abbreviateWord(w, REAL);

  test('plurals and inflected forms take the singular\'s abbreviation (3.4)', () => {
    expect(word('Reports').value).toBe('Rep.');
    expect(word('Sensors').value).toBe('Sens.');
    expect(word('Horizons').value).toBe('Horiz.');
    expect(word('Instruments').value).toBe('Instrum.');
    expect(word('Equilibria').value).toBe('Equilib.');
    expect(word('Accounts').value).toBe('Acc.');
  });

  test('an inflected form never borrows letters it does not have (3.4.1, 3.12)', () => {
    // weekly = wkly.; the "y" is not in "weeklies", so it stays in full. (The
    // list spells such plurals out where it wants them: countries = ctries.)
    expect(word('Weekly').value).toBe('Wkly.');
    expect(word('Weeklies').value).toBe('Weeklies');
    expect(word('countries').value).toBe('ctries.');
  });

  test('dropping one letter is not abbreviating (3.1)', () => {
    expect(word('Alloys').value).toBe('Alloys');
    expect(iso4('Journal of Alloys and Compounds')).toBe('J. Alloys Compd.');
  });

  test('diacritics: an accent-free spelling matches, and the title\'s letters are kept (3.2)', () => {
    expect(word('Electronic').value).toBe('Electron.');
    expect(word('Atmospheric').value).toBe('Atmos.');
    expect(iso4('Revista Brasileira de Ciência do Solo')).toBe('Rev. Bras. Ciênc. Solo');
  });

  test('a row spelled exactly like the word beats an accent-only match', () => {
    // Latin "Botanica" is "botan-" (bot.), not Spanish "botánica" (botán.).
    expect(word('Botanica').value).toBe('Bot.');
  });

  test('a ligature row matches a title that spells it out', () => {
    expect(word('Oecologica').value).toBe('Oecol.');
  });

  test('components: the head of a compound stays, short heads do not count (3.7, 3.8, 3.10)', () => {
    expect(word('Naturforschung').value).toBe('Naturforsch.');
    expect(word('Southampton').value).toBe('Southampt.');   // the 3.10 example
    expect(word('Dalton').value).toBe('Dalton');            // a person, not "Dal" + "-ton"
    expect(word('Phase').value).toBe('Phase');              // "-phas-" is a component only
  });

  test('a closed compound the list lacks is read as combining form + known word (3.7)', () => {
    expect(word('Electrochimica').value).toBe('Electrochim.');
    expect(word('Bioorganic').value).toBe('Bioorg.');
    // A surname is never split.
    expect(word('Beilstein').value).toBe('Beilstein');
  });

  test('a hyphenated compound is abbreviated part by part (3.7)', () => {
    expect(iso4('Physics-Uspekhi')).toBe('Phys.-Uspekhi');
    expect(iso4('Journal of Non-Equilibrium Thermodynamics')).toBe('J. Non-Equilib. Thermodyn.');
  });

  test('artificial words keep their form unless one row spans their capitals (3.3)', () => {
    expect(iso4('CrystEngComm Letters')).toBe('CrystEngComm Lett.');
    expect(iso4('Advances in OptoElectronics')).toBe('Adv. OptoElectron.');
  });

  test('every output letter is copied from the title (3.12, 4.5)', () => {
    expect(iso4('JOURNAL OF THE AMERICAN CHEMICAL SOCIETY')).toBe('J. AM. CHEM. SOC.');
    expect(iso4('journal of chemical physics')).toBe('j. chem. phys.');
  });
});

describe('ISO 4 on the real LTWA: designators and function words', () => {
  test.each([
    ['Physical Review A', 'Phys. Rev. A'],
    ['Physical Review E', 'Phys. Rev. E'],
    ['Physical Review X', 'Phys. Rev. X'],
    ['Journal of Physics A: Mathematical and Theoretical', 'J. Phys. A: Math. Theor.'],
    ['Acta Crystallographica Section B: Structural Science', 'Acta Crystallogr. Sect. B: Struct. Sci.'],
    ['Studies in History and Philosophy of Science Part B', 'Stud. Hist. Philos. Sci. Part B'],
    ['Journal of Physics II', 'J. Phys. II'],
    ['Comptes Rendus Series IV', 'Comptes Rendus Ser. IV'],
    ['Journal of Polymer Science Part A-1', 'J. Polym. Sci. Part A-1'],
    ['2D Materials', '2D Mater.'],
    ['JACS Au', 'JACS Au'],
    ['Lab on a Chip', 'Lab Chip'],
    ['Chemistry - A European Journal', 'Chem. - Eur. J.'],
    ['Geochimica et Cosmochimica Acta', 'Geochim. Cosmochim. Acta'],
    ['Auk, The', 'Auk'],
    ['Italia forestale e montana, L’', 'Ital. for. mont.'],
    ['From Zero to Hero', 'From Zero Hero'],
    ['Physica A', 'Physica A']
  ])('%s', (title, expected) => {
    expect(iso4(title)).toBe(expected);
  });

  test('a phrase the list knows is abbreviated as a whole', () => {
    expect(iso4('Proceedings of the National Academy of Sciences of the United States of America'))
      .toBe('Proc. Natl. Acad. Sci. U. S. A.');
  });
});

/*
 * The official abbreviations in the built-in dictionary (js/journal-data.js)
 * are the yardstick. The rules alone agreed on 150 of the 184 titles that are
 * actually abbreviated before the 2026-10 fixes; the floor below must only
 * ever rise. A title the rules do not reproduce must be listed here with the
 * rule output and the reason: these are places where the registered
 * abbreviation departs from ISO 4 on purpose, not engine bugs, and they are
 * deliberately not special-cased.
 */
const AGREEMENT_FLOOR = 169;
const KNOWN_DEVIATIONS = new Map([
  // CASSI keeps words that ISO 4 abbreviates by the LTWA.
  ['ACS Sustainable Chemistry & Engineering', 'ACS Sustain. Chem. Eng.'],
  ['International Journal of Hydrogen Energy', 'Int. J. Hydrog. Energy'],
  ['International Journal of Heat and Mass Transfer', 'Int. J. Heat Mass Transf.'],
  ['Bioconjugate Chemistry', 'Bioconjug. Chem.'],          // 3.7; NLM: Bioconjug Chem
  // The LTWA lists "Cheminformatics" as not abbreviated; CASSI uses "Cheminf.".
  ['Journal of Cheminformatics', 'J. Cheminformatics'],
  // CASSI puts a comma before a section letter or edition statement that the
  // title as written has no full stop for (4.6 only converts full stops).
  ['Journal of Vacuum Science & Technology A', 'J. Vac. Sci. Technol. A'],
  ['Angewandte Chemie International Edition', 'Angew. Chem. Int. Ed.'],
  ['Nuclear Instruments and Methods in Physics Research Section A', 'Nucl. Instrum. Methods Phys. Res. Sect. A'],
  // CASSI also drops the section title, which 4.8 keeps.
  ['Applied Catalysis A: General', 'Appl. Catal. A: Gen.'],
  ['Applied Catalysis B: Environmental', 'Appl. Catal. B: Environ.'],
  ['Colloids and Surfaces A: Physicochemical and Engineering Aspects', 'Colloids Surf. A: Physicochem. Eng. Asp.'],
  ['Spectrochimica Acta Part A: Molecular and Biomolecular Spectroscopy', 'Spectrochim. Acta Part A: Mol. Biomol. Spectrosc.'],
  ['Sensors and Actuators B: Chemical', 'Sens. Actuators B: Chem.'],
  // The LTWA spaces the initials ("U. S. A."); the registered form does not.
  ['Proceedings of the National Academy of Sciences of the United States of America', 'Proc. Natl. Acad. Sci. U. S. A.'],
  // The dictionary maps the short name to the full journal's abbreviation.
  ['Proceedings of the National Academy of Sciences', 'Proc. Natl. Acad. Sci.']
]);

function loadDictionary() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(repo, 'js', 'journal-data.js'), 'utf8'), sandbox);
  return sandbox.window.STEMKIT_JOURNALS;
}

describe('ISO 4 rules against the built-in dictionary', () => {
  const dictionary = loadDictionary();
  const abbreviated = dictionary.filter(([t, a]) => t.toLowerCase() !== a.toLowerCase());
  const results = abbreviated.map(([title, official]) => ({ title, official, rules: iso4(title) }));
  const misses = results.filter(r => r.rules !== r.official);

  test('the dictionary is the expected size', () => {
    expect(abbreviated.length).toBe(184);
  });

  test(`the rules alone agree on at least ${AGREEMENT_FLOOR} of the abbreviated titles`, () => {
    expect(results.length - misses.length).toBeGreaterThanOrEqual(AGREEMENT_FLOOR);
  });

  test('every disagreement is a listed deviation, with the listed rule output', () => {
    const unexplained = misses
      .filter(m => KNOWN_DEVIATIONS.get(m.title) !== m.rules)
      .map(m => `${m.title}: rules "${m.rules}", dictionary "${m.official}"`);
    expect(unexplained).toEqual([]);
  });

  test('no listed deviation has started to agree (if one has, remove it and raise the floor)', () => {
    const missed = new Set(misses.map(m => m.title));
    expect([...KNOWN_DEVIATIONS.keys()].filter(t => !missed.has(t))).toEqual([]);
  });

  test('titles left in full by the dictionary stay in full', () => {
    const identity = dictionary.filter(([t, a]) => t.toLowerCase() === a.toLowerCase());
    expect(identity.filter(([t]) => iso4(t) !== t)).toEqual([]);
  });
});

/*
 * Malformed output, over many titles built from LTWA rows of every shape:
 * stems with endings, components with long and short heads, phrases, stop
 * words, designators, punctuation, hyphenated compounds, elisions,
 * possessives and all three capitalisations. Seeded, so a failure reproduces.
 */
describe('ISO 4 never produces malformed output', () => {
  function mulberry32(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const { entries } = parseLTWA(LTWA);
  const rnd = mulberry32(20261001);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const ENDINGS = ['', '', 'al', 'ic', 'ics', 'ical', 'y', 'ies', 's', 'ation', 'en', 'e', 'a', 'ung', 'ique'];
  const HEADS = ['', 'X', 'Ab', 'Dal', 'Natur', 'Bio', 'Kunst', 'Southamp', 'Geo', 'Electro'];
  const EXTRAS = ['of', 'the', 'and', '&', 'in', 'A', 'B', 'E', 'II', 'IV', 'Part', 'Section', '12', 'A-1',
    ':', '-', 'for', 'de', 'la', 'für', 'und', 'et', 'y', 'e', 'i', 'a', 'Au', '2D'];
  const styled = (w) => {
    const r = rnd();
    if (r < 0.6) return w.charAt(0).toUpperCase() + w.slice(1);
    return r < 0.85 ? w.toLowerCase() : w.toUpperCase();
  };
  const formOf = (e) => {
    if (e.words) return e.pattern.replace(/-$/, '');
    const s = e.pattern.replace(/^-/, '').replace(/-$/, '');
    if (e.kind === 'exact') return s;
    if (e.kind === 'prefix') return s + pick(ENDINGS);
    if (e.kind === 'suffix') return pick(HEADS) + s + (rnd() < 0.3 ? 's' : '');
    return pick(HEADS) + s + pick(ENDINGS);
  };
  const lettersOf = (s) => fold(s).replace(/[^\p{L}]/gu, '');
  const isSubsequence = (a, b) => { let i = 0; for (const c of b) if (c === a[i]) i++; return i === a.length; };

  const titles = [];
  for (let n = 0; n < 20000; n++) {
    const parts = [];
    const length = 1 + Math.floor(rnd() * 6);
    for (let k = 0; k < length; k++) {
      if (rnd() < 0.25) { parts.push(pick(EXTRAS)); continue; }
      let w = styled(formOf(pick(entries)));
      const r = rnd();
      if (r < 0.06) w = w + '-' + styled(formOf(pick(entries)));
      else if (r < 0.09) w = "l'" + w;
      else if (r < 0.12) w = w + "'s";
      else if (r < 0.16) w = w + pick([',', '.', ':', ';']);
      else if (r < 0.18) w = '(' + w + ')';
      parts.push(w);
    }
    if (/\p{L}/u.test(parts.join(''))) titles.push(parts.join(' '));
  }

  const outputs = titles.map(t => [t, iso4(t)]);
  const failures = (check) => outputs.filter(([t, out]) => !check(out, t)).slice(0, 5);

  test('the sample is large', () => {
    expect(titles.length).toBeGreaterThan(19000);
  });

  test('no output word starts with a hyphen', () => {
    expect(failures(out => !out.split(' ').some(w => /^[-‐–—]\p{L}/u.test(w)))).toEqual([]);
  });

  test('no empty words, stray spaces or empty results', () => {
    expect(failures(out => out !== '' && out === out.trim() && !/\s\s/.test(out))).toEqual([]);
  });

  test('no doubled full stops or stray commas', () => {
    expect(failures(out => !/\.\.|,,|\s,|^,|,$/.test(out))).toEqual([]);
    expect(failures(out => !out.split(' ').some(w => /^[.,;]+$/.test(w)))).toEqual([]);
  });

  test('every output letter comes from the title, in order (3.12)', () => {
    expect(failures((out, t) => isSubsequence(lettersOf(out), lettersOf(t)))).toEqual([]);
  });
});
