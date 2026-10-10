#!/usr/bin/env node
/**
 * Regenerate sitemap.xml from the pages that actually exist.
 *
 * A hand-maintained sitemap goes stale quietly: a page is added and never
 * listed, or every `lastmod` keeps claiming a date months after the file
 * changed. Generating it means the list and the dates follow the repository.
 *
 * Pages are excluded when they are not user-facing: the 404 page, and any
 * page robots.txt disallows. The two lists are kept in step by reading the
 * disallow rules out of robots.txt rather than repeating them here.
 *
 * A page's `lastmod` is the date of the last commit that touched it, so a
 * fresh clone writes the same dates as the checkout it was cloned from (a
 * file's modification time is the day it was checked out). A page with
 * changes not yet committed, and any page outside a git checkout, takes its
 * modification time instead: the first is about to be committed, the second
 * has nothing else to go by.
 *
 *   node tools/build-sitemap.mjs               write sitemap.xml
 *   node tools/build-sitemap.mjs --out FILE    write FILE instead
 *   node tools/build-sitemap.mjs --check       fail if it is out of date
 *
 * `--check` is for CI: it regenerates in memory and compares, so a pull
 * request that adds a page without updating the sitemap is caught, and so is
 * a page committed since the date the sitemap gives for it. A date later
 * than the last commit passes. The dates need the history: in a shallow
 * clone (actions/checkout without fetch-depth: 0) every file appears to
 * have changed in the one commit there is, so `--check` compares the list of
 * pages only and says so, and writing the sitemap is refused.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.join(import.meta.dirname ?? '.', '..'));
const ORIGIN = 'https://stemkit.net';
const SITEMAP = path.join(ROOT, 'sitemap.xml');
const CHECK = process.argv.includes('--check');
const outAt = process.argv.indexOf('--out');
if (outAt >= 0 && !process.argv[outAt + 1]) {
  console.error('--out needs a file name.');
  process.exit(2);
}
const OUT = outAt >= 0 ? path.resolve(process.argv[outAt + 1]) : SITEMAP;

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

/** Run git in the site's directory; its output, or null when it fails. */
function git(...args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * What git can say about the pages: 'full' with the history at hand,
 * 'shallow' in a clone cut short (no dates to be had), 'none' when the site
 * is not in a git checkout or git is not installed.
 */
const HISTORY = git('rev-parse', '--is-inside-work-tree') !== 'true' ? 'none'
  : git('rev-parse', '--is-shallow-repository') === 'true' ? 'shallow' : 'full';

/** Date of the last commit that touched a page, as YYYY-MM-DD; null if none did. */
function commitDate(file) {
  if (HISTORY !== 'full') return null;
  const date = git('log', '-1', '--format=%cs', '--', file);
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/**
 * A file's modification date, as YYYY-MM-DD in local time: the day a commit
 * made now would carry, which a UTC date is not for part of each day.
 */
function modifiedDate(file) {
  const t = fs.statSync(path.join(ROOT, file)).mtime;
  const two = n => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}`;
}

/** The date a page last changed (see the top of the file), as YYYY-MM-DD. */
function lastmod(file) {
  if (HISTORY !== 'full') return modifiedDate(file);
  const uncommitted = git('status', '--porcelain', '--', file);
  return (uncommitted ? null : commitDate(file)) ?? modifiedDate(file);
}

const skip = new Set([...ALWAYS_SKIP, ...disallowedPages()]);

const pages = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.html'))
  .filter(f => !skip.has(f))
  .sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));

const locOf = file => (file === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${file}`);

const entries = pages.map(file => {
  const { changefreq, priority } = weightFor(file);
  return `  <url>
    <loc>${locOf(file)}</loc>
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
  const current = fs.existsSync(SITEMAP) ? fs.readFileSync(SITEMAP, 'utf8') : '';
  const urlsOf = t => [...t.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]).sort().join('\n');
  if (urlsOf(current) !== urlsOf(xml)) {
    console.error('sitemap.xml is out of date. Run: npm run build:sitemap');
    const now = new Set(urlsOf(xml).split('\n'));
    const was = new Set(urlsOf(current).split('\n'));
    for (const u of [...now].filter(u => !was.has(u))) console.error('  missing:', u);
    for (const u of [...was].filter(u => !now.has(u))) console.error('  stale  :', u);
    process.exit(1);
  }
  // A date may run ahead of the last commit (a page edited and not yet
  // committed), but never behind it: that is the sitemap telling a crawler
  // a page has not changed when it has.
  const dated = new Map([...current.matchAll(/<loc>([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g)].map(m => [m[1], m[2]]));
  const behind = pages
    .map(file => ({ loc: locOf(file), given: dated.get(locOf(file)), committed: commitDate(file) }))
    .filter(p => p.committed && (!p.given || p.given < p.committed));
  if (behind.length) {
    console.error('sitemap.xml gives dates older than the last commit of these pages. Run: npm run build:sitemap');
    for (const p of behind) console.error(`  ${p.loc}: sitemap says ${p.given || 'nothing'}, last commit ${p.committed}`);
    process.exit(1);
  }
  const dates = HISTORY === 'full' ? 'no date is older than its page\'s last commit'
    : HISTORY === 'shallow' ? 'dates not checked: this is a shallow clone, with no history to check them against'
      : 'dates not checked: not a git checkout';
  console.log(`sitemap.xml is current (${pages.length} pages; ${dates}).`);
} else {
  if (HISTORY === 'shallow') {
    console.error('This is a shallow clone, so git cannot say when each page last changed. Run: git fetch --unshallow, then build again.');
    process.exit(1);
  }
  fs.writeFileSync(OUT, xml);
  console.log(`${path.relative(ROOT, OUT) || OUT} written with ${pages.length} pages.`);
  console.log(`dates: ${HISTORY === 'full' ? 'each page\'s last commit, or its modification time if it has changes not yet committed' : 'modification times (not a git checkout)'}`);
  console.log(`excluded: ${[...skip].sort().join(', ')}`);
}
