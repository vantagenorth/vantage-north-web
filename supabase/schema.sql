-- Vantage North Normalized Booking & Payment Schema for Supabase
-- Safe / Idempotent: works whether bookings/payments already exist or are brand new.
-- Integrates with existing tables in app.vantagenorth.ae: clients, units, agents, reports.

create extension if not exists "pgcrypto";

-- 1. BOOKINGS (Event & Schedule Data Only)
create table if not exists public.bookings (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.bookings
    add column if not exists booking_reference text unique,
    add column if not exists created_at timestamptz not null default now(),
    add column if not exists updated_at timestamptz not null default now(),
    add column if not exists client_id uuid references public.clients(id) on delete restrict,
    add column if not exists unit_id uuid references public.units(id) on delete set null,
    add column if not exists agent_id uuid references public.agents(id) on delete set null,
    add column if not exists report_id uuid,
    add column if not exists status text not null default 'pending_payment',
    add column if not exists package_type text,
    add column if not exists package_label text,
    add column if not exists price_aed numeric(10, 2),
    add column if not exists inspection_purpose text not null default 'Handover',
    add column if not exists scheduled_date date,
    add column if not exists scheduled_start timestamptz,
    add column if not exists scheduled_end timestamptz,
    add column if not exists timezone text not null default 'Asia/Dubai',
    add column if not exists cal_event_type_id bigint,
    add column if not exists cal_booking_id bigint,
    add column if not exists cal_booking_uid text,
    add column if not exists terms_accepted boolean not null default false,
    add column if not exists terms_accepted_at timestamptz,
    add column if not exists notes text;

-- 2. PAYMENTS (Ziina Transactions)
create table if not exists public.payments (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.payments
    add column if not exists created_at timestamptz not null default now(),
    add column if not exists updated_at timestamptz not null default now(),
    add column if not exists booking_id uuid references public.bookings(id) on delete cascade,
    add column if not exists client_id uuid references public.clients(id) on delete restrict,
    add column if not exists provider text not null default 'ziina',
    add column if not exists ziina_payment_intent_id text unique,
    add column if not exists amount_aed numeric(10, 2),
    add column if not exists amount_fils integer,
    add column if not exists currency text not null default 'AED',
    add column if not exists status text not null default 'pending',
    add column if not exists is_test boolean not null default false,
    add column if not exists checkout_url text,
    add column if not exists paid_at timestamptz,
    add column if not exists raw_response jsonb;

-- Indexes for fast lookups in app.vantagenorth.ae
create index if not exists idx_bookings_client_id on public.bookings(client_id);
create index if not exists idx_bookings_unit_id on public.bookings(unit_id);
create index if not exists idx_bookings_agent_id on public.bookings(agent_id);
create index if not exists idx_bookings_report_id on public.bookings(report_id);
create index if not exists idx_bookings_status on public.bookings(status);
create index if not exists idx_bookings_scheduled_date on public.bookings(scheduled_date);
create index if not exists idx_bookings_scheduled_start on public.bookings(scheduled_start);
create index if not exists idx_payments_booking_id on public.payments(booking_id);
create index if not exists idx_payments_client_id on public.payments(client_id);
create index if not exists idx_payments_status on public.payments(status);
