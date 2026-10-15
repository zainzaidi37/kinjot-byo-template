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
      "Initial installation requires an empty Kinjot backend. Use the updater for the backend's installed release or a fresh Supabase project.",
  }),
  database_history_unavailable: Object.freeze({
    error: 'database migration history is unavailable',
    operator:
      'Database migration history must be readable before this update. Verify database access and retry.',
  }),
  database_history_mismatch: Object.freeze({
    error: 'database migration history does not match this release',
    operator:
      'Database migration history does not match this release. Inspect the actual history and signed release, then follow the manual migration guide before any repair.',
  }),
  database_epoch_unavailable: Object.freeze({
    error: 'database compatibility epoch is unavailable',
    operator:
      'The database compatibility epoch must be readable before this update. Verify database access and migration history before retrying.',
  }),
  database_epoch_mismatch: Object.freeze({
    error: 'release bundle does not support the database compatibility epoch',
    operator:
      'This release does not support the database compatibility epoch. Install the required intermediate release first.',
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
      'Setup needs the KINJOT_LICENSE_KEY repository secret. Add it under Settings → Secrets and variables → Actions, then run setup again.',
    operatorByCommand: Object.freeze({
      link: 'Link needs the KINJOT_LICENSE_KEY repository secret. Add it under Settings → Secrets and variables → Actions, then run link again.',
      unlink:
        'Unlink needs the KINJOT_LICENSE_KEY repository secret. Add it under Settings → Secrets and variables → Actions, then run unlink again.',
      update:
        'Update needs the KINJOT_LICENSE_KEY repository secret. Add it under Settings → Secrets and variables → Actions, then run update again.',
    }),
  }),
  license_key_invalid: Object.freeze({
    error: 'license key is malformed',
    operator:
      'KINJOT_LICENSE_KEY is malformed. Copy the complete license key from your purchase receipt and try again.',
  }),
  database_url_missing: Object.freeze({
    error: 'database url missing',
    operator:
      "Setup needs the KINJOT_DATABASE_URL repository secret. Copy the connection URL from your Supabase project's Connect dialog, then run setup again.",
  }),
  management_token_missing: Object.freeze({
    error: 'management token missing',
    operator:
      'Setup needs the SUPABASE_ACCESS_TOKEN repository secret. Create a Supabase Management API token, add it under Settings → Secrets and variables → Actions, then run setup again.',
  }),
  project_ref_missing: Object.freeze({
    error: 'project ref missing',
    operator:
      'Setup needs the KINJOT_SUPABASE_PROJECT_REF repository variable. Add your Supabase project reference, then run setup again.',
  }),
  project_ref_invalid: Object.freeze({
    error: 'project ref invalid',
    operator:
      "KINJOT_SUPABASE_PROJECT_REF is not a valid Supabase project reference. Copy it from your project's URL or its Connect dialog.",
  }),
  database_url_invalid: Object.freeze({
    error: 'database url invalid',
    operator:
      "KINJOT_DATABASE_URL is not a valid Supabase Postgres connection URL. Copy it from your project's Connect dialog.",
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
  cloudflare_token_missing: Object.freeze({
    error: 'cloudflare token missing',
    operator:
      'Full mode needs the CLOUDFLARE_API_TOKEN repository secret, with Pages edit access in the configured account.',
  }),
  cloudflare_account_missing: Object.freeze({
    error: 'cloudflare account missing',
    operator:
      'Full mode needs the CLOUDFLARE_ACCOUNT_ID repository secret, as the 32-character account id from your Cloudflare dashboard.',
  }),
  cloudflare_account_invalid: Object.freeze({
    error: 'cloudflare account invalid',
    operator:
      'CLOUDFLARE_ACCOUNT_ID is not a valid Cloudflare account id. Copy the 32-character lowercase hexadecimal id from your Cloudflare dashboard.',
  }),
  pages_project_missing: Object.freeze({
    error: 'pages project missing',
    operator:
      'Full mode needs the KINJOT_PAGES_PROJECT repository variable, naming a Direct Upload Pages project that already exists.',
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
      "This repository's release channel is closed. It is not open for new installations, and an existing deployment on it cannot be updated, linked or unlinked until it reopens.",
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
    operator: 'This deployment is not linked to a license. Run Setup first, which links it.',
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
      'Instance adoption only applies to an unresolved link. There is no unresolved linking intent to adopt.',
  }),
  adoption_after_activation: Object.freeze({
    error: 'adoption is not valid after activation was confirmed',
    operator: 'Instance adoption is not valid once activation was confirmed.',
  }),
  installed_updater_incomplete: Object.freeze({
    error: 'authenticated installed updater did not complete',
    operator:
      'The installed updater exited before finishing. Run the Doctor workflow to see how far the install got, then run setup again.',
  }),
  installation_unverified: Object.freeze({
    error: 'durable installation completion could not be verified',
    operator:
      'The installation could not be confirmed as complete. Run the Doctor workflow, then run setup again.',
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

export function updaterRefusalMessage(value, command) {
  const reason = normalizeUpdaterRefusalReason(value);
  if (!reason) return null;
  const definition = REFUSAL_DEFINITIONS[reason];
  return definition.operatorByCommand && Object.hasOwn(definition.operatorByCommand, command)
    ? definition.operatorByCommand[command]
    : definition.operator;
}
