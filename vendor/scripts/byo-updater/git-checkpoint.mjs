import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { UpdaterRefusal } from './refusal.mjs';

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function fixed(message) {
  return new Error(message);
}

function runGit(repository, args, exec = execFile) {
  return new Promise((resolvePromise, reject) => {
    exec(
      'git',
      ['-C', repository, ...args],
      // Every git call is bounded: `ls-remote` and `push` reach GitHub.
      { env: { PATH: process.env.PATH, LANG: 'C' }, timeout: 60_000, killSignal: 'SIGKILL' },
      (error, stdout) => {
        if (error) reject(fixed('durable Git checkpoint failed'));
        else resolvePromise(String(stdout).trim());
      },
    );
  });
}

export function pushWithLease({ git, repository, remoteRef, expectedHead }) {
  return git(repository, [
    'push',
    `--force-with-lease=${remoteRef}:${expectedHead}`,
    'origin',
    `HEAD:${remoteRef}`,
  ]);
}

async function assertLayout(repository, stateDirectory) {
  const repo = resolve(repository);
  const state = resolve(stateDirectory);
  const path = relative(repo, state).split(sep).join('/');
  if (path !== '.kinjot/deployment') throw fixed('durable state path must be .kinjot/deployment');
  const repoStat = await lstat(repo);
  const stateParent = dirname(state);
  await mkdir(stateParent, { recursive: true, mode: 0o700 }).catch(() => {
    throw fixed('checkpoint paths are invalid');
  });
  const parentStat = await lstat(stateParent);
  if (!repoStat.isDirectory() || !parentStat.isDirectory())
    throw fixed('checkpoint paths are invalid');
  if ((await realpath(repo)) !== repo || (await realpath(stateParent)) !== stateParent) {
    throw fixed('checkpoint paths must not traverse symlinks');
  }
  return { repo, path };
}

function allowedPath(path, sequence) {
  return (
    path === '.kinjot/deployment/deployment-state.json' ||
    path.startsWith(`.kinjot/deployment/control/${sequence}/`)
  );
}

export class GitCheckpointStore {
  constructor({ repository, stateDirectory, branch, expectedHead, localStore, git = runGit }) {
    if (!BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/')) {
      throw fixed('checkpoint branch is invalid');
    }
    if (!COMMIT.test(expectedHead)) throw fixed('checkpoint expected head is invalid');
    if (typeof localStore?.read !== 'function' || typeof localStore?.write !== 'function') {
      throw fixed('checkpoint local store is invalid');
    }
    this.repository = repository;
    this.stateDirectory = stateDirectory;
    this.branch = branch;
    this.expectedHead = expectedHead;
    this.localStore = localStore;
    this.git = git;
  }

  read() {
    return this.localStore.read();
  }

  async write(state) {
    const { repo, path } = await assertLayout(this.repository, this.stateDirectory);
    const remoteRef = `refs/heads/${this.branch}`;
    const observed = (await this.git(repo, ['ls-remote', '--refs', 'origin', remoteRef])).split(
      /\s+/,
    )[0];
    if (observed !== this.expectedHead) throw new UpdaterRefusal('configuration_branch_moved');
    const written = await this.localStore.write(state);
    const sequence = written.updaterControl?.sequence;
    const paths = [`${path}/deployment-state.json`];
    if (sequence) paths.push(`${path}/control/${sequence}`);
    await this.git(repo, ['add', '--', ...paths]);
    const staged = (await this.git(repo, ['diff', '--cached', '--name-only', '-z']))
      .split('\0')
      .filter(Boolean);
    if (staged.some((entry) => !allowedPath(entry, sequence))) {
      throw fixed('checkpoint staged an unexpected path');
    }
    if (staged.length === 0) return written;
    await this.git(repo, [
      '-c',
      'user.name=Kinjot updater',
      '-c',
      'user.email=updater@invalid',
      'commit',
      '-m',
      `Record deployment checkpoint sequence ${written.attempt?.target.sequence ?? written.installedRelease?.sequence}`,
      '--',
      ...paths,
    ]);
    const commit = await this.git(repo, ['rev-parse', 'HEAD']);
    const beforePush = (await this.git(repo, ['ls-remote', '--refs', 'origin', remoteRef])).split(
      /\s+/,
    )[0];
    if (beforePush !== this.expectedHead) throw new UpdaterRefusal('configuration_branch_moved');
    try {
      await pushWithLease({
        git: this.git,
        repository: repo,
        remoteRef,
        expectedHead: this.expectedHead,
      });
    } catch {
      throw new UpdaterRefusal('configuration_push_rejected');
    }
    this.expectedHead = commit;
    return written;
  }
}
