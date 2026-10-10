import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { stripVTControlCharacters } from 'node:util';
import { delimiter, dirname, isAbsolute } from 'node:path';

const MAX_OUTPUT = 1024 * 1024;
const SQLSTATES = new Set([
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

// Diagnostics belong only to this control and its formatter, never to state.
const diagnostics = new WeakMap();
const MAX_DIAGNOSTIC_BYTES = 2048;
const DIAGNOSTIC_PREFIX = '  | ';

export function copyProcessDiagnostic(target, source) {
  const tail = source && typeof source === 'object' ? diagnostics.get(source) : undefined;
  if (tail) {
    diagnostics.set(target, tail);
  }
  return target;
}

export function formatProcessDiagnostic(error) {
  return error && typeof error === 'object' ? (diagnostics.get(error) ?? '') : '';
}

function sanitizedTail(stderr, secrets) {
  const values = new Set();
  for (const secret of secrets) {
    if (!secret) continue;
    values.add(secret);
    const encoded = encodeURIComponent(secret);
    values.add(encoded);
    values.add(encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
    values.add(encoded.replace(/%20/g, '+'));
  }
  const redactValues = (text) => {
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
      text = text.split(value).join('[REDACTED]');
    }
    return text;
  };
  // Redact before ANY tail selection, including credentials crossing its edge.
  let text = redactValues(stderr);
  text = stripVTControlCharacters(text)
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === '\n' ? '\n' : ''));
  text = redactValues(text)
    .replace(/\bpostgres(?:ql)?:\/\/[^\s/@]+:[^\s@]*@/gi, 'postgresql://[REDACTED]@')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(?:sbp_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
      '[REDACTED]',
    );
  if (!text.trim()) return '';
  // Budget prefixes and newlines too, and keep complete UTF-8 characters.
  const lines = text.trimEnd().split('\n');
  const tail = [];
  let remaining = MAX_DIAGNOSTIC_BYTES;
  for (
    let index = lines.length - 1;
    index >= 0 && remaining > DIAGNOSTIC_PREFIX.length + 1;
    index--
  ) {
    const characters = [];
    let budget = remaining - DIAGNOSTIC_PREFIX.length - 1;
    const line = Array.from(lines[index]);
    for (let offset = line.length - 1; offset >= 0; offset--) {
      const size = Buffer.byteLength(line[offset]);
      if (size > budget) break;
      characters.push(line[offset]);
      budget -= size;
    }
    const printed = `${DIAGNOSTIC_PREFIX}${characters.reverse().join('')}\n`;
    tail.unshift(printed);
    remaining -= Buffer.byteLength(printed);
  }
  return tail.join('');
}

export function isolatedCliEnvironment(home, additions = {}, nodeExecutable = process.execPath) {
  if (
    !isAbsolute(home) ||
    !isAbsolute(nodeExecutable) ||
    Object.hasOwn(additions, 'PATH') ||
    Object.values(additions).some((value) => typeof value !== 'string')
  ) {
    throw new Error('invalid isolated CLI environment');
  }
  const path = [...new Set([dirname(nodeExecutable), '/usr/local/bin', '/usr/bin', '/bin'])].join(
    delimiter,
  );
  return Object.freeze({
    ...additions,
    HOME: home,
    XDG_CACHE_HOME: `${home}/cache`,
    XDG_CONFIG_HOME: `${home}/config`,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: path,
    SUPABASE_TELEMETRY_DISABLED: '1',
  });
}

function failure(label, stderr = '', diagnosticSecrets) {
  const found =
    /(?:ERROR|FATAL):\s+([0-9A-Z]{5}):/.exec(stderr)?.[1] ??
    /\bSQLSTATE\s*[(:=]?\s*([0-9A-Z]{5})\b/.exec(stderr)?.[1];
  const sqlstate =
    SQLSTATES.has(found) || (found?.length === 5 && /^KJ0[0-9]{2}$/.test(found))
      ? found
      : undefined;
  const error = Object.assign(
    new Error(`${label} failed${sqlstate ? ` (SQLSTATE ${sqlstate})` : ''}`),
    {
      code: 'command_failed',
      ...(sqlstate ? { sqlstate } : {}),
    },
  );
  if (diagnosticSecrets) {
    const tail = sanitizedTail(stderr, diagnosticSecrets);
    if (tail) {
      diagnostics.set(error, tail);
    }
  }
  return error;
}

export function runBoundedProcess({
  executable,
  args,
  cwd,
  env,
  input = '',
  timeoutMs,
  label,
  spawnImpl = spawn,
  diagnosticSecrets,
}) {
  if (
    typeof executable !== 'string' ||
    !isAbsolute(executable) ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg)) ||
    typeof cwd !== 'string' ||
    !isAbsolute(cwd) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15 * 60_000 ||
    typeof label !== 'string' ||
    !label ||
    typeof input !== 'string' ||
    (diagnosticSecrets !== undefined &&
      (!Array.isArray(diagnosticSecrets) ||
        diagnosticSecrets.some((value) => typeof value !== 'string')))
  ) {
    throw new Error('invalid updater subprocess configuration');
  }
  const exposesDiagnostic =
    diagnosticSecrets !== undefined &&
    (/^Supabase function deployment: [a-z0-9]+(?:-[a-z0-9]+)*$/.test(label) ||
      label === 'Cloudflare Pages publication');
  return new Promise((resolve, reject) => {
    let child;
    const usesProcessGroup = process.platform !== 'win32';
    try {
      child = spawnImpl(executable, args, {
        cwd,
        env: Object.freeze({ ...env }),
        detached: usesProcessGroup,
        shell: false,
        stdio: [input.length ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(failure(label));
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let closeSeen = false;
    let closeCode;
    let abortError;
    let terminationPoll;
    const processGroup =
      usesProcessGroup && Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
    const processGroupIsLive = () => {
      if (processGroup === null) return false;
      try {
        process.kill(-processGroup, 0);
        return true;
      } catch (error) {
        return error?.code !== 'ESRCH';
      }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminationPoll) clearTimeout(terminationPoll);
      if (error) reject(error);
      else resolve(value);
    };
    const finishAfterTermination = () => {
      if (settled || !closeSeen) return;
      if (processGroupIsLive()) {
        if (!terminationPoll) {
          terminationPoll = setTimeout(() => {
            terminationPoll = undefined;
            finishAfterTermination();
          }, 10);
        }
        return;
      }
      if (abortError) {
        finish(abortError);
        return;
      }
      if (closeCode !== 0) {
        finish(
          failure(
            label,
            Buffer.concat(stderr).toString('utf8'),
            exposesDiagnostic ? diagnosticSecrets : undefined,
          ),
        );
      } else {
        finish(null, Buffer.concat(stdout));
      }
    };
    const abort = (error) => {
      if (settled || abortError) return;
      abortError = error;
      let groupSignaled = false;
      if (processGroup !== null) {
        try {
          process.kill(-processGroup, 'SIGKILL');
          groupSignaled = true;
        } catch {
          // The group may not have formed yet or may already have exited.
        }
      }
      if (!groupSignaled) {
        try {
          child.kill('SIGKILL');
        } catch {
          // The fixed error below remains authoritative.
        }
      }
      finishAfterTermination();
    };
    const timer = setTimeout(
      () => abort(Object.assign(new Error(`${label} timed out`), { code: 'timeout' })),
      timeoutMs,
    );
    child.stdout.on('data', (chunk) => {
      if (abortError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT) abort(failure(label));
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (abortError) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT) abort(failure(label));
      else stderr.push(chunk);
    });
    child.once('error', () => abort(failure(label)));
    child.once('close', (code) => {
      closeSeen = true;
      closeCode = code;
      finishAfterTermination();
    });
    if (input.length) {
      child.stdin.once('error', () => abort(failure(label)));
      try {
        child.stdin.end(input);
      } catch {
        abort(failure(label));
      }
    }
  });
}
