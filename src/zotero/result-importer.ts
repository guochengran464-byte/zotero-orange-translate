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

export async function importTranslatedPdf(zotero: any, candidate: PdfCandidate, dualPdf: string): Promise<any> {
  const parent = assertImportTarget(zotero, candidate);
  return zotero.Attachments.importFromFile({
    file: dualPdf,
    libraryID: candidate.libraryID,
    parentItemID: parent?.id,
    collections: parent ? undefined : zotero.Items.get(candidate.attachmentID).getCollections(),
    title: '中英双语 · ' + candidate.fileName,
    contentType: 'application/pdf',
  });
}
