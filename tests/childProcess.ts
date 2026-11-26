/// <reference types="node" />
/**
 * Runs a script against the SDK in a separate Node process, for behaviour a
 * test runner hides: an unhandled rejection, which ends a plain Node process
 * (exit code 1) but which the runner catches and reports on its own.
 *
 * The SDK source is bundled once with esbuild (a dependency of tsup) into a
 * CommonJS file; its packages (`ws`, ...) stay external and resolve from this
 * repository's node_modules through NODE_PATH.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface ChildSdk {
    /** Runs `script` (CommonJS; `sdk` is the bundled SDK) in a new Node process. */
    run(script: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
    close(): Promise<void>;
}

export async function childSdk(): Promise<ChildSdk> {
    const dir = await mkdtemp(join(tmpdir(), "fish-audio-child-"));
    const bundle = join(dir, "sdk.cjs");
    await build({
        entryPoints: [join(ROOT, "src/index.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        packages: "external",
        outfile: bundle,
        logLevel: "silent",
    });
    let count = 0;
    return {
        async run(script) {
            const file = join(dir, `script-${count++}.cjs`);
            await writeFile(file, `const sdk = require(${JSON.stringify(bundle)});\n${script}`);
            return new Promise((done, fail) => {
                const child = spawn(process.execPath, [file], {
                    env: { ...process.env, NODE_PATH: join(ROOT, "node_modules"), NODE_OPTIONS: "" },
                    stdio: ["ignore", "pipe", "pipe"],
                });
                let stdout = "";
                let stderr = "";
                child.stdout.on("data", (chunk) => (stdout += chunk));
                child.stderr.on("data", (chunk) => (stderr += chunk));
                child.on("error", fail);
                child.on("close", (code) => done({ code, stdout, stderr }));
            });
        },
        close: () => rm(dir, { recursive: true, force: true }),
    };
}
