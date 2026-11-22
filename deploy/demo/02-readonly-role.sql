-- Create a genuine read-only role for DataChat demo sandbox verification.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'datachat_ro') THEN
    CREATE ROLE datachat_ro LOGIN PASSWORD 'datachat_ro_demo';
  END IF;
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO datachat_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO datachat_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO datachat_ro;
