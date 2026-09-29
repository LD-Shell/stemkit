#!/usr/bin/env node
/*
 * build-plumed-syntax.mjs: turn PLUMED's own syntax.json into the compact
 * keyword tables under src/core/plumed-syntax/.
 *
 * PLUMED writes syntax.json from the keywords each action registers
 * (`make -C json` in a compiled tree, which runs `plumed gen_json`), so the
 * table is the parser's own view of the input language for that release.
 *
 * Usage, once per PLUMED release:
 *     node tools/build-plumed-syntax.mjs --source /path/to/plumed2 --target 2.10
 *
 * --source  a compiled PLUMED tree holding json/syntax.json and src/<module>/module.type
 * --target  the release the table is filed under (2.9, 2.10, 2.11)
 * --plumed  the tree's plumed executable; needed for 2.9, whose syntax.json
 *           leaves out keyword defaults, which are then read from
 *           "plumed manual --action"
 * --check   compare against the file on disk and exit 1 when they differ
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src', 'core', 'plumed-syntax');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : '';
}

const source = arg('source');
const target = arg('target');
const plumedBin = arg('plumed');
const check = process.argv.includes('--check');

if (!source || !/^\d+\.\d+$/.test(target)) {
  console.error('usage: build-plumed-syntax.mjs --source <plumed tree> --target <major.minor> [--check]');
  process.exit(2);
}

const jsonPath = path.join(source, 'json', 'syntax.json');
if (!fs.existsSync(jsonPath)) {
  console.error(`No ${jsonPath}. Compile PLUMED, then run "make -C json" in the tree.`);
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

/* One letter per keyword style, as the parser distinguishes them. */
/* 2.9 files its multicolvar reductions (MEAN, MORE_THAN, ...) as "vessel". */
const STYLE = { atoms: 'a', compulsory: 'c', optional: 'o', flag: 'f', hidden: 'h', vessel: 'v' };

/* Keywords every action carries for the documentation generator alone. */
const INTERNAL = new Set(['HAS_VALUES', 'IS_SHORTCUT']);

const strings = [];
const stringIndex = new Map();
function intern(text) {
  const s = tidy(text);
  if (!s) return -1;
  if (!stringIndex.has(s)) {
    stringIndex.set(s, strings.length);
    strings.push(s);
  }
  return stringIndex.get(s);
}

/* First sentence, whitespace collapsed, capped so a table stays small. */
function tidy(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  const stop = s.search(/\.(\s|$)/);
  if (stop > 20) s = s.slice(0, stop + 1);
  if (s.length > 200) s = `${s.slice(0, 197).trimEnd()}...`;
  return s;
}

function moduleDefaults() {
  const out = {};
  const src = path.join(source, 'src');
  for (const name of fs.readdirSync(src).sort()) {
    const file = path.join(src, name, 'module.type');
    if (!fs.existsSync(file)) continue;
    const type = fs.readFileSync(file, 'utf8').trim();
    out[name] = type === 'default-off' ? 0 : 1;
  }
  return out;
}

function longVersion() {
  for (const name of ['VERSION.txt', 'VERSION']) {
    const file = path.join(source, name);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n')
      .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (lines.length) return lines[lines.length - 1];
  }
  return target;
}

/* PLUMED 2.9 writes no module into syntax.json, so the module is read from
   where the action is registered in the source. */
function registeredModules() {
  const out = {};
  const src = path.join(source, 'src');
  const re = /PLUMED_REGISTER_ACTION\(\s*[^,]+,\s*"([A-Z0-9_]+)"\s*\)/g;
  for (const dir of fs.readdirSync(src).sort()) {
    const full = path.join(src, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith('.cpp')) continue;
      const text = fs.readFileSync(path.join(full, file), 'utf8');
      let m;
      while ((m = re.exec(text))) if (!out[m[1]]) out[m[1]] = dir;
    }
  }
  return out;
}
const registered = registeredModules();

/* Where the manual for this release lives, and how it names its pages. */
function docStyle() {
  const link = String((raw.METAD && raw.METAD.hyperlink) || '');
  const base = link.slice(0, link.lastIndexOf('/') + 1);
  return { base, mangled: /_m_e_t_a_d\.html$/.test(link) };
}

const jsonHasDefaults = Object.values(raw).some(e => e && e.syntax &&
  Object.values(e.syntax).some(k => k && k.default !== undefined));
if (!jsonHasDefaults && !plumedBin) {
  console.error('This syntax.json carries no keyword defaults; pass --plumed <executable> to read them.');
  process.exit(2);
}

/* Defaults as the manual prints them: "<b> NN </b></td><td> ( default=6 ) ...". */
function manualDefaults(name) {
  const out = {};
  let html = '';
  try {
    html = execFileSync(plumedBin, ['manual', '--action', name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24 });
  } catch (_) { return out; }
  const re = /<b>\s*([A-Z0-9_]+)\s*<\/b>\s*<\/td>\s*<td>\s*\(\s*default=([^)]*?)\s*\)/g;
  let m;
  while ((m = re.exec(html))) out[m[1]] = m[2];
  return out;
}

const actions = {};
for (const name of Object.keys(raw).sort()) {
  const entry = raw[name];
  if (!entry || typeof entry !== 'object' || !entry.syntax || !/^[A-Z0-9_]+$/.test(name)) continue;

  const keywords = {};
  const outputs = {};
  const fromManual = jsonHasDefaults ? null : manualDefaults(name);
  for (const [key, spec] of Object.entries(entry.syntax)) {
    if (key === 'output') {
      for (const [comp, o] of Object.entries(spec || {})) {
        outputs[comp] = [o.flag || 'default', intern(o.description)];
      }
      continue;
    }
    if (!spec || typeof spec !== 'object' || INTERNAL.has(key)) continue;
    const style = STYLE[spec.type];
    if (!style) continue;
    const row = [style, style === 'h' ? -1 : intern(spec.description)];
    const numbered = Number(spec.multiple) === 1;
    const value = fromManual ? fromManual[key] : spec.default;
    const hasDefault = value !== undefined && style !== 'f';
    if (numbered || hasDefault) row.push(numbered ? 1 : 0);
    if (hasDefault) row.push(String(value).trim());
    keywords[key] = row;
  }

  const action = { m: entry.module || registered[name] || '', d: intern(entry.description), k: keywords };
  if (Object.keys(outputs).length) action.o = outputs;
  if (Array.isArray(entry.dois) && entry.dois.length) action.doi = entry.dois;
  if (entry.displayname && entry.displayname !== name) action.n = entry.displayname;
  actions[name] = action;
}

const table = {
  version: target,
  release: longVersion(),
  doc: docStyle(),
  modules: moduleDefaults(),
  strings,
  actions
};

const banner = `/**
 * PLUMED ${target} input syntax: every action, its keywords, defaults, output
 * components and module, as registered in the PLUMED source.
 *
 * Generated by tools/build-plumed-syntax.mjs from json/syntax.json of
 * PLUMED ${table.release}. Do not edit by hand.
 *
 * PLUMED is free software distributed under the GNU LGPL v3; the keyword
 * descriptions here are taken from it. See THIRD_PARTY_LICENSES.md.
 *
 * Read it through createSyntax() in ../plumed-syntax.js rather than directly:
 * keyword rows are [style, description index, numbered?, default?] and the
 * descriptions are interned in \`strings\`.
 */
`;

const body = `${banner}export default ${JSON.stringify(table)};\n`;
const outFile = path.join(OUT_DIR, `v${target}.js`);

if (check) {
  const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  if (current !== body) {
    console.error(`${path.relative(ROOT, outFile)} is out of date.`);
    process.exit(1);
  }
  console.log(`${path.relative(ROOT, outFile)} is up to date.`);
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outFile, body);
  const kb = (Buffer.byteLength(body) / 1024).toFixed(0);
  console.log(`${path.relative(ROOT, outFile)}: ${Object.keys(actions).length} actions, ` +
    `${strings.length} descriptions, ${kb} kB`);
}
