#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createUpdaterAdapters } from './apply-adapters.mjs';
import { runDoctor, formatReport } from '../byo-doctor/doctor.mjs';
import { createDatabaseAdapter } from '../byo-doctor/database.mjs';
import { createHttpAdapters } from '../byo-doctor/http.mjs';
import { GitCheckpointStore } from './git-checkpoint.mjs';
import { GitInstanceStore } from './git-configuration.mjs';
import {
  activateLicense,
  activeLink,
  assertIntentLicense,
  authorizedUnlink,
  compensatedLink,
  confirmedLink,
  confirmedUnlink,
  createLinkingIntent,
  deactivateLicense,
  pendingUnlink,
  validateLicenseAvailability,
  validateLicenseInstance,
} from './license-lifecycle.mjs';
import { validateOperatorConfig } from './operator-config.mjs';
import { createPsqlProbe, resolveDatabaseEndpoint } from './database-endpoint.mjs';
import { downloadRelease } from './release-download.mjs';
import { authenticateHandoffControl, readHandoffStateFile } from './handoff.mjs';
import { acquireUpdateLock, authenticateInstalledControl, FileStateStore } from './state.mjs';
import { runUpdate } from './updater.mjs';
import { formatCliFailure, main as localUpdaterMain } from './cli.mjs';
import { UpdaterRefusal } from './refusal.mjs';

const CHANNEL_KEYS = [
  'schemaVersion',
  'channel',
  'enabled',
  'releaseEndpoint',
  'r2Origin',
  'storeId',
  'productId',
  'trustList',
];

function fixed(message = 'customer updater configuration is invalid') {
  return new Error(message);
}

function isModeWidening(state, mode) {
  if (!state || state.mode === mode) return false;
  if (state.mode === 'backend-only' && mode === 'full' && state.attempt === null) return true;
  throw new UpdaterRefusal('mode_mismatch');
}

async function withLegacyOperatorUrlDefaults(operation) {
  const defaults = {
    KINJOT_SITE_URL: 'http://127.0.0.1',
    KINJOT_AUTH_CALLBACK_URL: 'http://127.0.0.1/auth/callback',
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(defaults)) {
    previous.set(name, Object.hasOwn(process.env, name) ? process.env[name] : undefined);
    if (!process.env[name]) process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function licenseRecovery(recoveryAction = 'link') {
  return Object.assign(new Error('license lifecycle recovery is required'), {
    code: 'license_recovery_required',
    recoveryAction,
  });
}

/**
 * Every caller passes `process.env.KINJOT_LICENSE_KEY`, so the value is a
 * string or absent — the first branch covers absent, and there is no third
 * case worth a `typeof` test.
 *
 * The shape check stays on all four commands, including the two that only
 * re-assert an existing intent. It cannot strand a deployment: the same 8-512
 * bound is enforced a layer down by `licenseFingerprint`, so a key this
 * refuses could never have been linked in the first place. Refusing here is
 * how that operator gets the refusal table's copy instead of the lifecycle's
 * bare `license key is invalid`.
 */
function commandLicenseKey(value) {
  if (value === undefined || value === null || value === '') {
    throw new UpdaterRefusal('license_key_missing');
  }
  if (value.length < 8 || value.length > 512) {
    throw new UpdaterRefusal('license_key_invalid');
  }
  return value;
}

function withIncompleteUpdate(report, attempt) {
  if (!attempt) return report;
  const checks = {
    ...report.checks,
    update: {
      status: 'unhealthy',
      code: 'update_incomplete',
      details: {
        phase: attempt.phase,
        target: {
          version: attempt.target.version,
          sequence: attempt.target.sequence,
        },
      },
    },
  };
  const summary = { healthy: 0, unhealthy: 0, unavailable: 0, not_configured: 0 };
  for (const check of Object.values(checks)) summary[check.status]++;
  return {
    ...report,
    status: 'unhealthy',
    summary,
    ...(report.readiness ? { readiness: { ...report.readiness, core: 'unhealthy' } } : {}),
    checks,
  };
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

async function channelConfig(repository) {
  let value;
  try {
    value = JSON.parse(await readFile(join(repository, 'kinjot.channel.json'), 'utf8'));
  } catch {
    throw fixed();
  }
  if (
    !exactKeys(value, CHANNEL_KEYS) ||
    value.schemaVersion !== 1 ||
    !['test', 'production'].includes(value.channel) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.releaseEndpoint !== 'string' ||
    typeof value.r2Origin !== 'string' ||
    !Number.isSafeInteger(value.storeId) ||
    !Number.isSafeInteger(value.productId) ||
    typeof value.trustList !== 'string' ||
    value.trustList.startsWith('/') ||
    value.trustList.includes('..')
  ) {
    throw fixed();
  }
  if (!value.enabled) throw new UpdaterRefusal('enrollment_disabled');
  const endpoint = new URL(value.releaseEndpoint);
  const r2 = new URL(value.r2Origin);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.search ||
    endpoint.hash ||
    r2.protocol !== 'https:' ||
    r2.origin !== value.r2Origin ||
    r2.pathname !== '/'
  ) {
    throw fixed();
  }
  return Object.freeze({ ...value });
}

function git(repository, args) {
  return new Promise((accept, reject) => {
    execFile(
      'git',
      ['-C', repository, ...args],
      { env: { PATH: process.env.PATH, LANG: 'C' } },
      (error, stdout) =>
        error
          ? reject(new UpdaterRefusal('repository_inspection_failed'))
          : accept(String(stdout).trim()),
    );
  });
}

// Resolved once per process: `setup` runs `update` in the same process, and the
// probe must not run twice. The memo is keyed by the raw secret, so a test that
// changes the environment resolves again.
let resolvedDatabaseEndpoint = null;

async function operatorDatabaseUrl(
  repository,
  dependencies = {},
  timeoutMs = Number(process.env.KINJOT_UPDATE_TIMEOUT_MS || 120_000),
) {
  const databaseUrl = process.env.KINJOT_DATABASE_URL;
  const psql = process.env.KINJOT_PSQL_BIN;
  // Without a probe there is no evidence of unreachability, and resolving on a
  // failure we cannot observe would replace a precise configuration refusal
  // with a misleading one.
  if (!databaseUrl || !psql) return databaseUrl;
  if (resolvedDatabaseEndpoint?.databaseUrl === databaseUrl) {
    if (resolvedDatabaseEndpoint.error) throw resolvedDatabaseEndpoint.error;
    return resolvedDatabaseEndpoint.resolved;
  }
  let resolved;
  try {
    resolved = await (dependencies.resolveDatabaseEndpoint ?? resolveDatabaseEndpoint)({
      databaseUrl,
      projectRef: process.env.KINJOT_SUPABASE_PROJECT_REF,
      managementToken: process.env.SUPABASE_ACCESS_TOKEN,
      timeoutMs,
      probe: dependencies.databaseProbe ?? createPsqlProbe({ psql, cwd: repository, timeoutMs }),
    });
  } catch (error) {
    // A failure is memoized like a success, so a fallback path in the same
    // process neither probes nor calls the Management API a second time.
    resolvedDatabaseEndpoint = { databaseUrl, error, noticed: false };
    throw error;
  }
  resolvedDatabaseEndpoint = { databaseUrl, resolved };
  return resolved;
}

const DOCTOR_FLAGS = ['--json', '--core', '--allow-billable-voyage'];

function doctorArgsValid(args) {
  return (
    args.every((arg) => DOCTOR_FLAGS.includes(arg)) &&
    !(args.includes('--core') && args.includes('--allow-billable-voyage'))
  );
}

// The range `runDoctor` accepts (scripts/byo-doctor/doctor.mjs); outside it the
// doctor refuses its configuration, so nothing is probed first.
function doctorTimeoutMs() {
  const timeoutMs = Number(process.env.KINJOT_DOCTOR_TIMEOUT_MS || 5000);
  return Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000 ? timeoutMs : null;
}

async function doctorDatabaseUrl(repository, dependencies) {
  const timeoutMs = doctorTimeoutMs();
  if (timeoutMs === null) return process.env.KINJOT_DATABASE_URL;
  try {
    return await operatorDatabaseUrl(repository, dependencies, timeoutMs);
  } catch {
    // stderr, not the report's stream: `doctor --json` must stay parseable.
    if (!resolvedDatabaseEndpoint?.noticed) {
      (dependencies.stderr ?? process.stderr).write(
        'Database pooler fallback could not resolve; checking the configured endpoint.\n',
      );
      if (resolvedDatabaseEndpoint) resolvedDatabaseEndpoint.noticed = true;
    }
    return process.env.KINJOT_DATABASE_URL;
  }
}

async function withDoctorDatabaseUrl(repository, dependencies, operation) {
  const previous = Object.hasOwn(process.env, 'KINJOT_DATABASE_URL')
    ? process.env.KINJOT_DATABASE_URL
    : undefined;
  const resolved = await doctorDatabaseUrl(repository, dependencies);
  if (resolved !== undefined) process.env.KINJOT_DATABASE_URL = resolved;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.KINJOT_DATABASE_URL;
    else process.env.KINJOT_DATABASE_URL = previous;
  }
}

function operatorConfig(
  mode,
  stateDirectory,
  trustListPath,
  databaseUrl = process.env.KINJOT_DATABASE_URL,
) {
  return validateOperatorConfig(
    {
      databaseUrl,
      projectRef: process.env.KINJOT_SUPABASE_PROJECT_REF,
      managementToken: process.env.SUPABASE_ACCESS_TOKEN,
      cloudflareToken: process.env.CLOUDFLARE_API_TOKEN,
      cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      pagesProject: process.env.KINJOT_PAGES_PROJECT,
      pagesBranch: process.env.KINJOT_PAGES_BRANCH || 'main',
      stateDirectory,
      trustListPath,
      executables: {
        psql: process.env.KINJOT_PSQL_BIN,
        supabase: process.env.KINJOT_SUPABASE_BIN,
        wrangler: process.env.KINJOT_WRANGLER_BIN,
      },
      timeoutMs: Number(process.env.KINJOT_UPDATE_TIMEOUT_MS || 120_000),
    },
    { mode },
  );
}

async function resolveOperatorConfig(
  readOperatorConfig,
  mode,
  stateDirectory,
  trustListPath,
  repository,
  dependencies,
) {
  const configuredDatabaseUrl = process.env.KINJOT_DATABASE_URL;
  // Validate every operator prerequisite before the new reachability probes or
  // Management API request. Otherwise a missing token, unsafe executable, or
  // invalid timeout can be hidden behind the fallback's IPv6 refusal.
  const initial = readOperatorConfig(mode, stateDirectory, trustListPath, configuredDatabaseUrl);
  const resolvedDatabaseUrl = await operatorDatabaseUrl(repository, dependencies);
  if (resolvedDatabaseUrl === configuredDatabaseUrl) return initial;
  return readOperatorConfig(mode, stateDirectory, trustListPath, resolvedDatabaseUrl);
}

/**
 * The frozen bootstrap. Everything it does before `import()` is the template's
 * permanent floor, so it reads durable state and authenticates the installed
 * control through `handoff.mjs` — both minisign signatures, the canonical
 * re-encoding binding, the trust list's own schema, the control-file digests,
 * and tolerant readers of nothing more than the fields below. The full
 * validators live behind the hand-off, where a release can change them.
 */
export async function selectInstalledControl(
  repository,
  stateDirectory,
  argv,
  authenticate = authenticateHandoffControl,
  dependencies = {},
) {
  if (process.env.KINJOT_AUTHENTICATED_CONTROL === '1') return false;
  const state = await readHandoffStateFile(stateDirectory);
  if (!state?.updaterControl) return false;
  const effectiveArgv =
    argv[0] === 'update' && argv.length === 1
      ? ['update', process.env.KINJOT_DEPLOYMENT_MODE || state.mode]
      : argv;
  let authenticated;
  try {
    authenticated = await authenticate({ stateDirectory, state });
  } catch (error) {
    if (argv[0] === 'doctor') return false;
    throw error;
  }
  // `doctor` delegates like every other command: its inventory, its checks and
  // its report belong to the installed release, not to whatever the template
  // was vendored with. The catch above keeps the diagnostic that matters most
  // — if authentication fails, doctor still runs locally, because a diagnostic
  // that cannot run when things are broken is worthless.
  //
  // `setup` stays local. It is the first-install path, and the control
  // directory it would hand off to belongs to the release it is installing.
  if (argv[0] === 'setup') return false;
  const initialRecoveryUpdate =
    effectiveArgv[0] === 'update' &&
    effectiveArgv.length === 2 &&
    ['full', 'backend-only'].includes(effectiveArgv[1]) &&
    effectiveArgv[1] === state.mode &&
    state.installedRelease === null &&
    state.attempt?.phase === 'control_installed' &&
    state.attempt.target.sequence === 1 &&
    state.updaterControl.sequence === state.attempt.target.sequence &&
    authenticated.manifest.release.minimumPreviousRelease === null;
  const wideningUpdate =
    effectiveArgv.length === 2 &&
    effectiveArgv[0] === 'update' &&
    effectiveArgv[1] === 'full' &&
    state.mode === 'backend-only' &&
    state.installedRelease !== null &&
    state.attempt === null &&
    state.updaterControl.sequence === state.installedRelease.sequence;
  const explicitUpdateMode =
    effectiveArgv.length === 2 &&
    effectiveArgv[0] === 'update' &&
    ['full', 'backend-only'].includes(effectiveArgv[1])
      ? effectiveArgv[1]
      : null;
  if (explicitUpdateMode && state.mode !== explicitUpdateMode && !wideningUpdate) {
    throw new UpdaterRefusal('mode_mismatch');
  }
  // `initialRecoveryUpdate` must stay on the template's vendored copy, and the
  // reason is specific: `installedRelease === null` with an `attempt` stuck at
  // `control_installed` for sequence 1 means the control directory sitting
  // there belongs to the release being installed — the *target*, not a release
  // that ever completed. Handing off to it would have a release validate and
  // drive its own first installation, which is precisely the property the
  // one-release-behind design exists to avoid.
  //
  // Widening does not share that reason, and it used to be lumped in with it.
  // Here `installedRelease !== null`, `attempt === null`, and the control
  // sequence equals the installed release's — the control directory is a
  // release that completed, which is exactly the "release N validates N+1"
  // case. And widening always applies a new release (`update()` refuses with
  // `widening_requires_release` when the channel is up to date), so returning
  // false meant an operator who enrolled before a validator change and later
  // widened `backend-only` → `full` ran enrollment-era validation against the
  // newest manifest — the one path where stale validation still reached a
  // live release.
  if (initialRecoveryUpdate) return false;
  const entry = join(authenticated.root, 'scripts/byo-updater/customer-cli.mjs');
  const module = await import(pathToFileURL(entry).href);
  const selected = Object.hasOwn(process.env, 'KINJOT_AUTHENTICATED_CONTROL')
    ? process.env.KINJOT_AUTHENTICATED_CONTROL
    : undefined;
  process.env.KINJOT_AUTHENTICATED_CONTROL = '1';
  let result;
  try {
    const runInstalled = () => withLegacyOperatorUrlDefaults(() => module.main(effectiveArgv));
    result =
      argv[0] === 'doctor' && doctorArgsValid(argv.slice(1))
        ? await withDoctorDatabaseUrl(repository, dependencies, runInstalled)
        : await runInstalled();
  } catch (error) {
    // The same fallback as the authentication catch above, for the same
    // reason: a diagnostic that cannot run when things are broken is
    // worthless. It matters concretely because the workflow and the installed
    // control are frozen independently — the template's doctor step passes
    // `--core`, which reached the CLI only in 0.1.0-rc.2, while a fresh
    // install's first hop lands on rc.1 and each `update` advances one
    // release. Delegating that dispatch to rc.1 turns a working diagnostic
    // into an invalid-configuration error. Doctor is read-only and makes no
    // durable change, so re-running it locally costs nothing; every other
    // command propagates, because retrying one of those locally would run
    // enrollment-era code against a live release.
    if (argv[0] !== 'doctor') throw error;
    // Never silently. The authentication fallback above degrades visibly,
    // because the local doctor prints that the inventory could not be
    // authenticated; this one would otherwise print a healthy-looking report
    // from an older local diagnostic while the installed one stays broken and
    // the workflow step stays green. One bounded line names what failed.
    const reason = (typeof error?.message === 'string' ? error.message : String(error)).slice(
      0,
      500,
    );
    process.stderr.write(
      `Installed release diagnostics did not run (${reason}); falling back to ` +
        `this repository's vendored doctor. The installed release's own ` +
        `diagnostic is broken and needs attention.\n`,
    );
    if (selected === undefined) delete process.env.KINJOT_AUTHENTICATED_CONTROL;
    else process.env.KINJOT_AUTHENTICATED_CONTROL = selected;
    return false;
  }
  return Number.isInteger(result) ? result : true;
}

async function stores(repository, stateDirectory) {
  const branch = process.env.KINJOT_CONFIGURATION_BRANCH || process.env.GITHUB_REF_NAME;
  if (!branch) throw new UpdaterRefusal('configuration_branch_missing');
  const expectedHead = await git(repository, ['rev-parse', 'HEAD']);
  const localStore = new FileStateStore(stateDirectory);
  return {
    instance: new GitInstanceStore({ repository, branch, expectedHead }),
    checkpoint: new GitCheckpointStore({
      repository,
      stateDirectory,
      branch,
      expectedHead,
      localStore,
    }),
  };
}

export async function update(repository, stateDirectory, mode, dependencies = {}) {
  const readChannel = dependencies.channelConfig ?? channelConfig;
  const readOperatorConfig = dependencies.operatorConfig ?? operatorConfig;
  const createStores = dependencies.stores ?? stores;
  const fetchRelease = dependencies.downloadRelease ?? downloadRelease;
  const createAdapters = dependencies.createUpdaterAdapters ?? createUpdaterAdapters;
  const applyUpdate = dependencies.runUpdate ?? runUpdate;
  const acquireLock = dependencies.acquireUpdateLock ?? acquireUpdateLock;
  const channel = await readChannel(repository);
  const trustListPath = resolve(repository, channel.trustList);
  const config = await resolveOperatorConfig(
    readOperatorConfig,
    mode,
    stateDirectory,
    trustListPath,
    repository,
    dependencies,
  );
  const durable = await createStores(repository, stateDirectory);
  const instance = await durable.instance.read();
  if (!instance || instance.status !== 'linked') throw new UpdaterRefusal('deployment_not_linked');
  const licenseKey = commandLicenseKey(process.env.KINJOT_LICENSE_KEY);
  assertIntentLicense(instance, licenseKey);
  if (instance.storeId !== channel.storeId || instance.productId !== channel.productId) {
    throw new UpdaterRefusal('channel_mismatch');
  }
  const state = await durable.checkpoint.read();
  const widening = isModeWidening(state, mode);
  const requestedPin = process.env.KINJOT_RELEASE_PIN || null;
  if (state?.attempt && requestedPin && requestedPin !== state.attempt.target.version) {
    throw new UpdaterRefusal('recovery_target_mismatch');
  }
  const pin = state?.attempt?.target.version ?? requestedPin;
  const downloads = join(stateDirectory, 'downloads');
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  const archive = join(downloads, 'selected-release.tar');
  await rm(archive, { force: true });
  try {
    const selected = await fetchRelease({
      endpoint: channel.releaseEndpoint,
      expectedR2Origin: channel.r2Origin,
      request: {
        schemaVersion: 1,
        licenseKey,
        instanceId: instance.instanceId,
        installed: state?.installedRelease ?? null,
        pin,
      },
      archivePath: archive,
      timeoutMs: config.timeoutMs,
    });
    const adapters = createAdapters(config);
    if (selected.status === 'up-to-date') {
      if (state?.attempt) throw new UpdaterRefusal('recovery_release_unavailable');
      if (widening) throw new UpdaterRefusal('widening_requires_release');
      const lock = await acquireLock(stateDirectory);
      try {
        await adapters.backfill();
      } finally {
        await lock.release();
      }
      process.stdout.write('Release is up to date; recurring embedding backfill queued.\n');
      return;
    }
    const result = await applyUpdate({
      archive,
      stateDirectory,
      bootstrapTrustList: await readFile(trustListPath),
      mode,
      adapters,
      stateStore: durable.checkpoint,
      expectedSelection: selected.expected,
    });
    process.stdout.write(
      `Authenticated BYO release ${result.release.version} sequence ${result.release.sequence} installed.\n`,
    );
  } finally {
    await rm(archive, { force: true });
  }
}

export async function link(repository, durable, channel, rest, dependencies) {
  let adoption = null;
  if (rest.length) {
    if (rest.length !== 2 || rest[0] !== '--adopt-instance') throw fixed();
    adoption = rest[1];
  }
  const licenseKey = commandLicenseKey(process.env.KINJOT_LICENSE_KEY);
  const instanceName = process.env.KINJOT_INSTANCE_NAME || basename(repository);
  let lifecycle = await durable.instance.read();
  if (lifecycle) assertIntentLicense(lifecycle, licenseKey);
  if (
    lifecycle?.storeId !== undefined &&
    (lifecycle.storeId !== channel.storeId || lifecycle.productId !== channel.productId)
  ) {
    throw new UpdaterRefusal('channel_mismatch');
  }
  if (lifecycle?.status === 'linked') {
    // Adopting an instance onto a deployment that is already linked stays refused,
    // as before: only a plain `link` is the no-op.
    if (adoption) throw new UpdaterRefusal('deployment_already_linked');
    process.stdout.write('This deployment is already linked to this license; nothing changed.\n');
    return;
  }
  if (lifecycle?.status === 'unlinking') {
    throw new UpdaterRefusal('relink_requires_unlink');
  }
  if (lifecycle?.phase === 'activation_confirmed') {
    if (adoption) throw new UpdaterRefusal('adoption_after_activation');
    let ownership;
    try {
      ownership = await (dependencies.validateLicenseInstance ?? validateLicenseInstance)({
        licenseKey,
        config: lifecycle,
      });
    } catch {
      throw licenseRecovery();
    }
    if (ownership.status === 'not_found') {
      let availability;
      try {
        availability = await (
          dependencies.validateLicenseAvailability ?? validateLicenseAvailability
        )({ licenseKey, config: lifecycle });
      } catch {
        throw licenseRecovery();
      }
      if (availability.status !== 'available') throw licenseRecovery();
      await durable.instance.checkpoint(compensatedLink(lifecycle));
      process.stdout.write(
        'Confirmed release instance is inactive; its durable intent is resolved. Run Link again to create a new activation.\n',
      );
      return 2;
    }
    await durable.instance.checkpoint(activeLink(lifecycle));
    process.stdout.write('Release instance linked and committed.\n');
    return;
  }
  if (lifecycle?.phase === 'activation_pending' && !adoption) {
    throw licenseRecovery();
  }
  if (lifecycle?.phase === 'activation_pending' && adoption) {
    let ownership;
    try {
      ownership = await (dependencies.validateLicenseInstance ?? validateLicenseInstance)({
        licenseKey,
        config: lifecycle,
        instanceId: adoption,
      });
    } catch {
      throw licenseRecovery();
    }
    lifecycle = confirmedLink(lifecycle, adoption);
    if (ownership.status === 'not_found') {
      let availability;
      try {
        availability = await (
          dependencies.validateLicenseAvailability ?? validateLicenseAvailability
        )({ licenseKey, config: lifecycle });
      } catch {
        throw licenseRecovery();
      }
      if (availability.status !== 'available') throw licenseRecovery();
      await durable.instance.checkpoint(compensatedLink(lifecycle));
      process.stdout.write(
        'Recovered instance is already inactive; its durable intent is resolved. Run Link again to create a new activation.\n',
      );
      return 2;
    }
    await durable.instance.checkpoint(lifecycle);
    await durable.instance.checkpoint(activeLink(lifecycle));
    process.stdout.write('Release instance adopted, linked, and committed.\n');
    return;
  }
  if (adoption) throw new UpdaterRefusal('adoption_requires_unresolved_link');
  lifecycle = createLinkingIntent({
    licenseKey,
    instanceName,
    expected: { storeId: channel.storeId, productId: channel.productId },
  });
  await durable.instance.checkpoint(lifecycle);
  let confirmed;
  try {
    confirmed = await (dependencies.activateLicense ?? activateLicense)({
      licenseKey,
      instanceName: lifecycle.instanceName,
      expected: { storeId: channel.storeId, productId: channel.productId },
      existing: lifecycle,
    });
  } catch {
    throw licenseRecovery();
  }
  try {
    await durable.instance.checkpoint(confirmed);
  } catch (checkpointError) {
    let compensationCompleted = false;
    try {
      await (dependencies.deactivateLicense ?? deactivateLicense)({
        licenseKey,
        config: confirmed,
      });
      await durable.instance.checkpoint(compensatedLink(confirmed));
      compensationCompleted = true;
    } catch {
      // The durable activation intent remains unresolved. A later run must
      // validate an explicitly supplied instance and never activates again.
    }
    if (!compensationCompleted) throw licenseRecovery();
    throw checkpointError;
  }
  await durable.instance.checkpoint(activeLink(confirmed));
  process.stdout.write('Release instance linked and committed.\n');
}

async function unlink(durable, channel, rest, dependencies) {
  if (rest.length) throw fixed();
  let lifecycle = await durable.instance.read();
  if (!lifecycle) throw new UpdaterRefusal('deployment_nothing_to_unlink');
  const licenseKey = commandLicenseKey(process.env.KINJOT_LICENSE_KEY);
  assertIntentLicense(lifecycle, licenseKey);
  if (lifecycle.storeId !== channel.storeId || lifecycle.productId !== channel.productId) {
    throw new UpdaterRefusal('channel_mismatch');
  }
  if (lifecycle.phase === 'activation_pending') {
    throw licenseRecovery();
  }
  if (lifecycle.phase === 'activation_compensated') {
    await durable.instance.checkpoint(null);
    process.stdout.write('Compensated release instance intent cleared.\n');
    return;
  }
  if (lifecycle.phase === 'deactivation_confirmed') {
    await durable.instance.checkpoint(null);
    process.stdout.write('Release instance deactivated and unlinked.\n');
    return;
  }
  if (lifecycle.status !== 'unlinking') {
    lifecycle = pendingUnlink(lifecycle);
    await durable.instance.checkpoint(lifecycle);
  }
  if (lifecycle.phase === 'deactivation_pending') {
    let ownership;
    try {
      ownership = await (dependencies.validateLicenseInstance ?? validateLicenseInstance)({
        licenseKey,
        config: lifecycle,
      });
    } catch {
      throw licenseRecovery('unlink');
    }
    if (ownership.status === 'not_found') {
      let availability;
      try {
        availability = await (
          dependencies.validateLicenseAvailability ?? validateLicenseAvailability
        )({ licenseKey, config: lifecycle });
      } catch {
        throw licenseRecovery('unlink');
      }
      if (availability.status !== 'available') throw licenseRecovery('unlink');
      lifecycle = confirmedUnlink(lifecycle);
      await durable.instance.checkpoint(lifecycle);
      await durable.instance.checkpoint(null);
      process.stdout.write('Release instance was already inactive and is now unlinked.\n');
      return;
    }
    lifecycle = authorizedUnlink(lifecycle);
    await durable.instance.checkpoint(lifecycle);
  }
  try {
    await (dependencies.deactivateLicense ?? deactivateLicense)({ licenseKey, config: lifecycle });
  } catch {
    throw licenseRecovery('unlink');
  }
  lifecycle = confirmedUnlink(lifecycle);
  await durable.instance.checkpoint(lifecycle);
  await durable.instance.checkpoint(null);
  process.stdout.write('Release instance deactivated and unlinked.\n');
}

export async function doctor(repository, stateDirectory, argv, dependencies = {}) {
  const output = dependencies.output ?? ((value) => process.stdout.write(value));
  const json = argv.includes('--json');
  const coreOnly = argv.includes('--core');
  const allowBillableVoyage = argv.includes('--allow-billable-voyage');
  if (!doctorArgsValid(argv)) throw fixed();
  const durable = await (dependencies.stores ?? stores)(repository, stateDirectory);
  const state = await durable.checkpoint.read();
  if (!state?.updaterControl) {
    output(
      'Kinjot doctor: unavailable\nNo authenticated installed release inventory is available; complete an authenticated install before running doctor.\nRead-only diagnostics; no changes made.\n',
    );
    return 2;
  }
  let authenticated;
  try {
    authenticated = await (
      dependencies.authenticateInstalledControl ?? authenticateInstalledControl
    )({ stateDirectory, state });
  } catch {
    output(
      'Kinjot doctor: unavailable\nThe installed release inventory could not be authenticated; no diagnostic provider request was made.\nRead-only diagnostics; no changes made.\n',
    );
    return 2;
  }
  const manifest = authenticated.manifest;
  const timeoutMs = Number(process.env.KINJOT_DOCTOR_TIMEOUT_MS || 5000);
  const databaseUrl = await doctorDatabaseUrl(repository, dependencies);
  let database;
  if (process.env.KINJOT_DATABASE_URL) {
    try {
      database = (dependencies.createDatabaseAdapter ?? createDatabaseAdapter)({
        databaseUrl,
        timeoutMs,
      });
    } catch {
      database = {
        read: async () => {
          throw Object.assign(new Error('Invalid database configuration.'), {
            code: 'invalid_configuration',
          });
        },
      };
    }
  }
  const http = (dependencies.createHttpAdapters ?? createHttpAdapters)({
    projectRef: process.env.KINJOT_SUPABASE_PROJECT_REF,
    managementToken: process.env.SUPABASE_ACCESS_TOKEN,
    openaiKey: coreOnly ? undefined : process.env.OPENAI_API_KEY,
    voyageKey: coreOnly ? undefined : process.env.VOYAGE_API_KEY,
    allowBillableVoyage: coreOnly ? false : allowBillableVoyage,
    timeoutMs,
  });
  const report = withIncompleteUpdate(
    await (dependencies.runDoctor ?? runDoctor)(
      {
        migrationVersions: manifest.migrations.map((name) => name.slice(0, 14)),
        functionInventory: manifest.functions,
        expectedEpoch: manifest.release.clientCompatibilityEpoch,
        timeoutMs,
        coreOnly,
      },
      { database, ...http },
    ),
    state.attempt,
  );
  output(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return report.status === 'healthy' ? 0 : report.status === 'unhealthy' ? 1 : 2;
}

export async function setup(repository, stateDirectory, dependencies = {}) {
  const readChannel = dependencies.channelConfig ?? channelConfig;
  const createStores = dependencies.stores ?? stores;
  const readOperatorConfig = dependencies.operatorConfig ?? operatorConfig;
  const runLink = dependencies.link ?? link;
  const runUpdateCommand = dependencies.runUpdateCommand ?? main;
  const runCustomerDoctor = dependencies.doctor ?? doctor;
  const output = dependencies.output ?? ((value) => process.stdout.write(value));

  const channel = await readChannel(repository);
  const durable = await createStores(repository, stateDirectory);
  const state = await durable.checkpoint.read();
  const requestedMode = process.env.KINJOT_DEPLOYMENT_MODE || null;
  if (requestedMode && !['full', 'backend-only'].includes(requestedMode)) {
    throw new UpdaterRefusal('deployment_mode_invalid');
  }
  const mode = requestedMode ?? state?.mode ?? 'backend-only';
  if (state?.mode === 'full' && mode !== 'full') throw new UpdaterRefusal('mode_mismatch');
  const licenseKey = commandLicenseKey(process.env.KINJOT_LICENSE_KEY);

  // Validate database/project binding and every mode-specific credential before
  // the public license provider can be mutated.
  const trustListPath = resolve(repository, channel.trustList ?? 'trust/production-v1.json');
  const config = await resolveOperatorConfig(
    readOperatorConfig,
    mode,
    stateDirectory,
    trustListPath,
    repository,
    dependencies,
  );
  const adapters = (dependencies.createUpdaterAdapters ?? createUpdaterAdapters)(config);
  await adapters.preflightTarget({ mode });

  const lifecycle = await durable.instance.read();
  if (lifecycle?.status !== 'linked') {
    const linkResult = await runLink(repository, durable, channel, [], dependencies);
    if (Number.isInteger(linkResult) && linkResult !== 0) return linkResult;
  } else {
    assertIntentLicense(lifecycle, licenseKey);
    if (lifecycle.storeId !== channel.storeId || lifecycle.productId !== channel.productId) {
      throw new UpdaterRefusal('channel_mismatch');
    }
  }

  const updateResult = await runUpdateCommand(['update', mode], dependencies);
  if (updateResult !== undefined && updateResult !== 0) {
    throw new UpdaterRefusal('installed_updater_incomplete');
  }
  let diagnosticOutput = '';
  const diagnosticExit = await runCustomerDoctor(repository, stateDirectory, ['--core'], {
    ...dependencies,
    output: (value) => {
      diagnosticOutput += value;
    },
  });
  if (diagnosticExit !== 0) {
    output(diagnosticOutput);
    throw new UpdaterRefusal('core_diagnostics_failed');
  }

  const completed = await durable.checkpoint.read();
  if (!completed?.installedRelease || completed.attempt !== null || completed.mode !== mode) {
    throw new UpdaterRefusal('installation_unverified');
  }
  const installed = completed?.installedRelease;
  output(
    [
      'Kinjot setup complete.',
      `Core installation checks passed (${mode}).`,
      ...(installed ? [`Release: ${installed.version} (sequence ${installed.sequence})`] : []),
      `App: ${mode === 'backend-only' ? 'https://byo.kinjot.com' : `https://${config.pagesProject}.pages.dev`}`,
      `Supabase project URL: https://${config.projectRef}.supabase.co`,
      'Next: create a confirmed operator account in Supabase Auth.',
      'Then open the app, enter the receipt license at the byo.kinjot.com gate when using the included app, and connect with your public project URL and publishable key.',
      'AI is optional and was not checked here. Add provider secrets in Supabase later, then use Recheck in Kinjot Settings → Account → Enable AI.',
    ].join('\n') + '\n',
  );
}

async function dispatchCustomerCommand(argv, dependencies) {
  const repository = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const stateDirectory = join(repository, '.kinjot', 'deployment');
  const delegated = await (dependencies.selectInstalledControl ?? selectInstalledControl)(
    repository,
    stateDirectory,
    argv,
    undefined,
    dependencies,
  );
  if (delegated !== false) return delegated === true ? undefined : delegated;
  const [command, ...rest] = argv;
  if (command === 'setup') {
    if (rest.length) throw fixed();
    return setup(repository, stateDirectory, dependencies);
  }
  if (command === 'update') {
    const recorded = rest.length === 0 ? await new FileStateStore(stateDirectory).read() : null;
    const mode = rest[0] || process.env.KINJOT_DEPLOYMENT_MODE || recorded?.mode || 'backend-only';
    if (!['full', 'backend-only'].includes(mode) || rest.length > 1) throw fixed();
    await update(repository, stateDirectory, mode, dependencies);
    return;
  }
  if (['backfill', 'repair-guide', 'migration-repair'].includes(command)) {
    await (dependencies.localUpdaterMain ?? localUpdaterMain)(argv);
    return;
  }
  if (command === 'doctor') return doctor(repository, stateDirectory, rest, dependencies);
  const durable = await (dependencies.stores ?? stores)(repository, stateDirectory);
  const channel = await (dependencies.channelConfig ?? channelConfig)(repository);
  if (command === 'link') {
    return link(repository, durable, channel, rest, dependencies);
  }
  if (command === 'unlink') {
    return unlink(durable, channel, rest, dependencies);
  }
  throw fixed(
    'command must be setup, link, unlink, update, backfill, doctor, repair-guide, or migration-repair',
  );
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  // Delegation sets this flag in-process. Only an already authenticated control
  // owns its error output; the bootstrap must retain its own failure handling.
  const authenticatedControlInvocation = process.env.KINJOT_AUTHENTICATED_CONTROL === '1';
  try {
    return await dispatchCustomerCommand(argv, dependencies);
  } catch (error) {
    if (authenticatedControlInvocation && argv[0] !== 'doctor') {
      process.stderr.write(formatCliFailure(error, argv[0]));
      return 1;
    }
    // Doctor must throw through to the frozen bootstrap's diagnostic fallback.
    throw error;
  }
}

export async function runCustomerCli(
  argv = process.argv.slice(2),
  { execute = main, stderr = process.stderr } = {},
) {
  try {
    const result = await execute(argv);
    return Number.isInteger(result) ? result : 0;
  } catch (error) {
    stderr.write(formatCliFailure(error, argv[0]));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runCustomerCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
