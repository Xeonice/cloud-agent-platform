import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runnerPath = join(root, 'scripts/scheduled-tasks-live-e2e.sh');
const runner = await readFile(runnerPath, 'utf8');
const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
const contributing = await readFile(join(root, 'CONTRIBUTING.md'), 'utf8');

test('scheduled-task runner is valid shell and allocates isolated resources', () => {
  const syntax = spawnSync('bash', ['-n', runnerPath], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(syntax.status, 0, syntax.stderr);

  assert.match(runner, /PG_CONTAINER="cap-schedule-e2e-pg-\$\{RUN_ID\}"/);
  assert.match(runner, /--publish "127\.0\.0\.1::5432"/);
  assert.match(runner, /\.NetworkSettings\.Ports "5432\/tcp"/);
  assert.match(runner, /E2E_API_PORT=0/);
  assert.match(runner, /E2E_CONTROL_PORT=0/);
  assert.match(runner, /CAP_SCHEDULE_E2E_READY/);
  assert.match(runner, /server\.listen\(\{ host: "127\.0\.0\.1", port: 0/);
  assert.doesNotMatch(runner, /free_port/);
  assert.doesNotMatch(runner, /(?:^|\s)(?:3000|5432|8080):(?:3000|5432|8080)(?:\s|$)/m);
});

test('API build and Prisma commands run without loading application env files', async () => {
  assert.equal((runner.match(/env -i \\/g) ?? []).length >= 6, true);
  assert.doesNotMatch(runner, /--env-file/);
  assert.match(runner, /E2E_EMPTY_ENV_DIR="\$EMPTY_ENV_DIR"/);
  assert.match(
    runner,
    /cp "\$ROOT_DIR\/apps\/api\/package\.json" "\$PRISMA_WORK_DIR\/package\.json"/,
  );
  assert.match(
    runner,
    /cp -R "\$ROOT_DIR\/apps\/api\/prisma" "\$PRISMA_WORK_DIR\/prisma"/,
  );
  assert.match(
    runner,
    /node "\$ROOT_DIR\/apps\/api\/node_modules\/prisma\/build\/index\.js"[\s\S]*?generate --schema "\$PRISMA_WORK_DIR\/prisma\/schema\.prisma"/,
  );
  assert.match(
    runner,
    /node "\$ROOT_DIR\/apps\/api\/node_modules\/prisma\/build\/index\.js"[\s\S]*?migrate deploy --schema "\$PRISMA_WORK_DIR\/prisma\/schema\.prisma"/,
  );
  assert.match(runner, /node node_modules\/@nestjs\/cli\/bin\/nest\.js build/);
  assert.doesNotMatch(runner, /turbo build --filter=@cap\/api/);
  assert.doesNotMatch(runner, /--filter @cap\/api exec prisma/);

  const apiPackage = JSON.parse(
    await readFile(join(root, 'apps/api/package.json'), 'utf8'),
  );
  assert.doesNotMatch(apiPackage.scripts['test:integration:schedules'], /env-file/);
});

test('cleanup is scoped to the invocation-owned processes and container', () => {
  assert.match(runner, /stop_process "\$WEB_PID"/);
  assert.match(runner, /stop_process "\$API_PID"/);
  assert.match(runner, /docker rm -f "\$PG_CONTAINER"/);
  assert.doesNotMatch(runner, /docker compose down|docker ps -aq|pkill|killall/);
  assert.match(runner, /KEEP_E2E_STACK/);
  assert.match(runner, /CALLER_DIR="\$\(pwd -P\)"/);
  assert.match(
    runner,
    /if \[\[ "\$ARTIFACT_ROOT_INPUT" == \/\* \]\]; then[\s\S]*?ARTIFACT_ROOT="\$ARTIFACT_ROOT_INPUT"[\s\S]*?ARTIFACT_ROOT="\$\{CALLER_DIR\}\/\$\{ARTIFACT_ROOT_INPUT\}"/,
  );
  assert.match(runner, /ARTIFACT_DIR="\$\{ARTIFACT_ROOT%\/\}\/\$\{RUN_ID\}"/);
  assert.match(runner, /\.cap-scheduled-tasks-e2e-owned/);
  assert.match(runner, /owns_artifact_dir/);
  assert.match(
    runner,
    /"\$\(cat "\$OWNERSHIP_MARKER" 2>\/dev\/null\)" == "\$RUN_ID"/,
  );
  assert.match(runner, /remove_owned_artifacts \|\| status=1/);
  assert.match(
    runner,
    /for \(\(attempt = 1; attempt <= 10; attempt \+= 1\)\); do[\s\S]*?rm -rf -- "\$ARTIFACT_DIR"[\s\S]*?\[\[ ! -e "\$ARTIFACT_DIR" \]\] && return 0/,
  );
  assert.doesNotMatch(
    runner,
    /\$\{(?:API_PID|WEB_PID|WEB_PORT_RESERVATION_PID):-0\}|kill 0/,
  );
});

test('retained stack reports real Node process IDs and sanitizes artifacts', () => {
  assert.match(
    runner,
    /nohup env -i \\\n[\s\S]*?node test\/scheduled-tasks-live-e2e-server\.mjs[\s\S]*?<\/dev\/null &[\s\S]*?API_PID=\$![\s\S]*?disown "\$API_PID"/,
  );
  assert.match(
    runner,
    /nohup env -i \\\n[\s\S]*?node node_modules\/vite\/bin\/vite\.js[\s\S]*?<\/dev\/null &[\s\S]*?WEB_PID=\$![\s\S]*?disown "\$WEB_PID"/,
  );
  assert.match(runner, /require_command nohup/);
  assert.doesNotMatch(
    runner,
    /\) >"\$(?:API|WEB)_LOG" 2>&1 &/,
  );
  assert.doesNotMatch(runner, /pnpm exec vite/);
  assert.match(
    runner,
    /node "\$ROOT_DIR\/scripts\/sanitize-scheduled-tasks-e2e-artifacts\.mjs" "\$ARTIFACT_DIR"/,
  );
  assert.match(
    runner,
    /discard_sensitive_artifacts\(\)[\s\S]*?"\$ARTIFACT_DIR\/playwright"[\s\S]*?"\$API_LOG"[\s\S]*?"\$WEB_LOG"[\s\S]*?"\$DIAGNOSTICS_FILE"/,
  );
  assert.match(
    runner,
    /freeze_retained_stack_logs\(\)[\s\S]*?freeze_live_log "\$API_LOG"[\s\S]*?freeze_live_log "\$WEB_LOG"/,
  );
  assert.match(runner, /collect_failure_evidence \|\| true/);
  assert.match(
    runner,
    /if \[\[ "\$\{KEEP_E2E_STACK:-0\}" == 1 \]\]; then[\s\S]*?freeze_retained_stack_logs[\s\S]*?finalize_retained_evidence[\s\S]*?exit "\$status"/,
  );
  assert.match(
    runner,
    /stop_process "\$WEB_PID"[\s\S]*?stop_process "\$API_PID"[\s\S]*?finalize_retained_evidence/,
  );
});

test('CI bounds the live run and always sanitizes before artifact upload', () => {
  assert.match(
    ci,
    /- name: Scheduled tasks live E2E[\s\S]*?timeout-minutes: 10[\s\S]*?run: pnpm test:e2e:schedules:local/,
  );
  assert.match(
    ci,
    /- name: Sanitize scheduled-task E2E evidence[\s\S]*?if: always\(\)[\s\S]*?sanitize-scheduled-tasks-e2e-artifacts\.mjs/,
  );
  assert.match(
    ci,
    /- name: Upload scheduled-task evidence[\s\S]*?if: always\(\)[\s\S]*?actions\/upload-artifact@v4/,
  );
  assert.match(contributing, /artifact root/);
  assert.match(contributing, /ownership marker/);
});

test('time control stays under apps/api/test and out of the production graph', async () => {
  const productionFiles = await listFiles(join(root, 'apps/api/src'));
  const forbidden = [
    'scheduled-tasks-live-e2e-server',
    '/control/schedules/',
    '/control/diagnostics',
    '/control/provider-calls',
  ];

  for (const file of productionFiles.filter((path) => path.endsWith('.ts'))) {
    const source = await readFile(file, 'utf8');
    for (const marker of forbidden) {
      assert.equal(
        source.includes(marker),
        false,
        `${relative(root, file)} must not contain test-control marker ${marker}`,
      );
    }
  }

  assert.match(
    runner,
    /node test\/scheduled-tasks-live-e2e-server\.mjs/,
    'the control server must be started only from the test tree',
  );
});

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );
  return nested.flat();
}
