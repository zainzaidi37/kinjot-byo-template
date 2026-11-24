# Kinjot self-host deployment template

This repository holds the tools that install and update Kinjot on your own
Supabase project, plus the public key that checks every release's signature.
The app itself is downloaded and signature-checked at install time. You use it
through the included `byo.kinjot.com` web app, or publish it to your own
Cloudflare Pages project.

> **Not yet on sale.** Setup, Link and Update work with a valid license key,
> but the self-host purchase has not opened, so keys are not generally
> available yet.

## Before you start

You need:

- your license key, from your Lemon Squeezy receipt;
- a Supabase account. Only projects on Supabase's hosted platform work;
  self-hosted Supabase servers are not supported;
- a GitHub account.

Setup takes about 20 minutes. You do not need AI keys or a Cloudflare account
to start: notes, text search and sync work without them, and AI can be added
later ([step 7](#7-optional-enable-ai)).

## 1. Create the repository

On this template's GitHub page, choose **Use this template → Create a new
repository**, and make it **Private**. Deployment diagnostics stay in its
Actions logs, and a private repository limits who can read them.

## 2. Create the Supabase project

Create a new, empty project in the Supabase Dashboard and save its database
password: the next step needs it. Setup installs only into a project with no
tables of its own yet.

## 3. Add the secrets

In your repository, open **Settings → Secrets and variables → Actions** and
add three repository secrets:

| Secret                  | Value                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| `KINJOT_LICENSE_KEY`    | Your license key, copied whole from your receipt.                        |
| `KINJOT_DATABASE_URL`   | Your project's database connection URL (below).                          |
| `SUPABASE_ACCESS_TOKEN` | A Supabase access token, from **Account → Access Tokens** in Supabase.   |

**The database URL.** Open your project's **Connect** dialog and copy a
connection URI. Replace `[YOUR-PASSWORD]` with your database password (reset
it under **Project Settings → Database** if you don't have it). If the
password contains any of `@ # / ? : %`, percent-encode those characters in
the URL (`@` is `%40`, `#` is `%23`, `/` is `%2F`, `?` is `%3F`, `:` is `%3A`,
`%` is `%25`), or reset the password to letters and digits.

Either the direct URL or the session pooler URL works. Supabase publishes the
direct host `db.<ref>.supabase.co` over IPv6 only, and GitHub-hosted runners
are IPv4-only, so when the direct host cannot be reached the workflow reads
your project's session pooler hostname from the Supabase Management API and
retries there on port 5432. It never guesses that hostname. A transaction
pooler URL (port 6543) is moved to the session pooler's port 5432 on the same
host. If neither endpoint answers, the run says so.

The workflow uses the database URL for migrations, and the access token to
deploy app functions. The access token has **account-wide access** to every
Supabase project your account can reach, so keep it only in this secret. Both
must belong to the project you intend. Kinjot never receives these
credentials.

The workflow reads your project reference from the database URL. You need no
variables for a standard setup; the optional ones are under
[Repository variables](#repository-variables).

## 4. Run setup

Open **Actions → Kinjot deployment → Run workflow**, choose `setup`, and run
it. Setup checks the project is empty, links your license, installs the first
release, runs core checks, and then updates to the newest release, all in one
run.

On a new installation setup also turns off **Allow new users to sign up** in
your project's Auth settings if it is on, and says so in the log. If it could
not turn them off, or could not check, the log says that instead: then turn off
**Allow new users to sign up** yourself under **Authentication → Sign In /
Providers**. Sign-ups are the only Auth setting setup ever changes, and only on
the first install. You can turn sign-ups back on there, but then anyone who
reaches your project can create an account and use its AI keys.

When setup succeeds, the run ends with "Kinjot setup is complete", the
installed release, the app's address and the next steps (steps 5 to 7 below),
and the same text appears on the run's summary page. A run that fails or stops
at its limits prints no next steps: its last lines name the cause, and
[Recovering a failed run](#recovering-a-failed-run) says what to do.

## 5. Create your account

In the Supabase Dashboard, open **Authentication → Users → Add user → Create
new user**. Enter your email address and a password, and leave **Auto Confirm
User** ticked. The address is only your sign-in name; it never has to receive
mail, and you need no SMTP server.

Your account works with sign-ups closed, and you need no Auth URL settings. Set
the Site URL and redirect URLs only if you turn on GitHub or email sign-in:
under **Authentication → URL Configuration**, set the Site URL to
`https://byo.kinjot.com` and add `https://byo.kinjot.com/app` as a redirect
URL (in `full` mode, your Pages origin and that origin plus `/app`). Configure
the GitHub provider itself in your project if you want it. Email-based
password recovery needs SMTP; without it, use
[Can't sign in](#cant-sign-in).

## 6. Open the app

1. Open `https://byo.kinjot.com` and enter your license key at its access
   page. (Yes, a second time: the workflow's copy stays in GitHub.)
2. **Connect** with your project URL (in the project's **Connect** dialog) and
   publishable key (**Project Settings → API Keys**). The publishable key is
   public by design; never paste a secret or service-role key there.
3. Sign in with the account from step 5 and save a note.

To add another device, copy the link under **Settings → Agent connections →
Connect another device** and open it there. If that device asks for your
license key first, enter it and then open the link again: the license page
cannot pass the link on. Open a second browser session this way to check
sync. Never put your license key or deployment secrets in a URL.

## 7. Optional: enable AI

When you want AI features, add these secrets in your **Supabase Dashboard →
Edge Functions → Secrets**:

- `OPENAI_API_KEY`: answers, note summaries and Tidy planning.
- `VOYAGE_API_KEY`: embeddings for semantic retrieval.

Both are needed for the note-indexing pipeline. The providers bill your
accounts. Keep these keys in Supabase; do not duplicate them in GitHub or
enter them in the app. The browser's session-only Recall key is a separate
feature. Changing Edge Function secrets needs no redeploy (Supabase's
[secret management guide](https://supabase.com/docs/guides/functions/secrets)).

Then open **Settings → AI provider → Enable AI** in Kinjot and use
**Recheck**. It reads which keys are configured from your own backend and
never returns their values. When both keys are present, pending AI work
resumes. Presence of a key does not prove it is valid or that its provider is
healthy: if a provider rejects requests or is unavailable, check its account
and your Edge Function logs. Missing AI configuration never breaks a working
notes installation, and saved Recall history stays available to browse.

Once AI is on, Tidy's automatic pass starts filing notes that have no folder
and adding tags, including notes saved before AI was on. It never moves a
note that already has a folder, and its changes can be undone from Tidy's
change log.

**Monthly limits.** Your project has no monthly limit on Recall, semantic
history search or paid dictation until you set one. To cap one, add an Edge
Function secret:

| Secret                                | Caps                    |
| ------------------------------------- | ----------------------- |
| `RECALL_MONTHLY_LIMIT`                | Recall                  |
| `RECALL_HISTORY_SEARCH_MONTHLY_LIMIT` | semantic history search |
| `VOICE_CREDITS_MONTHLY_LIMIT`         | paid dictation          |

Use a whole number of 1 or more. The literal `unlimited` states "no limit"
outright. Any other value, `0` included, counts as a mistake and keeps the
numbers hosted Kinjot uses (`200`, `500` and `1200`) rather than removing the
limit, so the Usage tab shows it. Stored images have their own fixed ceilings,
1 GB and 2,000 images, which these secrets do not change. The app's Usage tab
shows the ceilings.

## 8. Optional: connect your agents

In Kinjot, open **Settings → Agent connections**, create a key, and run the
`npx kinjot init-selfhost --api-url '…'` command shown there for this
deployment. It asks for the key you just created.

## Updating

Run the workflow with `update` to install newer releases. One run installs
each newer release in turn and stops when current. Each update also runs
embedding backfill, even when up to date or pinned.

The shared app at `byo.kinjot.com` is built for the newest release and tested
against the release before it. Two or more releases behind is outside that
window: the app may report that your database is behind and stop syncing until
you run `update`; notes already on the device stay there. Run `update` after
each release to stay inside the window.

- Keep backups; they are recommended, not a deployment requirement.
- If an update fails, fix the cause and retry the **same release and mode**.
  Do not reset the backend, edit `.kinjot`, or switch releases to bypass
  recovery.
- Migration drift stops updates; updates never rewrite migration history. See
  [Recovering a failed run](#recovering-a-failed-run).

## Can't sign in

Your project's own admin API sets a new password directly, with no email
involved. You need your user id (**Authentication → Users** in the Supabase
Dashboard) and a secret key (**Project Settings → API Keys → Secret keys**, an
`sb_secret_…` key). On an older project without secret keys, the legacy
`service_role` key on the same page works in its place.

```bash
curl -X PUT "https://<project-ref>.supabase.co/auth/v1/admin/users/<user-id>" \
  -H "apikey: $SECRET_KEY" \
  -H "Authorization: Bearer $SECRET_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"password":"<your new password>","email_confirm":true}'
```

`email_confirm` also confirms the account, so the same command fixes "Email not
confirmed" (an account created with **Auto Confirm User** unticked). The secret
key bypasses every access rule in your database: run this from your own
machine and never put the key in a browser, a note or a URL.

**Never delete and recreate the user.** Your notes are keyed to that user, and
a new user starts with none of them.

## Recovering a failed run

The last lines of a failed run name the cause and the operation to run again.

- **Setup failed.** Fix what the log names (usually a secret) and run the
  operation it names again. Most failures stop before anything is installed:
  your database is unchanged, though your license may already be linked and
  sign-ups closed, and the rerun does not repeat finished license work. A line
  that says migrations may already have been applied, or that the run failed
  during a step such as migration apply, stopped part-way through installing a
  release and may have changed your database: run `update`, which repeats the
  unfinished install.
  `doctor` cannot run until a release is installed.
- **A setup or update run stopped at the ten-release or 20-minute limit.** Run
  `update` again to continue (see
  [How setup and update walk the releases](#how-setup-and-update-walk-the-releases)).

| Finding                                                        | Next step                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Interrupted update                                             | Fix the cause; rerun `update` for the recorded release and mode. Preserve recovery state.                    |
| Pending migrations without an interrupted update               | Check release inventory and database history. Update cannot replay an installed release as a schema repair. |
| Remote-only migration history                                  | Check the project and release, then run `repair-guide`. See the repair limits below.                         |
| Notes eligible for backfill                                    | Run `backfill`. It queues eligible notes, including Trash, without resetting jobs.                           |
| Missing marker, incompatible schema version, or damaged schema | Investigate the release and database. Do not change migration history just to clear a diagnostic.            |
| Function or provider failure                                   | Restore the deployment, credential, or dependency; rerun `doctor`.                                           |

**Repair limits:** `migration-repair` changes bookkeeping only, requires exact
typed confirmation, and cannot execute or undo SQL. Verify SQL effects
independently.

## Advanced

### Repository variables

All optional. Add them under **Settings → Secrets and variables → Actions →
Variables**.

| Variable                      | Value                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `KINJOT_SUPABASE_PROJECT_REF` | Your project reference. Read from the database URL when unset; if set, it must match the URL.              |
| `KINJOT_DEPLOYMENT_MODE`      | `full` or `backend-only`; new installs default to `backend-only`.                                          |
| `KINJOT_PAGES_PROJECT`        | Existing Pages project name; `full` only.                                                                  |
| `KINJOT_PAGES_BRANCH`         | Pages production branch; defaults to `main`.                                                               |
| `KINJOT_RELEASE_PIN`          | A release version to stop at instead of the newest.                                                        |
| `KINJOT_INSTANCE_NAME`        | Your license activation's name in Lemon Squeezy, before a short suffix; defaults to the repository's name. |

An incomplete update is always recovered with its original release: a pin that
names another release is refused until you clear it or set it to that release.
`KINJOT_SITE_URL` and `KINJOT_AUTH_CALLBACK_URL` are no longer used, and no
repository variable configures Supabase Auth.

### Your own Cloudflare Pages project (`full` mode)

The default, `backend-only`, uses `byo.kinjot.com` with your own Supabase
backend and needs no Cloudflare credentials. In `full` mode the web app is
published to your own Cloudflare Pages project, with the backend on Supabase.

Before installing in `full` mode, create a **Direct Upload Cloudflare Pages
project**:

- Use the account in `CLOUDFLARE_ACCOUNT_ID`.
- Match its name to `KINJOT_PAGES_PROJECT` and its production branch to
  `KINJOT_PAGES_BRANCH` (default: `main`).
- Give your Cloudflare token Pages edit access in that account.

An empty Pages project is enough. The updater checks it but does not create it.
Then add two more secrets, `CLOUDFLARE_API_TOKEN` (a token with Pages edit
access) and `CLOUDFLARE_ACCOUNT_ID` (the 32-character account id from your
Cloudflare dashboard), and set `KINJOT_DEPLOYMENT_MODE=full` and
`KINJOT_PAGES_PROJECT`. Open the app at your Pages origin instead of
`byo.kinjot.com`. Your Pages site serves the app without the license page that
`byo.kinjot.com` shows, so step 6 starts at **Connect**.

Existing installations keep their recorded deployment mode when no mode is
set. Setting the `KINJOT_DEPLOYMENT_MODE` variable overrides the recorded mode,
so leave it unset once installed unless you intend every future run, scheduled
ones included, to use that mode.

### Adding Pages to a backend-only installation

1. Resolve any incomplete update in its recorded mode.
2. Create the Pages project and add its credentials.
3. With the current template and a **newer release available**, set
   `KINJOT_DEPLOYMENT_MODE=full` and run `update`.

Keep that mode for future updates. Switching back to `backend-only` is
unsupported, as is adding Pages from the same already-installed release.

### How setup and update walk the releases

Setup and `update` are each **one** workflow run. The workflow installs one
release at a time until the deployment is on the newest release (or on
`KINJOT_RELEASE_PIN`), then stops. A run stops early at an error, after ten
releases, or once 20 minutes have passed (a release already started still
finishes); the last lines of its output say where it stopped. A run that
stops at the ten-release or 20-minute limit is marked failed on purpose, even
though every release it installed succeeded, so it is not mistaken for a
finished run: run `update` again to continue.

Stepping through releases is the workflow's job. A local `pnpm run update`,
and the workflow's `backend-only` operation, each move one release.

### Scheduled updates — off by default

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
step. Nothing else needs changing. A scheduled run installs at most one
release; only a run you dispatch steps through several.

Before you turn it on, know what an unattended `update` does. It applies
migrations and deploys functions against your Supabase project using your
account-wide access token, and it runs embedding backfill, which bills your
provider accounts. Run at least one update by hand first and read its output.

Two scheduling limits are GitHub's, not ours. Scheduled runs always use your
**default branch**, so a configuration branch that is not the default will fail
every week. GitHub also suspends scheduled workflows after **60 days** without
repository activity, and a repository only the cron touches is exactly that
case — check occasionally that it is still running.

### Doctor

`doctor` checks migrations, schema compatibility, the self-host marker,
backfill, functions, and providers. **It diagnoses problems; it does not
repair them.**

The workflow's `doctor` runs the core checks: migrations, the schema version,
the self-host marker, extensions, the schema, and function deployment. Its
first line, `Kinjot doctor: healthy`, covers only those and an interrupted
update. The lines below it
also report checks outside the core, each with its own status, and none of
them changes that first line:

- feature tables, the image storage bucket and the backfill count;
- `AI secrets in Supabase`, which names which of `OPENAI_API_KEY` and
  `VOYAGE_API_KEY` exist; the workflow tests no AI key;
- `authSignups`: `healthy (signups_closed)`, or `unhealthy (signups_open)`
  with a line saying how to close them. So `Kinjot doctor: healthy` can sit
  above open sign-ups: read this line too.

Setup uses the same core result: schema and function deployment checks must
pass, while optional AI diagnostics do not block installation. Image
attachments are not part of that core check, so they never block setup: setup
runs it right after installing the first release in the chain, before it
walks on to the newest, and that first release predates the attachments'
storage bucket and usage function. A standalone `doctor` names them missing
until the deployment is on a release that includes them. Doctor does not prove
your login, end-to-end sync, or provider health; finish the app steps above.

Doctor needs authenticated release inventory from an install attempt. If
inventory is missing or cannot be authenticated, it makes no diagnostic
provider requests. It runs the installed release's own checks and report, so a
change to doctor reaches an installation with its next signed release; only
when the installed release cannot be authenticated does it fall back to the
copy in your repository.

The workflow needs only database and Supabase project credentials. It does not
receive provider keys; the **Enable AI** section of Kinjot Settings checks the
configuration stored in Supabase. Doctor reports which of `OPENAI_API_KEY` and
`VOYAGE_API_KEY` exist in your Supabase project (`AI secrets in Supabase: …`):
it lists secret names through the Management API and never keeps or shows a
value. The standalone doctor CLI also supports **locally supplied probe
credentials** for explicit operator diagnostics. These do not read your
Supabase secrets, so an absent local probe key does not mean your backend's
key is missing. Its optional Voyage probe can incur a small charge and
requires `--allow-billable-voyage`. No such probe is part of normal setup.

**Reading the results:**

- A zero backfill gap does not prove queued jobs finished.
- ACTIVE function metadata does not prove invocation or provider configuration
  works.
- Schema checks do not verify SQL function bodies, RLS policies, or every
  index.
- Doctor cannot establish that your database URL and project ref belong
  together.
- Check individual results even when others are unavailable.

### License linking and unlinking

Setup links your license for you; you do not run `link` to install. Before it
records or activates anything, setup checks the key with Lemon Squeezy, and
each of these stops the run with nothing activated:

- a key Lemon Squeezy does not recognise, or a license that was refunded or
  disabled: copy the key from your receipt again, and if it is right, email
  hello@kinjot.com;
- a license already activated on another deployment: run `unlink` from that
  deployment, or deactivate the activation in Lemon Squeezy's
  [My Orders](https://app.lemonsqueezy.com/my-orders) page;
- a license service that did not answer: run it again later.

Setup also refuses a project that already holds tables before it activates
the license.

If a link was interrupted, run `setup` (or `link`) again. When no activation
exists for the license, it links normally. If the run stops again with an
unconfirmed activation, **do not create another instance**: the license is
activated somewhere. Deactivate that activation in Lemon Squeezy's
[My Orders](https://app.lemonsqueezy.com/my-orders) page and run it again, or,
if you know the activation's instance id, run `link` with it in
`license_instance_id`. Link validates the key, product, store, and instance
name before adopting an instance; a 404 alone does not prove an instance is
inactive. If saving an activation fails, Link attempts
to deactivate that verified instance.

Run `unlink` to release the linked instance. It saves progress before
deactivation; retries validate ownership or zero active slots before
completing. A different license key is refused before any provider request.
To move a deployment to another license, run `unlink` with the original key,
then `link` with the new one.

### Lost your deployment repository?

The license allows one linked deployment, and `unlink` needs the instance ID
stored in this repository. The repository also holds `.kinjot/deployment`, the
record of what is installed in your Supabase project, and no command can take
over an installed project without it. So the way back depends on what you
have:

- **A copy of the old repository** (a clone, a fork, a backup): restore it,
  including `.kinjot/deployment`, and carry on with `update` as before.
- **No copy, and you want to keep your existing Supabase project and its
  notes:** email hello@kinjot.com with your order number. Running `setup`
  against that project from a new repository does not help: it refuses a
  project that already holds Kinjot, before it activates your license.
- **No copy, starting over on a new, empty Supabase project:** free the old
  activation first — open Lemon Squeezy's
  [My Orders](https://app.lemonsqueezy.com/my-orders) page, open the order and
  its license, and deactivate the old activation if the page offers that, or
  email hello@kinjot.com with your order number — then run `setup` in a new
  repository created from this template.

### Workflow log lines you can ignore

- GitHub's “Node.js 20 is deprecated … forced to run on Node.js 24” warning
  for `pnpm/action-setup` can be ignored because the action is pinned before
  v6 on purpose.

### Technical details

- **Contents:** deployment tools and a public signature trust root.
  Application bundles are downloaded separately; this template contains no
  credentials or private application source.
- **Channel:** pins the production endpoint, licensed product, and trust root.
  Disabled enrollment makes Link and Update refuse before provider calls.
- **Recovery records:** the configuration branch stores progress.
  `.kinjot/instance.json` holds a SHA-256 key fingerprint, product ownership,
  and lifecycle state; the license key stays in GitHub Secrets.
- **Tooling:** Supabase CLI 2.118.0, pnpm 10.15.1, and Wrangler 4.156.2 are
  installed before credentials are exposed. The frozen install disables
  lifecycle scripts. Vendored updater, verifier, and doctor code fetch no npm
  code.

## License

This template and its deployment tools use the [MIT License](LICENSE).
Downloaded Kinjot application bundles use their separate commercial license,
the [Kinjot Self-host License](https://kinjot.com/self-host/license); MIT does
not cover the purchased app or private Kinjot source.
