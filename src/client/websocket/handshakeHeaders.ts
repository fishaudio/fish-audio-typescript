import * as core from "../../core/index.js";
import { checkHeader, HeaderProviderFailure, providedHeaders } from "../../core/headerProvider.js";
import { withUserAgent } from "../../core/userAgent.js";

type HeaderSource = Record<string, string | core.Supplier<string | null | undefined> | null | undefined>;

/** Sets `name` to `value`, replacing the header under any other casing. */
function setHeader(headers: Record<string, string>, name: string, value: string | null | undefined): void {
    for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase()) {
            delete headers[existing];
        }
    }
    if (value != null) {
        headers[name] = value;
    }
}

/**
 * The headers of a WebSocket handshake, merged in the same order as on HTTP
 * requests, but without regard to case so no header is sent twice:
 *
 * 1. the client's `headers` (suppliers run; `Authorization` and `model` skipped);
 * 2. the SDK's `Authorization` and `model`;
 * 3. the call's `requestOptions.headers` (a value the header provider could
 *    not return throws `TypeError`);
 * 4. the header provider, for names not named in 1 or 3;
 * 5. `User-Agent`: the SDK's own, with a caller's value appended.
 *
 * In 1 and 3, a `null` or `undefined` value (or a supplier returning one)
 * removes the header, and the provider does not add it back.
 *
 * With `checkClientHeaders`, the client's `headers` other than `User-Agent`
 * follow the provider's rule too: the TTS handshake sends them only since the
 * header provider was added, so they get the SDK's `TypeError`, not Node's.
 * Otherwise they are not checked, as on HTTP requests.
 *
 * An error thrown by the header provider is rethrown unchanged.
 */
export async function handshakeHeaders(params: {
    clientHeaders: HeaderSource | undefined;
    sdkHeaders: Record<string, string>;
    requestHeaders: HeaderSource | undefined;
    headerProvider: core.HeaderProvider | undefined;
    checkClientHeaders?: boolean;
}): Promise<Record<string, string>> {
    const sdkNames = new Set(Object.keys(params.sdkHeaders).map((name) => name.toLowerCase()));
    const headers: Record<string, string> = {};
    // Every name the caller listed, removed ones included: the provider may not set them.
    const named: string[] = [];
    for (const [name, supplier] of Object.entries(params.clientHeaders ?? {})) {
        if (sdkNames.has(name.toLowerCase())) {
            // Replaced below, so its supplier is not run either.
            continue;
        }
        const value = await core.Supplier.get(supplier);
        if (params.checkClientHeaders && value != null && name.toLowerCase() !== "user-agent") {
            checkHeader("the client's headers have", name, String(value));
        }
        setHeader(headers, name, value);
        named.push(name);
    }
    for (const [name, value] of Object.entries(params.sdkHeaders)) {
        setHeader(headers, name, value);
    }
    for (const [name, supplier] of Object.entries(params.requestHeaders ?? {})) {
        const value = await core.Supplier.get(supplier);
        if (value != null) {
            // The rule the header provider follows, so a bad value fails here
            // with a TypeError that does not contain it, never inside ws.
            checkHeader("requestOptions.headers has", name, String(value));
        }
        setHeader(headers, name, value);
        named.push(name);
    }
    try {
        // Last, right before the socket is opened, so it sees the caller's context then.
        Object.assign(headers, providedHeaders(params.headerProvider, [...Object.keys(headers), ...named]));
    } catch (error) {
        throw error instanceof HeaderProviderFailure ? error.cause : error;
    }
    return withUserAgent(headers);
}
