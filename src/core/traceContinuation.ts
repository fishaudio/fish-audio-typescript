/**
 * Tells the caller, once per process, when Fish Audio did not continue the
 * trace that a `traceparent` sent by this SDK asked it to continue.
 *
 * The API continues a trace only when a request carries exactly one valid W3C
 * `traceparent`; otherwise it starts a new one, silently. Its responses (HTTP,
 * error responses and the WebSocket handshakes included) carry
 * `x-fish-trace-id`, the trace id the API used. (Checked 2026-11-25: the `/v1`
 * routes do; `/model` and `/wallet` do not yet, so those are not checked.) Comparing the two is the only
 * way to see the most common mistake: an HTTP auto-instrumentation such as
 * `@opentelemetry/instrumentation-undici` appends its own `traceparent` to the
 * one a header provider added, and the API, seeing two, starts a new trace.
 */

/** The response header with the 32-hex trace id that Fish Audio used. */
export const TRACE_ID_RESPONSE_HEADER = "x-fish-trace-id";

const WARNING_TYPE = "FishAudioTraceWarning";
const WARNING_CODE = "FISH_AUDIO_TRACE_NOT_CONTINUED";
const DOCS = "https://docs.fish.audio/api-reference/observability";

// Shared through the global object, so the ESM and CJS builds loaded into one
// process (a dual-package setup) still warn once between them.
const WARNED = Symbol.for("fish-audio.traceNotContinuedWarned");

const TRACE_ID = /^[0-9a-f]{32}$/i;
// W3C Trace Context, level 1: version-traceid-parentid-flags, lowercase hex.
// Version ff is invalid; a later version may append fields after a dash.
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/** The trace id of a valid W3C `traceparent`, or `undefined` if it is not one. */
export function traceIdOf(traceparent: string): string | undefined {
    const match = TRACEPARENT.exec(traceparent.trim());
    if (match == null) {
        return undefined;
    }
    const [, version, traceId, parentId, , rest] = match;
    if (version === "ff" || (version === "00" && rest !== undefined)) {
        return undefined;
    }
    if (/^0+$/.test(traceId!) || /^0+$/.test(parentId!)) {
        return undefined;
    }
    return traceId;
}

/**
 * The `traceparent` among the headers this SDK is about to send, or `undefined`
 * if there is none. Two spellings of the name are sent as one combined value,
 * which is not a valid `traceparent`, so they are returned joined the same way.
 */
export function sentTraceparent(headers: Record<string, string>): string | undefined {
    let value: string | undefined;
    for (const [name, headerValue] of Object.entries(headers)) {
        if (name.toLowerCase() === "traceparent") {
            value = value === undefined ? headerValue : `${value}, ${headerValue}`;
        }
    }
    return value;
}

/**
 * Compares the `traceparent` this SDK sent with the trace id in the response
 * and warns, once per process, if Fish Audio did not continue that trace.
 * `readResponseTraceId` reads `x-fish-trace-id` from the response; it is called
 * inside the guard, so not even reading the response can throw out of here.
 *
 * Does nothing when the SDK sent no `traceparent`, or when the response has no
 * `x-fish-trace-id` (a custom `baseUrl`, a proxy that drops it, or a browser
 * that hides it from CORS requests). Synchronous, and never throws.
 */
export function checkTraceContinued(
    sentHeaders: Record<string, string>,
    readResponseTraceId: () => string | string[] | null | undefined,
): void {
    try {
        if (warned()) {
            return;
        }
        const sent = sentTraceparent(sentHeaders);
        if (sent === undefined) {
            return;
        }
        const responseTraceId = readResponseTraceId();
        const used = Array.isArray(responseTraceId) ? responseTraceId[0] : responseTraceId;
        if (used == null || !TRACE_ID.test(used.trim())) {
            // Not an answer from Fish Audio's gateway, so nothing to compare with.
            return;
        }
        const usedId = used.trim().toLowerCase();
        const sentId = traceIdOf(sent);
        if (sentId !== undefined && sentId === usedId) {
            return;
        }
        markWarned();
        warn(message(sentId, usedId));
    } catch {
        // A diagnostic must never fail or change the call it watches.
    }
}

function message(sentId: string | undefined, usedId: string): string {
    // The sent value itself is never echoed: only a trace id parsed from it.
    const what =
        sentId !== undefined
            ? `sent trace id ${sentId}, the API used ${usedId}`
            : `the traceparent it sent is not a valid W3C traceparent; the API used ${usedId}`;
    return (
        `Fish Audio did not continue the trace this SDK sent (${what}). ` +
        "Usual causes: the request carried two traceparent headers (an HTTP auto-instrumentation such as " +
        "@opentelemetry/instrumentation-undici plus a headerProvider; use only one), " +
        `or the value is not a valid W3C traceparent. See ${DOCS}`
    );
}

function warned(): boolean {
    return (globalThis as Record<symbol, unknown>)[WARNED] === true;
}

function markWarned(): void {
    (globalThis as Record<symbol, unknown>)[WARNED] = true;
}

function warn(text: string): void {
    const process = (globalThis as { process?: { emitWarning?: unknown } }).process;
    if (typeof process?.emitWarning === "function") {
        // Handled or silenced the standard way: process.on("warning"),
        // --disable-warning=FishAudioTraceWarning, or --no-warnings.
        (process.emitWarning as (warning: string, options: { type: string; code: string }) => void).call(process, text, {
            type: WARNING_TYPE,
            code: WARNING_CODE,
        });
        return;
    }
    // Browsers and runtimes without process.emitWarning.
    console.warn(`${WARNING_TYPE} [${WARNING_CODE}]: ${text}`);
}

/** For tests: lets the next mismatch warn again. */
export function resetTraceContinuationWarning(): void {
    delete (globalThis as Record<symbol, unknown>)[WARNED];
}
