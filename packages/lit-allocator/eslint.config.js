import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Always brace control-flow bodies so the body lives on its own line,
      // e.g. `if (cond) {\n  doThing();\n}` instead of `if (cond) doThing();`.
      curly: ["error", "all"],
      "nonblock-statement-body-position": ["error", "below"],
    },
  },
  {
    // Lit Action source — runs inside the TEE with `Lit.Actions.*` available.
    files: ["src/vm/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
        Lit: "readonly",
      },
    },
  },
  {
    files: ["test/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.es2022 },
    },
  },
);
