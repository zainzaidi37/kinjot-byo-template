#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatProcessDiagnostic } from './safe-process.mjs';
import { runUpdate } from './updater.mjs';
import { createUpdaterAdapters } from './apply-adapters.mjs';
import { GitCheckpointStore } from './git-checkpoint.mjs';
import { MIGRATION_REPAIR_GUIDE, repairMigrationHistory } from './manual-operations.mjs';
import { validateOperatorConfig } from './operator-config.mjs';
import { acquireUpdateLock, FileStateStore } from './state.mjs';
import { updaterRefusalMessage } from './refusal.mjs';

const CLI_OPERATIONS = Object.freeze({
  preflight: 'preflight',
  'migration apply': 'migration apply',
  'backend initialization': 'backend initialization',
  'function deployment': 'function deployment',
  'web publication': 'web publication',
});
const CLI_MIGRATION_SQLSTATES = new Set([
  '23503',
  '23505',
  '23514',
  '28000',
  '28P01',
  '40001',
  '40P01',
  '42501',
  '42P01',
  '42P07',
  '42701',
  '42710',
  '42723',
  '42703',
  '42704',
  '42883',
  '55P03',
  '57014',
  'JN002',
]);
const RECOVERY_POINTER =
  'See "Recovering a failed run" in this repository\'s README (README.md#recovering-a-failed-run).';
// The command names a failure line may repeat; anything else is "updater".
const CLI_COMMANDS = new Set([
  'setup',
  'update',
  'link',
  'unlink',
  'backfill',
  'doctor',
  'repair-guide',
  'migration-repair',
]);

/**
 * `installed` is the caller's evidence that an authenticated installed release
 * exists, so `doctor` can run: `customer-cli.mjs` `doctor` refuses without one,
 * and only then does the line suggest it.
 */
export function formatCliFailure(error, command, { installed = false } = {}) {
  const name = CLI_COMMANDS.has(command) ? command : 'updater';
  const guidance =
    installed && command !== 'doctor'
      ? `Run doctor from the Kinjot deployment workflow to see the deployment's state. ${RECOVERY_POINTER}`
      : RECOVERY_POINTER;
  const genericFailure = `Kinjot ${name} failed. ${guidance}\n`;
  try {
    if (error?.code === 'license_recovery_required') {
      if (error.recoveryAction === 'unlink') {
        return 'Kinjot could not confirm the license deactivation, so the unlink is not finished. Its progress record stays in this repository. Run unlink again; it checks the same activation before it finishes.\n';
      }
      // A link recovery is resolved only by `link` (also inside `setup`); never
      // name `unlink`, whose `activation_pending` path refuses without asking
      // the provider (`customer-cli.mjs` `unlink`).
      const rerun = command === 'setup' ? 'setup' : 'link';
      return `Kinjot could not confirm whether this deployment's license activation went through, so it stopped without activating again. Run ${rerun}${command === rerun ? ' again' : ''}: it checks the license first, and links normally when no activation exists. If it stops here again, the license is activated somewhere: deactivate that activation in Lemon Squeezy's My Orders (https://app.lemonsqueezy.com/my-orders), then run ${rerun} again. If you know the activation's instance id, you can instead run link with it in license_instance_id.\n`;
    }
    const refusal = updaterRefusalMessage(error, command);
    if (refusal) return `${refusal}\n`;
    const candidateOperation = error?.operation;
    if (
      error?.code !== 'updater_operation_failed' ||
      typeof candidateOperation !== 'string' ||
      !Object.hasOwn(CLI_OPERATIONS, candidateOperation)
    ) {
      return genericFailure;
    }
    const operation = CLI_OPERATIONS[candidateOperation];
    const candidateSqlstate = error.sqlstate;
    const sqlstate =
      operation === 'migration apply' &&
      typeof candidateSqlstate === 'string' &&
      (CLI_MIGRATION_SQLSTATES.has(candidateSqlstate) ||
        (candidateSqlstate.length === 5 && /^KJ0[0-9]{2}$/.test(candidateSqlstate)))
        ? ` (SQLSTATE ${candidateSqlstate})`
        : '';
    const diagnostic =
      operation === 'function deployment' || operation === 'web publication'
        ? formatProcessDiagnostic(error)
        : '';
    return `Kinjot ${name} failed during ${operation}${sqlstate}. ${guidance}\n${diagnostic}`;
  } catch {
    return genericFailure;
  }
}

function argumentsMap(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error('invalid updater command arguments');
    }
    const name = argv[index].slice(2);
    if (Object.hasOwn(options, name)) throw new Error('duplicate updater command option');
    options[name] = argv[index + 1];
  }
  const allowed = {
    update: new Set(['archive', 'mode']),
    backfill: new Set(),
    'repair-guide': new Set(),
    'migration-repair': new Set(['version', 'status', 'confirm']),
  }[command];
  if (!allowed || Object.keys(options).some((name) => !allowed.has(name))) {
    throw new Error('invalid updater command arguments');
  }
  return { command, options };
}

export function configFromEnvironment(mode, databaseOnly = false) {
  return validateOperatorConfig(
    {
      databaseUrl: process.env.KINJOT_DATABASE_URL,
      projectRef: process.env.KINJOT_SUPABASE_PROJECT_REF,
      managementToken: process.env.SUPABASE_ACCESS_TOKEN,
      cloudflareToken: process.env.CLOUDFLARE_API_TOKEN,
      cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      pagesProject: process.env.KINJOT_PAGES_PROJECT,
      pagesBranch: process.env.KINJOT_PAGES_BRANCH || 'main',
      stateDirectory: resolve(process.env.KINJOT_UPDATER_STATE || '.kinjot-byo-state'),
      trustListPath: resolve(process.env.KINJOT_TRUST_LIST || 'release/trust-list.json'),
      executables: {
        psql: process.env.KINJOT_PSQL_BIN,
        supabase: process.env.KINJOT_SUPABASE_BIN,
        wrangler: process.env.KINJOT_WRANGLER_BIN,
      },
      timeoutMs: Number(process.env.KINJOT_UPDATE_TIMEOUT_MS || 120_000),
    },
    { mode, databaseOnly },
  );
}

export function checkpointStoreFromEnvironment(localStore, stateDirectory) {
  const repository = process.env.KINJOT_CHECKPOINT_REPOSITORY;
  const branch = process.env.KINJOT_CHECKPOINT_BRANCH;
  const expectedHead = process.env.KINJOT_CHECKPOINT_HEAD;
  const configured = [repository, branch, expectedHead].filter((value) => value !== undefined);
  if (configured.length === 0) return localStore;
  if (configured.length !== 3)
    throw new Error('durable Git checkpoint configuration is incomplete');
  return new GitCheckpointStore({
    repository,
    stateDirectory,
    branch,
    expectedHead,
    localStore,
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { command, options } = argumentsMap(argv);
  if (command === 'repair-guide') {
    process.stdout.write(`${MIGRATION_REPAIR_GUIDE}\n`);
    return;
  }
  const databaseOnly = command === 'backfill' || command === 'migration-repair';
  const mode = command === 'update' ? options.mode || 'full' : 'backend-only';
  const config = configFromEnvironment(mode, databaseOnly);
  const localStore = new FileStateStore(config.stateDirectory);
  await localStore.initialize();
  const stateStore =
    dependencies.createStateStore?.(localStore, config.stateDirectory) ??
    checkpointStoreFromEnvironment(localStore, config.stateDirectory);
  const adapters = (dependencies.createAdapters ?? createUpdaterAdapters)(config);
  if (command === 'update') {
    if (!options.archive) throw new Error('update requires --archive');
    const trustList = await readFile(config.trustListPath);
    await runUpdate({
      archive: resolve(options.archive),
      stateDirectory: config.stateDirectory,
      bootstrapTrustList: trustList,
      mode,
      adapters,
      stateStore,
    });
    process.stdout.write('Installed the Kinjot release (signature verified).\n');
    return;
  }
  if (command === 'backfill') {
    const lock = await acquireUpdateLock(config.stateDirectory);
    try {
      await adapters.backfill();
    } finally {
      await lock.release();
    }
    process.stdout.write('Embedding backfill queued.\n');
    return;
  }
  if (command === 'migration-repair') {
    await (dependencies.repairMigrationHistory ?? repairMigrationHistory)({
      config,
      version: options.version,
      status: options.status,
      confirmation: options.confirm,
    });
    process.stdout.write(
      'Migration history bookkeeping updated; no migration SQL was executed or undone.\n',
    );
    return;
  }
  throw new Error('command must be update, backfill, repair-guide, or migration-repair');
}

export async function runCli(
  argv = process.argv.slice(2),
  { execute = main, stderr = process.stderr } = {},
) {
  try {
    await execute(argv);
    return 0;
  } catch (error) {
    stderr.write(formatCliFailure(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
