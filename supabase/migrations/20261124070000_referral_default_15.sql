-- Standard partner referral rate is 15% (was 10%) for agents with no referral_percentage set.
-- Only the default in create_referral_for_booking changes. Existing referrals keep the rate they were created with.

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
          coalesce(a.referral_percentage, 15),   -- standard rate when the agent has none
          'pending',
          a.brn_verified_at is not null)
  on conflict (booking_id) do nothing;
end $$;
