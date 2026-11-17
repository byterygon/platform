// The Temporal tool's pure parts (Mightyconsole spec §9): the profile schema and its connect input,
// the status chips' rewriting of a visibility query, and the formats of the workflow table.
import { describe, expect, test } from "vitest";
import type { ConnectTemporalProfile } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { formatDuration, formatTime } from "@/tools/temporal/format";
import { namespaceOf, pageSizeOf, profile, savedQueriesOf, tlsOf, validateAddress } from "@/tools/temporal/profile";
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
    expect(connect(r)).toEqual({ name: "lab", address: "127.0.0.1:7233", namespace: "default", tls: { enabled: false }, clientKeyPem: null, apiKey: null });
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
});
