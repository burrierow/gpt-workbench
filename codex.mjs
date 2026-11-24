import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

let historyPlacement = Promise.resolve();

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
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        this.send({ id: message.id, error: { code: -32601, message: 'This bridge cannot acknowledge interactive requests.' } });
      } else if (message.method) {
        // App-server error notifications can describe retries. EventEmitter reserves `error` for process errors.
        const notification = message.method === 'error' ? 'codex-error-notification' : message.method;
        this.emit(notification, message.params);
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

  async request(method, params = {}, timeout = 25000, validate) {
    const startedAt = Date.now();
    const check = { method, startedAt: new Date(startedAt).toISOString() };
    this.emit('rpc', { ...check, state: 'running' });
    try {
      const result = await new Promise((resolve, reject) => {
        const fail = (message, code) => reject(Object.assign(new Error(message), { rpcCode: code }));
        if (this.disconnected) { fail(this.disconnected.message); return; }
        const id = ++this.nextId;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          fail('Codex 请求超时 ' + method);
        }, timeout);
        this.pending.set(id, { resolve, fail, timer });
        this.send({ id, method, params });
      });
      validate?.(result);
      this.emit('rpc', { ...check, state: 'passed', elapsedMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      Object.assign(error, { rpcMethod: method, elapsedMs: Date.now() - startedAt });
      this.emit('rpc', {
        ...check, state: 'failed', elapsedMs: error.elapsedMs, code: error.rpcCode,
        error: error.message.slice(0, 1500),
      });
      throw error;
    }
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
    this.lines.close();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    this.child.unref();
  }

  async init(timeout) {
    await this.request('initialize', {
      clientInfo: { name: 'gpt_workbench', title: 'GPT 工作台', version: '1.4.0' },
    }, timeout);
    this.send({ method: 'initialized' });
    await this.request('account/read', { refreshToken: false }, timeout, ({ account }) => {
      if (account?.type !== 'chatgpt') throw new Error('Codex App Server 需要 ChatGPT 帐号登录');
    });
  }

  async checkSession(cwd, timeout) {
    await this.request('thread/start', {
      cwd, modelProvider: 'openai', sandbox: 'workspace-write', approvalPolicy: 'never', ephemeral: true,
    }, timeout);
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

  async placeInHistory(thread, sectionId) {
    let cursor;
    do {
      const page = await this.request('thread/list', {
        sectionId, cursor, sortKey: 'section_position', sortDirection: 'asc',
        limit: 50, useStateDbOnly: true, currentAccountOnly: true,
      }, 4000);
      const before = page.data.find((item) => item.id !== thread.id && (
        item.createdAt < thread.createdAt || (item.createdAt === thread.createdAt && item.id < thread.id)
      ));
      if (before || !page.nextCursor) {
        await this.request('thread/section/move', {
          threadId: thread.id, sectionId, beforeThreadId: before?.id,
        }, 4000);
        return;
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  async run({ cwd, prompt, timeout, model, effort, historySectionId, diagnostic = false,
    resumeThreadId, persistent = false, beforeTurn = async () => {},
    started, turnStarted, progress = () => {}, activity = () => {}, signal }) {
    signal?.throwIfAborted();
    const { thread, model: actualModel, reasoningEffort } = await this.request(
      resumeThreadId ? 'thread/resume' : 'thread/start', {
      cwd, modelProvider: 'openai', sandbox: 'workspace-write', approvalPolicy: 'never',
      ...(resumeThreadId ? { threadId: resumeThreadId, excludeTurns: true } : { ephemeral: diagnostic && !persistent }),
      model, config: { model_reasoning_effort: effort },
    }, undefined, ({ model: actualModel, reasoningEffort }) => {
      if (actualModel !== model || reasoningEffort !== effort) {
        throw new Error(`Codex 未应用请求的模型或推理强度：${actualModel} / ${reasoningEffort}`);
      }
    });
    signal?.throwIfAborted();
    const threadId = thread.id;
    if (resumeThreadId && threadId !== resumeThreadId) throw new Error('Codex 返回了不同的会话 ID');
    if (resumeThreadId && thread.status?.type === 'active') throw new Error('原 GPT 会话仍有回合正在执行，请稍后重试');
    await started(threadId, { model: actualModel, reasoningEffort });
    let resolveTurn;
    let rejectTurn;
    const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    completed.catch(() => {});
    let turnId;
    const earlyCompletions = new Map();
    const answers = new Map();
    const matchesTurn = (event) => event.threadId === threadId && (!turnId || event.turnId === turnId);
    const toolProgress = (event, finished) => {
      if (!matchesTurn(event) || !Object.hasOwn(publicToolStages, event.item?.type)) return;
      const [stage, begin, end] = publicToolStages[event.item.type];
      if (finished && ['failed', 'declined', 'interrupted'].includes(event.item.status)) {
        progress({ stage, summary: '一次工具调用未成功，GPT 正在处理' });
      } else {
        progress({ stage, summary: finished ? end : begin });
      }
    };
    const onItemStarted = (event) => {
      if (matchesTurn(event) && Object.hasOwn(publicToolStages, event.item?.type)) activity();
      toolProgress(event, false);
    };
    const onOutput = (event) => {
      if (matchesTurn(event) && event.delta?.trim()) activity();
    };
    const outputEvents = ['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta'];
    const onItem = (event) => {
      const item = event.item;
      if (!matchesTurn(event)) return;
      if (Object.hasOwn(publicToolStages, item.type) || (item.type === 'agentMessage' && item.text?.trim())) activity();
      toolProgress(event, true);
      if (item.type !== 'agentMessage') return;
      if (item.phase === 'commentary') {
        const summary = summaryText(item.text);
        if (summary) progress({ stage: 'update', summary });
      }
      if (item.phase !== 'commentary') {
        const answer = answers.get(event.turnId) ?? {};
        answer.latest = item.text;
        if (item.phase === 'final_answer') answer.final = item.text;
        answers.set(event.turnId, answer);
      }
    };
    const onPlan = (event) => {
      if (!matchesTurn(event) || !Array.isArray(event.plan)) return;
      const done = event.plan.filter((entry) => entry.status === 'completed').length;
      const current = event.plan.find((entry) => entry.status === 'inProgress');
      const next = current ?? event.plan.find((entry) => entry.status === 'pending');
      const step = summaryText(next?.step);
      progress({ stage: 'plan', summary: '计划已完成 ' + done + '/' + event.plan.length + ' 步' +
        (step ? (current ? '，正在处理 ' : '，下一步 ') + step : '') });
    };
    const onTurn = (event) => {
      if (event.threadId !== threadId) return;
      if (!turnId) earlyCompletions.set(event.turn.id, event.turn);
      else if (event.turn.id === turnId) resolveTurn(event.turn);
    };
    const onCodexError = (event) => {
      if (event?.threadId === threadId && event.willRetry) {
        progress({ stage: 'update', summary: 'GPT 连接暂时中断，正在重连', transient: true });
      }
    };
    this.on('item/started', onItemStarted);
    this.on('item/completed', onItem);
    for (const name of outputEvents) this.on(name, onOutput);
    this.on('turn/plan/updated', onPlan);
    this.on('turn/completed', onTurn);
    this.on('codex-error-notification', onCodexError);
    this.once('disconnect', rejectTurn);
    let onAbort;
    const interrupted = new Promise((_, reject) => { onAbort = () => reject(signal.reason); });
    interrupted.catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => rejectTurn(new Error('GPT 任务执行超时')), timeout);
    try {
      signal?.throwIfAborted();
      await beforeTurn();
      signal?.throwIfAborted();
      const response = await this.request('turn/start', {
        threadId, cwd, input: [{ type: 'text', text: prompt, text_elements: [] }],
      });
      turnId = response.turn.id;
      if (earlyCompletions.has(turnId)) resolveTurn(earlyCompletions.get(turnId));
      signal?.throwIfAborted();
      await turnStarted(turnId);
      if (!resumeThreadId && !diagnostic && historySectionId) {
        historyPlacement = historyPlacement.then(() => {
          if (!signal?.aborted) return this.placeInHistory(thread, historySectionId);
        }).catch((error) => {
          console.warn('工作台会话分组失败', threadId, error.message);
        });
        await Promise.race([historyPlacement, interrupted]);
      }
      const turn = await Promise.race([completed, interrupted]);
      signal?.throwIfAborted();
      if (turn.status !== 'completed') throw new Error(turn.error?.message || 'GPT 状态 ' + turn.status);
      const answer = answers.get(turnId);
      const fallback = turn.items?.filter((item) => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)?.text;
      return { threadId, turnId, text: answer?.final || answer?.latest || fallback || '' };
    } catch (error) {
      if (turnId) await this.request('turn/interrupt', { threadId, turnId }, 4000).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      this.off('item/started', onItemStarted);
      this.off('item/completed', onItem);
      for (const name of outputEvents) this.off(name, onOutput);
      this.off('turn/plan/updated', onPlan);
      this.off('turn/completed', onTurn);
      this.off('codex-error-notification', onCodexError);
      this.off('disconnect', rejectTurn);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
