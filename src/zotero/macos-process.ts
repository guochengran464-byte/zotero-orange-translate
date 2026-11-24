import type { ZoteroPipeProcess, ZoteroSubprocessModule } from './subprocess-host.ts';

// Bash monitor mode puts the job in its own process group. Gecko signals only
// the supervisor on macOS, so forward cancellation to the whole group.
// Keep Gecko's inherited fd 3 open as its process-exit sentinel.
const SUPERVISOR = String.raw`set -m || exit 125
child=
cancelled=0
stop() {
  cancelled=1
  [ -n "$child" ] || return 0
  trap '' TERM INT HUP
  kill -TERM -- "-$child" 2>/dev/null || :
  /bin/sleep 0.25
  kill -KILL -- "-$child" 2>/dev/null || :
  wait "$child" 2>/dev/null || :
  exit 143
}
trap stop TERM INT HUP
"$@" <&0 &
child=$!
[ "$cancelled" = 0 ] || stop
wait "$child"
`;

type LaunchOptions = Parameters<ZoteroSubprocessModule['call']>[0] & {
  environment?: Record<string, string | null>;
  environmentAppend?: boolean;
};

export async function startMacProcess(subprocess: ZoteroSubprocessModule, options: LaunchOptions): Promise<ZoteroPipeProcess> {
  const process = await subprocess.call({
    ...options,
    command: '/bin/bash',
    arguments: ['-c', SUPERVISOR, 'orange-translate', options.command, ...options.arguments],
  });
  return {
    get pid() { return process.pid; },
    get exitCode() { return process.exitCode; },
    get stdin() { return process.stdin; },
    get stdout() { return process.stdout; },
    get stderr() { return process.stderr; },
    wait: () => process.wait(),
    // Give the supervisor time to stop and reap its job before Gecko escalates.
    kill: () => process.kill(5000),
  };
}
