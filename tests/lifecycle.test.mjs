/**
 * Behavior tests for src/zotero/lifecycle.ts.
 * Uses Node 24 built-in TypeScript type stripping (default in Node 24).
 * No external dependencies; uses node:test and node:assert only.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Import the TypeScript source directly — Node 24 strips types automatically.
import { createLifecycle } from '../src/zotero/lifecycle.ts';

// --- Test doubles ---

function createHost() {
  const debugCalls = [];
  const errorCalls = [];
  return {
    debug(msg) { debugCalls.push(msg); },
    reportError(err) { errorCalls.push(err); },
    debugCalls,
    errorCalls,
  };
}

// debug always throws; reportError records calls so we can assert the
// exception chain (debug failure -> reportError) actually executes.
function createHostWithDebugFailure() {
  const errorCalls = [];
  let debugThrows = 0;
  return {
    debug() { debugThrows++; throw new Error('debug broken'); },
    reportError(err) { errorCalls.push(err); },
    errorCalls,
    get debugThrows() { return debugThrows; },
  };
}

// Both debug and reportError throw; lifecycle must stay silent and correct.
function createHostWithDoubleFailure() {
  let debugThrows = 0;
  let errorThrows = 0;
  return {
    debug() { debugThrows++; throw new Error('debug broken'); },
    reportError() { errorThrows++; throw new Error('reportError broken'); },
    get debugThrows() { return debugThrows; },
    get errorThrows() { return errorThrows; },
  };
}

const STARTUP_DATA = { id: 'orange-translate-dev@local.invalid', version: '0.0.1', rootURI: 'chrome://orange-translate/' };

// --- Tests ---

describe('createLifecycle', () => {
  let host;
  let lc;

  beforeEach(() => {
    host = createHost();
    lc = createLifecycle(host);
  });

  it('initial state is stopped', () => {
    assert.equal(lc.getState(), 'stopped');
  });

  it('startup transitions to started', () => {
    lc.startup(STARTUP_DATA, 1);
    assert.equal(lc.getState(), 'started');
    assert.ok(host.debugCalls.some(m => m.includes('startup')));
  });

  it('double startup does not re-initialize', () => {
    lc.startup(STARTUP_DATA, 1);
    const callsAfterFirst = host.debugCalls.length;
    lc.startup(STARTUP_DATA, 1);
    assert.equal(lc.getState(), 'started');
    // Should log "ignored" but not re-register
    assert.ok(host.debugCalls.some(m => m.includes('ignored')));
    assert.ok(host.debugCalls.length > callsAfterFirst); // logs the ignore
  });

  it('shutdown transitions to stopped', () => {
    lc.startup(STARTUP_DATA, 1);
    lc.shutdown(2);
    assert.equal(lc.getState(), 'stopped');
    assert.ok(host.debugCalls.some(m => m.includes('shutdown')));
  });

  it('double shutdown does not throw', () => {
    lc.startup(STARTUP_DATA, 1);
    lc.shutdown(2);
    assert.doesNotThrow(() => lc.shutdown(2));
    assert.equal(lc.getState(), 'stopped');
  });

  it('uninstall transitions to stopped', () => {
    lc.startup(STARTUP_DATA, 1);
    lc.uninstall(3);
    assert.equal(lc.getState(), 'stopped');
    assert.ok(host.debugCalls.some(m => m.includes('uninstall')));
  });

  it('uninstall on stopped state is a no-op', () => {
    assert.doesNotThrow(() => lc.uninstall(3));
    assert.equal(lc.getState(), 'stopped');
    assert.ok(host.debugCalls.some(m => m.includes('ignored')));
  });

  it('shutdown then uninstall does not throw', () => {
    lc.startup(STARTUP_DATA, 1);
    lc.shutdown(2);
    assert.doesNotThrow(() => lc.uninstall(3));
    assert.equal(lc.getState(), 'stopped');
  });

  it('startup after shutdown works (re-enable cycle)', () => {
    lc.startup(STARTUP_DATA, 1);
    lc.shutdown(2);
    lc.startup(STARTUP_DATA, 1);
    assert.equal(lc.getState(), 'started');
  });

  it('debug failure during startup calls reportError and does not prevent state transition', () => {
    const badHost = createHostWithDebugFailure();
    const badLc = createLifecycle(badHost);
    assert.doesNotThrow(() => badLc.startup(STARTUP_DATA, 1));
    assert.equal(badLc.getState(), 'started');
    // debug threw once (the startup log); reportError must be called exactly once
    assert.equal(badHost.debugThrows, 1);
    assert.equal(badHost.errorCalls.length, 1);
    assert.equal(badHost.errorCalls[0].message, 'debug broken');
  });

  it('debug failure during shutdown calls reportError and does not prevent state reset', () => {
    const badHost = createHostWithDebugFailure();
    const badLc = createLifecycle(badHost);
    badLc.startup(STARTUP_DATA, 1);
    assert.equal(badLc.getState(), 'started');
    assert.doesNotThrow(() => badLc.shutdown(2));
    assert.equal(badLc.getState(), 'stopped');
    // startup + shutdown each triggered one debug failure -> one reportError each
    assert.equal(badHost.debugThrows, 2);
    assert.equal(badHost.errorCalls.length, 2);
  });

  it('debug failure during uninstall calls reportError and does not prevent state reset', () => {
    const badHost = createHostWithDebugFailure();
    const badLc = createLifecycle(badHost);
    badLc.startup(STARTUP_DATA, 1);
    assert.doesNotThrow(() => badLc.uninstall(3));
    assert.equal(badLc.getState(), 'stopped');
    assert.equal(badHost.debugThrows, 2);
    assert.equal(badHost.errorCalls.length, 2);
  });

  it('reportError failure does not block lifecycle when debug also fails', () => {
    const badHost = createHostWithDoubleFailure();
    const badLc = createLifecycle(badHost);
    assert.doesNotThrow(() => badLc.startup(STARTUP_DATA, 1));
    assert.equal(badLc.getState(), 'started');
    assert.doesNotThrow(() => badLc.shutdown(2));
    assert.equal(badLc.getState(), 'stopped');
    assert.doesNotThrow(() => badLc.uninstall(3));
    assert.equal(badLc.getState(), 'stopped');
    // startup debug fail (1 reportError) + shutdown debug fail (1) + uninstall ignored debug fail (1)
    assert.equal(badHost.debugThrows, 3);
    assert.equal(badHost.errorThrows, 3);
  });

  it('diagnostic messages contain only fixed fields (event, id, version, reason)', () => {
    lc.startup(STARTUP_DATA, 1);
    lc.shutdown(2);
    lc.uninstall(3);
    for (const msg of host.debugCalls) {
      // Fixed format: "<event> id=<id> version=<version> reason=<reason>"
      // The "[Orange Translate M0]" prefix is added by the bootstrap wrapper,
      // not by this module, so messages here must not contain it.
      assert.ok(!msg.startsWith('[Orange Translate M0]'), 'no prefix duplication');
      assert.ok(/ id=\S+ version=\S+ reason=-?\d+$/.test(msg), 'fixed field format');
      // Must not contain arbitrary paths or user data
      assert.ok(!msg.includes('\\'), 'no absolute paths');
      assert.ok(!msg.includes(STARTUP_DATA.rootURI), 'no rootURI value in log');
    }
  });

  it('multiple startup/shutdown cycles complete without error', () => {
    // M0 has no menus, windows, observers, timers, processes, or file resources
    // (verified by source review; this test only asserts observable behavior).
    lc.startup(STARTUP_DATA, 1);
    lc.shutdown(2);
    lc.startup(STARTUP_DATA, 1);
    lc.shutdown(2);
    lc.startup(STARTUP_DATA, 1);
    lc.uninstall(3);
    assert.equal(lc.getState(), 'stopped');
    // Every message follows the fixed field format
    assert.ok(host.debugCalls.every(m => / id=\S+ version=\S+ reason=-?\d+$/.test(m)));
  });
});
