import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TRANSLATION_CHILD_SCRIPT } from '../src/runtime/translation-child.ts';
import { encodeSecretFrame } from '../src/runtime/powershell-bridge.ts';
import { assertImportTarget, importTranslatedPdf } from '../src/zotero/result-importer.ts';

test('native PowerShell/Python adapter handles Unicode paths and keeps the key out of files and output', () => {
  const root = mkdtempSync(path.resolve('.local/tmp/connector-中文 空格-'));
  const job = path.join(root, 'job');
  const libs = path.join(root, 'libs');
  mkdirSync(job); mkdirSync(path.join(libs, 'pdf2zh_next'), { recursive: true });
  writeFileSync(path.join(libs, 'pdf2zh_next/__init__.py'), '');
  const implementation = path.join(libs, 'pdf2zh_next/translator/translator_impl');
  mkdirSync(implementation, { recursive: true });
  for (const directory of [path.dirname(implementation), implementation]) {
    writeFileSync(path.join(directory, '__init__.py'), '');
  }
  writeFileSync(path.join(implementation, 'openai.py'), `from types import SimpleNamespace as NS
class Stream:
    def __init__(self, events): self.events = events
    def __enter__(self): return iter(self.events)
    def __exit__(self, *args): pass
class Counter:
    def __init__(self): self.value = 0
    def inc(self, value): self.value += value
class Responses:
    def __init__(self): self.calls = []; self.mode = 'completed'
    def create(self, **kwargs):
        self.calls.append(kwargs)
        assert kwargs['stream'] is True and kwargs['model'] == 'deepseek-v4-flash'
        events = [NS(type='response.reasoning_text.delta', delta='DO NOT TRANSLATE THIS'),
                  NS(type='response.output_text.delta', delta='中文译文')]
        if self.mode == 'completed':
            events.append(NS(type='response.completed', response=NS(status='completed', output_text='', usage=NS(total_tokens=3, input_tokens=2, output_tokens=1))))
        elif self.mode != 'truncated': events.append(NS(type=self.mode))
        return Stream(events)
class OpenAITranslator:
    def __init__(self):
        self.client = NS(responses=Responses()); self.model = 'deepseek-v4-flash'
        self.token_count = Counter(); self.prompt_token_count = Counter(); self.completion_token_count = Counter()
    def prompt(self, text): return [{'role': 'user', 'content': 'translate: ' + text}]
    def _remove_cot_content(self, text): return text
    def do_translate(self, text, rate_limit_params=None): return '中文译文'
    def do_llm_translate(self, text, rate_limit_params=None): return '中文译文'
`);
  writeFileSync(path.join(libs, 'pdf2zh_next/high_level.py'), `async def do_translate_async_stream(*args, **kwargs):
    import os, json
    from pathlib import Path
    yield {'type':'progress_update', 'stage':'Translate Paragraphs', 'overall_progress':63.5, 'stage_progress':50.0,
        'stage_current':5, 'stage_total':10, 'part_index':1, 'total_parts':2, 'api_key':'TEST-ONLY-KEY'}
    recorded = json.loads(Path(os.environ['ORANGE_PROGRESS_PATH']).with_name('engine-progress.json').read_text())
    assert recorded['overallProgress'] == 63.5 and recorded['stageCurrent'] == 5 and recorded['stageTotal'] == 10
    assert recorded['stage'] == 'TRANSLATE_TEXT' and 'api_key' not in recorded
    yield {'type':'finish'}
`);
  writeFileSync(path.join(libs, 'pdf2zh_next/main.py'), `import os, sys, multiprocessing
from pathlib import Path
from pdf2zh_next.translator.translator_impl.openai import OpenAITranslator
def translation_worker(output_dir):
    import json
    from concurrent.futures import ThreadPoolExecutor
    translator = OpenAITranslator()
    assert translator.name == 'dcs-responses' if os.environ.get('ORANGE_API_PROTOCOL', 'responses') == 'responses' else translator.name.startswith('ot-chat-')
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(translator.do_llm_translate, ['worker prompt'] * 4)) == ['中文译文'] * 4
    p = Path(output_dir)
    status = json.loads((p / 'progress.json').read_text())
    assert status['api']['completed'] == 4 and status['api']['active'] == 0 and status['api']['failed'] == 0
    if os.environ.get('ORANGE_FAKE_WORKER_FAILURE'):
        translator.client.responses.mode = 'truncated'
        try: translator.do_llm_translate('worker prompt')
        except RuntimeError: pass
    (p / '中文 双语.zh.dual.pdf').write_bytes(b'%PDF-fake dual')
    (p / '中文 译文.zh.mono.pdf').write_bytes(b'%PDF-fake mono')
def cli():
    key = os.environ['PDF2ZH_OPENAI_API_KEY']
    assert key == 'TEST-ONLY-KEY' and key not in ' '.join(sys.argv)
    assert '--openai' in sys.argv and '--deepseek' not in sys.argv
    assert sys.argv[sys.argv.index('--pool-max-workers') + 1] == os.environ.get('ORANGE_POOL_MAX_WORKERS', '16')
    assert sys.argv[sys.argv.index('--openai-model') + 1] == 'deepseek-v4-flash'
    assert sys.argv[sys.argv.index('--openai-base-url') + 1] == os.environ.get('ORANGE_API_BASE_URL', 'https://dcsapi.dcs.cloud/api/aigress/unified/v1')
    translator = OpenAITranslator()
    responses_mode = os.environ.get('ORANGE_API_PROTOCOL', 'responses') == 'responses'
    assert translator.do_translate('source') == '中文译文'
    if responses_mode: assert translator.client.responses.calls[-1]['input'] == translator.prompt('source')
    assert translator.do_llm_translate('full prompt') == '中文译文'
    if responses_mode: assert translator.client.responses.calls[-1]['input'] == 'full prompt'
    assert translator.do_llm_translate(None) is None
    if responses_mode: assert translator.token_count.value == 6
    for mode in (('truncated', 'response.failed', 'response.incomplete', 'error') if responses_mode else []):
        translator.client.responses.mode = mode
        try: translator.do_llm_translate('full prompt')
        except RuntimeError: pass
        else: raise AssertionError('partial/failed stream accepted')
    print(key)
    p = Path(sys.argv[sys.argv.index('--output') + 1])
    process = multiprocessing.get_context('spawn').Process(target=translation_worker, args=(str(p),))
    process.start()
    process.join(8)
    if process.is_alive():
        process.kill(); process.join()
    assert process.exitcode == 0, 'Windows translation worker failed'
    import asyncio
    import pdf2zh_next.high_level as high_level
    async def consume():
        async for event in high_level.do_translate_async_stream(): pass
    asyncio.run(consume())
`);
  const source = path.join(root, '中文 原文.pdf');
  writeFileSync(source, '%PDF-original');
  const before = createHash('sha256').update(readFileSync(source)).digest('hex');
  const request = { schemaVersion: 1, jobId: '11111111-1111-4111-8111-111111111111',
    inputPdf: source, outputDir: job, provider: { id: 'deepseek', model: 'deepseek-v4-flash' }, outputMode: 'both' };
  const requestPath = path.join(job, 'request.json'), resultPath = path.join(job, 'result.json');
  const script = path.join(root, 'translation-child.ps1');
  writeFileSync(script, TRANSLATION_CHILD_SCRIPT);
  writeFileSync(requestPath, JSON.stringify(request));
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: root, TMP: root, USERPROFILE: root,
    ORANGE_PYTHON_EXE: 'F:/pdf2zh/build/PDF翻译器/runtime/python/python.exe',
    ORANGE_LIBS_ROOT: libs, ORANGE_CACHE_ROOT: path.join(root, 'cache'), ORANGE_MODELS_ROOT: path.join(root, 'no-models') };
  const stdout = execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-RequestPath', requestPath, '-ResultPath', resultPath], {
      env, input: Buffer.from(encodeSecretFrame({ jobId: request.jobId, providerId: 'deepseek', apiKey: 'TEST-ONLY-KEY' })),
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
  const rawResult = readFileSync(resultPath, 'utf8'), result = JSON.parse(rawResult);
  assert.equal(result.status, 'completed', stdout); assert.equal(result.jobId, request.jobId);
  assert.ok(result.outputs.dualPdf.endsWith('.dual.pdf'));
  const progressPath = path.join(job, 'progress.json');
  const progress = JSON.parse(readFileSync(progressPath, 'utf8'));
  assert.equal(progress.jobId, request.jobId);
  assert.equal(progress.stage, 'VALIDATING_OUTPUT');
  const enginePath = path.join(job, 'engine-progress.json');
  const engine = JSON.parse(readFileSync(enginePath, 'utf8'));
  assert.equal(engine.overallProgress, 100);
  assert.equal(engine.stage, 'FINISHED');
  assert.equal(engine.jobId, request.jobId);
  assert.equal(stdout.includes('TEST-ONLY-KEY'), false);
  for (const file of [requestPath, script, path.join(job, 'translate.py'), resultPath, progressPath, enginePath]) {
    assert.equal(readFileSync(file, 'utf8').includes('TEST-ONLY-KEY'), false);
  }
  assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), before);
  const partialJob = path.join(root, 'partial-job');
  mkdirSync(partialJob);
  const partialRequest = path.join(partialJob, 'request.json');
  const partialResult = path.join(partialJob, 'result.json');
  writeFileSync(partialRequest, JSON.stringify({ ...request, outputDir: partialJob }));
  execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-RequestPath', partialRequest, '-ResultPath', partialResult], {
      env: { ...env, ORANGE_FAKE_WORKER_FAILURE: '1' },
      input: Buffer.from(encodeSecretFrame({ jobId: request.jobId, providerId: 'deepseek', apiKey: 'TEST-ONLY-KEY' })),
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
  const failed = JSON.parse(readFileSync(partialResult, 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'PROVIDER_UNREACHABLE', 'engine swallowing a paragraph error must not report a successful PDF');
  const chatJob = path.join(root, 'chat-job'); mkdirSync(chatJob);
  const chatRequest = path.join(chatJob, 'request.json'), chatResult = path.join(chatJob, 'result.json');
  writeFileSync(chatRequest, JSON.stringify({ ...request, provider: { id: 'custom-profile', model: request.provider.model }, outputDir: chatJob }));
  execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-RequestPath', chatRequest, '-ResultPath', chatResult], {
      env: { ...env, ORANGE_API_PROTOCOL: 'chat', ORANGE_API_BASE_URL: 'https://compat.example/v1' },
      input: Buffer.from(encodeSecretFrame({ jobId: request.jobId, providerId: 'custom-profile', apiKey: 'TEST-ONLY-KEY' })),
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
  assert.equal(JSON.parse(readFileSync(chatResult, 'utf8')).status, 'completed');
});

test('importer preserves parent/library identity and standalone collections; changed/read-only targets are rejected', async () => {
  const candidate = { libraryID: 1, attachmentID: 2, attachmentKey: 'PDF', parentItemKey: 'PARENT', fileName: 'paper.pdf' };
  let source = { key: 'PDF', libraryID: 1, parentItemKey: 'PARENT', getCollections: () => [7] };
  const calls = [];
  const library = { editable: true, filesEditable: true };
  const host = { Items: { get: () => source, getByLibraryAndKey: () => ({ id: 3, isRegularItem: () => true }) },
    Libraries: { get: () => library }, Attachments: { importFromFile: async options => { calls.push(options); return { id: 4 }; } } };
  await importTranslatedPdf(host, candidate, 'D:/job/paper.zh.dual.pdf');
  assert.equal(calls[0].parentItemID, 3); assert.equal(calls[0].libraryID, 1);
  source.parentItemKey = null;
  await importTranslatedPdf(host, { ...candidate, parentItemKey: null }, 'D:/job/standalone.zh.dual.pdf');
  assert.deepEqual(calls[1].collections, [7]); assert.equal(calls[1].parentItemID, undefined);
  assert.throws(() => assertImportTarget(host, candidate), /SOURCE_CHANGED/);
  source.parentItemKey = 'PARENT'; library.filesEditable = false;
  assert.throws(() => assertImportTarget(host, candidate), /LIBRARY_READ_ONLY/);
  assert.equal(calls.length, 2);
});
