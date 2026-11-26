-- Booking form agent search: look through every agent in the database, not only partners.
-- Clients often book with an agent who hasn't been contacted yet, so partners-only missed them.
-- Unchanged: opted-out agents never appear, 3-letter minimum, max 3 rows, contact details masked,
-- and the function is only callable server-side (service role) via /api/agent-suggest.
-- Partners are listed first when several agents match.
create or replace function public.suggest_agents(q text)
returns table (id uuid, name text, agency_name text, email_hint text, phone_hint text)
language sql stable security definer set search_path = public as $$
  select a.id, a.name, coalesce(ag.name, a.agency_name) as agency_name,
         case when a.email like '%@%'
              then left(a.email, 1) || '•••@' || split_part(a.email, '@', 2) end as email_hint,
         case when length(regexp_replace(coalesce(a.phone, ''), '\D', '', 'g')) >= 7
              then left(a.phone, 7) || ' ••• ' || right(regexp_replace(a.phone, '\D', '', 'g'), 2) end as phone_hint
  from agents a
  left join agencies ag on ag.id = a.agency_id
  where length(trim(q)) >= 3
    and not a.opted_out
    and (lower(a.name) like '%' || lower(trim(q)) || '%'
         or similarity(lower(a.name), lower(trim(q))) > 0.3)
  order by (a.outreach_status = 'partner') desc,
           (lower(a.name) like lower(trim(q)) || '%') desc,
           similarity(lower(a.name), lower(trim(q))) desc
  limit 3;
$$;

revoke execute on function public.suggest_agents(text) from public, anon, authenticated;
grant execute on function public.suggest_agents(text) to service_role;
