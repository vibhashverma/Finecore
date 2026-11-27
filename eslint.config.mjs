// Root ESLint flat config shared by all TypeScript packages.
// apps/web extends this with Next.js rules in its own config.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Folders where money is handled. Floats are banned here (ADR-001). */
const MONEY_PATHS = [
  "**/src/**/ledger/**",
  "**/src/**/transfers/**",
  "**/src/**/payments/**",
  "**/src/**/refunds/**",
  "**/src/**/calculations/**",
  "**/src/**/money/**",
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/node_modules/**",
      "services/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "error",
    },
  },
  {
    files: MONEY_PATHS,
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "No floats for money (ADR-001). Use Money/bigint." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='Number']",
          message: "No Number() for money (ADR-001). Use Money/bigint.",
        },
        {
          selector: "CallExpression[callee.property.name='toFixed']",
          message: "No toFixed() for money (ADR-001). Use formatMoney().",
        },
        {
          selector: "MemberExpression[object.name='Number'][property.name='parseFloat']",
          message: "No floats for money (ADR-001).",
        },
      ],
    },
  },
);
