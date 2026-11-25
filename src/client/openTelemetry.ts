import type { HeaderProvider } from "../core/headerProvider.js";

/** The parts of a span context the helper reads; `@opentelemetry/api`'s `SpanContext` fits. */
export interface OpenTelemetrySpanContext {
    traceId: string;
    spanId: string;
    traceFlags: number;
}

/**
 * The parts of `@opentelemetry/api` that {@link openTelemetryHeaders} uses.
 * Pass the module itself (`import * as otel from "@opentelemetry/api"`); the
 * SDK never imports it, so it adds no dependency and works with any bundler.
 */
export interface OpenTelemetryApi {
    trace: {
        getActiveSpan(): { spanContext(): OpenTelemetrySpanContext } | undefined;
        isSpanContextValid?(spanContext: OpenTelemetrySpanContext): boolean;
    };
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/**
 * A header provider that sends the active OpenTelemetry span as a W3C
 * `traceparent`, so you can find your requests in Fish Audio's traces.
 *
 * ```typescript
 * import * as otel from "@opentelemetry/api";
 * const client = new FishAudioClient({ headerProvider: openTelemetryHeaders(otel) });
 * ```
 *
 * It sends `traceparent` only, built from the active span's IDs and flags, and
 * only for a valid span: no `baggage` (it can carry application data), no
 * `tracestate`, and not the configured propagator, because Fish Audio reads the
 * W3C `traceparent` only. An error inside OpenTelemetry sends no header and
 * never fails a request.
 *
 * Do not use it together with `@opentelemetry/instrumentation-undici` (part of
 * `auto-instrumentations-node`): that instrumentation already adds a
 * `traceparent` to every HTTP request, a second one is appended rather than
 * replaced, and Fish Audio treats a request with two as having none and starts
 * a new trace. With undici instrumentation you need no header provider.
 */
export function openTelemetryHeaders(api: OpenTelemetryApi): HeaderProvider {
    return () => {
        try {
            const context = api.trace.getActiveSpan()?.spanContext();
            if (context == null) {
                return undefined;
            }
            const valid = api.trace.isSpanContextValid
                ? api.trace.isSpanContextValid(context)
                : TRACE_ID.test(context.traceId) &&
                  SPAN_ID.test(context.spanId) &&
                  !/^0+$/.test(context.traceId) &&
                  !/^0+$/.test(context.spanId);
            if (!valid) {
                return undefined;
            }
            const flags = (context.traceFlags & 0xff).toString(16).padStart(2, "0");
            return { traceparent: `00-${context.traceId}-${context.spanId}-${flags}` };
        } catch {
            return undefined;
        }
    };
}
