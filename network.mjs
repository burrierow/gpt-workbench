import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class Clash {
  constructor(config) {
    this.config = config;
  }

  async loadProfile() {
    const { profile } = this.config;
    const yaml = await readFile(profile, 'utf8');
    const scalar = (key) => {
      const value = yaml.match(new RegExp('^' + key + ': *(.*)$', 'm'))?.[1].trim() ?? '';
      return value.replace(/^(['"])(.*)\1$/, '$2');
    };
    const secret = scalar('secret');
    const address = scalar('external-controller');
    const socketPath = scalar('external-controller-pipe');
    this.transport = address.startsWith('127.0.0.1:')
      ? { hostname: '127.0.0.1', port: Number(address.split(':').at(-1)) }
      : socketPath.startsWith('\\\\.\\pipe\\') ? { socketPath } : undefined;
    this.secret = secret;
    this.mixedPort = Number(scalar('mixed-port'));
    if (!Number.isInteger(this.mixedPort) || this.mixedPort < 1 || this.mixedPort > 65535) {
      throw new Error('Clash 代理端口无效');
    }
  }

  async connect() {
    await this.loadProfile();
    if (!this.secret || !this.transport) throw new Error('Clash 本地控制器配置不可用');
    return this.call('/version');
  }

  call(path, body) {
    return new Promise((resolve, reject) => {
      const request = http.request({
        ...this.transport, path, method: body ? 'PUT' : 'GET', agent: false,
        headers: {
          Host: 'localhost',
          Authorization: 'Bearer ' + this.secret,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('error', reject);
        response.on('end', () => {
          if (response.statusCode >= 400) {
            reject(new Error('Clash 控制器返回 HTTP ' + response.statusCode));
            return;
          }
          try { resolve(text ? JSON.parse(text) : {}); } catch (error) { reject(error); }
        });
      });
      const timer = setTimeout(() => request.destroy(new Error('Clash 控制器超时')), 4000);
      request.on('close', () => clearTimeout(timer));
      request.on('error', reject);
      request.end(body ? JSON.stringify(body) : undefined);
    });
  }

  async probe() {
    const proxy = 'http://127.0.0.1:' + this.mixedPort;
    try {
      const { stdout } = await exec('curl.exe', [
        '-sS', '--noproxy', '', '--proxy', proxy, '--max-time', '4', '-o', 'NUL',
        '-w', '%{http_code} %{time_total}', this.config.probeUrl,
      ], { windowsHide: true, timeout: 4700 });
      const [code, seconds] = stdout.trim().split(/\s+/).map(Number);
      const expected = this.config.probeStatus;
      return (expected ? code === expected : code >= 200 && code < 300) && Number.isFinite(seconds)
        ? Math.round(seconds * 1000) : null;
    } catch {
      return null;
    }
  }

  async inspect() {
    await this.loadProfile();
    const latency = await this.probe();
    const state = latency === null ? 'unreachable' : latency > this.config.slowMs ? 'slow' : 'healthy';
    return { proxy: 'http://127.0.0.1:' + this.mixedPort, network: { state, latency } };
  }

  async ready({ launch = true } = {}) {
    try {
      await this.connect();
    } catch (error) {
      if (!launch) throw error;
      const child = spawn(this.config.exe, [], {
        windowsHide: true, detached: true, stdio: 'ignore',
      });
      child.on('error', () => {});
      child.unref();
      let available = false;
      const deadline = Date.now() + 9000;
      while (!available && Date.now() < deadline) {
        await sleep(500);
        try { await this.connect(); available = true; } catch { /* Startup still pending. */ }
      }
      if (!available) throw new Error('Clash Verge 启动后本地控制器仍不可用');
    }
  }

  async delay(name) {
    const query = new URLSearchParams({ url: this.config.probeUrl, timeout: '3400',
      expected: String(this.config.probeStatus ?? '200-299') });
    try {
      const { delay } = await this.call('/proxies/' + encodeURIComponent(name) + '/delay?' + query);
      return Number.isFinite(delay) && delay > 0 ? delay : null;
    } catch {
      return null;
    }
  }

  async currentPath(name) {
    const visited = new Set();
    while (name && !visited.has(name)) {
      visited.add(name);
      const proxy = await this.call('/proxies/' + encodeURIComponent(name));
      if (!proxy.now || proxy.now === name) return name;
      name = proxy.now;
    }
    return name;
  }

  async prepare({ force = false } = {}) {
    await this.ready();
    const proxy = 'http://127.0.0.1:' + this.mixedPort;
    const latency = await this.probe();
    if (!force && latency !== null && latency <= this.config.slowMs) {
      return { proxy, network: { state: 'healthy', latency } };
    }
    const path = '/proxies/' + encodeURIComponent(this.config.group);
    const group = await this.call(path);
    if (group.type !== 'Selector' || !group.now || !Array.isArray(group.all)) {
      throw new Error('GPT 的 Clash 规则组需要是可手动选节点的策略组');
    }
    const region = (name) => Object.entries(this.config.regions).find(([, pattern]) =>
      new RegExp(pattern, 'iu').test(name ?? ''))?.[0];
    const current = await this.currentPath(group.now);
    const candidates = group.all.filter((name) => name !== current && name !== group.now
      && this.config.candidateRegions.includes(region(name)));
    const measured = (await Promise.all(candidates.map(async (name) => ({
      name, delay: await this.delay(name),
    })))).filter(({ delay }) => delay !== null
      && (force || latency === null || delay + this.config.minGainMs < latency))
      .sort((a, b) => Number(force && region(a.name) === region(current))
        - Number(force && region(b.name) === region(current)) || a.delay - b.delay);
    let changed = false;
    let verified = false;
    let attempted = 0;
    const deadline = Date.now() + 24000;
    try {
      for (const { name } of measured) {
        if (Date.now() >= deadline) break;
        attempted += 1;
        // A PUT can take effect even when its response times out.
        changed = true;
        await this.call(path, { name });
        const after = await this.probe();
        if (after === null || (!force && latency !== null && after >= latency)) continue;
        if ((await this.call(path)).now !== name) continue;
        verified = true;
        return { proxy, network: { state: 'switched', latency: after, region: region(name), attempted } };
      }
    } finally {
      if (changed && !verified) await this.call(path, { name: group.now });
    }
    const after = changed ? await this.probe() : latency;
    return { proxy, network: { state: changed ? 'restored' : 'kept', latency: after, attempted,
      detail: measured.length ? '候选节点未通过切换后的线路验证' : '没有通过测速的可用替代节点' } };
  }
}
