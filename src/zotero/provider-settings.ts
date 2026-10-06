import { DCS_BASE_URL, DCS_MODEL } from '../runtime/translation-child.ts';

export type ApiProtocol = 'responses' | 'chat';
export interface ApiProfile { id: string; name: string; protocol: ApiProtocol; baseUrl: string; model: string; models: string[]; }
export interface ApiSettings { schemaVersion: 1; activeId: string; profiles: ApiProfile[]; }
const PREF = 'extensions.orange-translate.apiProfiles';
const WORKERS_PREF = 'extensions.orange-translate.poolMaxWorkers';

export function readPoolMaxWorkers(host: any): number {
  const count = host.Services.prefs.getIntPref?.(WORKERS_PREF, 16) ?? 16;
  if (!Number.isInteger(count) || count < 1 || count > 64) { throw new Error('INVALID_WORKER_COUNT'); }
  return count;
}
export function savePoolMaxWorkers(count: number, host: any): void {
  if (!Number.isInteger(count) || count < 1 || count > 64) { throw new Error('INVALID_WORKER_COUNT'); }
  host.Services.prefs.setIntPref(WORKERS_PREF, count);
}
const ORIGIN = 'chrome://orange-translate';
export const API_PANE_ID = 'orange-translate-api';
export const DEFAULT_API_PROFILE: ApiProfile = { id: 'dcs', name: 'DCS', protocol: 'responses', baseUrl: DCS_BASE_URL, model: DCS_MODEL, models: [DCS_MODEL] };

export function normalizeProfile(value: any, URLClass: any): ApiProfile {
  if (!value || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80
    || !['responses', 'chat'].includes(value.protocol) || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200
    || !Array.isArray(value.models) || value.models.length > 500 || typeof value.baseUrl !== 'string' || value.baseUrl.length > 2048) { throw new Error('INVALID_PROFILE'); }
  let url: any;
  try { url = new URLClass(value.baseUrl.trim()); } catch { throw new Error('INVALID_ENDPOINT'); }
  if (url.username || url.password || url.search || url.hash) { throw new Error('CREDENTIAL_IN_URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('INVALID_ENDPOINT');
  }
  let protocol = value.protocol;
  if (/\/responses\/?$/.test(url.pathname)) { protocol = 'responses'; url.pathname = url.pathname.replace(/\/responses\/?$/, ''); }
  if (/\/chat\/completions\/?$/.test(url.pathname)) { protocol = 'chat'; url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, ''); }
  const model = value.model.trim();
  if (/[\r\n\0]/.test(model) || /^(-|sk-|Bearer\s)/i.test(model)) { throw new Error('INVALID_PROFILE'); }
  const models = [...new Set([model, ...value.models].filter((id: any) => typeof id === 'string' && id.trim() && id.length <= 200).map((id: string) => id.trim()))].slice(0, 500) as string[];
  return { id: value.id, name: value.name.trim(), protocol, baseUrl: url.toString().replace(/\/+$/, ''), model, models };
}

export function readApiSettings(host: any): ApiSettings {
  const raw = host.Services.prefs.getStringPref(PREF, '');
  if (!raw) { return { schemaVersion: 1, activeId: 'dcs', profiles: [{ ...DEFAULT_API_PROFILE, models: [...DEFAULT_API_PROFILE.models] }] }; }
  try {
    const value = JSON.parse(raw);
    if (value.schemaVersion !== 1 || !Array.isArray(value.profiles) || !value.profiles.length || value.profiles.length > 20) { throw new Error(); }
    const profiles = value.profiles.map((profile: any) => normalizeProfile(profile, host.win.URL));
    if (new Set(profiles.map((p: ApiProfile) => p.id)).size !== profiles.length || !profiles.some((p: ApiProfile) => p.id === value.activeId)) { throw new Error(); }
    return { schemaVersion: 1, activeId: value.activeId, profiles };
  } catch { throw new Error('INVALID_API_SETTINGS'); }
}

export function saveApiSettings(settings: ApiSettings, host: any): void {
  if (!settings.profiles.length || settings.profiles.length > 20 || !settings.profiles.some(p => p.id === settings.activeId)) { throw new Error('INVALID_API_SETTINGS'); }
  const profiles = settings.profiles.map(p => normalizeProfile(p, host.win.URL));
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) { throw new Error('INVALID_API_SETTINGS'); }
  host.Services.prefs.setStringPref(PREF, JSON.stringify({ schemaVersion: 1, activeId: settings.activeId, profiles }));
}

export function apiSecretScope(profile: ApiProfile): string { return 'Orange Translate:' + profile.id + ':' + profile.protocol + ':' + profile.baseUrl; }
function logins(host: any): any {
  if (!host.Services.logins) { throw new Error('SECRET_STORE_UNAVAILABLE'); }
  return host.Services.logins;
}
export async function readApiKey(profile: ApiProfile, host: any): Promise<string> {
  try {
    const manager = logins(host);
    await manager.initializationPromise;
    return manager.findLogins(ORIGIN, null, apiSecretScope(profile)).find((login: any) => login.username === profile.id)?.password || '';
  } catch { throw new Error('SECRET_STORE_UNAVAILABLE'); }
}
export async function saveApiKey(profile: ApiProfile, key: string, host: any): Promise<void> {
  if (!key.trim() || key.length > 8192 || /[\r\n\0]/.test(key)) { throw new Error('INVALID_API_KEY'); }
  try {
    const manager = logins(host);
    await manager.initializationPromise;
    const existing = manager.findLogins(ORIGIN, null, apiSecretScope(profile)).find((login: any) => login.username === profile.id);
    const login = host.Components.classes['@mozilla.org/login-manager/loginInfo;1'].createInstance(host.Components.interfaces.nsILoginInfo);
    login.init(ORIGIN, null, apiSecretScope(profile), profile.id, key.trim(), '', '');
    if (existing) { manager.modifyLogin(existing, login); }
    else { await manager.addLoginAsync(login); }
  } catch { throw new Error('SECRET_STORE_UNAVAILABLE'); }
}
export async function forgetApiKey(profile: ApiProfile, host: any): Promise<void> {
  try {
    const manager = logins(host);
    await manager.initializationPromise;
    const owned = manager.searchLoginsAsync ? await manager.searchLoginsAsync({ origin: ORIGIN }) : manager.findLogins(ORIGIN, null, apiSecretScope(profile));
    for (const login of owned) {
      if (login.username === profile.id && login.httpRealm?.startsWith('Orange Translate:' + profile.id + ':')) { manager.removeLogin(login); }
    }
  } catch { throw new Error('SECRET_STORE_UNAVAILABLE'); }
}

async function apiRequest(profile: ApiProfile, key: string, path: string, host: any, body?: any): Promise<any> {
  const controller = new host.win.AbortController();
  const timer = host.win.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await host.win.fetch(profile.baseUrl + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, credentials: 'omit', redirect: 'error' });
    if (!response.ok) { throw new Error('HTTP_' + response.status); }
    const raw = await response.text();
    if (raw.length > 2_000_000) { throw new Error('INVALID_API_RESPONSE'); }
    try { return JSON.parse(raw); } catch { throw new Error('INVALID_API_RESPONSE'); }
  } catch (error: any) {
    const code = String(error?.message || '');
    throw new Error(/^(HTTP_\d{3}|INVALID_API_RESPONSE)$/.test(code) ? code : 'API_CONNECTION_FAILED');
  } finally { host.win.clearTimeout(timer); }
}
export async function fetchApiModels(profile: ApiProfile, key: string, host: any): Promise<string[]> {
  const value = await apiRequest(profile, key, '/models', host);
  if (!Array.isArray(value.data)) { throw new Error('MODELS_UNAVAILABLE'); }
  return [...new Set(value.data.map((model: any) => model?.id).filter((id: any) => typeof id === 'string' && id.trim() && id.length <= 200))].slice(0, 500).sort() as string[];
}
export async function testApiConnection(profile: ApiProfile, key: string, host: any): Promise<void> {
  const value = await apiRequest(profile, key, profile.protocol === 'responses' ? '/responses' : '/chat/completions', host,
    profile.protocol === 'responses' ? { model: profile.model, input: 'Reply with OK.', stream: false }
      : { model: profile.model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false });
  const output = profile.protocol === 'responses'
    ? (value.output_text || value.output?.filter((item: any) => item.type === 'message').flatMap((item: any) => item.content || []).filter((item: any) => item.type === 'output_text').map((item: any) => item.text).join(''))
    : value.choices?.[0]?.message?.content;
  if (typeof output !== 'string' || !output.trim() || (profile.protocol === 'responses' && value.status && value.status !== 'completed')) { throw new Error('INVALID_API_RESPONSE'); }
}

export function registerApiPane(host: any, pluginID: string): Promise<string | null> {
  if (!host.Zotero.PreferencePanes) { return Promise.resolve(null); }
  if (host.Zotero.PreferencePanes.pluginPanes?.some((pane: any) => pane.id === API_PANE_ID)) { return Promise.resolve(API_PANE_ID); }
  return host.Zotero.PreferencePanes.register({ pluginID, id: API_PANE_ID, label: 'Orange Translate', src: 'api-prefs.xhtml', scripts: ['lifecycle.js', 'api-prefs.js'] });
}

export function mountProviderSettings(host: any): void {
  const { win, root } = host;
  const doc = win.document;
  const html = (tag: string, text = '') => { const el = doc.createElementNS('http://www.w3.org/1999/xhtml', tag); el.textContent = text; return el; };
  root.replaceChildren();
  const body = html('section'); body.style.cssText = 'max-width:760px;padding:12px;font:14px sans-serif;';
  body.append(html('h2', 'API 与模型'));
  body.append(html('p', '选择服务商，填写接口地址和 Key，再选择模型。支持 OpenAI Chat Completions 和 Responses 兼容接口。'));
  const notice = html('p'); notice.setAttribute('role', 'status'); notice.style.cssText = 'white-space:pre-line;';
  let settings: ApiSettings;
  try { settings = readApiSettings(host); }
  catch { body.append(html('p', '配置无法读取。请检查 Orange Translate 的 apiProfiles 偏好。')); root.append(body); return; }
  const field = (label: string, tag = 'input', type = 'text') => {
    const wrapper = html('label', label); wrapper.style.cssText = 'display:block;margin:10px 0;';
    const control = html(tag); control.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px;';
    if (tag === 'input') { control.type = type; }
    wrapper.append(control); body.append(wrapper); return control;
  };
  const option = (select: any, value: string, label: string) => { const el = html('option', label); el.value = value; select.append(el); };
  const workers = field('翻译线程数（每个线程池，1–64）', 'input', 'number');
  workers.min = '1'; workers.max = '64'; workers.step = '1';
  try { workers.value = String(readPoolMaxWorkers(host)); } catch { workers.value = '16'; }
  body.append(html('p', '默认 16，所有服务商共用；保存后从下一次翻译生效。请求启动速率仍为每秒 4 次。'));
  const profileSelect = field('服务商', 'select');
  const name = field('名称');
  const protocol = field('协议', 'select'); option(protocol, 'responses', 'OpenAI Responses'); option(protocol, 'chat', 'OpenAI Chat Completions');
  const baseUrl = field('Base URL（也可以粘贴完整接口地址）');
  baseUrl.placeholder = 'https://api.example.com/v1 或完整接口地址';
  const key = field('API Key（由 Zotero 内置密码管理器保存；留空保留已存 Key）', 'input', 'password');
  key.autocomplete = 'new-password';
  const model = field('当前模型 ID');
  const modelList = html('datalist'); modelList.id = 'orange-translate-model-options'; model.setAttribute('list', modelList.id); body.append(modelList);
  const models = field('模型列表（每行一个，也可拉取后从上面的输入框选择）', 'textarea'); models.rows = 4;
  let selected = settings.activeId;
  const formProfile = (requireModel = true) => normalizeProfile({ id: selected, name: name.value, protocol: protocol.value, baseUrl: baseUrl.value,
    model: model.value || (requireModel ? '' : '__models_lookup__'), models: models.value.split(/\r?\n/) }, win.URL);
  const render = () => {
    profileSelect.replaceChildren();
    for (const profile of settings.profiles) { option(profileSelect, profile.id, profile.name + (profile.id === settings.activeId ? '（当前使用）' : '')); }
    profileSelect.value = selected;
    const profile = settings.profiles.find(p => p.id === selected)!;
    name.value = profile.name; protocol.value = profile.protocol; baseUrl.value = profile.baseUrl; model.value = profile.model;
    models.value = profile.models.join('\n'); key.value = ''; modelList.replaceChildren();
    for (const id of profile.models) { option(modelList, id, id); }
  };
  profileSelect.addEventListener('change', () => { selected = profileSelect.value; render(); notice.textContent = ''; });
  const actions = html('div'); actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;'; body.append(actions);
  let busy = false;
  const errors: Record<string, string> = { SECRET_STORE_UNAVAILABLE: 'Zotero 密码存储暂不可用，未把 Key 写入普通配置。', INVALID_API_KEY: '请填写有效 Key。',
    INVALID_WORKER_COUNT: '线程数必须是 1 到 64 的整数。',
    INVALID_PROFILE: '请填写名称、接口地址及模型 ID。', INVALID_ENDPOINT: '接口需要 HTTPS；本机服务可使用 localhost 的 HTTP。', CREDENTIAL_IN_URL: '接口地址不能包含账号、密码、查询参数或片段。',
    HTTP_401: '认证失败，请检查 API Key。', HTTP_403: '该 Key 没有访问权限。', HTTP_404: '接口或模型不存在；不支持拉取模型时可手填模型 ID。', HTTP_429: '接口限流，请稍后重试。',
    MODELS_UNAVAILABLE: '此接口未提供标准模型列表，请手动填写模型 ID。', INVALID_API_RESPONSE: '接口未返回预期格式，请检查协议和模型。', API_CONNECTION_FAILED: '连接失败或超时，请检查地址和网络。' };
  const button = (label: string, action: () => any) => {
    const el = html('button', label); el.type = 'button';
    el.addEventListener('click', async () => {
      if (busy) { return; }
      busy = true;
      for (const control of body.querySelectorAll('button,input,select,textarea')) { control.disabled = true; }
      try { await action(); } catch (error: any) { notice.textContent = errors[String(error?.message)] || '操作未完成，请检查配置。'; }
      finally { busy = false; for (const control of body.querySelectorAll('button,input,select,textarea')) { control.disabled = false; } }
    }); actions.append(el);
  };
  const credential = async (profile: ApiProfile) => { const value = key.value.trim() || await readApiKey(profile, host); if (!value) { throw new Error('INVALID_API_KEY'); } return value; };
  button('保存线程数', () => {
    savePoolMaxWorkers(Number(workers.value), host);
    notice.textContent = '线程数已保存为 ' + workers.value + '，下一次翻译生效。';
  });
  button('保存并设为当前', async () => {
    const profile = formProfile();
    if (key.value.trim()) { await saveApiKey(profile, key.value, host); }
    const updated = { ...settings, activeId: profile.id, profiles: settings.profiles.filter(p => p.id === profile.id || p.model.trim()).map(p => p.id === profile.id ? profile : p) };
    saveApiSettings(updated, host); settings = updated; render(); notice.textContent = '已保存，下一次翻译使用此服务商与模型。';
  });
  button('拉取模型', async () => {
    const profile = formProfile(false); notice.textContent = '正在读取模型列表…';
    const ids = await fetchApiModels(profile, await credential(profile), host);
    models.value = ids.join('\n'); modelList.replaceChildren(); for (const id of ids) { option(modelList, id, id); }
    notice.textContent = '已读取 ' + ids.length + ' 个模型，请选择后保存。';
  });
  button('测试连接（短请求，可能计费）', async () => {
    const profile = formProfile(); notice.textContent = '正在发送短请求…';
    await testApiConnection(profile, await credential(profile), host); notice.textContent = '接口与所选模型的短请求成功。';
  });
  button('删除此服务商', async () => {
    const profiles = settings.profiles.filter(p => p.id !== selected && p.model.trim() && p.baseUrl.trim());
    if (!profiles.length) { notice.textContent = '请至少保留一个已配置的服务商。'; return; }
    const old = settings.profiles.find(p => p.id === selected)!;
    if (!host.Services.prompt.confirm(win, 'Orange Translate', '删除服务商“' + old.name + '”及其已存 Key？')) { return; }
    await forgetApiKey(old, host);
    settings = { schemaVersion: 1, activeId: settings.activeId === selected ? profiles[0].id : settings.activeId, profiles };
    saveApiSettings(settings, host); selected = settings.activeId; render(); notice.textContent = '已删除。';
  });
  for (const preset of [DEFAULT_API_PROFILE, { ...DEFAULT_API_PROFILE, name: 'DeepSeek 官方', protocol: 'chat', baseUrl: 'https://api.deepseek.com/v1', model: '', models: [] },
    { ...DEFAULT_API_PROFILE, name: '自定义兼容接口', protocol: 'chat', baseUrl: '', model: '', models: [] }]) {
    button('新增 ' + preset.name, () => {
      if (settings.profiles.length >= 20) { notice.textContent = '最多保存 20 个服务商。'; return; }
      selected = host.Services.uuid.generateUUID().toString().replace(/[{}]/g, '');
      settings.profiles.push({ ...preset, protocol: preset.protocol as ApiProtocol, id: selected, models: [...preset.models] }); render();
      notice.textContent = '填写配置后点击保存。';
    });
  }
  body.append(notice); root.append(body); render();
}
