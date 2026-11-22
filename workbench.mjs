import { createHash, randomUUID } from 'node:crypto';
import { existsSync, watch } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DesktopCodex } from './codex.mjs';
import { Clash } from './network.mjs';
import { WorkBuddyRecovery } from './workbuddy-recovery.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const codexExecutable = process.env.GPT_WORKBENCH_CODEX || config.codexExe;
const data = resolve(process.env.GPT_WORKBENCH_DATA || config.dataDir || join(root, 'data'));
const inbox = join(data, 'inbox');
const jobs = join(data, 'jobs');
const staging = join(data, 'staging');
const kb = join(data, 'knowledge');
const sources = ['workbuddy', 'kimi', 'gpt'];
const providers = sources.slice(0, 2);
const terminal = ['completed', 'failed', 'interrupted'];
const stamp = () => new Date().toISOString();
const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const taskDir = (id) => join(jobs, validId(id));
const handoffDir = (id) => join(taskDir(id), 'workspace', '.workbench');
const read = async (path) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const optional = async (path) => {
  try { return await read(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
};
const emit = (value) => console.log(JSON.stringify(value, null, 2));
const errorText = (error) => String(error.message ?? error).slice(0, 1500);
const relativeLink = (id) => 'codex://threads/' + id;
const heartbeatMs = 10000;
const networkRetryMs = 30000;
const workFallback = '当前工作台的原生 Work 入口需要手动领取，已转由桌面 Codex 自动执行。';
const phaseLabels = {
  submitted: '任务已提交，等待工作台收件',
  queued: '工作台已收件，等待启动检查',
  preparing_network: '正在检查 GPT 线路',
  waiting_network: '等待 GPT 线路恢复',
  awaiting_work: '旧 Work 任务等待迁入自动执行队列',
  starting_gpt: '正在启动 Codex，会话尚未确认开工',
  running: 'Codex 已确认开始执行',
  running_work: 'ChatGPT Work 已领取，模型活动由 Work 会话报告',
  completed: '任务已完成',
  failed: '任务失败',
  interrupted: '任务已中断',
  missing: '未找到此任务',
};
const connectionError = /stream disconnected|connection (?:reset|refused|closed|timed out)|websocket.{0,70}(?:error|failed|timeout|disconnect)|network error|failed to (?:connect|send request)|error sending request|ECONN(?:RESET|REFUSED)|ETIMEDOUT/i;
const workspaceRoutingTimeout = /\bworkspace routing discovery timed out\b/i;
const startupMethods = new Set(['initialize', 'account/read', 'thread/start']);
const startupObservedMethods = new Set([...startupMethods, 'turn/start']);
const startupLabels = {
  initialize: '初始化 Codex',
  'account/read': '检查 ChatGPT 登录',
  'thread/start': '创建 Codex 会话',
  'turn/start': '等待 Codex 确认开工',
};
const receiptStates = ['submitted', 'failed', 'confirmed'];
const startupRetryable = (error) => workspaceRoutingTimeout.test(errorText(error))
  || connectionError.test(errorText(error)) || /^Codex 请求超时 /.test(errorText(error));

async function currentQuota() {
  let app;
  try {
    const route = await new Clash(config.clash).inspect().catch(() => null);
    app = new DesktopCodex(codexExecutable, root, route?.proxy);
    await app.init(4000);
    return await app.readQuota();
  } catch {
    return null;
  } finally {
    app?.close();
  }
}

async function save(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  for (let delay = 20; ; delay *= 2) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      // Windows readers can briefly hold the previous snapshot open during replacement.
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || delay > 320) {
        await rm(temporary, { force: true });
        throw error;
      }
      await sleep(delay);
    }
  }
}

function validId(id) {
  if (!idPattern.test(id ?? '')) throw new Error('需要有效的工作台任务 ID');
  return id;
}

function isInside(directory, path) {
  const child = relative(directory, path);
  return !!child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
}

function known(value, choices) {
  if (!choices.includes(value)) throw new Error('无效选项 ' + String(value));
  return value;
}

function taskFeedback(status) {
  const { mode, state } = status;
  const sessionMode = (value) => value === 'work' ? 'ChatGPT Work' : value === 'codex' ? 'Codex' : null;
  const result = {
    ...status,
    execution: {
      status: state === 'starting_gpt' && status.startupStep?.state === 'running'
        ? startupLabels[status.startupStep.method] ?? phaseLabels[state]
        : phaseLabels[state] ?? state,
      sessionMode: sessionMode(mode),
      requestedSessionMode: sessionMode(status.requestedMode ?? mode),
      running: state === 'running_work' || state === 'missing' ? null
        : state === 'running' ? (status.turnId ? true : null) : false,
      model: status.model ?? null,
      reasoningEffort: status.reasoningEffort ?? null,
      metadataSource: status.sessionMetadataSource ?? null,
    },
  };
  return result;
}

function taskRoute(job) {
  const requestedMode = job.requestedMode === 'work' || job.mode === 'work' ? 'work' : 'codex';
  return {
    mode: 'codex', requestedMode,
    ...(requestedMode === 'work' ? { routingNote: workFallback } : {}),
  };
}

async function pendingStatus(id) {
  const status = await optional(statusPath(id));
  if (status) return status;
  const job = await optional(join(inbox, id, 'task.json')) ?? await optional(join(taskDir(id), 'task.json'));
  return job ? { id, source: job.source, ...taskRoute(job), state: 'submitted' } : { id, state: 'missing' };
}

async function loadText(file) {
  if (!file) throw new Error('需要通过文件提供文本');
  const info = await lstat(file);
  if (!info.isFile() || info.size > 512000) throw new Error('文本需要是 512 KB 以内的普通文件');
  const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('文本文件为空');
  return text;
}

async function files(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory() && !(await lstat(path)).isSymbolicLink()) result.push(...await files(path));
    if (item.isFile()) result.push(path);
  }
  return result.sort();
}

async function submit(args) {
  let source = known(args.source, sources);
  if (source === 'gpt' && config.kimiTaskRoot && isInside(config.kimiTaskRoot, process.cwd())) source = 'kimi';
  const requestedMode = known(args.mode || 'codex', ['codex', 'work']);
  const route = taskRoute({ requestedMode });
  const prompt = await loadText(args['prompt-file']);
  const selection = taskSelection(prompt, args);
  const id = randomUUID();
  const temporary = join(staging, id);
  const cwd = join(temporary, 'workspace');
  await mkdir(join(cwd, 'inputs'), { recursive: true });
  await mkdir(join(cwd, 'artifacts'));
  await mkdir(join(cwd, '.workbench', 'requests'), { recursive: true });
  try {
    for (const file of args.input ?? []) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('附件必须是本地普通文件');
      await cp(file, join(cwd, 'inputs', basename(file)), { force: false, errorOnExist: true });
    }
    const job = { id, target: 'gpt', source, mode: route.mode, requestedMode,
      title: (args.title || prompt.split('\n')[0]).slice(0, 76), prompt, selection, submittedAt: stamp() };
    await save(join(temporary, 'task.json'), job);
    await rename(temporary, join(inbox, id));
    emit(taskFeedback({ id, state: 'submitted', ...route, source }));
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function taskSelection(prompt, options = {}) {
  let model;
  let effort;
  for (const raw of prompt.trimStart().split(/\r?\n/).slice(0, 3)) {
    const line = raw.trim().replaceAll('**', '');
    const modelField = line.match(/^(?:模型|model)\s*[:：]\s*(.+)$/i);
    const effortField = line.match(/^(?:推理强度|effort)\s*[:：]\s*(.+)$/i);
    const request = line.match(/^(?:请?用|请?使用|please use|use)\s*(gpt[- ]?\d+(?:\.\d+)?[- ]+(?:sol|astra|terra|luna))(?:\s*[+＋]\s*([a-z]+))?(?=\s*$|[。！，、.!;,；：:])/i);
    if (modelField) model = modelField[1];
    else if (effortField) effort = effortField[1];
    else if (request) {
      model = request[1];
      effort = request[2] ?? effort;
    } else if (line && !/^用\s*GPT[。！!：:]?$/i.test(line)) break;
  }
  model = (options.model ?? model ?? 'gpt-6.2-sol').trim().toLowerCase()
    .replace(/^gpt[ -]?(\d+(?:\.\d+)?)[ -]+/, 'gpt-$1-');
  if (!/^gpt-\d+(?:\.\d+)?-(?:sol|astra|terra|luna)$/.test(model)) {
    throw new Error('无效模型，请填写完整型号，例如 GPT-6.2 Sol');
  }
  effort = (options.effort ?? effort ?? 'medium').trim().toLowerCase();
  if (effort === 'light') effort = 'low';
  if (effort === 'extra high') effort = 'xhigh';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new Error('推理强度须为 Low、Medium、High、XHigh 或 Max');
  }
  return { model, effort };
}

function statusPath(id) { return join(taskDir(id), 'status.json'); }
function resultPath(id) { return join(taskDir(id), 'result.json'); }
function peerPath(id) { return join(taskDir(id), 'peer.json'); }
function knowledgeDir(provider, id) { return join(kb, known(provider, providers), validId(id)); }

async function knowledgeAvailable(provider, jobId) {
  const base = join(kb, known(provider, providers));
  const found = [];
  for (const id of await readdir(base)) {
    if (!idPattern.test(id)) continue;
    const path = join(base, id);
    const request = await optional(join(path, 'request.json'));
    if (request && (!jobId || request.jobId === jobId) && Date.parse(request.expiresAt) > Date.now()
      && !existsSync(join(path, 'reply.json'))) found.push(request);
  }
  return found;
}

async function waitForJob(id, seconds, afterProgress, afterState) {
  const deadline = Date.now() + seconds * 1000;
  let lastBeat;
  for (;;) {
    const status = await optional(statusPath(id));
    if (status?.heartbeatAt && status.heartbeatAt !== lastBeat) {
      await save(peerPath(id), { observedHeartbeat: status.heartbeatAt, acknowledgedAt: stamp() });
      lastBeat = status.heartbeatAt;
    }
    if (status && providers.includes(status.source) && !terminal.includes(status.state)) {
      const requests = await knowledgeAvailable(status.source, id);
      if (requests.length) return { ...status, knowledgeRequests: requests };
    }
    if (terminal.includes(status?.state) || Date.now() >= deadline
      || (afterState !== undefined && status && status.state !== afterState)
      || (afterProgress !== undefined && status?.progress?.sequence > afterProgress)) {
      return status || await pendingStatus(id);
    }
    await sleep(180);
  }
}

async function stageKimiArtifacts(id, artifacts) {
  const folder = process.cwd();
  if (!artifacts?.length || !config.kimiTaskRoot || !isInside(config.kimiTaskRoot, folder)) return {};
  const cwd = await realpath(folder);
  if (!isInside(await realpath(config.kimiTaskRoot), cwd)) return {};

  const source = join(taskDir(id), 'workspace', 'artifacts');
  const output = join(cwd, 'gpt-results-' + id);
  const paths = artifacts.map((file) => {
    if (!isInside(source, file)) throw new Error('任务产物路径超出产物目录');
    return relative(source, file);
  });
  async function deliveryFiles(directory) {
    const physicalOutput = await realpath(directory);
    if (relative(directory, physicalOutput)) throw new Error('Kimi 交付目录无效');
    return Promise.all(paths.map(async (path) => {
      const file = join(directory, path);
      if (!(await lstat(file)).isFile() || !isInside(physicalOutput, await realpath(file))) {
        throw new Error('Kimi 交付文件不完整');
      }
      return file;
    }));
  }
  let destination = output;
  if (existsSync(output)) {
    try { return { deliveryArtifacts: await deliveryFiles(output) }; }
    catch {
      destination = output + '-retry';
      if (existsSync(destination)) {
        try { return { deliveryArtifacts: await deliveryFiles(destination) }; }
        catch { destination = output + '-' + randomUUID(); }
      }
    }
  }
  const physicalSource = await realpath(source);
  if (relative(await realpath(taskDir(id)), physicalSource) !== join('workspace', 'artifacts')) {
    throw new Error('任务产物目录无效');
  }
  const stagingDir = await mkdtemp(join(cwd, '.gpt-results-'));
  try {
    for (const path of paths) {
      const input = join(source, path);
      if (!(await lstat(input)).isFile() || !isInside(physicalSource, await realpath(input))) {
        throw new Error('任务产物需要是目录内的普通文件');
      }
      const stagedFile = join(stagingDir, path);
      await mkdir(dirname(stagedFile), { recursive: true });
      await cp(input, stagedFile, { force: false, errorOnExist: true });
    }
    try { await rename(stagingDir, destination); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !existsSync(destination)) throw error;
    }
  } finally {
    if (isInside(cwd, stagingDir)) await rm(stagingDir, { recursive: true, force: true });
  }
  return { deliveryArtifacts: await deliveryFiles(destination) };
}

async function followJob(id, seconds) {
  const status = await waitForJob(id, seconds);
  if (!providers.includes(status.source) || !terminal.includes(status.state)) return status;
  const [quota, staged, withReceipt] = await Promise.all([
    Object.hasOwn(status, 'quota') ? status.quota : currentQuota(),
    status.source === 'kimi' && status.state === 'completed'
      ? stageKimiArtifacts(id, status.artifacts).catch((error) => ({ deliveryError: errorText(error) }))
      : {},
    withDeliveryReceipt(status),
  ]);
  return { ...withReceipt, quota, ...staged };
}

function receiptPath(id, state) {
  return join(taskDir(id), 'delivery-' + state + '.json');
}

async function withDeliveryReceipt(status) {
  if (status.state !== 'completed' || !providers.includes(status.source)) return status;
  const [submitted, failed, confirmed] = await Promise.all(
    receiptStates.map((state) => optional(receiptPath(status.id, state))),
  );
  const latest = failed && (!submitted || failed.reportedAt > submitted.reportedAt) ? failed : submitted;
  return { ...status, delivery: confirmed ?? latest ?? { state: 'pending' } };
}

async function reportDelivery(id, source, state, detailFile) {
  known(source, providers);
  known(state, receiptStates);
  const status = await read(statusPath(id));
  if (status.state !== 'completed' || status.source !== source) {
    throw new Error('需要由原派单渠道回报已完成任务的交付');
  }
  if (state === 'failed' && !detailFile) throw new Error('回报交付失败时请提供失败原因');
  const detail = detailFile ? (await loadText(detailFile)).slice(0, 1000) : undefined;
  await save(receiptPath(id, state), {
    state, source, reportedAt: stamp(), ...(detail ? { detail } : {}),
  });
  emit(taskFeedback(await withDeliveryReceipt(status)));
}

async function askKnowledge(provider, jobId, file, seconds) {
  known(provider, providers);
  const job = await optional(join(taskDir(jobId), 'task.json'));
  if (!job || terminal.includes((await optional(statusPath(jobId)))?.state)) throw new Error('需要运行中的工作台任务 ID');
  const query = await loadText(file);
  const id = randomUUID();
  const outbox = join(handoffDir(jobId), 'requests');
  await mkdir(outbox, { recursive: true });
  await save(join(outbox, id + '.json'), {
    id, jobId, provider, query, expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
  });
  await waitForKnowledge(provider, id, seconds);
}

async function waitForKnowledge(provider, id, seconds) {
  const path = knowledgeDir(provider, id);
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const reply = await optional(join(path, 'reply.json'));
    if (reply) {
      emit({ id, provider, state: 'answered', reply: reply.text, receivedAt: reply.receivedAt });
      return;
    }
    const request = await optional(join(path, 'request.json'));
    const expired = request && Date.now() >= Date.parse(request.expiresAt);
    if (expired || Date.now() >= deadline) {
      emit({ id, provider, state: expired ? 'expired' : 'pending' });
      return;
    }
    await sleep(250);
  }
}

async function answerKnowledge(provider, id, file) {
  const path = knowledgeDir(provider, id);
  const request = await read(join(path, 'request.json'));
  if (Date.parse(request.expiresAt) <= Date.now()) throw new Error('知识请求已到期');
  if (existsSync(join(path, 'reply.json'))) throw new Error('知识请求已有回复');
  const text = await loadText(file);
  await save(join(path, 'reply.json'), { text, receivedAt: stamp() });
  emit({ id, provider, state: 'answered' });
}

const workReservation = (id) => join(handoffDir(id), 'work-claimed.json');

async function nativeWorkClaim(id) {
  const claim = await optional(workReservation(id));
  return claim && claim.action !== 'dispatch_codex' ? claim : undefined;
}

async function reserveAutomaticWork(id) {
  await mkdir(handoffDir(id), { recursive: true });
  const file = workReservation(id);
  const existing = await optional(file);
  if (existing) return existing;
  const reservation = { action: 'dispatch_codex', requestedAt: stamp() };
  try {
    await writeFile(file, JSON.stringify(reservation), { flag: 'wx' });
    return reservation;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return await read(file);
  }
}

function workChatLink(value) {
  if (value && !/^(https:\/\/chatgpt\.com\/c\/|codex:\/\/threads\/)[a-z0-9_-]+$/i.test(value)) {
    throw new Error('会话链接格式无效');
  }
  return value;
}

async function reportWork(id, options) {
  const job = await read(join(taskDir(id), 'task.json'));
  const status = await read(statusPath(id));
  if (job.mode !== 'work' || terminal.includes(status.state)
    || !await nativeWorkClaim(id)) throw new Error('需要已领取的 ChatGPT Work 任务');
  const file = join(handoffDir(id), 'work-progress.json');
  const safeText = (value) => {
    if (value === undefined) return undefined;
    const content = value.trim();
    if (!content || content.length > 100 || /[\r\n\u0000-\u001f]/u.test(content)) throw new Error('模型或推理强度格式无效');
    return content;
  };
  const model = safeText(options.model);
  const reasoningEffort = safeText(options.effort);
  const chatLink = workChatLink(options['chat-link']);
  if (!model && !reasoningEffort && !chatLink) throw new Error('提供 Work 会话已确认的模型、推理强度或链接');
  const metadata = {
    ...(await optional(file)),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(chatLink ? { chatLink } : {}),
  };
  await save(file, metadata);
  emit(taskFeedback({ ...status, ...metadata, state: 'running_work', sessionMetadataSource: 'work_session_report' }));
}

async function finishWork(id, file, chatLink) {
  const path = taskDir(id);
  const job = await read(join(path, 'task.json'));
  const status = await read(statusPath(id));
  if (job.mode !== 'work' || terminal.includes(status.state) || !await nativeWorkClaim(id)) {
    throw new Error('当前任务无法提交 Work 模式结果');
  }
  await save(join(handoffDir(id), 'work-output.json'), {
    text: await loadText(file), ...(chatLink ? { chatLink: workChatLink(chatLink) } : {}),
  });
  emit({ id, state: 'work_result_submitted' });
}

async function acquireListener() {
  const lockPath = join(data, 'listener.lock');
  const physicalPath = await realpath(data);
  const key = createHash('sha256').update(
    process.platform === 'win32' ? physicalPath.toLowerCase() : physicalPath,
  ).digest('hex').slice(0, 32);
  const endpoint = (process.platform === 'win32' ? '\\\\.\\pipe\\' : '\0') + 'gpt-workbench-' + key;
  const gate = createServer((socket) => socket.destroy());
  await new Promise((resolveGate, rejectGate) => {
    gate.once('error', rejectGate);
    gate.listen(endpoint, () => {
      gate.off('error', rejectGate);
      resolveGate();
    });
  }).catch((error) => {
    if (error.code === 'EADDRINUSE') throw new Error('工作台监听器已运行');
    throw error;
  });
  try {
    let previous = await optional(lockPath).catch((error) => {
      if (!(error instanceof SyntaxError)) throw error;
    });
    // Give a legacy listener time to write its PID if it just created the file.
    if (!previous && existsSync(lockPath)) {
      const age = Date.now() - (await lstat(lockPath)).mtimeMs;
      if (age < 1000) await sleep(1000 - Math.max(age, 0));
      previous = await optional(lockPath).catch((error) => {
        if (!(error instanceof SyntaxError)) throw error;
      });
    }
    if (previous?.ownership !== 'socket' && Number.isInteger(previous?.pid) && previous.pid > 0) {
      let running = true;
      try { process.kill(previous.pid, 0); } catch (error) {
        if (error.code === 'ESRCH') running = false;
        else if (error.code !== 'EPERM') throw error;
      }
      if (running) throw new Error('工作台监听器已运行');
    }
    await save(lockPath, { pid: process.pid, startedAt: stamp(), ownership: 'socket' });
    return async () => {
      try { await rm(lockPath, { force: true }); }
      finally { gate.close(); }
    };
  } catch (error) {
    gate.close();
    throw error;
  }
}

async function serve() {
  const releaseListener = await acquireListener();
  const clash = new Clash(config.clash);
  const recovery = new WorkBuddyRecovery(config.workbuddy, join(data, 'workbuddy-recovery'));
  const states = new Map();
  const pendingWrites = new Map();
  const progressByJob = new Map();
  const active = new Map();
  const shutdown = new AbortController();
  let closing = false;
  let scanActive = false;
  let rescan = false;
  let heartbeatActive = false;
  let routeCheck;
  let routeGeneration = 0;

  async function inspectRoute() {
    try {
      return await clash.inspect();
    } catch (error) {
      return { network: { state: 'unreachable', latency: null, detail: errorText(error) } };
    }
  }

  async function inspectAndRecover(force) {
    const before = await inspectRoute();
    if (!force && before.network.state === 'healthy') return { ...before, generation: routeGeneration };

    const recoveryMode = force ? 'force' : 'repair';
    const result = await recovery.dispatch(recoveryMode)
      .catch((error) => ({ error: errorText(error) }));
    if (force || result.network?.state === 'switched') routeGeneration += 1;
    const after = await inspectRoute();
    return {
      proxy: after.proxy,
      generation: routeGeneration,
      network: {
        ...after.network,
        state: result.error ? 'workbuddy_failed'
          : after.network.latency === null ? 'unreachable' : result.network.state,
        verifiedState: after.network.state,
        recoveryMode,
        ...(result.error ? { detail: result.error } : result.network?.detail ? { detail: result.network.detail } : {}),
        ...(result.executor ? {
          executor: result.executor, jobId: result.jobId,
          desktopStarted: result.desktopStarted, region: result.network?.region,
          attempted: result.network?.attempted,
        } : {}),
      },
    };
  }

  async function checkRoute(failedGeneration) {
    if (routeCheck) {
      const checked = await routeCheck;
      if (failedGeneration === undefined || checked.generation !== failedGeneration) return checked;
      if (closing) return checked;
    }
    const force = failedGeneration !== undefined && failedGeneration === routeGeneration;
    if (!routeCheck) routeCheck = inspectAndRecover(force).finally(() => { routeCheck = undefined; });
    return routeCheck;
  }

  async function relayKnowledge(jobId) {
    const outbox = join(handoffDir(jobId), 'requests');
    const entries = await readdir(outbox).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    for (const filename of entries) {
      const id = filename.slice(0, -5);
      if (!filename.endsWith('.json') || !idPattern.test(id)) continue;
      const file = join(outbox, filename);
      if (!(await lstat(file)).isFile()) continue;
      const request = await read(file);
      if (request.id !== id || request.jobId !== jobId || !providers.includes(request.provider)
        || typeof request.query !== 'string' || request.query.length > 512000
        || !(Date.parse(request.expiresAt) > Date.now())) continue;
      const directory = knowledgeDir(request.provider, id);
      await mkdir(directory, { recursive: true });
      if (!existsSync(join(directory, 'request.json'))) await save(join(directory, 'request.json'), request);
    }
  }

  async function update(id, values, heartbeat = false) {
    const next = { ...states.get(id), ...values, ...(heartbeat ? { heartbeatAt: stamp() } : {}), updatedAt: stamp() };
    states.set(id, next);
    const previous = pendingWrites.get(id) || Promise.resolve();
    const write = previous.catch(() => {}).then(() => save(statusPath(id), next));
    pendingWrites.set(id, write);
    try { await write; } finally {
      if (pendingWrites.get(id) === write) pendingWrites.delete(id);
    }
  }

  async function deliver(id, payload) {
    const artifacts = await files(join(taskDir(id), 'workspace', 'artifacts'));
    const result = { ...payload, artifacts, completedAt: stamp() };
    await save(resultPath(id), result);
    await update(id, { ...result, state: 'completed' }, true);
  }

  async function restoreJob(id) {
    const status = await optional(statusPath(id));
    if (status?.state === 'completed') return;

    const result = await optional(resultPath(id)).catch((error) => {
      if (!(error instanceof SyntaxError)) throw error;
      report(error);
    });
    if (result && typeof result.text === 'string' && Array.isArray(result.artifacts)) {
      const job = status ?? await read(join(taskDir(id), 'task.json'));
      states.set(id, status ?? { id, source: job.source, ...taskRoute(job) });
      const completedAt = result.completedAt ?? (await lstat(resultPath(id))).mtime.toISOString();
      await update(id, { ...result, completedAt, state: 'completed', error: undefined }, true);
      return;
    }

    if (!status) {
      const job = await read(join(taskDir(id), 'task.json'));
      startJob(job, { id, source: job.source, ...taskRoute(job) });
      return;
    }
    if (terminal.includes(status.state)) return;
    states.set(id, status);
    if (['queued', 'preparing_network', 'waiting_network', 'starting_gpt', 'running'].includes(status.state) && !status.threadId) {
      startJob(await read(join(taskDir(id), 'task.json')));
    } else if (status.mode === 'codex') {
      await update(id, { state: 'interrupted', error: '监听器上次退出时任务已启动，请检查会话链接' }, true);
    }
  }

  function noteProgress(id, { stage, summary }) {
    const previous = progressByJob.get(id) ?? states.get(id)?.progress;
    const last = previous?.events.at(-1);
    if (last?.stage === stage && last.summary === summary) return;
    const sequence = (previous?.sequence ?? 0) + 1;
    progressByJob.set(id, {
      sequence, events: [...(previous?.events ?? []), { sequence, stage, summary, at: stamp() }].slice(-4),
    });
  }

  function startJob(job, status = {}) {
    if (closing || active.has(job.id)) return;
    const execution = {};
    active.set(job.id, execution);
    execution.done = runJob(job, execution, status).catch(report).finally(() => active.delete(job.id));
  }

  function closeExecution(execution) {
    const { codex } = execution;
    execution.codex = undefined;
    codex?.close();
  }

  async function runJob(job, execution, status) {
    const { id } = job;
    let generation;
    let codexReady = false;
    let network;
    const startupFailures = [...(states.get(id)?.startupFailures ?? [])];
    const startupChecks = [...(states.get(id)?.startupChecks ?? [])];
    function recordStartupFailure(error, attempt) {
      startupFailures.push({ attempt, method: error.rpcMethod, code: error.rpcCode,
        elapsedMs: error.elapsedMs, error: errorText(error), at: stamp() });
    }
    try {
      const selection = taskSelection(job.prompt, job.selection);
      await update(id, { ...status, state: 'preparing_network' }, true);
      const cwd = join(taskDir(id), 'workspace');
      const prompt = [
        job.prompt, '', '工作台任务 ID ' + id + '，派单方 ' + job.source + '。',
        '使用当前工作目录的 inputs 作为任务附件来源。把要交付的用户文件全部放进 artifacts。',
        '如果任务明确授权查询工作台知识库，使用工作台技能；只把回复用于本任务，不写入跨任务记忆。',
        '对长任务，在重要节点用公开进度消息简报已完成的工作、下一步或实际阻塞。',
        '完成时直接给出可原样转发的简明结果。',
      ].join('\n');
      let checked = await checkRoute();
      for (let attempt = Math.min(startupFailures.length + 1, 2); attempt <= 2; attempt += 1) {
        while (!closing && checked.network.latency === null) {
          await update(id, { network: checked.network, state: 'waiting_network' });
          await sleep(networkRetryMs, undefined, { ref: false, signal: shutdown.signal });
          checked = await checkRoute();
        }
        if (closing) return;
        ({ network, generation } = checked);
        await update(id, { network, state: 'starting_gpt', startupAttempt: attempt, startupStep: undefined });
        if (closing) return;
        const codex = execution.codex = new DesktopCodex(codexExecutable, cwd, checked.proxy);
        codex.on('rpc', (check) => {
          if (closing || !startupObservedMethods.has(check.method)) return;
          const step = { ...check, attempt };
          if (step.state !== 'running') startupChecks.push(step);
          void update(id, { startupStep: step, startupChecks: startupChecks.slice(-12) }).catch(report);
        });
        let result;
        try {
          await codex.init();
          codexReady = true;
          if (closing) return;
          result = await codex.run({
            cwd, title: '工作台 · ' + job.title, prompt, timeout: config.taskTimeoutMinutes * 60000,
            ...selection,
            historySectionId: providers.includes(job.source) ? config.historySectionId : undefined,
            progress: (event) => noteProgress(id, event),
            started: async (threadId, metadata) => {
              await update(id, {
                threadId, chatLink: relativeLink(threadId), ...metadata, sessionMetadataSource: 'codex_app_server',
              });
              execution.handlingTurn = true;
            },
            turnStarted: (turnId) => update(id, { turnId, state: 'running', startedAt: stamp() }, true),
          });
        } catch (error) {
          if (!startupObservedMethods.has(error.rpcMethod)) throw error;
          recordStartupFailure(error, attempt);
          if (closing || attempt > 1 || !startupMethods.has(error.rpcMethod) || !startupRetryable(error)) throw error;
          closeExecution(execution);
          codexReady = false;
          await update(id, { startupFailures: [...startupFailures], state: 'preparing_network' }, true);
          checked = await checkRoute(generation);
          continue;
        }
        execution.handlingTurn = false;
        const quota = await codex.readQuota();
        await deliver(id, { ...result, chatLink: relativeLink(result.threadId), quota,
          ...(progressByJob.has(id) ? { progress: progressByJob.get(id) } : {}) });
        return;
      }
    } catch (error) {
      execution.handlingTurn = false;
      if (closing) return;
      if (generation !== undefined && !startupMethods.has(error.rpcMethod)
        && (connectionError.test(errorText(error)) || workspaceRoutingTimeout.test(errorText(error)))) {
        ({ network } = await checkRoute(generation));
      }
      if (closing) return;
      const quota = codexReady && execution.codex ? await execution.codex.readQuota() : undefined;
      if (closing) return;
      await update(id, { state: 'failed', error: errorText(error),
        ...(network ? { network } : {}),
        ...(startupFailures.length ? { startupFailures: [...startupFailures] } : {}),
        ...(quota !== undefined ? { quota } : {}),
        ...(progressByJob.has(id) ? { progress: progressByJob.get(id) } : {}) }, true);
    } finally {
      progressByJob.delete(id);
      closeExecution(execution);
    }
  }

  async function monitorRoute() {
    const working = [...active].filter(([, execution]) => execution.handlingTurn);
    if (closing || routeCheck || !working.length) return;
    const { network } = await checkRoute();
    if (closing || network.state === 'healthy') return;
    await Promise.all(working.map(async ([id, execution]) => {
      if (execution.handlingTurn) await update(id, { network }).catch(report);
    }));
  }

  async function accept(id) {
    const from = join(inbox, id);
    const job = await read(join(from, 'task.json'));
    if (job.id !== id || job.target !== 'gpt' || !sources.includes(job.source)
      || !['codex', 'work'].includes(job.mode) || typeof job.prompt !== 'string'
      || !job.prompt.trim() || typeof job.title !== 'string' || job.prompt.length > 512000) return;
    await rename(from, taskDir(id));
    startJob(job, { id, source: job.source, ...taskRoute(job), acceptedAt: stamp() });
  }

  async function scan() {
    if (closing) return;
    if (scanActive) { rescan = true; return; }
    scanActive = true;
    try {
      do {
        rescan = false;
        for (const id of await readdir(inbox)) {
          if (closing) break;
          if (idPattern.test(id)) await accept(id).catch(report);
        }
      } while (rescan && !closing);
    } finally {
      scanActive = false;
    }
  }

  async function heartbeat(sendBeat = true) {
    if (closing || heartbeatActive) return;
    heartbeatActive = true;
    try {
      for (const [id, status] of states) {
        if (terminal.includes(status.state)) continue;
        await relayKnowledge(id).catch(report);
        if (status.mode === 'work') {
          const claimed = status.state === 'awaiting_work'
            ? await reserveAutomaticWork(id) : await optional(workReservation(id));
          if (claimed?.action === 'dispatch_codex' && status.state === 'awaiting_work') {
            const job = await read(join(taskDir(id), 'task.json'));
            startJob(job, taskRoute(job));
            continue;
          }
          if (claimed) {
            const metadata = await optional(join(handoffDir(id), 'work-progress.json')) || {};
            const changed = status.state === 'awaiting_work' ||
              ['model', 'reasoningEffort', 'chatLink'].some((key) =>
                metadata[key] !== undefined && metadata[key] !== status[key]);
            if (changed) {
              const { model, reasoningEffort, chatLink } = metadata;
              await update(id, { state: 'running_work', startedAt: claimed.claimedAt,
                model, reasoningEffort, chatLink, sessionMetadataSource: 'work_session_report' });
            }
          }
          const result = await optional(join(handoffDir(id), 'work-output.json'));
          if (result) { await deliver(id, result); continue; }
        }
        if (!sendBeat) continue;
        const peer = await optional(peerPath(id));
        if (terminal.includes(states.get(id)?.state)) continue;
        await update(id, {
          ...(peer ? { peerAcknowledgedAt: peer.acknowledgedAt } : {}),
          ...(progressByJob.has(id) ? { progress: progressByJob.get(id) } : {}),
        }, true);
      }
    } finally {
      heartbeatActive = false;
    }
  }

  function report(error) { console.error(stamp(), errorText(error)); }
  let inboxWatch;
  let resultsWatch;
  let timer;
  let routeTimer;
  let finished;
  const stop = new Promise((resolveStop) => { finished = resolveStop; });
  const end = () => {
    closing = true;
    shutdown.abort();
    finished();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, end);
  try {
    for (const id of await readdir(jobs)) {
      if (!idPattern.test(id)) continue;
      await restoreJob(id).catch((error) => report(new Error(id + ' ' + errorText(error))));
    }
    inboxWatch = watch(inbox, () => void scan().catch(report));
    resultsWatch = watch(jobs, { recursive: true }, (_event, name) => {
      if (/[\\/]\.workbench[\\/].*\.json$/.test(String(name))) void heartbeat(false).catch(report);
    });
    inboxWatch.on('error', report);
    resultsWatch.on('error', report);
    timer = setInterval(() => {
      void scan().catch(report);
      void heartbeat().catch(report);
    }, heartbeatMs);
    routeTimer = setInterval(() => void monitorRoute().catch(report), networkRetryMs);
    console.log(stamp(), 'GPT 工作台正在监听', inbox);
    await heartbeat(false).catch(report);
    await scan();
    await stop;
  } finally {
    end();
    clearInterval(timer);
    clearInterval(routeTimer);
    inboxWatch?.close();
    resultsWatch?.close();
    for (const execution of active.values()) closeExecution(execution);
    await Promise.allSettled([...active.values()].map(({ done }) => done));
    await releaseListener();
  }
}

try {
  const [command, ...argv] = process.argv.slice(2);
  const { values: args } = parseArgs({
    args: argv,
    options: Object.fromEntries([
      ...['source', 'mode', 'title', 'prompt-file', 'id', 'seconds', 'after-progress', 'after-state', 'provider', 'job', 'reply-file', 'chat-link', 'model', 'effort', 'state']
        .map((name) => [name, { type: 'string' }]),
      ['input', { type: 'string', multiple: true }],
      ['check-session', { type: 'boolean' }],
    ]),
  });
  const seconds = Math.min(Math.max(Number(args.seconds) || 25, 1), 300);
  await Promise.all([inbox, jobs, staging, ...providers.map((provider) => join(kb, provider))]
    .map((path) => mkdir(path, { recursive: true })));
  switch (command) {
    case 'serve': await serve(); break;
    case 'submit': await submit(args); break;
    case 'status': emit(taskFeedback(await withDeliveryReceipt(await pendingStatus(args.id)))); break;
    case 'quota': emit({ quota: await currentQuota() }); break;
    case 'follow': emit(taskFeedback(await followJob(validId(args.id), seconds))); break;
    case 'delivery-report': await reportDelivery(args.id, args.source, args.state, args['reply-file']); break;
    case 'wait': {
      const after = args['after-progress'] === undefined ? undefined : Number(args['after-progress']);
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new Error('进度序号必须是非负整数');
      const afterState = args['after-state'];
      if (afterState !== undefined) known(afterState, Object.keys(phaseLabels));
      emit(taskFeedback(await waitForJob(validId(args.id), seconds, after, afterState)));
      break;
    }
    case 'knowledge-ask': await askKnowledge(args.provider, args.job, args['prompt-file'], seconds); break;
    case 'knowledge-wait': await waitForKnowledge(args.provider, args.id, seconds); break;
    case 'knowledge-next': emit(await knowledgeAvailable(args.provider, args.job)); break;
    case 'knowledge-reply': await answerKnowledge(args.provider, args.id, args['reply-file']); break;
    case 'work-report': await reportWork(args.id, args); break;
    case 'work-finish': await finishWork(args.id, args['reply-file'], args['chat-link']); break;
    case 'workbuddy-check':
      emit(await new WorkBuddyRecovery(config.workbuddy, join(data, 'workbuddy-check')).dispatch('check'));
      break;
    case 'doctor': {
      const check = {
        data, codexExeExists: isAbsolute(codexExecutable) && existsSync(codexExecutable), startupChecks: [],
      };
      try { check.lock = await optional(join(data, 'listener.lock')); }
      catch (error) { check.lockError = errorText(error); }
      const clash = new Clash(config.clash);
      let route;
      try {
        route = await clash.inspect();
        check.network = route.network;
        const version = await clash.connect();
        const group = await clash.call('/proxies/' + encodeURIComponent(config.clash.group));
        check.clash = { version: version.version, group: group.name, latency: route.network.latency };
      } catch (error) { check.clash = { error: errorText(error) }; }
      const app = new DesktopCodex(codexExecutable, root, route?.proxy);
      app.on('rpc', (step) => { if (step.state !== 'running') check.startupChecks.push(step); });
      try {
        await app.init();
        check.codexChatGPTLogin = true;
        if (args['check-session']) {
          await app.checkSession(root);
          check.sessionCreated = true;
        }
      } catch (error) {
        check.codexChatGPTLogin ??= false;
        if (args['check-session']) check.sessionCreated = false;
        check.codexError = errorText(error);
      } finally { app.close(); }
      emit(check);
      break;
    }
    default: throw new Error('命令可用 serve、doctor、workbuddy-check、submit、status、wait、follow、delivery-report、quota、knowledge-ask、knowledge-wait、knowledge-next、knowledge-reply、work-report、work-finish');
  }
} catch (error) {
  console.error(errorText(error));
  process.exitCode = 1;
}
