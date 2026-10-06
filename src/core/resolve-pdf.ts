/**
 * Orange Translate M1 - PDF selection / attachment resolver core.
 *
 * Owner: M1-RESOLVER-01 (DS). Pure logic only: this module must not touch
 * Zotero globals, the filesystem, the network, or any Runtime. The Zotero API
 * adapter in src/zotero feeds it already-normalized descriptors.
 *
 * Identity follows ADR-035: libraryID + parentItemKey (nullable) + attachmentKey
 * are stable; attachmentID is only a session handle. The absolute path is
 * transient and must never be logged or persisted.
 */

export type ResolveErrorCode =
  | 'EMPTY_SELECTION'
  | 'MULTIPLE_SELECTION'
  | 'MULTIPLE_PDF'
  | 'UNSUPPORTED_SELECTION'
  | 'NO_PDF'
  | 'FILE_NOT_FOUND'
  | 'FILE_NOT_READABLE';

export interface PdfCandidate {
  /** Owning Zotero library. */
  libraryID: number;
  /** Parent item key, or null for a standalone PDF attachment. */
  parentItemKey: string | null;
  /** Attachment key: the stable attachment identity. */
  attachmentKey: string;
  /** Numeric item handle for this host session only. */
  attachmentID: number;
  /** Parent item title, used for candidate display. */
  title: string;
  /** Attachment filename, shown in the candidate list. */
  fileName: string;
  /** Transient absolute path resolved for this request. */
  absolutePath: string;
  /**
   * Internal availability state, so a PDF the host enumerated but could not
   * read still reports FILE_NOT_READABLE rather than being downgraded to
   * FILE_NOT_FOUND. Not display text and not logged.
   */
  pathState: 'ok' | 'missing' | 'unreadable';
}

export interface ResolvedPdf extends PdfCandidate {
  kind: 'resolved';
}

export interface ResolveFailure {
  kind: 'error';
  code: ResolveErrorCode;
}

export type ResolveResult = ResolvedPdf | ResolveFailure;

/**
 * A metadata-only decision: which single PDF attachment the selection names.
 * The path has NOT been probed, so a caller can make the multiplicity
 * decision (NO_PDF / MULTIPLE_PDF) before touching getFilePathAsync or the
 * filesystem at all. The probe here carries identity and display fields only;
 * its absolutePath/pathState are not yet meaningful.
 */
export interface SingleTarget {
  kind: 'single';
  probe: AttachmentProbe;
}

export type TargetDecision = SingleTarget | ResolveFailure;

/**
 * Attachment descriptor produced by the Zotero adapter. The adapter is
 * responsible for calling only Zotero APIs, and for reporting whether the file
 * exists and is readable using host primitives.
 */
export interface AttachmentProbe {
  libraryID: number;
  parentItemKey: string | null;
  attachmentKey: string;
  attachmentID: number;
  title: string;
  fileName: string;
  /** True when the host reports a PDF file attachment. */
  isPdf: boolean;
  /** Absolute path when the host could resolve and stat the file. */
  absolutePath: string | null;
  /**
   * File availability, so the contract can distinguish a missing file from
   * an unreadable one (FILE_NOT_FOUND vs FILE_NOT_READABLE).
   * - ok: resolved and readable
   * - missing: no path, or the path does not exist
   * - unreadable: the path exists but cannot be read
   */
  pathState?: 'ok' | 'missing' | 'unreadable';
}

export interface SelectionDescriptor {
  /** Number of explicitly selected top-level/library rows. */
  selectedCount: number;
  /** True when the current selection supports this action at all. */
  supported: boolean;
  /** Parent item key when a single regular item is selected. */
  parentItemKey: string | null;
  /** Attachment key when the selection is a PDF attachment itself. */
  selectedAttachmentKey: string | null;
  /** Parent title for display, when known. */
  title: string;
}

export function failure(code: ResolveErrorCode): ResolveFailure {
  return { kind: 'error', code };
}

/**
 * Decide which single PDF attachment the selection names, using metadata only.
 * This runs BEFORE any path availability or readability check, so a parent
 * with two or more enumerated PDF attachment records returns MULTIPLE_PDF
 * without the adapter ever calling getFilePathAsync or the filesystem on a
 * candidate. A PDF whose path later proves missing or unreadable still counts
 * toward multiplicity and is never dropped in favour of another candidate.
 *
 * Rules (docs/contracts/M1.md, M1R single-PDF contract):
 * - several top-level items selected: MULTIPLE_SELECTION, never guess
 * - unsupported object type or a directly selected non-PDF: UNSUPPORTED_SELECTION
 * - zero PDFs: NO_PDF
 * - two or more local PDFs: MULTIPLE_PDF (no chooser, no pre-selection, and
 *   no guessing the main PDF by file name or size)
 * - one PDF attachment: that single target, which the adapter probes next
 */
export function decideTarget(
  selection: SelectionDescriptor,
  records: AttachmentProbe[],
): TargetDecision {
  if (selection.selectedCount > 1) {
    return failure('MULTIPLE_SELECTION');
  }
  if (selection.selectedCount === 0) {
    return failure('EMPTY_SELECTION');
  }
  if (!selection.supported) {
    return failure('UNSUPPORTED_SELECTION');
  }

  // A directly selected PDF attachment resolves itself.
  if (selection.selectedAttachmentKey) {
    const own = records.find(
      (record) => record.attachmentKey === selection.selectedAttachmentKey,
    );
    if (!own || !own.isPdf) {
      return failure('UNSUPPORTED_SELECTION');
    }
    return { kind: 'single', probe: own };
  }

  if (!selection.parentItemKey) {
    return failure('UNSUPPORTED_SELECTION');
  }

  const pdfs = records.filter(
    (record) => record.isPdf && record.parentItemKey === selection.parentItemKey,
  );
  if (pdfs.length === 0) {
    return failure('NO_PDF');
  }
  if (pdfs.length > 1) {
    // Count PDF attachment records before any path check: a missing or
    // unreadable PDF is still a candidate, so it is never dropped in favour
    // of silently resolving another one. 1.0 handles exactly one PDF per
    // run, so there is no chooser, no pre-selection and no main-PDF guess.
    return failure('MULTIPLE_PDF');
  }
  return { kind: 'single', probe: pdfs[0] };
}

/**
 * Finish a single, now path-probed target: RESOLVED, FILE_NOT_FOUND or
 * FILE_NOT_READABLE. Exactly one enumerated PDF maps its own path state here,
 * and an unreadable file is not downgraded to missing.
 */
export function finalizeSingle(probe: AttachmentProbe): ResolveResult {
  const state = probe.pathState ?? (probe.absolutePath ? 'ok' : 'missing');
  if (state === 'unreadable') {
    return failure('FILE_NOT_READABLE');
  }
  if (state === 'missing' || !probe.absolutePath) {
    return failure('FILE_NOT_FOUND');
  }
  const candidate = toCandidate(probe);
  return { kind: 'resolved', ...candidate };
}

/**
 * Convenience composition for callers that already path-probed candidates:
 * decide the metadata target, then map the file state of a single target.
 */
export function resolveSelection(
  selection: SelectionDescriptor,
  candidates: AttachmentProbe[],
): ResolveResult {
  const decision = decideTarget(selection, candidates);
  if (decision.kind === 'error') {
    return decision;
  }
  return finalizeSingle(decision.probe);
}

function toCandidate(probe: AttachmentProbe): PdfCandidate {
  return {
    libraryID: probe.libraryID,
    parentItemKey: probe.parentItemKey,
    attachmentKey: probe.attachmentKey,
    attachmentID: probe.attachmentID,
    title: probe.title,
    fileName: probe.fileName,
    absolutePath: probe.absolutePath ?? '',
    // Preserve the probe's availability so a chosen unreadable candidate is
    // not downgraded to "missing" once the absolute path is withheld.
    pathState: probe.pathState ?? (probe.absolutePath ? 'ok' : 'missing'),
  };
}

/**
 * Re-verify identity fields before any later stage acts on a PDF. M1 never
 * executes, but the contract requires that the next stage re-check identity.
 */
export function identityMatches(
  expected: Pick<PdfCandidate, 'libraryID' | 'parentItemKey' | 'attachmentKey'>,
  actual: Pick<AttachmentProbe, 'libraryID' | 'parentItemKey' | 'attachmentKey'>,
): boolean {
  return expected.libraryID === actual.libraryID
    && expected.parentItemKey === actual.parentItemKey
    && expected.attachmentKey === actual.attachmentKey;
}
