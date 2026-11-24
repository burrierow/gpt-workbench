import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = process.env.GPT_WORKBENCH_DATA;
const emit = (value) => console.log(JSON.stringify(value));
let threadId;

createInterface({ input: process.stdin }).on('line', (line) => {
  const { method, params, id } = JSON.parse(line);
  if (id === undefined) return;
  const reply = (result) => emit({ id, result });
  const note = (method, params) => emit({ method, params });
  if (method === 'account/read') return reply({ account: { type: 'chatgpt' } });
  if (method === 'thread/start' || method === 'thread/resume') {
    threadId = params.threadId ?? randomUUID();
    if (method === 'thread/start') writeFileSync(join(root, threadId), '');
    else readFileSync(join(root, threadId));
    return reply({ thread: { id: threadId, status: { type: 'idle' } },
      model: params.model, reasoningEffort: params.config.model_reasoning_effort });
  }
  if (method !== 'turn/start') return reply({});
  const prompt = params.input[0].text.split('\n')[0];
  const turnId = randomUUID();
  const history = join(root, threadId);
  const prior = readFileSync(history, 'utf8');
  appendFileSync(history, prompt + '\n');
  reply({ turn: { id: turnId } });
  if (prompt === 'stall') return;
  if (prompt === 'fail') {
    note('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'fixture failure' } } });
    return;
  }
  setTimeout(() => {
    const text = JSON.stringify({ prompt, prior });
    writeFileSync(join(params.cwd, 'artifacts', 'answer.txt'), text);
    note('item/completed', { threadId, turnId, item: { type: 'agentMessage', phase: 'final_answer', text } });
    note('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  }, prompt === 'first' ? 500 : 20);
});
