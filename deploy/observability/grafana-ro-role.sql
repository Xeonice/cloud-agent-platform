-- Read-only Postgres role for the Grafana "Postgres-Audit" datasource
-- (observability-stack Tier 2). Grafana queries audit_events IN PLACE; it must
-- never mutate. Run once against the cap database (psql -U cap -d cap -f ...),
-- substituting a strong password that matches GRAFANA_PG_PASSWORD in Grafana's env.
--
-- Idempotent-ish: re-running ALTERs the password / re-grants.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
    CREATE ROLE grafana_ro LOGIN PASSWORD 'CHANGE_ME';
  END IF;
END
$$;

-- Connect + schema usage, SELECT only on the audit table (NOT the whole schema —
-- least privilege; widen explicitly if a future panel needs another table).
GRANT CONNECT ON DATABASE cap TO grafana_ro;
GRANT USAGE ON SCHEMA public TO grafana_ro;
GRANT SELECT ON TABLE public.audit_events TO grafana_ro;

-- Ensure the role can never write, even if granted more later by accident.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM grafana_ro;
