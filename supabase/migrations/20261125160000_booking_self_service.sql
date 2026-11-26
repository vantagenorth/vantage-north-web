-- Self-service reschedule and cancel pages (reschedule.vantagenorth.ae / cancel.vantagenorth.ae).
-- Adds columns only; nothing existing is changed or removed. Safe to run more than once.

alter table public.bookings
  add column if not exists original_scheduled_start timestamptz,  -- first booked start, kept across reschedules
  add column if not exists reschedule_count integer not null default 0,
  add column if not exists last_rescheduled_at timestamptz,
  add column if not exists last_rescheduled_by text,             -- 'customer' (our page) or 'cal.com'
  add column if not exists non_refundable boolean not null default false, -- rescheduled inside 24h (terms, Policy s.2)
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by text,                    -- 'customer' (our page) or 'cal.com'
  add column if not exists cancellation_reason text,
  add column if not exists refund_status text,                   -- none | processing | refunded | manual_required | needs_review
  add column if not exists refund_amount_aed numeric(10, 2),
  add column if not exists ziina_refund_id text,
  add column if not exists refunded_at timestamptz;

create index if not exists idx_bookings_refund_status on public.bookings(refund_status)
  where refund_status is not null;

-- Referral void rule: also void when a payment goes to refund_pending, and when it
-- moves on from refund_pending to refunded. Otherwise identical to the existing trigger.
create or replace function public.payment_referral_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'paid' and coalesce(old.status, '') <> 'paid' and new.booking_id is not null then
    perform create_referral_for_booking(new.booking_id);
  elsif new.status in ('refunded','refund_pending','failed','cancelled')
        and coalesce(old.status, '') in ('paid','refund_pending')
        and new.status is distinct from old.status then
    update referrals set status = 'void', void_reason = 'payment ' || new.status
     where payment_id = new.id and status in ('pending','approved');
  end if;
  return new;
end $$;
