// The Temporal tool's pure parts (Mightyconsole spec §9): the profile schema and its connect input,
// the status chips' rewriting of a visibility query, and the formats of the workflow table.
import { describe, expect, test } from "vitest";
import type { ConnectTemporalProfile } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { formatDuration, formatShortTime, formatTime } from "@/tools/temporal/format";
import { codecEndpointOf, namespaceOf, pageSizeOf, profile, savedQueriesOf, tlsOf, validateAddress } from "@/tools/temporal/profile";
import { STATUS_CHIPS, statusOf, withStatus } from "@/tools/temporal/query";

const connect = (r: ProfileRecord) => profile.toConnect(r) as ConnectTemporalProfile;

function record(patch: Partial<ProfileRecord> = {}): ProfileRecord {
  return { id: "01T", tool: "temporal", version: 1, name: "lab", createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z", ...profile.defaults(), ...patch };
}

describe("profile (spec §9.1)", () => {
  test("a new profile is valid and points at a local dev server", () => {
    const r = record();
    expect(profile.validate(r)).toEqual({});
    expect(r.fields).toMatchObject({ address: "127.0.0.1:7233", namespace: "default", pageSize: 50, tls: { enabled: false } });
    expect(connect(r)).toEqual({ name: "lab", profileId: "01T", codecServer: null, codec: null, codecAuthorization: null, address: "127.0.0.1:7233", namespace: "default", tls: { enabled: false }, clientKeyPem: null, apiKey: null, externalStorage: null, s3AccessKeyId: null, s3SecretAccessKey: null, s3SessionToken: null });
  });

  test("addresses are host:port", () => {
    for (const ok of ["127.0.0.1:7233", "localhost:7233", "temporal.example.com:443", "[::1]:7233", "ns.a1b2c.tmprl.cloud:7233"]) expect(validateAddress(ok), ok).toBeNull();
    for (const bad of ["", "localhost", "http://localhost:7233", "host:0", "host:70000", "host:port", "two words:7233"]) expect(validateAddress(bad), bad).not.toBeNull();
  });

  test("fields are checked one by one", () => {
    const errors = profile.validate(record({ fields: { address: "nope", namespace: "  ", pageSize: 5000, tls: { enabled: false } } }));
    expect(Object.keys(errors).sort()).toEqual(["address", "namespace", "pageSize"]);
    // Empty text means the default, as the server reads it.
    expect(profile.validate(record({ fields: { address: "", tls: { enabled: false } } }))).toEqual({});
  });

  test("an API key is only for TLS, a client certificate needs its key and the key its certificate", () => {
    const withKey = record({ secrets: { apiKey: "k" } });
    expect(profile.validate(withKey)["tls"]).toMatch(/TLS/);
    expect(profile.validate(record({ fields: { ...withKey.fields, tls: { enabled: true } }, secrets: { apiKey: "k" } }))).toEqual({});
    const cert = { enabled: true, clientCertPem: "-----BEGIN CERTIFICATE-----" };
    expect(profile.validate(record({ fields: { tls: cert } }))["tls"]).toMatch(/private key/);
    expect(profile.validate(record({ fields: { tls: { enabled: true } }, secrets: { clientKeyPem: "k" } }))["tls"]).toMatch(/certificate/);
    expect(profile.validate(record({ fields: { tls: cert }, secrets: { clientKeyPem: "k" } }))).toEqual({});
  });

  test("connect carries the TLS options only when TLS is on, and secrets only when set", () => {
    const off = connect(record({ fields: { tls: { enabled: false, caPem: "ignored" } } }));
    expect(off.tls).toEqual({ enabled: false });
    const on = connect(
      record({ fields: { address: " tc:7233 ", namespace: "prod", tls: { enabled: true, caPem: "CA", serverName: "tc" } }, secrets: { apiKey: "secret", clientKeyPem: "" } }),
    );
    expect(on).toMatchObject({ address: "tc:7233", namespace: "prod", tls: { enabled: true, caPem: "CA", clientCertPem: null, serverName: "tc" }, apiKey: "secret", clientKeyPem: null });
  });

  test("External Storage (TSK-103) needs a bucket and sends its keys only when on", () => {
    const fields = { tls: { enabled: false }, externalStorage: { enabled: true, bucket: "", endpoint: "minio:9000", thresholdBytes: 0 } };
    expect(Object.keys(profile.validate(record({ fields }))).sort()).toEqual(["externalStorage.bucket", "externalStorage.endpoint", "externalStorage.thresholdBytes"]);
    const on = connect(
      record({
        fields: { tls: { enabled: false }, externalStorage: { enabled: true, bucket: " payloads ", endpoint: "http://127.0.0.1:8333", pathStyle: true, readBuckets: "old, older\nother" } },
        secrets: { s3AccessKeyId: "AK", s3SecretAccessKey: "SK" },
      }),
    );
    expect(on.externalStorage).toMatchObject({ enabled: true, bucket: "payloads", endpoint: "http://127.0.0.1:8333", pathStyle: true, readBuckets: ["old", "older", "other"], region: null });
    expect(on).toMatchObject({ s3AccessKeyId: "AK", s3SecretAccessKey: "SK", s3SessionToken: null });
    const off = connect(record({ fields: { tls: { enabled: false }, externalStorage: { enabled: false, bucket: "b" } }, secrets: { s3AccessKeyId: "AK" } }));
    expect(off).toMatchObject({ externalStorage: null, s3AccessKeyId: null });
  });

  test("the codec endpoint (TSK-103) needs External Storage and well-formed origins", () => {
    const ext = { enabled: true, bucket: "b" };
    expect(profile.validate(record({ fields: { tls: { enabled: false }, codecServer: { enabled: true } } }))["codecServer"]).toMatch(/External Storage/);
    expect(profile.validate(record({ fields: { tls: { enabled: false }, externalStorage: ext, codecServer: { enabled: true, allowedOrigins: "localhost:8233" } } }))["codecServer.allowedOrigins"]).toMatch(/scheme/);
    const on = connect(record({ fields: { tls: { enabled: false }, externalStorage: ext, codecServer: { enabled: true } } }));
    expect(on.codecServer).toEqual({ enabled: true, allowedOrigins: ["http://localhost:8233", "http://127.0.0.1:8233"] });
    expect(on.profileId).toBe("01T");
    expect(codecEndpointOf("https://localhost:7443/", "01T")).toBe("https://localhost:7443/codec/01T");
  });

  test("the payload codec (spec §9.5): https with its CA or localhost http, per-namespace lines, the secret only when on", () => {
    const base = { tls: { enabled: false } };
    const errors = (codec: Record<string, unknown>) => Object.keys(profile.validate(record({ fields: { ...base, codec: { enabled: true, ...codec } } }))).sort();
    expect(errors({ endpoint: "" })).toEqual(["codec.endpoint"]);
    expect(errors({ endpoint: "http://codec.internal:8888" })).toEqual(["codec.endpoint"]);
    expect(errors({ endpoint: "https://codec.internal:8888" })).toEqual(["codec.caPem"]);
    expect(errors({ endpoint: "http://127.0.0.1:8234", namespaces: "payments" })).toEqual(["codec.namespaces"]);
    expect(errors({ endpoint: "http://127.0.0.1:8234", namespaces: "payments → http://localhost:8235\nbilling http://localhost:8236" })).toEqual([]);
    const on = connect(record({ fields: { ...base, codec: { enabled: true, endpoint: " http://127.0.0.1:8234 ", namespaces: "payments http://localhost:8235", encodeInputs: false } }, secrets: { codecAuthorization: "Bearer t" } }));
    expect(on.codec).toEqual({ enabled: true, endpoint: "http://127.0.0.1:8234", namespaces: [{ namespace: "payments", endpoint: "http://localhost:8235" }], caPem: null, sendNamespace: true, encodeInputs: false, timeoutMs: null });
    expect(on.codecAuthorization).toBe("Bearer t");
    expect(connect(record({ fields: base, secrets: { codecAuthorization: "Bearer t" } })).codecAuthorization).toBeNull();
  });

  test("readers tolerate hand-edited records", () => {
    expect(tlsOf({ tls: "yes" })).toEqual({ enabled: false });
    expect(namespaceOf(record({ fields: {} }))).toBe("default");
    expect(pageSizeOf(record({ fields: { pageSize: "many" } }))).toBe(50);
    expect(pageSizeOf(record({ fields: { pageSize: 200 } }))).toBe(200);
    expect(savedQueriesOf({ savedQueries: [{ name: "failed", query: 'ExecutionStatus = "Failed"' }, { name: "", query: "x" }, 7, { name: "n" }] })).toEqual([{ name: "failed", query: 'ExecutionStatus = "Failed"' }]);
    expect(savedQueriesOf({})).toEqual([]);
  });
});

describe("status chips (spec §9.3)", () => {
  test("a chip sets, replaces and removes the ExecutionStatus clause", () => {
    expect(withStatus("", "Running")).toBe('ExecutionStatus = "Running"');
    expect(withStatus('WorkflowType = "Order"', "Failed")).toBe('ExecutionStatus = "Failed" AND WorkflowType = "Order"');
    expect(withStatus('ExecutionStatus = "Running" AND WorkflowType = "Order"', "Completed")).toBe('ExecutionStatus = "Completed" AND WorkflowType = "Order"');
    expect(withStatus('WorkflowType = "Order" AND ExecutionStatus = "Running"', null)).toBe('WorkflowType = "Order"');
    expect(withStatus('ExecutionStatus = "Running"', null)).toBe("");
  });

  test("the active chip is read from the query, whatever the case or quotes", () => {
    expect(statusOf('ExecutionStatus = "Failed"')).toBe("Failed");
    expect(statusOf("executionstatus='timedout' AND x = 1")).toBe("TimedOut");
    expect(statusOf('WorkflowType = "Order"')).toBeNull();
    expect(statusOf('ExecutionStatus = "Nonsense"')).toBeNull();
  });

  test("every chip round-trips", () => {
    for (const s of STATUS_CHIPS) expect(statusOf(withStatus("", s))).toBe(s);
    expect(STATUS_CHIPS).toHaveLength(7);
  });
});

describe("formats", () => {
  test("durations keep the two largest units", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(200_000)).toBe("3m 20s");
    expect(formatDuration(3_600_000 + 5_000)).toBe("1h 5s");
    expect(formatDuration(86_400_000 + 4 * 3_600_000 + 60_000)).toBe("1d 4h");
    expect(formatDuration(-1)).toBe("");
  });

  test("times are local and empty when absent or invalid", () => {
    expect(formatTime(undefined)).toBe("");
    expect(formatTime("not a time")).toBe("");
    expect(formatTime("2026-11-18T01:02:03Z", "en-US")).toMatch(/2026/);
  });

  test("table times are short: the time today, the day this year, the year before", () => {
    const now = new Date(2026, 10, 18, 12, 0, 0);
    expect(formatShortTime(new Date(2026, 10, 18, 10, 39, 30).toISOString(), now)).toBe("10:39:30");
    expect(formatShortTime(new Date(2026, 10, 17, 9, 5, 0).toISOString(), now)).toBe("17 Nov, 09:05");
    expect(formatShortTime(new Date(2025, 0, 2, 9, 5, 0).toISOString(), now)).toBe("2 Jan 2025");
    expect(formatShortTime(undefined, now)).toBe("");
    expect(formatShortTime("nope", now)).toBe("");
  });
});
