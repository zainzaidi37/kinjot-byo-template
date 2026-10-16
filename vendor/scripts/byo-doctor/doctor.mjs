import { readdir } from 'node:fs/promises';
import { FUNCTION_SLUG } from '../byo-release/manifest.mjs';
import {
  BUCKET_PREREQUISITES,
  FEATURE_SCHEMA_PREREQUISITES,
  SCHEMA_PREREQUISITES,
} from './schema.mjs';

export const REQUIRED_FUNCTIONS = Object.freeze([
  'delete-account',
  'recall',
  'recall-history-search',
  'embed-notes',
  'tidy-notes',
  'usage-limits',
  'mcp-api',
]);
export const AI_SECRET_NAMES = Object.freeze(['OPENAI_API_KEY', 'VOYAGE_API_KEY']);

const versionPattern = /^\d{14}$/;
const failureCodes = new Set([
  'timeout',
  'permission_denied',
  'authentication_rejected',
  'rate_limited',
  'network_error',
  'unsupported_probe',
  'invalid_response',
  'probe_requires_consent',
  'unavailable',
  'connection_failed',
  'invalid_configuration',
  'missing_prerequisite',
]);
const prerequisiteNames = new Set(SCHEMA_PREREQUISITES.map((p) => p.name));
const featureNames = new Set(FEATURE_SCHEMA_PREREQUISITES.map((p) => p.name));
const bucketNames = new Set(BUCKET_PREREQUISITES.map((p) => p.name));
const result = (status, code, details) => ({ status, code, ...(details ? { details } : {}) });
const invalid = () => {
  throw Object.assign(new Error('Invalid diagnostic response.'), { code: 'invalid_response' });
};

function versions(value) {
  if (
    !Array.isArray(value) ||
    value.length > 10000 ||
    value.some((v) => typeof v !== 'string' || !versionPattern.test(v)) ||
    new Set(value).size !== value.length
  )
    invalid();
  return [...value].sort();
}

/** Enumerate local filenames only. SQL contents and release manifests are never opened. */
export async function readMigrationVersions(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = entries.filter((e) => e.name.endsWith('.sql'));
    if (!files.length || files.some((e) => !e.isFile() || !/^\d{14}_.+\.sql$/.test(e.name)))
      invalid();
    return versions(files.map((e) => e.name.slice(0, 14)));
  } catch {
    throw Object.assign(new Error('Local migration directory is unavailable or invalid.'), {
      code: 'invalid_configuration',
    });
  }
}

async function bounded(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation({ signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('Diagnostic timed out.'), { code: 'timeout' }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function check(operation, convert, timeoutMs) {
  if (!operation) return result('not_configured', 'not_configured');
  try {
    return convert(await bounded(operation, timeoutMs));
  } catch (error) {
    const code = failureCodes.has(error?.code) ? error.code : 'unavailable';
    return result(code === 'missing_prerequisite' ? 'unhealthy' : 'unavailable', code);
  }
}

function provider(value) {
  if (value?.status === 'healthy' && value.code === 'authentication_accepted')
    return result('healthy', value.code);
  if (value?.status === 'unhealthy' && value.code === 'authentication_rejected')
    return result('unhealthy', value.code);
  if (value?.status === 'unavailable' && failureCodes.has(value.code))
    return result('unavailable', value.code);
  invalid();
}

/**
 * Reusable updater seam. Explicit config; no ambient credentials or network defaults.
 * Adapters are trusted local code, never loaded from release metadata. Each read must
 * honor cancellation/time bounds and the documented read-only contract (README).
 * All outputs are projected into known fields; exception messages are never retained.
 */
export async function runDoctor(
  {
    migrationDirectory,
    migrationVersions,
    expectedEpoch,
    timeoutMs = 5000,
    coreOnly = false,
    functionInventory = REQUIRED_FUNCTIONS,
  } = {},
  adapters = {},
) {
  const hasDirectory = typeof migrationDirectory === 'string' && migrationDirectory.length > 0;
  const hasInventory = migrationVersions !== undefined;
  if (
    hasDirectory === hasInventory ||
    !Number.isSafeInteger(expectedEpoch) ||
    expectedEpoch < 1 ||
    typeof coreOnly !== 'boolean' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000
  ) {
    throw new Error(
      'Doctor requires one migration inventory source, positive expected epoch, and timeout of 1–60000 ms.',
    );
  }
  // The inventory a caller may supply instead of the constant, exactly like
  // `migrationVersions` beside it: an embedder holding an authenticated
  // manifest diagnoses the functions *that release actually ships*, so a
  // release that adds one is not reported healthy while its new function is
  // absent. `REQUIRED_FUNCTIONS` stays the floor — a supplied inventory may
  // add to it and may not drop from it, because that set is what a healthy
  // deployment must have whatever the manifest says.
  if (!Array.isArray(functionInventory)) {
    throw new Error('Doctor requires a function inventory covering every required function.');
  }
  const functions = Object.freeze([...new Set(functionInventory)]);
  if (
    functions.length !== functionInventory.length ||
    functions.some((slug) => typeof slug !== 'string' || !FUNCTION_SLUG.test(slug)) ||
    REQUIRED_FUNCTIONS.some((slug) => !functions.includes(slug))
  ) {
    throw new Error('Doctor requires a function inventory covering every required function.');
  }
  const authenticatedVersions = hasInventory ? versions(migrationVersions) : null;
  const read = (name) => (adapters.database ? () => adapters.database.read(name) : undefined);
  // Local inventory is checked even without a database, and no path is reported.
  const local = await check(
    () =>
      authenticatedVersions ??
      (adapters.readMigrations ?? readMigrationVersions)(migrationDirectory),
    (value) => result('healthy', 'inventory_read', { available: versions(value) }),
    timeoutMs,
  );
  const tasks = {
    migrations: () =>
      check(
        read('migrations'),
        (value) => {
          const applied = versions(value);
          if (local.status !== 'healthy') return result('unavailable', local.code, { applied });
          const available = local.details.available;
          const pending = available.filter((v) => !applied.includes(v));
          const remoteOnly = applied.filter((v) => !available.includes(v));
          return result(
            pending.length || remoteOnly.length ? 'unhealthy' : 'healthy',
            remoteOnly.length
              ? 'bookkeeping_drift'
              : pending.length
                ? 'pending_migrations'
                : 'migrations_current',
            { available, applied, pending, remoteOnly },
          );
        },
        timeoutMs,
      ),
    epoch: () =>
      check(
        read('epoch'),
        (value) => {
          if (!Number.isSafeInteger(value) || value < 1) invalid();
          return result(
            value === expectedEpoch ? 'healthy' : 'unhealthy',
            value === expectedEpoch ? 'epoch_matches' : 'epoch_mismatch',
            { expected: expectedEpoch, actual: value },
          );
        },
        timeoutMs,
      ),
    marker: () =>
      check(
        read('marker'),
        (value) => {
          if (value !== null && typeof value !== 'boolean') invalid();
          return result(
            value === true ? 'healthy' : 'unhealthy',
            value === null ? 'marker_absent' : value ? 'self_hosted' : 'marker_disabled',
            { selfHosted: value },
          );
        },
        timeoutMs,
      ),
    extensions: () =>
      check(
        read('extensions'),
        (value) => {
          if (!Array.isArray(value)) invalid();
          const installed = ['vector', 'pgcrypto', 'uuid-ossp'].flatMap((name) => {
            const matches = value.filter((e) => e?.name === name);
            if (matches.length > 1) invalid();
            if (!matches.length) return [];
            if (
              typeof matches[0].version !== 'string' ||
              !/^\d+(?:\.\d+){0,3}$/.test(matches[0].version)
            )
              invalid();
            return [{ name, version: matches[0].version }];
          });
          const missing = installed.some((e) => e.name === 'vector') ? [] : ['vector'];
          return result(
            missing.length ? 'unhealthy' : 'healthy',
            missing.length ? 'extension_missing' : 'extensions_present',
            { installed, missing },
          );
        },
        timeoutMs,
      ),
    schema: () =>
      check(
        read('schema'),
        (value) => {
          if (
            !Array.isArray(value?.missing) ||
            value.missing.some((name) => !prerequisiteNames.has(name))
          )
            invalid();
          const missing = [...new Set(value.missing)].sort();
          return result(
            missing.length ? 'unhealthy' : 'healthy',
            missing.length ? 'missing_prerequisite' : 'prerequisites_present',
            { missing, checked: SCHEMA_PREREQUISITES.length },
          );
        },
        timeoutMs,
      ),
    // Catalog objects a later release adds (`schema.mjs`,
    // FEATURE_SCHEMA_PREREQUISITES). Outside core readiness because `setup`
    // runs the core check on the base release, which does not create them.
    featureSchema: () =>
      check(
        read('featureSchema'),
        (value) => {
          if (
            !Array.isArray(value?.missing) ||
            value.missing.some((name) => !featureNames.has(name))
          )
            invalid();
          const missing = [...new Set(value.missing)].sort();
          return result(
            missing.length ? 'unhealthy' : 'healthy',
            missing.length ? 'feature_prerequisite_missing' : 'feature_prerequisites_present',
            { missing, checked: FEATURE_SCHEMA_PREREQUISITES.length },
          );
        },
        timeoutMs,
      ),
    // The image-attachment bucket (plan D12). Separate from `schema` because it
    // is a row rather than a catalog object and reading it needs BYPASSRLS; a
    // role without it loses this line and keeps the whole inventory.
    bucket: () =>
      check(
        read('bucket'),
        (value) => {
          if (
            !Array.isArray(value?.missing) ||
            value.missing.some((name) => !bucketNames.has(name))
          )
            invalid();
          const missing = [...new Set(value.missing)].sort();
          return result(
            missing.length ? 'unhealthy' : 'healthy',
            missing.length ? 'bucket_missing' : 'buckets_present',
            { missing, checked: BUCKET_PREREQUISITES.length },
          );
        },
        timeoutMs,
      ),
    backfill: () =>
      check(
        read('backfill'),
        (value) => {
          if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value)) invalid();
          return result(
            value === '0' ? 'healthy' : 'unhealthy',
            value === '0' ? 'no_backfill_gap' : 'backfill_gap',
            { eligibleNotes: value, includesTrash: true },
          );
        },
        timeoutMs,
      ),
    functions: () =>
      check(
        adapters.functions,
        (value) => {
          if (!Array.isArray(value)) invalid();
          const deployments = functions.map((slug) => {
            const matches = value.filter((f) => f?.slug === slug);
            if (matches.length > 1) invalid();
            const f = matches[0];
            const state = !f
              ? 'missing'
              : ['ACTIVE', 'REMOVED', 'THROTTLED'].includes(f.status)
                ? f.status
                : 'unknown';
            return {
              slug,
              state,
              ...(Number.isSafeInteger(f?.version) && f.version > 0 ? { version: f.version } : {}),
            };
          });
          const unknown = deployments.some((f) => f.state === 'unknown');
          const missing = deployments.some((f) => f.state !== 'ACTIVE' && f.state !== 'unknown');
          return result(
            missing ? 'unhealthy' : unknown ? 'unavailable' : 'healthy',
            missing
              ? 'functions_missing_or_inactive'
              : unknown
                ? 'invalid_response'
                : 'functions_active',
            { deployments },
          );
        },
        timeoutMs,
      ),
    aiSecrets: () =>
      check(
        adapters.secrets,
        (value) => {
          if (
            !Array.isArray(value) ||
            value.length > 1_000 ||
            value.some((entry) => typeof entry?.name !== 'string')
          )
            invalid();
          const names = value.map((entry) => entry.name);
          if (new Set(names).size !== names.length) invalid();
          return result('healthy', 'secret_names_read', {
            presence: AI_SECRET_NAMES.map((name) => ({ name, present: names.includes(name) })),
          });
        },
        timeoutMs,
      ),
    // Core-only diagnostics withhold the optional provider probes outright: the
    // Voyage probe is billable, so the flag must suppress the call itself rather
    // than trust the caller to omit the adapters. A withheld probe reports
    // exactly what an unsupplied adapter reports.
    openai: () => check(coreOnly ? undefined : adapters.openai, provider, timeoutMs),
    voyage: () => check(coreOnly ? undefined : adapters.voyage, provider, timeoutMs),
  };
  // Sequential database sessions keep load and connection use small. Independent
  // checks still run after errors; each has its own transaction and deadline.
  const checks = { localMigrations: local };
  for (const [name, task] of Object.entries(tasks)) checks[name] = await task();
  const summary = { healthy: 0, unhealthy: 0, unavailable: 0, not_configured: 0 };
  for (const c of Object.values(checks)) summary[c.status]++;
  const coreNames = [
    'localMigrations',
    'migrations',
    'epoch',
    'marker',
    'extensions',
    'schema',
    'functions',
  ];
  const coreSummary = { healthy: 0, unhealthy: 0, unavailable: 0, not_configured: 0 };
  for (const name of coreNames) coreSummary[checks[name].status]++;
  const coreStatus = coreSummary.unhealthy
    ? 'unhealthy'
    : coreSummary.unavailable
      ? 'unavailable'
      : coreSummary.not_configured
        ? 'not_configured'
        : 'healthy';
  const overallStatus = summary.unhealthy
    ? 'unhealthy'
    : summary.unavailable
      ? 'unavailable'
      : summary.not_configured
        ? 'not_configured'
        : 'healthy';
  const providers = {
    openai: checks.openai.status !== 'not_configured',
    voyage: checks.voyage.status !== 'not_configured',
  };
  const configuredCount = Number(providers.openai) + Number(providers.voyage);
  const aiConfiguration =
    configuredCount === 0 ? 'not_configured' : configuredCount === 1 ? 'partial' : 'configured';
  const providerChecks = [checks.openai, checks.voyage].filter(
    (providerCheck) => providerCheck.status !== 'not_configured',
  );
  const aiHealth =
    aiConfiguration === 'not_configured'
      ? 'not_configured'
      : providerChecks.some((providerCheck) => providerCheck.status === 'unhealthy')
        ? 'unhealthy'
        : providerChecks.some((providerCheck) => providerCheck.status === 'unavailable')
          ? 'unavailable'
          : 'healthy';
  return {
    schemaVersion: 1,
    status: coreOnly ? coreStatus : overallStatus,
    // The summary must count the same checks the status beside it was computed
    // from; `readiness` still reports core readiness and the AI probe separately.
    summary: coreOnly ? coreSummary : summary,
    readiness: {
      core: coreStatus,
      localAiProbe: { credentials: aiConfiguration, health: aiHealth, providers },
    },
    checks,
  };
}

export function formatReport(report) {
  const lines = [`Kinjot doctor: ${report.status}`, 'Read-only diagnostics; no changes made.'];
  if (report.readiness?.localAiProbe) {
    lines.push(
      `Locally supplied AI probe credentials: ${report.readiness.localAiProbe.credentials}; provider health: ${report.readiness.localAiProbe.health}`,
    );
  }
  for (const [name, c] of Object.entries(report.checks)) {
    lines.push(`${name}: ${c.status} (${c.code})`);
    if (name === 'aiSecrets') {
      const presence = c.details?.presence
        ?.map(({ name, present }) => `${name} ${present ? 'present' : 'missing'}`)
        .join(', ');
      lines.push(
        `AI secrets in Supabase: ${presence ?? c.status} (names only; values are never kept or shown)`,
      );
    }
    const d = c.details;
    if (!d) continue;
    if (name === 'localMigrations') lines.push(`  ${d.available.length} local versions`);
    if (name === 'migrations') {
      lines.push(`  ${d.applied.length} applied versions`);
      if (d.pending) lines.push(`  Pending: ${d.pending.join(', ') || 'none'}`);
      if (d.remoteOnly) lines.push(`  Remote-only: ${d.remoteOnly.join(', ') || 'none'}`);
    }
    if (name === 'epoch') lines.push(`  Expected ${d.expected}; database declares ${d.actual}`);
    if (name === 'marker')
      lines.push(`  Self-hosted: ${d.selfHosted === null ? 'singleton absent' : d.selfHosted}`);
    if (name === 'extensions') {
      for (const e of d.installed) lines.push(`  ${e.name}: ${e.version}`);
      if (d.missing.length) lines.push(`  Missing: ${d.missing.join(', ')}`);
    }
    if (name === 'schema') {
      lines.push(`  ${d.checked} structural prerequisites checked`);
      for (const missing of d.missing) lines.push(`  Missing or disabled: ${missing}`);
    }
    if (name === 'featureSchema') {
      lines.push(`  ${d.checked} feature prerequisites checked`);
      for (const missing of d.missing) {
        lines.push(
          `  Missing: ${missing} — the feature that needs it refuses until the migration that creates it is applied`,
        );
      }
    }
    if (name === 'bucket') {
      lines.push(`  ${d.checked} storage bucket prerequisite checked`);
      for (const missing of d.missing) {
        lines.push(`  Missing: ${missing} — images cannot be saved on this project`);
      }
    }
    if (name === 'backfill') lines.push(`  ${d.eligibleNotes} eligible notes (includes Trash)`);
    if (name === 'functions')
      for (const f of d.deployments)
        lines.push(`  ${f.slug}: ${f.state}${f.version ? ` (version ${f.version})` : ''}`);
    if (name === 'update')
      lines.push(
        `  Release ${d.target.version} (sequence ${d.target.sequence}) stopped after ${d.phase}; rerun Update for this release.`,
      );
  }
  if (report.checks.migrations.details?.remoteOnly?.length) {
    lines.push(
      'Remote-only migrations need investigation: verify the local release history, backup/restore history, and prior operator changes before considering manual migration repair. Doctor never repairs history.',
    );
  }
  lines.push(
    'Provider health checks only locally supplied credentials. Supabase secret presence does not establish provider health.',
    'Backfill count includes Trash and excludes existing embeddings and all existing jobs, including abandoned jobs.',
    'Function status is deployment metadata, not an invocation or a proof of provider configuration.',
  );
  return lines.join('\n') + '\n';
}
