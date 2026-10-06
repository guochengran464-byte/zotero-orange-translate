import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_API_PROFILE, normalizeProfile, readApiSettings, saveApiSettings, saveApiKey, readApiKey, forgetApiKey,
  fetchApiModels, testApiConnection, readPoolMaxWorkers, savePoolMaxWorkers } from '../src/zotero/provider-settings.ts';

test('settings pane initializes from captured native load without inline handlers', () => {
  const script = readFileSync(new URL('../api-prefs.js', import.meta.url), 'utf8');
  for (const fail of [false, true]) {
    let listener, mounted, removed = false;
    const root = { id: 'orange-translate-api-settings', replaceChildren(message) { this.message = message; } };
    const win = { document: { createElementNS: () => ({}),
      addEventListener(type, handler, capture, wantsUntrusted) { assert.equal(type, 'load'); assert.equal(capture, true); assert.equal(wantsUntrusted, true); listener = handler; },
      removeEventListener(type, handler, capture) { assert.equal(handler, listener); assert.equal(capture, true); removed = true; } },
      addEventListener() { assert.fail('element load cannot reach window'); } };
    vm.runInNewContext(script, { window: win, Services: {}, Components: {}, Zotero: { logError() {} },
      OrangeTranslateLifecycle: { mountProviderSettings(host) { if (fail) { throw new Error('failure'); } mounted = host; } } });
    listener({ target: { id: 'another-pane' } }); assert.equal(removed, false);
    listener({ target: root }); assert.equal(removed, true);
    if (fail) { assert.match(root.message.textContent, /设置页加载失败/); }
    else { assert.equal(mounted.root, root); assert.equal(mounted.win, win); }
  }
});

test('API profiles normalize full endpoints and keep credentials scoped in the native login manager', async () => {
  const prefs = new Map(); const logins = [];
  const host = { win: { URL }, Services: { prefs: { getStringPref: (name, fallback) => prefs.get(name) ?? fallback,
    setStringPref: (name, value) => prefs.set(name, value),
    getIntPref: (name, fallback) => prefs.get(name) ?? fallback,
    setIntPref: (name, value) => prefs.set(name, value) }, logins: {
    findLogins: (origin, _form, realm) => logins.filter(login => login.origin === origin && login.httpRealm === realm),
    searchLoginsAsync: async ({ origin }) => logins.filter(login => login.origin === origin),
    addLoginAsync: async login => logins.push(login), modifyLogin: (old, login) => Object.assign(old, login),
    removeLogin: login => logins.splice(logins.indexOf(login), 1),
  } }, Components: { interfaces: {}, classes: { '@mozilla.org/login-manager/loginInfo;1': { createInstance: () => ({
    init(origin, formActionOrigin, httpRealm, username, password) { Object.assign(this, { origin, formActionOrigin, httpRealm, username, password }); },
  }) } } } };
  const profile = normalizeProfile({ ...DEFAULT_API_PROFILE, baseUrl: DEFAULT_API_PROFILE.baseUrl + '/responses', apiKey: 'TEST-ONLY-KEY' }, URL);
  assert.equal(profile.baseUrl, DEFAULT_API_PROFILE.baseUrl);
  assert.equal(normalizeProfile({ ...profile, baseUrl: 'https://example.com/v1/chat/completions' }, URL).protocol, 'chat');
  for (const baseUrl of ['https://user:secret@example.com/v1', 'https://example.com/v1?api_key=secret', 'http://example.com/v1']) {
    assert.throws(() => normalizeProfile({ ...profile, baseUrl }, URL));
  }
  const settings = { schemaVersion: 1, activeId: profile.id, profiles: [profile] };
  assert.equal(readPoolMaxWorkers(host), 16);
  for (const count of [1, 16, 64]) { savePoolMaxWorkers(count, host); assert.equal(readPoolMaxWorkers(host), count); }
  for (const count of [0, 65, 1.5, NaN]) { assert.throws(() => savePoolMaxWorkers(count, host), /INVALID_WORKER_COUNT/); }
  saveApiSettings(settings, host);
  await saveApiKey(profile, 'TEST-ONLY-KEY', host);
  assert.deepEqual(readApiSettings(host), settings);
  assert.equal([...prefs.values()].join('').includes('TEST-ONLY-KEY'), false);
  assert.equal(await readApiKey(profile, host), 'TEST-ONLY-KEY');
  assert.equal(await readApiKey({ ...profile, baseUrl: 'https://other.example/v1' }, host), '');
  await saveApiKey(profile, 'TEST-ONLY-NEW-KEY', host);
  assert.equal(logins.length, 1);
  await forgetApiKey(profile, host);
  assert.equal(await readApiKey(profile, host), '');
});

test('model fetch and short connection checks use the selected protocol and redact failures', async () => {
  const calls = [];
  let response = { data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] };
  let status = 200;
  const host = { win: { AbortController, setTimeout, clearTimeout, fetch: async (url, options) => {
    calls.push({ url, options }); return { ok: status === 200, status, text: async () => JSON.stringify(response) };
  } } };
  assert.deepEqual(await fetchApiModels(DEFAULT_API_PROFILE, 'TEST-ONLY-KEY', host), ['model-a', 'model-b']);
  assert.ok(calls[0].url.endsWith('/models'));
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  response = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] };
  await testApiConnection(DEFAULT_API_PROFILE, 'TEST-ONLY-KEY', host);
  assert.ok(calls[1].url.endsWith('/responses'));
  assert.equal(JSON.parse(calls[1].options.body).model, DEFAULT_API_PROFILE.model);
  response = { choices: [{ message: { content: 'OK' } }] };
  await testApiConnection({ ...DEFAULT_API_PROFILE, protocol: 'chat' }, 'TEST-ONLY-KEY', host);
  assert.ok(calls[2].url.endsWith('/chat/completions'));
  assert.equal(JSON.parse(calls[2].options.body).messages[0].role, 'user');
  status = 401;
  await assert.rejects(testApiConnection(DEFAULT_API_PROFILE, 'TEST-ONLY-KEY', host), /^Error: HTTP_401$/);
});
