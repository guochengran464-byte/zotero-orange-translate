/**
 * M1 entry integration tests (owner: M1-RESOLVER-01 / DS).
 *
 * Loads the REAL bootstrap.js into a Node vm context that mimics the frozen
 * Zotero 10.0.2 host ABI, and loads the REAL built lifecycle.js bundle into the
 * target scope the same way Services.scriptloader does. This is the closest
 * local check that bootstrap -> bundle -> menu registration/cleanup is wired
 * correctly without a Zotero host.
 *
 * It is still not host evidence: M1-VERIFY-01 owns the isolated Zotero run.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var BOOTSTRAP_SOURCE = readFileSync(path.join(ROOT, 'bootstrap.js'), 'utf8');

var REASON = { APP_STARTUP: 1, APP_SHUTDOWN: 2, ADDON_ENABLE: 3, ADDON_DISABLE: 4, ADDON_INSTALL: 5, ADDON_UNINSTALL: 6 };

/** Build the real bundle once per test run (deterministic, into .local/tmp). */
function buildBundle() {
  var tmp = mkdtempSync(path.join(ROOT, '.local', 'tmp', 'e2e-'));
  var out = path.join(tmp, 'probe.xpi');
  execFileSync(process.execPath, [
    path.join(ROOT, 'scripts', 'build.mjs'),
    '--out', out,
    '--quiet',
  ], { cwd: ROOT, encoding: 'utf8' });
  var buf = readFileSync(out);
  // Minimal central-directory walk to pull lifecycle.js out of the XPI.
  var eocd = -1;
  for (var i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  var total = buf.readUInt16LE(eocd + 10);
  var p = buf.readUInt32LE(eocd + 16);
  var lifecycle = null;
  for (var n = 0; n < total; n++) {
    var method = buf.readUInt16LE(p + 10);
    var compSize = buf.readUInt32LE(p + 20);
    var nameLen = buf.readUInt16LE(p + 28);
    var extraLen = buf.readUInt16LE(p + 30);
    var commentLen = buf.readUInt16LE(p + 32);
    var localOffset = buf.readUInt32LE(p + 42);
    var name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    var lhNameLen = buf.readUInt16LE(localOffset + 26);
    var lhExtraLen = buf.readUInt16LE(localOffset + 28);
    var dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    var raw = buf.subarray(dataStart, dataStart + compSize);
    if (name === 'lifecycle.js') {
      lifecycle = method === 0
        ? raw.toString('utf8')
        : inflateRawSync(raw).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.ok(lifecycle, 'lifecycle.js must be present in the built XPI');
  rmSync(tmp, { recursive: true, force: true });
  return lifecycle;
}

var LIFECYCLE_SOURCE = buildBundle();

function makeHarness(options) {
  var opts = options || {};
  var state = {
    registered: [],
    unregistered: [],
    debugLines: [],
    loggedErrors: [],
    alerts: [],
    confirmations: [],
    processCalls: [],
    moduleImports: [],
    imported: [],
    panels: [],
  };
  const mainWindow = { id: 'main', setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    document: {
      createElementNS: (_namespace, tag) => ({ tag, style: {}, attributes: {}, children: [],
        setAttribute(name, value) { this.attributes[name] = value; },
        append(...children) { this.children.push(...children); },
        addEventListener(name, handler) { this[name] = handler; },
        remove() { this.removed = true; },
      }),
      documentElement: { appendChild(panel) { state.panels.push(panel); } },
    },
  };

  const normalize = p => path.win32.normalize(p);
  const files = new Map(); const folders = new Set(['C:\\', 'D:\\', 'F:\\']);
  files.set(normalize('F:/pdf2zh/build/PDF翻译器/runtime/python/python.exe'), 'exe');
  files.set(normalize('F:/pdf2zh/build/PDF翻译器/runtime/libs/pdf2zh_next/main.py'), 'module');
  files.set(normalize('F:/pdf2zh/build/PDF翻译器/runtime/libs/babeldoc/__init__.py'), 'module');
  const file = p => ({ path: normalize(p),
    get leafName() { return path.win32.basename(p); },
    get parent() { return file(path.win32.dirname(p)); },
    exists() { return files.has(normalize(p)) || folders.has(normalize(p)); },
    isFile() { return files.has(normalize(p)); }, isDirectory() { return folders.has(normalize(p)); },
    isReadable() { return true; }, isWritable() { return true; }, create() { folders.add(normalize(p)); }, remove() {},
    get fileSize() { return (files.get(normalize(p)) || '').length; },
    get directoryEntries() { return { hasMoreElements: () => [...files.keys()].some(k => k.startsWith(normalize(p) + '\\')) }; },
  });
  const classes = new Proxy({}, { get: (_target, name) => ({ createInstance: () => {
    if (name === '@mozilla.org/intl/converter-output-stream;1') {
      return { init(stream) { this.stream = stream; }, writeString(text) { files.set(this.stream.file.path, text); }, close() {} };
    }
    if (name === '@mozilla.org/intl/converter-input-stream;1') {
      return { init(stream) { this.text = files.get(stream.file.path); this.offset = 0; },
        readString(length, chunk) { chunk.value = this.text.slice(this.offset, this.offset + length); this.offset += chunk.value.length; return chunk.value.length; }, close() {} };
    }
    if (name === '@mozilla.org/binaryinputstream;1') {
      return { setInputStream(stream) { this.stream = stream; }, readBytes(n) { return files.get(this.stream.file.path).slice(0, n); } };
    }
    if (name === '@mozilla.org/security/hash;1') {
      return { SHA256: 1, init() {}, updateFromStream(stream) { this.value = files.get(stream.file.path); }, finish() { return this.value; } };
    }
    return { init(f) { this.file = f; }, close() {} };
  } }) });

  var itemsByID = new Map();
  for (var entry of opts.items || []) { itemsByID.set(entry[0], entry[1]); }
  for (const item of itemsByID.values()) {
    if (item.isPDFAttachment?.()) {
      const p = 'C:/lib/storage/' + item.key + '/' + item.attachmentFilename;
      files.set(normalize(p), '%PDF-original'); folders.add(normalize(path.win32.dirname(p)));
    }
  }

  var sandbox = {
    Components: { classes, interfaces: { nsIFile: { DIRECTORY_TYPE: 1 } } },
    IOUtils: { writeUTF8: async (p, text) => files.set(normalize(p), text),
      copy: async (from, to, options) => { assert.equal(options.noOverwrite, true); assert.equal(files.has(normalize(to)), false); files.set(normalize(to), files.get(normalize(from))); },
      remove: async p => files.delete(normalize(p)) },
    PathUtils: { join: path.win32.join },
    ChromeUtils: {
      importESModule: function (uri) {
        state.moduleImports.push(uri);
        return { Subprocess: { call: async function (options) {
          state.processCalls.push(options);
          let finish;
          const exit = new Promise(resolve => { finish = resolve; });
          const frameChunks = [];
          return { pid: 321, exitCode: 0,
            stdout: { readString: async function () { return ''; } },
            stderr: { readString: async function () { return ''; } },
            stdin: { write: async bytes => {
              const written = bytes.byteLength;
              frameChunks.push(Buffer.from(bytes));
              structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
              return { bytesWritten: written };
            },
              close: async () => {
                const frame = Buffer.concat(frameChunks); state.frame = JSON.parse(frame.subarray(4).toString());
                const requestPath = options.arguments[options.arguments.indexOf('-RequestPath') + 1];
                const resultPath = options.arguments[options.arguments.indexOf('-ResultPath') + 1];
                const request = JSON.parse(files.get(normalize(requestPath)));
                const dual = path.win32.join(request.outputDir, 'paper.zh.dual.pdf');
                const mono = path.win32.join(request.outputDir, 'paper.zh.mono.pdf');
                files.set(dual, '%PDF-dual'); files.set(mono, '%PDF-mono');
                files.set(normalize(resultPath), JSON.stringify({ schemaVersion: 1, jobId: request.jobId,
                  status: 'completed', outputs: { dualPdf: dual, monoPdf: mono } }));
                finish({ exitCode: opts.exitUnconfirmed ? null : 0 });
              } },
            wait: () => exit,
            kill: function () {},
          };
        } } };
      },
    },
    Services: {
      uuid: { generateUUID: () => '{11111111-1111-4111-8111-111111111111}' },
      env: { get: function () { return 'C:\\Windows'; } },
      prefs: {
        getBoolPref: function () { return opts.debugPref === true; },
        getStringPref: function (name, fallback) {
          return name.endsWith('.runtimeRoot') ? 'F:\\pdf2zh\\build\\PDF翻译器' : fallback;
        },
      },
      prompt: {
        select: function () { return false; },
        alert: function (win, title, text) { state.alerts.push(text); },
        confirm: (_win, _title, text) => { state.confirmations.push(text); return true; },
        promptPassword: (_win, _title, _text, value) => { value.value = 'TEST-ONLY-KEY'; return true; },
      },
      scriptloader: {
        loadSubScriptWithOptions: function (uri, loadOptions) {
          // Mirror the frozen host: run the script with target as its global.
          vm.runInNewContext(LIFECYCLE_SOURCE, loadOptions.target, { filename: 'lifecycle.js' });
          state.loadedURI = uri;
          return loadOptions.target;
        },
      },
    },
    Zotero: {
      Libraries: { get: () => ({ editable: true, filesEditable: true }) },
      Attachments: { importFromFile: async options => { state.imported.push(options); return { getField: () => options.title }; } },
      ProgressWindow: function () { return { changeHeadline() {}, addDescription() {}, show() {}, close() {}, startCloseTimer() {} }; },
      debug: function (message) { state.debugLines.push(message); },
      logError: function (error) { state.loggedErrors.push(error); },
      getMainWindow: function () { return mainWindow; },
      MenuManager: {
        registerMenu: function (menuOptions) {
          state.registered.push(menuOptions);
          return 'handle-1';
        },
        unregisterMenu: function (menuID) {
          state.unregistered.push(menuID);
          return true;
        },
      },
      Items: {
        get: function (ids) { return Array.isArray(ids) ? ids.map(id => itemsByID.get(id)).filter(Boolean) : itemsByID.get(ids); },
        getByLibraryAndKey: (_libraryID, key) => [...itemsByID.values()].find(item => item.key === key),
      },
      File: {
        pathToFile: file,
      },
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(BOOTSTRAP_SOURCE, sandbox, { filename: 'bootstrap.js' });
  return { sandbox: sandbox, state: state };
}

function startupData() {
  return {
    id: 'orange-translate-dev@local.invalid',
    version: '0.0.1',
    rootURI: 'jar:file:///fake/orange.xpi!/',
  };
}

function makePdfItem(key, parentItemKey, id, fileName) {
  return {
    id: id,
    key: key,
    libraryID: 1,
    parentItemKey: parentItemKey,
    attachmentFilename: fileName,
    isAttachment: function () { return true; },
    isFileAttachment: function () { return true; },
    isPDFAttachment: function () { return true; },
    getDisplayTitle: function () { return 'Title ' + key; },
    getFilePathAsync: async function () { return 'C:/lib/storage/' + key + '/' + fileName; },
  };
}

function makeParent(key, title, attachmentIDs) {
  return {
    id: 500,
    key: key,
    libraryID: 1,
    parentItemKey: null,
    isAttachment: function () { return false; },
    isRegularItem: function () { return true; },
    getDisplayTitle: function () { return title; },
    getAttachments: function () { return attachmentIDs; },
  };
}

test('startup registers exactly one menu through the real bundle', function () {
  var h = makeHarness();
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  assert.equal(h.state.registered.length, 1);
  assert.equal(h.state.registered[0].target, 'main/library/item');
  assert.equal(h.state.registered[0].menus[0].menuType, 'submenu');
  assert.equal(h.state.loadedURI, startupData().rootURI + 'lifecycle.js');
});

test('repeat startup does not double-register the menu', function () {
  var h = makeHarness();
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  h.sandbox.startup(startupData(), REASON.ADDON_ENABLE);
  assert.equal(h.state.registered.length, 1);
});

test('shutdown unregisters the exact handle', function () {
  var h = makeHarness();
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  h.sandbox.shutdown(startupData(), REASON.ADDON_DISABLE);
  assert.deepEqual(h.state.unregistered, ['handle-1']);
});

test('uninstall unregisters the exact handle', function () {
  var h = makeHarness();
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  h.sandbox.uninstall(startupData(), REASON.ADDON_UNINSTALL);
  assert.deepEqual(h.state.unregistered, ['handle-1']);
});

test('disable/enable cycle registers, releases, then registers again', function () {
  var h = makeHarness();
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  h.sandbox.shutdown(startupData(), REASON.ADDON_DISABLE);
  h.sandbox.startup(startupData(), REASON.ADDON_ENABLE);
  assert.equal(h.state.registered.length, 2);
  assert.deepEqual(h.state.unregistered, ['handle-1']);
});

test('menu label is set to the M1 action text on showing', function () {
  var h = makeHarness();
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  var attributes = {};
  h.state.registered[0].menus[0].onShowing({}, { menuElem: { setAttribute: function (k, v) { attributes[k] = v; } } });
  assert.equal(attributes.label, 'Orange Translate');
});

test('built product resolves a PDF, transfers the credential through stdin and imports its result', async function () {
  var pdf = makePdfItem('A1', 'P1', 11, 'study.pdf');
  var parent = makeParent('P1', 'A Study', [11]);
  var h = makeHarness({ items: [[11, pdf], [500, parent]], debugPref: true });
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  await h.state.registered[0].menus[0].menus[0].onCommand({}, { items: [parent] });
  assert.ok(h.state.debugLines.some(function (m) { return m.indexOf('resolved single candidate') >= 0; }));
  assert.ok(!h.state.debugLines.join(' ').includes('C:/lib/storage'));
  assert.ok(!h.state.debugLines.join(' ').includes('A1'));
  assert.deepEqual(h.state.moduleImports, ['resource://gre/modules/Subprocess.sys.mjs']);
  assert.equal(h.state.processCalls.length, 1);
  assert.equal(h.state.processCalls[0].command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(h.state.processCalls[0].arguments.includes('-NonInteractive'));
  assert.ok(!h.state.processCalls[0].arguments.join(' ').includes('study.pdf'));
  assert.ok(h.state.alerts.some(function (text) { return text.includes('翻译完成'); }));
  assert.equal(h.state.frame.apiKey, 'TEST-ONLY-KEY');
  assert.ok(h.state.confirmations.some(text => text.includes('DCS') && text.includes('deepseek-v4-flash') && text.includes('/responses')));
  assert.ok(!h.state.processCalls[0].arguments.join(' ').includes('TEST-ONLY-KEY'));
  assert.equal(h.state.imported.length, 2);
  assert.equal(h.state.imported[0].parentItemID, 500);
  assert.equal(h.state.imported[1].parentItemID, 500);
  assert.equal(h.state.imported[0].file, 'C:\\lib\\storage\\A1\\study.zh.dual.pdf');
  assert.equal(h.state.imported[1].file, 'C:\\lib\\storage\\A1\\study.zh.mono.pdf');
  assert.match(h.state.imported[1].title, /纯中文/);
  assert.equal(h.state.panels.length, 1);
  assert.equal(h.state.panels[0].tag, 'section');
  assert.equal(h.state.panels[0].children[0].attributes.role, 'status');
  assert.ok(h.state.panels[0].children[0].textContent.includes('翻译完成'));
  assert.equal(h.state.panels[0].children[1].tag, 'progress');
  assert.equal(h.state.panels[0].children[1].value, 100);
  assert.ok(h.state.panels[0].children[2].textContent.includes('已回挂'));
  assert.equal(h.state.processCalls[0].environment.ORANGE_API_PROTOCOL, 'responses');
  assert.equal(h.state.processCalls[0].environment.ORANGE_POOL_MAX_WORKERS, '16');
  assert.ok(h.state.processCalls[0].environment.ORANGE_API_BASE_URL.includes('dcsapi.dcs.cloud'));
});

test('an unconfirmed process exit blocks another job and imports nothing', async function () {
  const pdf = makePdfItem('A1', 'P1', 11, 'study.pdf');
  const parent = makeParent('P1', 'A Study', [11]);
  const h = makeHarness({ items: [[11, pdf], [500, parent]], exitUnconfirmed: true });
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  const command = h.state.registered[0].menus[0].menus[0].onCommand;
  await command({}, { items: [parent] });
  await command({}, { items: [parent] });
  assert.equal(h.state.processCalls.length, 1);
  assert.equal(h.state.imported.length, 0);
  assert.ok(h.state.alerts.some(text => text.includes('暂停新任务')));
});

test('end to end: multiple PDFs reports MULTIPLE_PDF and never auto-resolves', async function () {
  var a = makePdfItem('A', 'P1', 11, 'a.pdf');
  var b = makePdfItem('B', 'P1', 12, 'b.pdf');
  var parent = makeParent('P1', 'A Study', [11, 12]);
  var h = makeHarness({ items: [[11, a], [12, b]], debugPref: true });
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  await h.state.registered[0].menus[0].menus[0].onCommand({}, { items: [parent] });
  // The fake Services.prompt has no select: 1.0 must report MULTIPLE_PDF
  // rather than opening any chooser or resolving anything.
  assert.ok(h.state.debugLines.some(function (m) { return m.indexOf('resolver error code=MULTIPLE_PDF') >= 0; }));
  assert.ok(!h.state.debugLines.some(function (m) { return m.indexOf('resolved single candidate') >= 0; }));
  assert.equal(h.state.alerts.length, 1);
  assert.ok(h.state.alerts[0].indexOf('多个 PDF') >= 0);
});

test('end to end: multiple selected items alerts and never resolves', async function () {
  var p1 = makeParent('P1', 'One', []);
  var p2 = makeParent('P2', 'Two', []);
  var h = makeHarness({ debugPref: true });
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  await h.state.registered[0].menus[0].menus[0].onCommand({}, { items: [p1, p2] });
  assert.ok(h.state.debugLines.some(function (m) { return m.indexOf('resolver error code=MULTIPLE_SELECTION') >= 0; }));
  assert.equal(h.state.alerts.length, 1);
});

test('a host without MenuManager does not half-register', function () {
  var h = makeHarness();
  delete h.sandbox.Zotero.MenuManager;
  assert.doesNotThrow(function () { h.sandbox.startup(startupData(), REASON.APP_STARTUP); });
  assert.equal(h.state.registered.length, 0);
});

test('shutdown without a prior startup is a safe no-op', function () {
  var h = makeHarness();
  h.sandbox.shutdown(startupData(), REASON.APP_SHUTDOWN);
  h.sandbox.uninstall(startupData(), REASON.ADDON_UNINSTALL);
  assert.deepEqual(h.state.unregistered, []);
  assert.equal(h.state.loadedURI, undefined);
});
