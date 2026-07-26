import { rename, writeFile } from 'node:fs/promises';

const identityPath = process.argv[2];
const marker = process.argv[3];
if (!identityPath || !marker) {
  throw new Error('usage: detached-cli.mjs <identity-path> <marker>');
}

const selfStartTicks = process.hrtime.bigint().toString();
const identity = {
  pid: process.pid,
  parentPid: process.ppid,
  selfStartTicks,
  selfStartTickClock: 'node-monotonic-nanoseconds',
  marker,
};
const temporaryIdentityPath = `${identityPath}.${process.pid}.tmp`;
await writeFile(temporaryIdentityPath, `${JSON.stringify(identity)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});
await rename(temporaryIdentityPath, identityPath);

process.stdout.write(
  [
    '\u001b[?1049h',
    '\u001b[2J\u001b[H',
    `CAP_ROLLBACK_TASK=${marker}`,
    `\r\nCLI_PID=${process.pid}`,
    `\r\nCLI_START_TICKS=${selfStartTicks}`,
    '\r\nDETACHED_TASK_STILL_RUNNING',
  ].join(''),
);

process.stdin.resume();
process.stdin.on('data', () => undefined);
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdout.write('\u001b[?1049l');
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

// The shell starts this fixture as a child so pane PID and CLI PID remain
// distinct. A background job can inherit /dev/null for stdin; keep one ref'ed
// timer so that stdin EOF cannot make the detached task disappear early.
setInterval(() => undefined, 60_000);
