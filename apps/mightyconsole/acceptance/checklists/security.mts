// Security acceptance (DOC-25 §6), run on the lab with the identity provider (the `idp` profile:
// Dex). Each build task wires its own items; TSK-141 attaches the evidence. Wired so far: "Login and
// sessions" (TSK-136) and "Audit" (TSK-137: the log, its events and the sensitive reads; verify
// and rotation come in its last batch). The parts other tasks own are `manual` checks naming them;
// the built-in accounts item (TSK-142) and the Start, Authorization, Destroy and Secrets sections
// come with their tasks.
import { cargo, command, manual } from "../checklist.mts";
import type { Checklist } from "../checklist.mts";

/** One test of the sign-in conformance cases (`crates/ambidex-conformance/tests/oidc.rs`), built with
 * the WebSocket harness only: the default `tauri` harness needs GTK, which the lab runner lacks. */
const conformance = (label: string, filter: string) =>
  command(`conformance: ${label}`, ["cargo", "test", "-p", "ambidex-conformance", "--no-default-features", "--features", "ws", "--test", "oidc", "--", filter], { requires: ["cargo"] });

export default {
  id: "security",
  task: "TSK-141",
  title: "Security (DOC-25 section 6)",
  builtWhen: "apps/mightyconsole/server/src/config.rs",
  lab: ["idp"],
  items: [
    {
      id: "login",
      text: "(TSK-136) A lab user signs in through the IdP and lands on the page they asked for; the session cookie is new, __Host-, Secure, HttpOnly, SameSite=Strict.",
      lab: true,
      checks: [
        cargo("a_lab_user_signs_in_through_dex_and_out_again", { features: ["lab-tests"], label: "through the lab's Dex" }),
        cargo("each_lab_user_gets_their_own_groups_and_session", { features: ["lab-tests"], label: "groups from Dex" }),
        cargo("a_person_signs_in_uses_the_console_and_signs_out", { label: "the server against the test IdP" }),
        command("in Chrome through Dex: the Lax login cookie, the Strict session after the meta refresh, sign-out", ["node", "apps/mightyconsole/acceptance/sign-in-walk.mts", "{server}", "{evidence}"], { requires: ["node"] }),
        conformance("PKCE, next, cookie attributes", "a_valid_sign_in_lands_on_next_with_a_strict_session"),
      ],
    },
    {
      id: "login-refused",
      text: "(TSK-136) Each is refused with login_error=invalid and an audit entry: a state that does not match, a callback in another browser (no login cookie), a replayed code, a wrong nonce, a wrong audience, a wrong issuer, an expired token, a token signed with none or HS256, a key not in the JWKS.",
      checks: [
        conformance("spoiled ID tokens", "spoiled_id_tokens_are_refused"),
        conformance("state and browser binding", "state_mismatch_and_another_browser_are_refused"),
        conformance("replayed code", "a_replayed_code_is_refused"),
        cargo("a_failed_sign_in_returns_to_the_page_with_its_code"),
        cargo("sign_in_a_refused_sign_in_and_sign_out_are_in_the_audit_log", { label: "the refusal's entry (system:auth, Deny, the error code), and the sign-in and sign-out entries" }),
      ],
    },
    {
      id: "login-keys-idp-down",
      text: "(TSK-136) The JWKS rotates at the IdP and sign-in keeps working; the IdP down gives login_error=unreachable, and the default administrator still signs in with its password.",
      checks: [
        conformance("key rotation", "key_rotation_keeps_sign_in_working"),
        conformance("the IdP down", "the_idp_down_gives_unreachable"),
        conformance("a sign-in during the first fetch", "a_sign_in_during_the_first_fetch_waits_for_it"),
        manual("the default administrator signs in with its password while the IdP is down: TSK-142"),
      ],
    },
    {
      id: "session-expiry",
      text: "(TSK-136) A session idle past the limit, and one past the absolute limit, end: calls fail, open streams end with Goaway, the page shows the expired state.",
      checks: [
        conformance("idle and absolute expiry", "session_idle_and_absolute_expiry"),
        manual("the page shows the expired state: TSK-140 (the UI)"),
      ],
    },
    {
      id: "logout",
      text: "(TSK-136) Sign-out ends the session everywhere (other tabs get Goaway) and goes to the IdP's logout.",
      checks: [
        conformance("every tab, the IdP's logout", "logout_ends_the_session_everywhere_and_goes_to_the_idp"),
        cargo("a_lab_user_signs_in_through_dex_and_out_again", { features: ["lab-tests"], label: "Dex (no end_session_endpoint: back to the base path)" }),
      ],
    },
    {
      id: "revocation",
      text: "(TSK-136) Revoking a session (own and by an administrator) ends its streams at once.",
      checks: [
        conformance("by session and by user", "a_revoked_session_ends_its_connections"),
        manual("app.sessions.revoke and admin.sessions.revoke: TSK-138 (they call the store's revocation, tested here)"),
      ],
    },
    {
      id: "fixation",
      text: "(TSK-136) A cookie from before the sign-in is not accepted after it (fixation).",
      checks: [conformance("fixation", "no_session_fixation")],
    },
    {
      id: "audit-events",
      text: "(TSK-137) A sign-in, a refused call, a write, a destroy with its confirmation, a Secret reveal, a file download, a connect and a role change each leave the entries of 3.5.1, with digests and no values.",
      checks: [
        manual("on the lab's NATS: a connect, a write, a destroy and a download are in the log, which verifies, with no credential in it: runs as the nats checklist's `audit` item (the lab here has only the idp profile)"),
        cargo("a_session_leaves_the_calls_the_spec_lists_and_never_a_value", { label: "the principal chain, tenant, session, correlation id, risk, decision and duration; no secret and no payload in the file" }),
        cargo("the_digest_does_not_depend_on_the_secret", { label: "the digest covers the redacted input" }),
        cargo("sign_in_a_refused_sign_in_and_sign_out_are_in_the_audit_log", { label: "sign-in, refused sign-in, sign-out" }),
        cargo("the_sensitive_reads_are_the_ones_the_spec_names", { label: "the sensitive reads are marked on the procedures, and are the spec's list" }),
        manual("a refused call by role, the destroy confirmation and a role change leave their entries: TSK-138 (the entries are written by the router and the management procedures; the sink keeps every refusal, tested in the unit tests of audit.rs)"),
        manual("a Kubernetes Secret reveal: with the Kubernetes tool (TSK-82), its procedure carries audit = \"always\""),
      ],
    },
    {
      id: "audit-verify",
      text: "(TSK-137) audit verify passes on the lab's log and fails, naming the line, on a copy with an edited line, a deleted line, a cut tail (checkpoint) and a gap across a segment boundary.",
      checks: [
        cargo("a_tampered_log_refuses_the_start_and_names_the_file", { label: "an edited line refuses the start, naming the file" }),
        manual("the audit verify command, the deleted line, the cut tail and the gap across segments: the next batch of TSK-137 (the checkpoint needs the key of TSK-139)"),
      ],
    },
    {
      id: "audit-fail-closed",
      text: "(TSK-137) With the audit directory made unwritable, Write, Destructive and sensitive Read calls are refused with Unavailable; ordinary reads still work.",
      checks: [
        cargo("without_a_writable_log_writes_and_sensitive_reads_are_refused_and_other_reads_run", { label: "a log that refuses entries: a sensitive read is Unavailable, an ordinary read runs" }),
        command("Ambidex: Write and Destructive calls are refused before the handler, a sensitive read fails closed for a human", ["cargo", "test", "-p", "ambidex", "--test", "audit", "--", "a_failing_sink_stops_writes_and_agent_calls_before_the_handler", "a_sensitive_read_fails_closed_for_a_human_and_is_marked_in_the_table"], { requires: ["cargo"] }),
      ],
    },
  ],
} satisfies Checklist;
