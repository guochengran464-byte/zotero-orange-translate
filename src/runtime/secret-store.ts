/**
 * M2D synthetic secret-store contract and redacted state mapping.
 *
 * This module is host-free: it defines the narrow, injected `SecretStorePort`
 * that a future host wiring would implement, plus the stable state names and
 * the mapping from a non-ready state to a stable, redacted failure code. It
 * never reads, invents, logs or serializes a credential; only the ready lease
 * carries one, and only in memory.
 *
 * Threat-model note: JavaScript strings are not reliably zeroizable and this
 * contract makes no claim about same-user process inspection. There is no
 * plaintext fallback and no automatic provider switch.
 */

/**
 * The reflective state of a credential lookup. `ready` means only that a
 * credential was retrieved for this provider+job; it says nothing about the
 * provider being reachable or the key being valid.
 */
export type SecretStoreState =
  | 'ready'
  | 'missing'
  | 'unavailable'
  | 'locked'
  | 'cancelled'
  | 'error';

/** A ready lease: the credential for exactly one provider and one job. */
export interface SecretLeaseReady {
  state: 'ready';
  /** Must equal the requested provider id. */
  providerId: string;
  /** Must equal the requested job id. */
  jobId: string;
  /** The credential value; in-memory only, never serialized by this module. */
  apiKey: string;
}

/** A non-ready lease: no credential value is present. */
export interface SecretLeaseNotReady {
  state: 'missing' | 'unavailable' | 'locked' | 'cancelled' | 'error';
}

export type SecretLease = SecretLeaseReady | SecretLeaseNotReady;

/**
 * The injected credential store. `retrieveForJob` returns a one-job lease that
 * the caller drops at terminal settlement; it must never be persisted. `save`
 * and `delete` are host concerns; this task ships only a test fake.
 */
export interface SecretStorePort {
  save(providerId: string, secret: string): Promise<void>;
  retrieveForJob(providerId: string, jobId: string): Promise<SecretLease>;
  delete(providerId: string): Promise<void>;
}

/**
 * Stable failure codes for non-ready store outcomes. Distinct so a missing
 * credential is never conflated with an unavailable/locked/cancelled/errored
 * store, and a lease that does not match the requested provider+job is its own
 * code. None of these carries a credential or echoes a store message.
 */
export const SECRET_STATE_FAILURE_CODES = {
  missing: 'SECRET_MISSING',
  unavailable: 'SECRET_STORE_UNAVAILABLE',
  locked: 'SECRET_STORE_LOCKED',
  cancelled: 'SECRET_STORE_CANCELLED',
  error: 'SECRET_STORE_ERROR',
} as const;

/** Code used when a ready lease names a different provider or job. */
export const SECRET_LEASE_MISMATCH_CODE = 'SECRET_LEASE_MISMATCH';

export function isReadyLease(lease: unknown): lease is SecretLeaseReady {
  return typeof lease === 'object'
    && lease !== null
    && (lease as { state?: unknown }).state === 'ready'
    && typeof (lease as { apiKey?: unknown }).apiKey === 'string';
}

/** True only when a ready lease carries the requested provider and job. */
export function leaseMatches(
  lease: SecretLeaseReady,
  providerId: string,
  jobId: string,
): boolean {
  return lease.providerId === providerId && lease.jobId === jobId;
}

/**
 * Map a non-ready state to its stable failure code. An unknown/malformed state
 * maps to the generic store-error code rather than echoing anything from the
 * store.
 */
export function secretFailureCodeForState(state: unknown): string {
  if (typeof state === 'string'
    && Object.prototype.hasOwnProperty.call(SECRET_STATE_FAILURE_CODES, state)) {
    return SECRET_STATE_FAILURE_CODES[state as keyof typeof SECRET_STATE_FAILURE_CODES];
  }
  // An unknown, malformed or inherited state (e.g. 'toString') is never a code.
  return SECRET_STATE_FAILURE_CODES.error;
}

export const SECRET_LEASE_MISMATCH_MESSAGE = 'the credential did not match the requested provider and job';
