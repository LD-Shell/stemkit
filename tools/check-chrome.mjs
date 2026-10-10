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
 *   6. every footer's .mdp credit ends "; version = vX.Y.Z (date)", with the
 *      version from package.json and the date from src/core/version.js, linked
 *      to the changelog, its "=" in line with the others; and the footer's
 *      links include the changelog. A release that bumps package.json but not
 *      the pages fails here.
 *   7. every page carries the Content-Security-Policy that tools/build-csp.mjs
 *      writes, before any script or stylesheet, with the hash of each inline
 *      script it runs (after editing one: npm run build:csp)
 *   8. every page at the root is a tool in the catalogue or is listed in
 *      NOT_TOOLS below, so a page copied from another and never finished is
 *      not passed over because nothing knows of it
 *   9. each tool page's <head> is its own: the <title> names the tool, the
 *      JSON-LD WebApplication is called "STEMKit <name>", the canonical,
 *      og:url, twitter:url and JSON-LD addresses are the page's own, and no
 *      two pages share a <title> or a meta description. A copied page fails
 *      here until its head is rewritten.
 *
 * No dependencies beyond tools/build-csp.mjs.
 *
 *   node tools/check-chrome.mjs
 *
 * Exits non-zero on any problem.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cspProblems } from './build-csp.mjs';

// From the tool's own place, read off its URL: import.meta.dirname is newer than Node 18.
const ROOT = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const text = html => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const WIDE = new Set(['plot-builder.html', 'plot-digitizer.html']);
const OVERLAY = new Set(['sandbox.html']);
const ORIGIN = 'https://stemkit.net';

/**
 * The pages that are not tools, and what each is. Every other page at the
 * root must be a tool in the js/site.js catalogue; a new page that is
 * neither goes here, with its reason.
 */
const NOT_TOOLS = new Map([
  ['index.html', 'the home page: the cards that lead to the tools'],
  ['privacy.html', 'the privacy policy and the terms of use'],
  ['404.html', 'what the host serves for an address that does not exist'],
]);

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();
const problems = [];
const fail = (page, msg) => problems.push(`${page}: ${msg}`);

// ---- the release -----------------------------------------------------------
const CHANGELOG = 'https://github.com/LD-Shell/stemkit/blob/main/CHANGELOG.md';
const VERSION = JSON.parse(read('package.json')).version;
const versionJs = read('src/core/version.js');
const coreVersion = (versionJs.match(/STEMKIT_VERSION = '([^']*)'/) || [])[1];
const RELEASE_DATE = (versionJs.match(/RELEASE_DATE = '([^']*)'/) || [])[1];
if (coreVersion !== VERSION) fail('src/core/version.js', `STEMKIT_VERSION is ${coreVersion}, package.json says ${VERSION}`);

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

for (const t of tools) if (!pages.includes(`${t.id}.html`)) fail('js/site.js', `catalogue lists ${t.id}, but there is no ${t.id}.html`);
for (const page of NOT_TOOLS.keys()) {
  if (!pages.includes(page)) fail('tools/check-chrome.mjs', `NOT_TOOLS lists ${page}, which does not exist`);
  if (byId.has(page.replace(/\.html$/, ''))) fail('tools/check-chrome.mjs', `NOT_TOOLS lists ${page}, which is a tool in the catalogue`);
}

// ---- the <head> of a page ---------------------------------------------------
const attr = (head, re) => { const m = head.match(re); return m ? text(m[1]) : null; };
const wordsOf = s => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/**
 * Whether a title names a tool: the words of the name, in order, give or
 * take a plural and with other words between them ("Visual LaTeX Table
 * Generator" names Visual LaTeX Tables, "XVG & CSV Visualizer" XVG Visualizer).
 */
function namesTool(title, name) {
  const have = wordsOf(title);
  let from = 0;
  for (const w of wordsOf(name)) {
    const at = have.findIndex((h, i) => i >= from && (h === w || `${h}s` === w || h === `${w}s`));
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}
/** The JSON-LD blocks of a page, parsed; one that is not JSON is a problem. */
function jsonLd(page, html) {
  const out = [];
  for (const [, body] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { out.push(JSON.parse(body)); } catch (e) { fail(page, `a JSON-LD block is not valid JSON (${e.message})`); }
  }
  return out;
}
const titles = new Map();        // <title> -> the pages that have it
const descriptions = new Map();  // meta description -> the pages that have it
const note = (map, key, page) => map.set(key, [...(map.get(key) || []), page]);

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
  if (!tool && !NOT_TOOLS.has(page)) {
    fail(page, 'is neither a tool in the js/site.js catalogue nor listed in NOT_TOOLS (tools/check-chrome.mjs): add the tool to the catalogue, or the page to that list with what it is');
  }

  // Whose head this is. A page copied from another keeps that page's title,
  // description and addresses until someone rewrites them.
  const title = attr(head, /<title>([\s\S]*?)<\/title>/);
  const description = attr(head, /<meta name="description" content="([^"]*)"/);
  if (!title) fail(page, 'no <title>');
  else note(titles, title, page);
  if (!description) fail(page, 'no meta description');
  else note(descriptions, description, page);
  const blocks = jsonLd(page, html);
  if (tool) {
    const own = `${ORIGIN}/${page}`;
    if (title && !namesTool(title, tool.name)) fail(page, `<title> is "${title}", which does not name "${tool.name}"`);
    const apps = blocks.filter(b => b && b['@type'] === 'WebApplication');
    if (apps.length !== 1) fail(page, `has ${apps.length} JSON-LD WebApplication blocks, not one`);
    for (const app of apps) {
      if (app.name !== `STEMKit ${tool.name}`) fail(page, `JSON-LD WebApplication is named "${app.name}", catalogue says "STEMKit ${tool.name}"`);
      if (app.url !== own) fail(page, `JSON-LD WebApplication url is ${app.url}, not ${own}`);
    }
    for (const [what, re] of [
      ['canonical link', /<link rel="canonical" href="([^"]*)"/],
      ['og:url', /<meta property="og:url" content="([^"]*)"/],
      ['twitter:url', /<meta name="twitter:url" content="([^"]*)"/],
    ]) {
      const url = attr(head, re);
      if (url !== own) fail(page, `${what} is ${url ?? 'missing'}, not ${own}`);
    }
  }

  for (const p of cspProblems(page, html)) fail(page, p);

  // Only the full footer lists the tools; the 404 page keeps a short one.
  const footer = (html.match(/<footer\b[\s\S]*?<\/footer>/) || [''])[0];
  if (footer) {
    const credit = (footer.match(/<pre class="stk-mdp-credit">([\s\S]*?)<\/pre>/) || [])[1];
    const v = credit && credit.match(/stk-mdp-credit-k">version +<\/span><span class="stk-mdp-credit-c">= <\/span><a href="([^"]*)"[^>]*>v([^<]*)<\/a> \(([^)]*)\)$/);
    if (!credit) fail(page, 'footer has no .mdp credit');
    else if (!v) fail(page, 'footer credit does not end with "; version = vX.Y.Z (date)"');
    else {
      if (v[2] !== VERSION) fail(page, `footer says v${v[2]}, package.json says ${VERSION}`);
      if (v[3] !== RELEASE_DATE) fail(page, `footer dates v${v[2]} ${v[3]}, src/core/version.js says ${RELEASE_DATE}`);
      if (v[1] !== CHANGELOG) fail(page, `footer version links to ${v[1]}, not the changelog`);
      const keys = [...credit.matchAll(/stk-mdp-credit-k">([^<]*)</g)].map(m => m[1].length);
      if (new Set(keys).size > 1) fail(page, 'footer credit keys differ in width, so the "=" signs do not line up');
    }
    if (!footer.includes(`<a href="${CHANGELOG}" target="_blank" rel="noopener" class="hover:text-brand-500 transition-colors">Changelog</a>`)) fail(page, 'footer links do not include the changelog');
  }
  if (footer.includes('stk-dir')) {
    for (const t of tools) {
      const m = footer.match(new RegExp(`<a href="${t.id}\\.html"[^>]*>([\\s\\S]*?)</a>`));
      if (!m) fail(page, `footer has no link to ${t.id}.html`);
      else if (text(m[1]) !== t.name) fail(page, `footer calls ${t.id} "${text(m[1])}", catalogue says "${t.name}"`);
    }
  }
}

// A title or a description two pages share belongs to one of them at most.
for (const [what, map] of [['<title>', titles], ['meta description', descriptions]]) {
  for (const [value, sharing] of map) {
    if (sharing.length > 1) fail(sharing[0], `has the same ${what} as ${sharing.slice(1).join(', ')}: "${value}"`);
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
  console.log(`\n${pages.length} pages, ${tools.length} tools: header, theme, names, heads, cards, footer v${VERSION} and CSP agree.`);
}
process.exit(problems.length ? 1 : 0);
