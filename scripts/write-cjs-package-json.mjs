import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "dist", "cjs", "package.json");

// Root package.json sets "type": "module", so Node would treat dist/cjs/*.js as ESM.
// This nested package.json marks the CJS build as CommonJS for require() consumers.
writeFileSync(outFile, `${JSON.stringify({ type: "commonjs" }, null, 4)}\n`);
