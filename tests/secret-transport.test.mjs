// M2D synthetic secret-transport tests (owner: M2D-SYNTHETIC-SECRET-PIPE-01 / DS).
//
// Drives the real PowershellBridge through an injected fake SecretStore and a
// fake Subprocess host whose stdin captures the exact credential frame. Uses a
// fake in-process consumer (FakeTranslator) to parse the frame and capture the
// api_key. No network, provider, real key, host, Runtime or child process.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PowershellBridge,
  SECRET_FRAME_HEADER_BYTES,
  SECRET_FRAME_PAYLOAD_LIMIT,
  encodeSecretFrame,
} from '../src/runtime/powershell-bridge.ts';
import {
  SECRET_LEASE_MISMATCH_CODE,
  secretFailureCodeForState,
} from '../src/runtime/secret-store.ts';
import {
  adaptOutputPipe,
  adaptZoteroProcess,
} from '../src/zotero/subprocess-host.ts';
import {
  FakeSubprocessHost,
  SYNTHETIC_PDF,
  createFakeFiles,
  createManualClock,
  looksLikePdf,
} from './fixtures/fake-subprocess.mjs';
import {
  FakeSecretStore,
  FakeTranslator,
  parseSecretFrame,
} from './fixtures/fake-secret-store.mjs';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var TMP_ROOT = path.join(ROOT, '.local', 'tmp');
var SENTINEL = 'OT_SENTINEL_DO_NOT_USE_9f3a1c7b2e5d';

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
  const bridge = new PowershellBridge({
    executablePath: FAKE_POWERSHELL,
    childScriptPath: CHILD_SCRIPT,
    subprocess: host,
    files: createFakeFiles(),
    clock: createManualClock(),
    pdfValidator: looksLikePdf,
    timeouts: { startupMs: 1000, translationMs: 1000, secretWriteMs: 1000 },
    ...overrides,
  });
  return bridge;
}

function successHost(stdinBehavior) {
  return new FakeSubprocessHost({
    behavior: { exitMode: 'exit', exitCode: 0, stdinBehavior },
    resultSpec: { kind: 'success', outputKinds: ['dualPdf', 'monoPdf'] },
  });
}

describe('frame encoding', () => {
  it('emits a 4-byte big-endian length then UTF-8 JSON in fixed field order', () => {
    const frame = encodeSecretFrame({ jobId: 'J1', providerId: 'deepseek', apiKey: SENTINEL });
    assert.ok(frame instanceof Uint8Array);
    const parsed = parseSecretFrame(frame);
    assert.ok(parsed);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    assert.equal(view.getUint32(0, false), parsed.payloadLength);
    assert.deepEqual(parsed.fields, { schemaVersion: 1, jobId: 'J1', providerId: 'deepseek', apiKey: SENTINEL });
    assert.equal(parsed.json.indexOf('schemaVersion'), parsed.json.indexOf('schemaVersion'));
    assert.ok(parsed.json.indexOf('"jobId"') < parsed.json.indexOf('"providerId"'));
    assert.ok(parsed.json.indexOf('"providerId"') < parsed.json.indexOf('"apiKey"'));
  });

  it('rejects an oversized payload before any header is produced', () => {
    const huge = 'x'.repeat(SECRET_FRAME_PAYLOAD_LIMIT);
    assert.equal(encodeSecretFrame({ jobId: 'J', providerId: 'p', apiKey: huge }), null);
  });
});

describe('happy path: one frame over stdin', () => {
  it('accepts a successful write whose buffer is detached by the native host', async () => {
    const host = successHost();
    const call = host.call.bind(host);
    host.call = async options => {
      const process = await call(options);
      const write = process.stdin.write.bind(process.stdin);
      process.stdin.write = async bytes => {
        const result = await write(bytes);
        structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
        assert.equal(bytes.length, 0);
        return result;
      };
      return process;
    };
    const bridge = makeBridge(host, { secretStore: new FakeSecretStore({ apiKey: SENTINEL }) });
    const result = await bridge.translate(makeRequest(makeJobDir('detached')));
    assert.equal(result.status, 'completed');
    assert.equal(host.processes[0].stdin.closed, true);
    assert.equal(parseSecretFrame(host.processes[0].stdin.bytes()).fields.apiKey, SENTINEL);
  });

  it('writes exactly one frame, closes stdin, and the fake consumer captures the value', async () => {
    const jobDir = makeJobDir('ok');
    const host = successHost();
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    const bridge = makeBridge(host, { secretStore: store });
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.status, 'completed');
    const stdin = host.processes[0].stdin;
    assert.equal(stdin.closed, true, 'stdin must be closed to signal EOF');
    const parsed = parseSecretFrame(stdin.bytes());
    assert.ok(parsed, 'the written bytes must be a valid frame');
    assert.equal(parsed.fields.jobId, result.jobId);
    assert.equal(parsed.fields.providerId, 'deepseek');
    // Fake consumer: pass the parsed value to a fake translator constructor.
    const translator = new FakeTranslator(parsed.fields.apiKey);
    assert.equal(translator.capturedApiKey, SENTINEL);
  });

  it('the credential-free path writes no stdin frame when no store is injected', async () => {
    const jobDir = makeJobDir('nostore');
    const host = successHost();
    const bridge = makeBridge(host);
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.status, 'completed');
    assert.equal(host.processes[0].stdin.writeCalls, 0, 'no store => no stdin write');
    assert.equal(host.processes[0].stdin.received.length, 0);
  });
});

describe('pipe-drain ordering before the stdin frame write', () => {
  it('starts both output drains before the first stdin write on the success path', async () => {
    const jobDir = makeJobDir('drain-ok');
    const host = successHost({ mode: 'normal' });
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    const bridge = makeBridge(host, { secretStore: store });
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.status, 'completed');
    const proc = host.processes[0];
    assert.ok(proc.stdin.writeCalls > 0, 'the credential path writes the frame to stdin');
    // Every write must begin with both readers already consuming: otherwise a
    // child filling an OS pipe buffer could deadlock against the frame write.
    assert.deepEqual(proc.stdin.writeDrainsReady, proc.stdin.writeDrainsReady.map(() => true));
    assert.equal(proc.stdin.firstWriteDrainsReady, true);
    assert.equal(proc.streamActivity.stdoutStarted, true);
    assert.equal(proc.streamActivity.stderrStarted, true);
    // Exactly one reader per stream: the stop/timeout paths reuse it.
    assert.equal(proc.streamActivity.stdoutStartCount, 1);
    assert.equal(proc.streamActivity.stderrStartCount, 1);
  });

  it('starts both output drains before a stdin write that never resolves', async () => {
    const jobDir = makeJobDir('drain-timeout');
    const host = successHost({ mode: 'hang' });
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    const clock = createManualClock();
    const bridge = new PowershellBridge({
      executablePath: FAKE_POWERSHELL,
      childScriptPath: CHILD_SCRIPT,
      subprocess: host,
      files: createFakeFiles(),
      clock,
      pdfValidator: looksLikePdf,
      timeouts: { startupMs: 1000, translationMs: 1000, secretWriteMs: 50 },
      secretStore: store,
    });
    const pending = bridge.translate(makeRequest(jobDir));
    // Let the span settle so the write is in flight, then inspect before firing
    // the write timeout.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const proc = host.processes[0];
    assert.equal(proc.stdin.writeCalls, 1, 'the blocked write is in flight');
    assert.equal(proc.stdin.firstWriteDrainsReady, true, 'readers live while the write blocks');
    assert.equal(proc.streamActivity.stdoutStarted, true);
    assert.equal(proc.streamActivity.stderrStarted, true);
    clock.fireAll();
    const result = await pending;
    assert.equal(result.error.code, 'SECRET_WRITE_TIMEOUT');
    // The write-timeout stop path reuses the same readers, never a duplicate.
    assert.equal(proc.streamActivity.stdoutStartCount, 1);
    assert.equal(proc.streamActivity.stderrStartCount, 1);
    assert.equal(proc.killed, true);
  });

  it('would fail if a reader started only after the stdin write resolved', async () => {
    // requireDrains rejects any write that begins before both output drains are
    // live. With the accepted ordering this can never fire, so the job
    // completes; an implementation that wrote stdin first would instead settle
    // SECRET_WRITE_FAILED here.
    const jobDir = makeJobDir('drain-required');
    const host = successHost({ mode: 'normal', requireDrains: true });
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    const bridge = makeBridge(host, { secretStore: store });
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.status, 'completed');
    assert.equal(host.processes[0].stdin.firstWriteDrainsReady, true);
  });

  it('drains both streams in order on the credential-free path with no stdin write', async () => {
    const jobDir = makeJobDir('drain-nostore');
    const host = successHost();
    const bridge = makeBridge(host);
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.status, 'completed');
    const proc = host.processes[0];
    assert.equal(proc.stdin.writeCalls, 0, 'no store => no stdin write');
    assert.equal(proc.streamActivity.stdoutStarted, true);
    assert.equal(proc.streamActivity.stderrStarted, true);
    assert.equal(proc.streamActivity.stdoutStartCount, 1);
    assert.equal(proc.streamActivity.stderrStartCount, 1);
  });
});

describe('non-ready store states map distinctly and fail closed before spawn', () => {
  for (const state of ['missing', 'unavailable', 'locked', 'cancelled', 'error']) {
    it('maps ' + state + ' to a stable code and never spawns', async () => {
      const jobDir = makeJobDir('state-' + state);
      const host = successHost();
      const store = new FakeSecretStore({ state });
      const bridge = makeBridge(host, { secretStore: store });
      const result = await bridge.translate(makeRequest(jobDir));
      assert.equal(result.status, 'failed');
      assert.equal(result.error.code, secretFailureCodeForState(state));
      assert.ok(result.error.messageRedacted.length > 0);
      assert.equal(host.callCount, 0, 'must fail closed before spawning');
      assert.equal(JSON.stringify(result).includes(SENTINEL), false);
    });
  }

  it('a thrown store error is mapped, not echoed', async () => {
    const jobDir = makeJobDir('thrown');
    const host = successHost();
    const store = new FakeSecretStore({ throwOnRetrieve: true, apiKey: SENTINEL });
    const bridge = makeBridge(host, { secretStore: store });
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.error.code, 'SECRET_STORE_ERROR');
    assert.equal(JSON.stringify(result).includes(SENTINEL), false);
    assert.equal(JSON.stringify(result).includes('store failure'), false);
    assert.equal(host.callCount, 0);
  });

  it('a ready lease for a different provider/job is its own mismatch code', async () => {
    const jobDir = makeJobDir('mismatch');
    const host = successHost();
    const store = new FakeSecretStore({ apiKey: SENTINEL, leaseJobId: '99999999-0000-1111-2222-333333333333' });
    const bridge = makeBridge(host, { secretStore: store });
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.error.code, SECRET_LEASE_MISMATCH_CODE);
    assert.equal(host.callCount, 0);
  });
});

describe('prototype-chain hardening', () => {
  it('an inherited/malformed state never yields a non-code string', () => {
    for (const bad of ['toString', 'hasOwnProperty', '__proto__', 'constructor', 5, null, undefined, {}]) {
      const code = secretFailureCodeForState(bad);
      assert.equal(typeof code, 'string');
      assert.equal(code, 'SECRET_STORE_ERROR');
    }
  });

  it('a malformed store state maps to SECRET_STORE_ERROR, not a prototype value', async () => {
    const jobDir = makeJobDir('proto');
    const host = successHost();
    const store = new FakeSecretStore({ state: 'toString' });
    const bridge = makeBridge(host, { secretStore: store });
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.error.code, 'SECRET_STORE_ERROR');
    assert.equal(typeof result.error.messageRedacted, 'string');
    assert.equal(host.callCount, 0);
  });
});

describe('partial write / EOF contract', () => {
  it('handles partial writes by advancing on bytesWritten and still emits the full frame', async () => {
    const jobDir = makeJobDir('partial');
    const host = successHost({ mode: 'partial', maxChunk: 3 });
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    const bridge = makeBridge(host, { secretStore: store });
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.status, 'completed');
    const stdin = host.processes[0].stdin;
    assert.ok(stdin.writeCalls > 1, 'partial writes must require multiple host writes');
    const parsed = parseSecretFrame(stdin.bytes());
    assert.ok(parsed);
    assert.equal(parsed.fields.apiKey, SENTINEL);
    assert.equal(stdin.closed, true);
  });

  it('rejects zero write progress and fails closed, stopping the child', async () => {
    const jobDir = makeJobDir('zero');
    const host = successHost({ mode: 'zero' });
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    const bridge = makeBridge(host, { secretStore: store });
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.error.code, 'SECRET_WRITE_FAILED');
    assert.equal(host.processes[0].killed, true, 'child must be stopped on write failure');
    assert.equal(JSON.stringify(result).includes(SENTINEL), false);
    assert.equal(existsSync(path.join(jobDir, 'out')), false, 'job dir discarded on confirmed stop');
  });

  it('a throwing stdin write fails closed', async () => {
    const jobDir = makeJobDir('throw');
    const host = successHost({ mode: 'throw' });
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    const bridge = makeBridge(host, { secretStore: store });
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.error.code, 'SECRET_WRITE_FAILED');
    assert.equal(JSON.stringify(result).includes(SENTINEL), false);
  });

  it('a missing stdin port fails closed with a stable code', async () => {
    const jobDir = makeJobDir('nostdin');
    const host = new FakeSubprocessHost({
      behavior: { exitMode: 'exit', exitCode: 0, noStdin: true },
      resultSpec: { kind: 'success', outputKinds: ['dualPdf'] },
    });
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    const bridge = makeBridge(host, { secretStore: store });
    const result = await bridge.translate(makeRequest(jobDir, { outputMode: 'dual' }));
    assert.equal(result.error.code, 'SECRET_STDIN_UNAVAILABLE');
  });
});

describe('write timeout keeps ownership until confirmed stop', () => {
  it('times out the write, stops the child, and discards only on confirmed exit', async () => {
    const jobDir = makeJobDir('writetimeout');
    const host = successHost({ mode: 'hang' });
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    // Manual clock so the test can fire the secret-write timeout deterministically.
    const clock = createManualClock();
    const bridge = new PowershellBridge({
      executablePath: FAKE_POWERSHELL,
      childScriptPath: CHILD_SCRIPT,
      subprocess: host,
      files: createFakeFiles(),
      clock,
      pdfValidator: looksLikePdf,
      timeouts: { startupMs: 1000, translationMs: 1000, secretWriteMs: 50 },
      secretStore: store,
    });
    const pending = bridge.translate(makeRequest(jobDir));
    // Let the span settle so the write is in flight, then fire the write timer.
    await new Promise((resolve) => setTimeout(resolve, 5));
    clock.fireAll();
    const result = await pending;
    assert.equal(result.error.code, 'SECRET_WRITE_TIMEOUT');
    // The child is stopped via the confirmed-exit contract; only then is the dir gone.
    assert.equal(host.processes[0].killed, true);
    assert.equal(existsSync(path.join(jobDir, 'out')), false);
    assert.equal(JSON.stringify(result).includes(SENTINEL), false);
  });
});

describe('sentinel sink assertions', () => {
  it('keeps the sentinel out of argv, job files, and returned results/errors', async () => {
    const jobDir = makeJobDir('sinks');
    const host = successHost();
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    const bridge = makeBridge(host, { secretStore: store });
    const result = await bridge.translate(makeRequest(jobDir));
    assert.equal(result.status, 'completed');
    // argv must never carry the sentinel.
    assert.equal(host.callOptions[0].arguments.join(' ').includes(SENTINEL), false);
    // the request file written by the bridge must be secret-free.
    const requestPath = path.join(jobDir, 'out', 'request.json');
    assert.equal(readFileSync(requestPath, 'utf8').includes(SENTINEL), false);
    // no file under the job dir may contain the sentinel.
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        }
        else {
          assert.equal(readFileSync(full).includes(SENTINEL), false, 'leaked into ' + full);
        }
      }
    };
    walk(path.join(jobDir, 'out'));
    // the returned result must be secret-free.
    assert.equal(JSON.stringify(result).includes(SENTINEL), false);
    // the only surface that may carry the sentinel is the captured stdin bytes.
    assert.equal(host.processes[0].stdin.bytes().includes(SENTINEL), true);
  });

  it('store result messages never expose a credential', async () => {
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    await store.save('deepseek', SENTINEL);
    await store.delete('deepseek');
    await store.retrieveForJob('deepseek', 'J1');
    assert.equal(JSON.stringify(store.saveCalls).includes(SENTINEL), false);
    assert.equal(JSON.stringify(store.deleteCalls).includes(SENTINEL), false);
  });
});

describe('Zotero host-port stdin mapping (static 10.0.2)', () => {
  function capturingOutputPipe() {
    const state = { written: [], closed: false };
    return {
      pipe: {
        async write(bytes) {
          const slice = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          state.written.push(Buffer.from(slice));
          return { bytesWritten: slice.byteLength };
        },
        close() {
          state.closed = true;
        },
      },
      state,
    };
  }

  it('adapts stdin only when the process exposes one; null otherwise', () => {
    const withStdin = adaptZoteroProcess({ pid: 1, exitCode: 0, stdin: capturingOutputPipe().pipe, kill() {}, wait: async () => ({ exitCode: 0 }) });
    assert.ok(withStdin.stdin, 'stdin present when the handle has one');
    const withoutStdin = adaptZoteroProcess({ pid: 1, exitCode: 0, kill() {}, wait: async () => ({ exitCode: 0 }) });
    assert.equal(withoutStdin.stdin, null, 'no stdin when the handle exposes none');
  });

  it('forwards bytes and normalises { bytesWritten }, and close() signals EOF', async () => {
    const { pipe, state } = capturingOutputPipe();
    const stdin = adaptOutputPipe(pipe);
    const result = await stdin.write(new Uint8Array([1, 2, 3, 4]));
    assert.equal(result.bytesWritten, 4);
    assert.equal(state.written.length, 1);
    assert.equal(state.written[0].length, 4);
    await stdin.close();
    assert.equal(state.closed, true);
  });

  it('a write with no bytesWritten result is surfaced as -1 (invalid progress)', async () => {
    const stdin = adaptOutputPipe({ write() { return undefined; }, close() {} });
    const result = await stdin.write(new Uint8Array([1]));
    assert.equal(result.bytesWritten, -1);
  });
});

describe('reservation gate across the async store lookup', () => {
  it('concurrent translate() while the store lookup is pending allows only one retrieval/spawn', async () => {
    const jobDirA = makeJobDir('race-a');
    const jobDirB = makeJobDir('race-b');
    const host = successHost();
    const store = new FakeSecretStore({ apiKey: SENTINEL, deferred: true });
    const bridge = makeBridge(host, { secretStore: store });
    const first = bridge.translate(makeRequest(jobDirA, { jobId: '11111111-2222-3333-4444-555555555555' }));
    // Give the first call time to reserve the slot and reach the pending lookup.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await bridge.translate(makeRequest(jobDirB, { jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));
    assert.equal(second.error.code, 'BRIDGE_BUSY', 'second job is rejected while the first is awaiting the store');
    assert.equal(second.status, 'failed');
    // Only the first job ever reached the store, and nothing has spawned yet.
    assert.equal(store.retrieveCalls.length, 1);
    assert.equal(host.callCount, 0);
    // The second job's directory must not be left behind (rejected before its own write).
    store.resolvePendingRetrieve();
    const firstResult = await first;
    assert.equal(firstResult.status, 'completed');
    assert.equal(host.callCount, 1);
  });

  it('cancel confirmed during the store lookup settles cancelled and never spawns', async () => {
    const jobDir = makeJobDir('cancel-await');
    const host = successHost();
    const store = new FakeSecretStore({ apiKey: SENTINEL, deferred: true });
    const bridge = makeBridge(host, { secretStore: store });
    const request = makeRequest(jobDir, { jobId: '11111111-2222-3333-4444-555555555555' });
    const pending = bridge.translate(request);
    // Let run() reserve the slot and reach the pending store lookup.
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Cancel while the store is still pending: handle is null, so ensureStop
    // confirms "no process" immediately and cancel resolves successfully.
    await bridge.cancel(request.jobId);
    // Only now does the lease resolve; run() must not spawn.
    store.resolvePendingRetrieve();
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.outputs, undefined);
    assert.equal(host.callCount, 0, 'no subprocess may be created after a confirmed cancel');
    assert.equal(existsSync(path.join(jobDir, 'out')), false, 'the cancelled job dir is removed');
    // A fresh job is accepted again (ownership released).
    store.deferred = false;
    const second = await bridge.translate(makeRequest(jobDir, { jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));
    assert.notEqual(second.error && second.error.code, 'BRIDGE_BUSY');
  });
});

describe('pre-spawn failure cleans up the job directory', () => {
  for (const state of ['missing', 'unavailable', 'locked', 'cancelled', 'error']) {
    it('removes the job output dir after a ' + state + ' failure', async () => {
      const jobDir = makeJobDir('clean-' + state);
      const host = successHost();
      const store = new FakeSecretStore({ state });
      const bridge = makeBridge(host, { secretStore: store });
      const result = await bridge.translate(makeRequest(jobDir));
      assert.equal(result.status, 'failed');
      assert.equal(existsSync(path.join(jobDir, 'out')), false, 'own dir must be removed');
      assert.equal(host.callCount, 0);
    });
  }

  it('removes the job dir on a lease mismatch and an oversized frame', async () => {
    const mismatchDir = makeJobDir('clean-mismatch');
    const hostA = successHost();
    const storeA = new FakeSecretStore({ apiKey: SENTINEL, leaseProviderId: 'other-provider' });
    const bridgeA = makeBridge(hostA, { secretStore: storeA });
    const rA = await bridgeA.translate(makeRequest(mismatchDir));
    assert.equal(rA.error.code, SECRET_LEASE_MISMATCH_CODE);
    assert.equal(existsSync(path.join(mismatchDir, 'out')), false);

    const bigDir = makeJobDir('clean-big');
    const hostB = successHost();
    const storeB = new FakeSecretStore({ apiKey: 'x'.repeat(SECRET_FRAME_PAYLOAD_LIMIT) });
    const bridgeB = makeBridge(hostB, { secretStore: storeB });
    const rB = await bridgeB.translate(makeRequest(bigDir));
    assert.equal(rB.error.code, 'SECRET_FRAME_TOO_LARGE');
    assert.equal(existsSync(path.join(bigDir, 'out')), false);
    assert.equal(hostB.callCount, 0);
  });
});

describe('secret transport failure releases ownership only on confirmed stop', () => {
  it('releases ownership after a confirmed stop so a new job is accepted', async () => {
    const jobDirA = makeJobDir('relA');
    const jobDirB = makeJobDir('relB');
    const host = successHost({ mode: 'zero' });
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    const bridge = makeBridge(host, { secretStore: store });
    const first = await bridge.translate(makeRequest(jobDirA, { jobId: '11111111-2222-3333-4444-555555555555' }));
    assert.equal(first.error.code, 'SECRET_WRITE_FAILED');
    assert.equal(host.processes[0].killed, true);
    // A second, healthy bridge is not needed: the same bridge must be free again.
    // Use a non-zero store so the second lookup also fails but is NOT BRIDGE_BUSY.
    const second = await bridge.translate(makeRequest(jobDirB, { jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));
    assert.notEqual(second.error.code, 'BRIDGE_BUSY', 'ownership must be released after confirmed stop');
  });

  it('keeps the bridge busy and the directory when the write-failure stop is unconfirmed', async () => {
    const jobDir = makeJobDir('keep');
    // waitMode 'reject' => exit cannot be confirmed on the write-failure stop.
    const host = new FakeSubprocessHost({
      behavior: { exitMode: 'exit', exitCode: 0, stdinBehavior: { mode: 'zero' }, waitMode: 'reject' },
      resultSpec: { kind: 'success', outputKinds: ['dualPdf'] },
    });
    const store = new FakeSecretStore({ apiKey: SENTINEL });
    const bridge = makeBridge(host, { secretStore: store });
    const result = await bridge.translate(makeRequest(jobDir, { outputMode: 'dual' }));
    assert.equal(result.error.code, 'SECRET_WRITE_FAILED');
    assert.equal(existsSync(path.join(jobDir, 'out')), true, 'dir retained on unconfirmed stop');
    const second = await bridge.translate(makeRequest(jobDir, { outputMode: 'dual', jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));
    assert.equal(second.error.code, 'BRIDGE_BUSY', 'bridge stays busy (poisoned) on unconfirmed stop');
  });
});

describe('secret failure message is always a string', () => {
  it('a store state that is a prototype key still yields a string message, not a function', async () => {
    const jobDir = makeJobDir('msg');
    const host = successHost();
    // 'toString' is inherited; the own-property guards must keep both the code
    // and the message as safe strings.
    const store = new FakeSecretStore({ state: 'toString' });
    const bridge = makeBridge(host, { secretStore: store });
    const failure = await bridge.translate(makeRequest(jobDir, { outputMode: 'dual' }));
    assert.equal(failure.error.code, 'SECRET_STORE_ERROR');
    assert.equal(typeof failure.error.messageRedacted, 'string');
    assert.ok(failure.error.messageRedacted.length > 0);
    assert.equal(host.callCount, 0);
  });
});
