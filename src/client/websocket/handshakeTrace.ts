import type { ClientRequest, IncomingMessage } from "node:http";
import {
    checkTraceContinued,
    TRACE_ID_RESPONSE_HEADER,
    type TransmittedTraceparent,
} from "../../core/traceContinuation.js";

/**
 * A `finishRequest` for `ws` that checks a handshake's response, accepted or
 * refused, against the `traceparent` in `headers` (see
 * {@link checkTraceContinued}), and then sends the request as `ws` would.
 *
 * `finishRequest` is `ws`'s public hook for the handshake's `ClientRequest`.
 * Through it the check reads the `traceparent` the request really carries
 * (after an http instrumentation changed it), and listens for the response:
 * `upgrade` when it is accepted, `response` when it is refused. `ws` added its
 * own listeners for both before calling this, so they run first and handle
 * the response exactly as without this one; this one only reads its headers.
 * (Listening for `ws`'s `unexpected-response` instead would take the refusal
 * away from `ws`, which then neither aborts the request nor emits the error.)
 */
export function checkHandshakeTrace(headers: Record<string, string>): (request: ClientRequest) => void {
    return (request) => {
        let transmitted: TransmittedTraceparent | undefined;
        try {
            const value = request.getHeader("traceparent");
            transmitted = {
                value: value === undefined ? undefined : Array.isArray(value) ? value.join(", ") : String(value),
            };
        } catch {
            // Unknown, as for fetch.
        }
        const check = (response: IncomingMessage) =>
            checkTraceContinued(headers, () => response.headers[TRACE_ID_RESPONSE_HEADER], transmitted);
        request.on("upgrade", check);
        request.on("response", check);
        // What ws does itself without a finishRequest.
        request.end();
    };
}
