/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { FishAudioClient, FishAudioError, RealtimeEvents, TextToSpeechWebSocket } from "../src/index.js";
import {
    SDK_PRODUCT,
    SDK_USER_AGENT,
    buildUserAgent,
    commentValue,
    detectPlatform,
    osFamily,
    withUserAgent,
} from "../src/core/userAgent.js";
import { VERSION } from "../src/version.js";
import { startRealtimeServer, type FakeServer } from "./realtimeServer.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Every value a request carries for a header name, compared without regard to case. */
function headerValues(request: IncomingMessage, name: string): string[] {
    const values: string[] = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
        if (request.rawHeaders[i]!.toLowerCase() === name) {
            values.push(request.rawHeaders[i + 1]!);
        }
    }
    return values;
}

/**
 * A fake HTTP API that records every request. It answers with `status`
 * (JSON for 2xx and 4xx, audio for `/v1/tts`) and accepts WebSocket upgrades on
 * `/v1/tts/live`, closing each at once.
 */
async function fakeApi(status = 200): Promise<{ url: string; requests: IncomingMessage[] }> {
    const requests: IncomingMessage[] = [];
    const server: Server = createServer((request, response) => {
        requests.push(request);
        request.resume();
        request.on("end", () => {
            response.statusCode = status;
            if (request.url?.startsWith("/v1/tts") && status === 200) {
                response.setHeader("Content-Type", "audio/mpeg");
                response.end(Buffer.from([1, 2, 3]));
                return;
            }
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(status === 200 ? { items: [], total: 0 } : { detail: "nope" }));
        });
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
        requests.push(request);
        wss.handleUpgrade(request, socket, head, (ws) => ws.close(1000));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
        for (const client of wss.clients) client.terminate();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, requests };
}

describe("SDK version", () => {
    it("src/version.ts matches package.json (run `npm run build` or `npm version` to regenerate it)", () => {
        expect(VERSION).toBe(packageJson.version);
    });

    it("the User-Agent product is fish-audio-typescript/<package.json version>", () => {
        expect(SDK_PRODUCT).toBe(`fish-audio-typescript/${packageJson.version}`);
    });

    it("the product is valid RFC 9110 grammar: token \"/\" token", () => {
        expect(SDK_PRODUCT).toMatch(new RegExp(`^${TCHAR}+/${TCHAR}+$`));
    });
});

const TCHAR = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]";
// product RWS comment, with nothing in the comment that RFC 9110 ctext excludes.
const USER_AGENT_GRAMMAR = new RegExp(`^${TCHAR}+/${TCHAR}+ \\([^()\\\\\\x00-\\x1f\\x7f]*\\)$`);

describe("runtime comment", () => {
    it("on Node it names node, its version and the OS family", () => {
        expect(SDK_USER_AGENT).toBe(`${SDK_PRODUCT} (node ${process.versions.node}; ${osFamily(process.platform)})`);
        expect(SDK_USER_AGENT).toMatch(USER_AGENT_GRAMMAR);
    });

    it("uses the shape (<runtime> <version>; <os>)", () => {
        expect(buildUserAgent("bun", "1.2.3", "linux")).toBe(`${SDK_PRODUCT} (bun 1.2.3; linux)`);
        expect(buildUserAgent("deno", "2.1.0", "windows")).toBe(`${SDK_PRODUCT} (deno 2.1.0; windows)`);
        expect(buildUserAgent("workerd", undefined, undefined)).toBe(`${SDK_PRODUCT} (workerd unknown; unknown)`);
    });

    it("normalises the OS to a short lowercase word", () => {
        expect(osFamily("win32")).toBe("windows");
        expect(osFamily("Darwin")).toBe("darwin");
        expect(osFamily("linux")).toBe("linux");
        expect(osFamily("freebsd")).toBe("freebsd");
        expect(osFamily(undefined)).toBe("unknown");
    });

    it("drops anything that could break the comment or identify a machine", () => {
        const hostile = [
            "1.2.3 (evil)",
            "1.2.3)",
            "1.2.3\\(",
            "1.2.3\r\nX-Injected: 1",
            "1.2.3\u0000",
            "1.2.3; host=alice-laptop",
            "1.2.3 /home/alice",
        ];
        for (const value of hostile) {
            expect(commentValue(value)).toBe("1.2.3");
            expect(buildUserAgent("node", value, value)).toMatch(USER_AGENT_GRAMMAR);
        }
        expect(commentValue("(x)")).toBe("unknown");
        expect(commentValue("\\")).toBe("unknown");
        expect(commentValue("")).toBe("unknown");
        expect(commentValue(42)).toBe("unknown");
        expect(commentValue("1".repeat(100))).toBe("1".repeat(32));
    });

    it("detecting the platform never throws, also without process", () => {
        expect(detectPlatform("node", {})).toBeUndefined();
        expect(detectPlatform("bun", { process: {} })).toBeUndefined();
        expect(detectPlatform("deno", { Deno: { build: { os: "linux" } } })).toBe("linux");
        expect(detectPlatform("workerd", { process: { platform: "linux" } })).toBeUndefined();
        const throwing = {
            get process(): never {
                throw new Error("no process here");
            },
        };
        expect(detectPlatform("node", throwing)).toBeUndefined();
    });

    it("a caller's User-Agent comes after the comment", () => {
        expect(withUserAgent({ "User-Agent": "my-app/1.0" })["User-Agent"]).toBe(`${SDK_USER_AGENT} my-app/1.0`);
    });
});

describe("withUserAgent", () => {
    it("adds the token when no User-Agent is set and keeps the other headers", () => {
        expect(withUserAgent({ Authorization: "Bearer k" })).toEqual({
            Authorization: "Bearer k",
            "User-Agent": SDK_USER_AGENT,
        });
    });

    it("appends a caller's User-Agent of any casing, sending one header", () => {
        expect(withUserAgent({ "user-agent": "my-app/1.0" })).toEqual({ "User-Agent": `${SDK_USER_AGENT} my-app/1.0` });
    });

    it("the last spelling wins when several are present", () => {
        expect(withUserAgent({ "User-Agent": "from-client/1", "USER-AGENT": "from-request/2" })).toEqual({
            "User-Agent": `${SDK_USER_AGENT} from-request/2`,
        });
    });

    it("treats an empty or blank value as unset", () => {
        expect(withUserAgent({ "User-Agent": "   " })).toEqual({ "User-Agent": SDK_USER_AGENT });
    });

    it("leaves the headers unchanged in a browser or web worker, where the API's CORS rules would refuse it", () => {
        for (const runtime of ["browser", "web-worker"] as const) {
            expect(withUserAgent({ Authorization: "Bearer k" }, runtime)).toEqual({ Authorization: "Bearer k" });
            expect(withUserAgent({ "User-Agent": "my-app/1.0" }, runtime)).toEqual({ "User-Agent": "my-app/1.0" });
        }
    });

    it("adds it in every server-side runtime", () => {
        for (const runtime of ["node", "bun", "deno", "workerd", "edge-runtime", "react-native", "unknown"] as const) {
            expect(withUserAgent({}, runtime)).toEqual({ "User-Agent": SDK_USER_AGENT });
        }
    });

    it("does not double the token when a value already starts with it", () => {
        expect(withUserAgent({ "User-Agent": SDK_USER_AGENT })).toEqual({ "User-Agent": SDK_USER_AGENT });
        expect(withUserAgent({ "User-Agent": `${SDK_USER_AGENT} my-app/1.0` })).toEqual({
            "User-Agent": `${SDK_USER_AGENT} my-app/1.0`,
        });
    });
});

describe("User-Agent on HTTP requests", () => {
    it("every endpoint sends the token once", async () => {
        const api = await fakeApi();
        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: api.url });

        await client.voices.search();
        await client.voices.get("voice-id");
        await client.user.get_api_credit();
        await client.textToSpeech.convert({ text: "hi" });
        await client.speechToText.convert({ audio: new Blob([Uint8Array.of(1, 2)]) } as never).catch(() => {});

        expect(api.requests.length).toBe(5);
        for (const request of api.requests) {
            expect(headerValues(request, "user-agent"), `${request.method} ${request.url}`).toEqual([SDK_USER_AGENT]);
        }
    });

    it("a client built without FishAudioClient sends it too", async () => {
        const api = await fakeApi();
        const tts = new TextToSpeechWebSocket({ apiKey: "test-key", baseUrl: api.url });

        await tts.convert({ text: "hi" });

        expect(headerValues(api.requests[0]!, "user-agent")).toEqual([SDK_USER_AGENT]);
    });

    it("every retry of a failing request sends it, and the error still surfaces", async () => {
        const api = await fakeApi(500);
        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: api.url });

        await expect(client.voices.search({}, { maxRetries: 1 })).rejects.toBeInstanceOf(FishAudioError);

        expect(api.requests.length).toBe(2);
        for (const request of api.requests) {
            expect(headerValues(request, "user-agent")).toEqual([SDK_USER_AGENT]);
        }
    });

    it("a User-Agent in the client's headers is appended", async () => {
        const api = await fakeApi();
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: api.url,
            headers: { "User-Agent": () => Promise.resolve("my-app/1.0") },
        });

        await client.voices.search();

        expect(headerValues(api.requests[0]!, "user-agent")).toEqual([`${SDK_USER_AGENT} my-app/1.0`]);
    });

    it("a User-Agent in request options replaces the client's one, whatever the casing", async () => {
        const api = await fakeApi();
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: api.url,
            headers: { "User-Agent": "my-app/1.0" },
        });

        await client.voices.search({}, { headers: { "user-agent": "my-script/2.0" } });
        await client.voices.search({}, { headers: { "User-Agent": null } });

        expect(headerValues(api.requests[0]!, "user-agent")).toEqual([`${SDK_USER_AGENT} my-script/2.0`]);
        // null removes the client's value, as it does for any header; the token stays.
        expect(headerValues(api.requests[1]!, "user-agent")).toEqual([SDK_USER_AGENT]);
    });
});

describe("User-Agent on the TTS WebSocket", () => {
    async function handshake(options: ConstructorParameters<typeof FishAudioClient>[0]): Promise<IncomingMessage> {
        const api = await fakeApi();
        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: api.url, ...options });
        const connection = await client.textToSpeech.convertRealtime({ text: "" }, []);
        await new Promise<void>((resolve) => {
            connection.on(RealtimeEvents.CLOSE, () => resolve());
            connection.on(RealtimeEvents.ERROR, () => resolve());
        });
        return api.requests[0]!;
    }

    it("sends the token in the handshake", async () => {
        const request = await handshake({});
        expect(request.url).toBe("/v1/tts/live");
        expect(headerValues(request, "user-agent")).toEqual([SDK_USER_AGENT]);
        expect(headerValues(request, "authorization")).toEqual(["Bearer test-key"]);
        expect(headerValues(request, "model")).toEqual(["s2.1-pro"]);
    });

    it("appends the client's User-Agent and sends the client's other headers", async () => {
        const request = await handshake({ headers: { "user-agent": "my-app/1.0", "X-Other": "x" } });
        expect(headerValues(request, "user-agent")).toEqual([`${SDK_USER_AGENT} my-app/1.0`]);
        expect(headerValues(request, "x-other")).toEqual(["x"]);
    });

    it("a refused handshake still carried it, and the error is emitted", async () => {
        const requests: IncomingMessage[] = [];
        const server = createServer();
        server.on("upgrade", (request, socket) => {
            requests.push(request);
            socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
        const { port } = server.address() as AddressInfo;

        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}` });
        const connection = await client.textToSpeech.convertRealtime({ text: "" }, []);
        const error = await new Promise<unknown>((resolve) => connection.on(RealtimeEvents.ERROR, resolve));

        expect(String(error)).toContain("401");
        expect(headerValues(requests[0]!, "user-agent")).toEqual([SDK_USER_AGENT]);
    });
});

describe("User-Agent on the realtime STT WebSocket", () => {
    const servers: FakeServer[] = [];
    afterEach(async () => {
        await Promise.all(servers.splice(0).map((server) => server.close()));
    });

    it("sends the token, with the client's User-Agent appended", async () => {
        const server = await startRealtimeServer(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });
        servers.push(server);

        for (const headers of [{}, { "USER-AGENT": "my-app/1.0" }]) {
            const client = new FishAudioClient({ apiKey: "test-key", baseUrl: server.url, headers });
            for await (const _ of client.speechToText.convertRealtime({}, [])) {
                // drain
            }
        }

        expect(server.connections[0]!.headerValues("user-agent")).toEqual([SDK_USER_AGENT]);
        expect(server.connections[1]!.headerValues("user-agent")).toEqual([`${SDK_USER_AGENT} my-app/1.0`]);
    });

    it("a refused handshake still carried it", async () => {
        const requests: IncomingMessage[] = [];
        const server = createServer();
        server.on("upgrade", (request, socket) => {
            requests.push(request);
            socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
        const { port } = server.address() as AddressInfo;

        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}` });
        const iterate = async () => {
            for await (const _ of client.speechToText.convertRealtime({}, [])) {
                // drain
            }
        };

        await expect(iterate()).rejects.toThrow();
        expect(headerValues(requests[0]!, "user-agent")).toEqual([SDK_USER_AGENT]);
    });
});
