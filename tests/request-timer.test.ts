/// <reference types="node" />
/**
 * A request that fails must not keep the process alive. The request timeout is
 * a timer; if it is left running after `fetch` rejects, a script that has
 * nothing else to do still waits for it (240 s by default) before it exits.
 * A test runner hides this, so the SDK runs in a separate Node process.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { getEventListeners } from "node:events";
import { createServer, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FishAudioClient, FishAudioError } from "../src/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Far below the timeouts used in the scripts (60 s and the 240 s default), far
// above what a failed request and Node's shutdown take, also on a busy machine.
const MUST_EXIT_WITHIN_MS = 20_000;

let dir: string;
let bundle: string;
let scripts = 0;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fish-audio-timer-"));
    bundle = join(dir, "sdk.cjs");
    // The SDK source as one CommonJS file; its packages resolve through NODE_PATH.
    await build({
        entryPoints: [join(ROOT, "src/index.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        packages: "external",
        outfile: bundle,
        logLevel: "silent",
    });
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

/** Runs `body` (CommonJS, inside an async function; `sdk` is the SDK) in a new Node process. */
async function run(body: string): Promise<{ exited: boolean; code: number | null; stdout: string; stderr: string }> {
    const file = join(dir, `script-${scripts++}.cjs`);
    await writeFile(
        file,
        `const sdk = require(${JSON.stringify(bundle)});
const net = require("node:net");
/** A port nothing listens on. */
async function closedPort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}
(async () => {
${body}
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
`,
    );
    return new Promise((done, fail) => {
        const child = spawn(process.execPath, [file], {
            env: { ...process.env, NODE_PATH: join(ROOT, "node_modules"), NODE_OPTIONS: "" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let exited = true;
        const kill = setTimeout(() => {
            exited = false;
            child.kill("SIGKILL");
        }, MUST_EXIT_WITHIN_MS);
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", fail);
        child.on("close", (code) => {
            clearTimeout(kill);
            done({ exited, code, stdout, stderr });
        });
    });
}

describe("the request timeout does not outlive the request", () => {
    it("a refused connection lets the process exit, with the default timeout", async () => {
        const result = await run(`
    const client = new sdk.FishAudioClient({ apiKey: "key", baseUrl: "http://127.0.0.1:" + (await closedPort()) });
    try {
        await client.user.get_api_credit({ maxRetries: 0 });
        console.log("no error");
    } catch (error) {
        console.log("failed:", error instanceof sdk.FishAudioError);
    }
`);
        expect(result.stdout.trim(), result.stderr).toBe("failed: true");
        expect(result.exited, "the process was still alive and had to be killed").toBe(true);
        expect(result.code).toBe(0);
    }, 60_000);

    it("a refused connection lets the process exit, with a timeout set per call", async () => {
        const result = await run(`
    const client = new sdk.FishAudioClient({ apiKey: "key", baseUrl: "http://127.0.0.1:" + (await closedPort()) });
    for (const call of [
        () => client.user.get_api_credit({ maxRetries: 0, timeoutInSeconds: 60 }),
        () => client.textToSpeech.convert({ text: "hi" }, "s1", { maxRetries: 0, timeoutInSeconds: 60 }),
    ]) {
        try {
            await call();
            console.log("no error");
        } catch (error) {
            console.log("failed:", error instanceof sdk.FishAudioError);
        }
    }
`);
        expect(result.stdout.trim().split("\n"), result.stderr).toEqual(["failed: true", "failed: true"]);
        expect(result.exited, "the process was still alive and had to be killed").toBe(true);
        expect(result.code).toBe(0);
    }, 60_000);

    it("a request aborted by the caller lets the process exit", async () => {
        const result = await run(`
    const http = require("node:http");
    // Accepts the request and never answers.
    const server = http.createServer(() => {});
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new sdk.FishAudioClient({ apiKey: "key", baseUrl: "http://127.0.0.1:" + server.address().port });
    const controller = new AbortController();
    server.on("request", () => controller.abort());
    try {
        await client.user.get_api_credit({ maxRetries: 0, abortSignal: controller.signal });
        console.log("no error");
    } catch (error) {
        console.log("failed:", error instanceof sdk.FishAudioError);
    }
    server.closeAllConnections();
    server.close();
`);
        expect(result.stdout.trim(), result.stderr).toBe("failed: true");
        expect(result.exited, "the process was still alive and had to be killed").toBe(true);
        expect(result.code).toBe(0);
    }, 60_000);

    it("a successful request still lets the process exit", async () => {
        const result = await run(`
    const http = require("node:http");
    const server = http.createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new sdk.FishAudioClient({ apiKey: "key", baseUrl: "http://127.0.0.1:" + server.address().port });
    await client.user.get_api_credit({ maxRetries: 0 });
    console.log("ok");
    server.closeAllConnections();
    server.close();
`);
        expect(result.stdout.trim(), result.stderr).toBe("ok");
        expect(result.exited, "the process was still alive and had to be killed").toBe(true);
        expect(result.code).toBe(0);
    }, 60_000);
});

describe("a caller's abort signal reused across requests", () => {
    /** A port nothing listens on. */
    async function closedPort(): Promise<number> {
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address() as { port: number };
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return port;
    }

    it("keeps no listener for a request that failed", async () => {
        const client = new FishAudioClient({ apiKey: "key", baseUrl: `http://127.0.0.1:${await closedPort()}` });
        const controller = new AbortController();
        for (let i = 0; i < 25; i++) {
            await expect(
                client.user.get_api_credit({ maxRetries: 0, abortSignal: controller.signal }),
            ).rejects.toBeInstanceOf(FishAudioError);
        }
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    });

    it("still aborts a request that is waiting for its response", async () => {
        // Accepts connections and never answers.
        const sockets: Socket[] = [];
        const server = createServer((socket) => {
            sockets.push(socket);
            socket.on("error", () => {});
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address() as { port: number };
        try {
            const client = new FishAudioClient({ apiKey: "key", baseUrl: `http://127.0.0.1:${port}` });
            const controller = new AbortController();
            server.once("connection", () => controller.abort());
            await expect(
                client.user.get_api_credit({ maxRetries: 0, abortSignal: controller.signal }),
            ).rejects.toThrow("The user aborted a request");
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        } finally {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
