-- Vantage North Normalized Booking & Payment Schema for Supabase
-- Designed to integrate with existing tables in app.vantagenorth.ae:
--   clients, units, developers, agents, reports
-- Run this in your Supabase SQL Editor

create extension if not exists "pgcrypto";

-- 1. BOOKINGS (Event & Schedule Data Only)
create table if not exists public.bookings (
    id uuid primary key default gen_random_uuid(),
    booking_reference text not null unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- Foreign Keys to your core tables
    client_id uuid not null references public.clients(id) on delete restrict,
    unit_id uuid references public.units(id) on delete set null,
    agent_id uuid references public.agents(id) on delete set null,
    report_id uuid, -- link to reports(id) once inspection report is generated

    -- Booking Status & Package
    status text not null default 'pending_payment' check (status in ('pending_payment', 'confirmed', 'completed', 'cancelled', 'quote_requested')),
    package_type text not null check (package_type in ('initial', 'initial_followup', 'initial_final', 'full_bundle', 'custom_quote')),
    package_label text not null,
    price_aed numeric(10, 2),
    inspection_purpose text not null default 'Handover' check (inspection_purpose in ('Handover', 'Secondary purchase', 'Move out')),

    -- Event Date & Time (Cal.com Sync)
    scheduled_date date,
    scheduled_start timestamptz,
    scheduled_end timestamptz,
    timezone text not null default 'Asia/Dubai',
    cal_event_type_id bigint,
    cal_booking_id bigint,
    cal_booking_uid text,

    -- Compliance & Notes
    terms_accepted boolean not null default false,
    terms_accepted_at timestamptz,
    notes text
);

-- 2. PAYMENTS (Ziina Transactions)
create table if not exists public.payments (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    booking_id uuid not null references public.bookings(id) on delete cascade,
    client_id uuid not null references public.clients(id) on delete restrict,

    provider text not null default 'ziina',
    ziina_payment_intent_id text unique,
    amount_aed numeric(10, 2) not null,
    amount_fils integer not null,
    currency text not null default 'AED',
    status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'cancelled', 'refunded')),
    is_test boolean not null default false,
    checkout_url text,
    paid_at timestamptz,
    raw_response jsonb
);

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
