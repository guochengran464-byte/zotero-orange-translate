/**
 * M2A contract boundary between Orange Translate core and a local translation
 * runtime. These types contain plain data only and have no Zotero dependency.
 */

export type TranslationOutputMode = 'dual' | 'mono' | 'both';

export interface TranslationProviderConfig {
  /** Explicit provider identifier; an empty/missing-key provider is never inferred. */
  id: string;
  model?: string;
  /** Endpoint only; must not embed URL userinfo, tokens, or other credentials. */
  baseUrl?: string;
}

export interface TranslationRequest {
  schemaVersion: 1;
  /** UUID for this single job; used to isolate output and correlate the result. */
  jobId: string;
  /** Absolute path to the selected local PDF. Treat as transient private data. */
  inputPdf: string;
  /** Absolute, fresh output directory owned by this job. */
  outputDir: string;
  language: {
    source: 'en';
    target: 'zh';
  };
  provider: TranslationProviderConfig;
  outputMode: TranslationOutputMode;
}

export interface RuntimeDiagnostic {
  code: string;
  /** Safe for display/logging; must not contain keys, document text, or full paths. */
  messageRedacted: string;
}

export interface RuntimeStatus {
  /** Local runtime availability only; this does not test provider/network access. */
  availability: 'available' | 'missing' | 'incompatible' | 'busy' | 'error';
  checkedAt: string;
  runtimeVersion?: string;
  diagnostic?: RuntimeDiagnostic;
}

export type TranslationOutputs =
  | { dualPdf: string; monoPdf?: string }
  | { dualPdf?: never; monoPdf: string };

export interface TranslationRuntimeInfo {
  version?: string;
  babeldocVersion?: string;
}

export interface TranslationError {
  code: string;
  /** Redacted, actionable summary; never raw stdout/stderr or provider response. */
  messageRedacted: string;
  retryable?: boolean;
}

interface TranslationResultBase {
  schemaVersion: 1;
  jobId: string;
  runtime?: TranslationRuntimeInfo;
}

export type TranslationResult =
  | (TranslationResultBase & {
      status: 'completed';
      outputs: TranslationOutputs;
      error?: never;
    })
  | (TranslationResultBase & {
      status: 'failed';
      outputs?: never;
      error: TranslationError;
    })
  | (TranslationResultBase & {
      status: 'cancelled';
      outputs?: never;
      error?: TranslationError;
    });

export interface RuntimeAdapter {
  /** Inspect local prerequisites only; must not download or launch the runtime. */
  checkAvailability(): Promise<RuntimeStatus>;

  /** Execute one request and return a terminal result for the same jobId. */
  translate(request: TranslationRequest): Promise<TranslationResult>;

  /**
   * Cancel the identified active job. Resolve only after its owned process family
   * is confirmed stopped; translate() must then settle with status 'cancelled'.
   */
  cancel(jobId: string): Promise<void>;
}
