-- =====================================================================
-- Simple Chat: database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- It's safe to run more than once.
-- =====================================================================


-- ---------- 1. Profiles: one per user (username + optional photo) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[A-Za-z0-9_.]{3,20}$')
);
-- Usernames are unique, ignoring upper/lower case
create unique index if not exists profiles_username_unique on public.profiles (lower(username));

-- When someone signs up, create their profile from the username they chose
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data ->> 'username');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Lets the sign-up screen check if a username is free
create or replace function public.username_available(name text) returns boolean
language sql security definer set search_path = public stable as $$
  select not exists (select 1 from public.profiles where lower(username) = lower(name));
$$;


-- ---------- 2. Chats (private or group) and who's in them ----------
create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  is_group boolean not null default false,
  name text check (name is null or char_length(name) between 1 and 40),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table if not exists public.chat_members (
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),   -- for unread counts and "Seen"
  primary key (chat_id, user_id)
);
create index if not exists chat_members_user_idx on public.chat_members (user_id);


-- ---------- 3. Messages and reactions ----------
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  text text not null default '' check (char_length(text) <= 2000),
  image_path text,                                    -- photo location in storage
  reply_to bigint references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint message_not_empty check (char_length(text) > 0 or image_path is not null or deleted_at is not null)
);
create index if not exists messages_chat_time_idx on public.messages (chat_id, created_at desc);

create table if not exists public.reactions (
  message_id bigint not null references public.messages(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  emoji text not null check (emoji in ('❤️', '😂', '👍', '😮', '😢', '🔥')),
  chat_id uuid not null references public.chats(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists reactions_chat_idx on public.reactions (chat_id);


-- ---------- 4. Helper: is the logged-in user in this chat? ----------
create or replace function public.is_member(chat uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.chat_members where chat_id = chat and user_id = auth.uid());
$$;

-- Same check, but takes text (used for photo folders, which are named after the chat)
create or replace function public.is_member_text(chat text) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.chat_members where chat_id::text = chat and user_id = auth.uid());
$$;


-- ---------- 5. Security rules: people only see chats they're in ----------
alter table public.profiles enable row level security;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;
alter table public.reactions enable row level security;

-- Profiles: any logged-in user can see usernames (to start chats); you can only edit your own
drop policy if exists "profiles are visible to logged-in users" on public.profiles;
create policy "profiles are visible to logged-in users" on public.profiles
  for select to authenticated using (true);
drop policy if exists "you can update your own profile" on public.profiles;
create policy "you can update your own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from anon, authenticated;
grant update (username, avatar_url) on public.profiles to authenticated;

-- Chats and members: only visible to members. New chats are made through the functions below.
drop policy if exists "members can see their chats" on public.chats;
create policy "members can see their chats" on public.chats
  for select to authenticated using (public.is_member(id));
drop policy if exists "members can see who is in their chats" on public.chat_members;
create policy "members can see who is in their chats" on public.chat_members
  for select to authenticated using (public.is_member(chat_id));
revoke insert, update, delete on public.chats, public.chat_members from anon, authenticated;

-- Messages: members can read; you can only send as yourself; you can only edit/delete your own
drop policy if exists "members can read messages" on public.messages;
create policy "members can read messages" on public.messages
  for select to authenticated using (public.is_member(chat_id));
drop policy if exists "members can send messages" on public.messages;
create policy "members can send messages" on public.messages
  for insert to authenticated with check (
    user_id = auth.uid()
    and public.is_member(chat_id)
    and edited_at is null and deleted_at is null
    and (image_path is null or image_path like chat_id::text || '/%')
  );
drop policy if exists "you can edit your own messages" on public.messages;
create policy "you can edit your own messages" on public.messages
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke update, delete on public.messages from anon, authenticated;
grant update (text, image_path, edited_at, deleted_at) on public.messages to authenticated;

-- Reactions: members can see; you can add/remove your own
drop policy if exists "members can see reactions" on public.reactions;
create policy "members can see reactions" on public.reactions
  for select to authenticated using (public.is_member(chat_id));
drop policy if exists "members can react" on public.reactions;
create policy "members can react" on public.reactions
  for insert to authenticated with check (
    user_id = auth.uid()
    and public.is_member(chat_id)
    and exists (select 1 from public.messages m where m.id = message_id and m.chat_id = reactions.chat_id)
  );
drop policy if exists "you can remove your reactions" on public.reactions;
create policy "you can remove your reactions" on public.reactions
  for delete to authenticated using (user_id = auth.uid());
revoke update on public.reactions from anon, authenticated;


-- ---------- 6. Functions the app calls ----------

-- Start (or reopen) a private chat with someone
create or replace function public.create_dm(other_user uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  existing uuid;
  new_chat uuid;
begin
  if me is null then raise exception 'Not logged in'; end if;
  if other_user = me then raise exception 'You can''t start a chat with yourself'; end if;
  if not exists (select 1 from profiles where id = other_user) then raise exception 'User not found'; end if;

  select c.id into existing
  from chats c
  join chat_members a on a.chat_id = c.id and a.user_id = me
  join chat_members b on b.chat_id = c.id and b.user_id = other_user
  where not c.is_group
  limit 1;
  if existing is not null then return existing; end if;

  insert into chats (is_group, created_by) values (false, me) returning id into new_chat;
  insert into chat_members (chat_id, user_id) values (new_chat, me), (new_chat, other_user);
  return new_chat;
end $$;

-- Create a group chat with a name and members
create or replace function public.create_group(group_name text, member_ids uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  new_chat uuid;
begin
  if me is null then raise exception 'Not logged in'; end if;
  if coalesce(trim(group_name), '') = '' then raise exception 'Give the group a name'; end if;

  insert into chats (is_group, name, created_by) values (true, left(trim(group_name), 40), me)
  returning id into new_chat;
  insert into chat_members (chat_id, user_id)
    select new_chat, p.id from profiles p where p.id = me or p.id = any(member_ids);
  return new_chat;
end $$;

-- Add people to a group you're in
create or replace function public.add_group_members(chat uuid, member_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from chats where id = chat and is_group) then raise exception 'Not a group'; end if;
  if not public.is_member(chat) then raise exception 'You are not in this group'; end if;
  insert into chat_members (chat_id, user_id)
    select chat, p.id from profiles p where p.id = any(member_ids)
  on conflict do nothing;
end $$;

-- Leave a group
create or replace function public.leave_group(chat uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from chats where id = chat and is_group) then raise exception 'Not a group'; end if;
  delete from chat_members where chat_id = chat and user_id = auth.uid();
end $$;

-- Mark a chat as read (clears the unread badge)
create or replace function public.mark_read(chat uuid) returns void
language sql security definer set search_path = public as $$
  update public.chat_members set last_read_at = now() where chat_id = chat and user_id = auth.uid();
$$;

-- Everything the chat list needs, newest chat first
create or replace function public.my_chats()
returns table (
  id uuid, is_group boolean, name text, other_user_id uuid, member_count bigint,
  last_message_at timestamptz, last_text text, last_has_image boolean,
  last_sender_id uuid, last_deleted boolean, unread bigint
)
language sql security definer set search_path = public stable as $$
  select
    c.id, c.is_group, c.name,
    (select o.user_id from chat_members o where o.chat_id = c.id and o.user_id <> auth.uid() limit 1),
    (select count(*) from chat_members n where n.chat_id = c.id),
    c.last_message_at,
    lm.text, lm.image_path is not null, lm.user_id, lm.deleted_at is not null,
    (select count(*) from messages u
       where u.chat_id = c.id and u.user_id <> auth.uid()
         and u.created_at > mine.last_read_at and u.deleted_at is null)
  from chat_members mine
  join chats c on c.id = mine.chat_id
  left join lateral (
    select m.* from messages m where m.chat_id = c.id order by m.created_at desc limit 1
  ) lm on true
  where mine.user_id = auth.uid()
  order by c.last_message_at desc;
$$;

-- When a message is sent: move the chat to the top, and mark it read for the sender
create or replace function public.after_message_sent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update chats set last_message_at = new.created_at where id = new.chat_id;
  update chat_members set last_read_at = new.created_at
    where chat_id = new.chat_id and user_id = new.user_id;
  return new;
end $$;

drop trigger if exists on_message_sent on public.messages;
create trigger on_message_sent
  after insert on public.messages
  for each row execute function public.after_message_sent();


-- ---------- 7. Real-time updates ----------
do $$
declare t text;
begin
  foreach t in array array['messages', 'reactions', 'chat_members'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- So the app learns which reaction was removed
alter table public.reactions replica identity full;


-- ---------- 8. Photo storage (private: only chat members can see a chat's photos) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-photos', 'chat-photos', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

-- Photos are saved as "<chat id>/<random name>.jpg"
drop policy if exists "chat members can view chat photos" on storage.objects;
create policy "chat members can view chat photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-photos' and public.is_member_text((storage.foldername(name))[1]));

drop policy if exists "chat members can upload chat photos" on storage.objects;
create policy "chat members can upload chat photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-photos' and public.is_member_text((storage.foldername(name))[1]));

-- Done! You should see "Success. No rows returned".
