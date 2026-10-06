/**
 * Orange Translate M1 - Zotero host adapter for the PDF resolver.
 *
 * Owner: M1-RESOLVER-01 (DS). This is the only M1 layer allowed to touch Zotero
 * APIs; the decision logic lives in src/core/resolve-pdf.ts and is host-free.
 *
 * The Zotero surface is injected explicitly by bootstrap.js instead of being
 * read from globalThis, because bootstrap loads this bundle into a standalone
 * target scope (frozen M0 contract) where globalThis is not the plugin scope.
 *
 * Frozen 10.0.2 evidence (line numbers refer to the frozen copies under
 * docs/reviews/GLM-P0/evidence/upstream/10.0.2, docs/contracts/evidence and
 * docs/reviews/CHIEF-A1):
 * - Zotero.MenuManager.registerMenu/unregisterMenu       menuManager.js:816-835
 * - menu data shape + onShowing/onCommand                menuManager.js:113-181,700-703
 * - menuitem label via the 'label' attribute             zoteroPane.js:4654
 * - official registerMenu example                        zotero8-developers.md:80-120
 * - item-context menu context { items, ... }             zoteroPane.js:4689-4703
 * - getAttachments                                       item.js:4256
 * - isPDFAttachment = file attachment + application/pdf  item.js:2788-2790
 * - getFilePathAsync returns false when missing/invalid  item.js:3003-3122
 * - libraryID / key / parentItemKey / getDisplayTitle    item.js:131,152,1112
 * - attachmentFilename                                   item.js:3601
 * - Services.prompt.alert                                zotero_xpcom_init.js:1446
 * - Zotero.getMainWindow                                 zotero-10.0.2-zotero.js:77
 * - nsIFile attribute family (.isWritable/.isExecutable) zotero-10.0.2-zotero.js:878, utilities_internal.js:676
 */
import type {
  AttachmentProbe,
  PdfCandidate,
  ResolveResult,
  SelectionDescriptor,
} from '../core/resolve-pdf.ts';
import {
  decideTarget,
  finalizeSingle,
} from '../core/resolve-pdf.ts';

export interface MenusApi {
  registerMenu(options: unknown): string | false;
  unregisterMenu(menuID: string): boolean;
}

export interface PromptsApi {
  alert(win: unknown, title: string, text: string): void;
}

/** The Zotero plugin-scope surface this adapter needs, injected by bootstrap. */
export interface ZoteroSurface {
  MenuManager: MenusApi;
  prompt: PromptsApi;
  getMainWindow(): any;
  /** Zotero.Items.get(ids) - returns an array of item objects. */
  getItems(ids: number[]): any[];
  /** Zotero.File.pathToFile(path) - returns an nsIFile-like object. */
  pathToFile(path: string): any;
  onTranslatePdf?(candidate: PdfCandidate): Promise<void>;
  onCancelTranslation?(): Promise<void>;
  onOpenApiSettings?(): void;
}

export interface M1Host {
  pluginID: string;
  zotero: ZoteroSurface;
  debug(message: string): void;
  reportError(error: unknown): void;
}

export interface M1MenuHandle {
  unregister(): void;
}

export const MENU_ID = 'orange-translate-m1-resolve';
export const MENU_TARGET = 'main/library/item';
export const MENU_LABEL = '翻译 PDF';

/** Classify the current menu context without touching the filesystem. */
export function readSelection(context: any): SelectionDescriptor {
  const items: any[] = Array.isArray(context?.items) ? context.items : [];
  if (items.length !== 1) {
    return {
      selectedCount: items.length,
      supported: items.length > 1,
      parentItemKey: null,
      selectedAttachmentKey: null,
      title: '',
    };
  }
  const item = items[0];
  let isAttachment = false;
  try {
    isAttachment = item?.isAttachment?.() === true;
  }
  catch (e) {
    isAttachment = false;
  }
  if (isAttachment) {
    let isFile = false;
    try {
      isFile = item?.isFileAttachment?.() === true;
    }
    catch (e) {
      isFile = false;
    }
    return {
      selectedCount: 1,
      supported: isFile,
      parentItemKey: readParentItemKey(item),
      selectedAttachmentKey: item?.key ?? null,
      title: readTitle(item),
    };
  }
  let isRegular = false;
  try {
    isRegular = item?.isRegularItem?.() === true;
  }
  catch (e) {
    isRegular = false;
  }
  return {
    selectedCount: 1,
    supported: isRegular,
    parentItemKey: isRegular ? (item?.key ?? null) : null,
    selectedAttachmentKey: null,
    title: readTitle(item),
  };
}

/**
 * Resolve the current selection to exactly one path-probed PDF, or a stable
 * error code. Multiplicity (NO_PDF / MULTIPLE_PDF) is decided from the
 * Zotero-enumerated PDF attachment records BEFORE any getFilePathAsync or
 * readability call, so a parent with two or more PDFs never touches the
 * filesystem on any candidate.
 */
export async function resolveFromContext(
  host: M1Host,
  context: any,
): Promise<ResolveResult> {
  const selection = readSelection(context);
  const collected = collectAttachmentRecords(host, context, selection);
  const decision = decideTarget(selection, collected.records);
  if (decision.kind === 'error') {
    return decision;
  }
  // Exactly one PDF: only now is the path resolved and its readability checked,
  // and only for this one chosen attachment.
  const source = collected.sourceByKey.get(decision.probe.attachmentKey) ?? null;
  const probe = await probePath(host, decision.probe, source);
  return finalizeSingle(probe);
}

/**
 * Enumerate attachment records (identity + display + isPdf) for the selection
 * using Zotero APIs only. Path availability and readability are deliberately
 * NOT checked here, so the caller can decide multiplicity first. The returned
 * sourceByKey maps each record's attachmentKey back to its Zotero object so a
 * single chosen target can be path-probed later.
 */
function collectAttachmentRecords(
  host: M1Host,
  context: any,
  selection: SelectionDescriptor,
): { records: AttachmentProbe[]; sourceByKey: Map<string, any> } {
  const items: any[] = Array.isArray(context?.items) ? context.items : [];
  const sourceByKey = new Map<string, any>();
  if (selection.selectedAttachmentKey) {
    const item = items.length === 1 ? items[0] : null;
    if (!item) {
      return { records: [], sourceByKey };
    }
    const record = readAttachmentRecord(item);
    sourceByKey.set(record.attachmentKey, item);
    return { records: [record], sourceByKey };
  }
  if (!selection.parentItemKey || items.length !== 1) {
    return { records: [], sourceByKey };
  }
  const parent = items[0];
  let attachmentIDs: number[] = [];
  try {
    const ids = parent.getAttachments(false);
    attachmentIDs = Array.isArray(ids) ? ids : [];
  }
  catch (e) {
    return { records: [], sourceByKey };
  }
  let attachments: any[] = [];
  try {
    attachments = host.zotero.getItems(attachmentIDs) ?? [];
  }
  catch (e) {
    return { records: [], sourceByKey };
  }
  const records: AttachmentProbe[] = [];
  for (const attachment of attachments) {
    const record = readAttachmentRecord(attachment);
    records.push(record);
    sourceByKey.set(record.attachmentKey, attachment);
  }
  return { records, sourceByKey };
}

/** Identity + display + isPdf only; no path lookup and no readability check. */
function readAttachmentRecord(attachment: any): AttachmentProbe {
  let isPdf = false;
  try {
    isPdf = attachment?.isPDFAttachment?.() === true;
  }
  catch (e) {
    isPdf = false;
  }
  return {
    libraryID: Number(attachment?.libraryID ?? 0),
    parentItemKey: readParentItemKey(attachment),
    attachmentKey: String(attachment?.key ?? ''),
    attachmentID: Number(attachment?.id ?? 0),
    title: readTitle(attachment),
    fileName: String(attachment?.attachmentFilename ?? ''),
    isPdf,
    absolutePath: null,
  };
}

/**
 * Probe one already-chosen attachment's path and readability. This is the only
 * place getFilePathAsync or nsIFile is touched, and it runs for exactly one
 * candidate after the multiplicity decision has been made.
 */
async function probePath(
  host: M1Host,
  record: AttachmentProbe,
  attachment: any,
): Promise<AttachmentProbe> {
  const base: AttachmentProbe = { ...record };
  if (!base.isPdf || !attachment) {
    return base;
  }
  const resolved = await resolvePath(attachment);
  if (!resolved) {
    base.pathState = 'missing';
    return base;
  }
  const readable = checkReadable(host, resolved);
  if (readable === 'ok') {
    base.absolutePath = resolved;
    base.pathState = 'ok';
  }
  else {
    // The path resolved but the host refused to read it: keep the path out of
    // the result while reporting the specific contract code.
    base.absolutePath = null;
    base.pathState = readable;
  }
  return base;
}

async function resolvePath(attachment: any): Promise<string | null> {
  try {
    const path = await attachment?.getFilePathAsync?.();
    return path ? String(path) : null;
  }
  catch (e) {
    return null;
  }
}

/**
 * Readability probe built on the nsIFile attribute family the frozen 10.0.2
 * source already uses (.isWritable()/.isExecutable()). Any throw means the file
 * cannot be read, which the contract maps to FILE_NOT_READABLE.
 */
function checkReadable(host: M1Host, absolutePath: string): 'ok' | 'missing' | 'unreadable' {
  try {
    const file = host.zotero.pathToFile(absolutePath);
    if (!file) {
      return 'missing';
    }
    if (typeof file.exists === 'function' && !file.exists()) {
      return 'missing';
    }
    if (typeof file.isFile === 'function' && !file.isFile()) {
      return 'unreadable';
    }
    if (typeof file.isReadable === 'function') {
      return file.isReadable() === true ? 'ok' : 'unreadable';
    }
    return 'ok';
  }
  catch (e) {
    // A throwing stat means the file cannot be used; treat it as unreadable
    // rather than claiming it is absent.
    return 'unreadable';
  }
}

function readParentItemKey(item: any): string | null {
  const key = item?.parentItemKey;
  return typeof key === 'string' ? key : null;
}

function readTitle(item: any): string {
  try {
    const title = item?.getDisplayTitle?.();
    return title ? String(title) : '';
  }
  catch (e) {
    return '';
  }
}

/** Map a stable error code to short user-facing text (UI layer may override). */
export function describeFailure(code: string): string {
  switch (code) {
    case 'EMPTY_SELECTION':
      return '请先在 Zotero 中选择一个条目或 PDF。';
    case 'MULTIPLE_SELECTION':
      return 'Orange Translate 1.0 一次只处理一个 PDF。请只选择一个 PDF 附件或一个仅含单个 PDF 的父文献。';
    case 'MULTIPLE_PDF':
      return '检测到多个 PDF。请在 Zotero 中直接选中要翻译的 PDF 附件，然后重新执行 Orange Translate。';
    case 'UNSUPPORTED_SELECTION':
      return '当前选择不受支持。请选择一个条目或 PDF 附件。';
    case 'NO_PDF':
      return '该条目没有可用的本地 PDF。请先添加 PDF，或选择其他条目。';
    case 'FILE_NOT_FOUND':
      return '找不到这份 PDF。请重新选择文件，或检查文件是否已被移动。';
    case 'FILE_NOT_READABLE':
      return '没有读取这份 PDF 的权限。请检查文件权限后重试。';
    default:
      return '无法解析所选 PDF。';
  }
}

/**
 * Report a failure the same way for every error path: show the mapped text to
 * the user, then log only the fixed code. Never logs keys, titles, file names,
 * paths or content, and a failing alert never hides the diagnostic.
 */
function reportFailure(
  host: M1Host,
  report: (message: string) => void,
  code: string,
): null {
  try {
    host.zotero.prompt.alert(
      host.zotero.getMainWindow(),
      'Orange Translate',
      describeFailure(code),
    );
  }
  catch (e) {
    // A failing alert must not hide the diagnostic below.
  }
  report('resolver error code=' + code);
return null;
}

/**
 * Full command path: resolve the user's selection to exactly one PDF, or
 * report a stable failure. Returns the resolved PDF or null. Orange
 * Translate 1.0 never opens a chooser: a parent with several PDFs is reported
 * as MULTIPLE_PDF and the user is asked to select the PDF attachment itself.
 * Diagnostics carry only fixed fields and event names - never a key, title,
 * file name, absolute path or file content.
 */
export async function handleResolveCommand(
  host: M1Host,
  context: any,
  report: (message: string) => void,
): Promise<PdfCandidate | null> {
  const result = await resolveFromContext(host, context);
  if (result.kind === 'error') {
    return reportFailure(host, report, result.code);
  }
  // Diagnostics carry fixed fields only: no key, title, file name or path.
  report('resolved single candidate');
  return {
    libraryID: result.libraryID,
    parentItemKey: result.parentItemKey,
    attachmentKey: result.attachmentKey,
    attachmentID: result.attachmentID,
    title: result.title,
    fileName: result.fileName,
    absolutePath: result.absolutePath,
    pathState: result.pathState,
  };
}

/** Register the item-context-menu action; returns a symmetric release handle. */
export function registerM1Menu(
  host: M1Host,
  report: (message: string) => void,
): M1MenuHandle | null {
  let registeredID: string | false = false;
  try {
    registeredID = host.zotero.MenuManager.registerMenu({
      menuID: MENU_ID,
      pluginID: host.pluginID,
      target: MENU_TARGET,
      menus: [{
        menuType: 'submenu',
        onShowing: (_event: unknown, context: any) => {
          context?.menuElem?.setAttribute('label', 'Orange Translate');
        },
        menus: [
        {
          menuType: 'menuitem',
          // No FTL bundle is shipped, so the label is set on the XUL menuitem with the 'label'
          // attribute, the same way the frozen host does at zoteroPane.js:4654.
          onShowing: (_event: unknown, menuContext: any) => {
            try {
              menuContext?.menuElem?.setAttribute('label', MENU_LABEL);
            }
            catch (e) {
              report('menu label failed');
            }
          },
          onCommand: async (_event: unknown, menuContext: any) => {
            // Return the promise so callers (and tests) can await the
            // resolution; the host ignores the return value.
            const candidate = await handleResolveCommand(host, menuContext, report);
            if (candidate && host.zotero.onTranslatePdf) {
              await host.zotero.onTranslatePdf(candidate);
            }
            return candidate;
          },
        },
        ...(host.zotero.onCancelTranslation ? [{
          menuType: 'menuitem',
          onShowing: (_event: unknown, context: any) => {
            context?.menuElem?.setAttribute('label', '取消翻译');
          },
          onCommand: () => host.zotero.onCancelTranslation!(),
        }] : []),
        ...(host.zotero.onOpenApiSettings ? [{
          menuType: 'menuitem',
          onShowing: (_event: unknown, context: any) => { context?.menuElem?.setAttribute('label', 'API 与模型设置'); },
          onCommand: () => host.zotero.onOpenApiSettings!(),
        }] : []),
        ],
      }],
    });
  }
  catch (e) {
    report('menu registration threw');
    return null;
  }
  if (!registeredID) {
    report('menu registration failed');
    return null;
  }
  const menuID = String(registeredID);
  report('menu registered');
  return {
    unregister(): void {
      try {
        host.zotero.MenuManager.unregisterMenu(menuID);
      }
      catch (e) {
        report('menu unregister failed');
      }
    },
  };
}
