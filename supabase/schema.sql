-- Personal Firearms Database backend
-- Run once in the Supabase SQL Editor for the new private project.

create extension if not exists pgcrypto;

create table if not exists public.collections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.collections enable row level security;
revoke all on public.collections from anon;
grant select, insert, update, delete on public.collections to authenticated;

drop policy if exists "collections_select_own" on public.collections;
create policy "collections_select_own" on public.collections
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "collections_insert_own" on public.collections;
create policy "collections_insert_own" on public.collections
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "collections_update_own" on public.collections;
create policy "collections_update_own" on public.collections
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "collections_delete_own" on public.collections;
create policy "collections_delete_own" on public.collections
  for delete to authenticated using (auth.uid() = user_id);

create table if not exists public.shares (
  token uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  label text,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists shares_owner_created_idx
  on public.shares (owner, created_at desc);
create index if not exists shares_expiry_idx
  on public.shares (expires_at) where expires_at is not null;

alter table public.shares enable row level security;
revoke all on public.shares from anon;
grant select, insert, update, delete on public.shares to authenticated;

drop policy if exists "shares_select_own" on public.shares;
create policy "shares_select_own" on public.shares
  for select to authenticated using (auth.uid() = owner);

drop policy if exists "shares_insert_own" on public.shares;
create policy "shares_insert_own" on public.shares
  for insert to authenticated with check (auth.uid() = owner);

drop policy if exists "shares_update_own" on public.shares;
create policy "shares_update_own" on public.shares
  for update to authenticated
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

drop policy if exists "shares_delete_own" on public.shares;
create policy "shares_delete_own" on public.shares
  for delete to authenticated using (auth.uid() = owner);

create or replace function public.get_shared_inventory(share_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select s.snapshot
  from public.shares as s
  where s.token = share_token
    and (s.expires_at is null or s.expires_at > now())
  limit 1;
$$;

revoke all on function public.get_shared_inventory(uuid) from public;
grant execute on function public.get_shared_inventory(uuid) to anon, authenticated;

insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do update set public = false;

drop policy if exists "media_select_own" on storage.objects;
create policy "media_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "media_insert_own" on storage.objects;
create policy "media_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "media_update_own" on storage.objects;
create policy "media_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "media_delete_own" on storage.objects;
create policy "media_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
