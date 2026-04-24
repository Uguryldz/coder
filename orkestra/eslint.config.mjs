// @ts-check
import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "apps/studio/.next/**",
      "packages/db/prisma/migrations/**",
      "**/node_modules/.prisma/**",
      "**/generated/**",
      "**/next-env.d.ts",
      "packages/db/prisma/**",
      // Studio has its own Next.js ESLint config (react-hooks plugin, etc.).
      // Skip here to avoid plugin-not-found errors and let Next's lint handle it.
      "apps/studio/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
      unicorn,
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      // Kept as WARN on day one — lots of existing intentional unused exports/signals.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Downgraded to warn so day-one CI passes; tighten to error later.
      "@typescript-eslint/consistent-type-imports": "warn",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      // Downgraded to warn on day one — some existing duplicate-import false positives
      // (e.g. workspace pkg resolved to node_modules/*). Tighten to error later.
      "import/no-duplicates": "warn",
      "import/order": "warn",
      // no-cycle is expensive and can be noisy on first enablement; downgraded to warn.
      "import/no-cycle": "warn",
      "unicorn/prevent-abbreviations": "off",
      // Downgraded to warn on day one — existing `crypto` imports can be migrated gradually.
      "unicorn/prefer-node-protocol": "warn",
      // Avoid crashes from rules defined by plugins we don't load here.
      "react-hooks/exhaustive-deps": "off",
      // Next.js generates this; keep off at the rule level too in case ignore is overridden.
      "@typescript-eslint/triple-slash-reference": "warn",
      "@typescript-eslint/await-thenable": "warn",
      "no-empty": "warn",
      // Relaxed for day-one CI pass on existing code; tighten later.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/require-await": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      "@typescript-eslint/unbound-method": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/prefer-promise-reject-errors": "warn",
      "prefer-const": "warn",
    },
  },
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/tests/**/*.ts",
      "**/tests/**/*.tsx",
      "**/__tests__/**/*.ts",
      "**/__tests__/**/*.tsx",
    ],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "no-console": "off",
    },
  },
);
