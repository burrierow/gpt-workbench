import { execFile } from 'node:child_process';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./workbench.mjs', import.meta.url));
const source = 'qwenwork';
const supportedVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const idSchema = { type: 'string', pattern: '^[a-f0-9-]{36}$' };
const string = { type: 'string' };
const conversationFields = { scope: string, conversation: string };
const definitions = {
  migrate_gpt_chat: {
    description: '把用户选定的已有对话按 8,000 字符截尾，交给新的 GPT 会话继续。',
    inputSchema: {
      type: 'object', required: ['title'], additionalProperties: false,
      properties: { title: string, text: string, input: string, origin: string,
        ...conversationFields, event: string },
      oneOf: [{ required: ['text'] }, { required: ['input'] }],
    },
  },
  send_to_workbuddy_ima: {
    description: '在用户明确要求时，把原文、文件或千问办公派发的 GPT 产物交给 WorkBuddy 存入指定 ima 知识库。',
    inputSchema: {
      type: 'object', required: ['library', 'title'], additionalProperties: false,
      properties: { library: string, title: string, input: string, text: string, job: idSchema, origin: string },
    },
  },
  get_workbuddy_ima_status: {
    description: '查询转存状态和 WorkBuddy 的 ima 入库回执。',
    inputSchema: { type: 'object', required: ['id'], additionalProperties: false,
      properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
  },
  submit_gpt_task: {
    description: '明确派单时提交原任务。宿主提供稳定标识时可带 scope、conversation、event 接管或续接原会话。',
    inputSchema: {
      type: 'object', required: ['prompt'], additionalProperties: false,
      properties: { prompt: { ...string, minLength: 1, maxLength: 512000 }, title: string,
        inputs: { type: 'array', items: string }, mode: { enum: ['codex', 'work'] }, model: string, effort: string,
        ...conversationFields, event: string, takeover: { type: 'boolean' } },
    },
  },
  get_gpt_conversation: {
    description: '使用宿主提供的稳定来源标识查询 GPT 接管状态。',
    inputSchema: { type: 'object', required: ['scope', 'conversation'], additionalProperties: false,
      properties: conversationFields },
  },
  follow_gpt_task: {
    description: '按千问办公原任务 ID 等待 GPT。任务结果、文件路径和额度准备好后提前返回。',
    inputSchema: {
      type: 'object', required: ['id'], additionalProperties: false,
      properties: { id: idSchema, seconds: { type: 'integer', minimum: 1, maximum: 45, default: 30 } },
    },
  },
  report_gpt_delivery: {
    description: '记录千问办公任务的实际回传情况。渠道受理为 submitted，用户确认收到为 confirmed，发送失败为 failed。',
    inputSchema: {
      type: 'object', required: ['id', 'state'], additionalProperties: false,
      properties: { id: idSchema, state: { enum: ['submitted', 'confirmed', 'failed'] }, detail: string },
    },
  },
};

async function run(...args) {
  try {
    const { stdout } = await execute(process.execPath, [cli, ...args], {
      windowsHide: true, timeout: 65000, maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(error.stderr?.trim() || (error.killed ? '工作台命令超时' : '工作台命令失败'));
  }
}

async function withText(text, useFile) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 512000) {
    throw new Error('请提供 512 KB 以内的非空文本');
  }
  const directory = await mkdtemp(join(tmpdir(), 'qwenwork-gpt-'));
  const path = join(directory, 'message.txt');
  try {
    await writeFile(path, text, { mode: 0o600, flag: 'wx' });
    return await useFile(path);
  } finally {
    await rm(path, { force: true });
    await rmdir(directory);
  }
}

async function callTool(name, args) {
  if (name === 'migrate_gpt_chat') {
    if (typeof args.title !== 'string' || (args.origin !== undefined && typeof args.origin !== 'string')) {
      throw new Error('请填写会话标题和可选的文本来源标识');
    }
    if (args.input !== undefined && (args.text !== undefined || typeof args.input !== 'string' || !isAbsolute(args.input))) {
      throw new Error('请提供对话正文或本机绝对路径');
    }
    const command = ['migrate', '--source', source, '--title=' + args.title];
    if (args.origin) command.push('--origin=' + args.origin);
    const ids = Object.entries({ scope: args.scope, conversation: args.conversation, event: args.event });
    if (ids.some(([, value]) => value !== undefined)) {
      if (ids.some(([, value]) => typeof value !== 'string' || !value.trim())) {
        throw new Error('迁移并接管需要宿主提供的三个稳定标识');
      }
      command.push('--takeover', ...ids.map(([name, value]) => '--' + name + '=' + value));
    }
    return args.input === undefined
      ? withText(args.text, (file) => run(...command, '--context-file', file))
      : run(...command, '--context-file', args.input);
  }
  if (name === 'send_to_workbuddy_ima') {
    if (typeof args.library !== 'string' || typeof args.title !== 'string') throw new Error('请填写库名和标题');
    if (args.input !== undefined && (typeof args.input !== 'string' || !isAbsolute(args.input))) {
      throw new Error('附件必须使用本机绝对路径');
    }
    if (args.text !== undefined && (args.input !== undefined || args.job !== undefined)) {
      throw new Error('请提供原文或文件');
    }
    const command = ['ima-save', '--source', source, '--library=' + args.library, '--title=' + args.title,
      ...Object.entries({ origin: args.origin, job: args.job, input: args.input })
        .filter(([, value]) => value !== undefined).map(([key, value]) => '--' + key + '=' + value)];
    return args.text === undefined ? run(...command)
      : withText(args.text, (file) => run(...command, '--input', file));
  }
  if (name === 'get_workbuddy_ima_status') return run('ima-status', '--id=' + args.id);
  if (name === 'get_gpt_conversation') {
    if (typeof args.scope !== 'string' || typeof args.conversation !== 'string') {
      throw new Error('需要宿主提供的账号或工作区标识及稳定会话 ID');
    }
    return run('conversation-status', '--source', source, '--scope=' + args.scope, '--conversation=' + args.conversation);
  }
  if (name === 'submit_gpt_task') {
    const inputs = args.inputs ?? [];
    if (!Array.isArray(inputs) || inputs.some((path) => typeof path !== 'string' || !isAbsolute(path))) {
      throw new Error('附件必须使用本机绝对路径');
    }
    const { scope, conversation, event, takeover } = args;
    const relay = [scope, conversation, event, takeover].some((value) => value !== undefined);
    if (relay && (![scope, conversation, event].every((value) => typeof value === 'string' && value.trim()) ||
      (takeover !== undefined && typeof takeover !== 'boolean'))) {
      throw new Error('接管或跟进需要宿主提供的三个稳定标识');
    }
    const options = Object.entries({ title: args.title, mode: args.mode, model: args.model, effort: args.effort,
      scope, conversation, event });
    if (options.some(([, value]) => value !== undefined && typeof value !== 'string')) throw new Error('参数须为文本');
    const flags = options.filter(([, value]) => value !== undefined).map(([key, value]) => '--' + key + '=' + value);
    return withText(args.prompt, (path) => run(relay ? 'relay' : 'submit', '--source', source, '--prompt-file', path,
      ...flags, ...(takeover ? ['--takeover'] : []), ...inputs.map((file) => '--input=' + file)));
  }
  if (name === 'follow_gpt_task') {
    const seconds = args.seconds ?? 30;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 45) throw new Error('等待时间须为 1 至 45 秒');
    const status = await run('status', '--id=' + args.id);
    if (status.source !== source) throw new Error('未找到该千问办公任务');
    return run('follow', '--id=' + args.id, '--seconds=' + seconds);
  }
  if (name === 'report_gpt_delivery') {
    if (!['submitted', 'confirmed', 'failed'].includes(args.state)) throw new Error('交付状态无效');
    const command = ['delivery-report', '--id=' + args.id, '--source', source, '--state=' + args.state];
    return args.detail === undefined ? run(...command)
      : withText(args.detail, (path) => run(...command, '--reply-file', path));
  }
  throw new Error('未知工具');
}

function send(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async (line) => {
  let request;
  try { request = JSON.parse(line); } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    send({ id: null, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  if (!Object.hasOwn(request, 'id')) return;
  const { id, method, params } = request;
  let result;
  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    result = { protocolVersion: supportedVersions.includes(requested) ? requested : supportedVersions[0],
      capabilities: { tools: {} }, serverInfo: { name: 'gpt-workbench-qwenwork', version: '1.3.0' } };
  } else if (method === 'ping') {
    result = {};
  } else if (method === 'tools/list') {
    result = { tools: Object.entries(definitions).map(([name, definition]) => ({ name, ...definition })) };
  } else if (method === 'tools/call') {
    try {
      const value = await callTool(params?.name, params?.arguments ?? {});
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      result = { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  } else {
    send({ id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  send({ id, result });
});
