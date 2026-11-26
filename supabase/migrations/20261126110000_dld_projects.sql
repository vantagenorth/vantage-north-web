-- Dubai Land Department project list (via datadubai.ae, CC BY 4.0) for the booking form's project search.
-- Filled nightly by /api/project-suggest?action=dld-import from https://datadubai.ae/projects.json.
create table if not exists public.dld_projects (
    pn bigint primary key,           -- DLD project number
    name text not null,
    slug text,
    community text,
    developer text,                   -- cleaned (no "L.L.C", "Fze" ...)
    status text,
    completion_date date,
    synced_at timestamptz not null default now()
);
alter table public.dld_projects enable row level security;   -- no policies: service role only
create index if not exists dld_projects_name_trgm on public.dld_projects using gin (lower(name) gin_trgm_ops);

-- Search order: our saved projects, then Reelly, then DLD. A DLD row is skipped when a saved or
-- Reelly project has the same name, or when DLD's name is "<master community> - <that name>"
-- (e.g. "Sobha Hartland - Crest Grande"), so Reelly's spelling wins.
-- New name rather than replacing suggest_projects, because the result gains a `source` column
-- (changing a function's columns needs a DROP). suggest_projects stays, unused.
create or replace function public.suggest_project_matches(q text)
returns table (id uuid, name text, area text, developer text, source text)
language sql stable security definer set search_path = public as $$
  with qq as (select lower(trim(q)) as t),
  known as (
    select lower(p.name) as n, p.reelly_id from projects p
    union all
    select lower(r.name), r.reelly_id from reelly_projects r
  ),
  candidates as (
    select p.id, p.name, p.area, d.name as developer, 'saved'::text as source, 0 as src
    from projects p left join developers d on d.id = p.developer_id
    union all
    select null::uuid, r.name, r.area, r.developer, 'reelly', 1
    from reelly_projects r
    where not exists (select 1 from projects p
                      where p.reelly_id = r.reelly_id or lower(p.name) = lower(r.name))
    union all
    select null::uuid, x.name, x.community, x.developer, 'dld', 2
    from dld_projects x
    where not exists (select 1 from known k
                      where k.n = lower(x.name) or lower(x.name) like '% - ' || k.n)
  )
  select c.id, c.name, c.area, c.developer, c.source
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

revoke execute on function public.suggest_project_matches(text) from public, anon, authenticated;
grant execute on function public.suggest_project_matches(text) to service_role;
