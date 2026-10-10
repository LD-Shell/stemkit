import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The method tabs of the Scientific Converter, the Statistics Calculator and
 * the MD Workflow Generator, and the workflow generator's engine tabs, held
 * to the ARIA tabs pattern in the markup a page is served with: a named tab
 * list, each tab pointing at its pane and each pane named by its tab, and
 * one tab in the tab order. The three pages are meant to behave alike, so
 * their handlers are compared too. What the keys do is checked in a browser.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));

const PAGES = [
  ['scientific-converter.html', 'js/scientific-converter.js'],
  ['stats-calculator.html', 'js/stats-calculator.js'],
  ['script-generator.html', 'js/script-generator.js']
];

describe.each(PAGES)('method tabs of %s', (page) => {
  const html = read(page);
  const list = html.match(/<div class="doc-tabs"[^>]*>/)[0];
  const tabs = [...html.matchAll(/<button\b[^>]*class="doc-tab[^>]*>/g)].map(m => attrs(m[0]));
  const panes = [...html.matchAll(/<div\b[^>]*class="doc-pane[^>]*>/g)].map(m => attrs(m[0]));

  test('the tab list has a role and a name', () => {
    expect(attrs(list)).toMatchObject({ role: 'tablist', 'aria-label': 'Method' });
  });

  test('each tab controls a pane that exists and is named by that tab', () => {
    expect(tabs.length).toBeGreaterThan(1);
    expect(panes.length).toBe(tabs.length);
    tabs.forEach((tab, i) => {
      const key = tab['data-doc-tab'];
      expect(tab).toMatchObject({ role: 'tab', id: `doc-tab-${key}`, 'aria-controls': `doc-pane-${key}` });
      expect(panes[i]).toMatchObject({
        role: 'tabpanel', id: `doc-pane-${key}`, 'data-doc-pane': key, 'aria-labelledby': `doc-tab-${key}`
      });
    });
  });

  test('one tab is selected, and it alone is in the tab order', () => {
    const selected = tabs.filter(t => t['aria-selected'] === 'true');
    expect(selected.length).toBe(1);
    expect(selected[0].class).toMatch(/\bactive\b/);
    expect(selected[0].tabindex).toBeUndefined();
    for (const t of tabs.filter(t => t !== selected[0])) {
      expect(t).toMatchObject({ 'aria-selected': 'false', tabindex: '-1' });
    }
    expect(panes.filter(p => /\bactive\b/.test(p.class)).map(p => p['data-doc-pane'])).toEqual([selected[0]['data-doc-tab']]);
  });

  test('the icon in a tab is hidden from its name', () => {
    for (const m of html.matchAll(/<button\b[^>]*class="doc-tab[^>]*>([\s\S]*?)<\/button>/g)) {
      for (const icon of m[1].matchAll(/<i\b[^>]*>/g)) expect(attrs(icon[0])['aria-hidden']).toBe('true');
    }
  });
});

describe('the handler of the method tabs', () => {
  /* From its comment to the end of the key handler, without indentation. */
  const handler = (file) => {
    const js = read(file);
    const start = js.indexOf('// The method tabs follow the ARIA tabs pattern');
    const end = js.indexOf('selectDocTab(docTabs[to], true);', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return js.slice(start, end).split('\n').map(l => l.trim()).filter(Boolean);
  };

  test('is the same on the three pages, but for the converter\'s fade', () => {
    const [converter, stats, workflow] = PAGES.map(([, js]) => handler(js));
    expect(workflow).toEqual(stats);
    expect(converter.filter(l => !l.includes("'doc-enter'"))).toEqual(stats);
  });

  test('moves with the arrow keys, Home and End, keeps one tab stop, and leaves modified keys alone', () => {
    const text = handler('js/stats-calculator.js').join('\n');
    expect(text).toContain('ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last');
    expect(text).toContain('x.tabIndex = on ? 0 : -1;');
    expect(text).toContain('if (e.altKey || e.ctrlKey || e.metaKey) return;');
    expect(text).toContain("if (pane.querySelector(FOCUSABLE)) pane.removeAttribute('tabindex');");
  });
});

describe('engine tabs of script-generator.html', () => {
  const html = read('script-generator.html');
  const tabs = [...html.matchAll(/<button\b[^>]*data-engine-tab="[^>]*>/g)].map(m => attrs(m[0]));

  test('each engine tab controls a panel named by that tab', () => {
    expect(tabs.map(t => t['data-engine-tab'])).toEqual(['gromacs', 'lammps', 'plumed']);
    for (const tab of tabs) {
      const panel = attrs(html.match(new RegExp(`<div id="${tab['aria-controls']}"[^>]*>`))[0]);
      expect(tab.role).toBe('tab');
      expect(tab.id).toBeTruthy();
      expect(panel).toMatchObject({ role: 'tabpanel', 'aria-labelledby': tab.id });
    }
  });

  test('one engine tab is selected, and it alone is in the tab order', () => {
    expect(tabs.map(t => [t['aria-selected'], t.tabindex])).toEqual([['true', undefined], ['false', '-1'], ['false', '-1']]);
  });

  test('switching engine moves the tab stop, and the arrow keys switch engine', () => {
    const js = read('js/script-generator.js');
    expect(js).toContain('btn.tabIndex = on ? 0 : -1;');
    expect(js).toMatch(/engineTabs\.forEach\(\(btn, i\) => \{[\s\S]*?addEventListener\('keydown'[\s\S]*?switchEngine\(engineTabs\[to\]\.getAttribute\('data-engine-tab'\)\);\s*engineTabs\[to\]\.focus\(\);/);
  });
});
