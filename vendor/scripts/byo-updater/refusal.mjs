const REFUSAL_DEFINITIONS = Object.freeze({
  mode_mismatch: Object.freeze({
    error: 'updater mode differs from durable deployment state',
    operator:
      'This mode change is not permitted. Keep full mode after web publication, and recover any incomplete update in its recorded mode.',
  }),
  release_replay: Object.freeze({
    error: 'release sequence is a replay or downgrade; explicit rollback is not implemented',
    operator:
      'The selected release is already installed or older. Select a newer release; rollback is not supported.',
  }),
  incomplete_recovery_target: Object.freeze({
    error:
      'an incomplete update remains the recovery target; resolve it before selecting another release',
    operator:
      'An incomplete update must be recovered with its original release. Retry that exact release before selecting another.',
  }),
  minimum_previous_release: Object.freeze({
    error: 'installed release does not satisfy the minimum previous release',
    operator:
      'The selected release requires a different previous release. Install the required release in sequence before retrying.',
  }),
  initial_backend_not_empty: Object.freeze({
    error: 'initial deployment requires a verified empty backend',
    operator:
      'This Supabase project is not empty: its public schema already has tables, and a first installation goes only into a new, empty project. Nothing was installed. Point KINJOT_DATABASE_URL and KINJOT_SUPABASE_PROJECT_REF at a new Supabase project, then run {command} again. If this project already runs Kinjot from a repository you no longer have, see "Lost your deployment repository?" in this repository\'s README.',
  }),
  database_history_unavailable: Object.freeze({
    error: 'database migration history is unavailable',
    operator:
      "Kinjot could not read your database's migration history. This run did not change your database. Check that KINJOT_DATABASE_URL reaches the database, then run {command} again.",
  }),
  database_history_unavailable_mid_install: Object.freeze({
    error: 'database migration history became unreadable during the install',
    operator:
      "Kinjot could not read your database's migration history partway through installing a release, so migrations may already have been applied. Check that KINJOT_DATABASE_URL reaches the database, then run update: it repeats the unfinished install.",
  }),
  database_history_mismatch: Object.freeze({
    error: 'database migration history does not match this release',
    operator:
      'Database migration history does not match this release. Inspect the actual history and signed release, then run the repair-guide operation before any repair.',
  }),
  database_epoch_unavailable: Object.freeze({
    error: 'database compatibility epoch is unavailable',
    operator:
      "Kinjot could not read your database's schema version before this update. Check that KINJOT_DATABASE_URL reaches the database and that its migration history is intact, then run {command} again.",
  }),
  database_epoch_mismatch: Object.freeze({
    error: 'release bundle does not support the database compatibility epoch',
    operator:
      "This release can't be installed directly on your database's current version. Run update without KINJOT_RELEASE_PIN, so the workflow installs the releases in between.",
  }),
  supabase_management_access: Object.freeze({
    error: 'Supabase Management API access preflight failed',
    operator:
      'Supabase Management API access to the configured project is required. Verify the project reference and management access token.',
  }),
  pages_project_prerequisite: Object.freeze({
    error: 'Cloudflare Pages project prerequisite preflight failed',
    operator:
      'The Cloudflare Pages project must already exist and match the configured production branch. Verify the account, token, project, and branch before retrying.',
  }),
  widening_requires_release: Object.freeze({
    error:
      'full mode requires a newer authenticated release; current backend release has no web publication',
    operator:
      'Full mode requires a newer authenticated release; the current backend release has no web publication.',
  }),
  license_key_missing: Object.freeze({
    // Command-neutral, because this string is the one that reaches Actions
    // logs, `withIncompleteUpdate` reports and any `console.error(err)` — and
    // `UpdaterRefusal` is constructed from a reason alone, with no command to
    // key on. Naming `setup` here contradicted the operator line whenever the
    // operator had run something else.
    error: 'license key is missing',
    operator:
      'This operation needs the KINJOT_LICENSE_KEY repository secret. Add it under Settings → Secrets and variables → Actions, then run {command} again.',
  }),
  license_key_invalid: Object.freeze({
    error: 'license key is malformed',
    operator:
      'KINJOT_LICENSE_KEY is malformed. Copy the complete license key from your purchase receipt, then run {command} again.',
  }),
  database_url_missing: Object.freeze({
    error: 'database url missing',
    operator:
      "This operation needs the KINJOT_DATABASE_URL repository secret. Copy the connection URL from your Supabase project's Connect dialog, then run {command} again.",
  }),
  management_token_missing: Object.freeze({
    error: 'management token missing',
    operator:
      'This operation needs the SUPABASE_ACCESS_TOKEN repository secret. Create a Supabase Management API token, add it under Settings → Secrets and variables → Actions, then run {command} again.',
  }),
  project_ref_missing: Object.freeze({
    error: 'project ref missing',
    operator:
      "Kinjot could not tell which Supabase project to use: KINJOT_DATABASE_URL does not name one, and the KINJOT_SUPABASE_PROJECT_REF repository variable is not set. Copy the connection URL from your Supabase project's Connect dialog into KINJOT_DATABASE_URL, then run {command} again.",
  }),
  project_ref_invalid: Object.freeze({
    error: 'project ref invalid',
    operator:
      "KINJOT_SUPABASE_PROJECT_REF is not a valid Supabase project reference. Copy it from your project's URL or its Connect dialog.",
  }),
  database_url_invalid: Object.freeze({
    error: 'database url invalid',
    operator:
      "KINJOT_DATABASE_URL is not a valid Supabase Postgres connection URL. Copy it from your project's Connect dialog. If your database password contains @, #, /, ? or :, percent-encode those characters in the URL, or reset the password to letters and digits under Project Settings → Database.",
  }),
  database_url_host_mismatch: Object.freeze({
    error: 'database url host mismatch',
    operator:
      'The hostname in KINJOT_DATABASE_URL does not match KINJOT_SUPABASE_PROJECT_REF. Copy the connection URL for that project.',
  }),
  database_url_direct_username_invalid: Object.freeze({
    error: 'database url direct username invalid',
    operator: 'KINJOT_DATABASE_URL must use the username postgres with a direct connection.',
  }),
  database_url_pooler_username_invalid: Object.freeze({
    error: 'database url pooler username invalid',
    operator:
      'KINJOT_DATABASE_URL must use the username postgres.<KINJOT_SUPABASE_PROJECT_REF> with a pooler connection.',
  }),
  database_direct_host_unreachable: Object.freeze({
    error: 'direct database host is unreachable and no pooler endpoint resolved',
    operator:
      "The direct database host db.<KINJOT_SUPABASE_PROJECT_REF>.supabase.co could not be reached, and this project's session pooler could not be resolved to retry. Supabase publishes the direct host over IPv6 only, and many CI runners are IPv4-only. Copy the session pooler URL on port 5432 from your project's Connect dialog into KINJOT_DATABASE_URL, then run this workflow again.",
  }),
  database_unreachable: Object.freeze({
    error: 'neither the direct database host nor the resolved session pooler answered',
    operator:
      "Neither the direct database host nor this project's session pooler answered. This run did not change your database. Check in the Supabase Dashboard that the project is running, then run {command} again.",
  }),
  database_password_rejected: Object.freeze({
    error: 'the database rejected the password in the database url',
    operator:
      'Supabase rejected the database password in KINJOT_DATABASE_URL. This run did not change your database. Put your current database password in KINJOT_DATABASE_URL, or reset it under Project Settings → Database and put the new one in the URL, then run {command} again.',
  }),
  database_password_placeholder: Object.freeze({
    error: 'the database url still holds the password placeholder',
    operator:
      "KINJOT_DATABASE_URL still holds the Connect dialog's [YOUR-PASSWORD] placeholder. This run did not change your database. Replace it with your database password (reset it under Project Settings → Database if you don't have it), then run {command} again.",
  }),
  supabase_project_not_active: Object.freeze({
    error: 'the Supabase project is not active and healthy',
    operator:
      'Your Supabase project is paused or not ready, so its database did not answer. This run did not change your database. Restore it in the Supabase Dashboard, wait until it is running, then run {command} again.',
  }),
  supabase_token_rejected: Object.freeze({
    error: 'the Supabase Management API refused the access token',
    operator:
      'Supabase refused SUPABASE_ACCESS_TOKEN: it is wrong, expired or revoked, or its account cannot manage this project. This run did not change your database. Create a new token under Account → Access Tokens in the Supabase Dashboard, put it in the SUPABASE_ACCESS_TOKEN secret, then run {command} again.',
  }),
  supabase_project_not_found: Object.freeze({
    error: 'the Supabase Management API has no such project',
    operator:
      "Supabase has no project with this project reference that SUPABASE_ACCESS_TOKEN can see. This run did not change your database. Copy KINJOT_DATABASE_URL from that project's Connect dialog (and correct or delete the KINJOT_SUPABASE_PROJECT_REF variable if you set one), make sure the token's account owns the project, then run {command} again.",
  }),
  supabase_busy: Object.freeze({
    error: 'the Supabase Management API is rate limiting or failing',
    operator:
      'Supabase is busy (it rate-limited or failed a request). This run did not change your database. Run {command} again later.',
  }),
  cloudflare_token_missing: Object.freeze({
    error: 'cloudflare token missing',
    operator:
      'Full mode needs the CLOUDFLARE_API_TOKEN repository secret, with Pages edit access in the configured account. Add it, then run {command} again.',
  }),
  cloudflare_account_missing: Object.freeze({
    error: 'cloudflare account missing',
    operator:
      'Full mode needs the CLOUDFLARE_ACCOUNT_ID repository secret, as the 32-character account id from your Cloudflare dashboard. Add it, then run {command} again.',
  }),
  cloudflare_account_invalid: Object.freeze({
    error: 'cloudflare account invalid',
    operator:
      'CLOUDFLARE_ACCOUNT_ID is not a valid Cloudflare account id. Copy the 32-character lowercase hexadecimal id from your Cloudflare dashboard.',
  }),
  pages_project_missing: Object.freeze({
    error: 'pages project missing',
    operator:
      'Full mode needs the KINJOT_PAGES_PROJECT repository variable, naming a Direct Upload Pages project that already exists. Add it, then run {command} again.',
  }),
  pages_branch_invalid: Object.freeze({
    error: 'pages branch invalid',
    operator:
      'KINJOT_PAGES_BRANCH is not a valid branch name for a Pages deployment. Use a name of lowercase letters, digits and hyphens, with no slashes.',
  }),
  deployment_mode_invalid: Object.freeze({
    error: 'KINJOT_DEPLOYMENT_MODE must be full or backend-only',
    operator: 'KINJOT_DEPLOYMENT_MODE must be full or backend-only.',
  }),
  enrollment_disabled: Object.freeze({
    error: 'enrollment disabled',
    operator:
      'Kinjot has paused installs and updates for this template. Nothing on your project changed. Check https://kinjot.com/self-host/setup or email hello@kinjot.com.',
  }),
  configuration_branch_missing: Object.freeze({
    error: 'configuration branch is required',
    operator: 'Run this workflow from a branch in your repository.',
  }),
  repository_inspection_failed: Object.freeze({
    error: 'unable to inspect the repository checkout',
    operator:
      'The repository checkout could not be inspected with Git. Check that the workflow checks out the repository with its history, and that Git is available on the runner.',
  }),
  deployment_not_linked: Object.freeze({
    error: 'deployment is not linked',
    operator: 'This deployment is not linked to a license. Run link, then run {command} again.',
  }),
  deployment_nothing_to_unlink: Object.freeze({
    error: 'deployment has no license lifecycle to unlink',
    operator: 'This deployment is not linked to a license, so there is nothing to unlink.',
  }),
  deployment_already_linked: Object.freeze({
    error: 'deployment is already linked',
    operator:
      'This deployment is already linked. Run Unlink first if you are moving it to a different license.',
  }),
  relink_requires_unlink: Object.freeze({
    error: 'deployment unlinking must be completed before relinking',
    operator: 'Unlinking must finish before this deployment can be linked again. Retry Unlink.',
  }),
  channel_mismatch: Object.freeze({
    error: 'durable lifecycle intent does not match the configured release channel',
    operator: "The linked license does not match this repository's release channel.",
  }),
  recovery_target_mismatch: Object.freeze({
    error: 'the configured pin differs from the incomplete recovery target',
    operator:
      'An incomplete update must be recovered with its original release. Clear KINJOT_RELEASE_PIN or set it to that release.',
  }),
  recovery_release_unavailable: Object.freeze({
    error: 'release service cannot satisfy the incomplete recovery target',
    operator:
      'The release service cannot supply the release this incomplete update must be recovered with. Try again later.',
  }),
  adoption_requires_unresolved_link: Object.freeze({
    error: 'adoption requires an unresolved durable linking intent',
    operator:
      'license_instance_id is only for finishing an interrupted link, and this deployment has none. Leave it empty and run link.',
  }),
  adoption_after_activation: Object.freeze({
    error: 'adoption is not valid after activation was confirmed',
    operator:
      "This deployment's activation is already confirmed, so license_instance_id is not needed. Leave it empty and run link.",
  }),
  installed_updater_incomplete: Object.freeze({
    error: 'authenticated installed updater did not complete',
    operator:
      'The installed updater exited before finishing. Run doctor from the Kinjot deployment workflow to see how far the install got, then run setup again.',
  }),
  installation_unverified: Object.freeze({
    error: 'durable installation completion could not be verified',
    operator:
      'The installation could not be confirmed as complete. Run doctor from the Kinjot deployment workflow, then run setup again.',
  }),
  bootstrap_manifest_schema: Object.freeze({
    // The frozen bootstrap's one loud refusal about the manifest document
    // itself, and the only escape it has. `MANIFEST_SCHEMA_VERSION` is
    // the documented hatch for a meaning-changing manifest revision, and an
    // enrolled operator's frozen copy cannot be taught a tolerated range later,
    // so the one honest outcome is to stop and say which side is behind.
    error: 'installed release manifest uses a schema this bootstrap cannot read',
    operator:
      "The installed release's manifest is a newer schema than this repository's bootstrap can read. Re-create the deployment repository from the current template, carry over .kinjot/deployment and your secrets, then run update again.",
  }),
  core_diagnostics_failed: Object.freeze({
    error: 'core installation diagnostics did not pass; see the report above',
    operator:
      'Core installation checks did not pass. See the diagnostic report printed above for the failing checks.',
  }),
  license_key_not_recognised: Object.freeze({
    error: 'license provider does not recognise the license key',
    operator:
      'Lemon Squeezy does not recognise KINJOT_LICENSE_KEY as a Kinjot Self-host license, or the license was refunded or disabled. Nothing was activated. Copy the complete key from your purchase receipt into the secret, then run {command} again; if the key is right, email hello@kinjot.com.',
  }),
  license_already_activated: Object.freeze({
    error: 'license is already activated on another deployment',
    operator:
      "KINJOT_LICENSE_KEY is already activated on another deployment, and a license allows one. Nothing was activated. Run unlink from the deployment that holds it, or deactivate that activation in Lemon Squeezy's My Orders (https://app.lemonsqueezy.com/my-orders), then run {command} again.",
  }),
  license_service_unavailable: Object.freeze({
    error: 'license provider did not give a usable answer',
    operator:
      'The license service (Lemon Squeezy) did not answer usably. Nothing was activated. Run {command} again; if it keeps failing, email hello@kinjot.com.',
  }),
  license_key_mismatch: Object.freeze({
    error: 'license key does not own the durable lifecycle intent',
    operator:
      'KINJOT_LICENSE_KEY is not the license this deployment is linked with, or began linking with. Put the original key back in the secret, then run {command} again. To move this deployment to another license, run unlink with the original key first, then link with the new one.',
  }),
  configuration_push_rejected: Object.freeze({
    error: 'the configuration branch refused the checkpoint push',
    operator:
      "The workflow could not save its progress record to this repository's branch: GitHub refused or did not finish the push (a branch protection rule, a token without write access, or a GitHub outage). Let the workflow's token push to this branch, then run {command} again.",
  }),
  configuration_branch_moved: Object.freeze({
    error: 'the configuration branch changed during the run',
    operator:
      "This repository's branch changed while the workflow was running (a push or another run). Nothing more was recorded. Run {command} again.",
  }),
  release_license_refused: Object.freeze({
    error: 'release service refused the license',
    operator:
      "The Kinjot release service refused this deployment's license: the key is wrong, refunded or deactivated, or this deployment's activation was freed in Lemon Squeezy's My Orders. Nothing was installed. Check KINJOT_LICENSE_KEY against your receipt; if you freed the activation, run unlink and then link. Then run {command} again.",
  }),
  release_path_refused: Object.freeze({
    error: 'release service has no release for the installed release',
    operator:
      'The Kinjot release service has no release that installs over this deployment, or KINJOT_RELEASE_PIN names one that cannot. Nothing was installed. Clear KINJOT_RELEASE_PIN or set it to a newer release, then run {command} again; with no pin set, email hello@kinjot.com.',
  }),
  release_service_unavailable: Object.freeze({
    error: 'release service is unavailable',
    operator:
      'The Kinjot release service is unavailable: delivery is paused, or it could not check the license. Nothing was installed. Run {command} again later.',
  }),
});

export const UPDATER_REFUSAL_REASONS = Object.freeze(Object.keys(REFUSAL_DEFINITIONS));

function recognizedReason(value) {
  return typeof value === 'string' && Object.hasOwn(REFUSAL_DEFINITIONS, value) ? value : null;
}

export function normalizeUpdaterRefusalReason(value) {
  try {
    const direct = recognizedReason(value);
    if (direct) return direct;
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
    const reason = recognizedReason(value.reason);
    if (reason) return reason;
    return value.code === 'release_replay_refused' ? 'release_replay' : null;
  } catch {
    return null;
  }
}

export class UpdaterRefusal extends Error {
  constructor(reason) {
    const normalized = normalizeUpdaterRefusalReason(reason);
    if (!normalized) throw new TypeError('unknown updater refusal reason');
    super(REFUSAL_DEFINITIONS[normalized].error);
    this.name = 'UpdaterRefusal';
    this.code = 'updater_refused';
    this.reason = normalized;
  }
}

// The operations an operator line may name back. Anything else (an unknown
// argv, or a caller with no command) reads as "this operation".
const RERUN_COMMANDS = new Set([
  'setup',
  'update',
  'link',
  'unlink',
  'backfill',
  'doctor',
  'migration-repair',
]);

export function updaterRefusalMessage(value, command) {
  const reason = normalizeUpdaterRefusalReason(value);
  if (!reason) return null;
  const rerun = RERUN_COMMANDS.has(command) ? command : 'this operation';
  return REFUSAL_DEFINITIONS[reason].operator.replaceAll('{command}', rerun);
}
