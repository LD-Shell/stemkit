#!/usr/bin/env node
/**
 * Consistency check for the parts every STEMKit page shares.
 *
 * The header, the theme script and the tool names are copied into each page
 * by hand, because the site has no build step for markup. Copies drift: the
 * header had come apart into nine versions and ten tools went by two names.
 * This script fails when that starts again.
 *
 *   1. every page applies the saved theme in <head>, before any stylesheet
 *   2. every page loads js/site.js and wires no theme or menu script of its own
 *   3. every page has a skip link to #main, and a <main id="main">
 *   4. the header is identical everywhere, apart from two sanctioned variants:
 *      the full-width workspaces (plot builder, plot digitizer) widen the
 *      container, and the kinetic sandbox floats it over its canvas
 *   5. each tool in the js/site.js catalogue has a page whose only <h1> is its
 *      name, a home page card with that name in the right section, and a
 *      link with that name in the tool directory of every page's footer
 *
 * No dependencies.
 *
 *   node tools/check-chrome.mjs
 *
 * Exits non-zero on any problem.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.join(import.meta.dirname ?? '.', '..'));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const text = html => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Scratch pages that are not part of the site.
const SKIP = new Set(['home-sections-preview.html']);
const WIDE = new Set(['plot-builder.html', 'plot-digitizer.html']);
const OVERLAY = new Set(['sandbox.html']);

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html') && !SKIP.has(f)).sort();
const problems = [];
const fail = (page, msg) => problems.push(`${page}: ${msg}`);

// ---- the catalogue ---------------------------------------------------------
const site = read('js/site.js');
const tools = [...site.matchAll(/\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)',\s*cat:\s*'([^']+)'/g)]
  .map(([, id, name, cat]) => ({ id, name, cat }));
if (tools.length < 20) fail('js/site.js', `catalogue parse found only ${tools.length} tools`);
const byId = new Map(tools.map(t => [t.id, t]));
for (const [, from, to] of site.matchAll(/\{\s*id:\s*'([^']+)'[\s\S]*?next:\s*\[([\s\S]*?)\]\s*\}/g)) {
  for (const [, id] of to.matchAll(/\['([^']+)'/g)) {
    if (!byId.has(id)) fail('js/site.js', `${from} lists unknown next step "${id}"`);
  }
}

// ---- per page --------------------------------------------------------------
const navOf = html => (html.match(/<nav\b[\s\S]*?<\/nav>/) || [''])[0];
const normNav = (html, page) => {
  let n = navOf(html).replace(/\s+/g, ' ');
  if (WIDE.has(page)) n = n.replace('max-w-[1600px]', 'max-w-7xl').replace(' flex-shrink-0"', '"');
  return n;
};
const reference = normNav(read('stats-calculator.html'), 'stats-calculator.html');

for (const page of pages) {
  const html = read(page);
  const head = html.slice(0, html.indexOf('</head>'));

  const themeAt = head.indexOf("prefers-color-scheme: dark");
  const cssAt = head.search(/<link rel="stylesheet"/);
  if (themeAt < 0) fail(page, 'no theme script in <head>');
  else if (cssAt >= 0 && themeAt > cssAt) fail(page, 'theme script comes after a stylesheet, so the page can flash');

  if (!/<script src="js\/site\.js"><\/script>/.test(html)) fail(page, 'does not load js/site.js');
  if (/<script>[\s\S]*?querySelectorAll\('\.themeToggle'\)[\s\S]*?<\/script>/.test(html)) fail(page, 'wires its own theme toggle');
  if (/<script>[\s\S]*?getElementById\('mobile-menu-btn'\)[\s\S]*?<\/script>/.test(html)) fail(page, 'wires its own mobile menu');

  if (!html.includes('<a href="#main" class="stk-skip">')) fail(page, 'no skip link to #main');
  if (!/<main id="main"/.test(html)) fail(page, 'no <main id="main">');

  const nav = navOf(html);
  if (!nav) { fail(page, 'no <nav>'); continue; }
  const labels = [...nav.matchAll(/data-stk-cat="[a-z]+">([^<]+)</g)].map(m => m[1]);
  if (labels.join() !== 'Data,Compute,Writing,Focus,Data,Compute,Writing,Focus') fail(page, `header links read ${labels.join(', ')}`);
  if (!OVERLAY.has(page) && normNav(html, page) !== reference) fail(page, 'header differs from stats-calculator.html');

  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(m => text(m[1]));
  const tool = byId.get(page.replace(/\.html$/, ''));
  if (tool && (h1s.length !== 1 || h1s[0] !== tool.name)) fail(page, `<h1> is ${JSON.stringify(h1s)}, catalogue says "${tool.name}"`);

  // Only the full footer lists the tools; the 404 page keeps a short one.
  const footer = (html.match(/<footer\b[\s\S]*?<\/footer>/) || [''])[0];
  if (footer.includes('stk-dir')) {
    for (const t of tools) {
      const m = footer.match(new RegExp(`<a href="${t.id}\\.html"[^>]*>([\\s\\S]*?)</a>`));
      if (!m) fail(page, `footer has no link to ${t.id}.html`);
      else if (text(m[1]) !== t.name) fail(page, `footer calls ${t.id} "${text(m[1])}", catalogue says "${t.name}"`);
    }
  }
}

// ---- home page cards -------------------------------------------------------
const home = read('index.html');
const cards = [...home.matchAll(/<section[^>]*data-category="([a-z]+)"[\s\S]*?<\/section>/g)]
  .flatMap(([sec, cat]) => [...sec.matchAll(/<a href="([a-z0-9-]+)\.html"[^>]*class="[^"]*tool-card[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/g)]
    .map(([, id, h3]) => ({ id, cat, name: text(h3) })));
for (const t of tools) {
  const c = cards.find(c => c.id === t.id);
  if (!c) fail('index.html', `no card for ${t.id}`);
  else {
    if (c.name !== t.name) fail('index.html', `card calls ${t.id} "${c.name}", catalogue says "${t.name}"`);
    if (c.cat !== t.cat) fail('index.html', `${t.id} card sits in "${c.cat}", catalogue says "${t.cat}"`);
  }
}
for (const c of cards) if (!byId.has(c.id)) fail('index.html', `card for ${c.id} has no catalogue entry`);

if (problems.length) {
  console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const p of problems) console.log('  ' + p);
} else {
  console.log(`\n${pages.length} pages, ${tools.length} tools: header, theme, names and cards agree.`);
}
process.exit(problems.length ? 1 : 0);
