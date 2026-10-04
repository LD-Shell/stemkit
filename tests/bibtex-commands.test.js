/**
 * LaTeX commands in titles: what the Deduplicator's comparison and the
 * Sanitizer's capital protection make of them.
 *
 * The last block runs BibTeX itself, when it is installed, on titles before
 * and after `protectCapitals`, and reads what the `plain` style prints.
 */
import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../tests/setup.js';
import {
  normaliseTitle, parseBibtex, findDuplicates, protectCapitals, sanitiseText
} from '../src/core/bibtex.js';

const keysOf = (entries) =>
  findDuplicates(entries).groups.map(g => g.members.map(m => m.data.citationKey));

describe('normaliseTitle and commands', () => {
  test('a formula keeps what it says', () => {
    expect(normaliseTitle('Energy E=mc² study')).toBe('energy e mc2 study');
    // Two titles that differ only in a formula are two works.
    expect(normaliseTitle('Synthesis of $\\alpha$-pinene'))
      .not.toBe(normaliseTitle('Synthesis of $\\beta$-pinene'));
  });

  test('a Greek letter is the same letter as a command and as a character', () => {
    expect(normaliseTitle('The $\\alpha$-helix')).toBe('the α helix');
    expect(normaliseTitle('The α-helix')).toBe('the α helix');
    // The space after a command is the command's: `$\Delta G$` is ΔG.
    expect(normaliseTitle('$\\Delta G$ of binding')).toBe(normaliseTitle('ΔG of binding'));
    expect(normaliseTitle('5 \\textmu m beads')).toBe(normaliseTitle('5 µm beads'));
    // \mu is not the start of \multicolumn.
    expect(normaliseTitle('a \\multicolumn b')).toBe('a multicolumn b');
  });

  test('a command around text is dropped and the text kept', () => {
    expect(normaliseTitle('Solubility of \\ce{NaCl} in water')).toBe('solubility of nacl in water');
    expect(normaliseTitle('Solubility of \\ce{NaCl} in water'))
      .not.toBe(normaliseTitle('Solubility of \\ce{KCl} in water'));
    expect(normaliseTitle('H\\textsubscript{2}O dynamics')).toBe('h2o dynamics');
    expect(normaliseTitle('H$_2$O dynamics')).toBe('h2o dynamics');
    expect(normaliseTitle('\\SI[per-mode=symbol]{5}{\\nano\\metre} pores')).toBe('5nanometre pores');
    expect(normaliseTitle('A \\emph{very} \\textit{nice} title')).toBe('a very nice title');
  });

  test('a command that is text keeps its name', () => {
    expect(normaliseTitle('Typesetting with \\LaTeX today')).toBe('typesetting with latex today');
    expect(normaliseTitle('Typesetting with {\\LaTeX{}} today')).toBe('typesetting with latex today');
    expect(normaliseTitle('Typesetting with \\LaTeX today'))
      .not.toBe(normaliseTitle('Typesetting with \\TeX today'));
  });

  test('an unknown command glued to its argument keeps the argument', () => {
    // What a parser that drops grouping braces makes of \ce{NaCl} and \ce{KCl}.
    expect(normaliseTitle('Solubility of \\ceNaCl in water'))
      .not.toBe(normaliseTitle('Solubility of \\ceKCl in water'));
    expect(normaliseTitle('Ha\\vcek')).toBe('havcek');
  });

  test('font switches and punctuation commands leave no word behind', () => {
    expect(normaliseTitle('{\\bf Bold} claim')).toBe('bold claim');
    expect(normaliseTitle('{\\itshape Bold} claim')).toBe('bold claim');
    expect(normaliseTitle('Structure\\textendash function')).toBe('structure function');
    expect(normaliseTitle('Structure--function')).toBe('structure function');
    expect(normaliseTitle('Structure\u2013function')).toBe('structure function');
    expect(normaliseTitle('And so on\\ldots')).toBe('and so on');
    expect(normaliseTitle('Cost of \\$5 \\& more')).toBe('cost of 5 more');
    expect(normaliseTitle('hy\\-phen\\-ation')).toBe('hyphenation');
    expect(normaliseTitle('Line\\\\break')).toBe('line break');
    // \item is not \it followed by "em".
    expect(normaliseTitle('An \\item here')).toBe('an item here');
  });

  test('accents fold, however they are written', () => {
    const forms = ['Schr\\"odinger', 'Schr{\\"o}dinger', 'Schr\\"{o}dinger', 'Schr\u00f6dinger', 'Schro\u0308dinger'];
    for (const f of forms) expect(normaliseTitle(f + ' equation')).toBe('schrodinger equation');
    expect(normaliseTitle('Ha\\v{c}ek and \\c{C}elik')).toBe(normaliseTitle('Haček and Çelik'));
    expect(normaliseTitle('Gar\\c con')).toBe('garcon');
    expect(normaliseTitle('Erd\\H{o}s number')).toBe(normaliseTitle('Erdős number'));
  });

  test('letters written as commands are those letters', () => {
    expect(normaliseTitle('Stra\\ss e und \\O resund')).toBe('straße und øresund');
    expect(normaliseTitle('Stra{\\ss}e und {\\O}resund')).toBe(normaliseTitle('Straße und Øresund'));
  });

  test('titles in other scripts are compared by their words', () => {
    // With ASCII-only word characters both of these reduced to "2020".
    expect(normaliseTitle('Отчёт 2020')).not.toBe(normaliseTitle('План 2020'));
    expect(normaliseTitle('分子动力学 2020')).toBe('分子动力学 2020');
    expect(normaliseTitle('分子动力学。')).toBe('分子动力学');
    expect(normaliseTitle('ﬁnal ﬂow')).toBe('final flow');
  });

  test('a normalised title is its own normal form', () => {
    const titles = ['Solubility of \\ce{NaCl}', 'The $\\alpha$-helix', 'Schr\\"odinger', '{The} Structure of DNA.',
      'Typesetting with \\LaTeX', 'Отчёт 2020', 'H\\textsubscript{2}O', 'Stra\\ss e'];
    for (const title of titles) {
      const once = normaliseTitle(title);
      expect(once).not.toBe('');
      expect(normaliseTitle(once)).toBe(once);
    }
  });
});

describe('findDuplicates reads titles from the source', () => {
  test('titles that differ only inside a command are not one work', () => {
    // The parser drops the braces of \ce{NaCl}; in the source the argument
    // still stands apart from the command.
    const bib = `@article{a, title={Solubility of \\ce{NaCl} in water}, year={2001}}
@article{b, title={Solubility of \\ce{KCl} in water}, year={2002}}
@article{c, title={Solubility of {\\ce{NaCl}} in Water.}, year={2003}}
@article{d, title="Notes on H\\textsubscript{2}O", year={2001}}
@article{e, title={Notes on H\\textsubscript{3}O}, year={2001}}
@article{f, title={Notes on H2O}, year={2004}}`;
    const parsed = parseBibtex(bib);
    expect(parsed.error).toBeNull();
    expect(keysOf(parsed.entries)).toEqual([['a', 'c'], ['d', 'f']]);
    expect(findDuplicates(parsed.entries).duplicateCount).toBe(2);
  });

  test('the same emphasised title still groups, a different one does not', () => {
    const bib = `@article{a, title={Notes on \\emph{cats} at night}}
@article{b, title={Notes on cats at night}}
@article{c, title={Notes on \\emph{dogs} at night}}
@article{d, TITLE = {Notes on \\textit{Cats} at Night.}}`;
    expect(keysOf(parseBibtex(bib).entries)).toEqual([['a', 'b', 'd']]);
  });

  test('a title from a macro or a concatenation is compared by its text', () => {
    const bib = `@string{t = "A Macro Title"}
@article{a, title=t, year={2001}}
@article{b, title = "A macro " # "title", year={2002}}
@article(c, title={Paren \\emph{entry} here})
@article{d, title={Paren entry here}}`;
    expect(keysOf(parseBibtex(bib).entries)).toEqual([['a', 'b'], ['c', 'd']]);
  });

  test('an entry changed after parsing is compared by what it now says', () => {
    const entries = parseBibtex(`@article{a, title={Same \\ce{NaCl} title}}
@article{b, title={Same \\ce{NaCl} title}}`).entries;
    expect(keysOf(entries)).toEqual([['a', 'b']]);
    entries[1].entryTags.title = 'Something else';
    expect(keysOf(entries)).toEqual([]);
  });

  test('entries that were never parsed here carry no source and still compare', () => {
    const made = [
      { citationKey: 'x', entryTags: { title: 'Solubility of \\ce{NaCl}' } },
      { citationKey: 'y', entryTags: { TITLE: 'solubility of NaCl.' } },
      { citationKey: 'z', entryTags: { title: 'Solubility of \\ce{KCl}' } },
      { citationKey: 'w', entryTags: {} }
    ];
    expect(keysOf(made)).toEqual([['x', 'y']]);
  });
});

describe('protectCapitals and commands', () => {
  test('text inside braces is left alone at any depth', () => {
    expect(protectCapitals('{The DNA of {E. coli}}')).toBe('{The DNA of {E. coli}}');
    expect(protectCapitals('The \\textbf{DNA} helix')).toBe('The \\textbf{DNA} helix');
    expect(protectCapitals('\\ce{NaCl} in water')).toBe('\\ce{NaCl} in water');
    // BibTeX counts an escaped brace as a brace.
    expect(protectCapitals('An \\{DNA\\} escape')).toBe('An \\{DNA\\} escape');
  });

  test('a capitalised command is braced together with its arguments', () => {
    expect(protectCapitals('Pores of \\SI{5}{\\nano\\metre} in DNA'))
      .toBe('Pores of {\\SI{5}{\\nano\\metre}} in {DNA}');
    expect(protectCapitals('\\SI[per-mode=symbol]{5}{\\metre\\per\\second} flows'))
      .toBe('{\\SI[per-mode=symbol]{5}{\\metre\\per\\second}} flows');
    expect(protectCapitals('\\SIrange{1}{5}{\\kilo\\hertz}')).toBe('{\\SIrange{1}{5}{\\kilo\\hertz}}');
    expect(protectCapitals('\\SI*{5}{m} and \\TeX*')).toBe('{\\SI*{5}{m}} and {\\TeX}*');
    expect(protectCapitals('\\LaTeX{} is fun')).toBe('{\\LaTeX{}} is fun');
    expect(protectCapitals('Nested \\MakeUppercase{a {b} c} here')).toBe('Nested {\\MakeUppercase{a {b} c}} here');
    // An argument set apart by a space is not taken to be one.
    expect(protectCapitals('\\TeX {users} group')).toBe('{\\TeX} {users} group');
    // The name ends where its letters end.
    expect(protectCapitals('\\LaTeX2e')).toBe('{\\LaTeX}2e');
  });

  test('the braces are doubled when an argument holds a word to protect', () => {
    // BibTeX keeps the commands inside {\cmd ...} but lowercases its plain text.
    expect(protectCapitals('A tone of \\SI{5}{kHz}')).toBe('A tone of {{\\SI{5}{kHz}}}');
    expect(protectCapitals('\\NoCaseChange{McMurry} text')).toBe('{{\\NoCaseChange{McMurry}}} text');
    expect(protectCapitals('\\SI{5}{\\kHz} tone')).toBe('{\\SI{5}{\\kHz}} tone');
  });

  test('any command with a capital in its name is braced', () => {
    expect(protectCapitals('Erd\\H{o}s numbers')).toBe('Erd{\\H{o}}s numbers');
    expect(protectCapitals('The \\Delta of it')).toBe('The {\\Delta} of it');
    expect(protectCapitals('The \\alpha of it')).toBe('The \\alpha of it');
  });

  test('letters written as commands are left alone', () => {
    // A brace after \AA would end the word: {\AA} ngstrom prints "Å ngstrom".
    expect(protectCapitals('Lengths in \\AA ngstr\\"om units')).toBe('Lengths in \\AA ngstr\\"om units');
    expect(protectCapitals("The \\O resund bridge and \\L \\'od\\'z")).toBe("The \\O resund bridge and \\L \\'od\\'z");
  });

  test('a formula with a capital is braced whole', () => {
    expect(protectCapitals('The free energy $\\Delta G$ of ATP')).toBe('The free energy {$\\Delta G$} of {ATP}');
    expect(protectCapitals('At constant $T$ and $p$')).toBe('At constant {$T$} and $p$');
    expect(protectCapitals('Display $$E = mc^2$$ here')).toBe('Display {$$E = mc^2$$} here');
    expect(protectCapitals('Water $\\mathrm{H_2O}$ again')).toBe('Water {$\\mathrm{H_2O}$} again');
    expect(protectCapitals('An $ABC$ triple')).toBe('An {$ABC$} triple');
    // \$ is a dollar sign, and a lone $ opens nothing.
    expect(protectCapitals('It costs \\$5 for DNA and \\$6 for RNA')).toBe('It costs \\$5 for {DNA} and \\$6 for {RNA}');
    expect(protectCapitals('A lone $ and DNA')).toBe('A lone $ and {DNA}');
  });

  test('only whole words are protected', () => {
    expect(protectCapitals('a_DNA and DNA_x')).toBe('a_DNA and DNA_x');
    expect(protectCapitals('X-ray of NaCl-water')).toBe('X-ray of {NaCl}-water');
  });

  const TITLES = [
    'Pores of \\SI{5}{\\nano\\metre} in DNA', '\\SI[per-mode=symbol]{5}{\\metre\\per\\second} flows',
    'A tone of \\SI{5}{kHz}', 'Typesetting with \\LaTeX and \\TeX', 'The free energy $\\Delta G$ of ATP',
    "Erd\\H{o}s and R\\'enyi", 'Lengths in \\AA ngstr\\"om units', '{The DNA of {E. coli}}', 'First\\\\DNA',
    'An \\{DNA\\} escape', 'Display $$E = mc^2$$ here', 'pH of mRNA in NaCl', '\\NoCaseChange{McMurry} text',
    'x\\SI{5}{\\Hz}{}{} y', 'It costs \\$5 for DNA', 'The \\textbf{DNA} helix', 'Plain title case only',
    'Salts such as \\ce{NaCl} and pH', 'A study of {\\LaTeX} in mRNA labs'
  ];

  test('braces are only added, stay balanced, and one pass is enough', () => {
    const bare = (s) => s.replace(/[{}]/g, '');
    const balanced = (s) => {
      let depth = 0;
      for (const c of s) {
        if (c === '{') depth++;
        else if (c === '}' && --depth < 0) return false;
      }
      return depth === 0;
    };
    for (const title of TITLES) {
      const once = protectCapitals(title);
      expect(bare(once)).toBe(bare(title));
      expect(balanced(once)).toBe(true);
      expect(protectCapitals(once)).toBe(once);
    }
  });

  test('an argument that is never closed does not stop the pass', () => {
    expect(protectCapitals('Unclosed \\SI{5 here')).toBe('Unclosed {\\SI}{5 here');
    expect(protectCapitals('Unclosed \\SI[5 here DNA')).toBe('Unclosed {\\SI}[5 here {DNA}');
  });

  test('sanitiseText writes the protected title back into the entry', () => {
    const src = '@article{a,\n  title = {Pores of \\SI{5}{\\nano\\metre} in DNA at $T$},\n  year = {2020}\n}\n';
    const out = sanitiseText(src, { protectTitle: true }).text;
    expect(out).toContain('title = {Pores of {\\SI{5}{\\nano\\metre}} in {DNA} at {$T$}}');
    expect(parseBibtex(out).error).toBeNull();
    expect(sanitiseText(out, { protectTitle: true }).text).toBe(out);
  });

  /* ---------------------------------------------------------------- *
   * BibTeX itself: the `plain` style lowercases a title after its first
   * letter. What is printed must still hold every command and capital.
   * ---------------------------------------------------------------- */

  const haveBibtex = (() => {
    try {
      return spawnSync('bibtex', ['--version'], { encoding: 'utf8', timeout: 30000 }).status === 0 &&
        spawnSync('kpsewhich', ['plain.bst'], { encoding: 'utf8', timeout: 30000 }).status === 0;
    } catch {
      return false;
    }
  })();
  const withBibtex = haveBibtex ? test : test.skip;

  /** The titles BibTeX prints for a library, by citation key. */
  function printedTitles(titles) {
    const dir = mkdtempSync(join(tmpdir(), 'stemkit-bibtex-'));
    try {
      writeFileSync(join(dir, 't.bib'), titles
        .map((t, i) => `@article{k${i}, author={A. Author}, title={${t}}, journal={J}, year=2000}`).join('\n'));
      writeFileSync(join(dir, 't.aux'),
        '\\bibstyle{plain}\n\\bibdata{t}\n' + titles.map((t, i) => `\\citation{k${i}}`).join('\n') + '\n');
      const run = spawnSync('bibtex', ['t'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
      const bbl = readFileSync(join(dir, 't.bbl'), 'utf8').replace(/%\n/g, '').replace(/\n\s+/g, ' ');
      const printed = {};
      for (const m of bbl.matchAll(/\\bibitem\{k(\d+)\}.*?\\newblock (.*?)\.\s*\\newblock/gs)) printed[m[1]] = m[2];
      return { status: run.status, printed: titles.map((t, i) => printed[i]) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  withBibtex('BibTeX damages the unprotected titles', () => {
    const { status, printed } = printedTitles([
      'Pores of \\SI{5}{\\nano\\metre} in DNA', 'Typesetting with \\LaTeX', 'The free energy $\\Delta G$ of it'
    ]);
    expect(status).toBe(0);
    expect(printed[0]).toBe('Pores of \\si{5}{\\nano\\metre} in dna');
    expect(printed[1]).toBe('Typesetting with \\latex');
    expect(printed[2]).toBe('The free energy $\\delta g$ of it');
  });

  withBibtex('BibTeX prints every protected title as it was written', () => {
    // A lower-case first word, so that nothing rests on BibTeX keeping the
    // first letter of a title.
    const titles = TITLES.map(t => 'on ' + t);
    const protectedTitles = titles.map(protectCapitals);
    const { status, printed } = printedTitles(protectedTitles);
    expect(status).toBe(0);
    // BibTeX lowercases what is outside braces, the letters written as
    // commands with it (\AA to \aa), and nothing inside them: every braced
    // command, word and formula is printed as it was written.
    const lowerOutsideBraces = (s) => {
      let depth = 0;
      let out = '';
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        out += depth === 0 ? c.toLowerCase() : c;
      }
      return out;
    };
    protectedTitles.forEach((title, i) => {
      const expected = lowerOutsideBraces(title);
      expect(printed[i].toLowerCase().startsWith('on ')).toBe(true);
      expect(printed[i].slice(1)).toBe(expected.slice(1));
    });
  });
});
