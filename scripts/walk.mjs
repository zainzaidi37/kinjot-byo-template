#!/usr/bin/env node
/**
 * Brings a deployment to the newest release, one release at a time.
 *
 * Each release only installs over its predecessor, so a deployment several
 * releases behind needs one `update` per release. This walk runs those updates
 * for the workflow: every hop is a separate `customer-cli.mjs update` process,
 * so every hop is still validated and applied by the installed release's own
 * control. The walk decides only whether to start another hop, from the
 * installed sequence in durable state before and after each one.
 *
 * It belongs to this template and never ships in a release archive: it lives
 * outside `vendor/` and is not in the runtime inventory.
 *
 * Bounds: at most `MAX_HOPS` hops per run, no new hop after `BUDGET_MS` of
 * walking, and each hop is killed after `HOP_TIMEOUT_MS`.
 *
 * With `--after-setup` (the workflow's `setup` operation), a walk that ends
 * successfully on an installed release also prints the operator's next steps
 * and appends them to the run's summary page (`GITHUB_STEP_SUMMARY`).
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readHandoffStateFile } from '../vendor/scripts/byo-updater/handoff.mjs';

export const MAX_HOPS = 10;
export const BUDGET_MS = 20 * 60 * 1000;
/**
 * A backstop, not a schedule: a hop is `db push` plus bounded function deploys
 * and normally finishes well inside this. The workflow's job timeout is the
 * outer bound.
 */
export const HOP_TIMEOUT_MS = 45 * 60 * 1000;
const KILL_GRACE_MS = 30 * 1000;

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CUSTOMER_CLI = join(TEMPLATE, 'vendor', 'scripts', 'byo-updater', 'customer-cli.mjs');

/**
 * The child's environment: the parent's, minus `KINJOT_AUTHENTICATED_CONTROL`.
 * That flag tells the bootstrap it is already running inside an authenticated
 * control, so passing it would make a hop skip the hand-off to the installed
 * release.
 */
export function childEnvironment(env) {
  const copy = { ...env };
  delete copy.KINJOT_AUTHENTICATED_CONTROL;
  return copy;
}

/** `null` state (no state file) means nothing is installed. */
export function installedFromState(state) {
  const release = state?.installedRelease ?? null;
  return {
    sequence: release?.sequence ?? 0,
    version: release?.version ?? null,
    mode: typeof state?.mode === 'string' ? state.mode : null,
  };
}

/** The same name rule as `validateOperatorConfig` (`vendor/scripts/byo-updater/operator-config.mjs`). */
const PAGES_PROJECT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const INCLUDED_APP = 'https://byo.kinjot.com';

/**
 * The operator's next steps once setup has walked to its last release, as
 * plain lines that also read as Markdown on the run's summary page. In
 * `full` mode the app is the operator's own Pages site; the license gate is
 * only on the included app at byo.kinjot.com (`workers/byo-origin/endpoint.ts`).
 */
export function completionBlock(installed, env = {}) {
  const full = installed.mode === 'full';
  const pages = env.KINJOT_PAGES_PROJECT;
  const app = !full
    ? INCLUDED_APP
    : typeof pages === 'string' && PAGES_PROJECT.test(pages)
      ? `https://${pages}.pages.dev`
      : 'your Cloudflare Pages site';
  return [
    `Kinjot setup is complete: release ${installed.version} is installed.`,
    '',
    `App: ${app}`,
    '',
    'Next steps:',
    '',
    '1. Create your account. In Supabase, open Authentication → Users → Add user → Create new user, enter your email and a password, and tick Auto Confirm User.',
    full
      ? `2. Open ${app} and connect with your Project URL and publishable key (Supabase: Project Settings → API Keys). Sign in with the account from step 1.`
      : `2. Open ${app}, enter your license key, and connect with your Project URL and publishable key (Supabase: Project Settings → API Keys). Sign in with the account from step 1.`,
    '3. AI is optional. To turn it on, add OPENAI_API_KEY and VOYAGE_API_KEY under Edge Functions → Secrets in Supabase, then in Kinjot open Settings → AI provider → Enable AI and choose Recheck.',
  ];
}

/**
 * Appends to the run's summary page. Best effort: an unset variable or a
 * failed write never changes the walk's result.
 */
export function appendStepSummary(text, env = process.env) {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, text);
  } catch {
    process.stderr.write('Could not add the next steps to the run summary; they are above.\n');
  }
}

function describe(installed) {
  return installed.sequence === 0
    ? 'no installed release'
    : `release ${installed.version} (sequence ${installed.sequence})`;
}

/**
 * The walk itself, with every effect injected.
 *
 * - `runHop(env)` runs one update and resolves to its exit code.
 * - `readState()` resolves to the durable state, or `null` when there is none.
 * - `now()` returns milliseconds; `write(line)` prints one line.
 * - `summary(text)` appends to the run's summary page; it must not throw.
 * - `afterSetup` adds the completion block to a successful end.
 *
 * Resolves to the process exit code.
 */
export async function runWalk({
  runHop,
  readState,
  now,
  write,
  summary = () => {},
  afterSetup = false,
  env = {},
  maxHops = MAX_HOPS,
  budgetMs = BUDGET_MS,
}) {
  const read = async () => installedFromState(await readState());
  const started = now();
  let walked = 0;
  let before;
  try {
    before = await read();
  } catch (error) {
    write(`Could not read the deployment state: ${error.message}`);
    return 1;
  }
  // Bounded by `maxHops`: every pass either returns or increments `walked`.
  for (;;) {
    if (walked >= maxHops || now() - started >= budgetMs) {
      write(`Walked ${walked} releases in this run; run \`update\` again to continue.`);
      return 1;
    }
    const code = await runHop(childEnvironment(env));
    let after;
    try {
      after = await read();
    } catch (error) {
      write(`Could not read the deployment state: ${error.message}`);
      return 1;
    }
    if (code !== 0) {
      const where =
        after.sequence === 0
          ? 'No release is installed yet.'
          : `The deployment is on ${describe(after)}.`;
      write(`${where} The output above says why this run stopped.`);
      return Number.isInteger(code) && code > 0 && code < 256 ? code : 1;
    }
    if (after.sequence === before.sequence) {
      const pin = env.KINJOT_RELEASE_PIN;
      if (pin) write(`Stopped at the pinned release ${pin}.`);
      else if (after.sequence === 0) write('The deployment has no installed release.');
      else write(`Deployment is current at ${after.version} (sequence ${after.sequence}).`);
      if (afterSetup && after.sequence > 0) {
        const block = completionBlock(after, env);
        write('');
        for (const line of block) write(line);
        try {
          summary(`${block.join('\n')}\n`);
        } catch {
          // The block is already printed; the summary page is a copy of it.
        }
      }
      return 0;
    }
    if (after.sequence < before.sequence) {
      write(
        `The installed release went backwards, from ${describe(before)} to ${describe(after)}. Stopping.`,
      );
      return 1;
    }
    walked += 1;
    before = after;
  }
}

/** One `customer-cli.mjs update`, with inherited stdio and a hard deadline. */
export function spawnUpdate(
  env,
  {
    args = [CUSTOMER_CLI, 'update'],
    timeoutMs = HOP_TIMEOUT_MS,
    graceMs = KILL_GRACE_MS,
    stdio = 'inherit',
  } = {},
) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { stdio, env });
    let settled = false;
    let grace = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (grace) clearTimeout(grace);
      resolvePromise(code);
    };
    const deadline = setTimeout(() => {
      process.stderr.write(
        `The update did not finish within ${Math.ceil(timeoutMs / 60000)} minutes.\n`,
      );
      child.kill('SIGTERM');
      grace = setTimeout(() => {
        child.kill('SIGKILL');
        // A child that ignores even SIGKILL still cannot hold the walk open.
        setTimeout(() => finish(1), graceMs).unref();
      }, graceMs);
    }, timeoutMs);
    child.on('error', (error) => {
      process.stderr.write(`Could not start the update: ${error.message}\n`);
      finish(1);
    });
    child.on('exit', (code) => finish(code ?? 1));
  });
}

/**
 * Exactly the directory the bootstrap uses (`customer-cli.mjs` `main`: the
 * workspace, then `.kinjot/deployment`), and deliberately NOT
 * `KINJOT_UPDATER_STATE`: the bootstrap ignores that variable, so honouring
 * it here could read a different state than the hops write and misreport a
 * deployment as current.
 */
export function stateDirectory(env = process.env) {
  return join(resolve(env.GITHUB_WORKSPACE || process.cwd()), '.kinjot', 'deployment');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const directory = stateDirectory();
  runWalk({
    runHop: (env) => spawnUpdate(env),
    readState: () => readHandoffStateFile(directory),
    now: () => Date.now(),
    write: (line) => process.stdout.write(`${line}\n`),
    summary: (text) => appendStepSummary(text),
    afterSetup: process.argv.slice(2).includes('--after-setup'),
    env: process.env,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`The release walk failed: ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
