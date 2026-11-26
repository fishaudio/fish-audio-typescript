import * as core from "../../core/index.js";
import { checkHeader, HeaderProviderFailure, providedHeaders } from "../../core/headerProvider.js";
import { setHeaderIgnoringCase } from "../../core/headers.js";
import { withUserAgent } from "../../core/userAgent.js";

type HeaderSource = Record<string, string | core.Supplier<string | null | undefined> | null | undefined>;

type Source = "client" | "sdk" | "call";

/**
 * The headers of a WebSocket handshake, merged in the same order as on HTTP
 * requests and, as there, without regard to case, so no header is sent twice:
 *
 * 1. the client's `headers` (`Authorization` and `model` skipped);
 * 2. the SDK's `Authorization` and `model`;
 * 3. the call's `requestOptions.headers` (a value the header provider could
 *    not return throws `TypeError`);
 * 4. the header provider, for names not named in 1 or 3;
 * 5. `User-Agent`: the SDK's own, with a caller's value appended.
 *
 * Which source wins each name is decided first; only then are the winners'
 * suppliers run and their values checked, so a client header that the call
 * replaces or removes is never resolved and cannot fail the call. In 1 and 3,
 * a `null` or `undefined` value (or a supplier returning one) removes the
 * header, and the provider does not add it back.
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
    // Every name the caller listed, removed and replaced ones included: the provider may not set them.
    const named: string[] = [];
    const winners: Record<string, { source: Source; supplier: HeaderSource[string] }> = {};
    for (const [name, supplier] of Object.entries(params.clientHeaders ?? {})) {
        named.push(name);
        if (!sdkNames.has(name.toLowerCase())) {
            setHeaderIgnoringCase(winners, name, { source: "client", supplier });
        }
    }
    for (const [name, value] of Object.entries(params.sdkHeaders)) {
        setHeaderIgnoringCase(winners, name, { source: "sdk", supplier: value });
    }
    for (const [name, supplier] of Object.entries(params.requestHeaders ?? {})) {
        named.push(name);
        setHeaderIgnoringCase(winners, name, { source: "call", supplier });
    }

    const headers: Record<string, string> = {};
    for (const [name, { source, supplier }] of Object.entries(winners)) {
        const value = await core.Supplier.get(supplier);
        if (value == null) {
            continue;
        }
        if (source === "call") {
            // The rule the header provider follows, so a bad value fails here
            // with a TypeError that does not contain it, never inside ws.
            checkHeader("requestOptions.headers has", name, String(value));
        } else if (source === "client" && params.checkClientHeaders && name.toLowerCase() !== "user-agent") {
            checkHeader("the client's headers have", name, String(value));
        }
        headers[name] = value;
    }
    try {
        // Last, right before the socket is opened, so it sees the caller's context then.
        Object.assign(headers, providedHeaders(params.headerProvider, [...Object.keys(headers), ...named]));
    } catch (error) {
        throw error instanceof HeaderProviderFailure ? error.cause : error;
    }
    return withUserAgent(headers);
}
