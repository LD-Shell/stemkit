#!/usr/bin/env node
/**
 * Link checker for the STEMKit site.
 *
 * Checks three things across every .html file in the project root:
 *
 *   1. internal file targets  , href="plot-builder.html"
 *   2. same-page anchors      , href="#references"
 *   3. cross-page fragments   , href="units.html#faq"
 *   4. external URLs          , href="https://..."  (unless --internal-only)
 *
 * No dependencies; Node 18+ for global fetch.
 *
 *   node tools/check-links.mjs                 check everything
 *   node tools/check-links.mjs --internal-only skip the network
 *   node tools/check-links.mjs --json          machine-readable output
 *
 * Exits non-zero when something is broken, so it can gate a release.
 *
 * External checks try HEAD first and fall back to GET, because a fair number
 * of documentation hosts answer HEAD with 403 or 405 while serving the page
 * perfectly well. Redirects are followed and reported, since a 301 today is
 * often a 404 next year.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.join(import.meta.dirname ?? '.', '..'));
const args = new Set(process.argv.slice(2));
const INTERNAL_ONLY = args.has('--internal-only');
const AS_JSON = args.has('--json');

const CONCURRENCY = 6;
const TIMEOUT_MS = 20000;
const RETRIES = 1;

// Hosts that are part of the page furniture rather than references.
const IGNORE_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
if (!pages.length) {
  console.error(`No .html files found in ${ROOT}`);
  process.exit(2);
}

/**
 * Metadata and prose files that also carry URLs.
 *
 * Scanning only the pages misses the ones a reviewer is most likely to click:
 * the repository, issue tracker and homepage recorded in package.json, the
 * citation metadata, and the install instructions in the README. These are
 * plain-text scanned rather than parsed, so a URL is found wherever it sits.
 */
const META_FILES = ['package.json', '.zenodo.json', 'CITATION.cff', 'README.md', 'LICENSE']
  .filter(f => fs.existsSync(path.join(ROOT, f)));

/**
 * Markup with script and style bodies removed.
 *
 * Inline scripts build URLs by concatenation (`'/' + t.f + '/'`) and a naive
 * href scan reports those fragments as broken links. Ids are read from the
 * stripped markup too, so an id assigned in JavaScript is not mistaken for one
 * present in the document.
 */
function markupOnly(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

const sourceOf = new Map(
  pages.map(p => [p, markupOnly(fs.readFileSync(path.join(ROOT, p), 'utf8'))])
);

/** id attributes present on each page, for anchor checking. */
const idsByPage = new Map();
for (const p of pages) {
  idsByPage.set(p, new Set([...sourceOf.get(p).matchAll(/\bid="([^"]+)"/g)].map(m => m[1])));
}

/** Every href, with the pages it appears on. */
const links = new Map();
for (const p of pages) {
  const html = sourceOf.get(p);
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1];
    if (!links.has(href)) links.set(href, new Set());
    links.get(href).add(p);
  }
}

const problems = [];
const external = [];

for (const f of META_FILES) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of text.matchAll(/https?:\/\/[^\s"'`<>)\]},]+/g)) {
    // A trailing dot or comma is nearly always sentence punctuation, and
    // package.json repository URLs keep their .git suffix.
    const href = m[0].replace(/[.,;]+$/, '');
    if (!links.has(href)) links.set(href, new Set());
    links.get(href).add(f);
  }
}

for (const [href, sources] of links) {
  const from = [...sources].sort();

  if (/^(mailto:|tel:|data:|javascript:)/i.test(href)) continue;

  if (/^https?:\/\//i.test(href)) {
    let host;
    try { host = new URL(href).host; } catch {
      problems.push({ href, from, kind: 'malformed URL' });
      continue;
    }
    if (!IGNORE_HOSTS.has(host)) external.push({ href, from });
    continue;
  }

  // Same-page anchor.
  if (href.startsWith('#')) {
    const id = href.slice(1);
    if (!id) continue;
    for (const p of from) {
      if (!idsByPage.get(p).has(id)) {
        problems.push({ href, from: [p], kind: 'anchor not on page' });
      }
    }
    continue;
  }

  // Root-absolute paths resolve against the deployed site, not the checkout.
  const [rawPath, fragment] = href.split('#');
  if (!rawPath) continue;
  const rel = rawPath.replace(/^\//, '').split('?')[0];
  const target = path.join(ROOT, rel);

  if (!fs.existsSync(target)) {
    problems.push({ href, from, kind: 'file missing' });
    continue;
  }
  if (fragment && idsByPage.has(rel) && !idsByPage.get(rel).has(fragment)) {
    problems.push({ href, from, kind: 'anchor not in target file' });
  }
}

async function probe(url) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    for (const method of ['HEAD', 'GET']) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method,
          redirect: 'follow',
          signal: ac.signal,
          headers: { 'User-Agent': 'stemkit-link-check/1.0' }
        });
        clearTimeout(timer);
        // Some hosts refuse HEAD but serve GET; only give up after both.
        if (res.status === 403 || res.status === 405) {
          if (method === 'HEAD') continue;
        }
        return { status: res.status, finalUrl: res.url };
      } catch (err) {
        clearTimeout(timer);
        if (method === 'GET' && attempt === RETRIES) {
          return { status: 0, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
        }
      }
    }
  }
  return { status: 0, error: 'unreachable' };
}

const redirects = [];

if (!INTERNAL_ONLY && external.length) {
  if (!AS_JSON) console.error(`Checking ${external.length} external links…`);
  let index = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, external.length) }, async () => {
    while (index < external.length) {
      const item = external[index++];
      const r = await probe(item.href);
      if (r.status === 0) {
        problems.push({ ...item, kind: `unreachable (${r.error})` });
      } else if (r.status >= 400) {
        problems.push({ ...item, kind: `HTTP ${r.status}` });
      } else if (r.finalUrl && r.finalUrl.replace(/\/$/, '') !== item.href.replace(/\/$/, '')) {
        redirects.push({ ...item, to: r.finalUrl });
      }
    }
  });
  await Promise.all(workers);
}

if (AS_JSON) {
  console.log(JSON.stringify({ problems, redirects, checked: { pages: pages.length, links: links.size, external: external.length } }, null, 2));
} else {
  console.log(`\npages ${pages.length} · metadata files ${META_FILES.length} · distinct links ${links.size} · external ${external.length}`);

  if (redirects.length) {
    console.log(`\nRedirected (${redirects.length}), still working, but the target moved:`);
    for (const r of redirects.sort((a, b) => a.href.localeCompare(b.href))) {
      console.log(`  ${r.href}\n    -> ${r.to}\n    on ${r.from.join(', ')}`);
    }
  }

  if (problems.length) {
    console.log(`\nBroken (${problems.length}):`);
    for (const p of problems.sort((a, b) => a.kind.localeCompare(b.kind))) {
      console.log(`  [${p.kind}] ${p.href}\n    on ${p.from.join(', ')}`);
    }
  } else {
    console.log('\nNo broken links.');
  }
}

process.exit(problems.length ? 1 : 0);
