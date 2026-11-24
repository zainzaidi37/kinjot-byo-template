import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { open, rm } from 'node:fs/promises';
import { UpdaterRefusal } from './refusal.mjs';

const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_REFUSAL_BYTES = 4096;
// The release Worker's fixed refusal vocabulary (`workers/release/endpoint.ts`
// `fixedError`): a status reads as a cause only with its own category.
const WORKER_REFUSALS = Object.freeze({
  403: Object.freeze({ category: 'license_refused', reason: 'release_license_refused' }),
  409: Object.freeze({ category: 'release_refused', reason: 'release_path_refused' }),
  503: Object.freeze({ category: 'service_unavailable', reason: 'release_service_unavailable' }),
});

function error() {
  return new Error('release download failed');
}

function header(response, name) {
  const value = response.headers.get(name);
  if (!value) throw error();
  return value;
}

function selection(response) {
  const value = {
    version: header(response, 'X-Kinjot-Release-Version'),
    sequence: Number(header(response, 'X-Kinjot-Release-Sequence')),
    sourceCommit: header(response, 'X-Kinjot-Release-Source-Commit'),
    clientCompatibilityEpoch: Number(header(response, 'X-Kinjot-Release-Compatibility-Epoch')),
    manifestSha256: header(response, 'X-Kinjot-Manifest-Sha256'),
    archiveSha256: header(response, 'X-Kinjot-Archive-Sha256'),
    archiveBytes: Number(header(response, 'X-Kinjot-Archive-Bytes')),
  };
  if (
    !VERSION.test(value.version) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence <= 0 ||
    !COMMIT.test(value.sourceCommit) ||
    !Number.isSafeInteger(value.clientCompatibilityEpoch) ||
    value.clientCompatibilityEpoch <= 0 ||
    !SHA.test(value.manifestSha256) ||
    !SHA.test(value.archiveSha256) ||
    !Number.isSafeInteger(value.archiveBytes) ||
    value.archiveBytes <= 0 ||
    value.archiveBytes > MAX_ARCHIVE_BYTES
  )
    throw error();
  return Object.freeze(value);
}

async function upToDate(response, beforeDeadline) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 1024)) throw error();
  const reader = response.body?.getReader?.();
  if (!reader) throw error();
  const chunks = [];
  let bytes = 0;
  let ended = false;
  for (let reads = 0; reads < 16; reads++) {
    const { done, value } = await beforeDeadline(reader.read());
    if (done) {
      ended = true;
      break;
    }
    bytes += value.byteLength;
    if (bytes > 1024) throw error();
    chunks.push(Buffer.from(value));
  }
  if (!ended) throw error();
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw error();
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).join('\0') !== 'status' ||
    value.status !== 'up-to-date'
  ) {
    throw error();
  }
}

/**
 * The Worker's `{"error":"<category>"}` body on a 403, 409 or 503, read
 * within the download's deadline and at most 4 KiB, as a refusal reason; any
 * other status, size or shape is `null`, the plain download failure.
 */
async function workerRefusal(response, beforeDeadline) {
  const expected = Object.hasOwn(WORKER_REFUSALS, response.status)
    ? WORKER_REFUSALS[response.status]
    : null;
  if (!expected) return null;
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_REFUSAL_BYTES)) {
    return null;
  }
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  const chunks = [];
  let bytes = 0;
  for (let reads = 0; reads < 16; reads++) {
    const { done, value } = await beforeDeadline(reader.read());
    if (done) {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      } catch {
        return null;
      }
      return parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).join('\0') === 'error' &&
        parsed.error === expected.category
        ? expected.reason
        : null;
    }
    bytes += value.byteLength;
    if (bytes > MAX_REFUSAL_BYTES) break;
    chunks.push(Buffer.from(value));
  }
  try {
    void Promise.resolve(reader.cancel()).catch(() => {});
  } catch {
    // An oversized or endless body is the plain download failure.
  }
  return null;
}

export async function downloadRelease({
  endpoint,
  expectedR2Origin,
  request,
  archivePath,
  fetchImpl = fetch,
  timeoutMs = 120_000,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60_000) {
    throw error();
  }
  const releaseUrl = new URL(endpoint);
  if (releaseUrl.protocol !== 'https:') throw error();
  const expectedOrigin = new URL(expectedR2Origin);
  if (
    expectedOrigin.protocol !== 'https:' ||
    expectedOrigin.origin !== expectedR2Origin ||
    expectedOrigin.pathname !== '/'
  ) {
    throw error();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const aborted = new Promise((_, reject) =>
    controller.signal.addEventListener('abort', () => reject(error()), { once: true }),
  );
  const beforeDeadline = (operation) => Promise.race([operation, aborted]);
  let handle;
  let refusal = null;
  try {
    const first = await beforeDeadline(
      fetchImpl(releaseUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      }),
    );
    if (first.status === 200) {
      await upToDate(first, beforeDeadline);
      return Object.freeze({ status: 'up-to-date' });
    }
    if (first.status !== 303) {
      const reason = await workerRefusal(first, beforeDeadline);
      if (reason) refusal = new UpdaterRefusal(reason);
      throw refusal ?? error();
    }
    const expected = selection(first);
    const location = new URL(header(first, 'location'));
    if (location.origin !== expectedR2Origin || location.protocol !== 'https:') throw error();

    // This is a deliberately new request. Only the signed URL crosses the R2
    // boundary: no license body, endpoint headers, or other credentials do.
    const response = await beforeDeadline(
      fetchImpl(location, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      }),
    );
    if (!response.ok || Number(response.headers.get('content-length')) !== expected.archiveBytes)
      throw error();
    const reader = response.body?.getReader?.();
    if (!reader) throw error();
    handle = await open(archivePath, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    let ended = false;
    for (let reads = 0; reads < 65_536; reads++) {
      const { done, value } = await beforeDeadline(reader.read());
      if (done) {
        ended = true;
        break;
      }
      if (!value.byteLength) continue;
      bytes += value.byteLength;
      if (bytes > expected.archiveBytes) throw error();
      hash.update(value);
      await handle.write(value);
    }
    if (!ended || bytes !== expected.archiveBytes || hash.digest('hex') !== expected.archiveSha256)
      throw error();
    await handle.sync();
    await handle.close();
    handle = undefined;
    return Object.freeze({ status: 'downloaded', archive: archivePath, expected });
  } catch {
    await handle?.close().catch(() => {});
    await rm(archivePath, { force: true });
    throw refusal ?? error();
  } finally {
    clearTimeout(timer);
  }
}
