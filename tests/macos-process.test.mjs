import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startMacProcess } from '../src/zotero/macos-process.ts';

test('macOS supervisor forwards stdin and cancels the owned process group', {
  skip: process.platform !== 'darwin', timeout: 7000,
}, async t => {
  let sentinelClosed = false;
  const handle = await startMacProcess({
    async call({ command, arguments: args }) {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      child.stdio[3].once('end', () => { sentinelClosed = true; }).resume();
      const complete = once(child, 'close').then(([exitCode]) => ({ exitCode }));
      t.after(() => { if (child.exitCode === null && child.signalCode === null) { child.kill(); } });
      return {
        pid: child.pid, stdout: child.stdout, stdin: child.stdin,
        get exitCode() { return child.exitCode; },
        wait: () => complete,
        kill(timeout) { assert.equal(timeout, 5000); child.kill('SIGTERM'); return complete; },
      };
    },
  }, {
    command: '/bin/bash', arguments: ['-c', `
      IFS= read -r token
      [ "$token" = 'test-only frame' ] || exit 2
      /bin/sleep 30 &
      descendant=$!
      trap 'wait "$descendant" 2>/dev/null; exit 143' TERM
      printf '%s\n' "$descendant"
      wait "$descendant"
    `],
  });
  const ready = once(handle.stdout, 'data');
  handle.stdin.end('test-only frame\n');
  const [chunk] = await ready;
  const descendant = Number(chunk.toString().trim());
  assert.ok(Number.isInteger(descendant) && descendant > 0);
  await delay(25);
  assert.equal(sentinelClosed, false);
  assert.equal((await handle.kill(0)).exitCode, 143);
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
});
