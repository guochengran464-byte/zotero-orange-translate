/**
 * M1 Zotero-adapter tests (owner: M1-RESOLVER-01 / DS).
 *
 * These exercise the adapter against a fake Zotero surface that mirrors the
 * frozen 10.0.2 host shapes: context.items, item.getAttachments(),
 * isPDFAttachment(), getFilePathAsync(), Zotero.Items.get(ids),
 * MenuManager.registerMenu/unregisterMenu and Services.prompt.alert. Orange
 * Translate 1.0 uses no native chooser, so the fake surface (and these tests)
 * deliberately have no Services.prompt.select.
 *
 * The fake host is an in-memory stand-in; it is NOT host evidence and never
 * replaces the isolated Zotero run owned by M1-VERIFY-01.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MENU_ID,
  MENU_LABEL,
  MENU_TARGET,
  describeFailure,
  handleResolveCommand,
  readSelection,
  registerM1Menu,
  resolveFromContext,
} from '../src/zotero/m1-resources.ts';

// --- Fake Zotero surface -----------------------------------------------------

function makeAttachment({
  key,
  parentItemKey,
  id,
  isPdf = true,
  filePath = 'C:/lib/storage/' + key + '/file.pdf',
  fileName = 'file.pdf',
  title = 'Attachment Title',
  isFileAttachment = true,
} = {}) {
  return {
    id,
    key,
    libraryID: 1,
    parentItemKey,
    attachmentFilename: fileName,
    isAttachment: () => true,
    isFileAttachment: () => isFileAttachment,
    isPDFAttachment: () => isPdf,
    getDisplayTitle: () => title,
    getFilePathAsync: async () => (filePath === null ? false : filePath),
  };
}

function makeRegularItem({ key, title = 'A Study', attachmentIDs = [] } = {}) {
  return {
    id: 900,
    key,
    libraryID: 1,
    parentItemKey: null,
    isAttachment: () => false,
    isRegularItem: () => true,
    getDisplayTitle: () => title,
    getAttachments: () => attachmentIDs,
  };
}

function makeHost(options = {}) {
  const state = {
    registered: [],
    unregistered: [],
    alerts: [],
    selectCalls: [],
    reports: [],
    // Path-probe spies: they must stay at 0 whenever a selection is decided
    // purely from Zotero attachment metadata (e.g. the MULTIPLE_PDF branch).
    getFilePathCalls: [],
    pathToFileCalls: [],
  };
  const itemsByID = new Map();
  for (const [id, item] of options.items ?? []) {
    itemsByID.set(id, item);
    if (item && typeof item.getFilePathAsync === 'function') {
      const original = item.getFilePathAsync;
      item.getFilePathAsync = async function (...args) {
        state.getFilePathCalls.push(item.key);
        return original.apply(item, args);
      };
    }
  }

  const host = {
    pluginID: 'orange-translate-dev@local.invalid',
    debug() {},
    reportError() {},
    zotero: {
      MenuManager: {
        registerMenu(menuOptions) {
          state.registered.push(menuOptions);
          return 'menu-handle-1';
        },
        unregisterMenu(menuID) {
          state.unregistered.push(menuID);
          return true;
        },
      },
      prompt: {
        // Orange Translate 1.0 has no chooser. If a select call ever arrives
        // it is recorded here so tests can assert the count stays at zero.
        select(win, title, text, list, out) {
          state.selectCalls.push({ win, title, text, list, out });
          return false;
        },
        alert(win, title, text) {
          state.alerts.push({ win, title, text });
        },
      },
      getMainWindow: () => ({ id: 'main-window' }),
      getItems(ids) {
        return ids.map((id) => itemsByID.get(id)).filter(Boolean);
      },
      pathToFile(path) {
        state.pathToFileCalls.push(path);
        if (options.unreadablePaths?.includes(path)) {
          return { exists: () => true, isFile: () => true, isReadable: () => false };
        }
        if (options.missingPaths?.includes(path)) {
          return { exists: () => false, isFile: () => true, isReadable: () => true };
        }
        if (options.pathToFileThrows) {
          throw new Error('pathToFile failed');
        }
        return { exists: () => true, isFile: () => true, isReadable: () => true };
      },
    },
  };
  return { host, state, itemsByID };
}

function report() {
  const messages = [];
  const fn = (m) => messages.push(m);
  fn.messages = messages;
  return fn;
}

// --- readSelection -----------------------------------------------------------

describe('readSelection', () => {
  it('treats one regular item as a supported parent selection', () => {
    const item = makeRegularItem({ key: 'P1' });
    const selection = readSelection({ items: [item] });
    assert.equal(selection.selectedCount, 1);
    assert.equal(selection.supported, true);
    assert.equal(selection.parentItemKey, 'P1');
    assert.equal(selection.selectedAttachmentKey, null);
  });

  it('treats one file attachment as a direct attachment selection', () => {
    const attachment = makeAttachment({ key: 'A1', parentItemKey: 'P1', id: 11 });
    const selection = readSelection({ items: [attachment] });
    assert.equal(selection.selectedAttachmentKey, 'A1');
    assert.equal(selection.parentItemKey, 'P1');
    assert.equal(selection.supported, true);
  });

  it('reports several top-level items', () => {
    const selection = readSelection({ items: [makeRegularItem({ key: 'P1' }), makeRegularItem({ key: 'P2' })] });
    assert.equal(selection.selectedCount, 2);
  });

  it('treats an empty context as an empty selection', () => {
    assert.equal(readSelection({}).selectedCount, 0);
    assert.equal(readSelection(undefined).selectedCount, 0);
  });

  it('marks a non-regular, non-attachment object as unsupported', () => {
    const note = { isAttachment: () => false, isRegularItem: () => false, getDisplayTitle: () => 'note' };
    const selection = readSelection({ items: [note] });
    assert.equal(selection.supported, false);
  });
});

// --- resolveFromContext ------------------------------------------------------

describe('resolveFromContext', () => {
  it('resolves a regular item with exactly one local PDF', async () => {
    const pdf = makeAttachment({ key: 'A1', parentItemKey: 'P1', id: 11 });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11] });
    const { host } = makeHost({ items: [[11, pdf]] });
    const result = await resolveFromContext(host, { items: [parent] });
    assert.equal(result.kind, 'resolved');
    assert.equal(result.attachmentKey, 'A1');
    assert.equal(result.absolutePath, 'C:/lib/storage/A1/file.pdf');
  });

  it('returns MULTIPLE_PDF when a parent has several PDFs (no chooser)', async () => {
    const a = makeAttachment({ key: 'A', parentItemKey: 'P1', id: 11, fileName: 'a.pdf' });
    const b = makeAttachment({ key: 'B', parentItemKey: 'P1', id: 12, fileName: 'b.pdf' });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11, 12] });
    const { host } = makeHost({ items: [[11, a], [12, b]] });
    const result = await resolveFromContext(host, { items: [parent] });
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'MULTIPLE_PDF');
  });

  it('ignores non-PDF children', async () => {
    const html = makeAttachment({ key: 'H', parentItemKey: 'P1', id: 11, isPdf: false, fileName: 'page.html' });
    const pdf = makeAttachment({ key: 'P', parentItemKey: 'P1', id: 12 });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11, 12] });
    const { host } = makeHost({ items: [[11, html], [12, pdf]] });
    const result = await resolveFromContext(host, { items: [parent] });
    assert.equal(result.kind, 'resolved');
    assert.equal(result.attachmentKey, 'P');
  });

  it('returns NO_PDF when a regular item has no PDF', async () => {
    const html = makeAttachment({ key: 'H', parentItemKey: 'P1', id: 11, isPdf: false });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11] });
    const { host } = makeHost({ items: [[11, html]] });
    const result = await resolveFromContext(host, { items: [parent] });
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'NO_PDF');
  });

  it('returns FILE_NOT_FOUND when the file is missing', async () => {
    const pdf = makeAttachment({ key: 'A1', parentItemKey: 'P1', id: 11, filePath: null });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11] });
    const { host } = makeHost({ items: [[11, pdf]] });
    const result = await resolveFromContext(host, { items: [parent] });
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'FILE_NOT_FOUND');
  });

  it('returns FILE_NOT_READABLE when the path exists but cannot be read', async () => {
    const pdf = makeAttachment({ key: 'A1', parentItemKey: 'P1', id: 11, filePath: 'C:/locked/a.pdf' });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11] });
    const { host } = makeHost({ items: [[11, pdf]], unreadablePaths: ['C:/locked/a.pdf'] });
    const result = await resolveFromContext(host, { items: [parent] });
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'FILE_NOT_READABLE');
    assert.equal(describeFailure('FILE_NOT_READABLE').includes('权限'), true);
  });

  it('resolves a directly selected standalone PDF', async () => {
    const pdf = makeAttachment({ key: 'S1', parentItemKey: null, id: 11 });
    const { host, itemsByID } = makeHost({ items: [[11, pdf]] });
    itemsByID.set(11, pdf);
    const result = await resolveFromContext(host, { items: [pdf] });
    assert.equal(result.kind, 'resolved');
    assert.equal(result.parentItemKey, null);
  });

  it('normalizes Zotero false standalone parent sentinel to null', async () => {
    const pdf = makeAttachment({ key: 'S_FALSE', parentItemKey: false, id: 12 });
    const { host } = makeHost();
    const selection = readSelection({ items: [pdf] });
    const result = await resolveFromContext(host, { items: [pdf] });

    assert.equal(selection.parentItemKey, null);
    assert.equal(result.kind, 'resolved');
    assert.equal(result.parentItemKey, null);
    assert.equal(result.attachmentKey, 'S_FALSE');
  });

  it('rejects several selected top-level items', async () => {
    const p1 = makeRegularItem({ key: 'P1' });
    const p2 = makeRegularItem({ key: 'P2' });
    const { host } = makeHost();
    const result = await resolveFromContext(host, { items: [p1, p2] });
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'MULTIPLE_SELECTION');
  });

  it('rejects an unsupported object type', async () => {
    const note = { isAttachment: () => false, isRegularItem: () => false, getDisplayTitle: () => 'n' };
    const { host } = makeHost();
    const result = await resolveFromContext(host, { items: [note] });
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'UNSUPPORTED_SELECTION');
  });

  it('keeps Chinese and space characters in the resolved path', async () => {
    const path = 'C:/资料库/我的 论文/研究 报告.pdf';
    const pdf = makeAttachment({ key: 'A1', parentItemKey: 'P1', id: 11, filePath: path });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11] });
    const { host } = makeHost({ items: [[11, pdf]] });
    const result = await resolveFromContext(host, { items: [parent] });
    assert.equal(result.kind, 'resolved');
    assert.equal(result.absolutePath, path);
  });
});

// --- handleResolveCommand ----------------------------------------------------

describe('handleResolveCommand', () => {
  it('resolves and reports a fixed diagnostic without the path', async () => {
    const pdf = makeAttachment({ key: 'A1', parentItemKey: 'P1', id: 11, filePath: 'C:/secret/paper.pdf' });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11] });
    const { host } = makeHost({ items: [[11, pdf]] });
    const rep = report();
    const resolved = await handleResolveCommand(host, { items: [parent] }, rep);
    assert.equal(resolved.attachmentKey, 'A1');
    // Diagnostics must not carry the key, title, file name or path.
    assert.deepEqual(rep.messages, ['resolved single candidate']);
    assert.ok(!rep.messages.join(' ').includes('C:/secret'));
    assert.ok(!rep.messages.join(' ').includes('A1'));
  });

  it('reports MULTIPLE_PDF on several PDFs without opening a chooser', async () => {
    const a = makeAttachment({ key: 'A', parentItemKey: 'P1', id: 11, fileName: 'a.pdf' });
    const b = makeAttachment({ key: 'B', parentItemKey: 'P1', id: 12, fileName: 'b.pdf' });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11, 12] });
    const { host, state } = makeHost({ items: [[11, a], [12, b]] });
    const rep = report();
    const resolved = await handleResolveCommand(host, { items: [parent] }, rep);
    assert.equal(resolved, null);
    // No chooser is ever opened, even when a select index is available.
    assert.equal(state.selectCalls.length, 0);
    assert.deepEqual(rep.messages, ['resolver error code=MULTIPLE_PDF']);
    assert.equal(state.alerts.length, 1);
    assert.equal(state.alerts[0].text, describeFailure('MULTIPLE_PDF'));
    assert.ok(state.alerts[0].text.includes('多个 PDF'));
  });

  it('alerts the user with mapped text on error and logs a fixed code', async () => {
    const { host, state } = makeHost();
    const rep = report();
    const resolved = await handleResolveCommand(host, { items: [] }, rep);
    assert.equal(resolved, null);
    assert.deepEqual(rep.messages, ['resolver error code=EMPTY_SELECTION']);
    assert.equal(state.alerts.length, 1);
    assert.ok(state.alerts[0].text.includes('请先在 Zotero 中选择'));
  });
});

// --- registerM1Menu ----------------------------------------------------------

describe('handleResolveCommand with mixed PDF availability (M1R multiplicity)', () => {
  it('never touches getFilePathAsync or pathToFile when a parent has 2+ PDFs', async () => {
    const a = makeAttachment({ key: 'A', parentItemKey: 'P1', id: 11, fileName: 'a.pdf' });
    const b = makeAttachment({ key: 'B', parentItemKey: 'P1', id: 12, fileName: 'b.pdf' });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11, 12] });
    const { host, state } = makeHost({ items: [[11, a], [12, b]] });
    const result = await resolveFromContext(host, { items: [parent] });
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'MULTIPLE_PDF');
    // MULTIPLE_PDF is decided from enumeration, before any path probing.
    assert.deepEqual(state.getFilePathCalls, []);
    assert.deepEqual(state.pathToFileCalls, []);
  });

  it('2+ PDFs where one path is missing still probe nothing (multiplicity first)', async () => {
    const ok = makeAttachment({ key: 'OK', parentItemKey: 'P1', id: 11, fileName: 'ok.pdf' });
    const gone = makeAttachment({ key: 'GONE', parentItemKey: 'P1', id: 12, filePath: null, fileName: 'gone.pdf' });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11, 12] });
    const { host, state } = makeHost({ items: [[11, ok], [12, gone]] });
    const result = await resolveFromContext(host, { items: [parent] });
    assert.equal(result.code, 'MULTIPLE_PDF');
    // A missing record still counts toward multiplicity and is not dropped.
    assert.deepEqual(state.getFilePathCalls, []);
    assert.deepEqual(state.pathToFileCalls, []);
  });

  it('2+ PDFs where one path is unreadable still probe nothing', async () => {
    const ok = makeAttachment({ key: 'OK', parentItemKey: 'P1', id: 11, fileName: 'ok.pdf' });
    const locked = makeAttachment({ key: 'LOCKED', parentItemKey: 'P1', id: 12, filePath: 'C:/locked/b.pdf', fileName: 'locked.pdf' });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11, 12] });
    const { host, state } = makeHost({ items: [[11, ok], [12, locked]], unreadablePaths: ['C:/locked/b.pdf'] });
    const result = await resolveFromContext(host, { items: [parent] });
    assert.equal(result.code, 'MULTIPLE_PDF');
    assert.deepEqual(state.getFilePathCalls, []);
    assert.deepEqual(state.pathToFileCalls, []);
  });

  it('exactly one PDF is probed exactly once (path lookup happens after the count)', async () => {
    const only = makeAttachment({ key: 'ONLY', parentItemKey: 'P1', id: 11, fileName: 'only.pdf' });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11] });
    const { host, state } = makeHost({ items: [[11, only]] });
    const result = await resolveFromContext(host, { items: [parent] });
    assert.equal(result.kind, 'resolved');
    assert.deepEqual(state.getFilePathCalls, ['ONLY']);
    assert.equal(state.pathToFileCalls.length, 1);
  });

  it('a missing PDF is never dropped: two enumerated PDFs still report MULTIPLE_PDF', async () => {
    const ok = makeAttachment({ key: 'OK', parentItemKey: 'P1', id: 11, fileName: 'ok.pdf' });
    // The second PDF resolves to no path (missing on disk).
    const gone = makeAttachment({ key: 'GONE', parentItemKey: 'P1', id: 12, filePath: null, fileName: 'gone.pdf' });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11, 12] });
    const { host, state } = makeHost({ items: [[11, ok], [12, gone]] });
    const rep = report();
    const resolved = await handleResolveCommand(host, { items: [parent] }, rep);
    assert.equal(resolved, null);
    assert.equal(state.selectCalls.length, 0);
    assert.deepEqual(rep.messages, ['resolver error code=MULTIPLE_PDF']);
    assert.equal(state.alerts.length, 1);
    assert.equal(state.alerts[0].text, describeFailure('MULTIPLE_PDF'));
    const joined = rep.messages.join(' ');
    assert.ok(!joined.includes('OK'));
    assert.ok(!joined.includes('GONE'));
    assert.ok(!joined.includes('C:/'));
  });

  it('an unreadable PDF is never dropped either: two enumerated PDFs report MULTIPLE_PDF', async () => {
    const ok = makeAttachment({ key: 'OK', parentItemKey: 'P1', id: 11, fileName: 'ok.pdf' });
    const locked = makeAttachment({ key: 'LOCKED', parentItemKey: 'P1', id: 12, filePath: 'C:/locked/b.pdf', fileName: 'locked.pdf' });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11, 12] });
    const { host } = makeHost({
      items: [[11, ok], [12, locked]],
      unreadablePaths: ['C:/locked/b.pdf'],
    });
    const rep = report();
    const resolved = await handleResolveCommand(host, { items: [parent] }, rep);
    assert.equal(resolved, null);
    assert.deepEqual(rep.messages, ['resolver error code=MULTIPLE_PDF']);
  });
});

describe('registerM1Menu', () => {
  it('registers against the frozen item-context target', () => {
    const { host, state } = makeHost();
    const rep = report();
    const handle = registerM1Menu(host, rep);
    assert.ok(handle);
    const registered = state.registered[0];
    assert.equal(registered.menuID, MENU_ID);
    assert.equal(registered.target, MENU_TARGET);
    assert.equal(registered.pluginID, 'orange-translate-dev@local.invalid');
    assert.equal(registered.menus[0].menuType, 'submenu');
    assert.equal(typeof registered.menus[0].menus[0].onCommand, 'function');
    assert.equal(typeof registered.menus[0].menus[0].onShowing, 'function');
  });

  it('sets the label on the menu element (no FTL bundle is shipped)', () => {
    const { host, state } = makeHost();
    registerM1Menu(host, report());
    const attributes = {};
    const context = { menuElem: { setAttribute: (k, v) => { attributes[k] = v; } } };
    state.registered[0].menus[0].menus[0].onShowing({}, context);
    assert.equal(attributes.label, MENU_LABEL);
  });

  it('releases the exact registered handle on unregister', () => {
    const { host, state } = makeHost();
    const handle = registerM1Menu(host, report());
    handle.unregister();
    assert.deepEqual(state.unregistered, ['menu-handle-1']);
  });

  it('reports failure and returns null when registration returns false', () => {
    const { host } = makeHost();
    host.zotero.MenuManager.registerMenu = () => false;
    const rep = report();
    assert.equal(registerM1Menu(host, rep), null);
    assert.deepEqual(rep.messages, ['menu registration failed']);
  });

  it('reports and returns null when registration throws', () => {
    const { host } = makeHost();
    host.zotero.MenuManager.registerMenu = () => { throw new Error('boom'); };
    const rep = report();
    assert.equal(registerM1Menu(host, rep), null);
    assert.deepEqual(rep.messages, ['menu registration threw']);
  });

  it('command handler routes through the same resolver', async () => {
    const pdf = makeAttachment({ key: 'A1', parentItemKey: 'P1', id: 11 });
    const parent = makeRegularItem({ key: 'P1', attachmentIDs: [11] });
    const { host, state } = makeHost({ items: [[11, pdf]] });
    registerM1Menu(host, report());
    const result = await state.registered[0].menus[0].menus[0].onCommand({}, { items: [parent] });
    assert.ok(result);
    assert.equal(result.attachmentKey, 'A1');
  });
});

describe('diagnostic privacy', () => {
  it('never logs a key, title, file name or path on the success path', async () => {
    const seen = [];
    const capture = (m) => seen.push(m);
    const pdf = makeAttachment({ key: 'SECRETKEY', parentItemKey: 'PARENTKEY', id: 11, fileName: 'secret.pdf', title: 'Secret Title', filePath: 'C:/secret/dir/secret.pdf' });
    const parent = makeRegularItem({ key: 'PARENTKEY', title: 'Secret Title', attachmentIDs: [11] });
    const { host } = makeHost({ items: [[11, pdf]] });
    await handleResolveCommand(host, { items: [parent] }, capture);
    for (const m of seen) {
      assert.ok(!m.includes('SECRETKEY'));
      assert.ok(!m.includes('PARENTKEY'));
      assert.ok(!m.includes('secret.pdf'));
      assert.ok(!m.includes('Secret Title'));
      assert.ok(!m.includes('C:/secret'));
    }
    assert.deepEqual(seen, ['resolved single candidate']);
  });

  it('never logs a key on the error path either', async () => {
    const seen = [];
    const capture = (m) => seen.push(m);
    const parent = makeRegularItem({ key: 'PRIVATEKEY', attachmentIDs: [] });
    const { host } = makeHost();
    await handleResolveCommand(host, { items: [parent] }, capture);
    for (const m of seen) { assert.ok(!m.includes('PRIVATEKEY')); }
    assert.deepEqual(seen, ['resolver error code=NO_PDF']);
  });
});

describe('describeFailure', () => {
  it('maps every stable error code to non-empty user text', () => {
    for (const code of ['EMPTY_SELECTION', 'MULTIPLE_SELECTION', 'MULTIPLE_PDF', 'UNSUPPORTED_SELECTION', 'NO_PDF', 'FILE_NOT_FOUND', 'FILE_NOT_READABLE']) {
      assert.ok(describeFailure(code).length > 0);
    }
    assert.ok(describeFailure('SOMETHING_ELSE').length > 0);
  });

  it('never mentions a path in user-facing error text', () => {
    for (const code of ['EMPTY_SELECTION', 'MULTIPLE_SELECTION', 'MULTIPLE_PDF', 'NO_PDF', 'FILE_NOT_FOUND', 'FILE_NOT_READABLE']) {
      assert.ok(!describeFailure(code).includes('/'));
      assert.ok(!describeFailure(code).includes('\\'));
    }
  });
});
