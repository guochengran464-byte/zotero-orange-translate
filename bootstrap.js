/*
 * Orange Translate - thin bootstrap entry point.
 *
 * Owned by DS. Zotero loads this file as a classic script into the plugin
 * sandbox (frozen evidence: Zotero.Plugins._loadScope loads
 * rootURI + 'bootstrap.js' with target = plugin scope in
 * zotero-10.0.2-plugins.js:203-215).
 *
 * Host ABI: Zotero calls every entry point as func.call(scope, params, reason)
 * (zotero-10.0.2-plugins.js:248-258), so install/startup/shutdown/uninstall all
 * receive (data, reason). The lifecycle module takes a single reason.
 *
 * M1 keeps this layer thin. It owns the only access to plugin-scope Zotero
 * globals: it gathers the small Zotero surface the resolver needs and injects it
 * into the bundled module. The module is otherwise host-free and testable in
 * Node, where no surface is provided and no menu is registered.
 */

var _otLifecycle = null;
var _otLifecycleScope = null;
var _otPaneID = null;

var _otPrefDebug = "extensions.orange-translate.debug";
var _otLogPrefix = "[Orange Translate M0]";
var _otLifecycleFile = "lifecycle.js";
var _otLifecycleGlobal = "OrangeTranslateLifecycle";

var _otHost = {
  debug: function (message) {
    var enabled = false;
    try {
      enabled = Services.prefs.getBoolPref(_otPrefDebug, false) === true;
    }
    catch (e) {
      enabled = false;
    }
    if (!enabled) {
      return;
    }
    try {
      Zotero.debug(_otLogPrefix + " " + String(message));
    }
    catch (e) {
      // A failing debug channel must not break lifecycle transitions.
      _otHost.reportError(e);
    }
  },

  reportError: function (error) {
    try {
      Zotero.logError(error);
    }
    catch (e) {
      // Diagnostics must never break lifecycle transitions.
    }
  },

  // Filled in by _otCreateZoteroSurface() on first startup. Stays null when the
  // required host APIs are unavailable, so the module registers no menu.
  zotero: null,
  pluginID: null
};

/**
 * Collect the Zotero surface the resolver needs. Returns null unless every
 * required API is present, so a partial host can never half-register a menu.
 */
function _otCreateZoteroSurface(api) {
  try {
    if (typeof Zotero === "undefined" || !Zotero) {
      return null;
    }
    if (!Zotero.MenuManager || !Zotero.Items || !Zotero.File) {
      return null;
    }
    if (!Services || !Services.prompt) {
      return null;
    }
    return {
      MenuManager: Zotero.MenuManager,
      prompt: Services.prompt,
      getMainWindow: function () {
        return Zotero.getMainWindow();
      },
      getItems: function (ids) {
        return Zotero.Items.get(ids);
      },
      pathToFile: function (p) {
        return Zotero.File.pathToFile(p);
      },
      onTranslatePdf: async function (candidate) {
        var win = Zotero.getMainWindow();
        return api.translatePdf(candidate, { Zotero: Zotero, Services: Services,
          Components: Components, IOUtils: IOUtils, PathUtils: PathUtils,
          ChromeUtils: ChromeUtils, win: win });
      },
      onCancelTranslation: async function () {
        try {
          if (!(await api.cancelTranslation())) {
            Services.prompt.alert(Zotero.getMainWindow(), 'Orange Translate', '没有可取消的翻译任务，或已进入附件回挂阶段。');
          }
        }
        catch (e) {
          Services.prompt.alert(Zotero.getMainWindow(), 'Orange Translate', '尚未确认翻译进程停止。请退出 Zotero 后再尝试。');
        }
      },
      onOpenApiSettings: function () {
        Zotero.Utilities.Internal.openPreferences('orange-translate-api');
      }
    };
  }
  catch (e) {
    return null;
  }
}

function _otReleaseState() {
  _otLifecycle = null;
  _otLifecycleScope = null;
  _otHost.zotero = null;
  _otHost.pluginID = null;
}

function _otLoadLifecycle(rootURI, data) {
  var scope = {};
  Services.scriptloader.loadSubScriptWithOptions(rootURI + _otLifecycleFile, {
    target: scope,
    ignoreCache: true
  });
  var api = scope[_otLifecycleGlobal];
  if (!api || typeof api.createLifecycle !== "function") {
    throw new Error(_otLogPrefix + " " + _otLifecycleFile + " did not expose "
      + _otLifecycleGlobal + ".createLifecycle");
  }
  _otHost.zotero = _otCreateZoteroSurface(api);
  _otHost.pluginID = data && data.id ? data.id : null;
  _otLifecycleScope = scope;
  return api.createLifecycle(_otHost);
}

function install(data, reason) {
  // No resources are requested or allocated at install time.
}

function startup(data, reason) {
  if (!_otLifecycle) {
    _otLifecycle = _otLoadLifecycle(data.rootURI, data);
  }
  _otLifecycle.startup({ id: data.id, version: data.version, rootURI: data.rootURI }, reason);
  if (typeof _otLifecycleScope[_otLifecycleGlobal].registerApiPane !== 'function') { return; }
  return _otLifecycleScope[_otLifecycleGlobal].registerApiPane({ Zotero: Zotero }, data.id).then(function (id) {
    if (!_otLifecycle && id) { Zotero.PreferencePanes.unregister(id); }
    else { _otPaneID = id; }
  }).catch(function () { _otHost.debug('API preferences registration failed'); });
}

function shutdown(data, reason) {
  if (_otPaneID) { Zotero.PreferencePanes.unregister(_otPaneID); _otPaneID = null; }
  var api = _otLifecycleScope && _otLifecycleScope[_otLifecycleGlobal];
  var pending = api && api.stopTranslation ? api.stopTranslation() : undefined;
  try {
    if (_otLifecycle) {
      _otLifecycle.shutdown(reason);
    }
  }
  finally {
    _otReleaseState();
  }
  return pending;
}

function uninstall(data, reason) {
  if (_otPaneID) { Zotero.PreferencePanes.unregister(_otPaneID); _otPaneID = null; }
  var api = _otLifecycleScope && _otLifecycleScope[_otLifecycleGlobal];
  var pending = api && api.stopTranslation ? api.stopTranslation() : undefined;
  try {
    if (_otLifecycle) {
      _otLifecycle.uninstall(reason);
    }
  }
  finally {
    _otReleaseState();
  }
  return pending;
}
