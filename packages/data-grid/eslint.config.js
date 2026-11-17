// Design-token guardrails (spec section 9a.4): see packages/lint/README.md.
import byterygon from "@byterygon/lint/eslint";

export default [{ ignores: ["dist/**"] }, ...byterygon.configs.recommended];
