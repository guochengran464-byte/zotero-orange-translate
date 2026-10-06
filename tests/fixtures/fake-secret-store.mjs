// Test-only fake SecretStore and fake downstream consumer for M2D
// (owner: M2D-SYNTHETIC-SECRET-PIPE-01 / DS).
//
// Provides an injected SecretStorePort fake, a fake translator that captures
// the constructor api_key, and a parser for the on-the-wire credential frame.
// No network, provider, real key or host access. Test fixture only; production
// code must never import it.

export class FakeSecretStore {
  constructor(options = {}) {
    // Reflective state returned by retrieveForJob unless overridden.
    this.state = options.state ?? 'ready';
    this.apiKey = options.apiKey ?? 'OT_SENTINEL_DO_NOT_USE_0000000000000000';
    // When set, the ready lease names a different provider/job (mismatch).
    this.leaseProviderId = options.leaseProviderId ?? null;
    this.leaseJobId = options.leaseJobId ?? null;
    // When true, retrieveForJob throws (error path; must not be echoed).
    this.throwOnRetrieve = options.throwOnRetrieve === true;
    this.saved = new Map();
    this.retrieveCalls = [];
    this.saveCalls = [];
    this.deleteCalls = [];
    this.deleted = new Set();
    // When true, retrieveForJob returns a promise the test resolves later,
    // modelling a store lookup that is slow (helps test the reservation gate).
    this.deferred = options.deferred === true;
    this._pendingRetrieve = null;
  }

  /** Resolve a deferred retrieveForJob with its normal result. */
  resolvePendingRetrieve() {
    if (this._pendingRetrieve) {
      const { resolve } = this._pendingRetrieve;
      this._pendingRetrieve = null;
      resolve(this._leaseFor(this._retrieveArgs.providerId, this._retrieveArgs.jobId));
    }
  }

  _leaseFor(providerId, jobId) {
    if (this.deleted.has(providerId)) {
      return { state: 'missing' };
    }
    if (this.state !== 'ready') {
      return { state: this.state };
    }
    return {
      state: 'ready',
      providerId: this.leaseProviderId ?? providerId,
      jobId: this.leaseJobId ?? jobId,
      apiKey: this.apiKey,
    };
  }

  async save(providerId, secret) {
    this.saveCalls.push({ providerId, secretLength: secret.length });
    this.saved.set(providerId, secret);
    this.deleted.delete(providerId);
  }

  async retrieveForJob(providerId, jobId) {
    this.retrieveCalls.push({ providerId, jobId });
    if (this.throwOnRetrieve) {
      throw new Error('store failure ' + this.apiKey);
    }
    if (this.deferred) {
      this._retrieveArgs = { providerId, jobId };
      return new Promise((resolve) => {
        this._pendingRetrieve = { resolve };
      });
    }
    return this._leaseFor(providerId, jobId);
  }

  async delete(providerId) {
    this.deleteCalls.push(providerId);
    this.saved.delete(providerId);
    this.deleted.add(providerId);
  }
}

/** A fake translator that captures the api_key it was constructed with. */
export class FakeTranslator {
  constructor(apiKey) {
    this.capturedApiKey = apiKey;
    this.constructed = true;
  }
}

/**
 * Parse a credential frame: 4-byte unsigned big-endian payload length followed
 * by a UTF-8 JSON object. Returns null on any structural mismatch, otherwise
 * the decoded fields plus the raw JSON string (so a test can assert field order).
 */
export function parseSecretFrame(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadLength = view.getUint32(0, false);
  if (bytes.length !== 4 + payloadLength) {
    return null;
  }
  const json = Buffer.from(bytes.subarray(4)).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(json);
  }
  catch (e) {
    return null;
  }
  return { payloadLength, json, fields: parsed };
}
