
// M0 packaging tests (owner: DS-M0-BUILD).
//
// Exercises the deterministic ZIP writer, the entry-set / integrity contract
// and the esbuild IIFE globalName handoff. The lifecycle source used here is a
// throwaway fixture written to a temp directory at run time: it is packaging
// input only, always written to a temp --out, and never shipped as a stand-in
// for the KIMI module.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { buildArtifact, buildZip, sha256 } from '../scripts/build.mjs';
import { checkArtifact, readZipEntries } from '../scripts/check-package.mjs';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var FIXTURE_SOURCE = [
  'export interface Host { debug(message: string): void; reportError(error: unknown): void; }',
  'export function createLifecycle(host: Host) {',
  '  let state = "stopped";',
  '  return {',
  '    startup(_data: unknown, _reason: number) { state = "started"; host.debug("fixture startup"); },',
  '    shutdown(_reason: number) { state = "stopped"; },',
  '    uninstall(_reason: number) { state = "stopped"; },',
  '    getState() { return state; }',
  '  };',
  '}',
  ''
].join('\n');

var GOOD_MANIFEST = JSON.stringify({
  manifest_version: 2,
  name: 'Orange Translate',
  version: '0.3.5',
  applications: {
    zotero: {
      id: 'orange-translate-dev@local.invalid',
      strict_min_version: '10.0',
      strict_max_version: '10.*'
    }
  }
});
var GOOD_BOOTSTRAP = [
  'function install(data, reason) {}',
  'function startup(data, reason) { Services.scriptloader.loadSubScriptWithOptions(data.rootURI + "lifecycle.js", { target: {} }); }',
  'function shutdown(data, reason) {}',
  'function uninstall(data, reason) {}',
  ''
].join('\n');

function tempWorkdir() {
  // Temp artifacts stay on the D: worktree (gitignored .local/), never on the
  // system temp drive, so generated files honor the worktree boundary.
  var base = path.join(ROOT, '.local', 'tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, 'ot-m0-'));
}

function validEntries() {
  return [
    { name: 'bootstrap.js', data: Buffer.from(GOOD_BOOTSTRAP) },
    { name: 'lifecycle.js', data: Buffer.from('var OrangeTranslateLifecycle = { createLifecycle: function () {} };') },
    { name: 'manifest.json', data: Buffer.from(GOOD_MANIFEST) },
    { name: 'prefs.js', data: Buffer.from('pref("extensions.orange-translate.debug", false);') },
    { name: 'api-prefs.xhtml', data: Buffer.from('<vbox/>') },
    { name: 'api-prefs.js', data: readFileSync(path.join(ROOT, 'api-prefs.js')) },
    { name: 'icon.png', data: readFileSync(path.join(ROOT, 'icon.png')) }
  ];
}

test('zip writer stores entries in order with fixed timestamps', function () {
  var zip = buildZip([
    { name: 'b.js', data: Buffer.from('alpha') },
    { name: 'a.js', data: Buffer.from('beta') }
  ]);
  var parsed = readZipEntries(zip);
  assert.deepEqual(parsed.map(function (e) { return e.name; }), ['b.js', 'a.js']);
  assert.equal(parsed[0].dosDate, 0x0021);
  assert.equal(parsed[0].dosTime, 0);
  assert.equal(parsed[0].data.toString('utf8'), 'alpha');
  assert.equal(parsed[1].data.toString('utf8'), 'beta');
});

test('a valid package really passes checkArtifact', function () {
  var report = checkArtifact(buildZip(validEntries()));
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
});

test('build produces a contract-conformant XPI that verifies clean', async function () {
  var dir = tempWorkdir();
  try {
    var fixture = path.join(dir, 'lifecycle.ts');
    writeFileSync(fixture, FIXTURE_SOURCE);
    var out = path.join(dir, 'out.xpi');
    var result = await buildArtifact({ lifecycle: fixture, out: out });

    assert.ok(result.xpiBytes > 0);
    assert.ok(result.xpiBytes < 5 * 1024 * 1024);
    assert.equal(result.out, out);

    var report = checkArtifact(readFileSync(out));
    assert.deepEqual(report.errors, []);
    assert.deepEqual(
      report.entries.map(function (e) { return e.name; }).sort(),
      ['api-prefs.js', 'api-prefs.xhtml', 'bootstrap.js', 'icon.png', 'lifecycle.js', 'manifest.json', 'prefs.js']
    );
    for (var i = 0; i < report.entries.length; i++) {
      assert.equal(report.entries[i].dosDate, 0x0021);
      assert.equal(report.entries[i].dosTime, 0);
    }
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rebuild is byte-identical for the same inputs', async function () {
  var dir = tempWorkdir();
  try {
    var fixture = path.join(dir, 'lifecycle.ts');
    writeFileSync(fixture, FIXTURE_SOURCE);
    var a = await buildArtifact({ lifecycle: fixture, out: path.join(dir, 'a.xpi') });
    var b = await buildArtifact({ lifecycle: fixture, out: path.join(dir, 'b.xpi') });
    assert.equal(a.xpiSha256, b.xpiSha256);
    assert.deepEqual(readFileSync(path.join(dir, 'a.xpi')), readFileSync(path.join(dir, 'b.xpi')));
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent builds to separate temp outputs do not interfere', async function () {
  var dir = tempWorkdir();
  try {
    var fixture = path.join(dir, 'lifecycle.ts');
    writeFileSync(fixture, FIXTURE_SOURCE);
    var results = await Promise.all([0, 1, 2, 3].map(function (n) {
      return buildArtifact({ lifecycle: fixture, out: path.join(dir, 'c' + n + '.xpi') });
    }));
    var hashes = results.map(function (r) { return r.xpiSha256; });
    assert.equal(new Set(hashes).size, 1);
    for (var i = 0; i < results.length; i++) {
      assert.equal(checkArtifact(readFileSync(results[i].out)).ok, true);
    }
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundled lifecycle exposes OrangeTranslateLifecycle.createLifecycle', async function () {
  var dir = tempWorkdir();
  try {
    var fixture = path.join(dir, 'lifecycle.ts');
    writeFileSync(fixture, FIXTURE_SOURCE);
    var out = path.join(dir, 'out.xpi');
    await buildArtifact({ lifecycle: fixture, out: out });

    var entries = readZipEntries(readFileSync(out));
    var lifecycle = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === 'lifecycle.js') { lifecycle = entries[i].data.toString('utf8'); }
    }
    assert.ok(lifecycle, 'lifecycle.js must be present in the XPI');
    assert.ok(!/require\(|from ['"]node:/.test(lifecycle), 'bundle must not use Node builtins');

    var sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(lifecycle, sandbox, { filename: 'lifecycle.js' });
    assert.equal(typeof sandbox.OrangeTranslateLifecycle, 'object');
    assert.equal(typeof sandbox.OrangeTranslateLifecycle.createLifecycle, 'function');

    var messages = [];
    var instance = sandbox.OrangeTranslateLifecycle.createLifecycle({
      debug: function (m) { messages.push(m); },
      reportError: function () {}
    });
    assert.equal(instance.getState(), 'stopped');
    instance.startup({ id: 'x', version: '0.0.1', rootURI: 'jar:file:///x!/' }, 1);
    assert.equal(instance.getState(), 'started');
    assert.deepEqual(messages, ['fixture startup']);
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('build fails clearly when the lifecycle source is missing', async function () {
  var dir = tempWorkdir();
  try {
    var missing = path.join(dir, 'does-not-exist.ts');
    await assert.rejects(
      buildArtifact({ lifecycle: missing, out: path.join(dir, 'out.xpi') }),
      /Missing lifecycle source/
    );
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fixture lifecycle may not be written to the formal dist path', async function () {
  var dir = tempWorkdir();
  try {
    var fixture = path.join(dir, 'lifecycle.ts');
    writeFileSync(fixture, FIXTURE_SOURCE);
    await assert.rejects(
      buildArtifact({ lifecycle: fixture }),
      /formal dist artifact/
    );
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the CLI refuses --lifecycle without an explicit --out', async function () {
  var dir = tempWorkdir();
  try {
    var fixture = path.join(dir, 'lifecycle.ts');
    writeFileSync(fixture, FIXTURE_SOURCE);
    var mod = await import('node:child_process');
    var result = mod.spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'build.mjs'), '--lifecycle', fixture],
      { encoding: 'utf8', cwd: ROOT }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires an explicit --out/);
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check rejects an unexpected or forbidden entry', function () {
  var entries = validEntries();
  entries.push({ name: 'src/zotero/lifecycle.ts', data: Buffer.from('export {};') });
  var report = checkArtifact(buildZip(entries));
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(function (e) { return /Unexpected entry/.test(e); }));
  assert.ok(report.errors.some(function (e) { return /Forbidden payload/.test(e); }));
});

test('check rejects duplicate entry names', function () {
  var entries = validEntries();
  entries.push({ name: 'prefs.js', data: Buffer.from('pref("dup", true);') });
  var report = checkArtifact(buildZip(entries));
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(function (e) { return /Duplicate entry: prefs\.js/.test(e); }));
});

test('check rejects a manifest with a non-placeholder update_url or wrong isolation fields', function () {
  var report = checkArtifact(buildZip([
    { name: 'bootstrap.js', data: Buffer.from(GOOD_BOOTSTRAP) },
    { name: 'lifecycle.js', data: Buffer.from('var OrangeTranslateLifecycle = {};') },
    {
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify({
       manifest_version: 2,
       name: 'Unexpected Plugin',
        version: '9.9.9',
       homepage_url: 'https://example.com',
        applications: { zotero: { id: 'real@id', update_url: 'https://example.com/updates.json', strict_min_version: '7.0', strict_max_version: '7.1.*' } }
      }))
    },
    { name: 'prefs.js', data: Buffer.from('pref("x", false);') }
  ]));
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(function (e) { return /version must be 0.3.5/.test(e); }));
  assert.ok(report.errors.some(function (e) { return /name must be/.test(e); }));
  assert.ok(report.errors.some(function (e) { return /homepage_url/.test(e); }));
  assert.ok(report.errors.some(function (e) { return /orange-translate-dev@local\.invalid/.test(e); }));
  assert.ok(report.errors.some(function (e) { return /strict_min_version/.test(e); }));
  assert.ok(report.errors.some(function (e) { return /update_url/.test(e); }));
});

test('check rejects a corrupted payload via CRC mismatch', function () {
  var zip = buildZip(validEntries());
  // Locate the prefs.js local header, then corrupt one compressed payload
  // byte. Payloads are deflated, so the plaintext is not byte-addressable.
  var victim = Buffer.from(zip);
  var dataStart = -1;
  for (var p = 0; p + 30 <= victim.length; p++) {
    if (victim.readUInt32LE(p) !== 0x04034b50) { continue; }
    var nameLen = victim.readUInt16LE(p + 26);
    var extraLen = victim.readUInt16LE(p + 28);
    var compSize = victim.readUInt32LE(p + 18);
    if (compSize === 0) { continue; }
    var name = victim.toString('utf8', p + 30, p + 30 + nameLen);
    if (name === 'prefs.js') { dataStart = p + 30 + nameLen + extraLen; break; }
  }
  assert.ok(dataStart > 0, 'prefs.js local header must be locatable');
  victim[dataStart] = victim[dataStart] ^ 0xff;

  var report = checkArtifact(victim);
  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some(function (e) { return /CRC mismatch|size mismatch|ZIP structure error/.test(e); }),
    'corruption must be detected, got: ' + JSON.stringify(report.errors)
  );
});

test('check rejects a duplicate-free archive whose entry was renamed in the central directory', function () {
  var zip = buildZip(validEntries());
  var victim = Buffer.from(zip);
  // Rename "prefs.js" in the local header only, leaving the central directory
  // intact; the local/central name disagreement must be reported.
  var localPos = victim.indexOf(Buffer.from('prefs.js'));
  assert.ok(localPos > 0);
  Buffer.from('prefsXjs').copy(victim, localPos);
  var report = checkArtifact(victim);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(function (e) { return /name mismatch|Missing required entry/.test(e); }));
});

test('check rejects a falsy or non-object manifest instead of skipping checks', function () {
  var nonObjects = ['null', 'false', '0', '""', '[]', '"a string"'];
  for (var i = 0; i < nonObjects.length; i++) {
    var entries = validEntries();
    entries[2] = { name: 'manifest.json', data: Buffer.from(nonObjects[i]) };
    var report = checkArtifact(buildZip(entries));
    assert.equal(report.ok, false, 'manifest.json=' + nonObjects[i] + ' must be rejected');
    assert.ok(
      report.errors.some(function (e) { return /manifest\.json must be a JSON object/.test(e); }),
      'manifest.json=' + nonObjects[i] + ' errors: ' + JSON.stringify(report.errors)
    );
  }
});

test('check still reports unparseable manifest.json', function () {
  var entries = validEntries();
  entries[2] = { name: 'manifest.json', data: Buffer.from('{ not json') };
  var report = checkArtifact(buildZip(entries));
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(function (e) { return /not valid JSON/.test(e); }));
});

test('build refuses to write an oversize artifact and leaves no file behind', async function () {
  var dir = tempWorkdir();
  try {
    var fixture = path.join(dir, 'lifecycle.ts');
    // Incompressible payload well past the 5 MiB contract, assigned to a
    // global so esbuild keeps it in the bundle (comments are stripped).
    var padding = randomBytes(6 * 1024 * 1024).toString('base64');
    writeFileSync(
      fixture,
      FIXTURE_SOURCE + '(globalThis as any).__otPadding = "' + padding + '";\n'
    );
    var out = path.join(dir, 'oversize.xpi');
    await assert.rejects(
      buildArtifact({ lifecycle: fixture, out: out }),
      /exceeds 5 MiB limit/
    );
    assert.equal(existsSync(out), false, 'no artifact may be written when the size check fails');
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sha256 helper is stable', function () {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
