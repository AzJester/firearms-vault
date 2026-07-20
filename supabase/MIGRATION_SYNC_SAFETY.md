# Sync-safety migration

Apply `migrations/20260720000001_sync_safety.sql` in the Supabase SQL editor before
`migrations/20260720000002_share_safety.sql`, and before deploying the matching
client code. The distinct timestamp prefixes preserve this order in migration
tooling. For a brand-new project, run the complete `schema.sql` instead.

The migration is additive and does not rewrite collection JSON or storage
objects. It adds:

- a monotonically increasing `collections.revision` used for compare-and-swap;
- a SHA-256 `media_manifest` with content-addressed object paths;
- up to 50 prior structured revisions per account in `collection_versions`;
- `save_collection_cas`, which atomically checks, versions, and saves;
- an owner-scoped `health_checks` canary and `run_health_check_canary` RPC.

The client remains usable before the migration: it falls back to an
`updated_at` conditional update and shows a degraded sync state. That fallback
does not provide server-side version history or content-addressed media, so it
is a transition path rather than the desired steady state.

## Verification

Run these checks as an authenticated test user:

```sql
select public.run_health_check_canary('manual-verification');
select revision, jsonb_typeof(media_manifest) from public.collections
where user_id = auth.uid();
select revision, created_at from public.collection_versions
where user_id = auth.uid() order by revision desc limit 5;
```

Expected canary result: `ok` is true and `deleted` is 1. The `health_checks`
table should contain no row for the caller after the RPC returns. Anonymous
requests must not be able to select any of these tables or execute either RPC.

## Rollback

The old client ignores the two added columns. If the new client must be rolled
back, leave the columns and history table in place and deploy the prior static
assets. Do not drop revision history until a verified backup has been restored
and checked.
