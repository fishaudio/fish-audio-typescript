/// <reference types="node" />
/**
 * OpenTelemetry for the instrumentation tests: a tracer provider that keeps
 * finished spans in memory, and the undici (fetch) and http (`ws` handshakes)
 * instrumentations. Import it before anything that loads `ws` or `node:http`
 * clients, so the http instrumentation can patch them.
 */
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

export const exporter = new InMemorySpanExporter();
export const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(provider);

export const undici = new UndiciInstrumentation();
export const http = new HttpInstrumentation({ ignoreIncomingRequestHook: () => true });
registerInstrumentations({ instrumentations: [undici, http] });
// registerInstrumentations enables every instrumentation; undici is switched on per test.
undici.disable();
