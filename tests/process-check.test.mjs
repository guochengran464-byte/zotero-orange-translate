import assert from 'node:assert/strict';
import test from 'node:test';
import { checkLocalProcess, createHostClock } from '../src/zotero/subprocess-host.ts';

function pipe(text) {
  const chunks = [text, ''];
  return { readString: async () => chunks.shift() || '' };
}

test('process check requires the expected marker and a successful exit', async () => {
  const clock = createHostClock({ setTimeout, clearTimeout });
  for (const [exitCode, output, ok] of [[0, 'ORANGE_PROCESS_READY', true],
    [1, 'ORANGE_PROCESS_READY', false], [0, 'wrong', false]]) {
    const module = { call: async () => ({ pid: 123, exitCode,
      stdout: pipe(output), stderr: pipe(''), kill() {},
      wait: async () => ({ exitCode }),
    }) };
    const result = checkLocalProcess(module, 'C:/Windows/powershell.exe', clock);
    if (ok) { assert.equal(await result, 123); }
    else { await assert.rejects(result, /LOCAL_PROCESS_CHECK_FAILED/); }
  }
});

test('timeout stops the owned process and clears its timer', async () => {
  let expire, finish, killed = false, cleared = false;
  const exit = new Promise(resolve => { finish = resolve; });
  const clock = { now: Date.now, setTimeout(fn) { expire = fn; return 1; },
    clearTimeout() { cleared = true; } };
  const module = { call: async () => ({ pid: 123, exitCode: null,
    stdout: pipe('ORANGE_PROCESS_READY'), stderr: pipe(''),
    wait: () => exit, kill(ms) { assert.equal(ms, 0); killed = true; finish({ exitCode: -9 }); },
  }) };
  const result = checkLocalProcess(module, 'C:/Windows/powershell.exe', clock);
  const failure = assert.rejects(result, /LOCAL_PROCESS_TIMEOUT/);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expire();
  await failure;
  assert.equal(killed, true);
  assert.equal(cleared, true);
});
