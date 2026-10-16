import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { instanceConfigBytes } from './license-lifecycle.mjs';

const COMMIT = /^[a-f0-9]{40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const CONFIG_PATH = '.kinjot/instance.json';

function checkpointMessage(value) {
  if (value === null) return 'Unlink Kinjot release instance';
  if (value.status === 'linked' && value.phase === 'active') return 'Link Kinjot release instance';
  const operation = value.status === 'unlinking' ? 'unlink' : 'link';
  return `Record Kinjot release instance ${operation} progress (${value.phase})`;
}

function fixed(code = 'checkpoint_failed') {
  return Object.assign(new Error('instance configuration checkpoint failed'), {
    code: 'instance_checkpoint_failed',
    checkpointOutcome: code,
  });
}

function runGit(repository, args, exec = execFile) {
  return new Promise((accept, reject) => {
    exec(
      'git',
      ['-C', repository, ...args],
      { env: { PATH: process.env.PATH, LANG: 'C' } },
      (error, stdout) => (error ? reject(fixed()) : accept(String(stdout).trim())),
    );
  });
}

export class GitInstanceStore {
  constructor({ repository, branch, expectedHead, git = runGit }) {
    if (!BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/')) throw fixed();
    if (!COMMIT.test(expectedHead)) throw fixed();
    this.repository = resolve(repository);
    this.branch = branch;
    this.expectedHead = expectedHead;
    this.git = git;
  }

  async read() {
    const path = join(this.repository, CONFIG_PATH);
    const stat = await lstat(path).catch(() => null);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(path)) !== path) throw fixed();
    const bytes = await readFile(path);
    if (bytes.byteLength > 4096) throw fixed();
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
      if (!bytes.equals(instanceConfigBytes(value))) throw new Error();
    } catch {
      throw fixed();
    }
    return value;
  }

  async remoteHead() {
    const ref = `refs/heads/${this.branch}`;
    return String(await this.git(this.repository, ['ls-remote', '--refs', 'origin', ref])).split(
      /\s+/,
    )[0];
  }

  async assertExpectedHead() {
    if ((await this.remoteHead()) !== this.expectedHead) throw fixed('competing_head');
  }

  async pushCommit(commit) {
    try {
      await this.git(this.repository, ['push', 'origin', `HEAD:refs/heads/${this.branch}`]);
    } catch {
      let observed;
      try {
        observed = await this.remoteHead();
      } catch {
        throw fixed('push_unresolved');
      }
      if (observed !== commit) {
        throw fixed(observed === this.expectedHead ? 'push_rejected' : 'competing_head');
      }
    }
    this.expectedHead = commit;
  }

  async checkpoint(value) {
    await this.assertExpectedHead();
    const path = join(this.repository, CONFIG_PATH);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (value === null) {
      await unlink(path).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    } else {
      const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, instanceConfigBytes(value), { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    await this.git(this.repository, ['add', '--', CONFIG_PATH]);
    const staged = String(
      await this.git(this.repository, ['diff', '--cached', '--name-only', '-z']),
    )
      .split('\0')
      .filter(Boolean);
    if (staged.some((entry) => entry !== CONFIG_PATH)) throw fixed();
    if (!staged.length) {
      const commit = String(await this.git(this.repository, ['rev-parse', 'HEAD']));
      const observed = await this.remoteHead();
      if (observed === commit) {
        this.expectedHead = commit;
        return value;
      }
      if (observed !== this.expectedHead) throw fixed('competing_head');
      if (commit !== this.expectedHead) await this.pushCommit(commit);
      return value;
    }
    await this.git(this.repository, [
      '-c',
      'user.name=Kinjot updater',
      '-c',
      'user.email=updater@invalid',
      'commit',
      '-m',
      checkpointMessage(value),
      '--',
      CONFIG_PATH,
    ]);
    const commit = String(await this.git(this.repository, ['rev-parse', 'HEAD']));
    await this.assertExpectedHead();
    await this.pushCommit(commit);
    return value;
  }
}
