import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

const publicToolStages = {
  webSearch: ['research', '正在查找公开资料', '已完成一轮资料检索'],
  commandExecution: ['tools', '正在运行本地工具', '已完成一次本地工具调用'],
  fileChange: ['files', '正在整理或写入文件', '已更新工作文件'],
  mcpToolCall: ['tools', '正在调用工具', '已完成一次工具调用'],
};
const summaryText = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 240) : '';

export class DesktopCodex extends EventEmitter {
  constructor(exe, cwd, proxy) {
    super();
    this.nextId = 0;
    this.pending = new Map();
    const env = { ...process.env };
    for (const variable of ['OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[variable];
    if (proxy) Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1' });
    const windowsSandbox = process.platform === 'win32'
      ? ['-c', 'windows.sandbox="mxc"']
      : [];
    this.child = spawn(exe, [
      'app-server', '-c', 'forced_login_method="chatgpt"',
      '-c', 'memories.generate_memories=false', '-c', 'memories.use_memories=false',
      ...windowsSandbox, '--disable', 'memories',
    ], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child.on('error', (error) => this.disconnect(error));
    this.child.on('exit', () => this.disconnect(new Error('Codex App Server 已退出')));
    this.child.stdin.on('error', (error) => this.disconnect(error));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        this.send({ id: message.id, error: { code: -32601, message: 'This bridge cannot acknowledge interactive requests.' } });
      } else if (message.method) {
        this.emit(message.method, message.params);
      } else {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.fail(message.error.message, message.error.code);
        else waiter.resolve(message.result);
      }
    });
  }

  send(value) {
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  request(method, params = {}, timeout = 25000) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const fail = (message, code) => reject(Object.assign(new Error(message), {
        rpcMethod: method, rpcCode: code, elapsedMs: Date.now() - startedAt,
      }));
      if (this.disconnected) { fail(this.disconnected.message); return; }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail('Codex 请求超时 ' + method);
      }, timeout);
      this.pending.set(id, { resolve, fail, timer });
      this.send({ id, method, params });
    });
  }

  disconnect(error) {
    if (this.disconnected) return;
    this.disconnected = error;
    for (const { fail, timer } of this.pending.values()) {
      clearTimeout(timer);
      fail(error.message);
    }
    this.pending.clear();
    this.emit('disconnect', error);
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }

  async init(timeout) {
    await this.request('initialize', {
      clientInfo: { name: 'gpt_workbench', title: 'GPT 工作台', version: '1.0.0' },
    }, timeout);
    this.send({ method: 'initialized' });
    const { account } = await this.request('account/read', { refreshToken: false }, timeout);
    if (account?.type !== 'chatgpt') throw new Error('Codex App Server 需要 ChatGPT 帐号登录');
  }

  async readQuota() {
    try {
      const response = await this.request('account/rateLimits/read', {}, 4000);
      const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
      if (!snapshot || (snapshot.limitId && snapshot.limitId !== 'codex')) return null;
      const windows = [snapshot.primary, snapshot.secondary];
      const remaining = (minutes) => {
        const used = windows.find((window) => window?.windowDurationMins === minutes)?.usedPercent;
        return Number.isInteger(used) && used >= 0 ? Math.max(0, 100 - used) : null;
      };
      const fiveHourRemainingPercent = remaining(300);
      const weeklyRemainingPercent = remaining(7 * 24 * 60);
      if (fiveHourRemainingPercent === null && weeklyRemainingPercent === null) return null;
      return { fiveHourRemainingPercent, weeklyRemainingPercent, checkedAt: new Date().toISOString() };
    } catch {
      return null;
    }
  }

  async run({ cwd, title, prompt, timeout, model, effort, historySectionId, started, turnStarted, progress = () => {} }) {
    const { thread, model: actualModel, reasoningEffort } = await this.request('thread/start', {
      cwd, modelProvider: 'openai', sandbox: 'workspace-write', approvalPolicy: 'never', ephemeral: false,
      model, config: { model_reasoning_effort: effort },
    });
    const threadId = thread.id;
    if (actualModel !== model || reasoningEffort !== effort) {
      throw new Error(`Codex 未应用请求的模型或推理强度：${actualModel} / ${reasoningEffort}`);
    }
    await started(threadId, { model: actualModel, reasoningEffort });
    let resolveTurn;
    let rejectTurn;
    const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    completed.catch(() => {});
    let latest = '';
    let final = '';
    const toolProgress = (event, finished) => {
      if (event.threadId !== threadId || !Object.hasOwn(publicToolStages, event.item?.type)) return;
      const [stage, begin, end] = publicToolStages[event.item.type];
      if (finished && ['failed', 'declined', 'interrupted'].includes(event.item.status)) {
        progress({ stage, summary: '一次工具调用未成功，GPT 正在处理' });
      } else {
        progress({ stage, summary: finished ? end : begin });
      }
    };
    const onItemStarted = (event) => toolProgress(event, false);
    const onItem = (event) => {
      const item = event.item;
      if (event.threadId !== threadId) return;
      toolProgress(event, true);
      if (item.type !== 'agentMessage') return;
      if (item.phase === 'commentary') {
        const summary = summaryText(item.text);
        if (summary) progress({ stage: 'update', summary });
      }
      if (item.phase === 'final_answer') final = item.text;
      if (item.phase !== 'commentary') latest = item.text;
    };
    const onPlan = (event) => {
      if (event.threadId !== threadId || !Array.isArray(event.plan)) return;
      const done = event.plan.filter((entry) => entry.status === 'completed').length;
      const current = event.plan.find((entry) => entry.status === 'inProgress');
      const next = current ?? event.plan.find((entry) => entry.status === 'pending');
      const step = summaryText(next?.step);
      progress({ stage: 'plan', summary: '计划已完成 ' + done + '/' + event.plan.length + ' 步' +
        (step ? (current ? '，正在处理 ' : '，下一步 ') + step : '') });
    };
    const onTurn = (event) => {
      if (event.threadId === threadId) resolveTurn(event.turn);
    };
    this.on('item/started', onItemStarted);
    this.on('item/completed', onItem);
    this.on('turn/plan/updated', onPlan);
    this.on('turn/completed', onTurn);
    this.once('disconnect', rejectTurn);
    const timer = setTimeout(() => rejectTurn(new Error('GPT 任务执行超时')), timeout);
    let turnId;
    try {
      const response = await this.request('turn/start', {
        threadId, input: [{ type: 'text', text: prompt, text_elements: [] }],
      });
      turnId = response.turn.id;
      await turnStarted(turnId);
      // Name after the first turn has initialized its persistent history.
      await this.request('thread/name/set', { threadId, name: title }, 4000).catch(() => {});
      if (historySectionId) {
        await this.request('thread/section/move', {
          threadId, sectionId: historySectionId,
        }, 4000).catch((error) => {
          console.warn('工作台会话分组失败', threadId, error.message);
        });
      }
      const turn = await completed;
      if (turn.status !== 'completed') throw new Error(turn.error?.message || 'GPT 状态 ' + turn.status);
      if (!final && !latest) {
        latest = turn.items?.filter((item) => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)?.text;
      }
      return { threadId, turnId, text: final || latest || '' };
    } catch (error) {
      if (turnId) await this.request('turn/interrupt', { threadId, turnId }, 4000).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      this.off('item/started', onItemStarted);
      this.off('item/completed', onItem);
      this.off('turn/plan/updated', onPlan);
      this.off('turn/completed', onTurn);
      this.off('disconnect', rejectTurn);
    }
  }
}
