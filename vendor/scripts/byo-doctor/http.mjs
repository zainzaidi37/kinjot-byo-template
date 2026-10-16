import { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout } from 'node:timers';
import { TextDecoder } from 'node:util';

// Official API references:
// - Supabase: https://supabase.com/docs/reference/api/v1-list-all-functions
// - Supabase secrets: https://supabase.com/docs/reference/api/v1-list-all-secrets
// - OpenAI: https://platform.openai.com/docs/api-reference/models/list
// - Voyage: https://docs.voyageai.com/reference/embeddings-api-1

const MANAGEMENT_ORIGIN = 'https://api.supabase.com';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const VOYAGE_EMBEDDINGS_URL = 'https://api.voyageai.com/v1/embeddings';
const MAX_MANAGEMENT_BODY_BYTES = 256 * 1024;
const PROJECT_REF = /^[a-z0-9]{20}$/;
// Deliberately looser than the manifest boundary: this describes what the
// provider already has deployed, not a slug we are about to deploy.
const MANAGEMENT_API_SLUG = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const FUNCTION_STATUSES = new Set(['ACTIVE', 'REMOVED', 'THROTTLED']);

class SafeHttpError extends Error {
  constructor(code) {
    super(code);
    this.name = 'HttpAdapterError';
    this.code = code;
  }
}

function safeError(code) {
  return new SafeHttpError(code);
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== '';
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function validCredential(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    Buffer.byteLength(value, 'utf8') <= MAX_CREDENTIAL_BYTES &&
    !hasControlCharacter(value)
  );
}

function validTimeout(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 60_000;
}

function statusCode(status) {
  if (status === 401) return 'authentication_rejected';
  if (status === 403) return 'permission_denied';
  if (status === 429) return 'rate_limited';
  if (status >= 300 && status < 400) return 'unsupported_probe';
  return 'unavailable';
}

function discardBody(response) {
  try {
    const cancellation = response.body?.cancel?.();
    cancellation?.catch?.(() => {});
  } catch {
    // A response body is untrusted too. Its cancellation failure is not useful
    // diagnostic output and must never replace the status classification.
  }
}

async function withDeadline(timeoutMs, operation, onTimeout = () => {}) {
  const controller = new globalThis.AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // Abort failures do not change the safe timeout result.
      }
      try {
        onTimeout();
      } catch {
        // Cleanup is best effort; the caller is still released at the deadline.
      }
      reject(safeError('timeout'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSafely(fetchImpl, signal, url, init) {
  try {
    return await fetchImpl(url, { ...init, redirect: 'error', signal });
  } catch (error) {
    if (error instanceof SafeHttpError) throw error;
    throw safeError('network_error');
  }
}

async function request(fetchImpl, timeoutMs, url, init) {
  return withDeadline(timeoutMs, (signal) => fetchSafely(fetchImpl, signal, url, init));
}

async function readLimitedJson(response, setActiveReader) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_MANAGEMENT_BODY_BYTES) {
      discardBody(response);
      throw safeError('invalid_response');
    }
  }

  const reader = response.body?.getReader?.();
  if (!reader) throw safeError('invalid_response');
  setActiveReader(reader);

  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof globalThis.Uint8Array)) throw safeError('invalid_response');
    received += value.byteLength;
    if (received > MAX_MANAGEMENT_BODY_BYTES) {
      try {
        const cancellation = reader.cancel();
        cancellation?.catch?.(() => {});
      } catch {
        // The size violation remains the only externally visible error.
      }
      throw safeError('invalid_response');
    }
    chunks.push(value);
  }

  const bytes = new globalThis.Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function parseFunctions(value) {
  if (!Array.isArray(value) || value.length > 1_000) throw safeError('invalid_response');
  return value.map((entry) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !MANAGEMENT_API_SLUG.test(entry.slug) ||
      typeof entry.status !== 'string' ||
      entry.status.length < 1 ||
      entry.status.length > 64
    ) {
      throw safeError('invalid_response');
    }

    const item = {
      slug: entry.slug,
      status: FUNCTION_STATUSES.has(entry.status) ? entry.status : 'UNKNOWN',
    };
    if (entry.version !== undefined) {
      if (!Number.isSafeInteger(entry.version)) throw safeError('invalid_response');
      item.version = entry.version;
    }
    return item;
  });
}

function parseSecrets(value) {
  if (!Array.isArray(value) || value.length > 1_000) throw safeError('invalid_response');
  return value.map((entry) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.name !== 'string' ||
      entry.name.length < 1 ||
      entry.name.length > 256 ||
      hasControlCharacter(entry.name)
    ) {
      throw safeError('invalid_response');
    }
    return { name: entry.name };
  });
}

function providerResult(response) {
  if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) {
    discardBody(response);
    return { status: 'unavailable', code: 'invalid_response' };
  }
  discardBody(response);
  if (response.status >= 200 && response.status < 300) {
    return { status: 'healthy', code: 'authentication_accepted' };
  }
  const code = statusCode(response.status);
  return {
    status: code === 'authentication_rejected' ? 'unhealthy' : 'unavailable',
    code,
  };
}

async function providerProbe(fetchImpl, timeoutMs, url, init) {
  try {
    return providerResult(await request(fetchImpl, timeoutMs, url, init));
  } catch (error) {
    return {
      status: 'unavailable',
      code: error instanceof SafeHttpError ? error.code : 'network_error',
    };
  }
}

export function createHttpAdapters({
  projectRef,
  managementToken,
  openaiKey,
  voyageKey,
  allowBillableVoyage = false,
  timeoutMs = 5_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const adapters = {};

  if (isPresent(managementToken)) {
    for (const [endpoint, parse] of [
      ['functions', parseFunctions],
      ['secrets', parseSecrets],
    ]) {
      adapters[endpoint] = async () => {
        if (
          !PROJECT_REF.test(projectRef) ||
          !validCredential(managementToken) ||
          !validTimeout(timeoutMs) ||
          typeof fetchImpl !== 'function'
        ) {
          throw safeError('invalid_response');
        }

        try {
          let activeReader;
          return await withDeadline(
            timeoutMs,
            async (signal) => {
              const response = await fetchSafely(
                fetchImpl,
                signal,
                `${MANAGEMENT_ORIGIN}/v1/projects/${projectRef}/${endpoint}`,
                {
                  method: 'GET',
                  headers: {
                    authorization: `Bearer ${managementToken}`,
                    accept: 'application/json',
                  },
                },
              );
              if (
                !Number.isInteger(response?.status) ||
                response.status < 100 ||
                response.status > 599
              ) {
                discardBody(response);
                throw safeError('invalid_response');
              }
              if (response.status < 200 || response.status >= 300) {
                discardBody(response);
                throw safeError(statusCode(response.status));
              }
              return parse(
                await readLimitedJson(response, (reader) => {
                  activeReader = reader;
                }),
              );
            },
            () => {
              try {
                const cancellation = activeReader?.cancel?.();
                cancellation?.catch?.(() => {});
              } catch {
                // The timeout result must not expose cleanup errors.
              }
            },
          );
        } catch (error) {
          if (error instanceof SafeHttpError) throw error;
          throw safeError('invalid_response');
        }
      };
    }
  }

  if (isPresent(openaiKey)) {
    adapters.openai = async () => {
      if (
        !validCredential(openaiKey) ||
        !validTimeout(timeoutMs) ||
        typeof fetchImpl !== 'function'
      ) {
        return { status: 'unavailable', code: 'invalid_response' };
      }
      return providerProbe(fetchImpl, timeoutMs, OPENAI_MODELS_URL, {
        method: 'GET',
        headers: { authorization: `Bearer ${openaiKey}`, accept: 'application/json' },
      });
    };
  }

  if (isPresent(voyageKey)) {
    adapters.voyage = async () => {
      if (allowBillableVoyage !== true) {
        return { status: 'unavailable', code: 'probe_requires_consent' };
      }
      if (
        !validCredential(voyageKey) ||
        !validTimeout(timeoutMs) ||
        typeof fetchImpl !== 'function'
      ) {
        return { status: 'unavailable', code: 'invalid_response' };
      }
      return providerProbe(fetchImpl, timeoutMs, VOYAGE_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${voyageKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ input: 'kinjot provider check', model: 'voyage-4-lite' }),
      });
    };
  }

  return adapters;
}
