/**
 * M1 lifecycle resource tests (owner: M1-RESOLVER-01 / DS).
 *
 * M1 adds a menu UI resource to the frozen M0 lifecycle, so the contract
 * requires symmetric registration and cleanup on disable/enable cycles
 * (docs/contracts/M1.md: "生命周期需注册的任何菜单或 UI 资源必须在
 * shutdown/uninstall 对称清理").
 *
 * Uses the injectable resource seam rather than patching globals, so these
 * assertions are about lifecycle bookkeeping, not about Zotero itself.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLifecycle } from '../src/zotero/lifecycle.ts';

function makeHost() {
  const debugCalls = [];
  const errorCalls = [];
  return {
    debug(message) { debugCalls.push(message); },
    reportError(error) { errorCalls.push(error); },
    debugCalls,
    errorCalls,
  };
}

function makeResources(log) {
  return {
    register(data) { log.push('register:' + data.id); },
    release() { log.push('release'); },
  };
}

const STARTUP_DATA = { id: 'orange-translate-dev@local.invalid', version: '0.0.1', rootURI: 'chrome://orange-translate/' };

describe('M1 lifecycle resource symmetry', () => {
  it('registers the menu resource exactly once on startup', () => {
    const log = [];
    const lc = createLifecycle(makeHost(), { resources: makeResources(log) });
    lc.startup(STARTUP_DATA, 1);
    assert.deepEqual(log, ['register:orange-translate-dev@local.invalid']);
  });

  it('releases the resource on shutdown', () => {
    const log = [];
    const lc = createLifecycle(makeHost(), { resources: makeResources(log) });
    lc.startup(STARTUP_DATA, 1);
    lc.shutdown(4);
    assert.deepEqual(log, ['register:orange-translate-dev@local.invalid', 'release']);
    assert.equal(lc.getState(), 'stopped');
  });

  it('releases the resource on uninstall', () => {
    const log = [];
    const lc = createLifecycle(makeHost(), { resources: makeResources(log) });
    lc.startup(STARTUP_DATA, 1);
    lc.uninstall(6);
    assert.deepEqual(log, ['register:orange-translate-dev@local.invalid', 'release']);
  });

  it('disable/enable cycle re-registers rather than leaking the old menu', () => {
    const log = [];
    const lc = createLifecycle(makeHost(), { resources: makeResources(log) });
    lc.startup(STARTUP_DATA, 1);
    lc.shutdown(4);
    lc.startup(STARTUP_DATA, 3);
    assert.deepEqual(log, [
      'register:orange-translate-dev@local.invalid',
      'release',
      'register:orange-translate-dev@local.invalid',
    ]);
  });

  it('repeat shutdown does not release twice', () => {
    const log = [];
    const lc = createLifecycle(makeHost(), { resources: makeResources(log) });
    lc.startup(STARTUP_DATA, 1);
    lc.shutdown(2);
    lc.shutdown(2);
    assert.deepEqual(log, ['register:orange-translate-dev@local.invalid', 'release']);
  });

  it('repeat startup does not double-register', () => {
    const log = [];
    const lc = createLifecycle(makeHost(), { resources: makeResources(log) });
    lc.startup(STARTUP_DATA, 1);
    lc.startup(STARTUP_DATA, 1);
    assert.deepEqual(log, ['register:orange-translate-dev@local.invalid']);
  });

  it('uninstall without a prior startup does not release', () => {
    const log = [];
    const lc = createLifecycle(makeHost(), { resources: makeResources(log) });
    lc.uninstall(6);
    assert.deepEqual(log, []);
  });

  it('a throwing register does not block the started state', () => {
    const host = makeHost();
    const lc = createLifecycle(host, {
      resources: {
        register() { throw new Error('register failed'); },
        release() {},
      },
    });
    assert.doesNotThrow(() => lc.startup(STARTUP_DATA, 1));
    assert.equal(lc.getState(), 'started');
    assert.equal(host.errorCalls.length, 1);
  });

  it('a throwing release still resets the state to stopped', () => {
    const host = makeHost();
    const lc = createLifecycle(host, {
      resources: {
        register() {},
        release() { throw new Error('release failed'); },
      },
    });
    lc.startup(STARTUP_DATA, 1);
    assert.doesNotThrow(() => lc.shutdown(4));
    assert.equal(lc.getState(), 'stopped');
    assert.equal(host.errorCalls.length, 1);
  });

  it('registers nothing when no Zotero surface is injected (Node/M0-only)', () => {
    // No resources option and no host.zotero: the default controller stays a
    // deliberate no-op, so M0 packaging behaviour is preserved exactly.
    const host = makeHost();
    const lc = createLifecycle(host);
    assert.doesNotThrow(() => lc.startup(STARTUP_DATA, 1));
    assert.equal(lc.getState(), 'started');
    assert.doesNotThrow(() => lc.shutdown(4));
    assert.equal(lc.getState(), 'stopped');
  });

  it('diagnostics still use the frozen fixed-field format', () => {
    const host = makeHost();
    const lc = createLifecycle(host, { resources: makeResources([]) });
    lc.startup(STARTUP_DATA, 1);
    lc.shutdown(4);
    for (const message of host.debugCalls) {
      assert.ok(/ id=\S+ version=\S+ reason=-?\d+$/.test(message), 'fixed field format: ' + message);
      assert.ok(!message.includes(STARTUP_DATA.rootURI));
      assert.ok(!message.includes('\\'));
    }
  });
});
