import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clash } from '../network.mjs';
import { WorkBuddyRecovery } from '../workbuddy-recovery.mjs';

const spawn = childProcess.spawn;
const fake = fileURLToPath(new URL('./fake-app.mjs', import.meta.url));
const timeOffset = join(process.env.GPT_WORKBENCH_DATA, 'clock-offset');
const now = Date.now;
Date.now = () => now() + (existsSync(timeOffset) ? Number(readFileSync(timeOffset, 'utf8')) : 0);
childProcess.spawn = (exe, args, options) => args[0] === 'app-server'
  ? spawn(process.execPath, [fake], options)
  : spawn(exe, args, options);
syncBuiltinESMExports();
Clash.prototype.inspect = async () => {
  const offline = existsSync(join(process.env.GPT_WORKBENCH_DATA, 'offline'));
  return { network: { state: offline ? 'unreachable' : 'healthy', latency: offline ? null : 1 } };
};
WorkBuddyRecovery.prototype.dispatch = async () => ({ network: { state: 'unreachable' } });
