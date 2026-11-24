import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('relay preserves ordering, scope, results and state across listener restarts', { timeout: 65000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gpt-workbench-test-'));
  let listener;
  async function stop() {
    if (!listener || listener.exitCode !== null || listener.signalCode !== null) return;
    const exited = once(listener, 'exit');
    listener.stdin.end();
    await exited;
  }
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  for (const filename of ['workbench.mjs', 'codex.mjs', 'network.mjs', 'workbuddy-recovery.mjs', 'ima-handoff.mjs',
    'chat-context.mjs', 'conversations.mjs', 'qwenwork-mcp.mjs', 'tests']) {
    await cp(join(root, filename), join(dir, filename), { recursive: true });
  }
  const data = join(dir, 'data');
  await mkdir(data);
  const env = { ...process.env, GPT_WORKBENCH_DATA: data, GPT_WORKBENCH_CODEX: process.execPath };
  const settings = { taskTimeoutMinutes: 10, networkRetrySeconds: 1, clash: {}, workbuddy: {} };
  await writeFile(join(dir, 'config.json'), JSON.stringify(settings));
  const entry = join(dir, 'workbench.mjs');
  const cli = async (...args) => JSON.parse((await exec(process.execPath, [entry, ...args], { env, cwd: dir })).stdout);
  const scope = ['--source', 'workbuddy', '--scope', 'test-account', '--conversation', 'chat-a'];
  const relay = async (message, event, flags = [], target = scope) => {
    const file = join(dir, event + '.txt');
    await writeFile(file, message);
    return cli('relay', ...target, '--event', event, '--prompt-file', file, ...flags);
  };
  async function wait(id, state) {
    for (let i = 0; i < 100; i += 1) {
      const status = await cli('status', '--id', id);
      if (status.state === state) return status;
      if (['completed', 'failed', 'interrupted'].includes(status.state)) assert.equal(status.state, state, status.error);
      await sleep(75);
    }
    assert.fail('state timed out: ' + state);
  }
  async function start() {
    listener = spawn(process.execPath, ['--import', pathToFileURL(join(dir, 'tests', 'fake-services.mjs')).href, entry, 'serve'], {
      env: { ...env, GPT_WORKBENCH_WATCHDOG_ID: 'fixture' }, stdio: ['pipe', 'pipe', 'inherit'], cwd: dir,
    });
    await Promise.race([once(listener.stdout, 'data'), once(listener, 'exit').then(([code]) => {
      throw new Error('监听器提前退出 ' + code);
    })]);
  }
  await assert.rejects(relay('unbound', 'event-unbound'), /尚未接管/);
  const first = await relay('first', 'event-1', ['--takeover']);
  const second = await relay('ordinary follow-up', 'event-2');
  assert.equal((await cli('conversation-status', ...scope)).state, 'pending');
  assert.equal((await cli('status', '--id', second.id)).state, 'submitted');
  const copies = await Promise.all([cli('relay', ...scope, '--event', 'event-2'), cli('relay', ...scope, '--event', 'event-2')]);
  assert.ok(copies.every((item) => item.id === second.id && item.duplicate));
  const other = await relay('separate', 'event-3', ['--takeover'],
    ['--source', 'workbuddy', '--scope', 'test-account', '--conversation', 'chat-b']);
  const otherAccount = await relay('other account', 'event-4', ['--takeover'],
    ['--source', 'workbuddy', '--scope', 'test-account-b', '--conversation', 'chat-a']);
  await start();
  const a = await wait(first.id, 'completed');
  const b = await wait(second.id, 'completed');
  assert.equal(a.threadId, b.threadId);
  assert.equal(JSON.parse(b.text).prior, 'first\n');
  assert.equal(await readFile(b.artifacts[0], 'utf8'), b.text);
  assert.notEqual((await wait(other.id, 'completed')).threadId, a.threadId);
  assert.notEqual((await wait(otherAccount.id, 'completed')).threadId, a.threadId);
  assert.equal((await cli('delivery-report', '--id', second.id, '--source', 'workbuddy', '--state', 'submitted')).delivery.state, 'submitted');
  await stop();
  const third = await relay('after restart', 'event-5');
  await start();
  assert.equal((await wait(third.id, 'completed')).threadId, a.threadId);
  const errored = await relay('fail', 'event-6');
  await wait(errored.id, 'failed');
  assert.equal((await cli('follow', '--id', errored.id, '--seconds', '1')).error, 'fixture failure');
  await writeFile(join(data, 'offline'), '');
  const recovered = await relay('after reconnect', 'event-7');
  await wait(recovered.id, 'waiting_network');
  await rm(join(data, 'offline'));
  assert.equal((await wait(recovered.id, 'completed')).threadId, a.threadId);
  const stalled = await relay('stall', 'event-8');
  await wait(stalled.id, 'running');
  await writeFile(join(data, 'clock-offset'), '300000');
  const timedOut = await wait(stalled.id, 'interrupted');
  assert.equal(timedOut.stopReason, 'stalled');
  assert.match(timedOut.error, /连续 300 秒/);
  await rm(join(data, 'clock-offset'));
  const uncertain = await relay('stall', 'event-9');
  await wait(uncertain.id, 'running');
  await stop();
  await start();
  const receipt = await wait(uncertain.id, 'interrupted');
  assert.match(receipt.error, /已尝试发送/);
  assert.equal(receipt.threadId, a.threadId);
  const later = await relay('after uncertain turn', 'event-10');
  const final = await wait(later.id, 'completed');
  assert.equal(final.threadId, a.threadId);
  assert.equal(JSON.parse(final.text).prior.match(/stall\n/g).length, 2);
  const health = JSON.parse(await readFile(join(data, 'listener-health.json'), 'utf8'));
  assert.equal(health.watchdogId, 'fixture');

  const mcp = spawn(process.execPath, [join(dir, 'qwenwork-mcp.mjs')], { env, cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => mcp.stdin.end());
  const lines = createInterface({ input: mcp.stdout });
  let requestId = 0;
  async function mcpTool(name, args) {
    const id = ++requestId;
    const result = once(lines, 'line');
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const [line] = await result;
    const response = JSON.parse(line);
    assert.equal(response.id, id);
    assert.equal(response.result.isError, undefined, response.result.content[0]?.text);
    return JSON.parse(response.result.content[0].text);
  }
  const qwen = { scope: 'test-account', conversation: 'chat-qwen' };
  const q1 = await mcpTool('submit_gpt_task', { ...qwen, event: 'q-1', prompt: 'q first', takeover: true });
  const q2 = await mcpTool('submit_gpt_task', { ...qwen, event: 'q-2', prompt: 'q follow-up' });
  const q1Result = await mcpTool('follow_gpt_task', { id: q1.id, seconds: 8 });
  const q2Result = await mcpTool('follow_gpt_task', { id: q2.id, seconds: 8 });
  assert.equal(q2Result.state, 'completed');
  assert.equal(q1Result.threadId, q2Result.threadId);
  assert.equal((await mcpTool('get_gpt_conversation', qwen)).threadId, q1Result.threadId);
  assert.equal(JSON.parse(q2Result.text).prior, 'q first\n');
  mcp.stdin.end();
});
