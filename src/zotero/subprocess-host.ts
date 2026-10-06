/**
 * M2C Zotero subprocess host port.
 *
 * The ONLY M2C layer allowed to touch Zotero host APIs. It maps the frozen
 * 10.0.2 Subprocess surface onto the narrow SubprocessPort that
 * src/runtime/powershell-bridge.ts consumes, so the bridge logic stays
 * host-free and testable.
 *
 * Frozen 10.0.2 evidence (docs/evidence/ZOTERO_10_0_2_SUBPROCESS.md, static
 * source inspection only; the host was not launched):
 * - Subprocess.call(options) at omni.ja!modules/Subprocess.sys.mjs:50-151;
 *   command must be a full executable path (58-59), arguments are a string
 *   array (64-65), stderr:'pipe' exposes stderr (79-85), workdir is supported
 *   (87-88); a later non-zero exit does not reject the spawn promise (97-109).
 * - Handle: pid (582), exitCode + exitPromise (584-592), stdout/stderr
 *   InputPipe (593-619), kill(timeout) (669-701), wait() (704-720).
 * - InputPipe.readString(length, {stream}) at subprocess_common.sys.mjs:496-529;
 *   with no length it reads one chunk and returns '' at end of file.
 * - utilities_internal.js exec()/subprocess() (684-725) log the executable and
 *   arguments, so this adapter must NOT use them - it calls Subprocess.call
 *   directly.
 *
 * IMPORTANT LIMIT: this is a static mapping. It does not prove that extension-
 * scope module import, real PowerShell execution, or Windows Job Object
 * cancellation work at runtime in Zotero. Those remain M2-REAL / native-host
 * gates. The file, clock and PDF-validator ports take host primitives by
 * injection because their exact host calls were not exercised here.
 */

import type {
  BridgeClock,
  BridgeFilePort,
  PdfValidator,
  SubprocessCallOptions,
  SubprocessPort,
  SubprocessProcessHandle,
  SubprocessStdin,
  SubprocessStream,
} from '../runtime/powershell-bridge.ts';

/** The subset of the Subprocess.sys.mjs module this host needs. */
export interface ZoteroSubprocessModule {
  call(options: {
    command: string;
    arguments: string[];
    workdir?: string;
    stderr?: 'pipe';
  }): Promise<ZoteroPipeProcess>;
}

/** An InputPipe as exposed by subprocess_common.sys.mjs. */
export interface ZoteroInputPipe {
  readString(length?: number | null, options?: { stream?: boolean }): Promise<string>;
}

/** An OutputPipe as exposed by subprocess_common.sys.mjs (writable stdin). */
export interface ZoteroOutputPipe {
  /** Writes a buffer/string and resolves with { bytesWritten }. */
  write(buffer: string | Uint8Array | ArrayBuffer): Promise<{ bytesWritten: number }> | void;
  /** Closes this end of the pipe, signalling EOF to the child. */
  close(immediate?: boolean): void | Promise<unknown>;
}

/** A process handle as exposed by Subprocess.sys.mjs / subprocess_common. */
export interface ZoteroPipeProcess {
  readonly pid: number | null;
  exitCode: number | null;
  readonly stdout?: ZoteroInputPipe | null;
  readonly stderr?: ZoteroInputPipe | null;
  readonly stdin?: ZoteroOutputPipe | null;
  kill(timeout?: number): Promise<{ exitCode: number | null }> | void;
  wait(): Promise<{ exitCode: number | null }>;
}

/**
 * Adapt one InputPipe into the bridge's async string stream. Reads one chunk at
 * a time with the pipe's own EOF contract (an empty string means end of file),
 * so the bridge can bound memory and stop promptly on cancellation.
 */
async function* readPipe(pipe: ZoteroInputPipe | null | undefined): SubprocessStream {
  if (!pipe) {
    return;
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let chunk: string;
    try {
      chunk = await pipe.readString(null, { stream: true });
    }
    catch (e) {
      return;
    }
    if (typeof chunk !== 'string' || chunk.length === 0) {
      return;
    }
    yield chunk;
  }
}

/** Adapt a Subprocess.sys.mjs process handle onto the bridge's narrow handle. */
export function adaptZoteroProcess(process: ZoteroPipeProcess): SubprocessProcessHandle {
  return {
    get pid() {
      return process.pid;
    },
    get exitCode() {
      return process.exitCode;
    },
    get stdout() {
      return process.stdout ? readPipe(process.stdout) : null;
    },
    get stderr() {
      return process.stderr ? readPipe(process.stderr) : null;
    },
    get stdin() {
      return process.stdin ? adaptOutputPipe(process.stdin) : null;
    },
    wait(): Promise<{ exitCode: number | null }> {
      return process.wait();
    },
    kill(timeoutSeconds?: number): void {
      // Subprocess.kill() takes a millisecond timeout; 0 forces immediate
      // termination of the owned Job Object (Windows behavior).
      const ms = typeof timeoutSeconds === 'number' ? timeoutSeconds * 1000 : 300;
      try {
        void process.kill(ms);
      }
      catch (e) {
        // Ignore; the caller always awaits wait() before treating it stopped.
      }
    },
  };
}

/** The SubprocessPort built from the injected Zotero Subprocess module. */
/**
 * Adapt a Zotero OutputPipe into the bridge's SubprocessStdin. The OutputPipe
 * transfers ownership of the written buffer to its IO worker (per
 * subprocess_common.sys.mjs OutputPipe.write), so callers already pass a fresh
 * exact slice; here we only forward and normalise the { bytesWritten } result.
 */
export function adaptOutputPipe(pipe: ZoteroOutputPipe): SubprocessStdin {
  return {
    async write(bytes: Uint8Array): Promise<{ bytesWritten: number }> {
      const result = await pipe.write(bytes);
      const written = result && typeof (result as { bytesWritten?: unknown }).bytesWritten === 'number'
        ? (result as { bytesWritten: number }).bytesWritten
        : -1;
      return { bytesWritten: written };
    },
    async close(): Promise<void> {
      await pipe.close();
    },
  };
}

export function createSubprocessPort(subprocess: ZoteroSubprocessModule): SubprocessPort {
  return {
    async call(options: SubprocessCallOptions): Promise<SubprocessProcessHandle> {
      const process = await subprocess.call({
        command: options.command,
        arguments: options.arguments,
        workdir: options.workdir,
        stderr: options.stderr ?? 'pipe',
      });
      return adaptZoteroProcess(process);
    },
  };
}

/** Step 1 smoke check: a fixed command, no PDF content or provider request. */
export async function checkLocalProcess(
  subprocess: ZoteroSubprocessModule,
  command: string,
  clock: BridgeClock,
): Promise<number> {
  let handle: SubprocessProcessHandle | null = null;
  let timedOut = false;
  let timer: unknown;
  const drain = async (stream: SubprocessStream | null) => {
    let text = '';
    if (stream) {
      for await (const chunk of stream) { text = (text + chunk).slice(-256); }
    }
    return text;
  };
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = clock.setTimeout(() => {
      timedOut = true;
      handle?.kill(0);
      reject(new Error('LOCAL_PROCESS_TIMEOUT'));
    }, 10_000);
  });
  const run = (async () => {
    handle = await createSubprocessPort(subprocess).call({
      command,
      arguments: ['-NoProfile', '-NonInteractive', '-Command',
        "[Console]::Out.Write('ORANGE_PROCESS_READY')"],
      stderr: 'pipe',
    });
    if (timedOut) { handle.kill(0); await handle.wait(); throw new Error('LOCAL_PROCESS_TIMEOUT'); }
    const [exit, stdout] = await Promise.all([
      handle.wait(), drain(handle.stdout), drain(handle.stderr),
    ]);
    if (exit.exitCode !== 0 || stdout !== 'ORANGE_PROCESS_READY'
      || !Number.isInteger(handle.pid) || Number(handle.pid) <= 0) {
      throw new Error('LOCAL_PROCESS_CHECK_FAILED');
    }
    return Number(handle.pid);
  })();
  try { return await Promise.race([run, deadline]); }
  finally {
    clock.clearTimeout(timer);
    const owned = handle as SubprocessProcessHandle | null;
    if (timedOut && owned) { await owned.wait(); }
  }
}

export interface ZoteroBridgeHostSurface {
  /** Services (nsIServices) - used for the clock and file services. */
  services: any;
  /** The Subprocess module (from ChromeUtils.importESModule). */
  subprocess: ZoteroSubprocessModule;
  /** A file port implementation supplied by the host wiring. */
  files: BridgeFilePort;
  /** A PDF validator supplied by the host wiring (e.g. a parser or header check). */
  pdfValidator: PdfValidator;
}

/** A clock backed by Services' timer facility (host) or a plain shim. */
export function createHostClock(services: any): BridgeClock {
  const globalTimers = globalThis as unknown as {
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(id: unknown): void;
  };
  return {
    now(): number {
      return Date.now();
    },
    setTimeout(handler: () => void, ms: number): unknown {
      if (services && typeof services.setTimeout === 'function') {
        return services.setTimeout(handler, ms);
      }
      return globalTimers.setTimeout(handler, ms);
    },
    clearTimeout(id: unknown): void {
      if (services && typeof services.clearTimeout === 'function') {
        services.clearTimeout(id);
        return;
      }
      globalTimers.clearTimeout(id);
    },
  };
}

/**
 * Assemble the injected bridge ports from the Zotero host surface. The file
 * port and PDF validator are supplied by the host wiring so this module does
 * not have to invent untested host calls; they are the same ports the tests
 * inject with synthetic implementations.
 */
export function createZoteroBridgePorts(surface: ZoteroBridgeHostSurface): {
  subprocess: SubprocessPort;
  files: BridgeFilePort;
  clock: BridgeClock;
  pdfValidator: PdfValidator;
} {
  return {
    subprocess: createSubprocessPort(surface.subprocess),
    files: surface.files,
    clock: createHostClock(surface.services),
    pdfValidator: surface.pdfValidator,
  };
}
