
// M0 thin-entry tests (owner: DS-M0-BUILD).
//
// Loads the real bootstrap.js into a Node vm context that mimics the frozen
// Zotero 10.0.2 host ABI: every entry point is invoked as
// func.call(scope, params, reason) (zotero-10.0.2-plugins.js:248-258), and
// Services.scriptloader.loadSubScriptWithOptions loads lifecycle.js into a
// standalone target scope exposing OrangeTranslateLifecycle.
//
// The lifecycle used here is an in-memory stand-in, per the M0 contract. It is
// never written to an XPI and never substitutes for the KIMI module.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var BOOTSTRAP_SOURCE = readFileSync(path.join(ROOT, 'bootstrap.js'), 'utf8');

// Reason codes from the frozen host (zotero-10.0.2-plugins.js:53-64).
var REASON = {
  APP_STARTUP: 1,
  APP_SHUTDOWN: 2,
  ADDON_ENABLE: 3,
  ADDON_DISABLE: 4,
  ADDON_INSTALL: 5,
  ADDON_UNINSTALL: 6,
  ADDON_UPGRADE: 7,
  ADDON_DOWNGRADE: 8
};

function makeHarness(options) {
  var opts = options || {};
  var debugPref = opts.debugPref === true;
  var state = {
    debugLines: [],
    loggedErrors: [],
    prefReads: [],
    loadCalls: [],
    createCalls: 0,
    lifecycleCalls: []
  };

  function makeLifecycle() {
    return {
      startup: function (data, reason) {
        state.lifecycleCalls.push({ method: 'startup', reason: reason, data: data });
      },
      shutdown: function (reason) {
        state.lifecycleCalls.push({ method: 'shutdown', reason: reason });
      },
      uninstall: function (reason) {
        state.lifecycleCalls.push({ method: 'uninstall', reason: reason });
      }
    };
  }

  var factory = {
    createLifecycle: function (host) {
      state.createCalls += 1;
      state.host = host;
      return makeLifecycle();
    }
  };

  var sandbox = {
    Services: {
      prefs: {
        getBoolPref: function (name, fallback) {
          state.prefReads.push(name);
          return debugPref;
        }
      },
      scriptloader: {
        loadSubScriptWithOptions: function (uri, loadOptions) {
          state.loadCalls.push({ uri: uri, options: loadOptions });
          if (opts.exposeModule === false) { return; }
          if (opts.exposeApi === false) {
            loadOptions.target.OrangeTranslateLifecycle = {};
            return;
          }
          loadOptions.target.OrangeTranslateLifecycle = factory;
        }
      }
    },
    Zotero: {
      debug: function (message) { state.debugLines.push(message); },
      logError: function (error) { state.loggedErrors.push(error); }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(BOOTSTRAP_SOURCE, sandbox, { filename: 'bootstrap.js' });
  return { sandbox: sandbox, state: state, factory: factory };
}

function startupData() {
  return {
    id: 'orange-translate-dev@local.invalid',
    version: '0.0.1',
    rootURI: 'jar:file:///fake/orange.xpi!/'
  };
}

test('install requests no resources', function () {
  var h = makeHarness();
  h.sandbox.install(startupData(), REASON.ADDON_INSTALL);
  assert.equal(h.state.loadCalls.length, 0);
  assert.equal(h.state.createCalls, 0);
  assert.equal(h.state.lifecycleCalls.length, 0);
});

test('startup loads lifecycle.js into a standalone scope and starts once', function () {
  var h = makeHarness();
  var data = startupData();
  h.sandbox.startup(data, REASON.APP_STARTUP);

  assert.equal(h.state.loadCalls.length, 1);
  assert.equal(h.state.loadCalls[0].uri, data.rootURI + 'lifecycle.js');
  assert.equal(h.state.loadCalls[0].options.ignoreCache, true);
  assert.equal(typeof h.state.loadCalls[0].options.target, 'object');
  assert.equal(h.state.createCalls, 1);
  assert.equal(h.state.lifecycleCalls.length, 1);
  assert.equal(h.state.lifecycleCalls[0].method, 'startup');
 assert.equal(h.state.lifecycleCalls[0].reason, REASON.APP_STARTUP);
  // The record is created inside the vm context, so compare field by field
  // instead of using a prototype-sensitive deep equality across realms.
  assert.equal(h.state.lifecycleCalls[0].data.id, data.id);
  assert.equal(h.state.lifecycleCalls[0].data.version, data.version);
  assert.equal(h.state.lifecycleCalls[0].data.rootURI, data.rootURI);
});

test('repeat startup reuses the loaded instance', function () {
  var h = makeHarness();
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  h.sandbox.startup(startupData(), REASON.ADDON_ENABLE);
  assert.equal(h.state.createCalls, 1);
  assert.equal(h.state.loadCalls.length, 1);
  assert.deepEqual(
    h.state.lifecycleCalls.map(function (c) { return c.reason; }),
    [REASON.APP_STARTUP, REASON.ADDON_ENABLE]
  );
});

test('shutdown receives (data, reason) and forwards a numeric reason', function () {
  var h = makeHarness();
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  h.sandbox.shutdown(startupData(), REASON.ADDON_DISABLE);

  var call = h.state.lifecycleCalls[1];
  assert.equal(call.method, 'shutdown');
  assert.equal(typeof call.reason, 'number');
  assert.equal(call.reason, 4);
});

test('uninstall receives (data, reason) and forwards a numeric reason', function () {
  var h = makeHarness();
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  h.sandbox.uninstall(startupData(), REASON.ADDON_UNINSTALL);

  var call = h.state.lifecycleCalls[1];
  assert.equal(call.method, 'uninstall');
  assert.equal(typeof call.reason, 'number');
  assert.equal(call.reason, 6);
});

test('shutdown without a loaded instance is a safe no-op', function () {
  var h = makeHarness();
  h.sandbox.shutdown(startupData(), REASON.APP_SHUTDOWN);
  h.sandbox.uninstall(startupData(), REASON.ADDON_UNINSTALL);
  assert.equal(h.state.lifecycleCalls.length, 0);
  assert.equal(h.state.loadCalls.length, 0);
});

test('shutdown releases state so the next startup reloads', function () {
  var h = makeHarness();
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  h.sandbox.shutdown(startupData(), REASON.ADDON_DISABLE);
  h.sandbox.startup(startupData(), REASON.ADDON_ENABLE);
  assert.equal(h.state.createCalls, 2);
  assert.equal(h.state.loadCalls.length, 2);
});

test('debug output is gated by the debug pref and prefixed once', function () {
  var off = makeHarness({ debugPref: false });
  off.sandbox.startup(startupData(), REASON.APP_STARTUP);
  off.state.host.debug('hello');
  assert.deepEqual(off.state.debugLines, []);
  assert.deepEqual(off.state.prefReads, ['extensions.orange-translate.debug']);

  var on = makeHarness({ debugPref: true });
  on.sandbox.startup(startupData(), REASON.APP_STARTUP);
  on.state.host.debug('shutdown id=x version=0.0.1 reason=4');
  assert.equal(on.state.debugLines.length, 1);
  assert.equal(on.state.debugLines[0], '[Orange Translate M0] shutdown id=x version=0.0.1 reason=4');
});

test('a failing debug channel is reported, not thrown', function () {
  var h = makeHarness({ debugPref: true });
  h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  h.sandbox.Zotero.debug = function () { throw new Error('debug down'); };
  h.state.host.debug('still alive');
  assert.equal(h.state.loggedErrors.length, 1);
});

test('startup fails clearly when lifecycle.js exposes no factory', function () {
  var h = makeHarness({ exposeApi: false });
  assert.throws(function () {
    h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  }, /OrangeTranslateLifecycle\.createLifecycle/);
});

test('startup fails clearly when lifecycle.js is absent', function () {
  var h = makeHarness({ exposeModule: false });
  assert.throws(function () {
    h.sandbox.startup(startupData(), REASON.APP_STARTUP);
  }, /createLifecycle/);
});
