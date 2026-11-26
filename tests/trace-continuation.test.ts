/// <reference types="node" />
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { FishAudioClient, RealtimeEvents, type HeaderProvider } from "../src/index.js";
import {
    checkTraceContinued,
    resetTraceContinuationWarning,
    traceIdOf,
} from "../src/core/traceContinuation.js";
import { FakeConnection } from "./realtimeServer.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const OTHER_ID = "0af7651916cd43dd8448eb211c80319c";

/** The trace id the gateway uses: the sent one if exactly one valid traceparent came, else a new one. */
function gatewayTraceId(rawHeaders: string[]): string {
    const sent: string[] = [];
    for (let i = 0; i < rawHeaders.length; i += 2) {
        if (rawHeaders[i]!.toLowerCase() === "traceparent") sent.push(rawHeaders[i + 1]!);
    }
    const id = sent.length === 1 ? traceIdOf(sent[0]!) : undefined;
    return id ?? randomBytes(16).toString("hex");
}

interface Gateway {
    url: string;
    requests: IncomingMessage[];
    /** "gateway" mimics Fish Audio; a string is always answered; "none" sends no x-fish-trace-id. */
    traceId: "gateway" | "none" | string;
    /** HTTP statuses for the next requests, in order; 200 once they run out. */
    statuses: number[];
    /** Refuse WebSocket handshakes with this status. */
    refuse?: number;
}

const cleanups: Array<() => Promise<void>> = [];
let warnings: MockInstance<typeof process.emitWarning>;

beforeEach(() => {
    resetTraceContinuationWarning();
    warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});
afterEach(async () => {
    vi.restoreAllMocks();
    resetTraceContinuationWarning();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function traceWarnings(): string[] {
    return warnings.mock.calls
        .filter(([, options]) => (options as { type?: string } | undefined)?.type === "FishAudioTraceWarning")
        .map(([message]) => String(message));
}

/** A fake Fish Audio API: HTTP endpoints, the TTS and STT WebSockets, and `x-fish-trace-id` on every response. */
async function startGateway(): Promise<Gateway> {
    const gateway: Gateway = { url: "", requests: [], traceId: "gateway", statuses: [] };
    const answer = (request: IncomingMessage): string | undefined =>
        gateway.traceId === "none"
            ? undefined
            : gateway.traceId === "gateway"
              ? gatewayTraceId(request.rawHeaders)
              : gateway.traceId;

    const server: Server = createServer((request, response) => {
        gateway.requests.push(request);
        const status = gateway.statuses.shift() ?? 200;
        request.resume();
        request.on("end", () => {
            const id = answer(request);
            if (id !== undefined) response.setHeader("x-fish-trace-id", id);
            response.statusCode = status;
            if (request.url?.startsWith("/v1/tts") && status === 200) {
                response.setHeader("Content-Type", "audio/mpeg");
                response.end(Buffer.from([1, 2, 3]));
                return;
            }
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(status === 200 ? { credit: "1" } : { detail: "nope" }));
        });
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
        gateway.requests.push(request);
        const id = answer(request);
        if (gateway.refuse !== undefined) {
            const body = JSON.stringify({ detail: "refused" });
            socket.end(
                `HTTP/1.1 ${gateway.refuse} Refused\r\n` +
                    (id !== undefined ? `x-fish-trace-id: ${id}\r\n` : "") +
                    "Content-Type: application/json\r\n" +
                    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                    "Connection: close\r\n\r\n" +
                    body,
            );
            return;
        }
        wss.once("headers", (headers) => {
            if (id !== undefined) headers.push(`x-fish-trace-id: ${id}`);
        });
        wss.handleUpgrade(request, socket, head, (ws) => {
            if ((request.url ?? "").includes("/v1/asr/realtime")) {
                const connection = new FakeConnection(ws, request.headers, request.rawHeaders);
                void (async () => {
                    await connection.start();
                    await connection.until("audio_done");
                    connection.done();
                })().catch(() => ws.terminate());
            } else {
                ws.close(1000);
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
        for (const client of wss.clients) client.terminate();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    gateway.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return gateway;
}

function clientFor(gateway: Gateway, headerProvider?: HeaderProvider, headers?: Record<string, string>) {
    return new FishAudioClient({ apiKey: "k", baseUrl: gateway.url, headerProvider, headers });
}

const fixed = (traceparent: string): HeaderProvider => () => ({ traceparent });

async function ttsHandshake(client: FishAudioClient): Promise<void> {
    const connection = await client.textToSpeech.convertRealtime({ text: "" }, []);
    await new Promise<void>((resolve) => {
        connection.on(RealtimeEvents.CLOSE, () => resolve());
        connection.on(RealtimeEvents.ERROR, () => resolve());
    });
}

async function sttSession(client: FishAudioClient): Promise<void> {
    try {
        for await (const _ of client.speechToText.convertRealtime({}, [])) {
            // drain
        }
    } catch {
        // A refused handshake ends the stream with an error; only the check matters here.
    }
}

/** Every path, each of which must run the check. */
const paths: Record<string, (client: FishAudioClient) => Promise<unknown>> = {
    "HTTP JSON": (client) => client.user.get_api_credit(),
    "HTTP streaming": async (client) => {
        const stream = await client.textToSpeech.convert({ text: "hi" });
        await new Response(stream).arrayBuffer();
    },
    "TTS WebSocket handshake": ttsHandshake,
    "STT WebSocket handshake": sttSession,
};

describe("trace continuation check", () => {
    it("no warning when the API continued the trace, on every path", async () => {
        const gateway = await startGateway();
        const client = clientFor(gateway, fixed(TRACEPARENT));
        for (const run of Object.values(paths)) await run(client);
        expect(gateway.requests.length).toBe(4);
        expect(traceWarnings()).toEqual([]);
    });

    it("compares trace ids without regard to case", async () => {
        const gateway = await startGateway();
        gateway.traceId = TRACE_ID.toUpperCase();
        await clientFor(gateway, fixed(TRACEPARENT)).user.get_api_credit();
        expect(traceWarnings()).toEqual([]);
    });

    for (const [name, run] of Object.entries(paths)) {
        it(`warns when the API used another trace: ${name}`, async () => {
            const gateway = await startGateway();
            gateway.traceId = OTHER_ID;
            await run(clientFor(gateway, fixed(TRACEPARENT)));
            const [message, ...more] = traceWarnings();
            expect(more).toEqual([]);
            expect(message).toContain(`sent trace id ${TRACE_ID}, the API used ${OTHER_ID}`);
            expect(message).toContain("@opentelemetry/instrumentation-undici");
            expect(message).toContain("https://docs.fish.audio/api-reference/observability");
            expect(warnings.mock.calls[0]![1]).toEqual({
                type: "FishAudioTraceWarning",
                code: "FISH_AUDIO_TRACE_NOT_CONTINUED",
            });
        });
    }

    it("warns on an error response (4xx)", async () => {
        const gateway = await startGateway();
        gateway.traceId = OTHER_ID;
        gateway.statuses = [404];
        await expect(clientFor(gateway, fixed(TRACEPARENT)).user.get_api_credit()).rejects.toThrow();
        expect(traceWarnings().length).toBe(1);
    });

    it("warns on a refused STT WebSocket handshake", async () => {
        const gateway = await startGateway();
        gateway.traceId = OTHER_ID;
        gateway.refuse = 401;
        await sttSession(clientFor(gateway, fixed(TRACEPARENT)));
        expect(traceWarnings().length).toBe(1);
    });

    it("checks each retry attempt: a retried attempt that was not continued warns", async () => {
        const gateway = await startGateway();
        // The first attempt sends an invalid value and gets a 503 (a new trace);
        // the retry sends a valid one, which the gateway continues.
        let attempt = 0;
        gateway.statuses = [503];
        const client = clientFor(gateway, () => ({
            traceparent: attempt++ === 0 ? "00-not-valid" : TRACEPARENT,
        }));
        await client.user.get_api_credit({ maxRetries: 1 });
        expect(gateway.requests.length).toBe(2);
        const [message, ...more] = traceWarnings();
        expect(more).toEqual([]);
        expect(message).toContain("not a valid W3C traceparent");
    });

    it("warns exactly once across many mismatched calls on every path", async () => {
        const gateway = await startGateway();
        gateway.traceId = OTHER_ID;
        const client = clientFor(gateway, fixed(TRACEPARENT));
        for (let i = 0; i < 3; i++) {
            for (const run of Object.values(paths)) await run(client);
        }
        gateway.statuses = [500, 500];
        await expect(client.user.get_api_credit({ maxRetries: 1 })).rejects.toThrow();
        expect(gateway.requests.length).toBe(14);
        expect(traceWarnings().length).toBe(1);
    });

    it("no warning when the response has no x-fish-trace-id", async () => {
        const gateway = await startGateway();
        gateway.traceId = "none";
        const client = clientFor(gateway, fixed("garbage"));
        for (const run of Object.values(paths)) await run(client);
        expect(traceWarnings()).toEqual([]);
    });

    it("no warning when the SDK sent no traceparent", async () => {
        const gateway = await startGateway();
        gateway.traceId = OTHER_ID;
        const client = clientFor(gateway);
        for (const run of Object.values(paths)) await run(client);
        expect(traceWarnings()).toEqual([]);
    });

    it("an unparseable value warns without echoing it", async () => {
        const gateway = await startGateway();
        const secret = "s3cr3t-token-value";
        await clientFor(gateway, fixed(secret)).user.get_api_credit();
        const [message, ...more] = traceWarnings();
        expect(more).toEqual([]);
        expect(message).toContain("not a valid W3C traceparent");
        expect(message).not.toContain(secret);
    });

    it("checks a traceparent from the client's headers and from per-call headers too", async () => {
        const gateway = await startGateway();
        gateway.traceId = OTHER_ID;
        await clientFor(gateway, undefined, { traceparent: TRACEPARENT }).user.get_api_credit();
        expect(traceWarnings().length).toBe(1);

        resetTraceContinuationWarning();
        await clientFor(gateway).user.get_api_credit({ headers: { TraceParent: TRACEPARENT } });
        expect(traceWarnings().length).toBe(2);
    });

    it("falls back to console.warn where process.emitWarning is missing", async () => {
        const gateway = await startGateway();
        gateway.traceId = OTHER_ID;
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const emitWarning = process.emitWarning;
        (process as { emitWarning?: unknown }).emitWarning = undefined;
        try {
            await clientFor(gateway, fixed(TRACEPARENT)).user.get_api_credit();
        } finally {
            process.emitWarning = emitWarning;
        }
        expect(consoleWarn).toHaveBeenCalledTimes(1);
        expect(String(consoleWarn.mock.calls[0]![0])).toContain(`the API used ${OTHER_ID}`);
    });

    it("never throws, whatever the response looks like", () => {
        const sent = { traceparent: TRACEPARENT };
        expect(() =>
            checkTraceContinued(sent, () => {
                throw new Error("broken response");
            }),
        ).not.toThrow();
        expect(() => checkTraceContinued(sent, () => "not-a-trace-id")).not.toThrow();
        expect(() => checkTraceContinued(sent, () => [OTHER_ID])).not.toThrow();
        expect(traceWarnings().length).toBe(1);
    });
});

describe("traceIdOf", () => {
    it("accepts valid W3C traceparents only", () => {
        expect(traceIdOf(TRACEPARENT)).toBe(TRACE_ID);
        expect(traceIdOf(` ${TRACEPARENT} `)).toBe(TRACE_ID);
        expect(traceIdOf(`01-${TRACE_ID}-00f067aa0ba902b7-01-future`)).toBe(TRACE_ID);
        for (const invalid of [
            "",
            `${TRACEPARENT}, ${TRACEPARENT}`,
            TRACEPARENT.toUpperCase(),
            `ff-${TRACE_ID}-00f067aa0ba902b7-01`,
            `00-${TRACE_ID}-00f067aa0ba902b7-01-extra`,
            `00-${"0".repeat(32)}-00f067aa0ba902b7-01`,
            `00-${TRACE_ID}-${"0".repeat(16)}-01`,
        ]) {
            expect(traceIdOf(invalid)).toBeUndefined();
        }
    });
});
