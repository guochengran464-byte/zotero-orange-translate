// M2B TranslationService tests (owner: M2B-FAKE-01 / DS).
//
// Drives the real core TranslationService through the test-only FakeRuntimeAdapter
// with synthetic fixtures under the D-drive worktree .local temp directory. No
// real runtime, network, provider, API key or Zotero access is involved.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TranslationService, TranslationServiceError } from '../src/core/translation-service.ts';
import { FakeRuntimeAdapter, makeSyntheticPdf } from './fixtures/fake-runtime.mjs';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var TMP_ROOT = path.join(ROOT, '.local', 'tmp');

var tmpDirs = [];
function makeTmp(label) {
  const dir = mkdtempSync(path.join(TMP_ROOT, label + '-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeJob(label) {
  const root = makeTmp(label);
  const inputPdf = path.join(root, 'in.pdf');
  writeFileSync(inputPdf, makeSyntheticPdf());
  return { root, inputPdf, outputDir: path.join(root, 'out') };
}

function makeRequest(job, overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: '11111111-2222-3333-4444-555555555555',
    inputPdf: job.inputPdf,
    outputDir: job.outputDir,
    language: { source: 'en', target: 'zh' },
    provider: { id: 'deepseek', model: 'deepseek-v4.1-flash', baseUrl: 'https://api.example.com/v1' },
    outputMode: 'dual',
    ...overrides,
  };
}

describe('success path', () => {
  /**
   * Structural check that a produced file is a minimal parseable PDF: a header,
   * catalog/pages/page objects, a startxref whose offset points at the xref
   * keyword, a trailer, and %%EOF.
   */
  function assertSyntheticPdfShape(filePath) {
    const produced = readFileSync(filePath);
    assert.ok(produced.length > 0, 'output must be non-empty');
    const text = produced.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.'), 'must start with a PDF header');
    assert.ok(text.includes('/Type /Catalog'), 'must contain a catalog object');
    assert.ok(text.includes('/Type /Pages'), 'must contain a pages object');
    assert.ok(text.includes('/Type /Page '), 'must contain a page object');
    const matches = [...text.matchAll(/startxref\s+(\d+)\s+%%EOF\s*$/g)];
    assert.equal(matches.length, 1, 'must end with exactly one startxref/%%EOF after the xref');
    const offset = Number(matches[0][1]);
    assert.ok(Number.isInteger(offset) && offset >= 0, 'startxref offset must be an integer');
    assert.equal(text.slice(offset, offset + 4), 'xref', 'startxref must point at the xref keyword');
    assert.ok(/xref\n0 4\n0000000000 65535 f /.test(text), 'must have a well-formed xref table');
    assert.ok(text.includes('trailer'), 'must contain a trailer');
    assert.equal(text.indexOf('startxref'), text.lastIndexOf('startxref'), 'exactly one startxref');
    // The runtime writes the fixture verbatim; the produced bytes must match it.
    assert.equal(produced.equals(makeSyntheticPdf()), true, 'output must be the synthetic fixture bytes');
  }
  it('resolves dual output for outputMode dual', async () => {
    const job = makeJob('dual');
    const adapter = new FakeRuntimeAdapter({ outputKinds: ['dualPdf'] });
    const service = new TranslationService(adapter);
    const request = makeRequest(job, { outputMode: 'dual' });
    const result = await service.translate(request);
    assert.equal(result.status, 'completed');
    assert.equal(result.jobId, request.jobId);
    assert.ok(result.outputs.dualPdf.startsWith(job.outputDir));
    assert.equal(result.outputs.monoPdf, undefined);
    assert.equal(existsSync(result.outputs.dualPdf), true);
    assertSyntheticPdfShape(result.outputs.dualPdf);
    assert.equal(service.activeJobId, null);
  });

  it('resolves mono output for outputMode mono', async () => {
    const job = makeJob('mono');
    const adapter = new FakeRuntimeAdapter({ outputKinds: ['monoPdf'] });
    const service = new TranslationService(adapter);
    const result = await service.translate(makeRequest(job, { outputMode: 'mono' }));
    assert.equal(result.status, 'completed');
    assert.ok(result.outputs.monoPdf.startsWith(job.outputDir));
    assert.equal(result.outputs.dualPdf, undefined);
    assert.equal(existsSync(result.outputs.monoPdf), true);
  });

  it('resolves both outputs for outputMode both', async () => {
    const job = makeJob('both');
    const adapter = new FakeRuntimeAdapter({ outputKinds: ['dualPdf', 'monoPdf'] });
    const service = new TranslationService(adapter);
    const result = await service.translate(makeRequest(job, { outputMode: 'both', jobId: '22222222-3333-4444-5555-666666666666' }));
    assert.equal(result.status, 'completed');
    assert.equal(typeof result.outputs.dualPdf, 'string');
    assert.equal(typeof result.outputs.monoPdf, 'string');
    assert.equal(existsSync(result.outputs.dualPdf), true);
    assert.equal(existsSync(result.outputs.monoPdf), true);
    assertSyntheticPdfShape(result.outputs.dualPdf);
    assertSyntheticPdfShape(result.outputs.monoPdf);
  });
});

describe('failure and cancellation', () => {
  it('propagates a failed result with a stable code and no outputs', async () => {
    const job = makeJob('fail');
    const adapter = new FakeRuntimeAdapter({ behavior: 'fail' });
    const service = new TranslationService(adapter);
    const result = await service.translate(makeRequest(job));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'FAKE_TRANSLATION_FAILED');
    assert.equal(result.outputs, undefined);
    assert.equal(service.activeJobId, null);
  });

  it('settles a cancelled job as cancelled with no consumable paths', async () => {
    const job = makeJob('cancel');
    const adapter = new FakeRuntimeAdapter({ behavior: 'hang' });
    const service = new TranslationService(adapter);
    const request = makeRequest(job, { jobId: '33333333-4444-5555-6666-777777777777' });
    const pending = service.translate(request);
    await adapter.waitForLaunch();
    assert.equal(service.activeJobId, request.jobId);
    await service.cancel(request.jobId);
    assert.deepEqual(adapter.cancelCalls, [request.jobId]);
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.outputs, undefined);
    assert.equal(service.activeJobId, null);
  });

  it('rejects cancel for a non-active or mismatched jobId', async () => {
    const service = new TranslationService(new FakeRuntimeAdapter());
    await assert.rejects(() => service.cancel('44444444-5555-6666-7777-888888888888'), (error) => {
      assert.ok(error instanceof TranslationServiceError);
      assert.equal(error.code, 'NO_SUCH_JOB');
      return true;
    });
  });
});

describe('result integrity enforcement', () => {
  it('downgrades a completed result that mismatches the request jobId', async () => {
    const job = makeJob('mismatch');
    const adapter = new FakeRuntimeAdapter({
      behavior: 'success',
      outputKinds: ['dualPdf'],
      resultOverrides: { jobId: '99999999-0000-1111-2222-333333333333' },
    });
    const service = new TranslationService(adapter);
    const result = await service.translate(makeRequest(job));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'RESULT_JOB_MISMATCH');
  });

  it('downgrades a completed result missing a required output', async () => {
    const job = makeJob('missing');
    const adapter = new FakeRuntimeAdapter({
      behavior: 'success',
      outputKinds: ['monoPdf'],
      resultOverrides: { outputs: { dualPdf: path.join(job.outputDir, 'out.zh.dual.pdf') } },
    });
    const service = new TranslationService(adapter);
    const result = await service.translate(makeRequest(job, { outputMode: 'both' }));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'MISSING_REQUIRED_OUTPUT');
  });

  it('downgrades a completed result whose output path escapes the job dir', async () => {
    const job = makeJob('escape');
    const adapter = new FakeRuntimeAdapter({
      behavior: 'success',
      outputKinds: ['dualPdf'],
      resultOverrides: { outputs: { dualPdf: 'C:/work/escaped-out.pdf' } },
    });
    const service = new TranslationService(adapter);
    const result = await service.translate(makeRequest(job));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'OUTPUT_PATH_ESCAPED');
  });

  it('rejects a completed result whose output equals the drive-root output dir', async () => {
    const job = makeJob('rootescape');
    const adapter = new FakeRuntimeAdapter({
      behavior: 'success',
      // Write nothing to disk (the drive root is not writable in tests); the
      // completed result is injected directly to exercise the containment rule.
      outputKinds: [],
      resultOverrides: { outputs: { dualPdf: 'C:/' } },
    });
    const service = new TranslationService(adapter);
    const result = await service.translate(makeRequest(job, { outputDir: 'C:/' }));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'OUTPUT_PATH_ESCAPED');
  });
  it('converts an adapter throw into a terminal failure without leaking it', async () => {
    const job = makeJob('throw');
    const adapter = new FakeRuntimeAdapter();
    adapter.translate = async () => { throw new Error('boom C:/secret/path'); };
    const service = new TranslationService(adapter);
    const result = await service.translate(makeRequest(job));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'RUNTIME_ADAPTER_ERROR');
    assert.ok(!JSON.stringify(result).includes('secret'));
  });
});

describe('request validation and single-active-job', () => {
  it('rejects an invalid request before starting any job', async () => {
    const job = makeJob('invalidreq');
    const adapter = new FakeRuntimeAdapter();
    const service = new TranslationService(adapter);
    await assert.rejects(() => service.translate(makeRequest(job, { jobId: 'nope' })), (error) => {
      assert.equal(error.code, 'INVALID_JOB_ID');
      return true;
    });
    assert.equal(adapter.translateCalls, 0);
    assert.equal(service.activeJobId, null);
  });

  it('rejects a credential-bearing provider baseUrl before starting', async () => {
    const job = makeJob('cred');
    const adapter = new FakeRuntimeAdapter();
    const service = new TranslationService(adapter);
    const request = makeRequest(job, { provider: { id: 'x', baseUrl: 'https://api.example.com/v1?api_key=SUPERSECRET' } });
    await assert.rejects(() => service.translate(request), (error) => {
      assert.equal(error.code, 'CREDENTIAL_IN_BASE_URL');
      assert.ok(!String(error.message).includes('SUPERSECRET'));
      return true;
    });
    assert.equal(adapter.translateCalls, 0);
  });

  it('rejects a second concurrent job while one is active', async () => {
    const job = makeJob('concurrent');
    const adapter = new FakeRuntimeAdapter({ behavior: 'hang' });
    const service = new TranslationService(adapter);
    const first = service.translate(makeRequest(job, { jobId: '55555555-6666-7777-8888-999999999999' }));
    await adapter.waitForLaunch();
    const second = makeRequest(job, { jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    await assert.rejects(() => service.translate(second), (error) => {
      assert.equal(error.code, 'JOB_ALREADY_ACTIVE');
      return true;
    });
    assert.equal(adapter.translateCalls, 1);
    await service.cancel('55555555-6666-7777-8888-999999999999');
    const result = await first;
    assert.equal(result.status, 'cancelled');
  });
});

describe('availability passthrough', () => {
  it('reports the adapter availability without launching anything', async () => {
    const adapter = new FakeRuntimeAdapter({ availability: 'missing' });
    const service = new TranslationService(adapter);
    const status = await service.checkAvailability();
    assert.equal(status.availability, 'missing');
    assert.equal(adapter.translateCalls, 0);
  });
});
