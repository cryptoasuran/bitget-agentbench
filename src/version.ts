import { readFileSync } from "node:fs";

/**
 * The package version, read once from package.json. Single source of truth so a
 * scorecard and the CLI can never drift from the version that produced them.
 *
 * tsup bundles each entry to dist/<name>.js, so at runtime import.meta.url is
 * the built file in dist/ and ../package.json is the package root, which ships
 * in every tarball. Under vitest the source runs from src/, where ../ is the
 * project root, so it resolves to the same package.json.
 */
export const VERSION: string = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
