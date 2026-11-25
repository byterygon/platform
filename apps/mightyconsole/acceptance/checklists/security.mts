// Security acceptance (DOC-25 §6), run on the lab with the identity provider (the `idp` profile:
// Dex). Each build task wires its own items; TSK-141 attaches the evidence. Wired so far: "Login and
// sessions" (TSK-136), "Audit" (TSK-137: the log, its events, the sensitive reads, verify and
// rotation, and the checkpoint with the key of TSK-139), the built-in accounts and the default
// administrator (TSK-142), Authorization and Destroy (TSK-138), and from TSK-139 the keys of the
// secret store (the Start item about them, rotation). The parts other tasks own are
// `manual` checks naming them; the rest of the Start section (TSK-141) and the Secrets section come
// with their tasks. Until TSK-139 moves profiles to the server, every connection is the caller's
// own (DOC-25 Open question 22): what roles do on shared profiles is proved by the server's tests,
// and on the lab once shared profiles exist.
import { cargo, command, manual, vitest } from "../checklist.mts";
import type { Checklist } from "../checklist.mts";

/** One test of the sign-in conformance cases (`crates/ambidex-conformance/tests/oidc.rs`), built with
 * the WebSocket harness only: the default `tauri` harness needs GTK, which the lab runner lacks. */
const conformance = (label: string, filter: string) =>
  command(`conformance: ${label}`, ["cargo", "test", "-p", "ambidex-conformance", "--no-default-features", "--features", "ws", "--test", "oidc", "--", filter], { requires: ["cargo"] });

/** One of the built-in account cases (`crates/ambidex-conformance/tests/accounts.rs`, TSK-142). */
const accounts = (label: string, filter: string) =>
  command(`conformance: ${label}`, ["cargo", "test", "-p", "ambidex-conformance", "--no-default-features", "--features", "ws", "--test", "accounts", "--", filter], { requires: ["cargo"] });

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
        cargo("the_default_administrator_signs_in_while_the_idp_is_down", { label: "the default administrator signs in with its password while the IdP is down" }),
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
        cargo("sessions_are_listed_and_revoked_own_and_by_an_administrator", { label: "app.sessions.revoke and admin.sessions.revoke (TSK-138)" }),
      ],
    },
    {
      id: "fixation",
      text: "(TSK-136) A cookie from before the sign-in is not accepted after it (fixation).",
      checks: [conformance("fixation", "no_session_fixation"), accounts("fixation, a password sign-in", "signing_in_replaces_the_previous_session")],
    },
    {
      id: "accounts",
      text: "(TSK-142) Built-in accounts: sign-up gives a member who can add and use a personal profile and sees no shared one until added to a group; a wrong password and an unknown user get the same answer; five failures lock the account and the audit says so; TOTP sign-in works, a reused code is refused, a recovery code works once; a setup link works once and expires; a sign-in POST from another origin is refused; auth.signup = off hides and refuses sign-up.",
      checks: [
        cargo("sign_up_signs_in_a_member_who_can_work", { label: "sign-up through the page's token, the session, app.me, sign-out; auth.signup, auth.login, auth.logout in the log without the password" }),
        manual("a member adds and uses a personal profile and sees no shared one until added to a group: TSK-138 and TSK-139 (roles, server-side profiles)"),
        accounts("the same answer and the same cost", "wrong_password_and_unknown_user_look_the_same"),
        accounts("five failures lock the account (the lockout event), and it ends", "five_failures_lock_the_account_for_fifteen_minutes"),
        cargo("a_session_leaves_the_calls_the_spec_lists_and_never_a_value", { label: "the audit entries' format (auth.lockout and auth.signup go through the same event log)" }),
        accounts("TOTP: the code once, drift", "totp_sign_in_needs_the_code_once"),
        accounts("a recovery code works once", "a_recovery_code_works_once"),
        accounts("wrong codes lock; pending sign-ins end", "wrong_codes_lock_and_pending_sign_ins_end"),
        accounts("a setup link works once and expires", "setup_links_work_once_and_expire"),
        accounts("a cross-site POST is refused", "cross_site_posts_are_refused"),
        cargo("signup_off_hides_and_refuses_sign_up", { label: "auth.signup = off on the server" }),
        cargo("the_default_administrator_must_change_its_password_first", { label: "mustChangePassword: only the change and app.me, then everything" }),
      ],
    },
    {
      id: "default-admin",
      text: "(TSK-142, Start) A first start creates the default administrator and DATA/admin-password (0600); the log names the path and not the password; the first sign-in forces a new password and the file disappears. reset-admin works with the server stopped and running, ends the administrator's sessions and unlocks it.",
      checks: [
        cargo("first_start_then_reset_admin_running_and_stopped", { label: "the built binary: first start, reset-admin running and stopped, auth.admin.reset in the log" }),
        cargo("the_default_administrator_must_change_its_password_first", { label: "the forced change deletes the file" }),
        cargo("a_reset_sets_a_new_password_and_lifts_everything", { label: "unlock, enable, remove TOTP" }),
        cargo("default_admin_off_refuses_the_start_and_the_reset", { label: "auth.default_admin = false" }),
      ],
    },
    {
      id: "start-keys",
      text: "(TSK-139) A key file with mode 0644, a wrong passphrase, a failing key command, and a store entry whose key is missing each refuse the start with their own message.",
      checks: [
        cargo("a_key_file_with_mode_0644_refuses_the_start", { label: "a key file with mode 0644" }),
        cargo("a_wrong_passphrase_refuses_the_start", { label: "a wrong passphrase" }),
        cargo("a_failing_key_command_refuses_the_start", { label: "a failing key command" }),
        cargo("a_secret_whose_key_is_missing_refuses_the_start", { label: "a stored entry whose key is missing" }),
        cargo("a_first_start_generates_a_key_and_says_where", { label: "a first start generates the key (0600) and says where, never what" }),
      ],
    },
    {
      id: "secrets-rotation",
      text: "(TSK-139) After a key rotation (SIGHUP) every profile still connects, and the old key can be removed.",
      checks: [
        cargo("sighup_rotates_to_a_new_key_and_the_old_one_can_then_go", { label: "SIGHUP: a reload without the old key is refused; with the new key first every entry moves (secrets.rewrap start and end); then the old key goes" }),
        cargo("rotation_with_calls_running_loses_nothing", { label: "rotation with calls running, and a restart half way (the job resumes)" }),
        manual("every profile still connects after the rotation: with profiles on the server (TSK-139, a later batch)"),
      ],
    },
    {
      id: "secrets-shared",
      text: "(TSK-139) A viewer connects with a shared profile whose password they never saw.",
      checks: [
        cargo("a_viewer_uses_a_shared_profile_whose_password_they_never_see", { label: "a viewer sees and may use a shared profile, its secrets' status but never their values; a member without the tool's read sees nothing" }),
        cargo("a_personal_profile_is_its_owners_alone_and_its_secret_is_never_answered", { label: "a personal profile is its owner's alone; no answer holds a value; the value is not in store.redb in clear" }),
        manual("the viewer's connection runs with the stored password: connect by profile reference (TSK-139, the next batch)"),
      ],
    },
    {
      id: "secrets-target",
      text: "(TSK-139) Changing a shared profile's host without re-entering the password removes it.",
      checks: [
        cargo("a_viewer_uses_a_shared_profile_whose_password_they_never_see", { label: "a changed host removes the password (removedSecrets), the registry's token stays; set again in the same call it is kept" }),
        cargo("a_changed_target_unbinds_the_secrets_of_its_group_only", { label: "each tool's target fields and the secrets they guard" }),
      ],
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
        cargo("a_refusal_by_role_and_a_role_change_are_in_the_audit_log", { label: "a refusal by role and a role change (TSK-138)" }),
        manual("the destroy confirmation: the nats checklist's `audit` item (TSK-138 checks there the refusal with its approval id and the confirmation)"),
        manual("a Kubernetes Secret reveal: with the Kubernetes tool (TSK-82), its procedure carries audit = \"always\""),
      ],
    },
    {
      id: "audit-verify",
      text: "(TSK-137) audit verify passes on the lab's log and fails, naming the line, on a copy with an edited line, a deleted line, a cut tail (checkpoint) and a gap across a segment boundary.",
      checks: [
        cargo("a_tampered_log_refuses_the_start_and_names_the_file", { label: "an edited line refuses the start, naming the file" }),
        cargo("audit_verify_passes_on_a_log_of_many_segments_and_names_each_kind_of_break", { label: "the audit verify command on a copy: intact (0), an edited line, a deleted line and a missing segment (1, naming file and line), nothing to check (2)" }),
        cargo("the_server_rotates_its_log_and_a_new_chain_follows_a_broken_one", { label: "the server rotates its log; --audit-new-chain moves a broken log aside and the new chain names it" }),
        command("audit-jsonl: segments, a gap across a boundary, retention with its anchor, the size limit and a full log", ["cargo", "test", "-p", "audit-jsonl"], { requires: ["cargo"] }),
        cargo("a_log_cut_at_its_end_is_found_by_the_checkpoint", { label: "a log cut at its end: audit verify and the start find it through the checkpoint (TSK-139)" }),
        command("audit-jsonl: the checkpoint (a cut tail, a forged checkpoint, another key, rotation)", ["cargo", "test", "-p", "audit-jsonl", "--test", "segments", "--", "checkpoint"], { requires: ["cargo"] }),
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
    {
      id: "authz-roles",
      text: "(TSK-138) A viewer can browse every tool but cannot write, exec or read container files (PermissionDenied naming the permission). An operator can write and exec but cannot destroy or reveal a Kubernetes Secret. An administrator can destroy, after the confirmation.",
      checks: [
        cargo("every_built_in_role_on_every_tool", { label: "every built-in role against procedures of every tool" }),
        cargo("without_profiles_personal_the_roles_bind_on_browser_profiles", { label: "over the wire: PermissionDenied names the permission, the target and the reason" }),
        cargo("the_right_phrase_allows_the_same_call_once", { label: "the destroy confirmation" }),
        cargo("the_idp_groups_decide_what_each_lab_user_may_do", { features: ["lab-tests"], label: "lab users through Dex: an administrator, a viewer and a user with no role, by their groups" }),
        manual("viewer, operator and administrator signed in through the lab's IdP on a shared profile: TSK-139 (shared profiles on the server; until then every connection is the caller's own)"),
      ],
    },
    {
      id: "authz-scope",
      text: "(TSK-138) A role limited to one Temporal namespace (and one Kubernetes namespace when TSK-82 lands) is refused in another, and in a cluster-wide list.",
      checks: [
        cargo("scopes_limit_a_role_to_profiles_and_namespaces", { label: "inside, outside, the whole profile, no target" }),
        command("the scope matcher (security-types)", ["cargo", "test", "-p", "security-types", "--lib", "--", "scope::"], { requires: ["cargo"] }),
        manual("a lab user whose group maps to a role limited to one Temporal namespace: TSK-139 (a scope names a profile stored on the server)"),
      ],
    },
    {
      id: "authz-no-role",
      text: "(TSK-138) A user with no role signs in and can do nothing but app.me.",
      checks: [
        cargo("a_user_without_a_role_can_only_see_who_they_are"),
      ],
    },
    {
      id: "authz-personal",
      text: "(TSK-138) A viewer who adds a personal profile with their own credentials can write, exec and destroy (after the confirmation) through it; another user, an administrator included, cannot see or connect with it; saving it with a kubeconfig exec plugin is refused without profiles.hostAccess.",
      checks: [
        cargo("a_browser_held_profile_is_the_callers_own"),
        cargo("a_stored_personal_profile_is_its_owners_alone"),
        cargo("a_member_has_every_right_on_their_own_connection"),
        manual("host-access fields need profiles.hostAccess when a profile is saved: TSK-139 (profiles.create and update)"),
      ],
    },
    {
      id: "authz-role-change",
      text: "(TSK-138) Removing a user's role revokes their sessions; the last administrator cannot be removed.",
      checks: [
        cargo("an_administrator_assigns_roles_and_a_lost_permission_ends_the_session"),
        cargo("the_last_administrator_cannot_be_removed"),
        cargo("custom_roles_and_group_mappings", { label: "custom roles, group mappings with an etag, local groups" }),
        cargo("accounts_are_made_reset_and_deleted_by_an_administrator", { label: "accounts made with a setup link, reset, unlocked, deleted after the confirmation" }),
      ],
    },
    {
      id: "authz-completeness",
      text: "(TSK-138) The completeness test fails for a procedure without a permission, a target or a confirmation subject (a test fixture).",
      checks: [
        cargo("the_fixture_catches_each_gap"),
        cargo("every_procedure_is_protected", { label: "the real API passes" }),
      ],
    },
    {
      id: "destroy",
      text: "(TSK-138) A Destructive call without a confirmation gets ApprovalRequired; a wrong phrase, an expired challenge, a reused challenge, another session's challenge and a changed input are each refused; the right phrase lets the same call through once.",
      checks: [
        cargo("the_right_phrase_allows_the_same_call_once", { label: "wrong phrases, a changed input, target or action; the right phrase once" }),
        cargo("another_session_or_principal_cannot_see_or_answer_it"),
        cargo("challenges_expire_pending_and_confirmed"),
        cargo("a_destroy_needs_a_confirmed_challenge_even_on_ones_own_connection", { label: "the Authorizer: no destroy without a confirmed challenge, used once" }),
        cargo("containers_are_listed_acted_on_and_their_logs_split_by_stream", { label: "over the wire: a Docker remove answered and sent again" }),
        vitest("test/confirmations.test.tsx"),
      ],
    },
  ],
} satisfies Checklist;
