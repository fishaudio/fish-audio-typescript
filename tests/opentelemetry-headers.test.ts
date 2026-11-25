/// <reference types="node" />
// First: OpenTelemetry and the instrumentations must be in place before `ws` loads.
import { exporter, provider, undici } from "./otelSetup.js";
import * as otel from "@opentelemetry/api";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { AlwaysOffSampler, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { FishAudioClient, RealtimeEvents, openTelemetryHeaders, type OpenTelemetryApi } from "../src/index.js";
import { startRealtimeServer } from "./realtimeServer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    undici.disable();
    exporter.reset();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

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

/** Records every HTTP request and WebSocket upgrade; upgrades are closed at once. */
async function fakeApi(): Promise<{ url: string; requests: IncomingMessage[] }> {
    const requests: IncomingMessage[] = [];
    const server: Server = createServer((request, response) => {
        requests.push(request);
        request.resume();
        request.on("end", () => {
            response.setHeader("Content-Type", "application/json");
            response.end("{}");
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
        const stt = await startRealtimeServer(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });
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
    });
});
