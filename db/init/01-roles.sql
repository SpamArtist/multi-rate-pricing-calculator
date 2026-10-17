CREATE ROLE pricing_migrator LOGIN PASSWORD 'pricing_migrator' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE pricing_runtime LOGIN PASSWORD 'pricing_runtime' NOSUPERUSER NOBYPASSRLS;
ALTER DATABASE pricing OWNER TO pricing_migrator;
REVOKE ALL ON DATABASE pricing FROM PUBLIC;
GRANT CONNECT ON DATABASE pricing TO pricing_migrator, pricing_runtime;
