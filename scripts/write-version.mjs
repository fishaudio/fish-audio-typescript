import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// The version goes into the User-Agent as a product-version, which RFC 9110
// defines as a token: no spaces, slashes or other separators.
if (typeof version !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(version)) {
    throw new Error(`package.json version ${JSON.stringify(version)} is not a valid User-Agent token`);
}
const outFile = join(root, "src", "version.ts");

// The SDK reports this version in its User-Agent. It lives in src/ because tsc
// only compiles src/ (rootDir), so the ESM and CJS builds both get it; the build
// and `npm version` rewrite it, and tests/version.test.ts fails if it drifts.
const content =
    "// Generated from package.json by scripts/write-version.mjs. Do not edit by hand.\n" +
    `export const VERSION = ${JSON.stringify(version)};\n`;

let current;
try {
    current = readFileSync(outFile, "utf8");
} catch {
    current = undefined;
}
if (current !== content) {
    writeFileSync(outFile, content);
}
