import { readFile, rename, writeFile } from 'node:fs/promises';
import { Clash } from './network.mjs';

const [mode, output] = process.argv.slice(2);
if (!['check', 'repair', 'force'].includes(mode) || !output) throw new Error('无效的 WorkBuddy 网络任务');
const { clash } = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
const controller = new Clash(clash);
let answer;
try {
  if (mode === 'check') {
    const version = await controller.connect();
    const { network } = await controller.inspect();
    answer = { network, version: version.version, checkOnly: true };
  } else {
    ({ network: answer } = await controller.prepare({ force: mode === 'force' }));
    answer = { network: answer };
  }
} catch (error) {
  answer = { error: String(error.message ?? error).slice(0, 500) };
}
const temporary = output + '.tmp';
await writeFile(temporary, JSON.stringify(answer), { flag: 'wx' });
await rename(temporary, output);
