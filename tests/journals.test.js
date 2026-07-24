import { describe, test, expect } from '@jest/globals';
import {
  normKey, toPatternPart, parseCustomRules, buildEngine,
  abbreviate, processText, findUnknownTitles, segmentText, SUSPECT_TITLE
} from '../src/core/journals.js';

const DICT = [
  ['Journal of the American Chemical Society', 'J. Am. Chem. Soc.'],
  ['Journal of Physical Chemistry', 'J. Phys. Chem.'],
  ['Journal of Physical Chemistry Letters', 'J. Phys. Chem. Lett.'],
  ['Nature', 'Nature'],
  ['Physical Review Letters', 'Phys. Rev. Lett.'],
  ['Angewandte Chemie International Edition', 'Angew. Chem. Int. Ed.']
];

const ENGINE = buildEngine(DICT);

describe('normKey', () => {
  test('lowercases and collapses whitespace', () => {
    expect(normKey('Journal  of   Chemistry')).toBe('journal of chemistry');
  });

  test('strips a leading "The"', () => {
    expect(normKey('The Journal of Physical Chemistry'))
      .toBe(normKey('Journal of Physical Chemistry'));
  });

  test('treats an ampersand as "and"', () => {
    expect(normKey('Metals & Alloys')).toBe(normKey('Metals and Alloys'));
  });

  test('normalises dashes and punctuation to spaces', () => {
    expect(normKey('Journal of Bio-Chemistry')).toBe('journal of bio chemistry');
    expect(normKey('Nature: Chemistry')).toBe('nature chemistry');
    expect(normKey('J. Chem.')).toBe('j chem');
  });

  test('handles em and en dashes', () => {
    expect(normKey('A\u2013B')).toBe(normKey('A-B'));
    expect(normKey('A\u2014B')).toBe(normKey('A-B'));
  });

  test('handles empty and non-string input', () => {
    expect(normKey('')).toBe('');
    expect(normKey(null)).toBe('');
  });
});

describe('toPatternPart', () => {
  test('escapes regex metacharacters', () => {
    const p = toPatternPart('Chem. (Berlin)');
    expect(() => new RegExp(p)).not.toThrow();
    expect(p).toContain('\\(');
  });

  test('makes whitespace flexible', () => {
    const re = new RegExp(toPatternPart('Journal of Chemistry'), 'i');
    expect(re.test('Journal  of   Chemistry')).toBe(true);
  });

  test('accepts an ampersand or the word "and"', () => {
    const re = new RegExp(toPatternPart('Metals & Alloys'), 'i');
    expect(re.test('Metals & Alloys')).toBe(true);
    expect(re.test('Metals and Alloys')).toBe(true);
  });

  test('makes trailing punctuation optional', () => {
    const re = new RegExp(toPatternPart('Nature: Chemistry'), 'i');
    expect(re.test('Nature Chemistry')).toBe(true);
    expect(re.test('Nature: Chemistry')).toBe(true);
  });

  test('strips a leading "The" from the pattern', () => {
    expect(toPatternPart('The Journal').toLowerCase()).not.toContain('the');
  });
});

describe('parseCustomRules', () => {
  test('parses name and abbreviation pairs', () => {
    expect(parseCustomRules('My Journal = My. J.')).toEqual([['My Journal', 'My. J.']]);
  });

  test('ignores comments and blank lines', () => {
    const rules = parseCustomRules('# a comment\n\nA = B\n   \nC = D');
    expect(rules).toHaveLength(2);
  });

  test('ignores lines without an equals sign', () => {
    expect(parseCustomRules('no equals here')).toEqual([]);
  });

  test('ignores a line with an empty name or abbreviation', () => {
    expect(parseCustomRules('= B')).toEqual([]);
    expect(parseCustomRules('A =')).toEqual([]);
  });

  test('keeps equals signs inside the abbreviation', () => {
    expect(parseCustomRules('A = B = C')).toEqual([['A', 'B = C']]);
  });

  test('handles CRLF and empty input', () => {
    expect(parseCustomRules('A = B\r\nC = D')).toHaveLength(2);
    expect(parseCustomRules('')).toEqual([]);
    expect(parseCustomRules(null)).toEqual([]);
  });
});

describe('buildEngine', () => {
  test('indexes every dictionary entry', () => {
    expect(ENGINE.entryCount).toBe(6);
    expect(ENGINE.builtinCount).toBe(6);
  });

  test('compiles a search pattern', () => {
    expect(ENGINE.pattern).not.toBeNull();
  });

  test('lets custom rules override built-in entries', () => {
    const e = buildEngine(DICT, [['Nature', 'Nat.']]);
    expect(abbreviate('Nature', e.lookup)).toBe('Nat.');
    expect(e.customCount).toBe(1);
  });

  test('produces a null pattern for an empty dictionary', () => {
    expect(buildEngine([]).pattern).toBeNull();
  });

  test('skips malformed entries', () => {
    const e = buildEngine([['A', 'B'], ['', 'C'], ['D', '']]);
    expect(e.entryCount).toBe(1);
  });

  test('handles non-array input', () => {
    expect(buildEngine(null).entryCount).toBe(0);
  });
});

describe('abbreviate', () => {
  test('looks up an exact title', () => {
    expect(abbreviate('Nature', ENGINE.lookup)).toBe('Nature');
    expect(abbreviate('Physical Review Letters', ENGINE.lookup)).toBe('Phys. Rev. Lett.');
  });

  test('matches despite case, punctuation and a leading "The"', () => {
    expect(abbreviate('the journal of physical chemistry.', ENGINE.lookup))
      .toBe('J. Phys. Chem.');
  });

  test('returns null for an unknown title', () => {
    expect(abbreviate('Journal of Imaginary Studies', ENGINE.lookup)).toBeNull();
  });

  test('handles a missing lookup', () => {
    expect(abbreviate('Nature', null)).toBeNull();
  });
});

describe('processText', () => {
  test('abbreviates a title inside running prose', () => {
    const r = processText('Published in Journal of the American Chemical Society, 2020.', ENGINE);
    expect(r.text).toBe('Published in J. Am. Chem. Soc., 2020.');
    expect(r.replacements).toHaveLength(1);
  });

  test('handles a leading "The"', () => {
    const r = processText('See The Journal of Physical Chemistry Letters here.', ENGINE);
    expect(r.text).toContain('J. Phys. Chem. Lett.');
  });

  test('prefers the longer title when one contains another', () => {
    // Without longest-first ordering, "...Letters" would abbreviate as the
    // shorter "Journal of Physical Chemistry", changing the citation.
    const r = processText(
      'Both Journal of Physical Chemistry and Journal of Physical Chemistry Letters.',
      ENGINE
    );
    expect(r.text).toContain('J. Phys. Chem. Lett.');
    expect(r.replacements).toHaveLength(2);
  });

  test('abbreviates several distinct titles in one pass', () => {
    const r = processText('Physical Review Letters and Nature.', ENGINE);
    // Both are recognised; only one changes the text.
    expect(r.replacements).toHaveLength(2);
    expect(r.replacements.filter(x => x.changed)).toHaveLength(1);
  });

  test('leaves unknown titles untouched', () => {
    const r = processText('Appeared in Journal of Imaginary Studies.', ENGINE);
    expect(r.text).toContain('Journal of Imaginary Studies');
    expect(r.replacements).toHaveLength(0);
  });

  test('records the position of each replacement', () => {
    const r = processText('X Nature Y', ENGINE);
    expect(r.replacements[0].index).toBe(2);
    expect(r.replacements[0].from).toBe('Nature');
  });

  test('is repeatable, a /g regex must not carry lastIndex between calls', () => {
    const input = 'Nature and Physical Review Letters';
    const first = processText(input, ENGINE);
    const second = processText(input, ENGINE);
    expect(second.text).toBe(first.text);
    expect(second.replacements).toHaveLength(first.replacements.length);
  });

  test('returns text unchanged when the engine is empty', () => {
    const r = processText('Nature', buildEngine([]));
    expect(r.text).toBe('Nature');
  });

  test('handles empty input', () => {
    expect(processText('', ENGINE).text).toBe('');
    expect(processText(null, ENGINE).text).toBe('');
  });
});

describe('findUnknownTitles', () => {
  test('flags a journal-like title absent from the dictionary', () => {
    const u = findUnknownTitles('Published in Journal of Imaginary Studies.', ENGINE);
    expect(u.length).toBeGreaterThan(0);
    expect(u[0]).toContain('Journal of Imaginary Studies');
  });

  test('does not flag a known title', () => {
    expect(findUnknownTitles('Journal of Physical Chemistry', ENGINE)).toEqual([]);
  });

  test('reports each unknown title once', () => {
    const text = 'Journal of Imaginary Studies and Journal of Imaginary Studies again';
    expect(findUnknownTitles(text, ENGINE)).toHaveLength(1);
  });

  test('returns nothing for ordinary prose', () => {
    expect(findUnknownTitles('This is a plain sentence.', ENGINE)).toEqual([]);
  });

  test('the suspect pattern matches typical journal phrasing', () => {
    const re = new RegExp(SUSPECT_TITLE.source, SUSPECT_TITLE.flags);
    expect(re.test('Proceedings of the National Academy')).toBe(true);
  });
});

describe('segmentText', () => {
  test('splits text into replaced and untouched runs', () => {
    const segs = segmentText('See Nature today', ENGINE);
    expect(segs[0]).toEqual({ type: 'text', value: 'See ' });
    expect(segs[1].type).toBe('replaced');
    expect(segs[1].original).toBe('Nature');
    expect(segs[2].value).toBe(' today');
  });

  test('marks an identity entry as recognised but unchanged', () => {
    // "Nature" abbreviates to itself; it is still a dictionary hit.
    const seg = segmentText('Nature', ENGINE)[0];
    expect(seg.type).toBe('replaced');
    expect(seg.changed).toBe(false);
  });

  test('marks a genuine abbreviation as changed', () => {
    const seg = segmentText('Physical Review Letters', ENGINE)[0];
    expect(seg.changed).toBe(true);
  });

  test('reassembles into the processed text', () => {
    const input = 'A Nature B Physical Review Letters C';
    const joined = segmentText(input, ENGINE).map(s => s.value).join('');
    expect(joined).toBe(processText(input, ENGINE).text);
  });

  test('returns a single run when nothing matches', () => {
    const segs = segmentText('nothing here', ENGINE);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('text');
  });

  test('returns a single run for an empty engine', () => {
    expect(segmentText('Nature', buildEngine([]))).toEqual([
      { type: 'text', value: 'Nature' }
    ]);
  });

  test('handles a title at the very start and end', () => {
    const segs = segmentText('Nature', ENGINE);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('replaced');
  });
});

describe('identity entries', () => {
  // A journal whose abbreviation equals its name (Nature, Small, Science)
  // must not be reported as a change: the text does not move, so counting it
  // would inflate the edit count with substitutions the reader cannot see.
  const IDENT = buildEngine([
    ['Nature', 'Nature'],
    ['Physical Review Letters', 'Phys. Rev. Lett.']
  ]);

  test('an identity entry leaves the text untouched', () => {
    const r = processText('Published in Nature.', IDENT);
    expect(r.text).toBe('Published in Nature.');
  });

  test('an identity entry is recognised but marked unchanged', () => {
    // It is a real dictionary hit -- some journals are simply not abbreviated
    // -- so it is reported, with `changed` distinguishing it from a rewrite.
    const r = processText('Published in Nature.', IDENT);
    expect(r.replacements).toHaveLength(1);
    expect(r.replacements[0].changed).toBe(false);
  });

  test('only genuine abbreviations report changed', () => {
    const r = processText('Nature and Physical Review Letters', IDENT);
    const changed = r.replacements.filter(x => x.changed);
    expect(changed).toHaveLength(1);
    expect(changed[0].to).toBe('Phys. Rev. Lett.');
  });

  test('segmentText marks an identity entry as recognised', () => {
    const segs = segmentText('Nature and Physical Review Letters', IDENT);
    const replaced = segs.filter(s => s.type === 'replaced');
    expect(replaced).toHaveLength(2);
    expect(replaced.filter(s => s.changed)).toHaveLength(1);
  });

  test('the identity check is case-insensitive', () => {
    // "nature" matches the dictionary entry "Nature"; the abbreviation equals
    // it apart from case, so nothing is rewritten.
    const r = processText('published in nature.', IDENT);
    expect(r.replacements.filter(x => x.changed)).toHaveLength(0);
  });
});
