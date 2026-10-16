/**
 * Compatibility wrapper for the retired live-environment test.
 * Preferred entrypoint: npm test (builds and runs all offline regressions).
 * This entrypoint runs the equivalent isolated suites against the current dist/.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));
console.error("[test_openai_extensions.mjs] Running isolated compatibility suites. Use npm test for the full build and test run.");

try {
  execFileSync(process.execPath, ["--test","test/extensions.test.mjs","test/app-tools.test.mjs"], {
    cwd: projectRoot,
    stdio: "inherit",
  });
} catch (error) {
  // execFileSync throws for nonzero exits; preserve the test runner status.
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    process.exitCode = error.status;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
