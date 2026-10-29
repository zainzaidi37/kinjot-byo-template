// Release-owned structural prerequisites, not SQL supplied by a manifest. This
// focused inventory detects missing objects/disabled triggers; it does not attest
// function bodies, ACLs, RLS policy correctness, index health, or complete schema
// equivalence. Update deliberately alongside the future updater's release metadata.
const tables = [
  'folders',
  'notes',
  'tags',
  'note_tags',
  'api_keys',
  'profiles',
  'note_embeddings',
  'embedding_jobs',
  'recall_usage',
  'note_versions',
  'recalls',
  'tidy_runs',
  'tidy_changes',
  'tidy_jobs',
  'deployment_settings',
];
const columns = {
  notes: [
    'id',
    'user_id',
    'title',
    'body',
    'folder_id',
    'deleted_at',
    'sync_seq',
    'updated_at',
    'pinned_at',
    'pinned_in',
  ],
  folders: ['id', 'user_id', 'deleted_at', 'sync_seq', 'updated_at'],
  tags: ['id', 'user_id', 'deleted_at', 'sync_seq', 'updated_at'],
  note_tags: ['note_id', 'tag_id', 'user_id', 'deleted_at', 'sync_seq', 'updated_at'],
  profiles: [
    'plan',
    'version_history_enabled',
    'tidy_create_folders',
    'tidy_create_tags',
    'tidy_merge_tags',
    'billing_ref',
    'billing_period_start',
    'billing_period_end',
  ],
  note_embeddings: ['note_id', 'embedding', 'gist'],
  embedding_jobs: ['note_id', 'attempts'],
  recall_usage: ['semantic_search_count'],
  recalls: ['search_embedding'],
  tidy_runs: ['instruction', 'pending_plan', 'pending_expires_at', 'confirmed_at'],
  deployment_settings: ['id', 'self_hosted'],
};
const functions = [
  'sync_watermark()',
  'kinjot_schema_compatibility()',
  'is_self_hosted()',
  'backfill_self_hosted_embeddings()',
  'match_notes_for_recall(extensions.vector,integer)',
  'match_recalls(extensions.vector,integer)',
  'consume_recall_quota_pro(integer)',
  'consume_recall_history_search_quota_pro(integer)',
  'current_recall_usage()',
  'begin_tidy_run(uuid,text)',
  'apply_tidy_plan_v2(uuid,uuid,jsonb)',
  'revert_tidy_change_v2(uuid)',
  'revert_tidy_run_v2(uuid)',
  'tidy_scope_note_ids(uuid,jsonb,integer)',
  'tidy_clarify_library(uuid)',
  'mcp_verify_key_plan(text,boolean)',
  'mcp_save_note(text,uuid,text,text,text[],text,text)',
  'mcp_get_note(text,text)',
  'mcp_list_recent_notes(text,integer)',
  'mcp_search_notes(text,text)',
  'mcp_match_note_embeddings(text,extensions.vector,integer)',
  'mcp_notes_for_embedding(text,uuid[])',
  'purge_account(uuid)',
  'billing_period(uuid)',
  'refund_recall_quota(uuid)',
  'touch_tidy_run(uuid,uuid,integer)',
  'tidy_snapshot(uuid,uuid[])',
  'apply_tidy_plan(uuid,uuid,jsonb)',
  'tidy_eligible_jobs(uuid,boolean)',
  'suspend_tidy_run(uuid,uuid,jsonb,integer)',
  'resume_tidy_run(uuid,uuid)',
  'resuspend_tidy_run(uuid,uuid,jsonb,integer)',
  'discard_tidy_run(uuid)',
  'tidy_run_change_counts(uuid,uuid)',
  'supersede_recall_runs(uuid)',
  'restore_note_version(uuid)',
  'merge_tags(uuid,uuid[])',
];

const triggers = [
  'notes.notes_set_timestamps',
  'folders.folders_set_timestamps',
  'tags.tags_set_timestamps',
  'note_tags.note_tags_set_timestamps',
  'notes.notes_enqueue_embedding_insert',
  'notes.notes_enqueue_embedding_update',
  'notes.notes_enqueue_tidy_insert',
  'notes.notes_enqueue_tidy_first_content',
  'notes.notes_capture_version',
  'profiles.profiles_backfill_embeddings',
  'folders.folders_reject_nested_under_trash',
];

export const SCHEMA_PREREQUISITES = Object.freeze(
  [
    ...tables.map((name) => ({ kind: 'table', name: `public.${name}` })),
    ...Object.entries(columns).flatMap(([table, names]) =>
      names.map((name) => ({ kind: 'column', name: `public.${table}.${name}` })),
    ),
    ...functions.map((name) => ({ kind: 'function', name: `public.${name}` })),
    ...triggers.map((name) => ({ kind: 'trigger', name: `public.${name}` })),
    { kind: 'extension', name: 'extensions.vector' },
  ].map(Object.freeze),
);

/**
 * Catalog objects a feature needs that the fresh-install base release does not
 * create, read by the same catalog query as the inventory above and reported by
 * a check of its own (`featureSchema`) that is outside core readiness.
 *
 * Nothing may join the core inventory unless the base release creates it.
 * `setup` runs the doctor with `--core` straight after its first install, which
 * is always the base release (`selectRelease` starts a fresh install at the one
 * release with a null `minimumPreviousRelease`), and this file is vendored into
 * `customer-template/vendor/`, where it outlives the release it was written
 * beside. An object a later release adds goes here instead, or every new
 * operator is refused at `setup` (issue #608).
 *
 * `attachment_usage()` arrives with the image-attachments migration. The app
 * already fails soft without it (`PGRST202` is `missing_migration`), so its
 * absence costs image uploads, not the deployment.
 */
export const FEATURE_SCHEMA_PREREQUISITES = Object.freeze(
  [{ kind: 'function', name: 'public.attachment_usage()' }].map(Object.freeze),
);

/**
 * The image-attachment bucket (plan D12), a prerequisite of its own kind.
 *
 * A bucket is a **row** in `storage.buckets`, not a catalog object, so nothing
 * in `pg_catalog` knows it exists and the inventory above cannot see it. That
 * matters: the attachments migration is re-runnable, but its bucket insert is
 * `on conflict do nothing`, so a project whose bucket was dropped keeps a
 * healthy `attachment_usage()`, two healthy policies, and nowhere to put an
 * image. Without this the doctor is blind to the feature's main dependency.
 *
 * It is a **separate check** rather than one more row in the schema query, and
 * that separation is the whole reason it is safe. `storage.buckets` has RLS
 * enabled and is owned by `supabase_storage_admin`, and the doctor's script
 * runs every statement under `SET LOCAL row_security = off` — which *errors*
 * for a role that is neither the owner nor `BYPASSRLS`. Measured 2026-09-21:
 * `postgres` has `rolbypassrls = true` and SELECT here both on the local stack
 * and on a real hosted project, so the role a Supabase database URL names can
 * read it; a role that cannot would otherwise have turned the entire
 * structural inventory into one `permission_denied` and lost every other
 * answer with it. On its own check, that role loses only this one line.
 *
 * Only the bucket's PRESENCE is a prerequisite. Its `public`,
 * `file_size_limit` and `allowed_mime_types` are deliberately left as the
 * operator has them on a re-run (a BYO operator may have widened their own
 * mime list), so reporting divergence there would be a claim this inventory
 * makes about nothing else either.
 */
export const BUCKET_PREREQUISITES = Object.freeze(
  [{ kind: 'bucket', name: 'storage.buckets.note-attachments' }].map(Object.freeze),
);
