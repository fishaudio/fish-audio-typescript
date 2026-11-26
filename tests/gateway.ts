/// <reference types="node" />
import { randomBytes } from "node:crypto";

const VERSION_00 = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * The trace id Fish Audio's gateway uses for a request, by its rule, written
 * here independently of the SDK's own parser so the tests do not check the SDK
 * against itself: the gateway continues a trace only when the request carries
 * exactly one `traceparent` header, lowercase version 00 with a non-zero trace
 * id and parent id; anything else (none, two, an uppercase or other-version
 * value, all-zero ids) starts a new trace.
 */
export function gatewayTraceId(rawHeaders: string[]): string {
    const values: string[] = [];
    for (let i = 0; i < rawHeaders.length; i += 2) {
        if (rawHeaders[i]!.toLowerCase() === "traceparent") values.push(rawHeaders[i + 1]!);
    }
    const match = values.length === 1 ? VERSION_00.exec(values[0]!) : null;
    if (match != null && !/^0+$/.test(match[1]!) && !/^0+$/.test(match[2]!)) {
        return match[1]!;
    }
    return randomBytes(16).toString("hex");
}
