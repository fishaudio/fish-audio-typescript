/// <reference types="node" />
// First: OpenTelemetry and the instrumentations must be in place before `ws` loads.
import { exporter, http as httpInstrumentation, provider, undici } from "./otelSetup.js";
import * as otel from "@opentelemetry/api";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AlwaysOffSampler, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { FishAudioClient, RealtimeEvents, openTelemetryHeaders, type OpenTelemetryApi } from "../src/index.js";
import { startRealtimeServer } from "./realtimeServer.js";
import { resetTraceContinuationWarning } from "../src/core/traceContinuation.js";
import { gatewayTraceId } from "./gateway.js";

const cleanups: Array<() => Promise<void>> = [];
let warnings: MockInstance<typeof process.emitWarning>;
beforeEach(() => {
    resetTraceContinuationWarning();
    warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});
afterEach(async () => {
    vi.restoreAllMocks();
    resetTraceContinuationWarning();
    undici.disable();
    exporter.reset();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function traceWarnings(): string[] {
    return warnings.mock.calls
        .filter(([, options]) => (options as { type?: string } | undefined)?.type === "FishAudioTraceWarning")
        .map(([message]) => String(message));
}

const tracer = provider.getTracer("test");

function traceparentOf(span: otel.Span): string {
    const c = span.spanContext();
    return `00-${c.traceId}-${c.spanId}-${c.traceFlags.toString(16).padStart(2, "0")}`;
}

function traceparents(rawHeaders: string[]): string[] {
    const values: string[] = [];
    for (let i = 0; i < rawHeaders.length; i += 2) {
        if (rawHeaders[i]!.toLowerCase() === "traceparent") values.push(rawHeaders[i + 1]!);
    }
    return values;
}

/**
 * Records every HTTP request and WebSocket upgrade, answering each with the
 * gateway's `x-fish-trace-id`; upgrades are closed at once.
 */
async function fakeApi(): Promise<{ url: string; requests: IncomingMessage[] }> {
    const requests: IncomingMessage[] = [];
    const server: Server = createServer((request, response) => {
        requests.push(request);
        request.resume();
        request.on("end", () => {
            response.setHeader("x-fish-trace-id", gatewayTraceId(request.rawHeaders));
            response.setHeader("Content-Type", "application/json");
            response.end("{}");
        });
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
        requests.push(request);
        wss.once("headers", (headers) => headers.push(`x-fish-trace-id: ${gatewayTraceId(request.rawHeaders)}`));
        wss.handleUpgrade(request, socket, head, (ws) => ws.close(1000));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
        for (const client of wss.clients) client.terminate();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function ttsHandshake(client: FishAudioClient): Promise<void> {
    const connection = await client.textToSpeech.convertRealtime({ text: "" }, []);
    await new Promise<void>((resolve) => {
        connection.on(RealtimeEvents.CLOSE, () => resolve());
        connection.on(RealtimeEvents.ERROR, () => resolve());
    });
}

/** The span the instrumentation created for a request carrying `traceparent`. */
function clientSpanFor(traceparent: string) {
    const spanId = traceparent.split("-")[2];
    return exporter.getFinishedSpans().find((span) => span.spanContext().spanId === spanId);
}

describe("openTelemetryHeaders", () => {
    const provide = openTelemetryHeaders(otel);

    it("returns the active span as traceparent, and nothing else", () => {
        tracer.startActiveSpan("outer", (span) => {
            expect(provide()).toEqual({ traceparent: traceparentOf(span) });
            span.end();
        });
    });

    it("returns nothing without an active span, or for an invalid one", () => {
        expect(provide()).toBeUndefined();
        otel.context.with(otel.trace.setSpan(otel.context.active(), otel.trace.wrapSpanContext(otel.INVALID_SPAN_CONTEXT)), () => {
            expect(provide()).toBeUndefined();
        });
    });

    it("keeps the flags of an unsampled span", () => {
        const unsampled = new BasicTracerProvider({ sampler: new AlwaysOffSampler() }).getTracer("t");
        unsampled.startActiveSpan("outer", (span) => {
            expect(span.spanContext().traceFlags & otel.TraceFlags.SAMPLED).toBe(0);
            expect(provide()).toEqual({ traceparent: traceparentOf(span) });
            span.end();
        });
    });

    it("never fails a request: an error inside OpenTelemetry sends nothing", () => {
        const broken: OpenTelemetryApi = {
            trace: {
                getActiveSpan() {
                    throw new Error("broken tracer");
                },
            },
        };
        expect(openTelemetryHeaders(broken)()).toBeUndefined();
    });

    it("lower-cases uppercase ids from a wrapped span context, through the real context manager", async () => {
        const upper = { traceId: "4BF92F3577B34DA6A3CE929D0E0E4736", spanId: "00F067AA0BA902B7", traceFlags: 1 };
        // @opentelemetry/api itself accepts these ids.
        expect(otel.trace.isSpanContextValid(upper)).toBe(true);
        const api = await fakeApi();
        const client = new FishAudioClient({ apiKey: "k", baseUrl: api.url, headerProvider: provide });
        const wrapped = otel.trace.setSpan(otel.context.active(), otel.trace.wrapSpanContext(upper));
        const lower = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
        await otel.context.with(wrapped, async () => {
            expect(provide()).toEqual({ traceparent: lower });
            await client.user.get_api_credit();
        });
        expect(traceparents(api.requests[0]!.rawHeaders)).toEqual([lower]);
        expect(traceWarnings()).toEqual([]);
    });

    it("sends nothing for ids that are not hex of the right length, whatever isSpanContextValid says", () => {
        for (const context of [
            { traceId: "4bf92f3577b34da6a3ce929d0e0e473g", spanId: "00f067aa0ba902b7", traceFlags: 1 },
            { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b", traceFlags: 1 },
            { traceId: "4bf92f3577b34da6a3ce929d0e0e4736 ", spanId: "00f067aa0ba902b7", traceFlags: 1 },
            { traceId: "0".repeat(32), spanId: "00f067aa0ba902b7", traceFlags: 1 },
        ]) {
            const lenient: OpenTelemetryApi = {
                trace: { getActiveSpan: () => ({ spanContext: () => context }), isSpanContextValid: () => true },
            };
            expect(openTelemetryHeaders(lenient)()).toBeUndefined();
        }
    });

    it("works with a minimal API object without isSpanContextValid", () => {
        const context = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", traceFlags: 1 };
        const minimal: OpenTelemetryApi = { trace: { getActiveSpan: () => ({ spanContext: () => context }) } };
        expect(openTelemetryHeaders(minimal)()).toEqual({
            traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        });
        const zero = { ...context, traceId: "0".repeat(32) };
        expect(openTelemetryHeaders({ trace: { getActiveSpan: () => ({ spanContext: () => zero }) } })()).toBeUndefined();
    });

    it("sends it on HTTP and both WebSocket handshakes (no undici instrumentation)", async () => {
        const api = await fakeApi();
        const stt = await startRealtimeServer(
            async (connection) => {
                await connection.start();
                await connection.until("audio_done");
                connection.done();
            },
            { traceId: gatewayTraceId },
        );
        cleanups.push(() => stt.close());
        const client = new FishAudioClient({ apiKey: "k", baseUrl: api.url, headerProvider: provide });
        const sttClient = new FishAudioClient({ apiKey: "k", baseUrl: stt.url, headerProvider: provide });

        const outer = await tracer.startActiveSpan("outer", async (span) => {
            await client.user.get_api_credit();
            await ttsHandshake(client);
            for await (const _ of sttClient.speechToText.convertRealtime({}, [])) {
                // drain
            }
            span.end();
            return span;
        });

        const [http, tts] = api.requests;
        expect(traceparents(http!.rawHeaders)).toEqual([traceparentOf(outer)]);
        // On the WebSockets the http instrumentation replaces the helper's value
        // with its own client span: one header, a child of the caller's span.
        for (const rawHeaders of [tts!.rawHeaders, stt.connections[0]!.rawHeaders]) {
            const [sent, ...more] = traceparents(rawHeaders);
            expect(more).toEqual([]);
            expect(sent!.split("-")[1]).toBe(outer.spanContext().traceId);
            expect(clientSpanFor(sent!)?.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
        }
        // The helper alone: Fish Audio continued the trace everywhere, so no warning.
        expect(traceWarnings()).toEqual([]);
    });
});

describe("openTelemetryHeaders without any HTTP instrumentation", () => {
    it("sends exactly the active span's traceparent on HTTP and both WebSocket handshakes", async () => {
        httpInstrumentation.disable();
        cleanups.push(async () => httpInstrumentation.enable());
        const api = await fakeApi();
        const stt = await startRealtimeServer(
            async (connection) => {
                await connection.start();
                await connection.until("audio_done");
                connection.done();
            },
            { traceId: gatewayTraceId },
        );
        cleanups.push(() => stt.close());
        const provide = openTelemetryHeaders(otel);
        const client = new FishAudioClient({ apiKey: "k", baseUrl: api.url, headerProvider: provide });
        const sttClient = new FishAudioClient({ apiKey: "k", baseUrl: stt.url, headerProvider: provide });

        const outer = await tracer.startActiveSpan("outer", async (span) => {
            await client.user.get_api_credit();
            await ttsHandshake(client);
            for await (const _ of sttClient.speechToText.convertRealtime({}, [])) {
                // drain
            }
            span.end();
            return span;
        });

        const [http, tts] = api.requests;
        for (const rawHeaders of [http!.rawHeaders, tts!.rawHeaders, stt.connections[0]!.rawHeaders]) {
            expect(traceparents(rawHeaders)).toEqual([traceparentOf(outer)]);
        }
        // No instrumentation span was made for any of them.
        expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["outer"]);
        expect(traceWarnings()).toEqual([]);
    });
});

describe("with @opentelemetry/instrumentation-undici", () => {
    it("without a header provider: one traceparent per request, the instrumentation's child span (use this)", async () => {
        undici.enable();
        const api = await fakeApi();
        const client = new FishAudioClient({ apiKey: "k", baseUrl: api.url });

        const outer = await tracer.startActiveSpan("outer", async (span) => {
            await client.user.get_api_credit();
            span.end();
            return span;
        });

        const [sent, ...more] = traceparents(api.requests[0]!.rawHeaders);
        expect(more).toEqual([]);
        expect(clientSpanFor(sent!)?.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
        // The SDK sent no traceparent of its own, so it checks nothing and says nothing.
        expect(traceWarnings()).toEqual([]);
    });

    it("plus openTelemetryHeaders: TWO traceparent headers, which Fish Audio treats as none (do not combine them)", async () => {
        undici.enable();
        const api = await fakeApi();
        const client = new FishAudioClient({ apiKey: "k", baseUrl: api.url, headerProvider: openTelemetryHeaders(otel) });

        const outer = await tracer.startActiveSpan("outer", async (span) => {
            await client.user.get_api_credit();
            span.end();
            return span;
        });

        const sent = traceparents(api.requests[0]!.rawHeaders);
        expect(sent.length).toBe(2);
        expect(sent[0]).toBe(traceparentOf(outer)); // the helper's
        expect(clientSpanFor(sent[1]!)?.parentSpanContext?.spanId).toBe(outer.spanContext().spanId); // undici's
        // Both carry the caller's trace id; only the span ids differ. The gateway
        // still sees two headers and starts a new trace.
        expect(sent.map((value) => value.split("-")[1])).toEqual([outer.spanContext().traceId, outer.spanContext().traceId]);
    });

    it("plus openTelemetryHeaders: the SDK sees the API did not continue the trace and warns once", async () => {
        undici.enable();
        const api = await fakeApi();
        const client = new FishAudioClient({ apiKey: "k", baseUrl: api.url, headerProvider: openTelemetryHeaders(otel) });

        const outer = await tracer.startActiveSpan("outer", async (span) => {
            for (let i = 0; i < 3; i++) await client.user.get_api_credit();
            span.end();
            return span;
        });

        expect(api.requests.length).toBe(3);
        const [message, ...more] = traceWarnings();
        expect(more).toEqual([]);
        expect(message).toContain(`(sent trace ${outer.spanContext().traceId}, API used `);
        expect(message).toContain("@opentelemetry/instrumentation-undici appends its own to every fetch request");
    });
});

describe("with @opentelemetry/instrumentation-http on the WebSocket handshakes", () => {
    const TRACE_A = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const fixedA = () => ({ traceparent: TRACE_A });

    async function handshakes(run: (client: FishAudioClient, sttClient: FishAudioClient) => Promise<void>) {
        const api = await fakeApi();
        const stt = await startRealtimeServer(
            async (connection) => {
                await connection.start();
                await connection.until("audio_done");
                connection.done();
            },
            { traceId: gatewayTraceId },
        );
        cleanups.push(() => stt.close());
        const options = { apiKey: "k", headerProvider: fixedA };
        await run(new FishAudioClient({ ...options, baseUrl: api.url }), new FishAudioClient({ ...options, baseUrl: stt.url }));
        return [api.requests[0]!.rawHeaders, stt.connections[0]!.rawHeaders];
    }

    async function both(client: FishAudioClient, sttClient: FishAudioClient) {
        await ttsHandshake(client);
        resetTraceContinuationWarning();
        for await (const _ of sttClient.speechToText.convertRealtime({}, [])) {
            // drain
        }
    }

    it("a provider's trace that is not the active span's is replaced on the way out, and the warning says so", async () => {
        let outerTraceId = "";
        const sent = await tracer.startActiveSpan("outer", async (span) => {
            outerTraceId = span.spanContext().traceId;
            const result = await handshakes(both);
            span.end();
            return result;
        });

        for (const rawHeaders of sent) {
            // One traceparent left the process, the active span's trace, not the provider's.
            const [value, ...more] = traceparents(rawHeaders);
            expect(more).toEqual([]);
            expect(value!.split("-")[1]).toBe(outerTraceId);
        }
        const messages = traceWarnings();
        expect(messages.length).toBe(2); // one per handshake: the flag is reset in between
        for (const message of messages) {
            expect(message).toContain(
                `The trace this SDK sent is not the one Fish Audio used (sent trace 4bf92f3577b34da6a3ce929d0e0e4736, API used ${outerTraceId}).`,
            );
            expect(message).toContain(
                `It was replaced before the handshake left this process: it went out as trace ${outerTraceId}, which the API continued.`,
            );
            expect(message).toContain("@opentelemetry/instrumentation-http does this");
            expect(message).not.toContain("instrumentation-undici");
        }
    });

    it("without an active span the instrumentation sends a new trace in place of the provider's", async () => {
        const sent = await handshakes(both);
        const goneOut = sent.map((rawHeaders) => traceparents(rawHeaders)[0]!.split("-")[1]!);
        for (const traceId of goneOut) expect(traceId).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
        const messages = traceWarnings();
        expect(messages.length).toBe(2);
        messages.forEach((message, i) => {
            expect(message).toContain(`it went out as trace ${goneOut[i]}, which the API continued.`);
        });
    });
});
