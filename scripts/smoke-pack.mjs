// Installs a tarball the way a user does, then loads it from CommonJS and from ESM.
// Usage: node scripts/smoke-pack.mjs [tarball path or URL]   (default: npm pack of this checkout)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "fish-audio-smoke-"));
const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });

try {
    const arg = process.argv[2];
    let tarball = arg && (/^https?:/.test(arg) ? arg : resolve(arg));
    if (!tarball) {
        const [{ filename }] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", dir], root));
        tarball = join(dir, filename);
    }
    writeFileSync(join(dir, "package.json"), "{}");
    run("npm", ["install", "--no-audit", "--no-fund", tarball]);
    writeFileSync(join(dir, "consumer.cjs"), "require('fish-audio').FishAudioClient.name;\n");
    writeFileSync(join(dir, "consumer.mjs"), "(await import('fish-audio')).FishAudioClient.name;\n");
    for (const file of ["consumer.cjs", "consumer.mjs"]) {
        run("node", [file]);
        console.log(`ok    ${file}`);
    }
} catch (error) {
    console.error(`${error.stderr ?? error.message}`);
    process.exitCode = 1;
} finally {
    rmSync(dir, { recursive: true, force: true });
}
