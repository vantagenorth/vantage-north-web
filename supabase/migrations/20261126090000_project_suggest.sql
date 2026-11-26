-- Booking form project search: suggest saved projects as the client types the project name,
-- so the same building isn't saved under several spellings.
-- 3-letter minimum, max 3 rows, returns the project's area and developer to prefill the form.
-- Only callable server-side (service role) via /api/project-suggest, like suggest_agents.
create extension if not exists pg_trgm;

create or replace function public.suggest_projects(q text)
returns table (id uuid, name text, area text, developer text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.area, d.name as developer
  from projects p
  left join developers d on d.id = p.developer_id
  where length(trim(q)) >= 3
    and (lower(p.name) like '%' || lower(trim(q)) || '%'
         or similarity(lower(p.name), lower(trim(q))) > 0.3
         or word_similarity(lower(trim(q)), lower(p.name)) >= 0.5)   -- typos like 'mayfare', 'waves opulance'
  order by (lower(p.name) like lower(trim(q)) || '%') desc,
           greatest(similarity(lower(p.name), lower(trim(q))), word_similarity(lower(trim(q)), lower(p.name))) desc,
           (p.reelly_id is not null) desc,
           p.name
  limit 3;
$$;

revoke execute on function public.suggest_projects(text) from public, anon, authenticated;
grant execute on function public.suggest_projects(text) to service_role;
