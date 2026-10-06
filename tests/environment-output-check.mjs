// Run: node tests/environment-output-check.mjs. Native Zotero UI is checked by installation.
import assert from 'node:assert/strict';
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { saveTranslatedPdfs, importTranslatedPdf, assertOutputFolder } from '../src/zotero/result-importer.ts';
import { resolveRuntime, installRuntime } from '../src/zotero/runtime-setup.ts';

const root = mkdtempSync(path.resolve('.local/tmp/environment-output-'));
const folder = path.join(root, '用户文献 空格'); mkdirSync(folder);
const source = path.join(folder, '文献.PDF'); writeFileSync(source, '%PDF-original');
const dual = path.join(root, 'dual.pdf'), mono = path.join(root, 'mono.pdf');
writeFileSync(dual, '%PDF-dual'); writeFileSync(mono, '%PDF-mono');
let writable = true, failMono = false;
const file = p => ({ path: p, leafName: path.basename(p), get parent() { return file(path.dirname(p)); },
  exists: () => existsSync(p), isDirectory: () => statSync(p).isDirectory(), isFile: () => statSync(p).isFile(),
  isWritable: () => writable, directoryEntries: { hasMoreElements: () => true } });
const calls = [], prefs = new Map();
const library = { libraryType: 'user', editable: true, filesEditable: true };
const candidate = { absolutePath: source, fileName: '文献.PDF', attachmentID: 2, attachmentKey: 'PDF', libraryID: 1, parentItemKey: 'PARENT' };
const host = { PathUtils: path, Zotero: { File: { pathToFile: file },
  Libraries: { userLibraryID: 1, get: () => library },
  Items: { get: () => ({ key: 'PDF', libraryID: candidate.libraryID, parentItemKey: candidate.parentItemKey, getCollections: () => [7] }),
    getByLibraryAndKey: () => ({ id: 3, isRegularItem: () => true }) },
  Attachments: { linkFromFile: async options => calls.push({ ...options, linked: true }), importFromFile: async options => calls.push(options) } },
  IOUtils: { copy: async (from, to, options) => { assert.equal(options.noOverwrite, true); if (failMono && from === mono) { throw Error(); } copyFileSync(from, to, constants.COPYFILE_EXCL); },
    remove: async p => rmSync(p) },
  Services: { prefs: { getStringPref: (key, fallback) => prefs.get(key) ?? fallback }, appinfo: { OS: 'WINNT', XPCOMABI: 'x86_64-msvc' } } };
const first = await saveTranslatedPdfs(host, candidate, { dualPdf: dual, monoPdf: mono });
const second = await saveTranslatedPdfs(host, candidate, { dualPdf: dual, monoPdf: mono });
assert.equal(first.dualPdf, path.join(folder, '文献.zh.dual.pdf'));
assert.equal(second.monoPdf, path.join(folder, '文献.zh-2.mono.pdf'));
for (const pair of [first, second]) {
  assert.equal(readFileSync(pair.dualPdf, 'utf8'), '%PDF-dual'); assert.equal(readFileSync(pair.monoPdf, 'utf8'), '%PDF-mono');
}
assert.equal(readFileSync(source, 'utf8'), '%PDF-original');
await importTranslatedPdf(host.Zotero, candidate, first.dualPdf, 'dual', true);
await importTranslatedPdf(host.Zotero, candidate, first.monoPdf, 'mono', true);
assert.ok(calls.slice(0, 2).every(c => c.linked && c.parentItemID === 3)); assert.match(calls[1].title, /纯中文/);
library.libraryType = 'group'; candidate.libraryID = 4;
await importTranslatedPdf(host.Zotero, candidate, first.monoPdf, 'mono', true);
assert.equal(calls[2].linked, undefined);
candidate.parentItemKey = null;
await importTranslatedPdf(host.Zotero, candidate, first.monoPdf, 'mono', true);
assert.deepEqual(calls[3].collections, [7]);
failMono = true;
await assert.rejects(saveTranslatedPdfs(host, candidate, { dualPdf: dual, monoPdf: mono }), /OUTPUT_SAVE_FAILED/);
assert.equal(existsSync(path.join(folder, '文献.zh-3.dual.pdf')), false);
writable = false; assert.throws(() => assertOutputFolder(host, candidate), /OUTPUT_FOLDER_READ_ONLY/); writable = true;
await assert.rejects(saveTranslatedPdfs(host, candidate, { dualPdf: dual }), /MISSING_REQUIRED_OUTPUT/);
assert.throws(() => resolveRuntime(host), /RUNTIME_MISSING/);
const runtime = path.join(root, 'runtime');
mkdirSync(path.join(runtime, 'runtime/python/Scripts'), { recursive: true });
mkdirSync(path.join(runtime, 'runtime/libs/pdf2zh_next'), { recursive: true });
mkdirSync(path.join(runtime, 'runtime/libs/babeldoc'), { recursive: true });
writeFileSync(path.join(runtime, 'runtime/python/Scripts/python.exe'), 'fake');
writeFileSync(path.join(runtime, 'runtime/libs/pdf2zh_next/main.py'), '');
writeFileSync(path.join(runtime, 'runtime/libs/babeldoc/__init__.py'), '');
assert.equal(resolveRuntime(host, runtime).python, path.join(runtime, 'runtime/python/Scripts/python.exe'));
writeFileSync(path.join(runtime, '.orange-translate-runtime.json'), '{}');
assert.throws(() => resolveRuntime(host, runtime), /RUNTIME_MISSING/);
writeFileSync(path.join(runtime, 'ready.json'), '{}'); assert.equal(resolveRuntime(host, runtime).root, runtime);
const unrelated = path.join(root, 'OrangeTranslateRuntime'); mkdirSync(unrelated); writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
host.ChromeUtils = { importESModule: () => ({ FilePicker: class { modeGetFolder = 2; returnOK = 0; file = root; init() {} async show() { return 0; } } }) };
host.IOUtils.readUTF8 = async p => readFileSync(p, 'utf8');
await assert.rejects(installRuntime(host, () => {}), /INSTALL_DIR_UNOWNED/);
assert.equal(readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
console.log('PASS: two adjacent PDFs, no overwrite, both attachment modes, runtime layouts and unowned-folder guard');
