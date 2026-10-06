// M2B runtime-contract and core-boundary tests (owner: M2B-FAKE-01 / DS).
//
// Two jobs:
//   1. guard the M2 boundary - the core service must stay pure (no Node,
//      filesystem, child_process, Zotero or network imports), and the frozen
//      M2A contract types must keep their accepted shape;
//   2. unit-test the pure request/result checks the service enforces, including
//      the two review follow-throughs: output-mode correspondence and rejection
//      of credential-bearing provider endpoints.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkCompletedResult,
  httpUrlHasAuthority,
  isAbsoluteLocalPath,
  isCredentialBearingUrl,
  isPathContained,
  normalizeLocalPathForCompare,
  requiredOutputKinds,
  validateTranslationRequest,
} from '../src/core/translation-service.ts';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function validRequest(overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: '11111111-2222-3333-4444-555555555555',
    inputPdf: 'C:/work/job/in.pdf',
    outputDir: 'C:/work/job/out',
    language: { source: 'en', target: 'zh' },
    provider: { id: 'deepseek', model: 'deepseek-v4.1-flash', baseUrl: 'https://api.example.com/v1' },
    outputMode: 'dual',
    ...overrides,
  };
}

describe('core boundary purity (M2)', () => {
  const coreSources = ['translation-service.ts', 'runtime-contract.ts'].map((name) => ({
    name,
    text: stripComments(readFileSync(path.join(ROOT, 'src', 'core', name), 'utf8')),
  }));

  it('imports only relative core modules (no Node/fs/child_process/Zotero)', () => {
    for (const { name, text } of coreSources) {
      const specifiers = [...text.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
      for (const spec of specifiers) {
        assert.ok(spec.startsWith('./') || spec.startsWith('../'), name + ' must not import ' + spec);
        assert.ok(!spec.startsWith('node:'), name + ' must not import a Node builtin: ' + spec);
      }
    }
  });

  it('does not reference host/network/process globals', () => {
    const forbidden = ['child_process', 'require(', 'process.env', '__dirname', 'Zotero.', 'Components.', 'window.', 'XMLHttpRequest', 'fetch('];
    for (const { name, text } of coreSources) {
      for (const token of forbidden) {
        assert.equal(text.includes(token), false, name + ' must not reference ' + token);
      }
    }
  });
});

describe('frozen M2A contract shape', () => {
  const contract = readFileSync(path.join(ROOT, 'src', 'core', 'runtime-contract.ts'), 'utf8');

  it('still declares the accepted boundary types and members', () => {
    for (const decl of [
      'TranslationOutputMode',
      'TranslationProviderConfig',
      'TranslationRequest',
      'RuntimeStatus',
      'TranslationResult',
      'RuntimeAdapter',
      'checkAvailability',
      "'dual'",
      "'mono'",
      "'both'",
      "'available' | 'missing' | 'incompatible' | 'busy' | 'error'",
      "status: 'completed'",
      "status: 'failed'",
      "status: 'cancelled'",
    ]) {
      assert.ok(contract.includes(decl), 'runtime-contract.ts is missing ' + decl);
    }
  });

  it('keeps schemaVersion pinned to the literal 1', () => {
    assert.ok(contract.includes('schemaVersion: 1'));
  });
});

describe('validateTranslationRequest', () => {
  it('accepts a well-formed schema-v1 request', () => {
    assert.deepEqual(validateTranslationRequest(validRequest()), { ok: true });
  });

  it('rejects a non-object or wrong schema version', () => {
    assert.equal(validateTranslationRequest(null).issue.code, 'INVALID_REQUEST_SHAPE');
    assert.equal(validateTranslationRequest(validRequest({ schemaVersion: 2 })).issue.code, 'UNSUPPORTED_SCHEMA_VERSION');
  });

  it('requires a UUID jobId', () => {
    assert.equal(validateTranslationRequest(validRequest({ jobId: 'not-a-uuid' })).issue.code, 'INVALID_JOB_ID');
  });

  it('requires absolute input and output paths', () => {
    assert.equal(validateTranslationRequest(validRequest({ inputPdf: 'relative/in.pdf' })).issue.code, 'INVALID_INPUT_PATH');
    assert.equal(validateTranslationRequest(validRequest({ outputDir: 'relative/out' })).issue.code, 'INVALID_OUTPUT_DIR');
    assert.equal(validateTranslationRequest(validRequest({ inputPdf: 'C:/a/../../etc/in.pdf' })).issue.code, 'INVALID_INPUT_PATH');
  });

  it('fixes English-to-Chinese for schema v1', () => {
    assert.equal(validateTranslationRequest(validRequest({ language: { source: 'en', target: 'fr' } })).issue.code, 'UNSUPPORTED_LANGUAGE');
    assert.equal(validateTranslationRequest(validRequest({ language: { source: 'de', target: 'zh' } })).issue.code, 'UNSUPPORTED_LANGUAGE');
  });

  it('requires an explicit non-empty provider id', () => {
    assert.equal(validateTranslationRequest(validRequest({ provider: { id: '' } })).issue.code, 'INVALID_PROVIDER');
    assert.equal(validateTranslationRequest(validRequest({ provider: {} })).issue.code, 'INVALID_PROVIDER');
    assert.equal(validateTranslationRequest(validRequest({ provider: null })).issue.code, 'INVALID_PROVIDER');
  });

  it('rejects a non-http baseUrl', () => {
    assert.equal(validateTranslationRequest(validRequest({ provider: { id: 'x', baseUrl: 'file:///etc/passwd' } })).issue.code, 'INVALID_PROVIDER');
  });

  it('rejects malformed http endpoints with no authority/host', () => {
    for (const baseUrl of ['https:///path', 'http:///v1', 'https://', 'http://:8080/v1', 'https://?api_key=abc']) {
      assert.equal(httpUrlHasAuthority(baseUrl), false, 'expected no authority for ' + baseUrl);
      assert.equal(validateTranslationRequest(validRequest({ provider: { id: 'x', baseUrl } })).issue.code, 'INVALID_PROVIDER');
    }
    assert.equal(httpUrlHasAuthority('https://api.example.com/v1'), true);
    assert.equal(httpUrlHasAuthority('https://api.example.com:8443/v1'), true);
  });

  it('rejects a host with whitespace, a bad port or an unterminated IPv6 bracket', () => {
    const malformed = [
      'https://not a host/path',
      'https://exa mple.com/v1',
      'https://example.com:bad/v1',
      'https://example.com:/v1',
      'https://example.com:99999a/v1',
      'https://[::1/v1',
      'https://[::1]x/v1',
    ];
    for (const baseUrl of malformed) {
      assert.equal(httpUrlHasAuthority(baseUrl), false, 'expected malformed for ' + JSON.stringify(baseUrl));
      assert.equal(validateTranslationRequest(validRequest({ provider: { id: 'x', baseUrl } })).issue.code, 'INVALID_PROVIDER');
    }
  });

  it('keeps valid DNS, IPv4 and bracketed IPv6 authorities', () => {
    const valid = [
      'https://api.example.com/v1',
      'http://api.example.com:8080/v1',
      'https://192.168.0.10/v1',
      'https://127.0.0.1:11434/v1',
      'https://[::1]:8443/v1',
      'https://[2001:db8::1]/v1',
    ];
    for (const baseUrl of valid) {
      assert.equal(httpUrlHasAuthority(baseUrl), true, 'expected valid authority for ' + baseUrl);
      assert.deepEqual(validateTranslationRequest(validRequest({ provider: { id: 'x', baseUrl } })), { ok: true });
    }
  });
  it('rejects credential-bearing baseUrl values (review follow-through)', () => {
    const cases = [
      'https://user:pass@api.example.com/v1',
      'https://user@api.example.com/v1',
      'https://api.example.com/v1?api_key=abc123',
      'https://api.example.com/v1?token=abc123',
      'https://api.example.com/v1?access_token=abc',
      'https://api.example.com/v1?secret=abc',
      'https://api.example.com/v1?password=abc',
      'https://api.example.com/v1?key=abc',
      // Percent-encoded credential names must not bypass the filter.
      'https://api.example.com/v1?api%5Fkey=abc123',
      'https://api.example.com/v1?access%5Ftoken=abc',
      'https://api.example.com/v1?%61ccess%5Ftoken=abc',
      // A malformed percent-encoded name is rejected conservatively.
      'https://api.example.com/v1?token%FF=abc',
    ];
    for (const baseUrl of cases) {
      const verdict = validateTranslationRequest(validRequest({ provider: { id: 'x', baseUrl } }));
      assert.equal(verdict.ok, false, 'expected rejection for ' + baseUrl);
      assert.equal(verdict.issue.code, 'CREDENTIAL_IN_BASE_URL');
    }
  });

  it('never echoes the offending value in the rejection', () => {
    const secret = 'https://api.example.com/v1?api_key=SUPERSECRETVALUE';
    const verdict = validateTranslationRequest(validRequest({ provider: { id: 'x', baseUrl: secret } }));
    assert.equal(verdict.ok, false);
    assert.ok(!JSON.stringify(verdict).includes('SUPERSECRETVALUE'));
  });

  it('never echoes an encoded credential secret in the rejection', () => {
    const secret = 'https://api.example.com/v1?access%5Ftoken=ENCODEDSECRETVALUE';
    const verdict = validateTranslationRequest(validRequest({ provider: { id: 'x', baseUrl: secret } }));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.issue.code, 'CREDENTIAL_IN_BASE_URL');
    assert.ok(!JSON.stringify(verdict).includes('ENCODEDSECRETVALUE'));
  });
  it('rejects an unsupported output mode', () => {
    assert.equal(validateTranslationRequest(validRequest({ outputMode: 'triple' })).issue.code, 'UNSUPPORTED_OUTPUT_MODE');
  });
});

describe('path containment helpers', () => {
  it('recognizes absolute local paths and rejects escapes', () => {
    assert.equal(isAbsoluteLocalPath('C:\\work\\out'), true);
    assert.equal(isAbsoluteLocalPath('/tmp/out'), true);
    assert.equal(isAbsoluteLocalPath('relative/out'), false);
    assert.equal(isAbsoluteLocalPath(''), false);
    assert.equal(isAbsoluteLocalPath('C:/a/../../b'), false);
  });

  it('normalizes separators, case and dot segments', () => {
    assert.equal(normalizeLocalPathForCompare('C:\\Work\\Out\\'), normalizeLocalPathForCompare('c:/work/out'));
    assert.equal(normalizeLocalPathForCompare('C:/a/./b/../c'), 'c:/a/c');
  });

  it('accepts descendants and rejects siblings/escapes', () => {
    assert.equal(isPathContained('C:/work/out', 'C:/work/out/out.zh.dual.pdf'), true);
    assert.equal(isPathContained('C:/work/out', 'C:/work/out/nested/deep/out.zh.mono.pdf'), true);
    assert.equal(isPathContained('C:/work/out', 'C:/work/out'), false);
    assert.equal(isPathContained('C:/work/out', 'C:/work/other/out.pdf'), false);
    assert.equal(isPathContained('C:/work/out', 'C:/work/out/../escape.pdf'), false);
    assert.equal(isPathContained('C:/work/out', 'C:/work/outside.pdf'), false);
  });

  it('rejects the parent directory itself, including the drive root', () => {
    // Regression: outputDir 'C:/' used to treat candidate 'C:/' as contained.
    assert.equal(isPathContained('C:/', 'C:/'), false);
    assert.equal(isPathContained('C:\\', 'C:/'), false);
    assert.equal(isPathContained('C:/', 'C:/out.pdf'), true);
    assert.equal(isPathContained('/', '/'), false);
    assert.equal(isPathContained('/tmp/out', '/tmp/out'), false);
  });
});

describe('requiredOutputKinds', () => {
  it('maps each mode to its required artifacts', () => {
    assert.deepEqual(requiredOutputKinds('dual'), ['dualPdf']);
    assert.deepEqual(requiredOutputKinds('mono'), ['monoPdf']);
    assert.deepEqual(requiredOutputKinds('both'), ['dualPdf', 'monoPdf']);
  });
});

describe('checkCompletedResult (output-mode correspondence)', () => {
  function completed(jobId, outputs) {
    return { schemaVersion: 1, jobId, status: 'completed', outputs };
  }

  it('accepts a result that satisfies the mode', () => {
    const request = validRequest({ outputMode: 'both' });
    const result = completed(request.jobId, {
      dualPdf: request.outputDir + '/out.zh.dual.pdf',
      monoPdf: request.outputDir + '/out.zh.mono.pdf',
    });
    assert.deepEqual(checkCompletedResult(request, result), { ok: true });
  });

  it('rejects a completed result missing a required artifact per mode', () => {
    const dualRequest = validRequest({ outputMode: 'dual' });
    assert.equal(checkCompletedResult(dualRequest, completed(dualRequest.jobId, { monoPdf: dualRequest.outputDir + '/m.pdf' })).defect.code, 'MISSING_REQUIRED_OUTPUT');

    const monoRequest = validRequest({ outputMode: 'mono' });
    assert.equal(checkCompletedResult(monoRequest, completed(monoRequest.jobId, { dualPdf: monoRequest.outputDir + '/d.pdf' })).defect.code, 'MISSING_REQUIRED_OUTPUT');

    const bothRequest = validRequest({ outputMode: 'both' });
    assert.equal(checkCompletedResult(bothRequest, completed(bothRequest.jobId, { dualPdf: bothRequest.outputDir + '/d.pdf' })).defect.code, 'MISSING_REQUIRED_OUTPUT');
  });

  it('rejects a result whose jobId does not match', () => {
    const request = validRequest();
    const other = '99999999-8888-7777-6666-555555555555';
    assert.equal(checkCompletedResult(request, completed(other, { dualPdf: request.outputDir + '/d.pdf' })).defect.code, 'RESULT_JOB_MISMATCH');
  });

  it('rejects outputs that escape the job output directory', () => {
    const request = validRequest({ outputMode: 'dual' });
    assert.equal(checkCompletedResult(request, completed(request.jobId, { dualPdf: 'C:/work/escaped.pdf' })).defect.code, 'OUTPUT_PATH_ESCAPED');
    assert.equal(checkCompletedResult(request, completed(request.jobId, { dualPdf: request.outputDir + '/../escape.pdf' })).defect.code, 'OUTPUT_PATH_ESCAPED');
  });

  it('rejects a completed result that carries an error or empty outputs', () => {
    const request = validRequest({ outputMode: 'dual' });
    assert.equal(checkCompletedResult(request, { schemaVersion: 1, jobId: request.jobId, status: 'completed', outputs: { dualPdf: request.outputDir + '/d.pdf' }, error: { code: 'X', messageRedacted: 'y' } }).defect.code, 'INVALID_COMPLETED_RESULT');
    assert.equal(checkCompletedResult(request, completed(request.jobId, {})).defect.code, 'MISSING_REQUIRED_OUTPUT');
  });
});
