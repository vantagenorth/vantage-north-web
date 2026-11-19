-- Vantage North Normalized Booking, Property, Report & Payment Schema for Supabase
-- Safe / Idempotent: works whether tables already exist or are brand new.

create extension if not exists "pgcrypto";

-- 1. DEVELOPERS
create table if not exists public.developers (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    name text not null unique
);

-- 2. AREAS
create table if not exists public.areas (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    name text not null unique
);

-- 3. PROJECTS
create table if not exists public.projects (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    name text not null,
    area_id uuid references public.areas(id) on delete set null,
    developer_id uuid references public.developers(id) on delete set null
);

alter table public.projects
    add column if not exists area_id uuid references public.areas(id) on delete set null,
    add column if not exists developer_id uuid references public.developers(id) on delete set null;

-- 4. UNITS
create table if not exists public.units (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unit_number text not null
);

alter table public.units
    add column if not exists unit_number text,
    add column if not exists project_id uuid references public.projects(id) on delete set null,
    add column if not exists area_id uuid references public.areas(id) on delete set null,
    add column if not exists developer_id uuid references public.developers(id) on delete set null,
    add column if not exists client_id uuid references public.clients(id) on delete set null,
    add column if not exists property_type text,
    add column if not exists bedroom_tier text,
    add column if not exists address text,
    add column if not exists dewa_connected boolean default true,
    add column if not exists access_instructions text;

-- 5. AGENTS
create table if not exists public.agents (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    full_name text not null
);

alter table public.agents
    add column if not exists full_name text,
    add column if not exists agency text,
    add column if not exists email text,
    add column if not exists phone text;

-- 6. BOOKINGS (Event & Schedule Data Only)
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
    add column if not exists scheduled_date date,
    add column if not exists scheduled_start timestamptz,
    add column if not exists scheduled_end timestamptz,
    add column if not exists timezone text not null default 'Asia/Dubai',
    add column if not exists terms_accepted boolean not null default false,
    add column if not exists terms_accepted_at timestamptz,
    add column if not exists notes text;

-- 7. REPORTS (Created upon booking & payment confirmation; stores 'type' = Handover / Secondary purchase / Move out)
create table if not exists public.reports (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.reports
    add column if not exists booking_id uuid references public.bookings(id) on delete set null,
    add column if not exists client_id uuid references public.clients(id) on delete set null,
    add column if not exists unit_id uuid references public.units(id) on delete set null,
    add column if not exists type text not null default 'Handover',
    add column if not exists status text not null default 'pending';

-- Link bookings.report_id -> reports(id) safely if not already linked
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'fk_bookings_report'
    ) then
        alter table public.bookings
            add constraint fk_bookings_report
            foreign key (report_id) references public.reports(id) on delete set null;
    end if;
end $$;

-- 8. PAYMENTS (Ziina Transactions)
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

-- Indexes for app.vantagenorth.ae
create index if not exists idx_bookings_client_id on public.bookings(client_id);
create index if not exists idx_bookings_unit_id on public.bookings(unit_id);
create index if not exists idx_bookings_agent_id on public.bookings(agent_id);
create index if not exists idx_bookings_report_id on public.bookings(report_id);
create index if not exists idx_bookings_status on public.bookings(status);
create index if not exists idx_bookings_scheduled_date on public.bookings(scheduled_date);
create index if not exists idx_bookings_scheduled_start on public.bookings(scheduled_start);
create index if not exists idx_reports_booking_id on public.reports(booking_id);
create index if not exists idx_reports_unit_id on public.reports(unit_id);
create index if not exists idx_payments_booking_id on public.payments(booking_id);
create index if not exists idx_payments_client_id on public.payments(client_id);
create index if not exists idx_payments_status on public.payments(status);

-- Auto-update updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

do $$
declare
    t text;
begin
    foreach t in array array['clients', 'units', 'bookings', 'reports', 'payments']
    loop
        execute format('drop trigger if exists trg_%I_updated_at on public.%I;', t, t);
        execute format('create trigger trg_%I_updated_at before update on public.%I for each row execute function public.set_updated_at();', t, t);
    end loop;
end $$;

-- Row Level Security (blocks anonymous browser access; service_role & authenticated staff retain access)
do $$
declare
    t text;
begin
    foreach t in array array['developers', 'areas', 'projects', 'units', 'agents', 'clients', 'bookings', 'reports', 'payments']
    loop
        execute format('alter table public.%I enable row level security;', t);
        execute format('drop policy if exists "Authenticated staff full access" on public.%I;', t);
        execute format('create policy "Authenticated staff full access" on public.%I for all to authenticated using (true) with check (true);', t);
    end loop;
end $$;
