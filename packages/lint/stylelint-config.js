// The recommended Stylelint config of @byterygon/lint: `extends: ["@byterygon/lint/stylelint-config"]`.
export default {
  // A disable must say why (`-- <reason>`) and must disable something.
  reportDescriptionlessDisables: true,
  reportNeedlessDisables: true,
  plugins: ["@byterygon/lint/stylelint"],
  rules: {
    "byterygon/no-raw-color": true,
    "byterygon/no-off-scale-spacing": true,
    "byterygon/no-arbitrary-value": true,
  },
};
