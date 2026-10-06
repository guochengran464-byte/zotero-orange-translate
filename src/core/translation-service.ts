/**
 * M2B core TranslationService.
 *
 * Pure control-path logic: validate a TranslationRequest, run it through an
 * injected RuntimeAdapter, and enforce the completed/failed/cancelled
 * semantics frozen in the M2A contract (docs/contracts/M2.md).
 *
 * This module must NOT import Node, Zotero, child_process or filesystem APIs,
 * and it never logs request values. Readability and parseability of produced
 * files are the adapter's responsibility (it has the filesystem); the service
 * independently enforces path containment, output-mode correspondence,
 * jobId correlation and the no-output rule for cancelled/failed results.
 */

import type {
  RuntimeAdapter,
  RuntimeStatus,
  TranslationOutputMode,
  TranslationRequest,
  TranslationResult,
  TranslationRuntimeInfo,
} from './runtime-contract.ts';

export type OutputKind = 'dualPdf' | 'monoPdf';

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SUPPORTED_OUTPUT_MODES: readonly TranslationOutputMode[] = ['dual', 'mono', 'both'];
const OUTPUT_KINDS: readonly OutputKind[] = ['dualPdf', 'monoPdf'];
const CREDENTIAL_QUERY_NAME = /token|secret|passwo?rd|passwd|pwd|api_?key|apikey|credential|authorization|bearer|signature|^sig$|^auth$|^key$/i;

export const ACTIVE_JOB_CODE = 'JOB_ALREADY_ACTIVE';
export const NO_SUCH_JOB_CODE = 'NO_SUCH_JOB';
export const CANCEL_NOT_HONORED_CODE = 'CANCEL_NOT_HONORED';

export class TranslationServiceError extends Error {
  readonly code: string;

  constructor(code: string, messageRedacted: string) {
    super(messageRedacted);
    this.name = 'TranslationServiceError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Which output artifacts a completed result must contain for a given mode. */
export function requiredOutputKinds(mode: TranslationOutputMode): OutputKind[] {
  if (mode === 'dual') {
    return ['dualPdf'];
  }
  if (mode === 'mono') {
    return ['monoPdf'];
  }
  return ['dualPdf', 'monoPdf'];
}

/**
 * Normalize an absolute local path to a lowercased, slash-separated form for
 * lexical comparison only. Returns null when the input is not an absolute local
 * path or escapes above its root via '..'. Lowercasing matches Windows path
 * semantics, which is the only host this resolver targets.
 */
export function normalizeLocalPathForCompare(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    return null;
  }
  let rest = input.replace(/\\/g, '/');
  let root: string;
  if (/^[A-Za-z]:\//.test(rest)) {
    root = rest.slice(0, 2).toLowerCase() + '/';
    rest = rest.slice(3);
  }
  else if (rest.startsWith('//')) {
    root = '//';
    rest = rest.slice(2);
  }
  else if (rest.startsWith('/')) {
    root = '/';
    rest = rest.slice(1);
  }
  else {
    return null;
  }
  const stack: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (stack.length === 0) {
        return null;
      }
      stack.pop();
      continue;
    }
    stack.push(segment.toLowerCase());
  }
  return root + stack.join('/');
}

export function isAbsoluteLocalPath(input: unknown): boolean {
  return normalizeLocalPathForCompare(input) !== null;
}

/** True when candidate is a strict descendant of parentDir (both absolute). */
export function isPathContained(parentDir: unknown, candidate: unknown): boolean {
  const parent = normalizeLocalPathForCompare(parentDir);
  const child = normalizeLocalPathForCompare(candidate);
  if (parent === null || child === null) {
    return false;
  }
  // Strict descendant only: the directory itself is never a contained file,
  // including the root case where parent '/' would otherwise prefix-match '/'.
  if (child === parent) {
    return false;
  }
  const prefix = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(prefix);
}

/**
 * Detect credential material embedded in a provider endpoint: URL userinfo
 * (user:password@host) or a token/key/secret-style query parameter. Never
 * returns or logs the value it examined.
 */

/**
 * True only when the URL has an http(s) authority with a non-empty host. A
 * malformed endpoint such as 'https:///path' (empty authority, no host) is not
 * a usable endpoint and is rejected by validation.
 */
export function httpUrlHasAuthority(url: unknown): boolean {
  if (typeof url !== 'string') {
    return false;
  }
  const match = /^https?:\/\/([^/?#]*)/i.exec(url);
  if (!match) {
    return false;
  }
  const authority = match[1];
  if (authority.length === 0) {
    return false;
  }
  const hostPart = authority.includes('@')
    ? authority.slice(authority.lastIndexOf('@') + 1)
    : authority;
  if (hostPart.length === 0) {
    return false;
  }
  let host = hostPart;
  let port = '';
  let portPresent = false;
  if (hostPart.startsWith('[')) {
    const close = hostPart.indexOf(']');
    if (close < 0) {
      // Unterminated IPv6 bracket.
      return false;
    }
    host = hostPart.slice(0, close + 1);
    const afterBracket = hostPart.slice(close + 1);
    if (afterBracket.length > 0) {
      if (!afterBracket.startsWith(':')) {
        return false;
      }
      portPresent = true;
      port = afterBracket.slice(1);
    }
  }
  else {
    const colon = hostPart.indexOf(':');
    host = colon < 0 ? hostPart : hostPart.slice(0, colon);
    if (colon >= 0) {
      portPresent = true;
      port = hostPart.slice(colon + 1);
    }
  }
  // Reject whitespace/control characters anywhere in the host.
  if (host.length === 0 || /\s/.test(host)) {
    return false;
  }
  // A present port separator requires a non-empty numeric port.
  if (portPresent && !/^[0-9]+$/.test(port)) {
    return false;
  }
  return true;
}

export function isCredentialBearingUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url);
  if (authority && authority[1].includes('@')) {
    return true;
  }
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) {
    return false;
  }
  let query = url.slice(queryIndex + 1);
  const hashIndex = query.indexOf('#');
  if (hashIndex >= 0) {
    query = query.slice(0, hashIndex);
  }
  for (const pair of query.split('&')) {
    if (pair.length === 0) {
      continue;
    }
    const rawName = pair.split('=')[0];
    let name: string;
    try {
      // '+' is a form-encoded space; percent escapes are decoded so an
      // encoded credential name (api%5Fkey, access%5Ftoken) cannot bypass.
      name = decodeURIComponent(rawName.replace(/\+/g, ' '));
    }
    catch (e) {
      // Malformed percent-encoding is rejected conservatively.
      return true;
    }
    if (CREDENTIAL_QUERY_NAME.test(name)) {
      return true;
    }
  }
  return false;
}

export type RequestValidationCode =
  | 'INVALID_REQUEST_SHAPE'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'INVALID_JOB_ID'
  | 'INVALID_INPUT_PATH'
  | 'INVALID_OUTPUT_DIR'
  | 'UNSUPPORTED_LANGUAGE'
  | 'INVALID_PROVIDER'
  | 'CREDENTIAL_IN_BASE_URL'
  | 'UNSUPPORTED_OUTPUT_MODE';

export interface RequestValidationIssue {
  code: RequestValidationCode;
  field: string;
  /** Safe, generic text; never contains the offending value. */
  messageRedacted: string;
}

export type RequestValidation = { ok: true } | { ok: false; issue: RequestValidationIssue };

function invalid(
  code: RequestValidationCode,
  field: string,
  messageRedacted: string,
): RequestValidation {
  return { ok: false, issue: { code, field, messageRedacted } };
}

/**
 * Validate a schema-v1 request. Returns a stable issue code and never echoes
 * the offending value, so a rejected credential URL cannot leak into logs.
 */
export function validateTranslationRequest(request: unknown): RequestValidation {
  if (!isRecord(request)) {
    return invalid('INVALID_REQUEST_SHAPE', 'request', 'request must be an object');
  }
  if (request.schemaVersion !== 1) {
    return invalid('UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion', 'only schema version 1 is supported');
  }
  if (typeof request.jobId !== 'string' || !UUID_PATTERN.test(request.jobId)) {
    return invalid('INVALID_JOB_ID', 'jobId', 'jobId must be a UUID');
  }
  if (!isAbsoluteLocalPath(request.inputPdf)) {
    return invalid('INVALID_INPUT_PATH', 'inputPdf', 'inputPdf must be an absolute local path');
  }
  if (!isAbsoluteLocalPath(request.outputDir)) {
    return invalid('INVALID_OUTPUT_DIR', 'outputDir', 'outputDir must be an absolute local path');
  }
  const language = request.language;
  if (!isRecord(language) || language.source !== 'en' || language.target !== 'zh') {
    return invalid('UNSUPPORTED_LANGUAGE', 'language', 'only English-to-Chinese is supported in schema v1');
  }
  const provider = request.provider;
  if (!isRecord(provider)) {
    return invalid('INVALID_PROVIDER', 'provider', 'provider must be an explicit configuration object');
  }
  if (typeof provider.id !== 'string' || provider.id.trim().length === 0) {
    return invalid('INVALID_PROVIDER', 'provider.id', 'provider.id must be a non-empty explicit identifier');
  }
  if (provider.model !== undefined && typeof provider.model !== 'string') {
    return invalid('INVALID_PROVIDER', 'provider.model', 'provider.model must be a string when present');
  }
  if (provider.baseUrl !== undefined) {
    if (typeof provider.baseUrl !== 'string' || !httpUrlHasAuthority(provider.baseUrl)) {
      return invalid('INVALID_PROVIDER', 'provider.baseUrl', 'provider.baseUrl must be an http(s) endpoint');
    }
    if (isCredentialBearingUrl(provider.baseUrl)) {
      return invalid('CREDENTIAL_IN_BASE_URL', 'provider.baseUrl', 'provider.baseUrl must not embed credentials or tokens');
    }
  }
  if (typeof request.outputMode !== 'string'
    || !SUPPORTED_OUTPUT_MODES.includes(request.outputMode as TranslationOutputMode)) {
    return invalid('UNSUPPORTED_OUTPUT_MODE', 'outputMode', 'outputMode must be dual, mono or both');
  }
  return { ok: true };
}

export type ResultDefectCode =
  | 'INVALID_RESULT_SHAPE'
  | 'RESULT_JOB_MISMATCH'
  | 'INVALID_COMPLETED_RESULT'
  | 'MISSING_REQUIRED_OUTPUT'
  | 'OUTPUT_PATH_ESCAPED'
  | 'INVALID_FAILED_RESULT'
  | 'INVALID_CANCELLED_RESULT';

export interface ResultDefect {
  code: ResultDefectCode;
  messageRedacted: string;
}

export type CompletedCheck = { ok: true } | { ok: false; defect: ResultDefect };

function defect(code: ResultDefectCode, messageRedacted: string): CompletedCheck {
  return { ok: false, defect: { code, messageRedacted } };
}

/**
 * Confirm an adapter 'completed' result against the request: same jobId, no
 * error, a non-empty path for every output the mode requires, and every
 * reported path contained in the job output directory.
 */
export function checkCompletedResult(request: TranslationRequest, result: unknown): CompletedCheck {
  if (!isRecord(result)) {
    return defect('INVALID_RESULT_SHAPE', 'result must be an object');
  }
  if (result.jobId !== request.jobId) {
    return defect('RESULT_JOB_MISMATCH', 'result jobId does not match the request jobId');
  }
  if (result.schemaVersion !== 1) {
    return defect('INVALID_RESULT_SHAPE', 'result schema version is not 1');
  }
  if (result.status !== 'completed') {
    return defect('INVALID_COMPLETED_RESULT', 'result is not a completed result');
  }
  if (result.error !== undefined) {
    return defect('INVALID_COMPLETED_RESULT', 'a completed result must not carry an error');
  }
  const outputs = result.outputs;
  if (!isRecord(outputs)) {
    return defect('INVALID_COMPLETED_RESULT', 'a completed result must carry outputs');
  }
  for (const kind of OUTPUT_KINDS) {
    const value = outputs[kind];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      return defect('INVALID_COMPLETED_RESULT', 'output paths must be non-empty strings');
    }
    if (!isPathContained(request.outputDir, value)) {
      return defect('OUTPUT_PATH_ESCAPED', 'an output path escapes the job output directory');
    }
  }
  for (const kind of requiredOutputKinds(request.outputMode)) {
    const value = outputs[kind];
    if (typeof value !== 'string' || value.length === 0) {
      return defect('MISSING_REQUIRED_OUTPUT', 'a completed result is missing an output required by the requested mode');
    }
  }
  return { ok: true };
}

function failedResult(jobId: string, code: string, messageRedacted: string): TranslationResult {
  return { schemaVersion: 1, jobId, status: 'failed', error: { code, messageRedacted, retryable: false } };
}

function readRuntime(result: Record<string, any>): TranslationRuntimeInfo | undefined {
  const runtime = result.runtime;
  if (!isRecord(runtime)) {
    return undefined;
  }
  const info: TranslationRuntimeInfo = {};
  if (typeof runtime.version === 'string') {
    info.version = runtime.version;
  }
  if (typeof runtime.babeldocVersion === 'string') {
    info.babeldocVersion = runtime.babeldocVersion;
  }
  return Object.keys(info).length > 0 ? info : undefined;
}

/**
 * Normalize an untrusted adapter result into a contract-conformant terminal
 * result for the request. An improper 'completed' result is downgraded to
 * 'failed'; it is never passed through as completed.
 */
export function enforceTranslationResult(
  request: TranslationRequest,
  raw: unknown,
): TranslationResult {
  if (!isRecord(raw)) {
    return failedResult(request.jobId, 'INVALID_RESULT_SHAPE', 'the adapter returned no usable result');
  }
  if (raw.status === 'completed') {
    const check = checkCompletedResult(request, raw);
    if (!check.ok) {
      return failedResult(request.jobId, check.defect.code, check.defect.messageRedacted);
    }
    const outputs = raw.outputs as Record<string, any>;
    const dual = typeof outputs.dualPdf === 'string' ? outputs.dualPdf : undefined;
    const mono = typeof outputs.monoPdf === 'string' ? outputs.monoPdf : undefined;
    if (dual !== undefined && mono === undefined) {
      return { schemaVersion: 1, jobId: request.jobId, status: 'completed', outputs: { dualPdf: dual }, runtime: readRuntime(raw) };
    }
    if (mono !== undefined && dual === undefined) {
      return { schemaVersion: 1, jobId: request.jobId, status: 'completed', outputs: { monoPdf: mono }, runtime: readRuntime(raw) };
    }
    if (dual !== undefined && mono !== undefined) {
      return { schemaVersion: 1, jobId: request.jobId, status: 'completed', outputs: { dualPdf: dual, monoPdf: mono }, runtime: readRuntime(raw) };
    }
    return failedResult(request.jobId, 'INVALID_COMPLETED_RESULT', 'a completed result must carry at least one output');
  }
  if (raw.jobId !== request.jobId) {
    return failedResult(request.jobId, 'RESULT_JOB_MISMATCH', 'the adapter result does not belong to this job');
  }
  if (raw.schemaVersion !== 1) {
    return failedResult(request.jobId, 'INVALID_RESULT_SHAPE', 'the adapter result schema version is not 1');
  }
  if (raw.status === 'failed') {
    const error = raw.error;
    if (!isRecord(error) || typeof error.code !== 'string' || error.code.length === 0) {
      return failedResult(request.jobId, 'INVALID_FAILED_RESULT', 'a failed result must carry a stable error code');
    }
    return {
      schemaVersion: 1,
      jobId: request.jobId,
      status: 'failed',
      error: {
        code: error.code,
        messageRedacted: typeof error.messageRedacted === 'string' ? error.messageRedacted : '',
        retryable: error.retryable === true,
      },
      runtime: readRuntime(raw),
    };
  }
  if (raw.status === 'cancelled') {
    if (raw.outputs !== undefined) {
      return failedResult(request.jobId, 'INVALID_CANCELLED_RESULT', 'a cancelled result must not carry output paths');
    }
    return { schemaVersion: 1, jobId: request.jobId, status: 'cancelled', runtime: readRuntime(raw) };
  }
  return failedResult(request.jobId, 'INVALID_RESULT_SHAPE', 'the adapter result has an unknown status');
}

/**
 * Owns one active job at a time and correlates every terminal result to the
 * request jobId. Pre-start rejections (invalid request, second concurrent job)
 * throw a TranslationServiceError; a started job always settles to a terminal
 * TranslationResult, including when the adapter itself throws.
 */
export class TranslationService {
  private readonly adapter: RuntimeAdapter;
  private activeJobIdValue: string | null = null;
  private activeSettle: ((result: TranslationResult) => void) | null = null;
  private activePromise: Promise<TranslationResult> | null = null;

  constructor(adapter: RuntimeAdapter) {
    this.adapter = adapter;
  }

  /** The jobId of the single active job, or null when idle. */
  get activeJobId(): string | null {
    return this.activeJobIdValue;
  }

  /** Local prerequisite check only; delegates to the adapter. */
  checkAvailability(): Promise<RuntimeStatus> {
    return this.adapter.checkAvailability();
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const validation = validateTranslationRequest(request);
    if (!validation.ok) {
      throw new TranslationServiceError(validation.issue.code, validation.issue.messageRedacted);
    }
    if (this.activeJobIdValue !== null) {
      throw new TranslationServiceError(ACTIVE_JOB_CODE, 'another translation job is already active');
    }
    const jobId = request.jobId;
    this.activeJobIdValue = jobId;
    this.activePromise = new Promise<TranslationResult>((resolve) => {
      this.activeSettle = resolve;
    });
    let result: TranslationResult;
    try {
      const raw = await this.adapter.translate(request);
      result = enforceTranslationResult(request, raw);
    }
    catch (error) {
      // An adapter that throws is a contract violation; surface a terminal
      // failure instead of leaking the adapter error or a raw value.
      result = failedResult(jobId, 'RUNTIME_ADAPTER_ERROR', 'the runtime adapter failed without returning a result');
    }
    this.activeSettle?.(result);
    if (this.activeJobIdValue === jobId) {
      this.activeJobIdValue = null;
      this.activeSettle = null;
      this.activePromise = null;
    }
    return result;
  }

  /**
   * Cancel the identified active job. Rejects a jobId that is not the active
   * job, and resolves only after the adapter confirmed the stop and the job
   * settled as cancelled.
   */
  async cancel(jobId: string): Promise<void> {
    if (this.activeJobIdValue === null || this.activeJobIdValue !== jobId) {
      throw new TranslationServiceError(NO_SUCH_JOB_CODE, 'no active job matches the requested jobId');
    }
    await this.adapter.cancel(jobId);
    const settled = this.activePromise;
    if (settled) {
      const result = await settled;
      if (result.status !== 'cancelled') {
        throw new TranslationServiceError(CANCEL_NOT_HONORED_CODE, 'the adapter did not settle the cancelled job as cancelled');
      }
    }
    if (this.activeJobIdValue === jobId) {
      this.activeJobIdValue = null;
      this.activeSettle = null;
      this.activePromise = null;
    }
  }
}
