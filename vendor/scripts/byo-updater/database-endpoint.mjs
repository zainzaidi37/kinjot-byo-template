import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { databaseConnection } from './operator-config.mjs';
import { UpdaterRefusal } from './refusal.mjs';
import { runBoundedProcess } from './safe-process.mjs';

// Supabase publishes `db.<ref>.supabase.co` over IPv6 only. GitHub-hosted
// runners are IPv4-only, so an operator who pastes the Connect dialog's default
// URL cannot reach their own database, while every structural check on that URL
// passes. Rather than refuse a correct-looking secret, resolve the project's
// session pooler from the Management API — the token is already supplied for
// function deployment — and retry once.
//
// The pooler host is never guessed from the region: only the API's own
// `db_host` is used. The API advertises port 6543, which is Supavisor's
// transaction mode; migrations need session mode, which is the same host on
// 5432.
const SESSION_POOLER_PORT = '5432';
const POOLER_HOST_SUFFIX = '.pooler.supabase.com';
const PROBE_CEILING_MS = 15_000;
const MAX_POOLER_BODY_BYTES = 64 * 1024;
const MAX_BODY_READS = 128;
// psql's connection failure is one short line; the head of stderr carries it.
// Kept in memory only to classify the failure, never printed or stored.
const MAX_PROBE_STDERR_BYTES = 4096;
const PASSWORD_REJECTED =
  /password authentication failed|\b(?:FATAL|ERROR):\s+28[0-9A-Z]{3}\b|\bSQLSTATE\W{0,3}28[0-9A-Z]{3}\b/i;

/** A probe's outcome: the database answered, refused the password, or did not answer. */
export const PROBE_REACHABLE = 'reachable';
export const PROBE_AUTH_FAILED = 'auth_failed';
export const PROBE_UNREACHABLE = 'unreachable';

function directHost(url, projectRef) {
  return url.hostname === `db.${projectRef}.supabase.co`;
}

/**
 * A single bounded reachability probe. A rejected password (psql's or
 * Supavisor's "password authentication failed", or an SQLSTATE of class 28) is
 * `PROBE_AUTH_FAILED`; every other failure, including a timeout, is
 * `PROBE_UNREACHABLE`. The probe never retries on its own.
 *
 * `runBoundedProcess`'s `failure()` (`safe-process.mjs`) keeps only an
 * allow-listed SQLSTATE from a failed child's stderr, as `error.sqlstate`, and
 * psql's connection errors carry none; so the probe also taps the first
 * `MAX_PROBE_STDERR_BYTES` through its `spawnImpl`. The bytes live in this
 * call's closure only: they are matched against `PASSWORD_REJECTED` and
 * dropped, never printed, interpolated into an error or kept.
 */
export function createPsqlProbe({
  psql,
  cwd,
  timeoutMs,
  runProcess = runBoundedProcess,
  spawnImpl = spawn,
}) {
  return async function probe(connection) {
    const head = [];
    let headBytes = 0;
    const tappedSpawn = (...args) => {
      const child = spawnImpl(...args);
      child?.stderr?.on?.('data', (chunk) => {
        if (headBytes >= MAX_PROBE_STDERR_BYTES) return;
        const bytes = Buffer.from(chunk).subarray(0, MAX_PROBE_STDERR_BYTES - headBytes);
        head.push(bytes);
        headBytes += bytes.byteLength;
      });
      return child;
    };
    try {
      await runProcess({
        executable: psql,
        args: [
          '--no-psqlrc',
          '--no-password',
          '--quiet',
          '--tuples-only',
          '--no-align',
          '--set=ON_ERROR_STOP=1',
          '--command=select 1',
        ],
        cwd,
        env: connection.psqlEnv,
        timeoutMs: Math.min(timeoutMs, PROBE_CEILING_MS),
        label: 'database reachability probe',
        spawnImpl: tappedSpawn,
      });
      return PROBE_REACHABLE;
    } catch (error) {
      let sqlstate;
      try {
        sqlstate = error?.sqlstate;
      } catch {
        // A hostile error object cannot replace the classification.
      }
      const rejected =
        (typeof sqlstate === 'string' && sqlstate.startsWith('28')) ||
        PASSWORD_REJECTED.test(Buffer.concat(head, headBytes).toString('utf8'));
      return rejected ? PROBE_AUTH_FAILED : PROBE_UNREACHABLE;
    } finally {
      head.length = 0;
    }
  };
}

function cancelBody(response) {
  try {
    const cancellation = response?.body?.cancel?.();
    cancellation?.catch?.(() => {});
  } catch {
    // Cleanup must never replace the fixed endpoint refusal.
  }
}

async function boundedJson(response, setActiveReader, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && (declared < 0 || declared > maxBytes)) {
    cancelBody(response);
    throw new Error('invalid pooler response');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    cancelBody(response);
    throw new Error('invalid pooler response');
  }
  setActiveReader(reader);
  const chunks = [];
  let size = 0;
  let reads = 0;
  while (true) {
    if ((reads += 1) > MAX_BODY_READS) {
      cancelReader(reader);
      throw new Error('invalid pooler response');
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) {
      cancelReader(reader);
      throw new Error('invalid pooler response');
    }
    size += value.byteLength;
    if (size > maxBytes) {
      cancelReader(reader);
      throw new Error('invalid pooler response');
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

function cancelReader(reader) {
  try {
    const cancellation = reader?.cancel?.();
    cancellation?.catch?.(() => {});
  } catch {
    // Cleanup must never replace the fixed endpoint refusal.
  }
}

/**
 * One bounded Management API GET: one request, `PROBE_CEILING_MS` at most,
 * `maxBytes` of body at most, no redirect and no retry. Resolves to
 * `select(body)`, or null on any failure. The parsed body stays inside this
 * call: only `select`'s result leaves it, and an error's text (a JSON parse
 * error can quote the body) is never kept.
 */
export async function managementJson({
  path,
  managementToken,
  timeoutMs,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_POOLER_BODY_BYTES,
  select,
}) {
  const controller = new AbortController();
  let activeReader;
  let timer;
  const operation = Promise.resolve()
    .then(() =>
      fetchImpl(`https://api.supabase.com/v1/projects/${path}`, {
        headers: { Authorization: `Bearer ${managementToken}` },
        redirect: 'error',
        signal: controller.signal,
      }),
    )
    .then(async (response) => {
      if (!response?.ok) {
        cancelBody(response);
        return null;
      }
      const body = await boundedJson(
        response,
        (reader) => {
          activeReader = reader;
        },
        maxBytes,
      );
      return select(body) ?? null;
    })
    .catch(() => null);
  // A mocked or broken fetch implementation may ignore AbortSignal. Race it so
  // the caller is still released at the advertised deadline, and retain a
  // rejection handler on the underlying operation for any late settlement.
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => {
        try {
          controller.abort();
        } catch {
          // The deadline remains authoritative even if abort itself misbehaves.
        }
        cancelReader(activeReader);
        resolve(null);
      },
      Math.min(timeoutMs, PROBE_CEILING_MS),
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function poolerHost({ projectRef, managementToken, timeoutMs, fetchImpl }) {
  return managementJson({
    path: `${projectRef}/config/database/pooler`,
    managementToken,
    timeoutMs,
    fetchImpl,
    select: (body) => {
      if (!Array.isArray(body) || body.length > 128) return null;
      const primary = body.find((entry) => entry?.database_type === 'PRIMARY');
      const host = primary?.db_host;
      if (typeof host !== 'string' || !host.endsWith(POOLER_HOST_SUFFIX)) return null;
      // A hostile or misconfigured response must not become a connection target.
      if (new URL(`https://${host}`).hostname !== host) return null;
      return host;
    },
  });
}

/**
 * True only when the Management API answers with a project status other than
 * `ACTIVE_HEALTHY` (a paused, pausing, restoring or starting project). An
 * unreadable answer is false, so the caller keeps the refusal it had.
 * One bounded request; callers make it only after a database failure.
 */
export async function projectNotActive({ projectRef, managementToken, timeoutMs, fetchImpl }) {
  if (typeof managementToken !== 'string' || !managementToken) return false;
  const status = await managementJson({
    path: projectRef,
    managementToken,
    timeoutMs,
    fetchImpl,
    select: (body) =>
      typeof body?.status === 'string' && /^[A-Z_]{1,64}$/.test(body.status) ? body.status : null,
  });
  return status !== null && status !== 'ACTIVE_HEALTHY';
}

/**
 * The refusal for a database that did not answer as configured: the project's
 * status first (one bounded request), then the password, then `fallback`.
 * Supavisor's answer for a paused tenant is unobserved, so any database failure
 * checks the status first, a rejected password included.
 */
export async function databaseFailureRefusal({
  outcome,
  fallback,
  projectRef,
  managementToken,
  timeoutMs,
  fetchImpl = globalThis.fetch,
}) {
  if (await projectNotActive({ projectRef, managementToken, timeoutMs, fetchImpl })) {
    return new UpdaterRefusal('supabase_project_not_active');
  }
  return new UpdaterRefusal(
    outcome === PROBE_AUTH_FAILED ? 'database_password_rejected' : fallback,
  );
}

function pooledUrl(url, host, projectRef) {
  const pooled = new URL(url);
  pooled.hostname = host;
  pooled.port = SESSION_POOLER_PORT;
  pooled.username = encodeURIComponent(`postgres.${projectRef}`);
  return pooled.toString();
}

/**
 * Returns the database URL to use, which is the operator's own URL unless it
 * names the unreachable direct host and a pooler endpoint answers in its place.
 *
 * Bounded by construction: at most two Management API requests (the pooler
 * lookup, and the project status after a failure) and at most two probes, with
 * no retry budget of its own and no recursion. A URL that is not a
 * direct-host URL is returned untouched without any probe, so the common case
 * costs nothing.
 */
export async function resolveDatabaseEndpoint({
  databaseUrl,
  projectRef,
  managementToken,
  timeoutMs,
  probe,
  fetchImpl = globalThis.fetch,
}) {
  // Structural problems stay with `databaseConnection`, whose refusals name the
  // exact defect. Resolving must never pre-empt those messages.
  let connection;
  let url;
  try {
    url = new URL(databaseUrl);
    connection = databaseConnection(databaseUrl, projectRef, timeoutMs);
  } catch {
    return databaseUrl;
  }
  if (!directHost(url, projectRef)) return databaseUrl;
  const refusal = (outcome, fallback) =>
    databaseFailureRefusal({
      outcome,
      fallback,
      projectRef,
      managementToken,
      timeoutMs,
      fetchImpl,
    });
  const direct = await probe(connection);
  if (direct === PROBE_REACHABLE) return databaseUrl;
  // An IPv6 runner reached the host and the password was refused: the pooler
  // holds the same password, so it is not tried.
  if (direct === PROBE_AUTH_FAILED) throw await refusal(direct, 'database_password_rejected');

  const host = await poolerHost({ projectRef, managementToken, timeoutMs, fetchImpl });
  if (!host) throw await refusal(PROBE_UNREACHABLE, 'database_direct_host_unreachable');

  const candidate = pooledUrl(url, host, projectRef);
  let pooledConnection;
  try {
    pooledConnection = databaseConnection(candidate, projectRef, timeoutMs);
  } catch {
    throw new UpdaterRefusal('database_direct_host_unreachable');
  }
  const pooled = await probe(pooledConnection);
  if (pooled !== PROBE_REACHABLE) throw await refusal(pooled, 'database_unreachable');
  return candidate;
}
