// Security acceptance (DOC-25 §6), run on the lab with the identity provider (the `idp` profile:
// Dex). Each build task wires its own items; TSK-141 attaches the evidence. Wired so far: "Login and
// sessions" (TSK-136). The parts other tasks own are `manual` checks naming them; the built-in
// accounts item (TSK-142) and the Start, Authorization, Destroy, Secrets and Audit sections come
// with their tasks.
import { cargo, command, manual } from "../checklist.mts";
import type { Checklist } from "../checklist.mts";

/** One test file of the sign-in conformance cases (`crates/ambidex-conformance/tests/oidc.rs`). */
const conformance = (label: string, filter: string) =>
  command(`conformance: ${label}`, ["cargo", "test", "-p", "ambidex-conformance", "--test", "oidc", "--", filter], { requires: ["cargo"] });

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
        manual("the audit entry of each refusal: TSK-137 (until then the reason is a line in the server log)"),
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
  ],
} satisfies Checklist;
