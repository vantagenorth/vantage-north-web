-- Vantage North Booking & Payment Schema for Supabase
-- Tables: clients, bookings, payments
-- Run this in your Supabase SQL Editor

create extension if not exists "pgcrypto";

-- 1. CLIENTS
create table if not exists public.clients (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    full_name text not null,
    email text not null unique,
    phone text,
    client_type text not null default 'owner_buyer' check (client_type in ('owner_buyer', 'agent', 'property_manager')),
    company_or_agency text,
    source text not null default 'website_booking'
);

-- 2. BOOKINGS
create table if not exists public.bookings (
    id uuid primary key default gen_random_uuid(),
    booking_reference text not null unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    client_id uuid not null references public.clients(id) on delete restrict,
    status text not null default 'pending_payment' check (status in ('pending_payment', 'confirmed', 'completed', 'cancelled', 'quote_requested')),

    -- Property & Package
    property_type text not null check (property_type in ('Apartment', 'Townhouse', 'Villa')),
    bedroom_tier text not null,
    bua_sqft integer,
    package_type text not null check (package_type in ('initial', 'initial_followup', 'initial_final', 'full_bundle', 'custom_quote')),
    package_label text not null,
    price_aed numeric(10, 2),

    -- Unit & Handover Details
    inspection_purpose text not null default 'Handover',
    project_name text not null,
    area_community text not null,
    unit_number text not null,
    address text,
    developer text,
    dewa_connected boolean not null default true,
    access_instructions text,

    -- Agent / Referral Details (optional)
    agent_name text,
    agent_agency text,
    agent_email text,
    agent_phone text,

    -- Cal.com Schedule Sync
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

-- 3. PAYMENTS
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
create index if not exists idx_bookings_status on public.bookings(status);
create index if not exists idx_bookings_scheduled_start on public.bookings(scheduled_start);
create index if not exists idx_payments_booking_id on public.payments(booking_id);
create index if not exists idx_payments_status on public.payments(status);
