// M2C PowerShell bridge tests (owner: M2C-POWERSHELL-BRIDGE / DS).
//
// Drives the real PowershellBridge through an injected fake Subprocess host,
// a synthetic filesystem under the D-drive worktree .local, a manual clock and
// a synthetic PDF validator. No real Runtime, PowerShell, network, provider,
// credential or Zotero access is involved. These tests prove adapter logic
// only; they do not prove Zotero module import or Windows Job Object behavior.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PowershellBridge,
  REQUEST_FILE_NAME,
  RESULT_FILE_NAME,
  redactDiagnostic,
  serializeBridgeRequest,
} from '../src/runtime/powershell-bridge.ts';
import {
  adaptZoteroProcess,
  createSubprocessPort,
} from '../src/zotero/subprocess-host.ts';
import {
  FakeSubprocessHost,
  SYNTHETIC_PDF,
  createFakeFiles,
  createManualClock,
  looksLikePdf,
} from './fixtures/fake-subprocess.mjs';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var TMP_ROOT = path.join(ROOT, '.local', 'tmp');

var tmpDirs = [];
function makeJobDir(label) {
  const dir = mkdtempSync(path.join(TMP_ROOT, label + '-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

var CHILD_SCRIPT = path.join(ROOT, 'tests', 'fixtures', 'fake-bridge-child.ps1');
var FAKE_POWERSHELL = path.join(ROOT, '.local', 'tmp', 'fake-powershell.exe');
// The file port checks existence without launching; make the fake executable
// (and the child script) present so availability resolves to 'available'.
mkdirSync(path.dirname(FAKE_POWERSHELL), { recursive: true });
writeFileSync(FAKE_POWERSHELL, 'synthetic-not-executed');

function makeRequest(jobDir, overrides = {}) {
  const inputPdf = path.join(jobDir, 'in.pdf');
  writeFileSync(inputPdf, SYNTHETIC_PDF);
  return {
    schemaVersion: 1,
    jobId: '11111111-2222-3333-4444-555555555555',
    inputPdf,
    outputDir: path.join(jobDir, 'out'),
    language: { source: 'en', target: 'zh' },
    provider: { id: 'deepseek', model: 'deepseek-v4.1-flash', baseUrl: 'https://api.example.com/v1' },
    outputMode: 'both',
    ...overrides,
  };
}

function makeBridge(host, overrides = {}) {
  const clock = createManualClock();
  const files = createFakeFiles();
  const bridge = new PowershellBridge({
    executablePath: FAKE_POWERSHELL,
    childScriptPath: CHILD_SCRIPT,
    subprocess: host,
    files,
    clock,
    pdfValidator: looksLikePdf,
    timeouts: { startupMs: 1000, translationMs: 1000 },
    ...overrides,
  });
  return { bridge, clock, files };
}

describe('success path', () => {
  it('completes dual+mono with a fresh job dir and a schema-v1 result', async () => {
    const host = new FakeSubprocessHost({ resultSpec: { kind: 'success', outputKinds: ['dualPdf', 'monoPdf'] } });
    const jobDir = makeJobDir('ok');
    const request = makeRequest(jobDir);
    const { bridge } = makeBridge(host);
    const result = await bridge.translate(request);
    assert.equal(result.status, 'completed');
    assert.equal(result.jobId, request.jobId);
    assert.ok(result.outputs.dualPdf.startsWith(request.outputDir));
    assert.ok(result.outputs.monoPdf.startsWith(request.outputDir));
    assert.equal(existsSync(result.outputs.dualPdf), true);
    assert.equal(result.runtime.version, 'fake-child-1.0.0');
  });

  it('accepts exactly the mode-required outputs (dual only)', async () => {
    const host = new FakeSubprocessHost({ resultSpec: { kind: 'success', outputKinds: ['dualPdf'] } });
    const jobDir = makeJobDir('dual');
    const { bridge } = makeBridge(host);
    const result = await bridge.translate(makeRequest(jobDir, { outputMode: 'dual' }));
    assert.equal(result.status, 'completed');
    assert.equal(typeof result.outputs.dualPdf, 'string');
    assert.equal(result.outputs.monoPdf, undefined);
  });

  it('builds fixed arguments plus job file paths and never free text', async () => {
    const host = new FakeSubprocessHost({ resultSpec: { kind: 'success', outputKinds: ['dualPdf'] } });
    const jobDir = makeJobDir('argv');
    const request = makeRequest(jobDir, { outputMode: 'dual', provider: { id: 'deepseek', baseUrl: 'https://api.example.com/v1' } });
    const { bridge } = makeBridge(host);
    await bridge.translate(request);
    const args = host.callOptions[0].arguments;
    assert.equal(host.callOptions[0].command, FAKE_POWERSHELL);
    assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
    assert.equal(args.includes(request.inputPdf), false);
    assert.equal(args.join(' ').includes('api.example.com'), false);
    assert.equal(args.join(' ').includes('deepseek-v4.1-flash'), false);
  });

  it('does not forward baseUrl into the request file', () => {
    const jobDir = makeJobDir('reqfile');
    const text = serializeBridgeRequest(makeRequest(jobDir));
    assert.equal(text.includes('api.example.com'), false);
    const parsed = JSON.parse(text);
    assert.equal(parsed.provider.baseUrl, undefined);
    assert.equal(parsed.provider.id, 'deepseek');
  });
});

describe('failure paths', () => {
  it('fails closed on a non-zero exit and discards partial outputs', async () => {
    const host = new FakeSubprocessHost({ behavior: { exitMode: 'exit', exitCode: 3 }, resultSpec: { kind: 'success', outputKinds: ['dualPdf'] } });
    const jobDir = makeJobDir('nonzero');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge } = makeBridge(host);
    const result = await bridge.translate(request);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'PROCESS_EXIT_NONZERO');
    assert.equal(existsSync(request.outputDir), false);
  });

  it('fails on a malformed result file', async () => {
    const host = new FakeSubprocessHost({ resultSpec: { kind: 'malformed' } });
    const jobDir = makeJobDir('malformed');
    const { bridge } = makeBridge(host);
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.error.code, 'RESULT_MALFORMED');
  });

  it('fails on a result that belongs to another job', async () => {
    const host = new FakeSubprocessHost({ resultSpec: { kind: 'mismatch' } });
    const jobDir = makeJobDir('mismatch');
    const { bridge } = makeBridge(host);
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.error.code, 'RESULT_JOB_MISMATCH');
  });

  it('fails when a required output is missing', async () => {
    const host = new FakeSubprocessHost({ resultSpec: { kind: 'success', outputKinds: ['dualPdf'], dropRequired: 'monoPdf' } });
    const jobDir = makeJobDir('missing');
    const { bridge } = makeBridge(host);
    const result = await bridge.translate(makeRequest(jobDir, { outputMode: 'both' }));
    assert.equal(result.error.code, 'MISSING_REQUIRED_OUTPUT');
  });

  it('fails when a produced output is empty', async () => {
    const host = new FakeSubprocessHost({ resultSpec: { kind: 'success', outputKinds: ['dualPdf'], emptyOutput: 'dualPdf' } });
    const jobDir = makeJobDir('empty');
    const { bridge } = makeBridge(host);
    const result = await bridge.translate(makeRequest(jobDir, { outputMode: 'dual' }));
    assert.equal(result.error.code, 'OUTPUT_EMPTY');
  });

  it('fails when a produced output escapes the job directory', async () => {
    const host = new FakeSubprocessHost({ resultSpec: { kind: 'success', outputKinds: ['dualPdf'], escapePath: 'C:/Windows/escaped.pdf' } });
    const jobDir = makeJobDir('escape');
    const { bridge } = makeBridge(host);
    const result = await bridge.translate(makeRequest(jobDir, { outputMode: 'dual' }));
    assert.equal(result.error.code, 'OUTPUT_OUTSIDE_JOB_DIR');
  });

  it('fails when the PDF validation port rejects a produced file', async () => {
    const host = new FakeSubprocessHost({ resultSpec: { kind: 'success', outputKinds: ['dualPdf'] } });
    const jobDir = makeJobDir('badpdf');
    const { bridge } = makeBridge(host, { pdfValidator: () => false });
    const result = await bridge.translate(makeRequest(jobDir, { outputMode: 'dual' }));
    assert.equal(result.error.code, 'PDF_VALIDATION_FAILED');
  });

  it('fails closed when the output directory is not fresh', async () => {
    const host = new FakeSubprocessHost({ resultSpec: { kind: 'success', outputKinds: ['dualPdf'] } });
    const jobDir = makeJobDir('dirty');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    mkdirSync(request.outputDir, { recursive: true });
    writeFileSync(path.join(request.outputDir, 'leftover.txt'), 'stale');
    const { bridge } = makeBridge(host);
    const result = await bridge.translate(request);
    assert.equal(result.error.code, 'JOB_DIR_NOT_FRESH');
    assert.equal(host.callCount, 0);
  });

  it('fails on a spawn failure', async () => {
    const host = new FakeSubprocessHost({ callRejects: true });
    const jobDir = makeJobDir('spawn');
    const { bridge } = makeBridge(host);
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.error.code, 'SPAWN_FAILED');
  });
});

describe('timeouts and cancellation', () => {
  it('times out startup when the process never spawns in time', async () => {
    const host = new FakeSubprocessHost();
    host.call = () => new Promise(() => {});
    const jobDir = makeJobDir('startuptimeout');
    const { bridge, clock } = makeBridge(host, { timeouts: { startupMs: 50, translationMs: 1000 } });
    const pending = bridge.translate(makeRequest(jobDir, { outputMode: 'dual' }));
    clock.fireAll();
    const result = await pending;
    assert.equal(result.error.code, 'STARTUP_TIMEOUT');
  });

  it('times out translation, kills the owned handle and discards outputs', async () => {
    const host = new FakeSubprocessHost({ behavior: { exitMode: 'hang' } });
    const jobDir = makeJobDir('translatetimeout');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge, clock } = makeBridge(host, { timeouts: { startupMs: 1000, translationMs: 50 } });
    const pending = bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    clock.fireAll();
    const result = await pending;
    assert.equal(result.error.code, 'TRANSLATION_TIMEOUT');
    assert.equal(host.processes[0].killed, true);
    assert.equal(existsSync(request.outputDir), false);
  });

  it('cancels the active job and settles cancelled with no consumable paths', async () => {
    const host = new FakeSubprocessHost({ behavior: { exitMode: 'hang' } });
    const jobDir = makeJobDir('cancel');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge } = makeBridge(host);
    const pending = bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await bridge.cancel(request.jobId);
    assert.equal(host.processes[0].killed, true);
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.outputs, undefined);
    assert.equal(existsSync(request.outputDir), false);
  });

  it('a cancel for another job does not affect the active job', async () => {
    const host = new FakeSubprocessHost({ behavior: { exitMode: 'hang' } });
    const jobDir = makeJobDir('cancelother');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge } = makeBridge(host);
    const pending = bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await bridge.cancel('99999999-0000-1111-2222-333333333333');
    assert.equal(host.processes[0].killed, false);
    await bridge.cancel(request.jobId);
    const result = await pending;
    assert.equal(result.status, 'cancelled');
  });

  it('rejects a second concurrent job while one is active', async () => {
    const host = new FakeSubprocessHost({ behavior: { exitMode: 'hang' } });
    const jobDir = makeJobDir('busy');
    const first = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge } = makeBridge(host);
    const pending = bridge.translate(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = makeRequest(jobDir, { outputMode: 'dual', jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    const busy = await bridge.translate(second);
    assert.equal(busy.error.code, 'BRIDGE_BUSY');
    assert.equal(host.callCount, 1);
    await bridge.cancel(first.jobId);
    await pending;
  });
});

describe('startup lifecycle races (M2C review round 2)', () => {
  it('rejects a second job while the first spawn is still pending', async () => {
    const host = new FakeSubprocessHost({ delayedSpawn: true });
    const jobDir = makeJobDir('slowspawn');
    const { bridge } = makeBridge(host);
    const first = bridge.translate(makeRequest(jobDir, { outputMode: 'dual' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = bridge.translate(makeRequest(jobDir, { outputMode: 'dual', jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));
    const busy = await second;
    assert.equal(busy.error.code, 'BRIDGE_BUSY');
    assert.equal(host.callCount, 1);
    const cancelPromise = bridge.cancel('11111111-2222-3333-4444-555555555555');
    // cancel() must NOT resolve while the spawn is pending.
    let cancelSettled = false;
    cancelPromise.then(() => { cancelSettled = true; }, () => { cancelSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelSettled, false, 'cancel() must stay pending until the process is confirmed stopped');
    host.resolvePendingSpawn();
    await cancelPromise;
    assert.equal(host.processes.length, 1);
    assert.equal(host.processes[0].killed, true);
    const settled = await first;
    assert.equal(settled.status, 'cancelled');
  });

  it('cancellation during startup settles cancelled and kills the late handle', async () => {
    const host = new FakeSubprocessHost({ delayedSpawn: true });
    const jobDir = makeJobDir('cancelstart');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge } = makeBridge(host);
    const pending = bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelPromise = bridge.cancel(request.jobId);
    let cancelSettled = false;
    cancelPromise.then(() => { cancelSettled = true; }, () => { cancelSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelSettled, false, 'cancel() must stay pending during a pending spawn');
    host.resolvePendingSpawn();
    await cancelPromise;
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(host.processes.length, 1);
    assert.equal(host.processes[0].killed, true);
    assert.equal(existsSync(request.outputDir), false);
  });

  it('cancel during a pending spawn that then rejects still settles cancelled', async () => {
    const host = new FakeSubprocessHost({ delayedSpawn: true });
    const jobDir = makeJobDir('cancelreject');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge } = makeBridge(host);
    const pending = bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelPromise = bridge.cancel(request.jobId);
    let cancelSettled = false;
    cancelPromise.then(() => { cancelSettled = true; }, () => { cancelSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelSettled, false, 'cancel must wait for the spawn to settle');
    host.rejectPendingSpawn();
    await cancelPromise;
    const result = await pending;
    assert.equal(result.status, 'cancelled', 'a successful cancel must settle translate() as cancelled');
    assert.equal(result.outputs, undefined);
    assert.equal(existsSync(request.outputDir), false);
  });

  it('startup timeout with a pending cancel settles cancelled only after confirmation', async () => {
    const host = new FakeSubprocessHost({ delayedSpawn: true });
    const jobDir = makeJobDir('timeoutcancel');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge, clock } = makeBridge(host, { timeouts: { startupMs: 50, translationMs: 1000 } });
    const pending = bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelPromise = bridge.cancel(request.jobId);
    let cancelSettled = false;
    let translateSettled = false;
    cancelPromise.then(() => { cancelSettled = true; }, () => { cancelSettled = true; });
    pending.then(() => { translateSettled = true; }, () => { translateSettled = true; });
    // Fire the startup timer BEFORE the spawn resolves.
    clock.fireAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cancelSettled, false, 'cancel must not settle before the stop is confirmed');
    assert.equal(translateSettled, false, 'translate must not settle early on a pending cancel');
    host.resolvePendingSpawn();
    await cancelPromise;
    const result = await pending;
    assert.equal(host.processes.length, 1);
    assert.equal(host.processes[0].killed, true, 'the late handle must be killed');
    assert.ok(host.processes[0].waitCalls >= 1, 'the stop must be confirmed via wait()');
    assert.equal(result.status, 'cancelled', 'a successful cancel settles translate() as cancelled');
    assert.equal(result.outputs, undefined);
    assert.equal(existsSync(request.outputDir), false, 'directory removed after confirmation');
  });

  it('keeps ownership during late reaping after STARTUP_TIMEOUT, then releases', async () => {
    const host = new FakeSubprocessHost({ delayedSpawn: true });
    const jobDir = makeJobDir('latespawn');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge, clock } = makeBridge(host, { timeouts: { startupMs: 50, translationMs: 1000 } });
    const pending = bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    clock.fireAll();
    const result = await pending;
    assert.equal(result.error.code, 'STARTUP_TIMEOUT');
    // A second job is still rejected while the late spawn is quarantined.
    const second = await bridge.translate(makeRequest(jobDir, { outputMode: 'dual', jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));
    assert.equal(second.error.code, 'BRIDGE_BUSY');
    assert.equal(existsSync(request.outputDir), true, 'directory stays quarantined while unconfirmed');
    // The late handle must be killed and its directory discarded.
    host.resolvePendingSpawn();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(host.processes.length, 1);
    assert.equal(host.processes[0].killed, true);
    assert.equal(existsSync(request.outputDir), false);
    // Ownership released: a fresh job is accepted again (not BRIDGE_BUSY). It
    // is accepted (and would await its own spawn), so race a short timer instead
    // of blocking on the never-resolving delayed spawn.
    const third = await Promise.race([
      bridge.translate(makeRequest(jobDir, { outputMode: 'dual', jobId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' })),
      new Promise((resolve) => setTimeout(() => resolve({ error: { code: 'STILL_PENDING' } }), 20)),
    ]);
    assert.notEqual(third.error && third.error.code, 'BRIDGE_BUSY');
  });
});

describe('exit confirmation (M2C review round 2)', () => {
  it('fails EXIT_UNCONFIRMED when wait() rejects and keeps ownership', async () => {
    const host = new FakeSubprocessHost({ behavior: { exitMode: 'hang', waitMode: 'reject' } });
    const jobDir = makeJobDir('waitreject');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge, clock } = makeBridge(host, { timeouts: { startupMs: 1000, translationMs: 50 } });
    const pending = bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    clock.fireAll();
    const result = await pending;
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'EXIT_UNCONFIRMED');
    // Exit was not confirmed: the output directory must NOT be deleted.
    assert.equal(existsSync(request.outputDir), true, 'directory must survive an unconfirmed timeout');
  });

  it('fails EXIT_UNCONFIRMED on a timeout when wait() returns a null exit code', async () => {
    const host = new FakeSubprocessHost({ behavior: { exitMode: 'hang', waitMode: 'nullExit' } });
    const jobDir = makeJobDir('nullexit');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge, clock } = makeBridge(host, { timeouts: { startupMs: 1000, translationMs: 50 } });
    const pending = bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    clock.fireAll();
    const result = await pending;
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'EXIT_UNCONFIRMED');
    assert.equal(existsSync(request.outputDir), true, 'a null exit code is not a confirmed stop');
  });

  it('settles EXIT_UNCONFIRMED promptly with never-ending streams (no EOF wait)', async () => {
    const host = new FakeSubprocessHost({ behavior: { exitMode: 'hang', waitMode: 'reject', neverEndingStreams: true } });
    const jobDir = makeJobDir('noeof-timeout');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge, clock } = makeBridge(host, { timeouts: { startupMs: 1000, translationMs: 50 } });
    const pending = bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    clock.fireAll();
    const raced = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 300)),
    ]);
    assert.notEqual(raced, 'HUNG', 'timeout must settle without waiting for stream EOF');
    assert.equal(raced.status, 'failed');
    assert.equal(raced.error.code, 'EXIT_UNCONFIRMED');
    assert.equal(existsSync(request.outputDir), true, 'directory is retained on unconfirmed exit');
  });

  it('rejects cancel promptly with never-ending streams and preserves ownership', async () => {
    const host = new FakeSubprocessHost({ behavior: { exitMode: 'hang', waitMode: 'reject', neverEndingStreams: true } });
    const jobDir = makeJobDir('noeof-cancel');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge } = makeBridge(host);
    void bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const raced = await Promise.race([
      bridge.cancel(request.jobId).then(() => 'RESOLVED', () => 'REJECTED'),
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 300)),
    ]);
    assert.equal(raced, 'REJECTED', 'cancel must reject promptly, not hang on stream EOF');
    assert.equal(existsSync(request.outputDir), true, 'directory is retained on unconfirmed cancel');
  });

  it('treats a non-integer (NaN) exit code as unconfirmed', async () => {
    const host = new FakeSubprocessHost({ behavior: { exitMode: 'hang', waitMode: 'nanExit' } });
    const jobDir = makeJobDir('nanexit');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge, clock } = makeBridge(host, { timeouts: { startupMs: 1000, translationMs: 50 } });
    const pending = bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    clock.fireAll();
    const raced = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 300)),
    ]);
    assert.notEqual(raced, 'HUNG');
    assert.equal(raced.status, 'failed');
    assert.equal(raced.error.code, 'EXIT_UNCONFIRMED');
  });

  it('reports CANCEL_NOT_HONORED when kill cannot confirm exit', async () => {
    const host = new FakeSubprocessHost({ behavior: { exitMode: 'hang', waitMode: 'reject' } });
    const jobDir = makeJobDir('cancelunconfirmed');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    const { bridge } = makeBridge(host);
    void bridge.translate(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(() => bridge.cancel(request.jobId));
    // Unconfirmed cancel must not delete the directory or clear ownership.
    assert.equal(existsSync(request.outputDir), true, 'directory must survive an unconfirmed cancel');
  });
});

describe('redaction', () => {
  it('never includes child stream content in messageRedacted', async () => {
    const host = new FakeSubprocessHost({
      behavior: { exitMode: 'exit', exitCode: 5 },
      resultSpec: { kind: 'none' },
    });
    const jobDir = makeJobDir('redact');
    const request = makeRequest(jobDir, { outputMode: 'dual' });
    // Force a leaky stream by overriding the process stdout/stderr content.
    const bridgeFiles = createFakeFiles();
    const bridge = new PowershellBridge({
      executablePath: FAKE_POWERSHELL,
      childScriptPath: CHILD_SCRIPT,
      subprocess: {
        async call(options) {
          const handle = await host.call(options);
          handle.stdout = { async *[Symbol.asyncIterator]() { yield 'reading C:\\Users\\GCR\\My Documents\\secret paper.pdf'; yield 'api_key=sk-ABCDEF0123456789'; } };
          handle.stderr = { async *[Symbol.asyncIterator]() { yield 'the document says "CONFIDENTIAL TEXT"'; } };
          return handle;
        },
      },
      files: bridgeFiles,
      clock: createManualClock(),
      pdfValidator: looksLikePdf,
      timeouts: { startupMs: 1000, translationMs: 1000 },
    });
    const result = await bridge.translate(request);
    assert.equal(result.status, 'failed');
    const text = result.error.messageRedacted;
    // A fixed, safe message: nothing from the child stream may survive.
    assert.equal(text, 'the translation process exited with an error');
    assert.equal(text.includes('C:\\Users'), false);
    assert.equal(text.includes('My Documents'), false);
    assert.equal(text.includes('sk-ABCDEF'), false);
    assert.equal(text.includes('CONFIDENTIAL'), false);
  });

  it('maps an unrecognized child error.code to a fixed safe code', async () => {
    const host = new FakeSubprocessHost({
      resultSpec: { kind: 'failed', code: 'C:\\Users\\GCR\\secret\\paper.pdf sk-ABCDEF0123456789', message: 'leaky' },
    });
    const jobDir = makeJobDir('evilcode');
    const { bridge } = makeBridge(host);
    const result = await bridge.translate(makeRequest(jobDir, { outputMode: 'dual' }));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'CHILD_ERROR_UNRECOGNIZED');
    assert.equal(JSON.stringify(result).includes('sk-ABCDEF'), false);
    assert.equal(JSON.stringify(result).includes('paper.pdf'), false);
  });

  it('passes through a whitelisted child error.code with a fixed message', async () => {
    const host = new FakeSubprocessHost({ resultSpec: { kind: 'failed', code: 'PROVIDER_UNREACHABLE', message: 'x' } });
    const jobDir = makeJobDir('goodcode');
    const { bridge } = makeBridge(host);
    const result = await bridge.translate(makeRequest(jobDir, { outputMode: 'dual' }));
    assert.equal(result.error.code, 'PROVIDER_UNREACHABLE');
    assert.equal(result.error.messageRedacted, 'the translation provider could not be reached');
  });

  it('redactDiagnostic removes paths, secrets and quoted text', () => {
    const raw = 'PS> Get-File C:\\Users\\me\\a.pdf; api_key=sk-SECRET1234567890; "document body"';
    const out = redactDiagnostic(raw);
    assert.equal(out.includes('C:\\Users'), false);
    assert.equal(out.includes('sk-SECRET'), false);
    assert.equal(out.includes('document body'), false);
  });
});

describe('availability', () => {
  it('reports available when the executable is absolute and the script exists', async () => {
    const host = new FakeSubprocessHost();
    const { bridge } = makeBridge(host);
    const status = await bridge.checkAvailability();
    assert.equal(status.availability, 'available');
    assert.equal(host.callCount, 0);
  });

  it('reports incompatible for a non-absolute executable path', async () => {
    const host = new FakeSubprocessHost();
    const { bridge } = makeBridge(host, { executablePath: 'powershell.exe' });
    const status = await bridge.checkAvailability();
    assert.equal(status.availability, 'incompatible');
  });

  it('reports missing when the configured executable does not exist', async () => {
    const host = new FakeSubprocessHost();
    const missingExe = path.join(ROOT, '.local', 'tmp', 'does-not-exist-exec.exe');
    const { bridge } = makeBridge(host, { executablePath: missingExe });
    const status = await bridge.checkAvailability();
    assert.equal(status.availability, 'missing');
    assert.equal(host.callCount, 0);
  });
});

describe('core boundary purity', () => {
  function pipeOf(chunks) {
    let i = 0;
    return {
      async readString() {
        return i < chunks.length ? chunks[i++] : '';
      },
    };
  }

  it('sends only documented Subprocess.call options (no stdout)', async () => {
    const seen = [];
    const process = { pid: 1, exitCode: 0, stdout: pipeOf([]), stderr: pipeOf([]), kill() {}, wait: async () => ({ exitCode: 0 }) };
    const port = createSubprocessPort({
      call: async (options) => {
        seen.push(options);
        return process;
      },
    });
    await port.call({ command: 'C:/ps.exe', arguments: ['-File', 'c.ps1'], workdir: 'C:/job' });
    assert.deepEqual(Object.keys(seen[0]).sort(), ['arguments', 'command', 'stderr', 'workdir']);
    assert.equal('stdout' in seen[0], false);
    assert.equal(seen[0].stderr, 'pipe');
  });

  it('adapts stdout/stderr pipes into streams that stop at EOF', async () => {
    const process = {
      pid: 7, exitCode: 0, kill() {}, wait: async () => ({ exitCode: 0 }),
      stdout: pipeOf(['a', 'b']),
      stderr: pipeOf(['x']),
    };
    const handle = adaptZoteroProcess(process);
    const readAll = async (stream) => {
      let out = '';
      for await (const chunk of stream) { out += chunk; }
      return out;
    };
    assert.equal(await readAll(handle.stdout), 'ab');
    assert.equal(await readAll(handle.stderr), 'x');
  });

  it('converts kill(seconds) to milliseconds and awaits wait()', async () => {
    const killCalls = [];
    const process = {
      pid: 9, exitCode: 0, stdout: null, stderr: null,
      kill(ms) { killCalls.push(ms); },
      wait: async () => ({ exitCode: 0 }),
    };
    const handle = adaptZoteroProcess(process);
    handle.kill(0);
    handle.kill(2);
    const result = await handle.wait();
    assert.deepEqual(killCalls, [0, 2000]);
    assert.equal(result.exitCode, 0);
  });

  it('returns null streams when the process exposes no pipes', () => {
    const process = { pid: 1, exitCode: 0, kill() {}, wait: async () => ({ exitCode: 0 }) };
    const handle = adaptZoteroProcess(process);
    assert.equal(handle.stdout, null);
    assert.equal(handle.stderr, null);
  });
  function stripComments(source) {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
  }

  it('the bridge logic imports only relative core modules', () => {
    const text = stripComments(readFileSync(path.join(ROOT, 'src', 'runtime', 'powershell-bridge.ts'), 'utf8'));
    const specifiers = [...text.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
    for (const spec of specifiers) {
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), 'unexpected import: ' + spec);
      assert.ok(!spec.startsWith('node:'), 'core bridge must not import a Node builtin: ' + spec);
    }
    for (const token of ['child_process', 'require(', 'process.env', 'Zotero.', 'Components.', 'fetch(']) {
      assert.equal(text.includes(token), false, 'core bridge must not reference ' + token);
    }
  });

  it('the Zotero host port is the only file that mentions the Subprocess module', () => {
    const bridge = stripComments(readFileSync(path.join(ROOT, 'src', 'runtime', 'powershell-bridge.ts'), 'utf8'));
    assert.equal(bridge.includes('Subprocess.call'), false);
    const host = readFileSync(path.join(ROOT, 'src', 'zotero', 'subprocess-host.ts'), 'utf8');
    assert.ok(host.includes('subprocess.call('), 'the host port should call Subprocess.call');
  });
});
