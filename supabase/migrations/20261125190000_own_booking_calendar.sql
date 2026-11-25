-- Own booking calendar (Supabase + Google Calendar) instead of Cal.com.
-- Adds things only; nothing existing is changed or removed. Safe to run more than once.

-- 1. The Google Calendar event for each booking made through the new system.
alter table public.bookings
  add column if not exists google_event_id text;

-- 2. No double-booking: two bookings that hold their slot can never overlap in time.
--    needs_reschedule bookings are left out on purpose (their time already went to
--    someone else), as are cancelled ones. If two paid bookings race for one slot,
--    the second is saved as needs_reschedule instead of being lost.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_no_overlap') then
    alter table public.bookings
      add constraint bookings_no_overlap
      exclude using gist (tstzrange(scheduled_start, scheduled_end, '[)') with &&)
      where (status in ('confirmed', 'cancelling')
             and scheduled_start is not null
             and scheduled_end is not null);
  end if;
end $$;

-- 3. Andy's Google Calendar sign-in. Only the website's server (service role) can read it.
create table if not exists public.google_calendar_auth (
  id text primary key default 'default',
  account_email text not null,
  refresh_token text not null,
  scope text,
  updated_at timestamptz not null default now()
);
alter table public.google_calendar_auth enable row level security;
revoke all on public.google_calendar_auth from anon, authenticated;
