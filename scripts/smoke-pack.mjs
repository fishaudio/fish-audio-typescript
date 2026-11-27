// Installs a tarball the way a user does, then checks it from a consumer's side:
// it loads from CommonJS and from ESM, and a TypeScript consumer type-checks
// against it under both module systems.
// Usage: node scripts/smoke-pack.mjs [tarball path or URL]   (default: npm pack of this checkout)
// Run `npm ci` first: the type check uses this checkout's TypeScript and @types/node.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "fish-audio-smoke-"));
const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });

// What a consumer writes. Kept to the public surface: the client, TTS, and realtime STT.
const usage = `
const client = new FishAudioClient({ apiKey: "key" });
const request: TTSRequest = { text: "Hello", format: "mp3" };

export async function main(): Promise<void> {
    const audio = await client.textToSpeech.convert(request, "s2.1-pro");
    await play(audio);
    const stream = client.speechToText.convertRealtime({ diarize: false }, [new Uint8Array(1280)]);
    try {
        for await (const event of stream) {
            const typed: RealtimeSTTEvent = event;
            if (typed.type === "committed") console.log(typed.text);
        }
    } catch (error) {
        if (error instanceof RealtimeSTTError) console.log(error.closeCode);
    }
}
`;

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
        console.log(`ok    node ${file}`);
    }

    // .cts resolves the package's "require" types, .mts its "import" types.
    // skipLibCheck is off so that a type the package needs but does not ship fails here.
    writeFileSync(
        join(dir, "types.cts"),
        `import fishAudio = require("fish-audio");\nimport type { RealtimeSTTEvent, TTSRequest } from "fish-audio";\nconst { FishAudioClient, RealtimeSTTError, play } = fishAudio;\n${usage}`,
    );
    writeFileSync(
        join(dir, "types.mts"),
        `import { FishAudioClient, RealtimeSTTError, play } from "fish-audio";\nimport type { RealtimeSTTEvent, TTSRequest } from "fish-audio";\n${usage}`,
    );
    writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: {
                module: "nodenext",
                target: "es2022",
                strict: true,
                noEmit: true,
                skipLibCheck: false,
                types: ["node"],
                typeRoots: [join(root, "node_modules", "@types")],
            },
            include: ["types.cts", "types.mts"],
        }),
    );
    run("node", [join(root, "node_modules", "typescript", "bin", "tsc"), "--project", dir]);
    console.log("ok    tsc --noEmit types.cts types.mts");
} catch (error) {
    console.error(`${error.stdout ?? ""}${error.stderr ?? ""}` || error.message);
    process.exitCode = 1;
} finally {
    rmSync(dir, { recursive: true, force: true });
}
