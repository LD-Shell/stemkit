#!/usr/bin/env node
/**
 * Regenerate sitemap.xml from the pages that actually exist.
 *
 * A hand-maintained sitemap goes stale quietly: a page is added and never
 * listed, or every `lastmod` keeps claiming a date months after the file
 * changed. Generating it means the list and the dates follow the repository.
 *
 * Pages are excluded when they are not user-facing: the 404 page, and the
 * development previews that robots.txt already disallows. The two lists are
 * kept in step by reading the disallow rules out of robots.txt rather than
 * repeating them here.
 *
 *   node tools/build-sitemap.mjs           write sitemap.xml
 *   node tools/build-sitemap.mjs --check   fail if it is out of date
 *
 * `--check` is for CI: it regenerates in memory and compares, so a pull
 * request that adds a page without updating the sitemap is caught.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.join(import.meta.dirname ?? '.', '..'));
const ORIGIN = 'https://stemkit.net';
const OUT = path.join(ROOT, 'sitemap.xml');
const CHECK = process.argv.includes('--check');

/** Pages that are never indexed, whatever else is true of them. */
const ALWAYS_SKIP = new Set(['404.html']);

/**
 * Read the disallowed paths out of robots.txt.
 *
 * Listing a page in the sitemap while robots.txt disallows it is a
 * contradiction crawlers report, so the exclusions are taken from there.
 */
function disallowedPages() {
  const robots = path.join(ROOT, 'robots.txt');
  if (!fs.existsSync(robots)) return new Set();
  const out = new Set();
  for (const line of fs.readFileSync(robots, 'utf8').split('\n')) {
    const m = /^\s*Disallow:\s*\/(\S+)/i.exec(line);
    if (m && m[1].endsWith('.html')) out.add(m[1]);
  }
  return out;
}

/**
 * How often a page is likely to change, and how much it matters.
 *
 * The home page is the entry point and changes whenever a tool is added. Tool
 * pages change when their tool does. Policy pages rarely change and are not
 * what anyone is searching for.
 */
function weightFor(file) {
  if (file === 'index.html') return { changefreq: 'weekly', priority: '1.0' };
  if (file === 'privacy.html') return { changefreq: 'yearly', priority: '0.3' };
  return { changefreq: 'monthly', priority: '0.8' };
}

/** Last modification date of a page, as YYYY-MM-DD. */
function lastmod(file) {
  return fs.statSync(path.join(ROOT, file)).mtime.toISOString().slice(0, 10);
}

const skip = new Set([...ALWAYS_SKIP, ...disallowedPages()]);

const pages = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.html'))
  .filter(f => !skip.has(f))
  .sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));

const entries = pages.map(file => {
  const loc = file === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${file}`;
  const { changefreq, priority } = weightFor(file);
  return `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod(file)}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
});

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`;

if (CHECK) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  // Dates move whenever a file is touched, so only the set of URLs is
  // compared; a stale date is not worth failing a build over, a missing page
  // is.
  const urlsOf = t => [...t.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]).sort().join('\n');
  if (urlsOf(current) !== urlsOf(xml)) {
    console.error('sitemap.xml is out of date. Run: npm run build:sitemap');
    const now = new Set(urlsOf(xml).split('\n'));
    const was = new Set(urlsOf(current).split('\n'));
    for (const u of [...now].filter(u => !was.has(u))) console.error('  missing:', u);
    for (const u of [...was].filter(u => !now.has(u))) console.error('  stale  :', u);
    process.exit(1);
  }
  console.log(`sitemap.xml is current (${pages.length} pages).`);
} else {
  fs.writeFileSync(OUT, xml);
  console.log(`sitemap.xml written with ${pages.length} pages.`);
  console.log(`excluded: ${[...skip].sort().join(', ')}`);
}
