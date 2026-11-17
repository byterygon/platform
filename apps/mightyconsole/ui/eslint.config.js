// Design-token guardrails (spec section 9a.4): see packages/lint/README.md.
import byterygon from "@byterygon/lint/eslint";

export default [
  { ignores: ["dist/**"] },
  ...byterygon.configs.recommended,
  {
    // Byterygon UI keeps its react-hooks directives for projects that run
    // eslint-plugin-react-hooks; this repository does not, so the rule is a stub here and
    // unused directives are not reported.
    plugins: { "react-hooks": { rules: { "exhaustive-deps": { create: () => ({}) } } } },
    rules: { "react-hooks/exhaustive-deps": "off" },
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
];
