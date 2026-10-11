# Kinjot self-host deployment template

Use Kinjot with your own Supabase project and the included `byo.kinjot.com`
web app, or host the web app on your own Cloudflare Pages project.

> **Not yet on sale.** Setup, Link and Update work with a valid license key,
> but the self-host purchase has not opened, so keys are not generally
> available yet.

## Setup at a glance

1. **Create a Supabase project.** Start without AI keys or a Cloudflare account.
   [Project setup](#project-setup)
2. **Create a private repository** using this template and add the required
   GitHub secrets and variables. Deployment diagnostics remain in its Actions
   logs; a private repository limits who can read them.
   [Repository configuration](#repository-configuration)
3. **Configure Supabase Auth** URLs and signup settings.
   [Authentication](#authentication)
4. **Set up Kinjot:** open **Actions → Kinjot deployment → Run workflow**,
   select `setup`, and wait for it to finish. Setup links your license when
   needed, installs the backend, runs core diagnostics, and then updates to
   the newest release.
5. **Create your confirmed account in Supabase Auth, then open the app.**
   On `byo.kinjot.com`, enter your receipt's license key at
   the host's access page first. Then enter your Supabase project URL and public
   connection key, sign in and save a note. Open a second browser session to
   check sync. Never put your license or deployment secrets in a URL.

OpenAI and Voyage credentials are optional. Add them later using
[Enable AI](#optional-enable-ai).

Run `update` again for later releases. If a run fails, follow
[the recovery guidance](#recovering-a-failed-run).

Setup and `update` are each **one** workflow run. The workflow installs one
release at a time until the deployment is on the newest release (or on
`KINJOT_RELEASE_PIN`), then stops. A run stops early at an error, after ten
releases, or once 20 minutes have passed (a release already started still
finishes); the last lines of its output say where it stopped. A run that
stops at the ten-release or 20-minute limit is marked failed on purpose,
even though every release it installed succeeded, so it is not mistaken
for a finished run: run `update` again to continue. Stepping through
releases is the workflow's job: a local `pnpm update`, and the
`backend-only` operation, move one release.

## Setup details

### Project setup

Choose your deployment mode:

- **`backend-only`** (new-install default): use `byo.kinjot.com` with your own
  Supabase backend. No Cloudflare credentials needed.
- **`full`**: web app on your Cloudflare Pages project, backend on Supabase.

Existing installations retain their recorded deployment mode when no mode is
specified. Keep an existing explicit mode setting for subsequent updates.

For `full`, create a **Direct Upload Cloudflare Pages project** before installing:

- Use the account in `CLOUDFLARE_ACCOUNT_ID`.
- Match its name to `KINJOT_PAGES_PROJECT` and production branch to
  `KINJOT_PAGES_BRANCH` (default: `main`).
- Give your Cloudflare token Pages edit access in that account.

An empty Pages project is enough. The updater checks it but does not create it.

### Repository configuration

Open **Settings → Secrets and variables → Actions** in your repository.

**Secrets**

| Name                    | Value                            | Required for |
| ----------------------- | -------------------------------- | ------------ |
| `KINJOT_LICENSE_KEY`    | Your license key                 | Both modes   |
| `KINJOT_DATABASE_URL`   | Supabase Postgres connection URL | Both modes   |
| `SUPABASE_ACCESS_TOKEN` | Supabase Management API token    | Both modes   |
| `CLOUDFLARE_API_TOKEN`  | Token with Pages edit access     | `full`       |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID            | `full`       |

**Variables**

| Name                          | Value                                                                      |
| ----------------------------- | -------------------------------------------------------------------------- |
| `KINJOT_SUPABASE_PROJECT_REF` | Your Supabase project ref                                                  |
| `KINJOT_DEPLOYMENT_MODE`      | Optional: `full` or `backend-only`; new installs default to `backend-only` |
| `KINJOT_PAGES_PROJECT`        | Existing Pages project name; `full` only                                   |
| `KINJOT_PAGES_BRANCH`         | Pages production branch; defaults to `main`                                |

The database URL is used for migrations. `SUPABASE_ACCESS_TOKEN` deploys
functions and has **account-wide access**. Both must target your intended
project. Kinjot never receives these credentials.

Either connection URL from the **Connect** dialog works. Supabase publishes the
direct host `db.<ref>.supabase.co` over IPv6 only, and GitHub-hosted runners are
IPv4-only, so if the direct host cannot be reached the workflow reads your
project's session pooler hostname from the Management API and retries there on
port 5432. It never guesses that hostname. If neither endpoint answers, the run
says so and names the session pooler.

### Authentication

In **Supabase Dashboard → Authentication → URL Configuration**, set:

- **Site URL:** `https://byo.kinjot.com` for the included web app.
- **Redirect URL:** `https://byo.kinjot.com/app`.

For own hosting, use your Pages origin and that origin plus `/app` instead.

The updater does not change Auth settings. `KINJOT_SITE_URL` and
`KINJOT_AUTH_CALLBACK_URL` are no longer required and do not configure Supabase.

For the default setup:

- Keep signups closed, email confirmations off, and SMTP unconfigured.
- Create your account in the Dashboard with a password and confirmed email.
- Configure GitHub login separately if wanted.

Password recovery is managed in your own project. Email-based recovery requires SMTP.

### Optional: enable AI

You can take notes, search their text and sync without provider credentials.
When you want AI features, add these secrets in your **Supabase Dashboard →
Edge Functions → Secrets**:

- `OPENAI_API_KEY`: answers, note summaries and Tidy planning.
- `VOYAGE_API_KEY`: embeddings for semantic retrieval.

Both are needed for the current note-indexing pipeline. The providers bill your
accounts. Keep these keys in Supabase; do not duplicate them in GitHub or enter
them in the app. The browser's session-only Recall key is a separate feature.

Missing AI configuration does not invalidate a working notes installation.
Presence of a key is not proof that it is valid or that its provider is healthy.
Saved Recall history remains available to browse.

Open **Settings → Account → Enable AI** in Kinjot and use **Recheck** after
adding keys. This reads configuration status from your authenticated backend;
it never returns key values. When both keys are present, pending AI work can
resume. If a configured provider rejects requests or is unavailable, check its
account and your Edge Function logs.

Supabase's [secret management guide](https://supabase.com/docs/guides/functions/secrets)
links directly to the Dashboard's **Functions → Secrets** page and confirms
that changing secrets does not require redeploying functions.

## Updates and maintenance

- Run `update` to install newer releases. One run installs each newer
  release in turn and stops when current. Each update also runs embedding
  backfill, even when up to date or pinned. You can run `backfill` separately.
- Keep backups; they are recommended, not a deployment requirement.
- If an update fails, retry the **same release and mode** after fixing the cause.
  Do not reset the backend, edit `.kinjot`, or switch releases to bypass recovery.
- Migration drift stops updates. Use [the recovery guidance](#recovering-a-failed-run);
  updates never rewrite migration history.
- The shared app at `byo.kinjot.com` is built for the newest release and is
  tested against the release before it. Two or more releases behind is outside
  that window: the app may report that your database is behind and stop syncing
  until you run `update`; notes already on the device stay there. Run `update`
  after each release to stay inside the window.

### Adding Pages to a backend-only installation

1. Resolve any incomplete update in its recorded mode.
2. Create the Pages project and add its credentials.
3. With the current template and a **newer release available**, set
   `KINJOT_DEPLOYMENT_MODE=full` and run `update`.

Keep that mode for future updates. Switching back to `backend-only` is unsupported,
as is adding Pages from the same already-installed release.

### Automatic updates — off by default

Updates run when you dispatch them. To update on a schedule instead, add a
trigger under `on` in `.github/workflows/kinjot-deployment.yml`:

```yaml
on:
  schedule:
    - cron: '17 4 * * 1' # Mondays, 04:17 UTC
  workflow_dispatch:
```

The workflow already handles the rest: a scheduled event carries no operation
input, so it selects `update` explicitly and skips the dispatch-only `doctor`
step. Nothing else needs changing. A scheduled run installs at most one release;
only a run you dispatch steps through several.

Before you turn it on, know what an unattended `update` does. It applies
migrations and deploys functions against your Supabase project using your
account-wide management token, and it runs embedding backfill, which bills your
provider accounts. Run at least one update by hand first and read its output.

Two scheduling limits are GitHub's, not ours. Scheduled runs always use your
**default branch**, so a configuration branch that is not the default will fail
every week. GitHub also suspends scheduled workflows after **60 days** without
repository activity, and a repository only the cron touches is exactly that
case — check occasionally that it is still running.

Setting the `KINJOT_DEPLOYMENT_MODE` variable overrides your recorded mode, so
leave it unset once installed unless you intend every future run, scheduled
ones included, to use that mode.

## Doctor and recovery

`doctor` checks migrations, schema compatibility, the self-host marker, backfill,
functions, and providers. **It diagnoses problems; it does not repair them.**

Setup uses the core diagnostic result: schema and function deployment checks
must pass, while optional AI diagnostics do not block installation. Image
attachments are not part of that core check, so they never block setup: setup
runs it right after installing the first release in the chain, before it
walks on to the newest, and that first release predates the attachments'
storage bucket and usage function. A standalone `doctor` names them missing
until the deployment is on a release that includes them. This does
not prove your login, end-to-end sync, or provider health; finish the app steps
above. Standalone Doctor retains the detailed results for all requested checks.

Doctor needs authenticated release inventory from an install attempt. If inventory
is missing or cannot be authenticated, it makes no diagnostic provider requests.
It runs from the current template so fixes also apply to older installed releases.

The customer workflow needs only database and Supabase project credentials.
It does not receive provider keys. The normal AI setup path uses the **Enable
AI** section of Kinjot Settings to check configuration stored in Supabase.

The standalone Doctor CLI still supports **locally supplied probe
credentials** for explicit operator diagnostics. These do not read your
Supabase secrets. An absent local probe key does not mean your backend's key is
missing. Its optional Voyage probe can incur a small charge and requires
`--allow-billable-voyage`. No such probe is part of normal setup.

### Recovering a failed run

For a failed first install, check the database connection, Supabase Management
API access, and (for `full`) the Pages project and branch. Fix the reported cause
and rerun `update` for the same release. Doctor cannot check a pre-install
environment without authenticated inventory.

| Finding                                                        | Next step                                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Interrupted update                                             | Fix the cause; rerun `update` for the recorded release and mode. Preserve recovery state.                   |
| Pending migrations without an interrupted update               | Check release inventory and database history. Update cannot replay an installed release as a schema repair. |
| Remote-only migration history                                  | Check the project and release, then run `repair-guide`. See the repair limits below.                        |
| Notes eligible for backfill                                    | Run `backfill`. It queues eligible notes, including Trash, without resetting jobs.                          |
| Missing marker, incompatible schema version, or damaged schema | Investigate the release and database. Do not change migration history just to clear a diagnostic.           |
| Function or provider failure                                   | Restore the deployment, credential, or dependency; rerun Doctor.                                            |

**Repair limits:** `migration-repair` changes bookkeeping only, requires exact typed
confirmation, and cannot execute or undo SQL. Verify SQL effects independently.

**Reading the results:**

- A zero backfill gap does not prove queued jobs finished.
- ACTIVE function metadata does not prove invocation or provider configuration works.
- Schema checks do not verify SQL function bodies, RLS policies, or every index.
- Doctor cannot establish that your database URL and project ref belong together.
- Check individual results even when others are unavailable. Unconfigured optional
  providers prevent an all-healthy result.

### License linking and unlinking

Run `link` once. If activation is interrupted, **do not create another instance**:

1. Find the exact instance UUID at the license provider.
2. Rerun `link` with `license_instance_id`.
3. If that instance is already inactive, Link verifies zero active slots and
   records recovery. Run `link` separately afterward to activate again.

Link validates the key, product, store, and instance name before adopting an
instance. A 404 alone does not prove it is inactive. Without the instance UUID,
an ambiguous activation cannot be recovered automatically.

If saving an activation fails, Link attempts to deactivate that verified instance.
If this also fails, use the recovery steps above.

Run `unlink` to release the linked instance. It saves progress before deactivation;
retries validate ownership or zero active slots before completing. A different
license key is refused before any provider request.

**Lost your deployment repository?** The license allows one linked deployment,
and `unlink` needs the instance ID stored in this repository. The repository
also holds `.kinjot/deployment`, the record of what is installed in your
Supabase project, and no command can take over an installed project without
it. So the way back depends on what you have:

- **A copy of the old repository** (a clone, a fork, a backup): restore it,
  including `.kinjot/deployment`, and carry on with `update` as before.
- **No copy, and you want to keep your existing Supabase project and its
  notes:** email hello@kinjot.com with your order number. Do not run `setup`
  against that project from a new repository: it refuses a project that
  already holds Kinjot, after spending your license's activation.
- **No copy, starting over on a new, empty Supabase project:** free the old
  activation first — open Lemon Squeezy's
  [My Orders](https://app.lemonsqueezy.com/my-orders) page, open the order and
  its license, and deactivate the old activation if the page offers that, or
  email hello@kinjot.com with your order number — then run `setup` in a new
  repository created from this template.

## Technical details

- **Contents:** deployment tools and a public signature trust root. Application
  bundles are downloaded separately; this template contains no credentials or
  private application source.
- **Channel:** pins the production endpoint, licensed product, and trust root.
  Disabled enrollment makes Link and Update refuse before provider calls.
- **Recovery records:** the configuration branch stores progress. `.kinjot/instance.json`
  holds a SHA-256 key fingerprint, product ownership, and lifecycle state;
  the license key stays in GitHub Secrets.
- **Tooling:** Supabase CLI 2.118.0, pnpm 10.15.1, and Wrangler 4.145.0 are
  installed before credentials are exposed. The frozen install disables lifecycle
  scripts. Vendored updater, verifier, and Doctor code fetch no npm code.

## License

This template and its deployment tools use the [MIT License](LICENSE).
Downloaded Kinjot application bundles use their separate commercial license;
MIT does not cover the purchased app or private Kinjot source.
