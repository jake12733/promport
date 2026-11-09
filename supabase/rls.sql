-- =====================================================================
-- PromptStudio 보안 설정 (Supabase SQL Editor에 그대로 붙여 넣고 Run)
-- 여러 번 실행해도 안전합니다(idempotent).
-- =====================================================================

-- ---------------------------------------------------------------
-- 1) RLS 켜기
-- ---------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.prompts       enable row level security;
alter table public.conversations enable row level security;
alter table public.chat_messages enable row level security;

-- ---------------------------------------------------------------
-- 2) 기존 정책 정리 후 "본인 데이터만" 정책 다시 만들기
-- ---------------------------------------------------------------
drop policy if exists "own profile read"   on public.profiles;
drop policy if exists "own profile update" on public.profiles;
drop policy if exists "own prompts"        on public.prompts;
drop policy if exists "own convs"          on public.conversations;
drop policy if exists "own chats"          on public.chat_messages;

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
-- profiles 행은 가입 시 트리거(handle_new_user)가 만들고, 사용자가 직접 추가/삭제하지 않습니다.

do $$
declare t text;
begin
  foreach t in array array['prompts','conversations','chat_messages'] loop
    execute format('drop policy if exists %I on public.%I', t||'_select_own', t);
    execute format('drop policy if exists %I on public.%I', t||'_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t||'_update_own', t);
    execute format('drop policy if exists %I on public.%I', t||'_delete_own', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t||'_select_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', t||'_insert_own', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t||'_update_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', t||'_delete_own', t);
  end loop;
end $$;

-- 채팅 메시지는 "내 대화방"에만 넣을 수 있게 한 번 더 확인
drop policy if exists chat_messages_insert_own on public.chat_messages;
create policy chat_messages_insert_own on public.chat_messages
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (conversation_id is null or exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())))
  );

-- ---------------------------------------------------------------
-- 3) 불필요한 권한 회수 (비로그인(anon)은 DB를 쓰지 않음)
-- ---------------------------------------------------------------
revoke all on public.profiles, public.prompts, public.conversations, public.chat_messages from anon;
revoke truncate, references, trigger on public.profiles, public.prompts, public.conversations, public.chat_messages from authenticated;
revoke insert, delete on public.profiles from authenticated;

-- ---------------------------------------------------------------
-- 4) 기본 AI 하루 사용량 제한 (Edge Function "generate"에서 사용)
-- ---------------------------------------------------------------
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default ((now() at time zone 'Asia/Seoul')::date),
  count   int  not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;
grant select on public.ai_usage to authenticated;
drop policy if exists ai_usage_select_own on public.ai_usage;
create policy ai_usage_select_own on public.ai_usage
  for select to authenticated using ((select auth.uid()) = user_id);

-- 1회 차감 (한도 초과면 null 반환). 서버(service_role)만 호출 가능
create or replace function public.ai_usage_bump(p_user uuid, p_limit int)
returns int language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Seoul')::date; n int;
begin
  insert into public.ai_usage(user_id, day, count) values (p_user, d, 1)
  on conflict (user_id, day) do update set count = public.ai_usage.count + 1
  where public.ai_usage.count < p_limit
  returning count into n;
  return n;
end $$;

-- 실패한 호출은 되돌려 줌
create or replace function public.ai_usage_refund(p_user uuid)
returns void language sql security definer set search_path = public as $$
  update public.ai_usage set count = greatest(count - 1, 0)
  where user_id = p_user and day = (now() at time zone 'Asia/Seoul')::date;
$$;

revoke all on function public.ai_usage_bump(uuid, int) from public, anon, authenticated;
revoke all on function public.ai_usage_refund(uuid)    from public, anon, authenticated;
grant execute on function public.ai_usage_bump(uuid, int) to service_role;
grant execute on function public.ai_usage_refund(uuid)    to service_role;

-- ---------------------------------------------------------------
-- 5) 확인용: 아래 결과에서 4개 테이블 + ai_usage 모두 rls = true 여야 정상
-- ---------------------------------------------------------------
select c.relname as table_name, c.relrowsecurity as rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;
