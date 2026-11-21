import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('./clash-recovery.mjs', import.meta.url));
const shellArg = (value) => {
  if (/["%!\r\n]/.test(value)) throw new Error('WorkBuddy 本地任务路径包含 CMD 保留字符');
  return '"' + value + '"';
};

export class WorkBuddyRecovery {
  constructor(config, directory) {
    this.config = config;
    this.directory = directory;
  }

  async ensureDesktop() {
    const running = async () => {
      const { stdout } = await exec('tasklist.exe', ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 4500 });
      return /^"WorkBuddy\.exe",/im.test(stdout);
    };
    if (await running()) return false;
    const desktop = spawn(this.config.exe, [], { windowsHide: true, detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      desktop.once('spawn', resolve);
      desktop.once('error', reject);
    });
    desktop.unref();
    for (let i = 0; i < 8; i += 1) {
      if (await running()) return true;
      await sleep(450);
    }
    throw new Error('WorkBuddy 桌面进程未启动');
  }

  async dispatch(mode) {
    const desktopStarted = await this.ensureDesktop();
    await mkdir(this.directory, { recursive: true });
    const password = randomBytes(32).toString('hex');
    const env = { ...process.env };
    for (const name of ['CODEBUDDY_GATEWAY_BASE_PATH', 'CODEBUDDY_GATEWAY_FORCE_TUNNEL',
      'CODEBUDDY_DISABLE_REQUEST_VALIDATION', 'CODEBUDDY_ENV_FILE', 'CODEBUDDY_CODE_SHELL_PREFIX']) {
      delete env[name];
    }
    Object.assign(env, {
      CODEBUDDY_CONFIG_DIR: this.directory, CODEBUDDY_GATEWAY_AUTH: 'password',
      CODEBUDDY_GATEWAY_PASSWORD: password, SERVER__HOST: '127.0.0.1', SERVER__PORT: '0',
      CODEBUDDY_CODE_GIT_BASH_PATH: this.config.gitBash,
      PATH: dirname(process.execPath) + ';' + (process.env.PATH ?? ''),
    });
    const child = spawn(process.execPath, [
      this.config.cli, '--serve', '--host', '127.0.0.1', '--auth', 'password',
      '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk',
    ], { cwd: this.directory, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const output = join(this.directory, 'clash-result-' + randomUUID() + '.json');
    let base;
    let jobId;
    let done = false;

    const api = async (path, body, timeout = 3500) => {
      const response = await fetch(base + '/api/v1/' + path, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + password, 'X-CodeBuddy-Request': '1',
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
      });
      const result = await response.json();
      if (!response.ok) throw new Error('WorkBuddy 本地任务接口返回 HTTP ' + response.status +
        (result.error?.code ? ' ' + result.error.code : ''));
      return result.data;
    };

    try {
      base = await new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('WorkBuddy 本地任务接口启动超时')), 17000);
        const finish = (error, endpoint) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(endpoint);
        };
        child.once('error', (error) => finish(error));
        child.once('exit', () => finish(new Error('WorkBuddy 本地任务接口已退出')));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buffer = (buffer + chunk).slice(-10000);
          const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d{1,5})(?=[/\s]|$)/);
          if (match && Number(match[1]) > 0) finish(null, 'http://127.0.0.1:' + match[1]);
        });
      });
      // A shell job runs this fixed command locally without submitting a model prompt.
      const prompt = 'node.exe ' + [runner, mode, output].map(shellArg).join(' ');
      const accepted = await api('jobs', {
        name: mode === 'check' ? 'GPT 工作台代理检查' : 'GPT 工作台代理恢复',
        prompt, cwd: this.directory, bash: true, bgIsolation: 'none',
      }, 7000);
      jobId = accepted?.id ?? accepted?.job?.id;
      if (!jobId) throw new Error('WorkBuddy 没有返回本地任务 ID');
      const deadline = Date.now() + 65000;
      let lastState;
      while (Date.now() < deadline) {
        const state = await api('jobs/' + encodeURIComponent(jobId));
        const detail = state?.job ?? state;
        lastState = detail?.state ?? detail?.status;
        try {
          const result = JSON.parse(await readFile(output, 'utf8'));
          done = true;
          if (result.error) throw new Error(result.error);
          return { ...result, executor: 'workbuddy-local', jobId, desktopStarted };
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (detail?.settled || ['done', 'failed', 'stopped', 'completed'].includes(lastState)) {
          done = true;
          throw new Error('WorkBuddy 本地任务结束但未生成代理检查结果（' + lastState + '）');
        }
        await sleep(350);
      }
      throw new Error('WorkBuddy 代理任务超时（' + (lastState ?? '状态未知') + '）');
    } catch (error) {
      return { error: String(error.message ?? error).slice(0, 500),
        executor: 'workbuddy-local', jobId, desktopStarted };
    } finally {
      if (jobId && !done) await api('jobs/' + encodeURIComponent(jobId) + '/stop', {}).catch(() => {});
      child.kill();
      await Promise.all([rm(output, { force: true }), rm(output + '.tmp', { force: true })]);
    }
  }
}
