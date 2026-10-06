// Test-only FakeRuntimeAdapter for M2B (owner: M2B-FAKE-01 / DS).
//
// It implements the M2A RuntimeAdapter shape with deterministic controls and
// performs NO network, provider, or real-runtime work. It only writes synthetic
// fixture bytes into the job's own output directory. This file is a test
// fixture and must never be imported by production core code.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// A minimal structurally-valid synthetic PDF so a completed fake result models
// the M2A 'parseable PDF' requirement: catalog -> pages -> page, a byte-accurate
// xref table pointing at each object, a trailer, and a startxref offset that
// matches the xref position, followed by %%EOF.
export function makeSyntheticPdf() {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n',
  ];
  let pdf = '%PDF-1.7\n%\xFF\xFF\xFF\xFF\n';
  const offsets = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefOffset = pdf.length;
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n';
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\n';
  pdf += 'startxref\n' + xrefOffset + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}

const SYNTHETIC_PDF = makeSyntheticPdf();

export const FAKE_DUAL_NAME = 'out.zh.dual.pdf';
export const FAKE_MONO_NAME = 'out.zh.mono.pdf';

function applyOverrides(result, overrides) {
  if (!overrides) {
    return result;
  }
  const merged = { ...result, ...overrides };
  if (Object.prototype.hasOwnProperty.call(overrides, 'outputs')) {
    merged.outputs = overrides.outputs;
  }
  return merged;
}

export class FakeRuntimeAdapter {
  constructor(options = {}) {
    this.options = options;
    this.availability = options.availability ?? 'available';
    // 'success' | 'fail' | 'hang' (hang waits for cancel())
    this.behavior = options.behavior ?? 'success';
    this.outputKinds = options.outputKinds ?? ['dualPdf', 'monoPdf'];
    this.resultOverrides = options.resultOverrides ?? null;
    this.translateCalls = 0;
    this.cancelCalls = [];
    this.lastRequest = null;
    this._hangResolve = null;
    this._launchResolve = null;
    this._launched = new Promise((resolve) => { this._launchResolve = resolve; });
  }

  async checkAvailability() {
    return { availability: this.availability, checkedAt: new Date().toISOString() };
  }

  /** Resolves once translate() has actually started (for cancel tests). */
  waitForLaunch() {
    return this._launched;
  }

  _writePdf(outputDir, name) {
    const target = path.join(outputDir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, SYNTHETIC_PDF);
    return target;
  }

  async translate(request) {
    this.translateCalls += 1;
    this.lastRequest = request;
    if (this._launchResolve) {
      this._launchResolve();
      this._launchResolve = null;
    }

    if (this.behavior === 'fail') {
      return applyOverrides({
        schemaVersion: 1,
        jobId: request.jobId,
        status: 'failed',
        error: { code: 'FAKE_TRANSLATION_FAILED', messageRedacted: 'the fake runtime failed on purpose' },
      }, this.resultOverrides);
    }

    if (this.behavior === 'hang') {
      await new Promise((resolve) => { this._hangResolve = resolve; });
      return applyOverrides({
        schemaVersion: 1,
        jobId: request.jobId,
        status: 'cancelled',
      }, this.resultOverrides);
    }

    // behavior === 'success'
    const outputs = {};
    for (const kind of this.outputKinds) {
      if (kind === 'dualPdf') {
        outputs.dualPdf = this._writePdf(request.outputDir, FAKE_DUAL_NAME);
      }
      else if (kind === 'monoPdf') {
        outputs.monoPdf = this._writePdf(request.outputDir, FAKE_MONO_NAME);
      }
    }
    return applyOverrides({
      schemaVersion: 1,
      jobId: request.jobId,
      status: 'completed',
      outputs,
      runtime: { version: 'fake-1.0.0', babeldocVersion: 'fake-0.6.4' },
    }, this.resultOverrides);
  }

  async cancel(jobId) {
    this.cancelCalls.push(jobId);
    if (this._hangResolve) {
      const resolve = this._hangResolve;
      this._hangResolve = null;
      resolve();
    }
  }
}
