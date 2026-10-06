import type { PdfCandidate } from '../core/resolve-pdf.ts';
import { PowershellBridge } from '../runtime/powershell-bridge.ts';
import { TRANSLATION_CHILD_SCRIPT } from '../runtime/translation-child.ts';
import { readApiSettings, readApiKey, apiSecretScope, readPoolMaxWorkers } from './provider-settings.ts';
import { createSubprocessPort, createHostClock } from './subprocess-host.ts';
import { assertImportTarget, importTranslatedPdf } from './result-importer.ts';

const sessionKeys = new Map<string, string>();
// ponytail: one translation per Zotero session; add a queue only if batch work is needed.
let active: { jobId: string; bridge: PowershellBridge | null; cancelled: boolean; importing: boolean } | null = null;

export async function cancelTranslation(): Promise<boolean> {
  if (!active || active.importing) { return false; }
  active.cancelled = true;
  if (active.bridge) { await active.bridge.cancel(active.jobId); }
  return true;
}

export async function stopTranslation(): Promise<void> {
  sessionKeys.clear();
  await cancelTranslation();
}

export async function translatePdf(candidate: PdfCandidate, host: any): Promise<void> {
  const { Zotero, Services, Components, IOUtils, PathUtils, ChromeUtils, win } = host;
  const alert = (text: string) => Services.prompt.alert(win, 'Orange Translate', text);
  if (active) { alert('已有翻译任务正在运行。可在右键菜单取消当前任务。'); return; }
  const jobId = Services.uuid.generateUUID().toString().replace(/[{}]/g, '');
  const job = { jobId, bridge: null as PowershellBridge | null, cancelled: false, importing: false };
  active = job;
  let progress: any = null;
  let progressTimer: unknown = null;
  let outputDir = '';
  let jobsRoot = '';
  let stage = 'PREPARING';
  let credentialScope = '';
  let translated = false;
  let preserveActive = false;
  const Cc = Components.classes, Ci = Components.interfaces;
  const localFile = (path: string) => Zotero.File.pathToFile(path);
  const mkdir = (file: any) => {
    if (file.exists()) { if (!file.isDirectory()) { throw new Error('JOB_DIR_UNAVAILABLE'); } return; }
    if (file.parent && !file.parent.exists()) { mkdir(file.parent); }
    file.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  };
  const readText = (path: string) => {
    const file = localFile(path);
    if (!file.exists()) { return null; }
    const stream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
    stream.init(file, 0x01, 0, 0);
    const converter = Cc['@mozilla.org/intl/converter-input-stream;1'].createInstance(Ci.nsIConverterInputStream);
    try {
      converter.init(stream, 'UTF-8', 0, 0);
      const chunk: any = {}; let text = '';
      while (converter.readString(8192, chunk)) { text += chunk.value; }
      return text;
    }
    finally { converter.close(); }
  };
  const writeText = (path: string, text: string) => {
    const stream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
    stream.init(localFile(path), 0x02 | 0x08 | 0x20, 0o600, 0);
    const converter = Cc['@mozilla.org/intl/converter-output-stream;1'].createInstance(Ci.nsIConverterOutputStream);
    try { converter.init(stream, 'UTF-8', 0, 0); converter.writeString(text); }
    finally { converter.close(); }
  };
  const pdfValidator = (path: string) => {
    const stream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
    const binary = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
    try { stream.init(localFile(path), 0x01, 0, 0); binary.setInputStream(stream); return binary.readBytes(5) === '%PDF-'; }
    finally { stream.close(); }
  };
  const digest = (path: string) => {
    const stream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
    try {
      stream.init(localFile(path), 0x01, 0, 0);
      const hash = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
      hash.init(hash.SHA256); hash.updateFromStream(stream, -1);
      return hash.finish(true);
    }
    finally { stream.close(); }
  };
  try {
    assertImportTarget(Zotero, candidate);
    const runtimeRoot = Services.prefs.getStringPref('extensions.orange-translate.runtimeRoot', 'F:\\pdf2zh\\build\\PDF翻译器');
    const python = PathUtils.join(runtimeRoot, 'runtime', 'python', 'python.exe');
    const libs = PathUtils.join(runtimeRoot, 'runtime', 'libs');
    if (!localFile(python).exists() || !localFile(PathUtils.join(libs, 'pdf2zh_next', 'main.py')).exists()) {
      throw new Error('RUNTIME_MISSING');
    }
    jobsRoot = Services.prefs.getStringPref('extensions.orange-translate.jobsRoot', 'D:\\Orange Translate-jobs');
    mkdir(localFile(jobsRoot));
    outputDir = PathUtils.join(jobsRoot, jobId);
    const settings = readApiSettings(host);
    const poolMaxWorkers = readPoolMaxWorkers(host);
    const profile = settings.profiles.find(p => p.id === settings.activeId)!;
    const model = profile.model;
    credentialScope = apiSecretScope(profile);
    if (!Services.prompt.confirm(win, 'Orange Translate',
      '将通过 ' + profile.name + '（' + model + '）翻译所选 PDF，发送待翻译文本并可能产生 API 费用。\n接口：' + profile.baseUrl
      + (profile.protocol === 'responses' ? '/responses' : '/chat/completions') + '\n完成后自动添加双语附件。\n\n开始翻译？')) { return; }
    let apiKey = sessionKeys.get(credentialScope) || '';
    try { apiKey = await readApiKey(profile, host) || apiKey; } catch {}
    if (!apiKey) {
      const value = { value: '' };
      if (!Services.prompt.promptPassword(win, profile.name + ' API Key',
        '请输入此服务商的 API Key。本次输入仅在当前会话内保留；可在“API 与模型设置”中保存。', value, null, { value: false })) { return; }
      apiKey = value.value.trim();
      if (!apiKey || /[\r\n\0]/.test(apiKey)) { throw new Error('PROVIDER_NOT_CONFIGURED'); }
    }
    sessionKeys.set(credentialScope, apiKey);
    if (job.cancelled) { return; }
    const originalDigest = digest(candidate.absolutePath!);
    const childScriptPath = PathUtils.join(jobsRoot, 'translation-child.ps1');
    await IOUtils.writeUTF8(childScriptPath, TRANSLATION_CHILD_SCRIPT);
    const cacheRoot = PathUtils.join(jobsRoot, 'runtime-cache');
    mkdir(localFile(cacheRoot));
    const native = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs').Subprocess;
    job.bridge = new PowershellBridge({
      executablePath: Services.env.get('SystemRoot') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      childScriptPath,
      subprocess: createSubprocessPort({ call: (options: any) => native.call({ ...options,
        environmentAppend: true, environment: {
          ORANGE_PYTHON_EXE: python, ORANGE_LIBS_ROOT: libs, ORANGE_CACHE_ROOT: cacheRoot,
          ORANGE_MODELS_ROOT: PathUtils.join(runtimeRoot, 'models', 'babeldoc'),
          ORANGE_API_BASE_URL: profile.baseUrl, ORANGE_API_PROTOCOL: profile.protocol,
          ORANGE_POOL_MAX_WORKERS: String(poolMaxWorkers),
          TEMP: cacheRoot, TMP: cacheRoot,
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
        },
      }) }),
      files: {
        isFreshDirectory: path => { const f = localFile(path); return !f.exists() || (f.isDirectory() && !f.directoryEntries.hasMoreElements()); },
        mkdirp: path => mkdir(localFile(path)), writeText, readText,
        exists: path => localFile(path).exists(), size: path => localFile(path).fileSize,
        removeRecursive: path => { try { const f = localFile(path); if (f.exists()) { f.remove(true); } } catch {} },
      },
      clock: createHostClock({ setTimeout: win.setTimeout.bind(win), clearTimeout: win.clearTimeout.bind(win) }),
      pdfValidator,
      timeouts: { startupMs: 30_000, translationMs: 30 * 60_000 },
      secretStore: {
        save: async (_id, key) => { apiKey = key; sessionKeys.set(credentialScope, key); },
        delete: async () => { sessionKeys.delete(credentialScope); },
        retrieveForJob: async (providerId, id) => ({ state: 'ready', providerId, jobId: id, apiKey }),
      },
    });
    if (job.cancelled) { return; }
    const doc = win.document;
    const element = (tag: string) => doc.createElementNS('http://www.w3.org/1999/xhtml', tag);
    const panel = element('section');
    panel.setAttribute('aria-label', 'Orange Translate 翻译状态');
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:calc(100vw - 32px);width:420px;padding:14px;box-sizing:border-box;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:8px;box-shadow:0 2px 12px #0003;font:13px sans-serif;';
    const headline = element('strong');
    headline.setAttribute('role', 'status');
    headline.setAttribute('aria-live', 'polite');
    const details = element('p');
    details.style.cssText = 'margin:8px 0;white-space:pre-line;overflow-wrap:anywhere;';
    const cancel = element('button');
    cancel.textContent = '取消翻译';
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try {
        if (await cancelTranslation()) { details.textContent = '正在停止翻译进程…'; }
        else { details.textContent = '正在添加附件，请等待完成。'; }
      } catch { alert('尚未确认翻译进程停止。'); }
    });
    const meter = element('progress'); meter.max = 100; meter.style.cssText = 'display:block;width:100%;margin:8px 0;';
    meter.setAttribute('aria-label', '翻译引擎总进度');
    const percent = element('div'); percent.textContent = '等待引擎进度…';
    panel.append(headline, meter, percent, details, cancel);
    progress = {
      changeHeadline: (text: string) => { headline.textContent = text; },
      addDescription: (text: string) => { details.textContent = text; },
      show: () => doc.documentElement.appendChild(panel),
      close: () => panel.remove(),
      startCloseTimer: (ms: number) => { cancel.disabled = true; win.setTimeout(() => panel.remove(), ms); },
    };
    progress.changeHeadline('Orange Translate：正在翻译');
    progress.addDescription('正在启动原有本地翻译环境。');
    progress.show();
    const startedMs = Date.now();
    const pollProgress = () => {
      if (active !== job || job.cancelled || job.importing) { return; }
      try {
        const raw = readText(PathUtils.join(outputDir, 'progress.json'));
        const update = raw ? JSON.parse(raw) : null;
        const labels: Record<string, string> = {
          PREPARING_ASSETS: '正在准备本地字体与模型',
          RUNNING_TRANSLATOR: '正在启动翻译引擎',
          API_REQUEST: '正在等待 DCS 返回译文',
          API_RECEIVING: '正在接收 DCS 译文',
          API_PROCESSING: 'DCS 正在处理请求',
          API_FAILED: '部分 DCS 请求失败，正在收尾',
          API_FINISHED: 'DCS 已返回译文，继续处理 PDF',
          VALIDATING_OUTPUT: '正在检查生成的 PDF',
        };
        if (update?.jobId === jobId && labels[update.stage]) {
          progress.changeHeadline('Orange Translate：' + labels[update.stage]);
          const counts = update.api;
          const elapsed = Math.floor((Date.now() - startedMs) / 1000);
          const idle = Math.max(0, Math.floor((Date.now() - update.updatedMs) / 1000));
          const valid = counts && ['completed', 'active', 'failed'].every(key => Number.isInteger(counts[key]) && counts[key] >= 0);
          progress.addDescription((valid ? '接口已完成 ' + counts.completed + ' 次 · 进行中 ' + counts.active + ' 次 · 失败 ' + counts.failed + ' 次\n' : '')
            + '已用时 ' + elapsed + ' 秒 · 距最近状态更新 ' + idle + ' 秒'
            + (idle >= 120 ? '\n等待时间较长，可取消；目前尚未完成。' : ''));
        }
        const engineRaw = readText(PathUtils.join(outputDir, 'engine-progress.json'));
        const engine = engineRaw ? JSON.parse(engineRaw) : null;
        if (engine?.jobId === jobId && Number.isFinite(engine.overallProgress) && engine.overallProgress >= 0 && engine.overallProgress <= 100) {
          meter.value = engine.overallProgress;
          const stageNames: Record<string, string> = { PARSE_PDF: '解析 PDF', LAYOUT: '分析版面', TRANSLATE_TEXT: '翻译段落',
            TYPESETTING: '排版', SAVE_PDF: '保存 PDF', FINISHED: '引擎已完成，准备回挂' };
          const label = stageNames[engine.stage] || '处理 PDF';
          percent.textContent = '翻译进度 ' + engine.overallProgress.toFixed(1) + '% · ' + label
            + (Number.isInteger(engine.stageCurrent) && Number.isInteger(engine.stageTotal) && engine.stageTotal > 0 ? ' ' + engine.stageCurrent + '/' + engine.stageTotal : '')
            + (engine.totalParts > 1 ? ' · 第 ' + engine.partIndex + '/' + engine.totalParts + ' 部分' : '');
        }
      } catch {}
      progressTimer = win.setTimeout(pollProgress, 2000);
    };
    progressTimer = win.setTimeout(pollProgress, 2000);
    stage = 'TRANSLATING';
    const result = await job.bridge.translate({ schemaVersion: 1, jobId,
      inputPdf: candidate.absolutePath!, outputDir, language: { source: 'en', target: 'zh' },
      provider: { id: profile.id, model }, outputMode: 'both',
    });
    if (result.status === 'failed' && ['EXIT_UNCONFIRMED', 'CANCEL_NOT_HONORED'].includes(result.error.code)) {
      preserveActive = true;
      throw new Error(result.error.code);
    }
    if (job.cancelled || result.status === 'cancelled') { progress.close(); alert('翻译已取消，未添加附件。'); return; }
    if (result.status !== 'completed') { throw new Error(result.error?.code || 'TRANSLATION_FAILED'); }
    if (!result.outputs.dualPdf) { throw new Error('MISSING_REQUIRED_OUTPUT'); }
    translated = true;
    let unchanged = false;
    try { unchanged = digest(candidate.absolutePath!) === originalDigest; } catch {}
    if (!unchanged) { throw new Error('SOURCE_CHANGED'); }
    job.importing = true;
    stage = 'IMPORTING';
    progress.changeHeadline('Orange Translate：正在添加双语附件');
    const attachment = await importTranslatedPdf(Zotero, candidate, result.outputs.dualPdf);
    progress.changeHeadline('Orange Translate：翻译完成');
    meter.value = 100; percent.textContent = '100% · 双语 PDF 已回挂';
    progress.addDescription('双语 PDF 已添加为 Zotero 附件。');
    progress.startCloseTimer(5000);
    alert('翻译完成，双语 PDF 已添加到文献下。\n附件：' + attachment.getField('title'));
  }
  catch (error: any) {
    const rawCode = String(error?.message || 'INTERNAL_ERROR');
    const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(rawCode) ? rawCode : 'INTERNAL_ERROR';
    const messages: Record<string, string> = {
      RUNTIME_MISSING: '找不到原翻译环境。请检查插件配置的 runtimeRoot 路径。',
      RUNTIME_INCOMPATIBLE: '原翻译环境无法运行，请检查 Python 与翻译依赖。',
      LIBRARY_READ_ONLY: '当前文献库没有附件写入权限。',
      SOURCE_CHANGED: '原文或文献位置发生变化，未自动回挂。',
      PROVIDER_NOT_CONFIGURED: '没有配置可用的 API Key。',
      INVALID_API_SETTINGS: 'API 配置无法读取，请打开“API 与模型设置”修正配置。',
      INVALID_WORKER_COUNT: '线程数配置无效，请在“API 与模型设置”中保存 1 到 64 的整数。',
      TRANSLATION_TIMEOUT: '翻译超时，进程已停止。',
      SPAWN_FAILED: '本地翻译进程未能启动。',
      SECRET_WRITE_FAILED: '插件向本地翻译进程传送 Key 失败；这不代表 DCS Key 无效。',
      SECRET_STDIN_UNAVAILABLE: '本地翻译进程没有提供 Key 输入通道。',
      SECRET_WRITE_TIMEOUT: '向本地翻译进程传送 Key 超时。',
      REQUEST_WRITE_FAILED: '插件无法写入本地翻译请求。',
      JOB_DIR_UNAVAILABLE: '本地翻译任务目录不可用。',
      PROCESS_EXIT_NONZERO: '本地翻译程序异常退出。',
      RESULT_MISSING: '本地翻译程序未返回结果。',
      PROVIDER_UNREACHABLE: '所选 API 未返回完整翻译结果。请检查协议、模型、Key 或网络。',
      INTERNAL_ERROR: '插件本地执行发生错误。',
      EXIT_UNCONFIRMED: '无法确认翻译进程已退出，已暂停新任务。请退出 Zotero 后再尝试。',
      CANCEL_NOT_HONORED: '取消操作尚未确认进程停止，已暂停新任务。请退出 Zotero 后再尝试。',
    };
    if (jobsRoot) {
      try { await IOUtils.writeUTF8(PathUtils.join(jobsRoot, 'last-job.json'),
        JSON.stringify({ schemaVersion: 1, jobId, status: 'failed', stage, errorCode: code })); } catch {}
    }
    if (progress) { progress.close(); }
    if (!translated && ['PROVIDER_NOT_CONFIGURED', 'PROVIDER_UNREACHABLE', 'TRANSLATION_FAILED'].includes(code)) { sessionKeys.delete(credentialScope); }
    alert((messages[code] || '翻译未完成。') + '\n阶段：' + stage + '\n错误码：' + code
      + (translated ? '\n译文已保留，可手动导入：\n' + outputDir : ''));
  }
  finally {
    if (progressTimer !== null) { win.clearTimeout(progressTimer); }
    if (active === job && !preserveActive) { active = null; }
  }
}
