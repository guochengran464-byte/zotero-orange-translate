/**
 * M1 core resolver tests (owner: M1-RESOLVER-01 / DS).
 *
 * Pure logic only: no Zotero globals, no filesystem, no network. Every
 * contract case from docs/contracts/M1.md is asserted here, plus the ADR-035
 * rule that several PDFs must never auto-pick the first candidate.
 *
 * Uses Node 24 built-in TypeScript type stripping, like tests/lifecycle.test.mjs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveSelection, identityMatches } from '../src/core/resolve-pdf.ts';

function probe(overrides = {}) {
  return {
    libraryID: 1,
    parentItemKey: 'PARENT1',
    attachmentKey: 'ATT1',
    attachmentID: 101,
    title: 'A Study',
    fileName: 'study.pdf',
    isPdf: true,
    absolutePath: 'C:/lib/storage/ATT1/study.pdf',
    ...overrides,
  };
}

function selection(overrides = {}) {
  return {
    selectedCount: 1,
    supported: true,
    parentItemKey: 'PARENT1',
    selectedAttachmentKey: null,
    title: 'A Study',
    ...overrides,
  };
}

describe('resolveSelection - contract cases', () => {
  it('regular item with a single PDF resolves it', () => {
    const result = resolveSelection(selection(), [probe()]);
    assert.equal(result.kind, 'resolved');
    assert.equal(result.attachmentKey, 'ATT1');
    assert.equal(result.parentItemKey, 'PARENT1');
    assert.equal(result.libraryID, 1);
    assert.equal(result.attachmentID, 101);
  });

  it('regular item with several PDFs returns MULTIPLE_PDF (no chooser, no candidate list)', () => {
    const result = resolveSelection(selection(), [
      probe({ attachmentKey: 'A', attachmentID: 1, fileName: 'a.pdf' }),
      probe({ attachmentKey: 'B', attachmentID: 2, fileName: 'b.pdf' }),
    ]);
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'MULTIPLE_PDF');
    // No candidate payload leaves the resolver: nothing can be pre-selected.
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'candidates'), false);
  });

  it('several PDFs never auto-resolve to the first candidate', () => {
    const result = resolveSelection(selection(), [
      probe({ attachmentKey: 'A' }),
      probe({ attachmentKey: 'B' }),
    ]);
    assert.notEqual(result.kind, 'resolved');
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'MULTIPLE_PDF');
  });

  it('non-PDF attachments are ignored when enumerating', () => {
    const result = resolveSelection(selection(), [
      probe({ attachmentKey: 'HTML', fileName: 'page.html', isPdf: false }),
      probe({ attachmentKey: 'PDF1' }),
    ]);
    assert.equal(result.kind, 'resolved');
    assert.equal(result.attachmentKey, 'PDF1');
  });

  it('regular item with no PDF returns NO_PDF', () => {
    const result = resolveSelection(selection(), [
      probe({ attachmentKey: 'HTML', isPdf: false }),
    ]);
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'NO_PDF');
  });

  it('directly selected PDF attachment resolves itself', () => {
    const result = resolveSelection(
      selection({ parentItemKey: null, selectedAttachmentKey: 'STANDALONE' }),
      [probe({ parentItemKey: null, attachmentKey: 'STANDALONE' })],
    );
    assert.equal(result.kind, 'resolved');
    assert.equal(result.attachmentKey, 'STANDALONE');
    assert.equal(result.parentItemKey, null);
  });

  it('standalone PDF keeps a null parentItemKey', () => {
    const result = resolveSelection(
      selection({ parentItemKey: null, selectedAttachmentKey: 'S1' }),
      [probe({ parentItemKey: null, attachmentKey: 'S1' })],
    );
    assert.equal(result.kind, 'resolved');
    assert.equal(result.parentItemKey, null);
  });

  it('several selected top-level items are refused', () => {
    const result = resolveSelection(selection({ selectedCount: 2 }), [probe()]);
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'MULTIPLE_SELECTION');
  });

  it('unsupported object type returns UNSUPPORTED_SELECTION', () => {
    const result = resolveSelection(
      selection({ supported: false, parentItemKey: null }),
      [],
    );
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'UNSUPPORTED_SELECTION');
  });

  it('empty selection returns EMPTY_SELECTION', () => {
    const result = resolveSelection(selection({ selectedCount: 0, parentItemKey: null }), []);
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'EMPTY_SELECTION');
  });

  it('missing file returns FILE_NOT_FOUND', () => {
    const result = resolveSelection(selection(), [probe({ absolutePath: null })]);
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'FILE_NOT_FOUND');
  });

  it('exactly one enumerated PDF maps its path state to FILE_NOT_FOUND or FILE_NOT_READABLE', () => {
    const missing = resolveSelection(selection(), [probe({ absolutePath: null, pathState: 'missing' })]);
    assert.equal(missing.kind, 'error');
    assert.equal(missing.code, 'FILE_NOT_FOUND');

    const unreadable = resolveSelection(selection(), [probe({ absolutePath: null, pathState: 'unreadable' })]);
    assert.equal(unreadable.kind, 'error');
    assert.equal(unreadable.code, 'FILE_NOT_READABLE');
  });

  it('a directly selected non-PDF attachment is UNSUPPORTED_SELECTION', () => {
    const result = resolveSelection(
      selection({ parentItemKey: 'PARENT1', selectedAttachmentKey: 'HTML' }),
      [probe({ attachmentKey: 'HTML', isPdf: false })],
    );
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'UNSUPPORTED_SELECTION');
  });

  it('a directly selected attachment missing from the probe set is UNSUPPORTED_SELECTION', () => {
    const result = resolveSelection(
      selection({ selectedAttachmentKey: 'GONE' }),
      [probe({ attachmentKey: 'OTHER' })],
    );
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'UNSUPPORTED_SELECTION');
  });

  it('only PDFs belonging to the selected parent are considered', () => {
    const result = resolveSelection(selection(), [
      probe({ attachmentKey: 'MINE', parentItemKey: 'PARENT1' }),
      probe({ attachmentKey: 'OTHER', parentItemKey: 'PARENT2' }),
    ]);
    assert.equal(result.kind, 'resolved');
    assert.equal(result.attachmentKey, 'MINE');
  });
});

describe('path fidelity', () => {
  it('keeps Chinese characters, spaces and Unicode intact', () => {
    const path = 'C:/资料库/我的 论文/研究 报告（2024）.pdf';
    const result = resolveSelection(selection(), [probe({
      absolutePath: path,
      fileName: '研究 报告（2024）.pdf',
      title: '一项 研究',
    })]);
    assert.equal(result.kind, 'resolved');
    assert.equal(result.absolutePath, path);
    assert.equal(result.fileName, '研究 报告（2024）.pdf');
    assert.equal(result.title, '一项 研究');
  });

});

describe('identity re-check (ADR-035)', () => {
  it('matches on libraryID + parentItemKey + attachmentKey', () => {
    const expected = { libraryID: 1, parentItemKey: 'P', attachmentKey: 'A' };
    assert.equal(identityMatches(expected, { libraryID: 1, parentItemKey: 'P', attachmentKey: 'A' }), true);
    assert.equal(identityMatches(expected, { libraryID: 2, parentItemKey: 'P', attachmentKey: 'A' }), false);
    assert.equal(identityMatches(expected, { libraryID: 1, parentItemKey: 'Q', attachmentKey: 'A' }), false);
    assert.equal(identityMatches(expected, { libraryID: 1, parentItemKey: 'P', attachmentKey: 'B' }), false);
  });

  it('null parentItemKey matches only null (standalone identity)', () => {
    const expected = { libraryID: 1, parentItemKey: null, attachmentKey: 'A' };
    assert.equal(identityMatches(expected, { libraryID: 1, parentItemKey: null, attachmentKey: 'A' }), true);
    assert.equal(identityMatches(expected, { libraryID: 1, parentItemKey: 'P', attachmentKey: 'A' }), false);
  });
});

describe('PDF multiplicity is counted before any path check (M1R)', () => {
  it('two enumerated PDFs, one missing, still returns MULTIPLE_PDF (never drops it)', () => {
    const result = resolveSelection(selection(), [
      probe({ attachmentKey: 'OK', fileName: 'ok.pdf' }),
      probe({ attachmentKey: 'GONE', fileName: 'gone.pdf', absolutePath: null, pathState: 'missing' }),
    ]);
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'MULTIPLE_PDF');
  });

  it('two enumerated PDFs, one unreadable, still returns MULTIPLE_PDF', () => {
    const result = resolveSelection(selection(), [
      probe({ attachmentKey: 'OK', fileName: 'ok.pdf' }),
      probe({ attachmentKey: 'LOCKED', fileName: 'locked.pdf', absolutePath: null, pathState: 'unreadable' }),
    ]);
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'MULTIPLE_PDF');
  });

  it('a missing PDF is never dropped so that a readable one auto-resolves', () => {
    const result = resolveSelection(selection(), [
      probe({ attachmentKey: 'GONE', fileName: 'gone.pdf', absolutePath: null, pathState: 'missing' }),
      probe({ attachmentKey: 'OK', fileName: 'ok.pdf' }),
    ]);
    // The readable candidate must NOT win silently: multiplicity wins first.
    assert.notEqual(result.kind, 'resolved');
    assert.equal(result.code, 'MULTIPLE_PDF');
  });

  it('three enumerated PDFs (all present) return MULTIPLE_PDF', () => {
    const result = resolveSelection(selection(), [
      probe({ attachmentKey: 'A', fileName: 'a.pdf' }),
      probe({ attachmentKey: 'B', fileName: 'b.pdf' }),
      probe({ attachmentKey: 'C', fileName: 'c.pdf' }),
    ]);
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'MULTIPLE_PDF');
  });
});
