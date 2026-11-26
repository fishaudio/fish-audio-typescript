import * as core from "../../core/index.js";
import { mergeHeaders } from "../../core/headers.js";

type Headers = Record<string, string | core.Supplier<string | null | undefined> | null | undefined>;

/**
 * Headers for a WebSocket handshake: the client's headers, then the call's,
 * resolved for this connection as an HTTP request resolves them, then the
 * SDK's own `Authorization` and `model`. A client or call header with either
 * name, in any casing, is dropped before its supplier runs, so the handshake
 * carries the SDK's value once.
 */
export async function handshakeHeaders(
    clientHeaders: Headers | undefined,
    requestHeaders: Headers | undefined,
    own: { Authorization: string; model: string },
): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const [name, supplier] of Object.entries(mergeHeaders(clientHeaders, requestHeaders))) {
        if (["authorization", "model"].includes(name.toLowerCase())) {
            continue;
        }
        const value = await core.Supplier.get(supplier);
        if (value != null) {
            headers[name] = value;
        }
    }
    return { ...headers, ...own };
}
