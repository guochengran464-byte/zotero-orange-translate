/**
 * M2C PowerShell bridge adapter.
 *
 * Implements the frozen M2A RuntimeAdapter by supervising a non-interactive
 * PowerShell child process through a narrow, injected port. It never imports
 * Node, Zotero, child_process or filesystem APIs: the process spawn, the file
 * operations, the timer and the PDF validation are all injected, so the same
 * logic runs against the isolated fake in tests and against the real Zotero
 * Subprocess API in the host (see src/zotero/subprocess-host.ts).
 *
 * Boundaries enforced here (docs/tasks/M2C_POWERSHELL_BRIDGE.md):
 * - only an absolute configured executable path; the argument list is built
 *   from fixed flags plus job-scoped file paths, never from request free text;
 * - a fresh per-job directory plus a request file and a result file;
 * - fail-closed on non-zero exit, malformed/mismatched result, missing/empty/
 *   escaped output, or a PDF validation rejection;
 * - no credential is read, invented, forwarded or logged (provider.baseUrl is
 *   never emitted into the request file or argv);
 * - stdout/stderr drains are started as soon as the handle exists, BEFORE any
 *   potentially blocking credential-frame write to stdin, kept active for the
 *   process lifetime and bounded; every diagnostic is redacted before it
 *   becomes messageRedacted;
 * - finite startup and translation timeouts; cancel() resolves only after the
 *   owned handle reports exit and partial outputs are discarded.
 */

import type {
  RuntimeAdapter,
  RuntimeStatus,
  TranslationOutputMode,
  TranslationRequest,
  TranslationResult,
} from '../core/runtime-contract.ts';
import {
  isAbsoluteLocalPath,
  isPathContained,
  requiredOutputKinds,
} from '../core/translation-service.ts';
import type { SecretLease, SecretStorePort } from './secret-store.ts';
import {
  isReadyLease,
  leaseMatches,
  secretFailureCodeForState,
  SECRET_LEASE_MISMATCH_CODE,
} from './secret-store.ts';

// --- Injected ports -----------------------------------------------------------

/** A process stdout/stderr pipe, already decoded to text by the host port. */
export type SubprocessStream = AsyncIterable<string>;

/**
 * A writable stdin pipe. `write` transfers ownership of the byte slice to the
 * host (the Zotero OutputPipe detaches the buffer), so the caller must pass a
 * fresh exact slice each time and read `bytesWritten` to advance.
 */
export interface SubprocessStdin {
  write(bytes: Uint8Array): Promise<{ bytesWritten: number }>;
  close(): void | Promise<void>;
}

/** The subset of the Zotero 10.0.2 process handle this bridge relies on. */
export interface SubprocessProcessHandle {
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly stdout: SubprocessStream | null;
  readonly stderr: SubprocessStream | null;
  /** Writable stdin, or null when the host did not expose one. */
  readonly stdin?: SubprocessStdin | null;
  /** Resolves with { exitCode } once the owned process family has stopped. */
  wait(): Promise<{ exitCode: number | null }>;
  /** Terminates the owned process family; await wait() before treating it stopped. */
  kill(timeoutSeconds?: number): void;
}

export interface SubprocessCallOptions {
  /** Absolute executable path. Never derived from the translation request. */
  command: string;
  arguments: string[];
  workdir?: string;
  stderr?: 'pipe';
}

/** Narrow port onto Zotero's direct Subprocess.call(); not the logging wrappers. */
export interface SubprocessPort {
  call(options: SubprocessCallOptions): Promise<SubprocessProcessHandle>;
}

/** Narrow filesystem port; the bridge itself must not import fs. */
export interface BridgeFilePort {
  /** True when the path does not exist, or exists as an empty directory. */
  isFreshDirectory(absoluteDir: string): boolean;
  mkdirp(absoluteDir: string): void;
  writeText(absolutePath: string, text: string): void;
  readText(absolutePath: string): string | null;
  exists(absolutePath: string): boolean;
  /** Byte length of a file, or -1 when it does not exist. */
  size(absolutePath: string): number;
  removeRecursive(absoluteDir: string): void;
}

/** Timer port so the bridge can time out without a global setTimeout. */
export interface BridgeClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** True when the file at the absolute path is an acceptable PDF. */
export type PdfValidator = (absolutePath: string) => boolean;

export interface BridgeTimeouts {
  startupMs: number;
  translationMs: number;
  /** Budget for writing the credential frame to stdin, when a store is injected. */
  secretWriteMs?: number;
}

export interface PowershellBridgeOptions {
  executablePath: string;
  childScriptPath: string;
  subprocess: SubprocessPort;
  files: BridgeFilePort;
  clock: BridgeClock;
  pdfValidator: PdfValidator;
  timeouts?: Partial<BridgeTimeouts>;
  /** Bound for the retained stdout/stderr excerpt; retained for future safe use. */
  maxStreamChars?: number;
  /**
   * Optional credential store. When absent, the bridge is byte-for-byte the
   * accepted M2C path: no stdin frame is written and no credential is read.
   * When present, exactly one job-scoped frame is written to the child stdin.
   */
  secretStore?: SecretStorePort;
}

// --- Stable failure codes -----------------------------------------------------

export const BRIDGE_FAILURE_MESSAGES: Record<string, string> = {
  INVALID_REQUEST: 'the bridge received a request it cannot use',
  BRIDGE_BUSY: 'another translation job is already active',
  JOB_DIR_NOT_FRESH: 'the job output directory is not empty',
  JOB_DIR_UNAVAILABLE: 'the job output directory could not be prepared',
  REQUEST_WRITE_FAILED: 'the bridge could not write its request file',
  STARTUP_TIMEOUT: 'the translation process did not start in time',
  SPAWN_FAILED: 'the translation process could not be started',
  TRANSLATION_TIMEOUT: 'the translation process exceeded its time budget',
  PROCESS_EXIT_NONZERO: 'the translation process exited with an error',
  RESULT_MISSING: 'the translation process produced no result file',
  RESULT_MALFORMED: 'the result file was not a valid result',
  RESULT_JOB_MISMATCH: 'the result did not belong to this job',
  MISSING_REQUIRED_OUTPUT: 'a required output file was not produced',
  OUTPUT_EMPTY: 'a produced output file was empty',
  OUTPUT_OUTSIDE_JOB_DIR: 'a produced output path was outside the job directory',
  PDF_VALIDATION_FAILED: 'a produced output file was not a usable PDF',
  INTERNAL_ERROR: 'the bridge hit an unexpected internal error',
  EXIT_UNCONFIRMED: 'the translation process exit could not be confirmed',
  CANCEL_NOT_HONORED: 'the translation process did not confirm it stopped',
  CHILD_ERROR_UNRECOGNIZED: 'the translation process reported an unrecognized error',
  RUNTIME_MISSING: 'the local translation runtime is not installed',
  RUNTIME_INCOMPATIBLE: 'the local translation runtime is not compatible',
  INPUT_NOT_FOUND: 'the input PDF could not be found',
  INPUT_NOT_READABLE: 'the input PDF could not be read',
  PROVIDER_NOT_CONFIGURED: 'no translation provider is configured',
  PROVIDER_UNREACHABLE: 'the translation provider could not be reached',
  TRANSLATION_FAILED: 'the translation failed',
  CHILD_FAILED: 'the translation process reported a failure',
};

// Secret-transport failure messages. All are fixed, safe strings: a store
// error, lease mismatch or write failure must never echo a credential or a
// store-supplied message. The store-state codes are defined in secret-store.ts.
export const SECRET_TRANSPORT_MESSAGES: Record<string, string> = {
  SECRET_MISSING: 'no saved credential is available for the selected provider',
  SECRET_STORE_UNAVAILABLE: 'the credential store is not available',
  SECRET_STORE_LOCKED: 'the credential store is locked',
  SECRET_STORE_CANCELLED: 'the credential prompt was cancelled',
  SECRET_STORE_ERROR: 'the credential store returned an error',
  SECRET_LEASE_MISMATCH: 'the credential did not match the requested provider and job',
  SECRET_FRAME_TOO_LARGE: 'the credential frame exceeded the size limit',
  SECRET_STDIN_UNAVAILABLE: 'the translation process did not expose a stdin pipe',
  SECRET_WRITE_FAILED: 'the credential frame could not be written',
  SECRET_WRITE_TIMEOUT: 'writing the credential frame timed out',
};

/** 4-byte unsigned big-endian length prefix + UTF-8 JSON, fields in fixed order. */
export const SECRET_FRAME_PAYLOAD_LIMIT = 65_536;
export const SECRET_FRAME_HEADER_BYTES = 4;

/**
 * UTF-8 encode a string without TextEncoder (tsconfig lib is ES2022 only and
 * the bridge must not import Node or DOM globals). Surrogate pairs are handled;
 * an unpaired surrogate is encoded as U+FFFD like TextEncoder does.
 */
function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes.push(code);
    }
    else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    }
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

export interface SecretFrameFields {
  jobId: string;
  providerId: string;
  apiKey: string;
}

/**
 * Encode the credential frame: a 4-byte unsigned big-endian payload length
 * followed by UTF-8 JSON `{schemaVersion, jobId, providerId, apiKey}` with the
 * fields in that fixed order. Returns null when the JSON payload exceeds the
 * 65,536-byte limit (excluding the 4-byte header), so the caller fails closed
 * before spawning.
 */
export function encodeSecretFrame(fields: SecretFrameFields): Uint8Array | null {
  const json = JSON.stringify({
    schemaVersion: 1,
    jobId: fields.jobId,
    providerId: fields.providerId,
    apiKey: fields.apiKey,
  });
  const payload = utf8Encode(json);
  if (payload.length > SECRET_FRAME_PAYLOAD_LIMIT) {
    return null;
  }
  const frame = new Uint8Array(SECRET_FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.length, false);
  frame.set(payload, SECRET_FRAME_HEADER_BYTES);
  return frame;
}

// Stable failure codes a child is allowed to report. Any other value is mapped
// to CHILD_ERROR_UNRECOGNIZED so an untrusted child cannot inject an arbitrary code (or
// a code-shaped string carrying a key or path) into the returned TranslationError.
const CHILD_FAILURE_CODES = new Set<string>([
  'RUNTIME_MISSING',
  'RUNTIME_INCOMPATIBLE',
  'INPUT_NOT_FOUND',
  'INPUT_NOT_READABLE',
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_UNREACHABLE',
  'TRANSLATION_FAILED',
  'CHILD_FAILED',
]);

export const REQUEST_FILE_NAME = 'request.json';
export const RESULT_FILE_NAME = 'result.json';

// --- Redaction ----------------------------------------------------------------

const KEY_LIKE = /\b(?:sk|pk|ghp|gho|xox[baprs]|bearer)-?[A-Za-z0-9_\-]{8,}\b/gi;
const ASSIGNED_SECRET = /\b(?:api[_-]?key|apikey|access[_-]?token|token|secret|password|passwd|pwd|authorization|bearer)\b\s*[:=]\s*\S+/gi;
const WINDOWS_PATH = /[A-Za-z]:[\\/][^\s"'<>|]*/g;
const UNC_PATH = /\\\\[^\s"'<>|]+/g;
const POSIX_PATH = /(?<![\w:])\/(?:[^\s"'<>|\/]+\/)*[^\s"'<>|\/]*/g;
const QUOTED = /"[^"]*"|'[^']*'/g;

/**
 * Reduce untrusted child output to a safe, bounded diagnostic string. It strips
 * absolute and UNC paths, key-like tokens and assigned secrets, and quoted
 * regions (treated as document text), collapses whitespace and truncates. It is
 * the only path from raw child output to messageRedacted.
 */
export function redactDiagnostic(input: unknown, maxChars = 160): string {
  if (input === null || input === undefined) {
    return '';
  }
  let text = typeof input === 'string' ? input : String(input);
  text = text.replace(/\r\n?|\n/g, ' ');
  text = text.replace(QUOTED, ' ');
  text = text.replace(WINDOWS_PATH, '<path>');
  text = text.replace(UNC_PATH, '<path>');
  text = text.replace(POSIX_PATH, '<path>');
  text = text.replace(ASSIGNED_SECRET, '<redacted>');
  text = text.replace(KEY_LIKE, '<redacted>');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '...';
  }
  return text;
}

// --- Helpers ------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinLocal(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  const sep = trimmed.includes('\\') ? '\\' : '/';
  return trimmed + sep + name;
}

/**
 * The request file carries only what the child needs. provider.baseUrl is
 * deliberately not forwarded: M2C does not build a provider endpoint from free
 * text, and no credential material is read or written here.
 */
export function serializeBridgeRequest(request: TranslationRequest): string {
  const provider: Record<string, string> = { id: request.provider.id };
  if (request.provider.model) {
    provider.model = request.provider.model;
  }
  return JSON.stringify({
    schemaVersion: 1,
    jobId: request.jobId,
    inputPdf: request.inputPdf,
    outputDir: request.outputDir,
    language: { source: request.language.source, target: request.language.target },
    provider,
    outputMode: request.outputMode,
  }, null, 2);
}

function cancelledResult(jobId: string): TranslationResult {
  return { schemaVersion: 1, jobId, status: 'cancelled' };
}

// --- Adapter ------------------------------------------------------------------

interface ActiveJob {
  jobId: string;
  dir: string;
  /** Null while the spawn is still pending. */
  handle: SubprocessProcessHandle | null;
  cancelRequested: boolean;
  /** Resolves with the handle once the spawn settles, or null if it failed. */
  spawnPromise: Promise<SubprocessProcessHandle | null> | null;
  /** Memoized stop-and-release of a starting job; resolves true only when the
   *  owned process family is confirmed stopped (or was never created). */
  settlePromise: Promise<boolean> | null;
  /** The credential frame to write to stdin, or null when no store is injected. */
  frame: Uint8Array | null;
  /** Memoized drains for the owned handle's stdout/stderr, started as soon as
   *  the handle exists and shared by every path that waits on stream EOF. */
  drainsPromise: Promise<string[]> | null;
}

export class PowershellBridge implements RuntimeAdapter {
  private readonly executablePath: string;
  private readonly childScriptPath: string;
  private readonly subprocess: SubprocessPort;
  private readonly files: BridgeFilePort;
  private readonly clock: BridgeClock;
  private readonly pdfValidator: PdfValidator;
  private readonly timeouts: BridgeTimeouts;
  private readonly maxStreamChars: number;
  private readonly secretStore: SecretStorePort | null;
  private active: ActiveJob | null = null;

  constructor(options: PowershellBridgeOptions) {
    this.executablePath = options.executablePath;
    this.childScriptPath = options.childScriptPath;
    this.subprocess = options.subprocess;
    this.files = options.files;
    this.clock = options.clock;
    this.pdfValidator = options.pdfValidator;
    this.timeouts = {
      startupMs: options.timeouts?.startupMs ?? 30_000,
      translationMs: options.timeouts?.translationMs ?? 20 * 60_000,
      secretWriteMs: options.timeouts?.secretWriteMs ?? 10_000,
    };
    this.maxStreamChars = options.maxStreamChars ?? 4096;
    this.secretStore = options.secretStore ?? null;
  }

  async checkAvailability(): Promise<RuntimeStatus> {
    const checkedAt = new Date(this.clock.now()).toISOString();
    if (!isAbsoluteLocalPath(this.executablePath)) {
      return { availability: 'incompatible', checkedAt, diagnostic: { code: 'EXEC_NOT_ABSOLUTE', messageRedacted: 'the configured executable path is not absolute' } };
    }
    if (!this.files.exists(this.executablePath)) {
      return { availability: 'missing', checkedAt, diagnostic: { code: 'EXEC_MISSING', messageRedacted: 'the configured executable was not found' } };
    }
    if (!isAbsoluteLocalPath(this.childScriptPath) || !this.files.exists(this.childScriptPath)) {
      return { availability: 'missing', checkedAt, diagnostic: { code: 'CHILD_SCRIPT_MISSING', messageRedacted: 'the bridge child script was not found' } };
    }
    return { availability: 'available', checkedAt };
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const jobId = request?.jobId ?? '';
    try {
      return await this.run(request);
    }
    catch (e) {
      return this.failure(jobId, 'INTERNAL_ERROR');
    }
  }

  private async run(request: TranslationRequest): Promise<TranslationResult> {
    const jobId = request.jobId;
    if (!isRecord(request)
      || typeof jobId !== 'string' || jobId.length === 0
      || !isAbsoluteLocalPath(request.inputPdf)
      || !isAbsoluteLocalPath(request.outputDir)) {
      return this.failure(jobId, 'INVALID_REQUEST');
    }
    if (this.active !== null) {
      return this.failure(jobId, 'BRIDGE_BUSY');
    }
    if (!this.files.isFreshDirectory(request.outputDir)) {
      return this.failure(jobId, 'JOB_DIR_NOT_FRESH');
    }
    try {
      this.files.mkdirp(request.outputDir);
    }
    catch (e) {
      return this.failure(jobId, 'JOB_DIR_UNAVAILABLE');
    }
    const requestPath = joinLocal(request.outputDir, REQUEST_FILE_NAME);
    const resultPath = joinLocal(request.outputDir, RESULT_FILE_NAME);
    try {
      this.files.writeText(requestPath, serializeBridgeRequest(request));
    }
    catch (e) {
      return this.failure(jobId, 'REQUEST_WRITE_FAILED');
    }

    // Reserve the single active slot BEFORE any await (including the credential
    // store lookup below). Otherwise two concurrent translate() calls could both
    // pass the `active === null` gate above, each await the store, then each spawn
    // and overwrite `active`, breaking the single-active-job invariant.
    const reserved: ActiveJob = {
      jobId,
      dir: request.outputDir,
      handle: null,
      cancelRequested: false,
      spawnPromise: null,
      settlePromise: null,
      frame: null,
      drainsPromise: null,
    };
    this.active = reserved;

    // Opt-in credential path: when a store is injected, acquire the one-job
    // lease and build the stdin frame BEFORE spawning, so a non-ready store or
    // an oversized frame fails closed without ever creating a process. When no
    // store is injected this stays null and the path is byte-for-byte M2C.
    let frame: Uint8Array | null = null;
    if (this.secretStore !== null) {
      let lease: SecretLease;
      try {
        lease = await this.secretStore.retrieveForJob(request.provider.id, jobId);
      }
      catch (e) {
        // A thrown store error is never echoed; map to the generic store code.
        return this.abortBeforeSpawn(reserved, secretFailureCodeForState('error'));
      }
      if (!isReadyLease(lease)) {
        return this.abortBeforeSpawn(reserved, secretFailureCodeForState(lease?.state));
      }
      if (!leaseMatches(lease, request.provider.id, jobId)) {
        return this.abortBeforeSpawn(reserved, SECRET_LEASE_MISMATCH_CODE);
      }
      frame = encodeSecretFrame({ jobId, providerId: request.provider.id, apiKey: lease.apiKey });
      if (frame === null) {
        return this.abortBeforeSpawn(reserved, 'SECRET_FRAME_TOO_LARGE');
      }
    }

    // A cancel may have been requested and confirmed while the store lookup was
    // awaited (reserved.handle is null, so ensureStop confirms "no process"). In
    // that case never spawn: drop the lease/frame and settle cancelled. This also
    // discards the in-memory key rather than forwarding it.
    if (reserved.cancelRequested) {
      this.files.removeRecursive(request.outputDir);
      this.clearActive(reserved);
      return cancelledResult(jobId);
    }

    // Reserve the single active slot BEFORE awaiting the spawn, so a second
    // translate() is rejected while this job is starting and cancel(jobId) can
    // target a job whose handle has not been returned yet.
    const spawnPromise = (async (): Promise<SubprocessProcessHandle | null> => {
      try {
        return await this.subprocess.call({
          command: this.executablePath,
          arguments: this.buildArguments(requestPath, resultPath),
          workdir: request.outputDir,
          stderr: 'pipe',
        });
      }
      catch (e) {
        return null;
      }
    })();
    // Reuse the SAME reserved object as the active job: never create a second
    // ActiveJob that would reset cancelRequested or lose the reservation. The
    // spawn is registered on the reservation itself.
    reserved.spawnPromise = spawnPromise;
    reserved.frame = frame;
    const job = reserved;

    const started = await this.raceTimeout(spawnPromise, this.timeouts.startupMs);
    if (started.timedOut) {
      if (job.cancelRequested) {
        // A cancel was requested before the spawn resolved. The frozen rule is
        // that a successful cancellation settles translate() as cancelled, so
        // await the SAME confirmed stop the cancel path waits on and settle
        // cancelled only after the owned process family is confirmed stopped.
        const stopped = await this.ensureStop(job);
        if (!stopped) {
          // Cannot confirm the stop: fail closed, retain ownership + directory.
          return this.failure(jobId, 'CANCEL_NOT_HONORED');
        }
        this.files.removeRecursive(request.outputDir);
        this.clearActive(job);
        return cancelledResult(jobId);
      }
      // The spawn may still resolve later. Keep the one-job ownership slot and
      // the output directory quarantined (bridge stays busy) until the spawn
      // promise resolves and any returned handle is confirmed stopped. If the
      // spawn never resolves, the bridge stays busy and fails closed.
      void this.finishQuarantine(job);
      return this.failure(jobId, 'STARTUP_TIMEOUT');
    }
    if (started.value === null) {
      this.files.removeRecursive(request.outputDir);
      this.clearActive(job);
      // The spawn failed, so no process was ever created. If a cancel was
      // requested while the spawn was pending, the RuntimeAdapter contract
      // requires that successful cancellation settle translate() as cancelled.
      return job.cancelRequested ? cancelledResult(jobId) : this.failure(jobId, 'SPAWN_FAILED');
    }
    const handle = started.value;
    job.handle = handle;
    // Start consuming both child output streams BEFORE any potentially blocking
    // write to stdin, and keep them active while the credential frame is
    // written. A child that fills an OS pipe buffer must never be able to block
    // on stdout/stderr while the bridge is blocked writing the frame: if the
    // readers started only after the frame write resolved, a full pipe would
    // deadlock both sides. Every stop/timeout path reuses this same memoized
    // drain work, so no stream ever gets a second concurrent reader.
    const drains = this.startDrains(job, handle);
    // A cancel that arrived while the spawn was pending still owns this job:
    // the handle never runs, so kill it and settle cancelled.
    if (job.cancelRequested) {
      const stopped = await this.ensureStop(job);
      if (!stopped) {
        return this.failure(jobId, 'CANCEL_NOT_HONORED');
      }
      this.files.removeRecursive(request.outputDir);
      this.clearActive(job);
      return cancelledResult(jobId);
    }

    // Opt-in credential frame: write exactly one job-scoped frame to the child
    // stdin, then close it to signal EOF. Any failure stops the child through
    // the confirmed-exit contract and fails closed.
    if (job.frame !== null) {
      const written = await this.writeSecretFrame(handle, job);
      if (written !== null) {
        const stopped = await this.ensureStop(job);
        if (stopped) {
          this.files.removeRecursive(request.outputDir);
          this.clearActive(job);
        }
        // On an unconfirmed stop the directory and ownership are retained
        // (poisoned adapter); on a confirmed stop they are released. Either way
        // report the stable write-failure code.
        return this.secretFailure(jobId, written);
      }
    }

    const exitPromise = (async () => {
      try {
        return await handle.wait();
      }
      catch (e) {
        return { exitCode: null, waitFailed: true as const };
      }
    })();
    const exited = await this.raceTimeout(exitPromise, this.timeouts.translationMs);

    if (exited.timedOut) {
      const stopped = await this.killAndConfirm(handle);
      if (!stopped) {
        // Exit could not be confirmed. The pipes may never reach EOF while a
        // live process holds them, so do NOT await the drains: leave them
        // running in the background (they are already started, so the pipe
        // cannot block) and settle immediately. Keep ownership AND the
        // directory, since the process may still be writing. Fail closed.
        return this.failure(jobId, job.cancelRequested ? 'CANCEL_NOT_HONORED' : 'EXIT_UNCONFIRMED');
      }
      await drains;
      this.discard(request.outputDir);
      this.clearActive(job);
      return job.cancelRequested ? cancelledResult(jobId) : this.failure(jobId, 'TRANSLATION_TIMEOUT');
    }

    const waitResult = exited.value as { exitCode: number | null; waitFailed?: boolean };
    if (waitResult.waitFailed === true || !Number.isInteger(waitResult.exitCode)) {
      // wait() rejected, or returned a non-numeric exit code (e.g.
      // { exitCode: null }): the handle did NOT confirm exit, so the pipes may
      // never close. Do not await the drains; keep ownership and the
      // directory, and never settle cancellation on an unconfirmed stop.
      return this.failure(jobId, job.cancelRequested ? 'CANCEL_NOT_HONORED' : 'EXIT_UNCONFIRMED');
    }
    await drains;
    const code = waitResult.exitCode;
    if (job.cancelRequested) {
      this.discard(request.outputDir);
      this.clearActive(job);
      return cancelledResult(jobId);
    }
    this.clearActive(job);
    if (code !== 0) {
      this.discard(request.outputDir);
      return this.failure(jobId, 'PROCESS_EXIT_NONZERO');
    }
    return this.readResult(request, resultPath);
  }

  /** Fixed flags plus job-scoped file paths only; never request free text. */
  private buildArguments(requestPath: string, resultPath: string): string[] {
    return [
      '-NoProfile',
      '-NonInteractive',
      '-NoLogo',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.childScriptPath,
      '-RequestPath',
      requestPath,
      '-ResultPath',
      resultPath,
    ];
  }

  private readResult(
    request: TranslationRequest,
    resultPath: string,
  ): TranslationResult {
    const jobId = request.jobId;
    const raw = this.files.readText(resultPath);
    if (raw === null) {
      this.discard(request.outputDir);
      return this.failure(jobId, 'RESULT_MISSING');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    }
    catch (e) {
      this.discard(request.outputDir);
      return this.failure(jobId, 'RESULT_MALFORMED');
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
      this.discard(request.outputDir);
      return this.failure(jobId, 'RESULT_MALFORMED');
    }
    if (parsed.jobId !== jobId) {
      this.discard(request.outputDir);
      return this.failure(jobId, 'RESULT_JOB_MISMATCH');
    }
    if (parsed.status === 'cancelled') {
      this.discard(request.outputDir);
      return cancelledResult(jobId);
    }
    if (parsed.status === 'failed') {
      this.discard(request.outputDir);
      const error = isRecord(parsed.error) ? parsed.error : null;
      const rawCode = error && typeof error.code === 'string' ? error.code : '';
      // The child's error code (and message) are untrusted: only a known stable
      // code is passed through, and the message is never forwarded.
      const code = CHILD_FAILURE_CODES.has(rawCode) ? rawCode : 'CHILD_ERROR_UNRECOGNIZED';
      return this.failure(jobId, code);
    }
    if (parsed.status !== 'completed') {
      this.discard(request.outputDir);
      return this.failure(jobId, 'RESULT_MALFORMED');
    }
    const outputs = parsed.outputs;
    if (!isRecord(outputs)) {
      this.discard(request.outputDir);
      return this.failure(jobId, 'RESULT_MALFORMED');
    }
    const collected: Record<string, string> = {};
    for (const kind of ['dualPdf', 'monoPdf']) {
      const value = outputs[kind];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'string' || value.length === 0) {
        this.discard(request.outputDir);
        return this.failure(jobId, 'RESULT_MALFORMED');
      }
      if (!isPathContained(request.outputDir, value)) {
        this.discard(request.outputDir);
        return this.failure(jobId, 'OUTPUT_OUTSIDE_JOB_DIR');
      }
      if (!this.files.exists(value)) {
        this.discard(request.outputDir);
        return this.failure(jobId, 'MISSING_REQUIRED_OUTPUT');
      }
      if (this.files.size(value) <= 0) {
        this.discard(request.outputDir);
        return this.failure(jobId, 'OUTPUT_EMPTY');
      }
      let valid = false;
      try {
        valid = this.pdfValidator(value) === true;
      }
      catch (e) {
        valid = false;
      }
      if (!valid) {
        this.discard(request.outputDir);
        return this.failure(jobId, 'PDF_VALIDATION_FAILED');
      }
      collected[kind] = value;
    }
    for (const kind of requiredOutputKinds(request.outputMode as TranslationOutputMode)) {
      if (typeof collected[kind] !== 'string' || collected[kind].length === 0) {
        this.discard(request.outputDir);
        return this.failure(jobId, 'MISSING_REQUIRED_OUTPUT');
      }
    }
    const runtime = isRecord(parsed.runtime) ? parsed.runtime : null;
    return {
      schemaVersion: 1,
      jobId,
      status: 'completed',
      outputs: collected as any,
      runtime: runtime ? {
        ...(typeof runtime.version === 'string' ? { version: runtime.version } : {}),
        ...(typeof runtime.babeldocVersion === 'string' ? { babeldocVersion: runtime.babeldocVersion } : {}),
      } : undefined,
    };
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.active;
    if (job === null || job.jobId !== jobId) {
      // A cancellation for another job must not affect the active job.
      return;
    }
    job.cancelRequested = true;
    // cancel() may resolve only after the owned process family is confirmed
    // stopped. ensureStop waits for a pending spawn, kills the returned handle
    // and requires a concrete exit; it may block while the spawn is pending.
    const stopped = await this.ensureStop(job);
    if (!stopped) {
      // Do not clear ownership or discard outputs on an unconfirmed stop.
      throw new Error(BRIDGE_FAILURE_MESSAGES.CANCEL_NOT_HONORED);
    }
    this.discard(job.dir);
    this.clearActive(job);
  }

  private clearActive(job: ActiveJob): void {
    if (this.active === job) {
      this.active = null;
    }
  }

  /**
   * A pre-spawn failure of the reserved (but not yet spawned) job. No process
   * was created, so it is safe to remove this job's own output directory and
   * release the reservation, then return the stable failure.
   */
  private abortBeforeSpawn(job: ActiveJob, code: string): TranslationResult {
    this.files.removeRecursive(job.dir);
    this.clearActive(job);
    // If a cancel was requested and confirmed during the store lookup, the
    // RuntimeAdapter contract requires a successful cancel to settle cancelled,
    // regardless of the store outcome that raced with it.
    if (job.cancelRequested) {
      return cancelledResult(job.jobId);
    }
    return this.secretFailure(job.jobId, code);
  }

  /**
   * Write the credential frame to the child stdin with the partial-write
   * contract: a fresh exact byte slice per write (the host pipe takes buffer
   * ownership), advance by `bytesWritten`, reject zero/invalid progress, and
   * close stdin to signal EOF only after the whole frame. Returns null on
   * success or a stable secret-transport failure code. Bounded by
   * `timeouts.secretWriteMs`.
   */
  private async writeSecretFrame(
    handle: SubprocessProcessHandle,
    job: ActiveJob,
  ): Promise<string | null> {
    const frame = job.frame;
    if (frame === null) {
      return null;
    }
    const stdin = handle.stdin ?? null;
    if (stdin === null) {
      return 'SECRET_STDIN_UNAVAILABLE';
    }
    const started = await this.raceTimeout(this.writeAll(stdin, frame), this.timeouts.secretWriteMs ?? 10_000);
    if (started.timedOut) {
      return 'SECRET_WRITE_TIMEOUT';
    }
    return started.value;
  }

  /** Write the whole frame, then close stdin; resolves null on success. */
  private async writeAll(stdin: SubprocessStdin, frame: Uint8Array): Promise<string | null> {
    try {
      let offset = 0;
      while (offset < frame.length) {
        // A fresh exact slice per write: the host pipe detaches the buffer.
        const slice = frame.slice(offset);
        const offered = slice.length;
        const result = await stdin.write(slice);
        const written = result && typeof result.bytesWritten === 'number' ? result.bytesWritten : -1;
        if (!Number.isInteger(written) || written <= 0 || written > offered) {
          return 'SECRET_WRITE_FAILED';
        }
        offset += written;
      }
      await stdin.close();
      return null;
    }
    catch (e) {
      return 'SECRET_WRITE_FAILED';
    }
  }

  /** A fixed, safe failure result for the credential path; never echoes input. */
  private secretFailure(jobId: string, code: string): TranslationResult {
    // Own-property lookup only: an inherited/unknown code (e.g. 'toString')
    // must never resolve to a prototype value, so messageRedacted is a string.
    const messageRedacted = Object.prototype.hasOwnProperty.call(SECRET_TRANSPORT_MESSAGES, code)
      ? SECRET_TRANSPORT_MESSAGES[code]
      : SECRET_TRANSPORT_MESSAGES.SECRET_WRITE_FAILED;
    return { schemaVersion: 1, jobId, status: 'failed', error: { code, messageRedacted, retryable: false } };
  }

  private safeKill(handle: SubprocessProcessHandle): void {
    try {
      handle.kill(0);
    }
    catch (e) {
      // ignore; wait() below still reports the real state
    }
  }

  /**
   * Kill the owned handle and return true only when wait() confirms a concrete
   * exit. A rejected wait, or a non-numeric exit code like { exitCode: null },
   * never counts as a confirmed stop.
   */
  private async killAndConfirm(handle: SubprocessProcessHandle): Promise<boolean> {
    this.safeKill(handle);
    try {
      const result = await handle.wait();
      return result !== null
        && result !== undefined
        // Subprocess documents integer exit codes; NaN is typeof number but
        // is not a valid confirmed exit.
        && Number.isInteger(result.exitCode);
    }
    catch (e) {
      return false;
    }
  }

  /**
   * Stop-and-release for a job whose spawn may still be pending. Shared and
   * memoized so run(), cancel() and the startup-timeout quarantine all wait on
   * the same confirmation. Returns true only when the owned process family is
   * confirmed stopped (or was never created). Never discards the directory or
   * clears ownership: the caller does that only on a confirmed stop.
   */
  private ensureStop(job: ActiveJob): Promise<boolean> {
    if (job.settlePromise === null) {
      job.settlePromise = (async () => {
        const handle = job.handle ?? (job.spawnPromise ? await job.spawnPromise : null);
        if (handle === null) {
          // The spawn failed, so no process was ever created.
          return true;
        }
        job.handle = handle;
        const stopped = await this.killAndConfirm(handle);
        // Reuse the drains already started for this handle (started before any
        // stdin frame write) so a still-live process cannot block on a full
        // pipe and no stream gets a duplicate concurrent reader. Only await
        // their EOF after a confirmed exit: on an unconfirmed stop the process
        // may hold the pipes open forever, so the drains keep running in the
        // background and the caller settles now.
        const drains = this.startDrains(job, handle);
        if (stopped) {
          await drains;
        }
        return stopped;
      })();
    }
    return job.settlePromise;
  }

  /**
   * Start the stdout/stderr drains for the job's handle exactly once and return
   * the shared promise. Called as soon as the handle exists (before any stdin
   * write) and reused by every stop, timeout, cancellation and write-failure
   * path so a single stream never gets two concurrent readers.
   */
  private startDrains(job: ActiveJob, handle: SubprocessProcessHandle): Promise<string[]> {
    if (job.drainsPromise === null) {
      job.drainsPromise = Promise.all([this.drain(handle.stdout), this.drain(handle.stderr)]);
    }
    return job.drainsPromise;
  }

  /**
   * A spawn that resolved after STARTUP_TIMEOUT: keep the ownership slot and
   * directory quarantined (the bridge stays busy) until the spawn promise
   * resolves and any returned handle is confirmed stopped, then release. If
   * the confirm fails, ownership and the directory are retained and the bridge
   * stays busy, failing closed.
   */
  private async finishQuarantine(job: ActiveJob): Promise<void> {
    const stopped = await this.ensureStop(job);
    if (!stopped) {
      return;
    }
    this.discard(job.dir);
    this.clearActive(job);
  }

  private discard(absoluteDir: string): void {
    try {
      this.files.removeRecursive(absoluteDir);
    }
    catch (e) {
      // best effort; never throw from a settle path
    }
  }

  private async drain(stream: SubprocessStream | null): Promise<string> {
    if (!stream) {
      return '';
    }
    let kept = '';
    try {
      for await (const chunk of stream) {
        if (typeof chunk !== 'string') {
          continue;
        }
        kept += chunk;
        if (kept.length > this.maxStreamChars) {
          kept = kept.slice(kept.length - this.maxStreamChars);
        }
      }
    }
    catch (e) {
      // A broken stream must not break settling.
    }
    return kept;
  }

  /**
   * Build a failure result with a fixed, safe message. Child stdout/stderr and
   * child-provided text are deliberately NOT included: raw streams are
   * untrusted and may contain paths with spaces, document text or key
   * fragments, so user-facing diagnostics stay fixed strings keyed by code.
   */
  private failure(jobId: string, code: string): TranslationResult {
    const messageRedacted = BRIDGE_FAILURE_MESSAGES[code] ?? BRIDGE_FAILURE_MESSAGES.INTERNAL_ERROR;
    return { schemaVersion: 1, jobId, status: 'failed', error: { code, messageRedacted, retryable: false } };
  }

  private raceTimeout<T>(
    promise: Promise<T>,
    ms: number,
  ): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
    return new Promise((resolve) => {
      let settled = false;
      const id = this.clock.setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ timedOut: true });
        }
      }, ms);
      promise.then(
        (value) => {
          if (!settled) {
            settled = true;
            this.clock.clearTimeout(id);
            resolve({ timedOut: false, value });
          }
        },
        () => {
          if (!settled) {
            settled = true;
            this.clock.clearTimeout(id);
            resolve({ timedOut: false, value: undefined as unknown as T });
          }
        },
      );
    });
  }
}
