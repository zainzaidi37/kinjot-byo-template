import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { createDatabaseAdapter } from '../byo-doctor/database.mjs';
import { REQUIRED_FUNCTIONS } from '../byo-doctor/doctor.mjs';
import { sha256File } from '../byo-release/manifest.mjs';
import { createDatabaseApply } from './database-apply.mjs';
import { ensureOperatorWorkDirectory } from './operator-workspace.mjs';
import { isolatedCliEnvironment, runBoundedProcess } from './safe-process.mjs';
import { UpdaterRefusal } from './refusal.mjs';

function fixedError(message) {
  return new Error(message);
}

async function boundedJson(response, reason) {
  if (!response?.ok) throw new UpdaterRefusal(reason);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > 1024 * 1024) {
    throw new UpdaterRefusal(reason);
  }
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader?.();
  if (!reader) throw new UpdaterRefusal(reason);
  const cancel = () => {
    try {
      void Promise.resolve(reader.cancel()).catch(() => {});
    } catch {
      // A hostile stream cannot delay or replace the fixed refusal.
    }
  };
  let reads = 0;
  while (true) {
    reads++;
    if (reads > 1024) {
      cancel();
      throw new UpdaterRefusal(reason);
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (value.byteLength === 0) continue;
    size += value.byteLength;
    if (size > 1024 * 1024) {
      cancel();
      throw new UpdaterRefusal(reason);
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks, size);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new UpdaterRefusal(reason);
  }
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, reason) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => fetchImpl(url, { ...options, signal: controller.signal }))
        .then((response) => boundedJson(response, reason)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new UpdaterRefusal(reason));
        }, timeoutMs);
      }),
    ]);
  } catch {
    throw new UpdaterRefusal(reason);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A bounded Management API call whose result is the status alone.
 *
 * `fetchWithTimeout` above parses a JSON body, and the secrets endpoint can
 * answer `201` with no body at all — parsing that would turn a success into a
 * refusal. Same deadline, same abort, same fixed refusal; the body is drained
 * and cancelled rather than read, so a hostile or endless stream cannot hold
 * the update open.
 */
async function sendWithTimeout(fetchImpl, url, options, timeoutMs, reason) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => fetchImpl(url, { ...options, signal: controller.signal }))
        .then((response) => {
          try {
            void Promise.resolve(response?.body?.cancel?.()).catch(() => {});
          } catch {
            // A hostile stream cannot delay or replace the fixed refusal.
          }
          if (!response?.ok) throw new UpdaterRefusal(reason);
          return true;
        }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new UpdaterRefusal(reason));
        }, timeoutMs);
      }),
    ]);
  } catch {
    throw new UpdaterRefusal(reason);
  } finally {
    clearTimeout(timer);
  }
}

function versions(manifest) {
  return manifest.migrations.map((name) => name.slice(0, 14));
}

function compareHistory(manifest, applied) {
  const available = versions(manifest);
  let valid = false;
  try {
    valid =
      Array.isArray(applied) &&
      !applied.some((version) => typeof version !== 'string' || !/^\d{14}$/.test(version)) &&
      new Set(applied).size === applied.length;
  } catch {
    // A provider-controlled result is never allowed to replace the fixed refusal.
  }
  if (!valid) {
    throw new UpdaterRefusal('database_history_mismatch');
  }
  try {
    const remoteOnly = applied.filter((version) => !available.includes(version));
    if (remoteOnly.length) throw new UpdaterRefusal('database_history_mismatch');
    return {
      available,
      applied,
      pending: available.filter((version) => !applied.includes(version)),
    };
  } catch {
    throw new UpdaterRefusal('database_history_mismatch');
  }
}

function hasErrorCode(error, code) {
  try {
    return error?.code === code;
  } catch {
    return false;
  }
}

async function readMigrationHistory(database) {
  try {
    return await database.read('migrations');
  } catch (error) {
    if (hasErrorCode(error, 'missing_prerequisite')) return [];
    throw new UpdaterRefusal('database_history_unavailable');
  }
}

function renderTomlString(value) {
  if (/["\\\0\r\n]/.test(value)) throw fixedError('approved config placeholder value is invalid');
  return value;
}

async function renderConfig(root, config) {
  const path = join(root, 'supabase', 'config.toml');
  let text = await readFile(path, 'utf8');
  // Old signed releases carry these Auth placeholders. The updater never runs
  // `supabase config push`; fixed loopback values keep local CLI parsing valid
  // without implying that this temporary file configures the remote project.
  const replacements = new Map([
    ['{{ SUPABASE_PROJECT_ID }}', config.projectRef],
    ['{{ SITE_URL }}', 'http://127.0.0.1'],
    ['{{ AUTH_CALLBACK_URL }}', 'http://127.0.0.1/auth/callback'],
  ]);
  for (const [placeholder, value] of replacements) {
    if (text.split(placeholder).length !== 2)
      throw fixedError('release config placeholder contract is invalid');
    text = text.replace(placeholder, renderTomlString(value));
  }
  if (/\{\{ (?:SUPABASE_PROJECT_ID|SITE_URL|AUTH_CALLBACK_URL) \}\}/.test(text)) {
    throw fixedError('release config contains an unrendered approved placeholder');
  }
  await writeFile(path, text, { mode: 0o600 });
}

async function assertCopiedIdentity(packageRoot, workingRoot, manifest, components) {
  for (const entry of manifest.files.filter((file) => components.has(file.component))) {
    const source = await sha256File(join(packageRoot, ...entry.path.split('/')));
    const copy = await sha256File(join(workingRoot, ...entry.path.split('/')));
    if (
      source.sha256 !== entry.sha256 ||
      copy.sha256 !== entry.sha256 ||
      source.size !== entry.size ||
      copy.size !== entry.size
    ) {
      throw fixedError('isolated release working copy failed identity verification');
    }
  }
}

async function withWorkingCopy(config, packageRoot, manifest, components, operation) {
  const parent = await ensureOperatorWorkDirectory(config.stateDirectory);
  const root = await mkdtemp(join(parent, '.apply-'));
  try {
    if (components.has('migrations') || components.has('functions') || components.has('config')) {
      await cp(join(packageRoot, 'supabase'), join(root, 'supabase'), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
      });
      await assertCopiedIdentity(
        packageRoot,
        root,
        manifest,
        new Set(['migrations', 'functions', 'config', 'templates']),
      );
      await renderConfig(root, config);
    }
    if (components.has('web')) {
      await cp(join(packageRoot, 'dist'), join(root, 'dist'), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
      });
      await assertCopiedIdentity(packageRoot, root, manifest, new Set(['web']));
    }
    const home = join(root, '.operator-home');
    await mkdir(home, { mode: 0o700 });
    return await operation(root, home);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function createUpdaterAdapters(config, dependencies = {}) {
  const runProcess = dependencies.runProcess ?? runBoundedProcess;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const database =
    dependencies.database ??
    (() => {
      const readDatabase =
        dependencies.readDatabase ??
        createDatabaseAdapter({
          databaseUrl: config.databaseUrl,
          // Doctor's read adapter deliberately caps a single database probe at
          // 60 seconds. The operator timeout may remain longer for migrations,
          // function deploys, and Pages publication.
          timeoutMs: Math.min(config.timeoutMs, 60_000),
          spawnImpl: (_command, args, options) => {
            const { PATH: _ambientPath, ...env } = options.env;
            return (dependencies.spawnImpl ?? spawn)(config.executables.psql, args, {
              ...options,
              env,
            });
          },
        });
      return createDatabaseApply({ config, readDatabase, runProcess });
    })();

  async function readSupabaseFunctions() {
    const functions = await fetchWithTimeout(
      fetchImpl,
      `https://api.supabase.com/v1/projects/${config.projectRef}/functions`,
      { headers: { Authorization: `Bearer ${config.managementToken}` } },
      config.timeoutMs,
      'supabase_management_access',
    );
    if (!Array.isArray(functions)) throw new UpdaterRefusal('supabase_management_access');
    return functions;
  }

  async function readPagesProject() {
    if (config.mode !== 'full') return;
    const pages = await fetchWithTimeout(
      fetchImpl,
      `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/pages/projects/${config.pagesProject}`,
      { headers: { Authorization: `Bearer ${config.cloudflareToken}` } },
      config.timeoutMs,
      'pages_project_prerequisite',
    );
    if (
      pages?.success !== true ||
      pages?.result?.name !== config.pagesProject ||
      pages?.result?.production_branch !== config.pagesBranch
    ) {
      throw new UpdaterRefusal('pages_project_prerequisite');
    }
  }

  /**
   * Tell the deployed functions which release they are, for the client-side
   * release handshake (`apps/web/src/data/release-handshake.ts`).
   *
   * The schema axis has the compatibility epoch and CI's N−1 migration replay;
   * the frontend ↔ Edge Function axis had nothing, because `byo.kinjot.com`
   * serves catalog head to a backend the operator updates by hand. One
   * function (`usage-limits`) reports this value in a response header and the
   * client says "run update" when it is behind.
   *
   * Via the Management API, never `supabase secrets set`: that CLI command
   * pushes `config.toml`'s mock values over a project's real secrets and is
   * banned repo-wide. This runs after a successful deploy, so the value never
   * claims a release that did not ship.
   *
   * It reuses `supabase_management_access` rather than introducing a new
   * refusal reason. Constructing one would work — the control is imported
   * in-process (`customer-cli.mjs`), so the *control's* `refusal.mjs` builds
   * the error and nothing throws. The cost is at the other end: an operator
   * whose `vendor/` predates the new reason normalizes it to `null` and prints
   * the generic "run doctor" line instead of the specific one, and nothing ever
   * refreshes `vendor/`.
   */
  async function publishReleaseSequence(manifest) {
    const sequence = manifest?.release?.sequence;
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw fixedError('release sequence is invalid');
    }
    await sendWithTimeout(
      fetchImpl,
      `https://api.supabase.com/v1/projects/${config.projectRef}/secrets`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.managementToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify([{ name: 'KINJOT_RELEASE_SEQUENCE', value: String(sequence) }]),
      },
      config.timeoutMs,
      'supabase_management_access',
    );
  }

  return Object.freeze({
    async preflightTarget({ mode }) {
      if (mode !== config.mode) throw new UpdaterRefusal('mode_mismatch');
      try {
        await database.read('migrations');
      } catch (error) {
        if (!hasErrorCode(error, 'missing_prerequisite')) {
          throw new UpdaterRefusal('database_history_unavailable');
        }
      }
      await readSupabaseFunctions();
      await readPagesProject();
    },

    async preflight({ manifest, mode }) {
      if (mode !== config.mode) throw new UpdaterRefusal('mode_mismatch');
      const applied = await readMigrationHistory(database);
      const history = compareHistory(manifest, applied);
      let databaseEpoch = null;
      try {
        databaseEpoch = await database.read('epoch');
      } catch (error) {
        if (!hasErrorCode(error, 'missing_prerequisite'))
          throw new UpdaterRefusal('database_epoch_unavailable');
      }
      let emptyBackend = false;
      if (databaseEpoch === null) {
        try {
          emptyBackend = await database.emptyAppSchema();
        } catch {
          throw new UpdaterRefusal('database_history_unavailable');
        }
      }
      await readSupabaseFunctions();
      await readPagesProject();
      return {
        databaseEpoch,
        emptyBackend,
        appliedMigrations: history.applied,
        pendingMigrations: history.pending,
      };
    },

    async applyMigrations({ packageRoot, manifest }) {
      const before = compareHistory(manifest, await readMigrationHistory(database));
      await database.rehearse({ packageRoot, manifest, applied: before.applied });
      await withWorkingCopy(
        config,
        packageRoot,
        manifest,
        new Set(['migrations', 'config']),
        async (root, home) => {
          await runProcess({
            executable: config.executables.supabase,
            args: [
              'db',
              'push',
              '--db-url',
              config.database.passwordlessUrl,
              '--include-all',
              '--yes',
            ],
            cwd: root,
            env: isolatedCliEnvironment(home, { PGPASSWORD: config.database.password }),
            timeoutMs: config.timeoutMs,
            label: 'Supabase migration apply',
          });
        },
      );
      const after = compareHistory(manifest, await readMigrationHistory(database));
      if (after.pending.length)
        throw fixedError('Supabase migration apply left pending migrations');
      return { databaseEpoch: await database.read('epoch') };
    },

    async initializeBackend() {
      await database.initializeAndBackfill();
    },

    async deployFunctions({ packageRoot, manifest }) {
      // A minimum, matching the manifest validator: a release may add an Edge
      // Function, and an exact comparison here would refuse it after the
      // signature had already been checked. `REQUIRED_FUNCTIONS` remains the
      // floor a healthy deployment must carry.
      //
      // The slugs themselves are already shape-validated at the manifest
      // boundary (`FUNCTION_SLUG` in byo-release/manifest.mjs) and
      // `verifyPackage` has proved each one has a signed
      // `supabase/functions/<slug>/index.ts` behind it — which is what makes
      // the loop below safe to drive from data rather than a constant.
      const required = new Set(manifest.functions);
      if (REQUIRED_FUNCTIONS.some((slug) => !required.has(slug))) {
        throw fixedError('release function inventory is invalid');
      }
      await withWorkingCopy(
        config,
        packageRoot,
        manifest,
        new Set(['functions', 'config']),
        async (root, home) => {
          for (const slug of manifest.functions) {
            await runProcess({
              executable: config.executables.supabase,
              args: ['functions', 'deploy', slug, '--project-ref', config.projectRef, '--use-api'],
              cwd: root,
              env: isolatedCliEnvironment(home, {
                SUPABASE_ACCESS_TOKEN: config.managementToken,
              }),
              timeoutMs: config.timeoutMs,
              label: `Supabase function deployment: ${slug}`,
              diagnosticSecrets: [
                config.managementToken,
                config.database.password,
                config.cloudflareToken ?? '',
                config.cloudflareAccountId ?? '',
              ],
            });
          }
        },
      );
      await publishReleaseSequence(manifest);
    },

    async publishWeb({ packageRoot, manifest }) {
      if (config.mode !== 'full')
        throw fixedError('Pages publication is disabled in backend-only mode');
      await withWorkingCopy(config, packageRoot, manifest, new Set(['web']), async (root, home) => {
        await runProcess({
          executable: config.executables.wrangler,
          args: [
            'pages',
            'deploy',
            'dist',
            '--project-name',
            config.pagesProject,
            '--branch',
            config.pagesBranch,
            '--commit-hash',
            manifest.release.sourceCommit,
          ],
          cwd: root,
          env: isolatedCliEnvironment(home, {
            CLOUDFLARE_API_TOKEN: config.cloudflareToken,
            CLOUDFLARE_ACCOUNT_ID: config.cloudflareAccountId,
          }),
          timeoutMs: config.timeoutMs,
          label: 'Cloudflare Pages publication',
          diagnosticSecrets: [
            config.cloudflareToken,
            config.managementToken,
            config.database.password,
            config.cloudflareAccountId,
          ],
        });
      });
    },

    async backfill() {
      await database.backfill();
    },
  });
}
