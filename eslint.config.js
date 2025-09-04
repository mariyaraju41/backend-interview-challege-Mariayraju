const globals = require("globals");
const tseslint = require("typescript-eslint");

module.exports = [
  {
    languageOptions: { globals: { ...globals.node } },
  },
  ...tseslint.configs.recommended,
];
