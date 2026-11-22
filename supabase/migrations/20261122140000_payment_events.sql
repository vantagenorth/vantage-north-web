-- Payment event log: an append-only record of every Ziina call, webhook,
-- booking confirmation and Cal.com step, so failures can be traced later.
--
-- Rows are never updated. Rows older than 12 months are deleted by the daily
-- pg_cron job at the bottom of this file, and that is the only delete allowed.

create table if not exists public.payment_events (
    id bigint generated always as identity primary key,
    created_at timestamptz not null default now(),
    -- Where the event happened: checkout, ziina_webhook, confirm, finalize, cal, cal_webhook, health
    source text not null,
    -- What happened, e.g. ziina.intent_created, hold.save_failed, cal.booking_failed
    event text not null,
    level text not null default 'info' check (level in ('info', 'warn', 'error')),
    booking_reference text,
    ziina_payment_intent_id text,
    http_status integer,
    ziina_status text,
    message text,
    -- Key fields only (ids, statuses, amounts, error messages). Never full API bodies.
    details jsonb
);

create index if not exists idx_payment_events_created_at on public.payment_events(created_at desc);
create index if not exists idx_payment_events_booking_reference on public.payment_events(booking_reference);
create index if not exists idx_payment_events_intent_id on public.payment_events(ziina_payment_intent_id);
create index if not exists idx_payment_events_level on public.payment_events(level, created_at desc);
create index if not exists idx_payment_events_event on public.payment_events(event, created_at desc);

-- Append-only: block updates, and block deletes of anything newer than 12 months.
create or replace function public.payment_events_append_only()
returns trigger
language plpgsql
as $$
begin
    if tg_op = 'UPDATE' then
        raise exception 'payment_events is append-only: updates are not allowed';
    end if;
    if tg_op = 'DELETE' and old.created_at > now() - interval '12 months' then
        raise exception 'payment_events is append-only: only rows older than 12 months can be deleted';
    end if;
    return old;
end;
$$;

drop trigger if exists trg_payment_events_append_only on public.payment_events;
create trigger trg_payment_events_append_only
    before update or delete on public.payment_events
    for each row execute function public.payment_events_append_only();

-- RLS: the website writes with the service role. Signed-in staff can read only.
alter table public.payment_events enable row level security;
drop policy if exists "Authenticated staff read access" on public.payment_events;
create policy "Authenticated staff read access" on public.payment_events
    for select to authenticated using (true);

-- Retention: every day at 03:15 Dubai time (23:15 UTC), delete events older than 12 months.
do $$
begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.unschedule(jobid) from cron.job where jobname = 'payment-events-retention';
        perform cron.schedule(
            'payment-events-retention',
            '15 23 * * *',
            $job$delete from public.payment_events where created_at < now() - interval '12 months'$job$
        );
    end if;
end $$;
