-- bench_rows, 1,000,000 x 10: the same definition as the TSK-36 benchmark
-- (crates/ambidex-bench/src/pg.rs), so the numbers compare with DOC-16.
CREATE TABLE bench_rows AS SELECT
    n::int8 AS id,
    CASE WHEN n % 10 = 3 THEN NULL ELSE (n % 100000)::int4 END AS qty,
    (n % 32000)::int2 AS level,
    n * 0.37::float8 AS score,
    (n % 1000)::float4 / 8 AS ratio,
    'user-' || (n % 5000) AS name,
    CASE WHEN n % 5 = 0 THEN NULL ELSE md5(n::text) || md5((n + 1)::text) END AS note,
    TIMESTAMPTZ '2020-01-01 00:00:00+00' + n * INTERVAL '37 seconds' AS created,
    DATE '2000-01-01' + (n % 10000)::int AS day,
    CASE WHEN n % 20 = 7 THEN NULL ELSE n % 3 = 0 END AS flag
FROM generate_series(0, 999999) AS n;
ANALYZE bench_rows;
-- As in TSK-36: scans start at the first page (no synchronized scans).
ALTER DATABASE postgres SET synchronize_seqscans = off;
