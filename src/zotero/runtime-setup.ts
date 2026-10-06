import { RUNTIME_INSTALL_SCRIPT } from '../runtime/runtime-install.ts';
import { adaptZoteroProcess } from './subprocess-host.ts';

const ROOT_PREF = 'extensions.orange-translate.runtimeRoot';
let installing: any = null;

export function resolveRuntime(host: any, root = host.Services.prefs.getStringPref(ROOT_PREF, '')): { root: string; python: string; libs: string; models: string } {
  if (!root) { throw new Error('RUNTIME_MISSING'); }
  const join = host.PathUtils.join;
  const exists = (path: string) => { const file = host.Zotero.File.pathToFile(path); return file.exists() && file.isFile(); };
  if (exists(join(root, '.orange-translate-runtime.json')) && !exists(join(root, 'ready.json'))) { throw new Error('RUNTIME_MISSING'); }
  const python = [join(root, 'runtime', 'python', 'python.exe'), join(root, 'runtime', 'python', 'Scripts', 'python.exe')].find(exists);
  const libs = join(root, 'runtime', 'libs');
  if (!python || !exists(join(libs, 'pdf2zh_next', 'main.py')) || !exists(join(libs, 'babeldoc', '__init__.py'))) { throw new Error('RUNTIME_MISSING'); }
  const models = join(root, 'models', 'babeldoc');
  return { root, python, libs, models: host.Zotero.File.pathToFile(models).exists() ? models : join(root, '.cache', 'babeldoc') };
}

async function pickFolder(host: any, title: string): Promise<string | null> {
  const { FilePicker } = host.ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
  const picker = new FilePicker();
  picker.init(host.win, title, picker.modeGetFolder);
  return await picker.show() === picker.returnOK ? picker.file : null;
}

export async function selectRuntime(host: any): Promise<string | null> {
  const root = await pickFolder(host, '选择已有翻译环境的根目录（包含 runtime 文件夹）');
  if (!root) { return null; }
  resolveRuntime(host, root);
  host.Services.prefs.setStringPref(ROOT_PREF, root);
  return root;
}

export async function cancelRuntimeSetup(): Promise<void> {
  if (installing) { installing.cancelled = true; if (installing.process) { await installing.process.kill(0); } }
}

export async function installRuntime(host: any, update: (text: string) => void): Promise<string | null> {
  if (installing) { throw new Error('INSTALL_BUSY'); }
  if (host.Services.appinfo.OS !== 'WINNT' || !/x86_64|amd64/i.test(host.Services.appinfo.XPCOMABI)) { throw new Error('INSTALL_UNSUPPORTED'); }
  const parent = await pickFolder(host, '选择安装位置：将在其中创建 OrangeTranslateRuntime 文件夹');
  if (!parent) { return null; }
  const root = host.PathUtils.join(parent, 'OrangeTranslateRuntime');
  const marker = host.PathUtils.join(root, '.orange-translate-runtime.json');
  const folder = host.Zotero.File.pathToFile(root);
  if (folder.exists() && !folder.isDirectory()) { throw new Error('INSTALL_DIR_UNOWNED'); }
  if (folder.exists() && folder.directoryEntries.hasMoreElements()) {
    let owned: any;
    try { owned = JSON.parse(await host.IOUtils.readUTF8(marker)); } catch {}
    if (owned?.app !== 'Orange Translate' || owned?.schemaVersion !== 1) { throw new Error('INSTALL_DIR_UNOWNED'); }
  }
  await host.IOUtils.makeDirectory(root, { createAncestors: true, ignoreExisting: true });
  await host.IOUtils.writeUTF8(marker, JSON.stringify({ app: 'Orange Translate', schemaVersion: 1 }));
  const script = host.PathUtils.join(root, 'install-runtime.ps1');
  await host.IOUtils.writeUTF8(script, RUNTIME_INSTALL_SCRIPT);
  const job = { process: null as any, cancelled: false };
  installing = job;
  const stop = () => { void cancelRuntimeSetup(); };
  host.win.addEventListener('unload', stop, { once: true });
  const labels: Record<string, string> = {
    DOWNLOAD_UV: '正在下载并校验安装工具…', INSTALL_PYTHON: '正在安装 Python 3.12…',
    INSTALL_ENGINE: '正在安装翻译引擎与依赖…', DOWNLOAD_ASSETS: '正在下载字体与版面模型，首次准备可能需要几分钟…',
    READY: '翻译环境准备完成。',
  };
  let failure = 'INSTALL_FAILED', ready = false;
  let timedOut = false;
  const timer = host.win.setTimeout(() => { timedOut = true; void cancelRuntimeSetup(); }, 45 * 60_000);
  try {
    update('正在准备安装：' + root + '\n请保持设置窗口打开，首次需要联网下载。');
    const native = host.ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs').Subprocess;
    job.process = await native.call({
      command: host.Services.env.get('SystemRoot') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      arguments: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root],
      workdir: root, stderr: 'pipe',
    });
    await job.process.stdin?.close();
    if (job.cancelled) { await job.process.kill(0); }
    const process = adaptZoteroProcess(job.process);
    const read = async (pipe: any, stdout: boolean) => {
      if (!pipe) { return; }
      let pending = '';
      for await (const chunk of pipe) {
        if (!stdout) { continue; }
        pending += chunk;
        if (pending.length > 8192) { throw new Error('INSTALL_FAILED'); }
        let pos: number;
        while ((pos = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, pos); pending = pending.slice(pos + 1);
          let value: any; try { value = JSON.parse(line); } catch { continue; }
          if (labels[value.stage]) { update(labels[value.stage] + '\n安装目录：' + root); }
          if (value.stage === 'READY') { ready = true; }
          if (/^[A-Z_]+FAILED$|^DOWNLOAD_HASH_MISMATCH$/.test(value.stage)) { failure = value.stage; }
        }
      }
    };
    const [exit] = await Promise.all([process.wait(), read(process.stdout, true), read(process.stderr, false)]);
    if (timedOut) { throw new Error('INSTALL_TIMEOUT'); }
    if (job.cancelled) { throw new Error('INSTALL_CANCELLED'); }
    if (exit.exitCode !== 0 || !ready) { throw new Error(failure); }
    resolveRuntime(host, root);
    host.Services.prefs.setStringPref(ROOT_PREF, root);
    return root;
  } finally {
    host.win.clearTimeout(timer);
    host.win.removeEventListener('unload', stop);
    if (job.process?.exitCode === null) { await job.process.kill(0); }
    if (installing === job) { installing = null; }
  }
}
