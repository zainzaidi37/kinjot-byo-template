import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolvePackagePath, verifyPackage } from '../byo-release/manifest.mjs';
import { copyProcessDiagnostic } from './safe-process.mjs';
import { adoptTrustList } from '../byo-release/signature.mjs';
import { parseTrustList } from '../byo-release/trust-list.mjs';
import { assertApplicable, releaseRecordFor } from './applicability.mjs';
import { removeQuarantine } from './cleanup.mjs';
import { authenticateQuarantinedPackage, extractTarToQuarantine } from './quarantine.mjs';
import { normalizeUpdaterRefusalReason, UpdaterRefusal } from './refusal.mjs';
import {
  FileStateStore,
  acquireUpdateLock,
  initialState,
  installImmutableControl,
  validateState,
} from './state.mjs';

const SAFE_MIGRATION_SQLSTATES = new Set([
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

function assertAdapters(adapters, mode) {
  for (const name of ['preflight', 'applyMigrations', 'initializeBackend', 'deployFunctions']) {
    if (typeof adapters?.[name] !== 'function')
      throw new Error(`updater adapter ${name} is required`);
  }
  if (mode === 'full' && typeof adapters.publishWeb !== 'function') {
    throw new Error('updater adapter publishWeb is required in full mode');
  }
}

function withAttempt(state, target, phase, changes = {}) {
  return validateState({
    ...state,
    ...changes,
    attempt: { target, phase },
  });
}

async function callAdapter(name, operation, input) {
  try {
    return await operation(input);
  } catch (error) {
    const reason = normalizeUpdaterRefusalReason(error);
    let candidateSqlstate;
    try {
      candidateSqlstate = error?.sqlstate;
    } catch {
      // Hostile accessors cannot replace the fixed operation error.
    }
    const sqlstate =
      name === 'migration apply' &&
      typeof candidateSqlstate === 'string' &&
      (SAFE_MIGRATION_SQLSTATES.has(candidateSqlstate) ||
        (candidateSqlstate.length === 5 && /^KJ0[0-9]{2}$/.test(candidateSqlstate)))
        ? candidateSqlstate
        : null;
    const failure = Object.assign(
      new Error(`updater ${name} failed${sqlstate ? ` (SQLSTATE ${sqlstate})` : ''}`),
      {
        code: 'updater_operation_failed',
        operation: name,
        ...(reason ? { reason } : {}),
        ...(sqlstate ? { sqlstate } : {}),
      },
    );
    if (name === 'function deployment' || name === 'web publication') {
      copyProcessDiagnostic(failure, error);
    }
    throw failure;
  }
}

function isModeWidening(state, mode) {
  if (state.mode === mode) return false;
  if (state.mode === 'backend-only' && mode === 'full' && state.attempt === null) return true;
  throw new UpdaterRefusal('mode_mismatch');
}

async function checkpoint({ store, state, target, phase, changes, faultInjector }) {
  const next = await store.write(withAttempt(state, target, phase, changes));
  await faultInjector?.(phase);
  return next;
}

async function verifyStillComplete(root, verified) {
  await verifyPackage(root, verified.manifest);
}

export async function runUpdate({
  archive,
  stateDirectory,
  bootstrapTrustList,
  mode,
  adapters,
  stateStore,
  limits,
  faultInjector,
  expectedSelection,
}) {
  if (!['full', 'backend-only'].includes(mode))
    throw new Error('updater mode must be full or backend-only');
  assertAdapters(adapters, mode);
  const stateRoot = resolve(stateDirectory);
  const store = stateStore ?? new FileStateStore(stateRoot);
  if (typeof store?.read !== 'function' || typeof store?.write !== 'function') {
    throw new Error('updater state store is invalid');
  }
  const lock = await acquireUpdateLock(stateRoot);
  let quarantine;
  let operationError;
  let operationFailed = false;
  let result;
  try {
    const prior = await store.read();
    const stateExisted = prior !== null;
    let state = prior ?? initialState({ mode, trustList: bootstrapTrustList });
    const widening = isModeWidening(state, mode);
    const effectiveTrust = state.effectiveTrustList;

    quarantine = await extractTarToQuarantine({
      archive,
      parentDirectory: join(stateRoot, 'quarantine'),
      limits,
    });
    const authenticated = await authenticateQuarantinedPackage({
      packageRoot: quarantine.root,
      trustList: effectiveTrust,
    });
    const manifestSha256 = createHash('sha256').update(authenticated.rawManifest).digest('hex');
    const target = releaseRecordFor(authenticated.verified.manifest, manifestSha256);
    if (
      expectedSelection &&
      (target.version !== expectedSelection.version ||
        target.sequence !== expectedSelection.sequence ||
        target.sourceCommit !== expectedSelection.sourceCommit ||
        target.clientCompatibilityEpoch !== expectedSelection.clientCompatibilityEpoch ||
        target.manifestSha256 !== expectedSelection.manifestSha256)
    ) {
      throw new Error('authenticated release identity differs from the selected download');
    }

    // Preflight is the first injected operation. It is required to be read-only;
    // no durable attempt/control state exists if it refuses.
    const preflight = await callAdapter('preflight', adapters.preflight, {
      packageRoot: quarantine.root,
      manifest: authenticated.verified.manifest,
      mode,
    });
    assertApplicable({
      manifest: authenticated.verified.manifest,
      target,
      state,
      preflight,
      stateExisted,
    });
    state = await checkpoint({
      store,
      state,
      target,
      phase: 'verified',
      changes: widening ? { mode: 'full' } : undefined,
      faultInjector,
    });

    await verifyStillComplete(quarantine.root, authenticated.verified);
    const candidatePath = authenticated.verified.manifest.components.trustList;
    if (typeof candidatePath !== 'string') throw new Error('release has no trust-list component');
    const candidateBytes = await readFile(resolvePackagePath(quarantine.root, candidatePath));
    const adopted = adoptTrustList({
      verifiedRelease: authenticated.verified,
      currentTrustList: effectiveTrust,
      candidateTrustListBytes: candidateBytes,
    });
    const updaterControl = await installImmutableControl({
      stateDirectory: stateRoot,
      packageRoot: quarantine.root,
      manifest: authenticated.verified.manifest,
    });
    state = await checkpoint({
      store,
      state,
      target,
      phase: 'control_installed',
      changes: { effectiveTrustList: parseTrustList(adopted), updaterControl },
      faultInjector,
    });

    await verifyStillComplete(quarantine.root, authenticated.verified);
    const migrationResult = await callAdapter('migration apply', adapters.applyMigrations, {
      packageRoot: quarantine.root,
      manifest: authenticated.verified.manifest,
    });
    if (
      !Number.isSafeInteger(migrationResult?.databaseEpoch) ||
      migrationResult.databaseEpoch !== target.clientCompatibilityEpoch
    ) {
      throw new Error('database compatibility epoch does not match after migrations');
    }
    state = await checkpoint({ store, state, target, phase: 'migrations_applied', faultInjector });

    await callAdapter('backend initialization', adapters.initializeBackend, {
      packageRoot: quarantine.root,
      manifest: authenticated.verified.manifest,
    });
    state = await checkpoint({ store, state, target, phase: 'backend_initialized', faultInjector });

    await verifyStillComplete(quarantine.root, authenticated.verified);
    await callAdapter('function deployment', adapters.deployFunctions, {
      packageRoot: quarantine.root,
      manifest: authenticated.verified.manifest,
    });
    state = await checkpoint({ store, state, target, phase: 'functions_deployed', faultInjector });

    if (mode === 'full') {
      await verifyStillComplete(quarantine.root, authenticated.verified);
      await callAdapter('web publication', adapters.publishWeb, {
        packageRoot: quarantine.root,
        manifest: authenticated.verified.manifest,
      });
      state = await checkpoint({ store, state, target, phase: 'web_published', faultInjector });
    }

    state = await store.write(
      validateState({
        ...state,
        installedRelease: target,
        attempt: null,
      }),
    );
    result = Object.freeze({ status: 'installed', release: state.installedRelease });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const finalizationErrors = [];
  try {
    if (quarantine) await removeQuarantine(quarantine.root);
  } catch {
    finalizationErrors.push(new Error('updater quarantine cleanup failed'));
  } finally {
    try {
      await lock.release();
    } catch {
      finalizationErrors.push(new Error('updater lock release failed'));
    }
  }
  if (finalizationErrors.length > 0) {
    if (operationFailed) finalizationErrors.unshift(operationError);
    throw new AggregateError(finalizationErrors, 'updater finalization failed');
  }
  if (operationFailed) throw operationError;
  return result;
}
