-- Schema `wide` with 10,000 tables for the schema-tree budget (DOC-18 section 1), created in
-- transactions of 500 tables so the lock table holds.
CREATE SCHEMA wide;
DO $$
BEGIN
  FOR i IN 1..10000 LOOP
    EXECUTE format(
      'CREATE TABLE wide.%I (id int8, name text, amount numeric(12,2), created timestamptz, payload jsonb)',
      'table_' || lpad(i::text, 5, '0'));
    IF i % 500 = 0 THEN
      COMMIT;
    END IF;
  END LOOP;
END
$$;
