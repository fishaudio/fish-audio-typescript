/// <reference types="node" />
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
import { gatewayTraceId } from "./gateway.js";
import { FakeConnection } from "./realtimeServer.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const OTHER_ID = "0af7651916cd43dd8448eb211c80319c";

interface Gateway {
    url: string;
    requests: IncomingMessage[];
    /** "gateway" mimics Fish Audio; a string is always answered; "none" sends no x-fish-trace-id. */
    traceId: "gateway" | "none" | string;
    /** HTTP statuses for the next requests, in order; 200 once they run out. */
    statuses: number[];
    /** Refuse WebSocket handshakes with this status. */
    refuse?: number;
    /** Called with the socket of each WebSocket upgrade request. */
    onUpgradeSocket?: (socket: import("node:stream").Duplex) => void;
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
        gateway.onUpgradeSocket?.(socket);
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
            expect(message).toContain(
                `The trace this SDK sent is not the one Fish Audio used (sent trace ${TRACE_ID}, API used ${OTHER_ID}).`,
            );
            if (name.startsWith("HTTP")) {
                // fetch does not show what it sent: the message lists the possibilities.
                expect(message).toContain("The SDK cannot see the request as it was sent");
                expect(message).toContain("@opentelemetry/instrumentation-undici appends");
            } else {
                // The handshake's request shows it: here it went out as the SDK built it.
                expect(message).toContain("It left this process unchanged, so the API did not accept the value.");
                expect(message).not.toContain("instrumentation");
            }
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

    it("warns on a refused TTS WebSocket handshake", async () => {
        const gateway = await startGateway();
        gateway.traceId = OTHER_ID;
        gateway.refuse = 401;
        await ttsHandshake(clientFor(gateway, fixed(TRACEPARENT)));
        const [message, ...more] = traceWarnings();
        expect(more).toEqual([]);
        expect(message).toContain(`(sent trace ${TRACE_ID}, API used ${OTHER_ID})`);
    });

    it("a refused TTS handshake looks the same to the caller whether or not the trace is checked", async () => {
        // What the caller of convertRealtime observes: the connection's events
        // in order, with the error's class and message, the socket's state at
        // each, and whether the server saw the connection closed.
        async function refusedOutcome(headerProvider?: HeaderProvider) {
            const gateway = await startGateway();
            gateway.traceId = OTHER_ID;
            gateway.refuse = 401;
            const closedOnServer = new Promise<void>((resolve) =>
                gateway.onUpgradeSocket = (socket) => socket.once("close", () => resolve()),
            );
            const connection = await clientFor(gateway, headerProvider).textToSpeech.convertRealtime({ text: "" }, []);
            const websocket = (connection as unknown as { websocket: { readyState: number } }).websocket;
            // Event-loop turns, to compare when the events arrive relative to each other.
            let turn = 0;
            let ticking = true;
            const tick = () => {
                turn += 1;
                if (ticking) setImmediate(tick);
            };
            setImmediate(tick);
            const events: unknown[][] = [];
            await new Promise<void>((resolve) => {
                connection.on(RealtimeEvents.OPEN, () => events.push(["open", turn]));
                connection.on(RealtimeEvents.ERROR, (error) =>
                    events.push([
                        "error",
                        (error as Error).constructor.name,
                        (error as Error).message,
                        websocket.readyState,
                        turn,
                    ]),
                );
                connection.on(RealtimeEvents.CLOSE, () => {
                    events.push(["close", websocket.readyState, turn]);
                    resolve();
                });
            });
            ticking = false;
            await closedOnServer;
            // Turns relative to the first event: when the refusal arrives depends on the network.
            const first = events[0]![events[0]!.length - 1] as number;
            return events.map((event) => [...event.slice(0, -1), (event[event.length - 1] as number) - first]);
        }

        // Without a traceparent nothing is checked, as before the check existed.
        const unchecked = await refusedOutcome();
        const checked = await refusedOutcome(fixed(TRACEPARENT));
        expect(checked).toEqual(unchecked);
        // ws's own handling of a refusal (the outcome before this check existed):
        // a plain Error with its message, then close in the same turn, the
        // socket CLOSING then CLOSED.
        expect(unchecked).toEqual([
            ["error", "Error", "Unexpected server response: 401", 2, 0],
            ["close", 3, 0],
        ]);
        expect(traceWarnings().length).toBe(1);
    });

    it("a version other than 00 is sent, and the gateway's new trace is reported", async () => {
        // The SDK accepts a later version (W3C forward compatibility); the
        // gateway continues version 00 only.
        const gateway = await startGateway();
        const future = `01-${TRACE_ID}-00f067aa0ba902b7-01`;
        for (const run of Object.values(paths)) await run(clientFor(gateway, fixed(future)));
        for (const request of gateway.requests) {
            expect(request.headers.traceparent).toBe(future);
        }
        const [message, ...more] = traceWarnings();
        expect(more).toEqual([]);
        expect(message).toContain(`(sent trace ${TRACE_ID}, API used `);
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
        expect(String(consoleWarn.mock.calls[0]![0])).toContain(`API used ${OTHER_ID}`);
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

describe("the warning, when the SDK can see what left the process", () => {
    const sent = { traceparent: TRACEPARENT };

    it.each([
        ["removed", undefined, "It was changed before the handshake left this process, into no traceparent at all."],
        [
            "duplicated",
            `${TRACEPARENT}, 00-${OTHER_ID}-00f067aa0ba902b7-01`,
            "It was changed before the handshake left this process, into a value that is not a single valid W3C traceparent.",
        ],
        ["replaced", `00-${OTHER_ID}-b7ad6b7169203331-01`, `it went out as trace ${OTHER_ID}, which the API continued.`],
        [
            "given another parent span in the same trace",
            `00-${TRACE_ID}-b7ad6b7169203331-01`,
            "It left this process with that trace, so the API did not accept the value.",
        ],
    ])("%s on the way out: says so", (_, value, expected) => {
        checkTraceContinued(sent, () => OTHER_ID, { value });
        const [message, ...more] = traceWarnings();
        expect(more).toEqual([]);
        expect(message).toContain(`(sent trace ${TRACE_ID}, API used ${OTHER_ID})`);
        expect(message).toContain(expected);
    });

    it("never echoes a value, only trace ids parsed from it", () => {
        const secret = "s3cr3t-token-value";
        checkTraceContinued({ traceparent: secret }, () => OTHER_ID, { value: `${secret}, ${secret}` });
        const [message] = traceWarnings();
        expect(message).toContain("(sent a value that is not a valid W3C traceparent, API used");
        expect(message).not.toContain(secret);
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
