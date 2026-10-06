/**
 * M2-REAL-0 isolated test driver (TEST-ONLY).
 *
 * This module is NOT part of the product. It is bundled by the opt-in
 * test-package build into a driver XPI that is installed only into an isolated
 * Zotero Dev Profile on D:. It imports the existing, unmodified product sources
 * (src/zotero/subprocess-host.ts plus its transitive module graph) and drives the
 * real Zotero 10.0.2 Subprocess surface against tests/fixtures/m2-real-0-child.ps1,
 * a harmless synthetic child.
 *
 * It writes nothing outside the control.json run root, starts no process other
 * than the fixture child, opens no network socket (Services.io.offline is set
 * true), reads no credential store, touches no Zotero database or Library and
 * loads no Runtime.
 */

import { createSubprocessPort } from '../../../../src/zotero/subprocess-host.ts';
import { PowershellBridge } from '../../../../src/runtime/powershell-bridge.ts';
import type { SubprocessPort, SubprocessProcessHandle, BridgeFilePort, PdfValidator, SubprocessStream } from '../../../../src/runtime/powershell-bridge.ts';
import type { SecretStorePort } from '../../../../src/runtime/secret-store.ts';
import type { TranslationRequest, TranslationOutputMode } from '../../../../src/core/runtime-contract.ts';

declare const ChromeUtils: any;
declare const Services: any;
declare const IOUtils: any;
declare const PathUtils: any;
declare const Zotero: any;
declare const Components: any;
declare const Subprocess: any;

var FAKE_SENTINEL = 'TEST-ONLY-SENTINEL-NOT-A-REAL-KEY';
var TEST_ADDON_ID = 'orange-translate-dev@local.invalid';
var DRIVER_ID = 'orange-m2-real-0-driver@local.invalid';
var PROFILE_GUARD = /^d:\/orange translate-worktrees\/ds-m2c-powershell-bridge\/\.local\/m2-real-0\/runs\/[a-z0-9-]{1,48}\/profile$/;

var addonManager = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
var AddonManager = addonManager.AddonManager;

var control: any = null;
var sequence = 0;
var pendingWrites: Promise<unknown> = Promise.resolve();
var failed = false;

function normpath(value: any): string {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function profilePath(): string {
  return Services.dirsvc.get('ProfD', Components.interfaces.nsIFile).path;
}

function record(event: any): Promise<unknown> {
  var data = Object.assign({}, event, {
    seq: ++sequence,
    phase: control.phase,
    pid: Services.appinfo.processID,
    at: new Date().toISOString(),
  });
  pendingWrites = pendingWrites.then(function () {
    return IOUtils.writeUTF8(PathUtils.join(control.artifacts, 'evidence.jsonl'),
      JSON.stringify(data) + '\n', { mode: 'append' });
  });
  return pendingWrites;
}

function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* ---- host ports over IOUtils/PathUtils (no Node, no product change) ---- */

var files: BridgeFilePort = {
  isFreshDirectory: function (dir: string) {
    if (!IOUtils.exists(dir)) { return true; }
    try { return IOUtils.getChildren(dir).length === 0; } catch (e) { return false; }
  },
  mkdirp: function (dir: string) {
    return IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
  },
  writeText: function (p: string, text: string) {
    return IOUtils.writeUTF8(p, text);
  },
  readText: function (p: string) {
    try { return IOUtils.readUTF8(p); } catch (e) { return null; }
  },
  exists: function (p: string) {
    return IOUtils.exists(p);
  },
  size: function (p: string) {
    try { return IOUtils.stat(p).size; } catch (e) { return -1; }
  },
  removeRecursive: function (p: string) {
    try { return IOUtils.remove(p, { recursive: true, ignoreAbsent: true }); } catch (e) { return undefined; }
  },
};

var pdfValidator: PdfValidator = function (p: string) {
  var head = files.readText(p);
  return typeof head === 'string' && head.slice(0, 5) === '%PDF-' && files.size(p) > 0;
};

var clock = {
  now: function () { return Date.now(); },
  setTimeout: function (handler: () => void, ms: number) { return setTimeout(handler, ms); },
  clearTimeout: function (id: unknown) { clearTimeout(id as any); },
};

/* ---- per-case instrumentation ---- */

interface Sink {
  spawned: number;
  settled: number;
  pid: number | null;
  exitCode: number | null;
  killCalled: boolean;
  firstWriteAt: number | null;
  probeAt: number | null;
  stdout: string;
  stderr: string;
  stdoutTotal: number;
  stderrTotal: number;
}

function newSink(): Sink {
  return { spawned: 0, settled: 0, pid: null, exitCode: null, killCalled: false,
    firstWriteAt: null, probeAt: null, stdout: '', stderr: '', stdoutTotal: 0, stderrTotal: 0 };
}

function tapStream(source: SubprocessStream | null, sink: Sink, which: 'stdout' | 'stderr') {
  if (!source) { return null; }
  return (async function* () {
    for await (var chunk of source as AsyncIterable<string>) {
      if (typeof chunk === 'string') {
        if (which === 'stdout') {
          sink.stdoutTotal += chunk.length;
          sink.stdout = (sink.stdout + chunk).slice(-8192);
          if (sink.probeAt === null && chunk.indexOf('reader-live-probe') >= 0) {
            sink.probeAt = Date.now();
          }
        }
        else {
          sink.stderrTotal += chunk.length;
          sink.stderr = (sink.stderr + chunk).slice(-8192);
        }
      }
      yield chunk;
    }
  })();
}

function wrapHandle(handle: SubprocessProcessHandle, sink: Sink): SubprocessProcessHandle {
  var outTapped = false;
  var errTapped = false;
  var outGen: any = null;
  var errGen: any = null;
  var stdin = handle.stdin
    ? {
        write: function (bytes: Uint8Array) {
          if (sink.firstWriteAt === null) { sink.firstWriteAt = Date.now(); }
          return handle.stdin!.write(bytes);
        },
        close: function () { return handle.stdin!.close(); },
      }
    : null;
  return {
    get pid() { return handle.pid; },
    get exitCode() { return handle.exitCode; },
    get stdout() {
      if (!outTapped) { outTapped = true; outGen = tapStream(handle.stdout, sink, 'stdout'); }
      return outGen;
    },
    get stderr() {
      if (!errTapped) { errTapped = true; errGen = tapStream(handle.stderr, sink, 'stderr'); }
      return errGen;
    },
    get stdin() { return stdin; },
    wait: function () {
      return handle.wait().then(function (r) {
        sink.settled += 1;
        sink.exitCode = r ? r.exitCode : null;
        return r;
      });
    },
    kill: function (timeoutSeconds?: number) {
      sink.killCalled = true;
      return handle.kill(timeoutSeconds);
    },
  };
}

function makePort(sink: Sink): SubprocessPort {
  var base = createSubprocessPort({ call: function (o: any) { return Subprocess.call(o); } });
  return {
    call: async function (options) {
      var handle = await base.call(options);
      sink.spawned += 1;
      sink.pid = handle.pid;
      // Bounded child-start evidence, written by the driver itself: no payload,
      // no secret, no command line. The runner treats childLaunched as true
      // only when this record is present.
      await record({ op: 'child-started', childPid: handle.pid });
      return wrapHandle(handle, sink);
    },
  };
}

function fakeStore(): SecretStorePort {
  return {
    save: async function () { return undefined; },
    retrieveForJob: async function (providerId: string, jobId: string) {
      return { state: 'ready', providerId: providerId, jobId: jobId, apiKey: FAKE_SENTINEL };
    },
    delete: async function () { return undefined; },
  };
}

/* ---- request construction ---- */

function makeRequest(jobId: string, outputDir: string, childCase: string, mode: TranslationOutputMode): TranslationRequest {
  return {
    schemaVersion: 1,
    jobId: jobId,
    inputPdf: PathUtils.join(control.runRoot, 'synthetic-input.pdf'),
    outputDir: outputDir,
    language: { source: 'en', target: 'zh' },
    // childCase travels in provider.model: the only free-form field the frozen
    // request serializer forwards to the child.
    provider: { id: 'fake-provider', model: childCase },
    outputMode: mode,
  } as TranslationRequest;
}

function newBridge(sink: Sink, timeouts: any, withStore: boolean) {
  return new PowershellBridge({
    executablePath: control.powershell,
    childScriptPath: control.childScript,
    subprocess: makePort(sink),
    files: files,
    clock: clock,
    pdfValidator: pdfValidator,
    timeouts: timeouts,
    secretStore: withStore ? fakeStore() : undefined,
  });
}

function jobDir(name: string): string {
  var dir = PathUtils.join(control.artifacts, 'jobs', name);
  files.removeRecursive(dir);
  return dir;
}

/* ---- cases ---- */

async function caseStart() {
  var sink = newSink();
  var dir = jobDir('start');
  var bridge = newBridge(sink, { startupMs: 30000, translationMs: 30000 }, false);
  var result: any = await bridge.translate(makeRequest('11111111-1111-4111-8111-111111111111', dir, 'success', 'both'));
  var ok = !!(result && result.status === 'completed'
    && result.outputs && result.outputs.dualPdf && result.outputs.monoPdf
    && files.exists(result.outputs.dualPdf) && files.exists(result.outputs.monoPdf)
    && sink.pid !== null && sink.pid > 0 && sink.exitCode === 0);
  await record({ op: 'case', case: 'R0-01-start', verdict: ok ? 'PASS' : 'FAIL',
    pid: sink.pid, exitCode: sink.exitCode, spawned: sink.spawned, settled: sink.settled,
    status: result && result.status, checks: [
      { name: 'completed', ok: !!(result && result.status === 'completed') },
      { name: 'outputs-present', ok: !!(result && result.outputs && result.outputs.dualPdf && result.outputs.monoPdf) },
      { name: 'handle-pid-recorded', ok: sink.pid !== null && sink.pid > 0 },
      { name: 'child-exit-0', ok: sink.exitCode === 0 },
    ], stdout: sink.stdout, stderr: sink.stderr });
  return { verdict: ok ? 'PASS' : 'FAIL' };
}

async function caseStdin() {
  var sink = newSink();
  var dir = jobDir('stdin');
  var bridge = newBridge(sink, { startupMs: 30000, translationMs: 30000, secretWriteMs: 10000 }, true);
  var result: any = await bridge.translate(makeRequest('22222222-2222-4222-8222-222222222222', dir, 'success', 'both'));
  var ackOk = /stdin-ack provider=fake-provider jobMatch=True keyLength=\d+/.test(sink.stdout);
  var stdoutOk = sink.stdout.indexOf('stdout-complete case=success') >= 0;
  var stderrOk = sink.stderr.indexOf('stderr-marker case=success') >= 0;
  var ok = !!(result && result.status === 'completed' && ackOk && stdoutOk && stderrOk);
  await record({ op: 'case', case: 'R0-02-04-stdin-stdout-stderr', verdict: ok ? 'PASS' : 'FAIL',
    status: result && result.status, checks: [
      { name: 'stdin-ack', ok: ackOk },
      { name: 'stdout-marker', ok: stdoutOk },
      { name: 'stderr-marker', ok: stderrOk },
    ], stdout: sink.stdout, stderr: sink.stderr,
    sentinelLeaked: (sink.stdout + sink.stderr).indexOf(FAKE_SENTINEL) >= 0 });
  return { verdict: ok ? 'PASS' : 'FAIL' };
}

async function caseReaderAfter() {
  var sink = newSink();
  var dir = jobDir('readerafter');
  var bridge = newBridge(sink, { startupMs: 30000, translationMs: 30000, secretWriteMs: 10000 }, true);
  var result: any = await bridge.translate(makeRequest('33333333-3333-4333-8333-333333333333', dir, 'readerafter', 'both'));
  var ordered = sink.probeAt !== null && sink.firstWriteAt !== null && sink.probeAt <= sink.firstWriteAt;
  var ok = !!(result && result.status === 'completed' && ordered);
  await record({ op: 'case', case: 'R0-05-readers-live-before-write', verdict: ok ? 'PASS' : 'FAIL',
    status: result && result.status, probeAt: sink.probeAt, firstWriteAt: sink.firstWriteAt, checks: [
      { name: 'reader-probe-before-frame-write', ok: ordered },
      { name: 'completed', ok: !!(result && result.status === 'completed') },
    ], stdout: sink.stdout });
  return { verdict: ok ? 'PASS' : 'FAIL' };
}

async function casePressure() {
  var sink = newSink();
  var dir = jobDir('pressure');
  var bridge = newBridge(sink, { startupMs: 30000, translationMs: 60000, secretWriteMs: 20000 }, true);
  var result: any = await bridge.translate(makeRequest('44444444-4444-4444-8444-444444444444', dir, 'pressure', 'both'));
  var stdoutChars = sink.stdoutTotal;
  var stderrChars = sink.stderrTotal;
  var ok = !!(result && result.status === 'completed' && stdoutChars > 20000 && stderrChars > 20000);
  await record({ op: 'case', case: 'R0-06-pipe-pressure', verdict: ok ? 'PASS' : 'FAIL',
    status: result && result.status, exitCode: sink.exitCode, stdoutChars: stdoutChars, stderrChars: stderrChars,
    checks: [
      { name: 'no-deadlock-completed', ok: !!(result && result.status === 'completed') },
      { name: 'bounded-stdout-captured', ok: stdoutChars > 20000 },
      { name: 'bounded-stderr-captured', ok: stderrChars > 20000 },
    ] });
  return { verdict: ok ? 'PASS' : 'FAIL' };
}

async function caseExitNonZero() {
  var sink = newSink();
  var dir = jobDir('exitnonzero');
  var bridge = newBridge(sink, { startupMs: 30000, translationMs: 30000 }, false);
  var result: any = await bridge.translate(makeRequest('55555555-5555-4555-8555-555555555555', dir, 'exitnonzero', 'both'));
  var ok = !!(result && result.status === 'failed' && result.error && result.error.code === 'PROCESS_EXIT_NONZERO');
  await record({ op: 'case', case: 'R0-07-exit-nonzero', verdict: ok ? 'PASS' : 'FAIL',
    status: result && result.status, code: result && result.error && result.error.code, exitCode: sink.exitCode,
    checks: [
      { name: 'reported-failed-not-completed', ok: !!(result && result.status === 'failed') },
      { name: 'stable-code', ok: !!(result && result.error && result.error.code === 'PROCESS_EXIT_NONZERO') },
    ] });
  return { verdict: ok ? 'PASS' : 'FAIL' };
}

async function caseTimeout() {
  var sink = newSink();
  var dir = jobDir('sleep');
  var bridge = newBridge(sink, { startupMs: 30000, translationMs: 5000 }, false);
  var started = Date.now();
  var result: any = await bridge.translate(makeRequest('66666666-6666-4666-8666-666666666666', dir, 'sleep', 'both'));
  var elapsed = Date.now() - started;
  var ok = !!(result && result.status === 'failed' && result.error && result.error.code === 'TRANSLATION_TIMEOUT'
    && sink.killCalled && Number.isInteger(sink.exitCode) && elapsed < 30000);
  await record({ op: 'case', case: 'R0-08-timeout-cleanup', verdict: ok ? 'PASS' : 'FAIL',
    status: result && result.status, code: result && result.error && result.error.code,
    killCalled: sink.killCalled, exitCode: sink.exitCode, elapsedMs: elapsed,
    checks: [
      { name: 'timeout-code', ok: !!(result && result.error && result.error.code === 'TRANSLATION_TIMEOUT') },
      { name: 'kill-issued', ok: sink.killCalled },
      { name: 'child-exit-confirmed', ok: Number.isInteger(sink.exitCode) },
    ] });
  return { verdict: ok ? 'PASS' : 'FAIL' };
}

async function caseCancel() {
  var sink = newSink();
  var dir = jobDir('cancelwait');
  var bridge = newBridge(sink, { startupMs: 30000, translationMs: 60000 }, false);
  var jobId = '77777777-7777-4777-8777-777777777777';
  var translatePromise = bridge.translate(makeRequest(jobId, dir, 'cancelwait', 'both'));
  var deadline = Date.now() + 20000;
  while (sink.pid === null && Date.now() < deadline) { await sleep(100); }
  await sleep(800);
  var cancelError: string | null = null;
  try { await bridge.cancel(jobId); } catch (e) { cancelError = String(e); }
  var result: any = await translatePromise;
  var ok = !!(cancelError === null && result && result.status === 'cancelled' && sink.killCalled
    && Number.isInteger(sink.exitCode));
  await record({ op: 'case', case: 'R0-09-cancel-cleanup', verdict: ok ? 'PASS' : 'FAIL',
    status: result && result.status, cancelError: cancelError, killCalled: sink.killCalled,
    exitCode: sink.exitCode, checks: [
      { name: 'cancel-resolved', ok: cancelError === null },
      { name: 'settled-cancelled', ok: !!(result && result.status === 'cancelled') },
      { name: 'child-exit-confirmed', ok: Number.isInteger(sink.exitCode) },
    ] });
  return { verdict: ok ? 'PASS' : 'FAIL' };
}

async function caseRepeat() {
  var cycles: any[] = [];
  var ok = true;
  for (var i = 1; i <= 3; i++) {
    var sink = newSink();
    var dir = jobDir('repeat-' + i);
    var bridge = newBridge(sink, { startupMs: 30000, translationMs: 30000 }, false);
    var jobId = '8' + i + '0000000-0000-4000-8000-00000000000' + i;
    var result: any = await bridge.translate(makeRequest(jobId, dir, 'success', 'both'));
    var cycleOk = !!(result && result.status === 'completed') && sink.spawned === 1 && sink.settled === 1
      && sink.exitCode === 0 && Number.isInteger(sink.pid);
    if (!cycleOk) { ok = false; }
    cycles.push({ cycle: i, ok: cycleOk, pid: sink.pid, spawned: sink.spawned, settled: sink.settled, exitCode: sink.exitCode });
  }
  await record({ op: 'case', case: 'R0-10-repeat-cycles', verdict: ok ? 'PASS' : 'FAIL', cycles: cycles, checks: [
    { name: 'three-isolated-completions', ok: ok },
    { name: 'no-duplicate-reader-or-stale-child', ok: cycles.every(function (c) { return c.spawned === 1 && c.settled === 1; }) },
  ] });
  return { verdict: ok ? 'PASS' : 'FAIL' };
}

async function importCandidate(): Promise<any> {
  var install = await AddonManager.getInstallForFile(Zotero.File.pathToFile(control.candidate));
  if (!install || install.addon.id !== TEST_ADDON_ID) { throw new Error('Wrong candidate identity'); }
  await install.install();
  var deadline = Date.now() + 30000;
  var active = null;
  while (Date.now() < deadline) {
    active = await AddonManager.getAddonByID(TEST_ADDON_ID);
    if (active && active.isActive) { break; }
    await sleep(200);
  }
  if (!active || !active.isActive) { throw new Error('Candidate did not activate'); }
  var scope = Services.scriptloader.loadSubScriptWithOptions(
    'jar:' + Zotero.File.pathToFile(control.candidate).path + '!/bootstrap.js',
    { target: {}, ignoreCache: true });
  return scope;
}

/* ---- phase orchestration ---- */

async function runCasesPhase(): Promise<void> {
  await record({ op: 'phase-cases-start' });
  var outcomes: any = {};
  outcomes['R0-01-start'] = await caseStart();
  outcomes['R0-02-04-stdin-stdout-stderr'] = await caseStdin();
  outcomes['R0-05-readers-live-before-write'] = await caseReaderAfter();
  outcomes['R0-06-pipe-pressure'] = await casePressure();
  outcomes['R0-07-exit-nonzero'] = await caseExitNonZero();
  outcomes['R0-08-timeout-cleanup'] = await caseTimeout();
  outcomes['R0-09-cancel-cleanup'] = await caseCancel();
  outcomes['R0-10-repeat-cycles'] = await caseRepeat();
  await record({ op: 'phase-cases-complete', outcomes: outcomes });
}

async function runShutdownPhase(): Promise<void> {
  await record({ op: 'phase-shutdown-start' });
  // Genuine safe skip: R0-11 is NOT-CHECKED and we do NOT instantiate or spawn
  // the bridge/child. A child active across a full host shutdown cannot have its
  // post-host termination safely observed or confirmed from inside this process
  // (runner's process-table checks only cover zotero.exe), so launching one would
  // risk an unverified 300s orphan. Record the skip explicitly and quit normally.
  await record({ op: 'case', case: 'R0-11-shutdown-with-child', verdict: 'NOT-CHECKED',
    reason: 'skipped: child-active shutdown is not exercised because post-host child-family termination cannot be safely observed or confirmed',
    childStarted: false, childPid: null });
  await record({ op: 'phase-shutdown-quit-request' });
  Zotero.Utilities.Internal.quit();
}

/* ---- plugin entry points ---- */

export function install(_data: any, _reason: number): void { return undefined; }

export async function startup(data: any, reason: number): Promise<void> {
  try {
    Services.io.offline = true;
    void data;
    var prof = normpath(profilePath());
    var match = prof.match(PROFILE_GUARD);
    if (!match) { throw new Error('Driver refuses non-isolated profile'); }
    var root = PathUtils.parent(profilePath());
    control = JSON.parse(await IOUtils.readUTF8(PathUtils.join(root, 'control.json')));
    if (!control || control.driverId !== DRIVER_ID) { throw new Error('Control identity mismatch'); }
    if (normpath(control.profile) !== prof
      || normpath(control.data) !== normpath(PathUtils.join(root, 'data'))
      || normpath(control.artifacts) !== normpath(PathUtils.join(root, 'artifacts'))) {
      throw new Error('Control root mismatch');
    }
    await record({ op: 'driver-startup', reason: reason, version: Zotero.version,
      buildID: Services.appinfo.appBuildID, offline: Services.io.offline,
      powershell: control.powershell, childScript: control.childScript });
    if (control.phase === 'install') {
      // One-time UI install opening. Record readiness and return WITHOUT
      // importing the candidate, running any case, spawning the child, or
      // requesting quit, so the visible host stays open while the user installs
      // the driver through Tools -> Plugins. The user closes Zotero normally.
      await record({ op: 'install-ready', driverId: DRIVER_ID,
        candidateImported: false, childStarted: false });
      return;
    }
    if (control.phase === 'cases') { await importCandidate(); await runCasesPhase(); }
    else if (control.phase === 'shutdown') { await runShutdownPhase(); }
    else { throw new Error('Unknown phase'); } // unexpected phases stay fail-closed
    if (failed) { throw new Error('Earlier failure'); }
    if (control.phase !== 'shutdown') {
      await record({ op: 'quit-request' });
      Zotero.Utilities.Internal.quit();
    }
  }
  catch (e) {
    failed = true;
    try { await record({ op: 'error', message: String(e), stage: 'startup' }); } catch (ignored) { /* ignore */ }
    try { Zotero.logError(e); } catch (ignored) { /* ignore */ }
    Zotero.Utilities.Internal.quit();
  }
}

export function shutdown(_data: any, reason: number): Promise<unknown> {
  return record({ op: 'driver-shutdown', reason: reason });
}

export function uninstall(_data: any, _reason: number): void { return undefined; }
