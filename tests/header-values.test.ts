/// <reference types="node" />
// One rule for header values the SDK adds (the header provider's, and per-call
// headers on the WebSockets): RFC 9110 field values, ASCII only. A value the
// SDK accepts reaches the server byte-for-byte on every path; a value it
// rejects throws the SDK's TypeError before anything is sent, without the value.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FishAudioClient, RealtimeEvents } from "../src/index.js";
import { startRealtimeServer, type FakeServer } from "./realtimeServer.js";

type Path = "http" | "tts" | "stt";
type Source = "provider" | "call" | "client";

/** Every value a request carried for a header name, without regard to case. */
function valuesIn(rawHeaders: string[], name: string): string[] {
    const values: string[] = [];
    for (let i = 0; i < rawHeaders.length; i += 2) {
        if (rawHeaders[i]!.toLowerCase() === name.toLowerCase()) {
            values.push(rawHeaders[i + 1]!);
        }
    }
    return values;
}

let api: { url: string; requests: IncomingMessage[]; close: () => Promise<void> };
let realtime: FakeServer;

beforeAll(async () => {
    const requests: IncomingMessage[] = [];
    const server: Server = createServer((request, response) => {
        requests.push(request);
        request.resume();
        request.on("end", () => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ items: [], total: 0 }));
        });
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
        requests.push(request);
        wss.handleUpgrade(request, socket, head, (ws) => ws.close(1000));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    api = {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: async () => {
            for (const client of wss.clients) client.terminate();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
    realtime = await startRealtimeServer(async (connection) => {
        await connection.start();
        await connection.until("audio_done");
        connection.done();
    });
});

afterAll(async () => {
    await api.close();
    await realtime.close();
});

/** The raw headers of every request the path's server has received so far. */
function received(path: Path): string[][] {
    return path === "stt" ? realtime.connections.map((c) => c.rawHeaders) : api.requests.map((r) => r.rawHeaders);
}

/**
 * Sends one request on `path` with `headers` from `source` and returns the
 * error the caller got, if any, and the raw headers of what the server
 * received (`undefined` if nothing arrived).
 */
async function send(
    path: Path,
    source: Source,
    headers: Record<string, string>,
    clientHeaders?: Record<string, string>,
): Promise<{ error: unknown; arrived: string[] | undefined }> {
    const before = received(path).length;
    const client = new FishAudioClient({
        apiKey: "test-key",
        baseUrl: path === "stt" ? realtime.url : api.url,
        headers: source === "client" ? headers : clientHeaders,
        headerProvider: source === "provider" ? () => headers : undefined,
    });
    const call = source === "call" ? { headers } : {};
    let error: unknown;
    try {
        if (path === "http") {
            await client.user.get_api_credit(call);
        } else if (path === "tts") {
            const connection = await client.textToSpeech.convertRealtime({ text: "" }, [], "s2-pro", call);
            await new Promise<void>((resolve) => {
                connection.on(RealtimeEvents.CLOSE, () => resolve());
                connection.on(RealtimeEvents.ERROR, () => resolve());
            });
        } else {
            for await (const _ of client.speechToText.convertRealtime({}, [], call)) {
                // drain
            }
        }
    } catch (e) {
        error = e;
    }
    const all = received(path);
    expect(all.length - before).toBeLessThanOrEqual(1);
    return { error, arrived: all.length > before ? all[all.length - 1] : undefined };
}

const KINDS = ["leading or trailing whitespace", "a non-ASCII character", "a control character"] as const;

function expectRejected(
    result: { error: unknown; arrived: string[] | undefined },
    source: Source,
    name: string,
    value: string,
    kind: (typeof KINDS)[number],
): void {
    expect(result.arrived).toBeUndefined();
    expect(result.error).toBeInstanceOf(TypeError);
    const prefix = {
        provider: "headerProvider returned",
        call: "requestOptions.headers has",
        client: "the client's headers have",
    }[source];
    // The whole message is fixed text plus the header name, so no part of the value is in it.
    expect((result.error as TypeError).message).toBe(`${prefix} a value with ${kind} for header ${JSON.stringify(name)}`);
    expect(String(result.error)).not.toContain(value);
}

function expectSent(result: { error: unknown; arrived: string[] | undefined }, name: string, value: string): void {
    expect(result.arrived).toBeDefined();
    expect(valuesIn(result.arrived!, name)).toEqual([value]);
}

// A value made to look like a credential, so the tests can see that no part of it leaks.
const SECRET = "sk-Secret0123";

const CASES: Array<[label: string, value: string, kind: (typeof KINDS)[number]]> = [
    ["Latin-1 non-ASCII", `${SECRET}café`, "a non-ASCII character"],
    ["non-Latin-1", `${SECRET}日本`, "a non-ASCII character"],
    ["a leading space", ` ${SECRET}`, "leading or trailing whitespace"],
    ["a trailing space", `${SECRET} `, "leading or trailing whitespace"],
    ["a leading tab", `\t${SECRET}`, "leading or trailing whitespace"],
    ["DEL", `${SECRET}\x7fb`, "a control character"],
    ["\\x01", `${SECRET}\x01b`, "a control character"],
    ["NUL", `${SECRET}\x00b`, "a control character"],
    ["CR LF", `${SECRET}\r\nInjected: yes`, "a control character"],
    ["LF", `${SECRET}\nb`, "a control character"],
];

const ROUTES: Array<[Source, Path]> = [
    ["provider", "http"],
    ["provider", "tts"],
    ["provider", "stt"],
    ["call", "tts"],
    ["call", "stt"],
    // The TTS handshake sends the client's headers only since the header
    // provider was added, so they follow the same rule there.
    ["client", "tts"],
];

describe.each(ROUTES)("header values from the %s on %s", (source, path) => {
    it.each(CASES)("a value with %s throws the SDK's TypeError and sends nothing", async (_, value, kind) => {
        expectRejected(await send(path, source, { "x-probe": value }), source, "x-probe", value, kind);
    });

    it.each([
        ["an empty value", ""],
        ["visible ASCII", SECRET],
        ["inner spaces and tabs", `a b\tc  d`],
        ["every visible ASCII character", Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)).join("")],
    ])("%s is sent byte-for-byte", async (_, value) => {
        expectSent(await send(path, source, { "x-probe": value }), "x-probe", value);
    });
});

// One problem is reported, by a fixed precedence wherever it is in the value:
// a control character, then a non-ASCII character, then leading or trailing
// whitespace.
const MIXED: Array<[label: string, value: string, kind: (typeof KINDS)[number]]> = [
    ["all three", ` ${SECRET}é\x01 `, "a control character"],
    ["non-ASCII and edge whitespace", ` ${SECRET}é `, "a non-ASCII character"],
    ["control and edge whitespace", `\t${SECRET}\n`, "a control character"],
    ["control after non-ASCII", `${SECRET}日\x7f`, "a control character"],
    ["non-Latin-1 and a trailing tab", `${SECRET}日本\t`, "a non-ASCII character"],
];

describe.each(ROUTES)("a value with several problems from the %s on %s", (source, path) => {
    it.each(MIXED)("%s: reports the first by precedence", async (_, value, kind) => {
        expectRejected(await send(path, source, { "x-probe": value }), source, "x-probe", value, kind);
    });
});

describe("the client's User-Agent on the TTS handshake", () => {
    it("is not checked: it was sent before the header provider existed, appended to the SDK's", async () => {
        const result = await send("tts", "client", { "User-Agent": "my-app café" });
        expect(result.error).toBeUndefined();
        expect(valuesIn(result.arrived!, "user-agent")[0]).toMatch(/ my-app café$/);
    });
});

describe.each(["http", "tts", "stt"] as Path[])("on %s, a header the provider may not set", (path) => {
    it("is skipped whatever its value, without an error", async () => {
        const result = await send(
            path,
            "provider",
            {
                Authorization: "a\r\nb",
                model: "日本",
                "User-Agent": " x",
                "Sec-WebSocket-Key": "\x00",
                "x-client": "a\nb",
                traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            },
            { "x-client": "c" },
        );
        expect(result.error).toBeUndefined();
        expect(valuesIn(result.arrived!, "authorization")).toEqual(["Bearer test-key"]);
        expect(valuesIn(result.arrived!, "x-client")).toEqual(["c"]);
        expect(valuesIn(result.arrived!, "traceparent")).toEqual(["00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"]);
    });
});

describe.each(ROUTES)("every code unit 0x00-0xFF from the %s on %s", (source, path) => {
    it("is either sent exactly or rejected by the SDK before sending", async () => {
        const before = received(path).length;
        for (let code = 0; code <= 0xff; code++) {
            const c = String.fromCharCode(code);
            for (const [position, value] of [
                ["start", `${c}${SECRET}`],
                ["middle", `sk-Secret${c}0123`],
                ["end", `${SECRET}${c}`],
            ] as const) {
                const visible = code >= 0x21 && code <= 0x7e;
                const innerWhitespace = (code === 0x20 || code === 0x09) && position === "middle";
                const result = await send(path, source, { "x-probe": value });
                if (visible || innerWhitespace) {
                    expect(result.error, `0x${code.toString(16)} at ${position}`).toBeUndefined();
                    expectSent(result, "x-probe", value);
                } else {
                    const kind =
                        code === 0x20 || code === 0x09
                            ? "leading or trailing whitespace"
                            : code >= 0x80
                              ? "a non-ASCII character"
                              : "a control character";
                    expectRejected(result, source, "x-probe", value, kind);
                }
            }
        }
        // 94 visible characters in 3 positions, and space and tab in the middle.
        expect(received(path).length - before).toBe(94 * 3 + 2);
    }, 120_000);
});

