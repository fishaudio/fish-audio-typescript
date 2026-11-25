/**
 * A function the SDK calls for every HTTP request (once per attempt, retries
 * included) and every WebSocket handshake, right before it is sent, to add
 * headers such as the W3C `traceparent` of your current request.
 *
 * It takes no arguments: read your current span or request inside it (it runs
 * in the async context of the call, so `AsyncLocalStorage` and OpenTelemetry's
 * `context.active()` see the caller's values). It must be synchronous. Return
 * the headers to add, or `undefined`/`null` to add none; a header whose value
 * is `undefined` or `null` is skipped.
 *
 * Headers the SDK sets (`Authorization`, `model`, `User-Agent`, `Content-Type`,
 * `Content-Length`, `Host`, WebSocket handshake headers) cannot be set by it,
 * and the client's `headers` and per-call `requestOptions.headers` win over it.
 * An error it throws fails the call, unchanged, before anything is sent.
 */
export type HeaderProvider = () => Record<string, string | null | undefined> | null | undefined;

// Headers the SDK sets itself or that HTTP and the WebSocket handshake own. A
// provider can never set them, so it cannot replace the API key or the model
// by accident, e.g. when it copies an inbound request's headers.
const RESERVED = new Set([
    "authorization",
    "model",
    "user-agent",
    "content-type",
    "content-length",
    "host",
    "connection",
    "upgrade",
    "transfer-encoding",
]);

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Control characters other than horizontal tab may not appear in a value.
const FORBIDDEN_IN_VALUE = /[\x00-\x08\x0a-\x1f\x7f]/;

function isReserved(name: string): boolean {
    const lowered = name.toLowerCase();
    return RESERVED.has(lowered) || lowered.startsWith("sec-websocket-");
}

/**
 * Carries an error thrown by a header provider through code that would
 * otherwise turn it into a `FishAudioError`, so the caller gets it unchanged.
 */
export class HeaderProviderFailure {
    constructor(readonly cause: unknown) {}
}

/** Throws `TypeError` unless `provider` is a function or absent. */
export function checkHeaderProvider(provider: unknown): void {
    if (provider != null && typeof provider !== "function") {
        throw new TypeError("headerProvider must be a function");
    }
}

/**
 * Calls `provider` and returns the headers it may add to a request that already
 * has the headers named in `taken` (compared without regard to case).
 *
 * An error the provider throws, or the `TypeError` for a result it may not
 * return, is thrown wrapped in `HeaderProviderFailure`, for the caller to
 * unwrap. Nothing is sent in either case.
 */
export function providedHeaders(
    provider: HeaderProvider | undefined,
    taken: Iterable<string>,
): Record<string, string> {
    if (provider == null) {
        return {};
    }
    try {
        return collect(provider(), taken);
    } catch (error) {
        throw new HeaderProviderFailure(error);
    }
}

function collect(result: unknown, taken: Iterable<string>): Record<string, string> {
    if (result == null) {
        return {};
    }
    if (typeof (result as { then?: unknown }).then === "function") {
        // Not awaited: the value must reflect the moment the request is sent.
        throw new TypeError("headerProvider must return headers synchronously, not a promise");
    }
    if (typeof result !== "object" || Array.isArray(result)) {
        throw new TypeError(
            `headerProvider must return an object of header names to strings, not ${Array.isArray(result) ? "an array" : typeof result}`,
        );
    }
    const takenNames = new Set<string>();
    for (const name of taken) {
        takenNames.add(name.toLowerCase());
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(result)) {
        if (value == null) {
            continue;
        }
        if (typeof value !== "string") {
            throw new TypeError(`headerProvider must return string header values, got ${typeof value} for ${JSON.stringify(name)}`);
        }
        if (!HEADER_NAME.test(name)) {
            throw new TypeError(`headerProvider returned an invalid header name ${JSON.stringify(name)}`);
        }
        if (FORBIDDEN_IN_VALUE.test(value)) {
            // The value is not echoed: it may be a credential.
            throw new TypeError(`headerProvider returned an invalid value for header ${JSON.stringify(name)}`);
        }
        if (isReserved(name) || takenNames.has(name.toLowerCase())) {
            continue;
        }
        // One spelling per name: a later one replaces an earlier one.
        for (const existing of Object.keys(headers)) {
            if (existing.toLowerCase() === name.toLowerCase()) {
                delete headers[existing];
            }
        }
        headers[name] = value;
    }
    return headers;
}
