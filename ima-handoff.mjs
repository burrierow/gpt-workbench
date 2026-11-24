import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const keyPattern = /^[a-f0-9]{64}$/;
const allowedFiles = new Set(['.md', '.txt', '.docx', '.pdf', '.srt', '.vtt']);
const time = () => new Date().toISOString();
const json = async (path) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const optional = async (path) => {
  try { return await json(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
};

function required(value, name, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f]/.test(value)) {
    throw new Error('请提供有效的' + name);
  }
  return value.trim();
}

export class ImaHandoff {
  constructor(directory) {
    this.directory = directory;
  }

  folder(id) {
    if (!keyPattern.test(id ?? '')) throw new Error('无效的 ima 转存 ID');
    return join(this.directory, id);
  }

  async status(id) {
    const folder = this.folder(id);
    const request = await json(join(folder, 'request.json'));
    const [claim, receipt] = await Promise.all(['claim', 'receipt'].map((name) => optional(join(folder, name, 'value.json'))));
    return { ...request, file: join(folder, request.file),
      state: receipt?.state ?? (claim ? 'processing' : 'queued'), claimedAt: claim?.claimedAt, receipt };
  }

  async submit({ source, library, libraryScope, title, input, origin, job }) {
    library = required(library, '目标 ima 知识库名称');
    title = required(title, '资料标题');
    if (origin !== undefined) origin = required(origin, '来源会话标识', 1000);
    if (typeof input !== 'string' || !isAbsolute(input) || !allowedFiles.has(extname(input).toLowerCase())) {
      throw new Error('请提供已生成的转写稿或文档的绝对路径，支持 md、txt、docx、pdf、srt、vtt');
    }
    const file = await lstat(input);
    if (!file.isFile() || file.size < 1 || file.size > 20 * 1024 * 1024) {
      throw new Error('转存文件必须是 20 MB 以内的非空普通文件');
    }
    await mkdir(this.directory, { recursive: true });
    const temp = await mkdtemp(join(this.directory, '.prepare-'));
    try {
      const name = basename(input);
      const copied = join(temp, name);
      await copyFile(input, copied);
      const bytes = await readFile(copied);
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('转存文件大小无效');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const destination = libraryScope ? [libraryScope, library] : [library];
      const id = createHash('sha256').update(JSON.stringify([...destination, sha256])).digest('hex');
      const folder = this.folder(id);
      await writeFile(join(temp, 'request.json'), JSON.stringify({ id, source, target: 'workbuddy', operation: 'ima.store',
        library, libraryScope, title, origin, job, file: name, sha256, createdAt: time() }), { flag: 'wx' });
      try { await rename(temp, folder); } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(error.code) ||
          !(await optional(join(folder, 'request.json')))) throw error;
      }
      return this.status(id);
    } finally {
      const path = await realpath(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      if (path) {
        const child = relative(await realpath(this.directory), path);
        if (child.startsWith('.prepare-') && !child.includes(sep)) await rm(path, { recursive: true });
      }
    }
  }

  async record(folder, name, value) {
    const temp = await mkdtemp(join(folder, '.record-'));
    const file = join(temp, 'value.json');
    try {
      await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
      await rename(temp, join(folder, name));
      return true;
    } catch (error) {
      if (['ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(error.code) &&
        (await optional(join(folder, name, 'value.json')))) return false;
      throw error;
    } finally {
      await rm(file, { force: true });
      await rmdir(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async next() {
    const entries = await readdir(this.directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    const jobs = await Promise.all(entries.filter((id) => keyPattern.test(id)).map((id) => this.status(id)));
    return jobs.filter((job) => job.state === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async claim(id) {
    const job = await this.status(id);
    if (job.state !== 'queued') throw new Error('转存任务已经被领取或结束');
    const token = randomUUID();
    if (!(await this.record(this.folder(id), 'claim', { token, claimedAt: time() }))) {
      throw new Error('转存任务已被另一位 WorkBuddy 执行者领取');
    }
    return { ...(await this.status(id)), claimToken: token };
  }

  async finish(id, token, replyFile) {
    const folder = this.folder(id);
    const claim = await optional(join(folder, 'claim', 'value.json'));
    if (!claim || claim.token !== token) throw new Error('转存回执需要对应的领取令牌');
    const previous = await optional(join(folder, 'receipt', 'value.json'));
    if (previous) return this.status(id);
    const reply = await json(replyFile);
    let receipt;
    if (reply.state === 'stored') {
      receipt = { state: 'stored', libraryId: required(reply.libraryId, 'ima 库 ID'),
        mediaId: required(reply.mediaId, 'ima 条目 ID'),
        ...(reply.url ? { url: required(reply.url, 'ima 条目链接', 1000) } : {}) };
    } else if (reply.state === 'blocked' || reply.state === 'needs_review') {
      receipt = { state: reply.state, error: required(reply.error, '转存阻塞原因', 1000) };
    } else {
      throw new Error('回执状态须为 stored、blocked 或 needs_review');
    }
    await this.record(folder, 'receipt', { ...receipt, finishedAt: time() });
    return this.status(id);
  }

  async follow(id, seconds) {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const job = await this.status(id);
      if (job.receipt || Date.now() >= deadline) return job;
      await sleep(500);
    }
  }
}
