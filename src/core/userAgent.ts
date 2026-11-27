import { RUNTIME, type Runtime } from "./runtime/runtime.js";
import { VERSION } from "../version.js";

/**
 * The SDK's product, `fish-audio-<language>/<version>`: the format every Fish
 * Audio SDK sends, so the API can tell which SDK and version made a request. It
 * is one RFC 9110 product (`token "/" token`); the build checks that the version
 * is a token.
 */
export const SDK_PRODUCT = `fish-audio-typescript/${VERSION}`;

const SAFE_PREFIX = /^[A-Za-z0-9._+-]+/;

/**
 * Makes a value safe inside an RFC 9110 comment: keeps its leading run of
 * letters, digits and `._+-` (at most 32 characters) and drops the rest, so
 * `(`, `)`, `\`, spaces and control characters can never reach the header.
 * Returns `unknown` when nothing usable is left.
 */
export function commentValue(value: unknown): string {
    if (typeof value !== "string") {
        return "unknown";
    }
    const match = SAFE_PREFIX.exec(value.trim());
    return match ? match[0].slice(0, 32) : "unknown";
}

/** The OS family as one short lowercase word: `linux`, `darwin`, `windows`, or the platform's own name. */
export function osFamily(platform: unknown): string {
    const os = commentValue(typeof platform === "string" ? platform.toLowerCase() : platform);
    return os === "win32" ? "windows" : os;
}

/**
 * The full User-Agent value: the product, then a comment with the runtime, its
 * version and the OS family, e.g. `fish-audio-typescript/0.2.1 (node 24.1.0; darwin)`.
 * Nothing that identifies a person or machine is included.
 */
export function buildUserAgent(runtime: unknown, runtimeVersion: unknown, platform: unknown): string {
    return `${SDK_PRODUCT} (${commentValue(runtime)} ${commentValue(runtimeVersion)}; ${osFamily(platform)})`;
}

interface PlatformGlobals {
    process?: { platform?: unknown };
    Deno?: { build?: { os?: unknown } };
}

/**
 * The platform name the runtime reports, or `undefined`. Reads only globals
 * that exist, so it never throws, also where `process` is missing.
 */
export function detectPlatform(
    runtime: Runtime["type"],
    globals: PlatformGlobals = globalThis as PlatformGlobals,
): unknown {
    try {
        if (runtime === "deno") {
            return globals.Deno?.build?.os;
        }
        if (runtime === "node" || runtime === "bun") {
            return globals.process?.platform;
        }
    } catch {
        // A getter that throws leaves the OS unknown.
    }
    return undefined;
}

/** Computed once, when the module loads. */
export const SDK_USER_AGENT = buildUserAgent(RUNTIME.type, RUNTIME.version, detectPlatform(RUNTIME.type));

/**
 * Returns the headers with exactly one `User-Agent`: the SDK's product and its
 * runtime comment, followed by the User-Agent the caller set, if any.
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
