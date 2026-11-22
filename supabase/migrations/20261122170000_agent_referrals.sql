-- Vantage North: agent referral tracking + agent data ingest (v2)
-- Additive only. The link is bookings.agent_id (set by the booking flow from the agent name).
-- Commission rate comes from agents.referral_percentage, or 10% if not set. No VAT handling (not VAT-registered).

------------------------------------------------------------
-- 1. Agents: licence check, ingest + outreach fields
------------------------------------------------------------
alter table public.agents
  add column if not exists whatsapp          text,
  add column if not exists rera_brn          text,
  add column if not exists brn_verified_at   timestamptz,
  add column if not exists source            text not null default 'manual'
                           check (source in ('manual','booking','bayut','propertyfinder')),
  add column if not exists source_id         text,
  add column if not exists service_areas     text[] not null default '{}',
  add column if not exists languages         text[] not null default '{}',
  add column if not exists villa_listings    integer,
  add column if not exists outreach_status   text not null default 'prospect'
                           check (outreach_status in ('prospect','contacted','replied','met','partner','not_interested')),
  add column if not exists last_contacted_at timestamptz,
  add column if not exists opted_out         boolean not null default false,
  add column if not exists notes             text;

create unique index if not exists agents_source_source_id_key
  on public.agents (source, source_id) where source_id is not null;

------------------------------------------------------------
-- 2. Agencies: RERA office number + payout preference
------------------------------------------------------------
alter table public.agencies
  add column if not exists rera_orn        text,
  add column if not exists pays_via_agency boolean not null default false;

------------------------------------------------------------
-- 3. Referrals ledger
------------------------------------------------------------
create table if not exists public.referrals (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  booking_id       uuid not null unique references public.bookings(id),
  payment_id       uuid references public.payments(id),
  agent_id         uuid not null references public.agents(id),
  agency_id        uuid references public.agencies(id),
  payee            text not null default 'agent' check (payee in ('agent','agency')),
  base_amount_aed  numeric(12,2) not null,
  rate_pct         numeric(5,2) check (rate_pct >= 0 and rate_pct <= 50),   -- copied from the agent at payment time
  commission_aed   numeric(12,2) generated always as (round(base_amount_aed * rate_pct / 100, 2)) stored,
  status           text not null default 'pending'
                   check (status in ('pending','approved','paid','void')),
  brn_checked      boolean not null default false,
  approved_at      timestamptz,
  paid_at          timestamptz,
  payout_reference text,
  void_reason      text,
  notes            text
);

create index if not exists referrals_agent_id_idx on public.referrals (agent_id);
create index if not exists referrals_status_idx   on public.referrals (status);

drop trigger if exists trg_referrals_updated_at on public.referrals;
create trigger trg_referrals_updated_at
  before update on public.referrals
  for each row execute function public.touch_updated_at();

alter table public.referrals enable row level security;
create policy "Team can read referrals"   on public.referrals for select using (public.is_team_member((select auth.uid())));
create policy "Team can add referrals"    on public.referrals for insert with check (public.is_team_member((select auth.uid())));
create policy "Team can change referrals" on public.referrals for update using (public.is_team_member((select auth.uid())));
-- No delete policy: void instead.

------------------------------------------------------------
-- 4. Core: create a referral for a paid booking with an agent
------------------------------------------------------------
create or replace function public.create_referral_for_booking(_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  b  bookings%rowtype;
  p  payments%rowtype;
  a  agents%rowtype;
  ag agencies%rowtype;
begin
  select * into b from bookings where id = _booking_id;
  if b.agent_id is null then return; end if;

  select * into p from payments
   where booking_id = _booking_id and status = 'paid' and not is_test
   order by paid_at desc nulls last limit 1;
  if p.id is null then return; end if;

  select * into a from agents where id = b.agent_id;
  if a.agency_id is not null then select * into ag from agencies where id = a.agency_id; end if;

  insert into referrals (booking_id, payment_id, agent_id, agency_id, payee,
                         base_amount_aed, rate_pct, status, brn_checked)
  values (b.id, p.id, a.id, a.agency_id,
          case when coalesce(ag.pays_via_agency, false) then 'agency' else 'agent' end,
          coalesce(p.amount_aed, p.total, 0),
          coalesce(a.referral_percentage, 10),   -- standard rate when the agent has none
          'pending',
          a.brn_verified_at is not null)
  on conflict (booking_id) do nothing;
end $$;

-- Fires when a payment becomes paid (or is refunded)
create or replace function public.payment_referral_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'paid' and coalesce(old.status, '') <> 'paid' and new.booking_id is not null then
    perform create_referral_for_booking(new.booking_id);
  elsif new.status in ('refunded','failed','cancelled') and old.status = 'paid' then
    update referrals set status = 'void', void_reason = 'payment ' || new.status
     where payment_id = new.id and status in ('pending','approved');
  end if;
  return new;
end $$;

drop trigger if exists trg_payment_referral on public.payments;
create trigger trg_payment_referral
  after insert or update of status on public.payments
  for each row execute function public.payment_referral_trigger();

-- Fires when an agent is attached to a booking after it was already paid
create or replace function public.booking_referral_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.agent_id is not null and new.agent_id is distinct from old.agent_id then
    perform create_referral_for_booking(new.id);
  end if;
  return new;
end $$;

drop trigger if exists trg_booking_referral on public.bookings;
create trigger trg_booking_referral
  after update of agent_id on public.bookings
  for each row execute function public.booking_referral_trigger();

------------------------------------------------------------
-- 5. Agent statement view
------------------------------------------------------------
create or replace view public.agent_referral_summary
with (security_invoker = true) as
select
  a.id as agent_id, a.name, a.agency_name, a.referral_percentage,
  count(r.id) filter (where r.status <> 'void')                                          as referrals,
  coalesce(sum(r.commission_aed) filter (where r.status in ('pending','approved')), 0)   as owed_aed,
  coalesce(sum(r.commission_aed) filter (where r.status = 'paid'), 0)                    as paid_aed,
  max(r.created_at)                                                                      as last_referral_at
from public.agents a
left join public.referrals r on r.agent_id = a.id
group by a.id, a.name, a.agency_name, a.referral_percentage;

------------------------------------------------------------
-- 6. Agent name suggestions for the booking form
--    Partners only, max 3 rows, name + agency only.
--    Called server-side by /api/agent-suggest with the service role; not exposed to anon.
------------------------------------------------------------
create extension if not exists pg_trgm;

create index if not exists agents_name_trgm_idx
  on public.agents using gin (lower(name) gin_trgm_ops);

create or replace function public.suggest_partner_agents(q text)
returns table (id uuid, name text, agency_name text, email_hint text, phone_hint text)
language sql stable security definer set search_path = public as $$
  -- Contact details are returned masked only; the full email and phone stay in the database
  select a.id, a.name, coalesce(ag.name, a.agency_name) as agency_name,
         case when a.email like '%@%'
              then left(a.email, 1) || '•••@' || split_part(a.email, '@', 2) end as email_hint,
         case when length(regexp_replace(coalesce(a.phone, ''), '\D', '', 'g')) >= 7
              then left(a.phone, 7) || ' ••• ' || right(regexp_replace(a.phone, '\D', '', 'g'), 2) end as phone_hint
  from agents a
  left join agencies ag on ag.id = a.agency_id
  where length(trim(q)) >= 3
    and a.outreach_status = 'partner'
    and not a.opted_out
    and (lower(a.name) like '%' || lower(trim(q)) || '%'
         or similarity(lower(a.name), lower(trim(q))) > 0.3)
  order by (lower(a.name) like lower(trim(q)) || '%') desc,
           similarity(lower(a.name), lower(trim(q))) desc
  limit 3;
$$;

revoke execute on function public.suggest_partner_agents(text) from public, anon, authenticated;
grant execute on function public.suggest_partner_agents(text) to service_role;
