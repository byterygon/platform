// The signed-out page (DOC-25 §3.2.5): it goes to the server's sign-in with where it was, or shows
// why the last sign-in failed.
import { describe, expect, it } from "vitest";
import { renderSignInFailure, signInState } from "@/app/sign-in";

function page(metas: Record<string, string>): Document {
  const doc = document.implementation.createHTMLDocument("t");
  for (const [name, content] of Object.entries(metas)) {
    const meta = doc.createElement("meta");
    meta.name = name;
    meta.content = content;
    doc.head.append(meta);
  }
  return doc;
}

describe("signInState", () => {
  it("is on without the signed-out meta", () => {
    expect(signInState(page({}), new URL("https://mc.test/nats"))).toEqual({ kind: "signed-in" });
    expect(signInState(page({ "mightyconsole-auth": "signed-in" }), new URL("https://mc.test/"))).toEqual({ kind: "signed-in" });
  });

  it("goes to the sign-in with the place it was, under the base path", () => {
    const doc = page({ "mightyconsole-auth": "signed-out", "mightyconsole-base": "/tools/mc" });
    const state = signInState(doc, new URL("https://mc.test/tools/mc/nats/dev?x=1#top"));
    expect(state).toEqual({ kind: "redirect", to: `/tools/mc/auth/login?next=${encodeURIComponent("/tools/mc/nats/dev?x=1#top")}` });
  });

  it("shows a failure with a retry that drops the error", () => {
    const doc = page({ "mightyconsole-auth": "signed-out", "mightyconsole-idp": "Acme SSO" });
    const state = signInState(doc, new URL("https://mc.test/?login_error=unreachable"));
    expect(state).toEqual({
      kind: "failed",
      message: "The identity provider cannot be reached. Try again in a moment.",
      retry: `/auth/login?next=${encodeURIComponent("/")}`,
      idp: "Acme SSO",
    });
    const root = document.createElement("div");
    if (state.kind !== "failed") throw new Error("failed");
    renderSignInFailure(root, state);
    expect(root.textContent).toContain("Sign in with Acme SSO");
    expect(root.querySelector("a")?.getAttribute("href")).toBe(state.retry);
    const unknown = signInState(doc, new URL("https://mc.test/?login_error=<script>"));
    expect(unknown.kind === "failed" && unknown.message).toBe("The sign-in failed. Try again.");
  });
});
