import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The how-to guide of the MD Workflow Generator has a tab for each engine and
 * one for the cluster card, each with its own video and steps. The tabs follow
 * the ARIA tabs pattern like the method tabs, and every video a pane names has
 * an entry and a thumbnail. What the keys do is checked in a browser.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));

const html = read('script-generator.html');
const guide = html.slice(html.indexOf('id="how-to-use"'), html.indexOf('id="how-it-works"'));
const tabs = [...guide.matchAll(/<button\b[^>]*class="how-tab[^>]*>/g)].map(m => attrs(m[0]));
const panes = [...guide.matchAll(/<div\b[^>]*class="how-pane[^>]*>/g)].map(m => attrs(m[0]));

describe('how-to guide tabs of script-generator.html', () => {
  test('the tab list has a role and a name, and the label above it is where the page head links to', () => {
    expect(attrs(guide.match(/<div class="how-tabs"[^>]*>/)[0])).toMatchObject({
      role: 'tablist', 'aria-label': 'How to use, by engine'
    });
    expect(guide).toMatch(/<p class="how-tabs-label" id="tutorial">[^<]*<i [^>]*aria-hidden="true"><\/i>[^<]*<\/p>\s*<div class="how-tabs"/);
    expect(html).toContain('<a href="#tutorial">');
  });

  test('a tab for each engine and for the cluster card, each controlling its pane', () => {
    expect(tabs.map(t => t['data-how-tab'])).toEqual(['gromacs', 'lammps', 'plumed', 'cluster']);
    expect(panes.length).toBe(tabs.length);
    tabs.forEach((tab, i) => {
      const key = tab['data-how-tab'];
      expect(tab).toMatchObject({ role: 'tab', id: `how-tab-${key}`, 'aria-controls': `how-pane-${key}` });
      expect(panes[i]).toMatchObject({
        role: 'tabpanel', id: `how-pane-${key}`, 'data-how-pane': key, 'aria-labelledby': `how-tab-${key}`
      });
    });
  });

  test('one tab is selected, it alone is in the tab order, and its pane is the open one', () => {
    const on = tabs.filter(t => t['aria-selected'] === 'true');
    expect(on.length).toBe(1);
    expect(on[0]['data-how-tab']).toBe('gromacs');
    expect(on[0].tabindex).toBeUndefined();
    for (const t of tabs.filter(t => t !== on[0])) expect(t).toMatchObject({ 'aria-selected': 'false', tabindex: '-1' });
    expect(panes.filter(p => /\bactive\b/.test(p.class)).map(p => p['data-how-pane'])).toEqual(['gromacs']);
  });

  test('the icon in a tab is hidden from its name', () => {
    for (const m of guide.matchAll(/<button\b[^>]*class="how-tab[^>]*>([\s\S]*?)<\/button>/g)) {
      for (const icon of m[1].matchAll(/<i\b[^>]*>/g)) expect(attrs(icon[0])['aria-hidden']).toBe('true');
    }
  });

  test('the guide follows the engine tab in use, and the arrow keys move between tabs', () => {
    const js = read('js/script-generator.js');
    expect(js).toContain('syncHowTab(engine);');
    expect(js).toContain('syncHowTab(currentEngine);');
    expect(js).toMatch(/howTabs\.forEach\(\(tab, i\) => \{[\s\S]*?ArrowRight[\s\S]*?selectHowTab\(howTabs\[to\], true\);/);
  });
});

describe('the videos of the guide', () => {
  const videos = read('js/tutorial-video.js');
  const mounts = [...guide.matchAll(/<section\b[^>]*data-tutorial="([^"]+)"/g)].map(m => m[1]);

  test('each pane carries its own video, and none stays in the method section', () => {
    expect(mounts).toEqual(['script-generator-gromacs', 'script-generator-lammps', 'script-generator-plumed', 'script-generator']);
    const rest = html.replace(guide, '');
    expect(rest).not.toMatch(/data-tutorial="script-generator/);
  });

  test('each video has an entry and a thumbnail', () => {
    for (const slug of mounts) {
      expect(videos).toContain(`'${slug}':`);
      expect(fs.existsSync(path.join(ROOT, 'assets', 'tutorials', `${slug}.webp`))).toBe(true);
    }
  });
});

describe('the FAQ of script-generator.html', () => {
  test('is grouped by engine, with every question under a heading', () => {
    const faq = html.slice(html.indexOf('id="faq"'));
    const heads = [...faq.matchAll(/<h3 class="stk-faq-group">([^<]+)<\/h3>/g)].map(m => m[1]);
    expect(heads).toEqual(['GROMACS', 'LAMMPS', 'PLUMED', 'Schedulers and job scripts', 'This page']);
    expect(faq.indexOf('<details class="stk-faq">')).toBeGreaterThan(faq.indexOf('stk-faq-group'));
  });
});
