import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated output, at any depth. Compiled bundles and emitted .d.ts files
    // are not source and cannot be fixed in place -- linting them reports
    // thousands of problems against code nobody wrote. These were previously
    // excluded only by `--ignore-pattern dist` on the `pnpm lint` command line,
    // which does not reach `services/*/dist`, so a bare `eslint .` disagreed
    // with the gate CI runs. Declaring it here makes both agree.
    "**/dist/**",
    "**/.next/**",
  ]),
  {
    rules: {
      // Rest-sibling destructuring is how this repository omits a property, and
      // in at least one place that omission is a security control: serializing
      // a connection strips `staticCredentials` so cleartext material cannot
      // reach persisted state. The discarded binding is the point, not an
      // oversight, so it must not read as a lint warning inviting "cleanup".
      // `_`-prefixed bindings follow the same intent everywhere else.
      "@typescript-eslint/no-unused-vars": ["warn", {
        args: "after-used",
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
      }],
    },
  },
]);

export default eslintConfig;
