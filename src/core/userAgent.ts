import { RUNTIME, type Runtime } from "./runtime/runtime.js";
import { VERSION } from "../version.js";

/**
 * The SDK's product, `fish-audio-<language>/<version>`: the format every Fish
 * Audio SDK sends, so the API can tell which SDK and version made a request. It
 * is one RFC 9110 product (`token "/" token`); the build checks that the version
 * is a token.
 */
export const SDK_USER_AGENT = `fish-audio-typescript/${VERSION}`;

/**
 * Returns the headers with exactly one `User-Agent`: the SDK's product token,
 * followed by the User-Agent the caller set, if any.
 *
 * A caller's value is appended rather than allowed to replace the token, so an
 * app can name itself without hiding which SDK made the request. Header names
 * are compared without regard to case; when several spellings are present, the
 * last one wins, as request options are merged after the client's headers.
 *
 * In a browser or web worker the headers are returned unchanged. Chromium and
 * Safari drop a User-Agent set by a page; Firefox sends it, which adds it to the
 * CORS preflight, and the API does not allow that header, so the request would
 * fail. The server sees the browser's own User-Agent there.
 */
export function withUserAgent(
    headers: Record<string, string>,
    runtime: Runtime["type"] = RUNTIME.type,
): Record<string, string> {
    if (runtime === "browser" || runtime === "web-worker") {
        return headers;
    }
    const result: Record<string, string> = {};
    let callerValue = "";
    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === "user-agent") {
            callerValue = value.trim();
        } else {
            result[name] = value;
        }
    }
    // A value that already starts with the token (one passed back in) is not doubled.
    if (callerValue === SDK_USER_AGENT || callerValue.startsWith(`${SDK_USER_AGENT} `)) {
        callerValue = callerValue.slice(SDK_USER_AGENT.length).trim();
    }
    result["User-Agent"] = callerValue === "" ? SDK_USER_AGENT : `${SDK_USER_AGENT} ${callerValue}`;
    return result;
}
