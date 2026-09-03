import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The Flask dashboard's browser JS. It is being replaced by the App
    // Router pages, not maintained, and it is not written to these rules.
    "flighttracker/static/**",
  ]),
]);

export default eslintConfig;
