// Test-only fake Subprocess host for M2C (owner: M2C-POWERSHELL-BRIDGE / DS).
//
// Implements the narrow SubprocessPort + handle shape the bridge consumes, with
// deterministic controls, and performs NO network, provider or real-runtime
// work. This is a test fixture; production core must never import it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** A minimal structurally-valid synthetic PDF (kept local to keep M2C standalone). */
export function syntheticPdfText() {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n',
  ];
  let pdf = '%PDF-1.7\n%\xFF\xFF\xFF\xFF\n';
  const offsets = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefOffset = pdf.length;
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\n';
  pdf += 'startxref\n' + xrefOffset + '\n%%EOF\n';
  return pdf;
}

export const SYNTHETIC_PDF = syntheticPdfText();

/** True when a produced file is a structurally plausible synthetic PDF. */
export function looksLikePdf(absolutePath) {
  let text;
  try {
    text = readFileSync(absolutePath).toString('latin1');
  }
  catch (e) {
    return false;
  }
  const match = /startxref\s+(\d+)\s+%%EOF\s*$/g.exec(text);
  return text.startsWith('%PDF-1.') && text.includes('/Type /Catalog') && match !== null;
}

/**
 * A per-process record of when each output stream started being consumed. The
 * flags are set the first time a reader pulls from the stream, so a test can
 * prove the drains were started before a stdin write resolved.
 */
function newStreamActivity() {
  return {
    stdoutStarted: false,
    stderrStarted: false,
    stdoutStartCount: 0,
    stderrStartCount: 0,
  };
}

function markStarted(activity, label) {
  if (!activity) {
    return;
  }
  activity[label + 'Started'] = true;
  activity[label + 'StartCount'] += 1;
}

/** Split text into a few chunks so the bridge must drain an iterable stream. */
function neverEndingStream(activity = null, label = 'stdout') {
  return {
    async *[Symbol.asyncIterator]() {
      markStarted(activity, label);
      yield 'live-output';
      await new Promise(() => {});
    },
  };
}

function chunkStream(text, size = 8, activity = null, label = 'stdout') {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return {
    async *[Symbol.asyncIterator]() {
      // Runs on the first next(), i.e. when a reader actually starts consuming.
      markStarted(activity, label);
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

/**
 * A fake writable stdin pipe. Captures the exact bytes it received (the only
 * permitted transport surface) and supports partial, zero-progress, throwing
 * and never-resolving (timeout) write behaviours.
 */
class FakeStdin {
  constructor(behavior = {}, streamActivity = null) {
    // 'normal' | 'partial' | 'zero' | 'throw' | 'hang'
    this.mode = behavior.mode ?? 'normal';
    // For 'partial', write at most this many bytes per call.
    this.maxChunk = behavior.maxChunk ?? 3;
    this.streamActivity = streamActivity;
    // When true, a write that arrives before BOTH output drains have started is
    // rejected. This deterministically models the pipe-drain ordering contract:
    // a real child could block on a full stdout/stderr pipe while the bridge is
    // blocked writing the credential frame, so the readers must already be live.
    this.requireDrains = behavior.requireDrains === true;
    // Per-write record of whether both drains had started when the write began.
    this.writeDrainsReady = [];
    this.firstWriteDrainsReady = null;
    this.received = [];
    this.writeCalls = 0;
    this.closed = false;
  }

  write(bytes) {
    this.writeCalls += 1;
    const drainsReady = this.streamActivity
      ? this.streamActivity.stdoutStarted === true && this.streamActivity.stderrStarted === true
      : null;
    this.writeDrainsReady.push(drainsReady);
    if (this.firstWriteDrainsReady === null) {
      this.firstWriteDrainsReady = drainsReady;
    }
    if (this.requireDrains && drainsReady === false) {
      return Promise.reject(new Error('synthetic stdin write attempted before output drains started'));
    }
    if (this.mode === 'throw') {
      return Promise.reject(new Error('synthetic stdin write failure'));
    }
    if (this.mode === 'zero') {
      return Promise.resolve({ bytesWritten: 0 });
    }
    if (this.mode === 'hang') {
      return new Promise(() => {});
    }
    const slice = this.mode === 'partial'
      ? bytes.subarray(0, Math.min(this.maxChunk, bytes.length))
      : bytes;
    this.received.push(Buffer.from(slice));
    return Promise.resolve({ bytesWritten: slice.length });
  }

  close() {
    this.closed = true;
  }

  /** The full received byte stream, concatenated. */
  bytes() {
    return Buffer.concat(this.received);
  }
}

class FakeProcess {
  constructor(behavior) {
    this.pid = 4242;
    this.exitCode = null;
    // When each stream first started being read, and how many times.
    this.streamActivity = newStreamActivity();
    // When true, stdout/stderr never reach EOF (a live process holds the pipe).
    this.stdout = behavior.neverEndingStreams
      ? neverEndingStream(this.streamActivity, 'stdout')
      : chunkStream(behavior.stdout ?? '', 8, this.streamActivity, 'stdout');
    this.stderr = behavior.neverEndingStreams
      ? neverEndingStream(this.streamActivity, 'stderr')
      : chunkStream(behavior.stderr ?? '', 8, this.streamActivity, 'stderr');
    this.killed = false;
    this.waitCalls = 0;
    this._resolveWait = null;
    this._exited = false;
    // 'reject' makes wait() reject; 'never' makes it hang forever.
    this.waitMode = behavior.waitMode ?? 'normal';
    // When true, kill() does not actually exit the process (models a handle
    // whose cancellation cannot be confirmed).
    this.killIgnored = behavior.killIgnored === true;
    // Writable stdin pipe; null models a host that exposed no stdin.
    this.stdin = behavior.noStdin ? null : new FakeStdin(behavior.stdinBehavior ?? {}, this.streamActivity);
    if (behavior.exitMode === 'exit') {
      // Simulate a finite process that exits on its own.
      this._timer = setTimeout(() => this._exit(behavior.exitCode ?? 0), 0);
    }
  }

  _exit(code) {
    if (this._exited) {
      return;
    }
    this._exited = true;
    this.exitCode = code;
    if (this._resolveWait) {
      this._resolveWait({ exitCode: code });
      this._resolveWait = null;
    }
  }

  wait() {
    this.waitCalls += 1;
    if (this.waitMode === 'reject') {
      return Promise.reject(new Error('synthetic wait failure'));
    }
    if (this.waitMode === 'nullExit') {
      // kill() marks it exited, but the observed exit code is null (unconfirmed).
      return Promise.resolve({ exitCode: null });
    }
    if (this.waitMode === 'nanExit') {
      // typeof NaN === 'number', but it is not a valid integer exit code.
      return Promise.resolve({ exitCode: NaN });
    }
    if (this.waitMode === 'never' && !this.killed) {
      return new Promise(() => {});
    }
    if (this._exited) {
      return Promise.resolve({ exitCode: this.exitCode });
    }
    return new Promise((resolve) => {
      this._resolveWait = resolve;
    });
  }

  kill() {
    this.killed = true;
    if (this.killIgnored) {
      return;
    }
    this._exit(-9);
  }
}

export class FakeSubprocessHost {
  constructor(options = {}) {
    this.behavior = options.behavior ?? { exitMode: 'exit', exitCode: 0 };
    this.resultSpec = options.resultSpec ?? { kind: 'success' };
    this.callOptions = [];
    this.processes = [];
    this.callCount = 0;
    this.callRejects = options.callRejects === true;
    // When true, call() returns a promise the test resolves later via
    // resolvePendingSpawn(), modelling a slow spawn.
    this.delayedSpawn = options.delayedSpawn === true;
    // When true, a delayed call() rejects instead of resolving a process.
    this.delayedReject = options.delayedReject === true;
    this._pendingSpawn = null;
  }

  /** Resolve a delayed call() with a fresh fake process. */
  resolvePendingSpawn() {
    if (this._pendingSpawn) {
      const { resolve } = this._pendingSpawn;
      this._pendingSpawn = null;
      const process = new FakeProcess(this.behavior);
      this.processes.push(process);
      resolve(process);
    }
  }

  /** Reject a delayed call(), modelling a spawn that fails after a delay. */
  rejectPendingSpawn() {
    if (this._pendingSpawn) {
      const { reject } = this._pendingSpawn;
      this._pendingSpawn = null;
      reject(new Error('synthetic delayed spawn failure'));
    }
  }

  /** Stand in for the synthetic PowerShell child: read request, write result. */
  writeRequestResult(requestPath, resultPath) {
    const request = JSON.parse(readFileSync(requestPath, 'utf8'));
    const outputDir = request.outputDir;
    const spec = this.resultSpec;
    const write = (name, body) => {
      const target = path.join(outputDir, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, body);
      return target;
    };
    if (spec.kind === 'none') {
      return;
    }
    if (spec.kind === 'malformed') {
      writeFileSync(resultPath, '{ not valid json ');
      return;
    }
    if (spec.kind === 'mismatch') {
      writeFileSync(resultPath, JSON.stringify({ schemaVersion: 1, jobId: '00000000-0000-0000-0000-000000000000', status: 'completed', outputs: { dualPdf: write('out.zh.dual.pdf', SYNTHETIC_PDF) } }));
      return;
    }
    if (spec.kind === 'failed') {
      writeFileSync(resultPath, JSON.stringify({ schemaVersion: 1, jobId: request.jobId, status: 'failed', error: { code: spec.code ?? 'CHILD_FAILED', messageRedacted: spec.message ?? 'child reported failure' } }));
      return;
    }
    if (spec.kind === 'cancelled') {
      writeFileSync(resultPath, JSON.stringify({ schemaVersion: 1, jobId: request.jobId, status: 'cancelled' }));
      return;
    }
    const outputs = {};
    const kinds = spec.outputKinds ?? ['dualPdf', 'monoPdf'];
    for (const kind of kinds) {
      const name = kind === 'dualPdf' ? 'out.zh.dual.pdf' : 'out.zh.mono.pdf';
      const body = spec.emptyOutput === kind ? '' : SYNTHETIC_PDF;
      outputs[kind] = write(name, body);
    }
    if (spec.escapePath) {
      outputs.dualPdf = spec.escapePath;
    }
    if (spec.dropRequired) {
      delete outputs[spec.dropRequired];
    }
    writeFileSync(resultPath, JSON.stringify({ schemaVersion: 1, jobId: request.jobId, status: 'completed', outputs, runtime: { version: 'fake-child-1.0.0' } }));
  }

  async call(options) {
    this.callCount += 1;
    this.callOptions.push(options);
    if (this.callRejects) {
      throw new Error('synthetic spawn failure');
    }
    if (this.delayedSpawn) {
      return new Promise((resolve, reject) => {
        this._pendingSpawn = { resolve, reject };
      });
    }
    const requestPath = options.arguments[options.arguments.indexOf('-RequestPath') + 1];
    const resultPath = options.arguments[options.arguments.indexOf('-ResultPath') + 1];
    if (this.behavior.exitMode !== 'hang') {
      this.writeRequestResult(requestPath, resultPath);
    }
    const process = new FakeProcess(this.behavior);
    this.processes.push(process);
    return process;
  }
}

// --- Synthetic filesystem, clock and PDF validator used by the tests -----------

export function createFakeFiles() {
  return {
    isFreshDirectory(dir) {
      try {
        if (!existsSync(dir)) {
          return true;
        }
        return readdirSync(dir).length === 0;
      }
      catch (e) {
        return true;
      }
    },
    mkdirp(dir) {
      mkdirSync(dir, { recursive: true });
    },
    writeText(p, text) {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text);
    },
    readText(p) {
      try {
        return readFileSync(p, 'utf8');
      }
      catch (e) {
        return null;
      }
    },
    exists(p) {
      return existsSync(p);
    },
    size(p) {
      try {
        return statSync(p).size;
      }
      catch (e) {
        return -1;
      }
    },
    removeRecursive(dir) {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A clock whose timeouts the test can fire manually for deterministic timing. */
export function createManualClock() {
  const pending = new Map();
  let nextId = 1;
  return {
    now: () => Date.now(),
    setTimeout(handler) {
      const id = nextId++;
      pending.set(id, handler);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** Fire every pending timer (used to drive startup/translation timeouts). */
    fireAll() {
      const handlers = [...pending.values()];
      pending.clear();
      for (const handler of handlers) {
        handler();
      }
    },
    pendingCount() {
      return pending.size;
    },
  };
}
