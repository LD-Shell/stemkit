/**
 * The maintenance scripts that look after the pages: tools/build-sitemap.mjs
 * (where a page's date comes from, and what --check refuses) and
 * tools/check-chrome.mjs (a page nobody listed, and a head copied from
 * another page). Each script finds the site from its own location, so it is
 * copied into a scratch site and run there; the sitemap tests make that site
 * a git repository with commits on known dates, and are skipped without git.
 */

import { describe, test, expect, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const made = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-site-tools-'));
  made.push(dir);
  return dir;
};
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

const write = (dir, file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const copyIn = (dir, file) => write(dir, file, fs.readFileSync(path.join(ROOT, file)));
const run = (dir, tool, args = [], env = {}) => {
  // The ceiling stops git from finding a repository above the scratch site.
  const r = spawnSync(process.execPath, [path.join(dir, 'tools', tool), ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir), ...env }
  });
  return { status: r.status, out: r.stdout + r.stderr };
};

/* ------------------------------------------------------------------ *
 * tools/build-sitemap.mjs
 * ------------------------------------------------------------------ */

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const withGit = hasGit ? test : test.skip;

function git(dir, args, date) {
  const stamp = date ? { GIT_AUTHOR_DATE: `${date}T12:00:00+0000`, GIT_COMMITTER_DATE: `${date}T12:00:00+0000` } : {};
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd: dir, encoding: 'utf8',
    env: {
      ...process.env, ...stamp, GIT_CEILING_DIRECTORIES: path.dirname(dir),
      GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.org', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.org'
    }
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const commitAll = (dir, date, message) => { git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', message], date); };

/* A site of three pages; index.html and a.html committed on 1 March, a.html again on 20 May. */
function sitemapSite({ repository = true } = {}) {
  const dir = scratch();
  copyIn(dir, 'tools/build-sitemap.mjs');
  write(dir, 'robots.txt', 'User-agent: *\nAllow: /\n');
  write(dir, 'index.html', '<h1>Home</h1>\n');
  write(dir, 'a.html', '<h1>A</h1>\n');
  write(dir, '404.html', '<h1>Not found</h1>\n');
  if (repository) {
    git(dir, ['init', '-q']);
    commitAll(dir, '2026-03-01', 'pages');
    write(dir, 'a.html', '<h1>A, revised</h1>\n');
    commitAll(dir, '2026-05-20', 'a: revised');
  }
  return dir;
}
/* Give a file a modification time at noon, local time, on a day of July 2026. */
const touch = (dir, file, day) => fs.utimesSync(path.join(dir, file), new Date(2026, 6, day, 12), new Date(2026, 6, day, 12));
const datesIn = (xml) => Object.fromEntries(
  [...xml.matchAll(/<loc>https:\/\/stemkit\.net\/([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g)].map(m => [m[1] || 'index.html', m[2]]));

describe('build-sitemap', () => {
  withGit('a page is dated by the last commit that touched it, not by when the file was written', () => {
    const dir = sitemapSite();
    touch(dir, 'index.html', 4);
    touch(dir, 'a.html', 4);
    const r = run(dir, 'build-sitemap.mjs', ['--out', 'would-be.xml']);
    expect(r.status).toBe(0);
    expect(datesIn(fs.readFileSync(path.join(dir, 'would-be.xml'), 'utf8')))
      .toEqual({ 'index.html': '2026-03-01', 'a.html': '2026-05-20' });
    expect(fs.existsSync(path.join(dir, 'sitemap.xml'))).toBe(false); // --out leaves sitemap.xml alone
  });

  withGit('a page with changes not yet committed, or never committed, takes its modification time', () => {
    const dir = sitemapSite();
    write(dir, 'a.html', '<h1>A, being edited</h1>\n');
    write(dir, 'b.html', '<h1>B, new</h1>\n');
    touch(dir, 'a.html', 4);
    touch(dir, 'b.html', 5);
    run(dir, 'build-sitemap.mjs');
    expect(datesIn(fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8')))
      .toEqual({ 'index.html': '2026-03-01', 'a.html': '2026-07-04', 'b.html': '2026-07-05' });
  });

  test('outside a git checkout every page takes its modification time', () => {
    const dir = sitemapSite({ repository: false });
    touch(dir, 'index.html', 4);
    touch(dir, 'a.html', 5);
    const r = run(dir, 'build-sitemap.mjs');
    expect(r.status).toBe(0);
    expect(datesIn(fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8')))
      .toEqual({ 'index.html': '2026-07-04', 'a.html': '2026-07-05' });
    const check = run(dir, 'build-sitemap.mjs', ['--check']);
    expect(check.status).toBe(0);
    expect(check.out).toMatch(/dates not checked: not a git checkout/);
  });

  withGit('--check passes on a sitemap just built, and fails once a page is committed after its date', () => {
    const dir = sitemapSite();
    run(dir, 'build-sitemap.mjs');
    commitAll(dir, '2026-05-20', 'sitemap');
    const fresh = run(dir, 'build-sitemap.mjs', ['--check']);
    expect(fresh.status).toBe(0);
    expect(fresh.out).toMatch(/sitemap\.xml is current \(2 pages; no date is older than its page's last commit\)/);

    write(dir, 'a.html', '<h1>A, revised again</h1>\n');
    commitAll(dir, '2026-06-02', 'a: revised again');
    const stale = run(dir, 'build-sitemap.mjs', ['--check']);
    expect(stale.status).toBe(1);
    expect(stale.out).toMatch(/https:\/\/stemkit\.net\/a\.html: sitemap says 2026-05-20, last commit 2026-06-02/);
    expect(stale.out).not.toMatch(/stemkit\.net\/: sitemap says/); // index.html has not changed
  });

  withGit('--check passes when a date runs ahead of the last commit', () => {
    const dir = sitemapSite();
    run(dir, 'build-sitemap.mjs');
    const file = path.join(dir, 'sitemap.xml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('2026-05-20', '2026-09-30'));
    expect(run(dir, 'build-sitemap.mjs', ['--check']).status).toBe(0);
  });

  withGit('--check still fails for a page the sitemap does not list', () => {
    const dir = sitemapSite();
    run(dir, 'build-sitemap.mjs');
    write(dir, 'b.html', '<h1>B</h1>\n');
    const r = run(dir, 'build-sitemap.mjs', ['--check']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/missing: https:\/\/stemkit\.net\/b\.html/);
  });

  withGit('a shallow clone has no dates to give: --check compares the pages only, and writing is refused', () => {
    const dir = sitemapSite();
    run(dir, 'build-sitemap.mjs');
    commitAll(dir, '2026-05-20', 'sitemap');
    write(dir, 'index.html', '<h1>Home, revised</h1>\n');
    commitAll(dir, '2026-08-08', 'home: revised');
    const clone = scratch();
    git(clone, ['clone', '-q', '--depth', '1', `file://${dir}`, 'site']);
    const shallow = path.join(clone, 'site');
    const check = run(shallow, 'build-sitemap.mjs', ['--check']);
    expect(check.status).toBe(0);
    expect(check.out).toMatch(/dates not checked: this is a shallow clone/);
    const build = run(shallow, 'build-sitemap.mjs', ['--out', 'would-be.xml']);
    expect(build.status).toBe(1);
    expect(build.out).toMatch(/shallow clone/);
    expect(fs.existsSync(path.join(shallow, 'would-be.xml'))).toBe(false);
    // With the history the same sitemap is refused: index.html changed on 8 August.
    expect(run(dir, 'build-sitemap.mjs', ['--check']).out)
      .toMatch(/https:\/\/stemkit\.net\/: sitemap says 2026-03-01, last commit 2026-08-08/);
  });
});

/* ------------------------------------------------------------------ *
 * tools/check-chrome.mjs
 * ------------------------------------------------------------------ */

/* The site's own pages and the files the check reads, in a scratch directory. */
function chromeSite() {
  const dir = scratch();
  for (const f of fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))) copyIn(dir, f);
  for (const f of ['js/site.js', 'package.json', 'src/core/version.js', 'tools/check-chrome.mjs', 'tools/build-csp.mjs']) copyIn(dir, f);
  return dir;
}
/* What the check says about one page. */
const about = (out, page) => out.split('\n').filter(l => l.trim().startsWith(`${page}:`)).map(l => l.trim().slice(page.length + 2));
/* The problems only the head and catalogue checks report. */
const HEAD_PROBLEMS = /neither a tool|has the same|does not name|JSON-LD|canonical link|og:url|twitter:url|no <title>|no meta description|NOT_TOOLS/;

describe('check-chrome', () => {
  test('every page of the site is a tool or a listed page, with a head of its own', () => {
    const r = run(chromeSite(), 'check-chrome.mjs');
    expect(r.out.split('\n').filter(l => HEAD_PROBLEMS.test(l))).toEqual([]);
  });

  test('a copied page that nothing lists fails, and so do the title and description it kept', () => {
    const dir = chromeSite();
    fs.copyFileSync(path.join(dir, 'decision.html'), path.join(dir, 'decision-copy.html'));
    const r = run(dir, 'check-chrome.mjs');
    expect(r.status).toBe(1);
    const said = about(r.out, 'decision-copy.html');
    expect(said.some(l => /^is neither a tool in the js\/site\.js catalogue nor listed in NOT_TOOLS/.test(l))).toBe(true);
    expect(said).toContain('has the same <title> as decision.html: "Decision Matrix Calculator | STEMKit"');
    expect(said.some(l => l.startsWith('has the same meta description as decision.html'))).toBe(true);
  });

  test('a copied page added to the catalogue under a new name fails until its head is its own', () => {
    const dir = chromeSite();
    fs.copyFileSync(path.join(dir, 'decision.html'), path.join(dir, 'choice-helper.html'));
    const site = fs.readFileSync(path.join(dir, 'js/site.js'), 'utf8');
    const first = "{ id: 'plot-digitizer',";
    expect(site).toContain(first);
    write(dir, 'js/site.js', site.replace(first,
      `{ id: 'choice-helper', name: 'Choice Helper', cat: 'focus', icon: 'fa-scale-balanced', desc: '', tags: '', next: [] },\n    ${first}`));
    const r = run(dir, 'check-chrome.mjs');
    expect(r.status).toBe(1);
    const said = about(r.out, 'choice-helper.html');
    expect(said).toEqual(expect.arrayContaining([
      '<title> is "Decision Matrix Calculator | STEMKit", which does not name "Choice Helper"',
      'JSON-LD WebApplication is named "STEMKit Decision Matrix", catalogue says "STEMKit Choice Helper"',
      'JSON-LD WebApplication url is https://stemkit.net/decision.html, not https://stemkit.net/choice-helper.html',
      'canonical link is https://stemkit.net/decision.html, not https://stemkit.net/choice-helper.html',
      'og:url is https://stemkit.net/decision.html, not https://stemkit.net/choice-helper.html',
      'twitter:url is https://stemkit.net/decision.html, not https://stemkit.net/choice-helper.html',
      'has the same <title> as decision.html: "Decision Matrix Calculator | STEMKit"'
    ]));
    expect(said.some(l => /neither a tool/.test(l))).toBe(false);
  });

  test('a tool in the catalogue with no page, and a listed page that is gone, are reported', () => {
    const dir = chromeSite();
    fs.rmSync(path.join(dir, 'pomodoro.html'));
    fs.rmSync(path.join(dir, 'privacy.html'));
    const r = run(dir, 'check-chrome.mjs');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/js\/site\.js: catalogue lists pomodoro, but there is no pomodoro\.html/);
    expect(r.out).toMatch(/tools\/check-chrome\.mjs: NOT_TOOLS lists privacy\.html, which does not exist/);
  });
});
