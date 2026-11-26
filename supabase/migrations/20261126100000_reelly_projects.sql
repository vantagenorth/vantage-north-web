-- Our own copy of Reelly's Dubai project list, used only by the booking form's project search.
-- Kept separate from `projects` (which the Vantage North app uses for its own pipeline),
-- so importing ~1,700 projects doesn't flood the app.
-- Filled and refreshed by /api/project-suggest?action=reelly-import (daily Vercel cron).
create table if not exists public.reelly_projects (
    reelly_id bigint primary key,
    name text not null,
    area text,
    developer text,
    construction_status text,
    completion_date text,
    reelly_updated_at timestamptz,
    synced_at timestamptz not null default now()
);

alter table public.reelly_projects enable row level security;   -- no policies: service role only

create index if not exists reelly_projects_name_trgm on public.reelly_projects using gin (lower(name) gin_trgm_ops);
create index if not exists projects_name_trgm on public.projects using gin (lower(name) gin_trgm_ops);

-- Where the import got to, so a run that runs out of time carries on next time.
create table if not exists public.reelly_sync_state (
    id int primary key default 1 check (id = 1),
    next_offset int not null default 0,
    total int,
    last_full_sync_at timestamptz,
    last_run_at timestamptz,
    last_error text
);
alter table public.reelly_sync_state enable row level security;
insert into public.reelly_sync_state (id) values (1) on conflict do nothing;

-- Search now covers saved projects first, then the Reelly copy (skipping ones already saved).
-- Reelly rows come back with id null: the form prefills area and developer, and the booking
-- saves the project under Reelly's spelling.
create or replace function public.suggest_projects(q text)
returns table (id uuid, name text, area text, developer text)
language sql stable security definer set search_path = public as $$
  with qq as (select lower(trim(q)) as t),
  candidates as (
    select p.id, p.name, p.area, d.name as developer, 0 as src
    from projects p left join developers d on d.id = p.developer_id
    union all
    select null::uuid, r.name, r.area, r.developer, 1 as src
    from reelly_projects r
    where not exists (select 1 from projects p
                      where p.reelly_id = r.reelly_id or lower(p.name) = lower(r.name))
  )
  select c.id, c.name, c.area, c.developer
  from candidates c, qq
  where length(qq.t) >= 3
    and (lower(c.name) like '%' || qq.t || '%'
         or similarity(lower(c.name), qq.t) > 0.3
         or word_similarity(qq.t, lower(c.name)) >= 0.5)
  order by (lower(c.name) like qq.t || '%') desc,
           greatest(similarity(lower(c.name), qq.t), word_similarity(qq.t, lower(c.name))) desc,
           c.src,
           c.name
  limit 3;
$$;

revoke execute on function public.suggest_projects(text) from public, anon, authenticated;
grant execute on function public.suggest_projects(text) to service_role;
