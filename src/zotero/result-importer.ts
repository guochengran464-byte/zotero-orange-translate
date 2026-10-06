import type { PdfCandidate } from '../core/resolve-pdf.ts';

export function assertImportTarget(zotero: any, candidate: PdfCandidate): any {
  const source = zotero.Items.get(candidate.attachmentID);
  const library = zotero.Libraries.get(candidate.libraryID);
  if (!source || source.deleted || source.key !== candidate.attachmentKey
    || source.libraryID !== candidate.libraryID
    || (source.parentItemKey || null) !== candidate.parentItemKey) {
    throw new Error('SOURCE_CHANGED');
  }
  if (!library?.editable || !library.filesEditable) { throw new Error('LIBRARY_READ_ONLY'); }
  if (candidate.parentItemKey) {
    const parent = zotero.Items.getByLibraryAndKey(candidate.libraryID, candidate.parentItemKey);
    if (!parent || parent.deleted || !parent.isRegularItem()) { throw new Error('SOURCE_CHANGED'); }
    return parent;
  }
  return null;
}

export function assertOutputFolder(host: any, candidate: PdfCandidate): any {
  const source = host.Zotero.File.pathToFile(candidate.absolutePath);
  const folder = source.parent;
  if (!folder?.exists() || !folder.isDirectory() || !folder.isWritable()) { throw new Error('OUTPUT_FOLDER_READ_ONLY'); }
  return source;
}

export async function saveTranslatedPdfs(host: any, candidate: PdfCandidate, outputs: { dualPdf?: string; monoPdf?: string }): Promise<{ dualPdf: string; monoPdf: string }> {
  if (!outputs.dualPdf || !outputs.monoPdf) { throw new Error('MISSING_REQUIRED_OUTPUT'); }
  const source = assertOutputFolder(host, candidate);
  const stem = source.leafName.replace(/\.pdf$/i, '');
  for (let index = 1; index <= 9999; index++) {
    const suffix = '.zh' + (index === 1 ? '' : '-' + index);
    const dualPdf = host.PathUtils.join(source.parent.path, stem + suffix + '.dual.pdf');
    const monoPdf = host.PathUtils.join(source.parent.path, stem + suffix + '.mono.pdf');
    if ([dualPdf, monoPdf].some(path => host.Zotero.File.pathToFile(path).exists())) { continue; }
    let copied = false;
    try {
      await host.IOUtils.copy(outputs.dualPdf, dualPdf, { noOverwrite: true }); copied = true;
      await host.IOUtils.copy(outputs.monoPdf, monoPdf, { noOverwrite: true });
      return { dualPdf, monoPdf };
    } catch {
      if (copied) { try { await host.IOUtils.remove(dualPdf); } catch {} }
      throw new Error('OUTPUT_SAVE_FAILED');
    }
  }
  throw new Error('OUTPUT_SAVE_FAILED');
}

export async function importTranslatedPdf(zotero: any, candidate: PdfCandidate, pdf: string, kind: 'dual' | 'mono' = 'dual', link = false): Promise<any> {
  const parent = assertImportTarget(zotero, candidate);
  const personal = zotero.Libraries.get(candidate.libraryID)?.libraryType === 'user'
    || zotero.Libraries.userLibraryID === candidate.libraryID;
  const options = {
    file: pdf,
    libraryID: candidate.libraryID,
    parentItemID: parent?.id,
    collections: parent ? undefined : zotero.Items.get(candidate.attachmentID).getCollections(),
    title: (kind === 'dual' ? '中英双语 · ' : '纯中文 · ') + candidate.fileName,
    contentType: 'application/pdf',
  };
  // Zotero group libraries cannot contain linked files. Keep the adjacent PDFs
  // and use Zotero's managed import for those libraries.
  return link && personal ? zotero.Attachments.linkFromFile(options) : zotero.Attachments.importFromFile(options);
}
