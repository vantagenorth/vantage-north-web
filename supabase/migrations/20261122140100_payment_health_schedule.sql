-- Runs the website's payment health check every 5 minutes.
--
-- The check (api/payment-health.js) emails an alert when a payment went
-- through but no booking was created, and clears out abandoned checkout holds.
--
-- Before applying, store the shared secret in Supabase Vault. It must match the
-- CRON_SECRET environment variable in Vercel:
--
--   select vault.create_secret('<same value as CRON_SECRET>', 'payment_health_cron_secret');
--
-- The URL below is the production site. Change it here if the domain changes.

do $$
begin
    if exists (select 1 from pg_extension where extname = 'pg_cron')
       and exists (select 1 from pg_extension where extname = 'pg_net') then
        perform cron.unschedule(jobid) from cron.job where jobname = 'payment-health-check';
        perform cron.schedule(
            'payment-health-check',
            '*/5 * * * *',
            $job$
            select net.http_post(
                url := 'https://vantagenorth.ae/api/payment-health',
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'Authorization', 'Bearer ' || (
                        select decrypted_secret from vault.decrypted_secrets
                        where name = 'payment_health_cron_secret' limit 1
                    )
                ),
                body := '{}'::jsonb,
                timeout_milliseconds := 30000
            );
            $job$
        );
    end if;
end $$;
