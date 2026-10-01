#!/usr/bin/env node
/**
 * The Content-Security-Policy of every page, written into its <head>.
 *
 * The privacy page promises that nothing loads from another host, and that
 * the only requests to one are DOI to BibTeX asking doi.org (which passes the
 * lookup to the agency that registered the DOI) and the Structure Inspector
 * fetching a PDB entry from RCSB. Each page carries a
 * <meta http-equiv="Content-Security-Policy"> right after its viewport tag, so
 * the browser enforces that promise rather than taking it on trust.
 *
 * Inline scripts run by hash, not by 'unsafe-inline': a page that shows text
 * from elsewhere (BibTeX from doi.org, a file the user opens) cannot then run
 * a script slipped into it. The cost is that editing an inline <script> (the
 * theme script in every <head>, the home page search, the 404 page's
 * suggestions, the MD Workflow Generator's doc tabs) changes its hash, and
 * the browser refuses the edited script until the tag is rewritten:
 *
 *   node tools/build-csp.mjs           rewrite the tag in every page
 *   node tools/build-csp.mjs --check   fail if any page's tag is out of date
 *
 * `npm run check:chrome` runs the same check, so CI catches a stale tag.
 * Styles stay 'unsafe-inline': KaTeX, Plotly and MathLive write style
 * attributes and <style> elements as they render.
 *
 * No dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

/**
 * The hosts DOI content negotiation sends a BibTeX request on to, by
 * registration agency, as doi.org answered on 2026-10-01. Agencies whose
 * answer a browser cannot read are left out: JaLC (japanlinkcenter.org) has
 * no BibTeX and sends no CORS header; Airiti, ISTIC and CNKI redirect to
 * plain-HTTP or landing pages. A DOI from those fails with or without them.
 */
export const DOI_HOSTS = [
  'https://doi.org',
  'https://api.crossref.org',            // Crossref
  'https://data.crosscite.org',          // DataCite
  'https://data.medra.org',              // mEDRA
  'https://ra.publications.europa.eu',   // Publications Office of the EU
  'https://data.doi.or.kr'               // KISTI
];

/** What every page gets. Inline-script hashes are added to script-src. */
const BASE = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  // data: for Plotly's heatmaps, KaTeX and CSS icons; blob: for Plotly's
  // PNG export, which draws its SVG through an <img> from a blob: URL.
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"]
};

/** What a page needs beyond BASE, and why. Values are appended. */
const EXTRA = {
  // The DOI lookups, and the agencies doi.org hands them to.
  'doi-fetcher.html': { 'connect-src': DOI_HOSTS },
  // PDB entries from RCSB; 3Dmol.js computes surfaces in Web Workers it
  // starts from blob: URLs.
  'structure-inspector.html': {
    'connect-src': ['https://files.rcsb.org'],
    'worker-src': ["'self'", 'blob:']
  }
};

const ORDER = [
  'default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src',
  'media-src', 'worker-src', 'object-src', 'base-uri', 'form-action'
];

export const CSP_META = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/;

/** The inline scripts a page runs (JSON-LD is data, not script). */
export function inlineScripts(html) {
  return [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs = '']) => !/\bsrc=/.test(attrs) && !/type="application\/ld\+json"/.test(attrs))
    .map(m => m[2]);
}

const hashOf = text => `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** The policy a page should carry, as the meta tag's content. */
export function policyFor(page, html) {
  const d = Object.fromEntries(Object.entries(BASE).map(([k, v]) => [k, [...v]]));
  for (const [k, v] of Object.entries(EXTRA[page] || {})) d[k] = [...(d[k] || []), ...v];
  d['script-src'].push(...new Set(inlineScripts(html).map(hashOf)));
  return ORDER.filter(k => d[k]).map(k => `${k} ${d[k].join(' ')}`).join('; ');
}

/** Problems with a page's tag: missing, too late in <head>, or stale. */
export function cspProblems(page, html) {
  const head = html.slice(0, html.indexOf('</head>'));
  const m = CSP_META.exec(head);
  if (!m) return ['no Content-Security-Policy <meta> in <head> (run npm run build:csp)'];
  const out = [];
  const first = head.search(/<script\b|<link rel="stylesheet"/);
  if (first >= 0 && first < m.index) out.push('the Content-Security-Policy <meta> comes after a script or stylesheet');
  const want = policyFor(page, html);
  if (m[1] !== want) {
    const have = new Set(m[1].split(/[\s;]+/));
    const missing = want.split(/[\s;]+/).filter(t => t.startsWith("'sha256-") && !have.has(t));
    out.push(missing.length
      ? `an inline script changed, so the browser would refuse it: Content-Security-Policy lacks ${missing.join(' ')} (run npm run build:csp)`
      : 'Content-Security-Policy differs from tools/build-csp.mjs (run npm run build:csp)');
  }
  return out;
}

/** The page with its tag written or rewritten, just after the viewport tag. */
export function withPolicy(page, html) {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policyFor(page, html)}">`;
  if (CSP_META.test(html)) return html.replace(CSP_META, tag);
  const vp = /^([ \t]*)<meta name="viewport"[^>]*>\n/m.exec(html);
  if (!vp) throw new Error(`${page}: no viewport <meta> to place the policy after`);
  const at = vp.index + vp[0].length;
  return html.slice(0, at) + `${vp[1]}${tag}\n` + html.slice(at);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();
  const problems = [];
  let written = 0;
  for (const page of pages) {
    const file = path.join(ROOT, page);
    const html = fs.readFileSync(file, 'utf8');
    if (check) {
      for (const p of cspProblems(page, html)) problems.push(`${page}: ${p}`);
      continue;
    }
    const next = withPolicy(page, html);
    if (next !== html) { fs.writeFileSync(file, next); written++; }
  }
  if (check) {
    for (const p of problems) console.log('  ' + p);
    console.log(problems.length ? `\n${problems.length} problem(s).` : `${pages.length} pages: Content-Security-Policy current.`);
    process.exit(problems.length ? 1 : 0);
  }
  console.log(`${written} of ${pages.length} pages written.`);
}
