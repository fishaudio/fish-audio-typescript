/// <reference types="node" />
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { FishAudioClient, RealtimeEvents } from "../src/index.js";
import { startRealtimeServer, type FakeConnection, type FakeServer } from "./realtimeServer.js";

type Headers = Record<string, string | (() => string | null | undefined | Promise<string | null | undefined>) | null>;

const servers: FakeServer[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(): Promise<FakeServer> {
    const server = await startRealtimeServer(async (connection) => {
        if (!connection.url.endsWith("/v1/asr/realtime")) return;
        await connection.start();
        await connection.until("audio_done");
        connection.done();
    });
    servers.push(server);
    return server;
}

function client(server: FakeServer, headers?: Headers): FishAudioClient {
    return new FishAudioClient({ apiKey: "test-key", baseUrl: server.url, ...(headers ? { headers } : {}) });
}

/** Opens a TTS WebSocket and returns the handshake the server saw. */
async function tts(server: FakeServer, fish: FishAudioClient, headers?: Headers): Promise<FakeConnection> {
    const before = server.connections.length;
    const connection = await fish.textToSpeech.convertRealtime({ text: "" }, [], "s2.1-pro", headers ? { headers } : undefined);
    await new Promise((resolve) => connection.on(RealtimeEvents.OPEN, resolve));
    connection.close();
    return server.connection(before);
}

/** Runs a realtime STT session and returns the handshake the server saw. */
async function stt(server: FakeServer, fish: FishAudioClient, headers?: Headers): Promise<FakeConnection> {
    const before = server.connections.length;
    for await (const _event of fish.speechToText.convertRealtime({}, [], headers ? { headers } : {})) {
        // drain
    }
    return server.connection(before);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TTS WebSocket handshake", () => {
    it("carries the client's headers, calling a supplier once per connection", async () => {
        const server = await serve();
        let calls = 0;
        const fish = client(server, { "X-Static": "static", traceparent: () => `value-${++calls}` });

        const first = await tts(server, fish);
        const second = await tts(server, fish);

        expect(calls).toBe(2);
        expect(first.headerValues("x-static")).toEqual(["static"]);
        expect(first.headerValues("traceparent")).toEqual(["value-1"]);
        expect(second.headerValues("traceparent")).toEqual(["value-2"]);
        expect(first.headerValues("authorization")).toEqual(["Bearer test-key"]);
        expect(first.headerValues("model")).toEqual(["s2.1-pro"]);
    });
});

describe.each([
    ["TTS", tts, "s2.1-pro"],
    ["STT", stt, "transcribe-stream-1"],
] as const)("%s WebSocket per-call headers", (_name, open, model) => {
    it("win over the client's, and null removes a client header", async () => {
        const server = await serve();
        const fish = client(server, { "X-Replaced": "client", "X-Removed": "client" });

        const connection = await open(server, fish, { "X-Replaced": "call", "X-Removed": null, "X-Added": () => "call" });

        expect(connection.headerValues("x-replaced")).toEqual(["call"]);
        expect(connection.headerValues("x-removed")).toEqual([]);
        expect(connection.headerValues("x-added")).toEqual(["call"]);
    });

    it("Authorization and model from the client or the call do not replace the SDK's, and their suppliers are not called", async () => {
        const server = await serve();
        const called: string[] = [];
        const fish = client(server, {
            AUTHORIZATION: () => (called.push("client authorization"), "Bearer client"),
            Model: () => (called.push("client model"), "client-model"),
        });

        const connection = await open(server, fish, {
            authorization: () => (called.push("call authorization"), "Bearer call"),
            MODEL: () => (called.push("call model"), "call-model"),
        });

        expect(called).toEqual([]);
        expect(connection.headerValues("authorization")).toEqual(["Bearer test-key"]);
        expect(connection.headerValues("model")).toEqual([model]);
    });

    it("concurrent connections in different AsyncLocalStorage contexts each carry their own value", async () => {
        const server = await serve();
        const context = new AsyncLocalStorage<string>();
        const fish = client(server, {
            traceparent: async () => {
                await sleep(20);
                return context.getStore();
            },
        });

        await Promise.all([
            context.run("trace-a", () => open(server, fish, { "X-Context": "trace-a" })),
            context.run("trace-b", () => open(server, fish, { "X-Context": "trace-b" })),
        ]);

        const seen = server.connections.map((connection) => ({
            context: connection.headerValues("x-context"),
            traceparent: connection.headerValues("traceparent"),
        }));
        expect(seen.sort((a, b) => String(a.context).localeCompare(String(b.context)))).toEqual([
            { context: ["trace-a"], traceparent: ["trace-a"] },
            { context: ["trace-b"], traceparent: ["trace-b"] },
        ]);
    });
});
