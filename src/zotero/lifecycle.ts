/**
 * Orange Translate - Zotero plugin lifecycle.
 *
 * M0 froze this interface (docs/contracts/M0.md): createLifecycle(host) with
 * startup/shutdown/uninstall/getState and no side effects outside the module.
 *
 * M1 adds one compatible extension: the PDF resolver owns a menu UI resource,
 * so startup registers it and shutdown/uninstall release it symmetrically. The
 * Zotero surface reaches this module through the host object, injected by
 * bootstrap.js; when it is absent (Node tests, or M0-only packaging) no menu is
 * registered and behaviour is identical to M0.
 */

import {
  registerM1Menu,
  type M1MenuHandle,
  type ZoteroSurface,
} from './m1-resources.ts';

export { checkLocalProcess } from './subprocess-host.ts';
export { translatePdf, cancelTranslation, stopTranslation } from './translation.ts';
export { mountProviderSettings, registerApiPane } from './provider-settings.ts';

export interface LifecycleHost {
  debug(message: string): void;
  reportError(error: unknown): void;
  /** M1: Zotero plugin-scope surface, injected by bootstrap.js. */
  zotero?: ZoteroSurface | null;
  /** M1: plugin id used to tag the registered menu. */
  pluginID?: string;
}

export interface StartupData {
  id: string;
  version: string;
  rootURI: string;
}

export type LifecycleState = 'stopped' | 'started';

export interface Lifecycle {
  startup(data: StartupData, reason: number): void;
  shutdown(reason: number): void;
  uninstall(reason: number): void;
  getState(): LifecycleState;
}

/** A UI resource that must be registered on startup and released on teardown. */
export interface LifecycleResourceController {
  register(data: StartupData): void;
  release(): void;
}

export interface LifecycleOptions {
  /** Test seam: replaces the default menu registration entirely. */
  resources?: LifecycleResourceController;
}

/**
 * Register the item-context-menu action when bootstrap injected a Zotero
 * surface; otherwise stay a deliberate no-op so tests and packaged M0 builds
 * never pretend a menu exists.
 */
function createDefaultResources(
  host: LifecycleHost,
  report: (message: string) => void,
): LifecycleResourceController {
  let handle: M1MenuHandle | null = null;

  return {
    register(data: StartupData): void {
      if (handle) {
        return;
      }
      const zotero = host.zotero;
      if (!zotero) {
        return;
      }
      try {
        handle = registerM1Menu(
          {
            pluginID: host.pluginID ?? data.id,
            zotero,
            debug: host.debug,
            reportError: host.reportError,
          },
          report,
        );
      }
      catch (e) {
        handle = null;
        try {
          host.reportError(e);
        }
        catch (_) {
          // Diagnostics must never block a lifecycle transition.
        }
      }
    },

    release(): void {
      const current = handle;
      handle = null;
      if (!current) {
        return;
      }
      try {
        current.unregister();
      }
      catch (e) {
        try {
          host.reportError(e);
        }
        catch (_) {
          // Diagnostics must never block a lifecycle transition.
        }
      }
    },
  };
}

export function createLifecycle(
  host: LifecycleHost,
  options?: LifecycleOptions,
): Lifecycle {
  let state: LifecycleState = 'stopped';
  let pluginId: string | null = null;
  let pluginVersion: string | null = null;

  // Log prefix "[Orange Translate M0]" is added by the bootstrap debug wrapper
  // (DS side), not here, to avoid double-prefixing after integration.
  function log(event: string, reason: number): void {
    const message = event + ' id=' + (pluginId ?? 'unknown') + ' version=' + (pluginVersion ?? 'unknown') + ' reason=' + reason;
    try {
      host.debug(message);
    } catch (e) {
      try {
        host.reportError(e);
      } catch (_) {
        // Both debug and reportError failed; must not block state transitions.
      }
    }
  }

  // Resource diagnostics use fixed event names only: no paths, keys or user data.
 const resources: LifecycleResourceController = options?.resources
   ?? createDefaultResources(host, (event: string) => log(event, state === 'started' ? 1 : 2));

  // Teardown must always reach the state reset, so a failing release is
  // reported rather than propagated (same rule as the M0 log path).
  function releaseResources(): void {
    try {
      resources.release();
    }
    catch (e) {
      try {
        host.reportError(e);
      }
      catch (_) {
        // Diagnostics must never block a lifecycle transition.
      }
    }
  }

  return {
    startup(data: StartupData, reason: number): void {
      if (state === 'started') {
        log('startup ignored (already started)', reason);
        return;
      }
      pluginId = data.id;
      pluginVersion = data.version;
      state = 'started';
      try {
        resources.register(data);
      }
      catch (e) {
        try {
          host.reportError(e);
        }
        catch (_) {
          // A failing resource registration must not break startup bookkeeping.
        }
      }
      log('startup', reason);
    },

    shutdown(reason: number): void {
      if (state !== 'started') {
        log('shutdown ignored (not started)', reason);
        return;
      }
      try {
        log('shutdown', reason);
      } finally {
        releaseResources();
        state = 'stopped';
      }
    },

    uninstall(reason: number): void {
      if (state !== 'started') {
        log('uninstall ignored (not started)', reason);
        return;
      }
      try {
        log('uninstall', reason);
      } finally {
        releaseResources();
        state = 'stopped';
      }
    },

    getState(): LifecycleState {
      return state;
    },
  };
}
