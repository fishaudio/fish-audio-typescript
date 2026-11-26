/// <reference types="node" />
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { FishAudioClient, FishAudioError, RealtimeEvents, type HeaderProvider } from "../src/index.js";
import { SDK_USER_AGENT } from "../src/core/userAgent.js";
import { startRealtimeServer, type FakeServer } from "./realtimeServer.js";
import { childSdk } from "./childProcess.js";

const TRACE_A = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE_B = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

const traces = new AsyncLocalStorage<string>();
const fromStorage: HeaderProvider = () => ({ traceparent: traces.getStore() });
const traceFor = (i: number) => `00-${i.toString(16).padStart(32, "0")}-00f067aa0ba902b7-01`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Every value a request carries for a header name, compared without regard to case. */
function headerValues(request: IncomingMessage, name: string): string[] {
    const values: string[] = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
        if (request.rawHeaders[i]!.toLowerCase() === name.toLowerCase()) {
            values.push(request.rawHeaders[i + 1]!);
        }
    }
    return values;
}

/**
 * A fake API that records every request, answers with `status`, and accepts
 * WebSocket upgrades (closing each at once).
 */
async function fakeApi(status = 200): Promise<{ url: string; requests: IncomingMessage[] }> {
    const requests: IncomingMessage[] = [];
    const server: Server = createServer((request, response) => {
        requests.push(request);
        request.resume();
        request.on("end", () => {
            response.statusCode = status;
            if (request.url?.startsWith("/v1/tts") && status === 200) {
                response.setHeader("Content-Type", "audio/mpeg");
                response.end(Buffer.from([1, 2, 3]));
                return;
            }
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(status === 200 ? { items: [], total: 0 } : { detail: "nope" }));
        });
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
        requests.push(request);
        wss.handleUpgrade(request, socket, head, (ws) => ws.close(1000));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
        for (const client of wss.clients) client.terminate();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, requests };
}

async function realtimeServer(): Promise<FakeServer> {
    const server = await startRealtimeServer(async (connection) => {
        await connection.start();
        await connection.until("audio_done");
        connection.done();
    });
    cleanups.push(() => server.close());
    return server;
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const _ of stream) {
        // drain
    }
}

async function ttsHandshake(client: FishAudioClient, ...rest: unknown[]): Promise<void> {
    const connection = await (client.textToSpeech.convertRealtime as (...args: unknown[]) => Promise<any>)(
        { text: "" },
        [],
        ...rest,
    );
    await new Promise<void>((resolve) => {
        connection.on(RealtimeEvents.CLOSE, () => resolve());
        connection.on(RealtimeEvents.ERROR, () => resolve());
    });
}

describe("header provider on HTTP requests", () => {
    it("every endpoint gets it once, read from the caller's AsyncLocalStorage", async () => {
        const api = await fakeApi();
        let calls = 0;
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: api.url,
            headerProvider: () => {
                calls += 1;
                return fromStorage();
            },
        });

        await traces.run(TRACE_A, async () => {
            await client.voices.search();
            await client.voices.get("voice-id");
            await client.user.get_api_credit();
            await client.textToSpeech.convert({ text: "hi" });
            await client.speechToText.convert({ audio: new Blob([Uint8Array.of(1, 2)]) } as never).catch(() => {});
        });

        expect(api.requests.length).toBe(5);
        expect(calls).toBe(5);
        for (const request of api.requests) {
            expect(headerValues(request, "traceparent"), `${request.method} ${request.url}`).toEqual([TRACE_A]);
            expect(headerValues(request, "authorization")).toEqual(["Bearer test-key"]);
        }
    });

    it("is called again for every retry, at the moment of that attempt", async () => {
        const api = await fakeApi(500);
        let calls = 0;
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: api.url,
            headerProvider: () => ({ traceparent: traceFor(++calls) }),
        });

        await expect(client.voices.search({}, { maxRetries: 2 })).rejects.toBeInstanceOf(FishAudioError);

        expect(calls).toBe(3);
        expect(api.requests.map((request) => headerValues(request, "traceparent"))).toEqual([
            [traceFor(1)],
            [traceFor(2)],
            [traceFor(3)],
        ]);
    }, 20_000);

    it("concurrent calls each send their own context's value", async () => {
        const api = await fakeApi();
        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: api.url, headerProvider: fromStorage });

        await Promise.all(
            Array.from({ length: 32 }, (_, i) =>
                traces.run(traceFor(i), async () => {
                    await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
                    await client.user.get_api_credit({ headers: { "x-call": String(i) } });
                }),
            ),
        );

        expect(api.requests.length).toBe(32);
        for (const request of api.requests) {
            const [call] = headerValues(request, "x-call");
            expect(headerValues(request, "traceparent")).toEqual([traceFor(Number(call))]);
        }
    });

    it("per-call and client headers win; SDK headers cannot be replaced", async () => {
        const api = await fakeApi();
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: api.url,
            headers: { "X-Request-Id": "static" },
            headerProvider: () => ({
                traceparent: TRACE_A,
                baggage: "k=v",
                "x-request-id": "dynamic",
                authorization: "Bearer stolen",
                Authorization: "Bearer stolen",
                model: "s1",
                "User-Agent": "evil/1",
                "content-type": "text/plain",
                "Content-Length": "1",
                Host: "example.com",
                Connection: "close",
                "Sec-WebSocket-Key": "x",
            }),
        });

        await client.textToSpeech.convert({ text: "hi" }, "s2-pro", { headers: { TraceParent: TRACE_B } });

        const request = api.requests[0]!;
        expect(headerValues(request, "traceparent")).toEqual([TRACE_B]);
        expect(headerValues(request, "baggage")).toEqual(["k=v"]);
        expect(headerValues(request, "x-request-id")).toEqual(["static"]);
        expect(headerValues(request, "authorization")).toEqual(["Bearer test-key"]);
        expect(headerValues(request, "model")).toEqual(["s2-pro"]);
        expect(headerValues(request, "user-agent")).toEqual([SDK_USER_AGENT]);
        expect(headerValues(request, "content-type")).toEqual(["application/msgpack"]);
        expect(headerValues(request, "host")).not.toEqual(["example.com"]);
        expect(headerValues(request, "sec-websocket-key")).toEqual([]);
    });

    it.each([undefined, null, {}, { traceparent: undefined }, { traceparent: null }])(
        "returning %j adds nothing",
        async (result) => {
            const api = await fakeApi();
            const client = new FishAudioClient({
                apiKey: "test-key",
                baseUrl: api.url,
                headerProvider: () => result as ReturnType<HeaderProvider>,
            });
            await client.user.get_api_credit();
            expect(headerValues(api.requests[0]!, "traceparent")).toEqual([]);
        },
    );

    it("an error it throws reaches the caller unchanged, and nothing is sent", async () => {
        const api = await fakeApi();
        const error = new Error("tracer is down");
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: api.url,
            headerProvider: () => {
                throw error;
            },
        });

        await expect(client.textToSpeech.convert({ text: "hi" })).rejects.toBe(error);
        await expect(client.user.get_api_credit()).rejects.toBe(error);
        expect(api.requests).toEqual([]);
    });

    it.each([
        ["a promise", () => Promise.resolve({ traceparent: TRACE_A })],
        ["an array", () => ["traceparent", TRACE_A]],
        ["a string", () => TRACE_A],
        ["a number value", () => ({ traceparent: 1 })],
        ["a value with a line break", () => ({ traceparent: "a\r\nInjected: yes" })],
        ["an invalid name", () => ({ "bad name": "x" })],
    ])("returning %s fails with TypeError before sending", async (_, provider) => {
        const api = await fakeApi();
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: api.url,
            headerProvider: provider as unknown as HeaderProvider,
        });

        const error = await client.user.get_api_credit().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(TypeError);
        expect(String(error)).not.toContain("Injected");
        expect(api.requests).toEqual([]);
    });

    it("must be a function", () => {
        expect(
            () => new FishAudioClient({ apiKey: "k", headerProvider: { traceparent: TRACE_A } as unknown as HeaderProvider }),
        ).toThrow(TypeError);
    });

    it("without one nothing changes", async () => {
        const api = await fakeApi();
        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: api.url });
        await client.user.get_api_credit();
        expect(headerValues(api.requests[0]!, "traceparent")).toEqual([]);
    });
});

describe("header provider on the TTS WebSocket", () => {
    it("adds its headers to the handshake, with per-call and client headers winning", async () => {
        const api = await fakeApi();
        let calls = 0;
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: api.url,
            headers: { "x-client": "c" },
            headerProvider: () => {
                calls += 1;
                return { traceparent: traces.getStore(), baggage: "k=v", Authorization: "Bearer stolen", "x-client": "p" };
            },
        });

        await traces.run(TRACE_A, () => ttsHandshake(client, "s2-pro", { headers: { "x-call": "1" } }));
        await traces.run(TRACE_A, () => ttsHandshake(client, "s2-pro", { headers: { Baggage: "k=call" } }));

        expect(calls).toBe(2);
        const [first, second] = api.requests;
        expect(first!.url).toBe("/v1/tts/live");
        expect(headerValues(first!, "traceparent")).toEqual([TRACE_A]);
        expect(headerValues(first!, "baggage")).toEqual(["k=v"]);
        expect(headerValues(first!, "x-call")).toEqual(["1"]);
        expect(headerValues(first!, "x-client")).toEqual(["c"]);
        expect(headerValues(first!, "authorization")).toEqual(["Bearer test-key"]);
        expect(headerValues(first!, "model")).toEqual(["s2-pro"]);
        expect(headerValues(first!, "user-agent")).toEqual([SDK_USER_AGENT]);
        expect(headerValues(second!, "baggage")).toEqual(["k=call"]);
    });

    it("an error it throws rejects convertRealtime unchanged, before connecting", async () => {
        const api = await fakeApi();
        const error = new Error("no span");
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: api.url,
            headerProvider: () => {
                throw error;
            },
        });

        await expect(client.textToSpeech.convertRealtime({ text: "" }, [])).rejects.toBe(error);
        expect(api.requests).toEqual([]);
    });
});

describe("header provider on the realtime STT WebSocket", () => {
    it("adds its headers to the handshake, with per-call headers winning", async () => {
        const server = await realtimeServer();
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: server.url,
            headerProvider: () => ({ traceparent: traces.getStore(), "x-request-id": "p", model: "other" }),
        });

        await traces.run(TRACE_B, () => drain(client.speechToText.convertRealtime({}, [])));
        await traces.run(TRACE_B, () =>
            drain(client.speechToText.convertRealtime({}, [], { headers: { "X-Request-Id": "call", traceparent: TRACE_A } })),
        );

        const [first, second] = server.connections;
        expect(first!.headerValues("traceparent")).toEqual([TRACE_B]);
        expect(first!.headerValues("x-request-id")).toEqual(["p"]);
        expect(first!.headerValues("model")).toEqual(["transcribe-stream-1"]);
        expect(first!.headerValues("authorization")).toEqual(["Bearer test-key"]);
        expect(second!.headerValues("traceparent")).toEqual([TRACE_A]);
        expect(second!.headerValues("x-request-id")).toEqual(["call"]);
    });

    it("concurrent sessions each send their own context's value", async () => {
        const server = await realtimeServer();
        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: server.url, headerProvider: fromStorage });

        await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                traces.run(traceFor(i), () =>
                    drain(client.speechToText.convertRealtime({}, [], { headers: { "x-call": String(i) } })),
                ),
            ),
        );

        expect(server.connections.length).toBe(8);
        for (const connection of server.connections) {
            const [call] = connection.headerValues("x-call");
            expect(connection.headerValues("traceparent")).toEqual([traceFor(Number(call))]);
        }
    });

    it("an error it throws ends the stream with that error, before connecting", async () => {
        const server = await realtimeServer();
        const error = new Error("no span");
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: server.url,
            headerProvider: () => {
                throw error;
            },
        });

        await expect(drain(client.speechToText.convertRealtime({}, []))).rejects.toBe(error);
        expect(server.connections).toEqual([]);
    });
});

describe("an async header provider", () => {
    // In a separate process: there an unhandled rejection ends Node with exit
    // code 1 (the default since Node 15), which the test runner would hide.
    const CALLS = {
        HTTP: "await client.user.get_api_credit({ maxRetries: 0 })",
        "TTS WebSocket": 'await client.textToSpeech.convertRealtime({ text: "" }, [])',
        "STT WebSocket": "for await (const _ of client.speechToText.convertRealtime({}, [])) {}",
    };

    it.each(Object.entries(CALLS))(
        "that rejects: on %s the caller catches the TypeError and the process exits normally",
        async (_, call) => {
            const child = await childSdk();
            try {
                const result = await child.run(`
                    const client = new sdk.FishAudioClient({
                        apiKey: "test-key",
                        baseUrl: "http://127.0.0.1:9",
                        headerProvider: async () => { throw new Error("provider-rejection"); },
                    });
                    (async () => {
                        try {
                            ${call};
                            console.log("no error");
                        } catch (error) {
                            console.log("caught " + error.name + ": " + error.message);
                        }
                        // Time for an unhandled rejection to surface and end the process.
                        await new Promise((resolve) => setTimeout(resolve, 100));
                        console.log("still running");
                    })();
                `);
                expect(result).toEqual({
                    code: 0,
                    stdout: "caught TypeError: headerProvider must return headers synchronously, not a promise\nstill running\n",
                    stderr: "",
                });
            } finally {
                await child.close();
            }
        },
        30_000,
    );
});

describe("a header named in the client's or per-call headers wins over the provider, even when removed", () => {
    const provider: HeaderProvider = () => ({ traceparent: TRACE_A, "x-other": "p" });

    it.each([
        ["per-call null", {}, { traceparent: null }],
        ["per-call undefined", {}, { traceparent: undefined }],
        ["per-call supplier returning null", {}, { traceparent: () => null }],
        ["client null", { traceparent: null }, {}],
        ["client undefined", { traceparent: undefined }, {}],
        ["client value, per-call null", { traceparent: TRACE_B }, { traceparent: null }],
    ])("HTTP, %s: no traceparent is sent", async (_, clientHeaders, callHeaders) => {
        const api = await fakeApi();
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: api.url,
            headers: clientHeaders as Record<string, string | null | undefined>,
            headerProvider: provider,
        });
        await client.user.get_api_credit({ headers: callHeaders as Record<string, string | null | undefined> });
        await client.textToSpeech.convert({ text: "hi" }, "s2-pro", {
            headers: callHeaders as Record<string, string | null | undefined>,
        });
        expect(api.requests.length).toBe(2);
        for (const request of api.requests) {
            expect(headerValues(request, "traceparent")).toEqual([]);
            expect(headerValues(request, "x-other")).toEqual(["p"]);
        }
    });

    it.each([
        ["per-call null", {}, { TraceParent: null }],
        ["per-call undefined", {}, { traceparent: undefined }],
        ["client null", { traceparent: null }, {}],
        ["client value, per-call null", { traceparent: TRACE_B }, { traceparent: null }],
    ])("both WebSocket handshakes, %s: no traceparent is sent", async (_, clientHeaders, callHeaders) => {
        const api = await fakeApi();
        const server = await realtimeServer();
        const options = {
            apiKey: "test-key",
            headers: clientHeaders as Record<string, string | null | undefined>,
            headerProvider: provider,
        };
        const call = { headers: callHeaders as Record<string, string | null | undefined> };
        await ttsHandshake(new FishAudioClient({ ...options, baseUrl: api.url }), "s2-pro", call);
        await drain(new FishAudioClient({ ...options, baseUrl: server.url }).speechToText.convertRealtime({}, [], call));
        const handshakes = [api.requests[0]!.rawHeaders, server.connections[0]!.rawHeaders];
        for (const rawHeaders of handshakes) {
            const names = rawHeaders.filter((_, i) => i % 2 === 0).map((name) => name.toLowerCase());
            expect(names).not.toContain("traceparent");
            expect(names).toContain("x-other");
        }
    });
});

type Headers = Record<string, string | (() => string | null) | null | undefined>;

/** Every HTTP path type: GET JSON, GET with a query, POST JSON streaming audio back, multipart upload. */
const HTTP_CALLS: Record<string, (client: FishAudioClient, headers: Headers) => Promise<unknown>> = {
    "GET JSON": (client, headers) => client.user.get_api_credit({ headers }),
    "GET with query": (client, headers) => client.voices.search(undefined, { headers }),
    "POST JSON, streamed response": async (client, headers) => {
        await new Response(await client.textToSpeech.convert({ text: "hi" }, "s2-pro", { headers })).arrayBuffer();
    },
    "multipart upload": (client, headers) =>
        client.speechToText.convert({ audio: new File([Uint8Array.of(1)], "a.wav") }, { headers }).catch(() => {}),
};

describe("HTTP: client and per-call header names are merged without regard to case", () => {
    it.each(Object.entries(HTTP_CALLS))("%s", async (_, call) => {
        const api = await fakeApi();
        const cases: Array<[client: Headers, perCall: Headers, expected: string[]]> = [
            // Different casing: the later source replaces or removes the earlier one.
            [{ TraceParent: TRACE_A }, { traceparent: TRACE_B }, [TRACE_B]],
            [{ TraceParent: TRACE_A }, { traceparent: null }, []],
            [{ traceparent: TRACE_A }, { TRACEPARENT: undefined }, []],
            // Same casing: unchanged.
            [{ traceparent: TRACE_A }, { traceparent: TRACE_B }, [TRACE_B]],
            [{ traceparent: TRACE_A }, { traceparent: null }, []],
            [{ traceparent: TRACE_A }, {}, [TRACE_A]],
            [{}, { traceparent: TRACE_B }, [TRACE_B]],
        ];
        for (const [clientHeaders, perCall] of cases) {
            const client = new FishAudioClient({ apiKey: "test-key", baseUrl: api.url, headers: clientHeaders });
            await call(client, perCall);
        }
        expect(api.requests.length).toBe(cases.length);
        cases.forEach(([, , expected], i) => {
            expect(headerValues(api.requests[i]!, "traceparent"), `case ${i}`).toEqual(expected);
            expect(headerValues(api.requests[i]!, "authorization"), `case ${i}`).toEqual(["Bearer test-key"]);
        });
    });

    it("a client header spelled differently from the SDK's Authorization does not add a second one", async () => {
        const api = await fakeApi();
        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: api.url, headers: { authorization: "Bearer other" } });
        await client.user.get_api_credit();
        await client.user.get_api_credit({ apiKey: "call-key" });
        expect(headerValues(api.requests[0]!, "authorization")).toEqual(["Bearer test-key"]);
        expect(headerValues(api.requests[1]!, "authorization")).toEqual(["Bearer call-key"]);
    });
});

describe("WebSockets: a client header that a per-call header replaces or removes is never resolved", () => {
    const throwing = () => {
        supplierCalls += 1;
        throw new Error("client supplier must not run");
    };
    let supplierCalls = 0;

    it.each([
        ["removed", { traceparent: null }, []],
        ["replaced in another casing", { TraceParent: TRACE_B }, [TRACE_B]],
    ] as const)("%s: TTS and STT connect, the supplier is not called", async (_, perCall, expected) => {
        supplierCalls = 0;
        const api = await fakeApi();
        const server = await realtimeServer();
        const options = { apiKey: "test-key", headers: { traceparent: throwing } as Headers, headerProvider: () => ({ traceparent: TRACE_A }) };
        const call = { headers: perCall as Headers };
        await ttsHandshake(new FishAudioClient({ ...options, baseUrl: api.url }), "s2-pro", call);
        await drain(new FishAudioClient({ ...options, baseUrl: server.url }).speechToText.convertRealtime({}, [], call));
        expect(supplierCalls).toBe(0);
        expect(headerValues(api.requests[0]!, "traceparent")).toEqual(expected);
        expect(server.connections[0]!.headerValues("traceparent")).toEqual(expected);
    });

    it.each([
        ["removed", { "x-meta": null }, []],
        ["replaced in another casing", { "X-Meta": "ok" }, ["ok"]],
    ] as const)("TTS: an invalid client value that is %s does not throw", async (_, perCall, expected) => {
        const api = await fakeApi();
        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: api.url, headers: { "x-meta": "café" } });
        await ttsHandshake(client, "s2-pro", { headers: perCall });
        expect(headerValues(api.requests[0]!, "x-meta")).toEqual(expected);
    });

    it("TTS: an invalid client value that is sent still throws", async () => {
        const api = await fakeApi();
        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: api.url, headers: { "x-meta": "café" } });
        await expect(client.textToSpeech.convertRealtime({ text: "" }, [])).rejects.toThrow(
            `the client's headers have a value with a non-ASCII character for header "x-meta"`,
        );
        expect(api.requests).toEqual([]);
    });
});

describe("a client header value that is a promise and loses to another source", () => {
    // In a separate process, as for async providers: a promise the SDK drops
    // without a handler would end Node with an unhandled rejection when it
    // later rejects. The SDK neither awaits nor uses it; it only handles the rejection.
    const VARIANTS = {
        "two spellings in the client's headers": ['{ "X-Context": later, "x-context": "override" }', "{}"],
        "replaced per call in another casing": ['{ "X-Context": later }', '{ "x-context": "override" }'],
        "replaced per call in the same casing": ['{ "X-Context": later }', '{ "X-Context": "override" }'],
        "replaced by the SDK's Authorization": ["{ Authorization: later }", "{}"],
    };
    const PATHS = {
        // A short timeout: a failed fetch leaves the SDK's timeout timer running
        // (a separate issue), which would keep the process alive that long.
        HTTP: "await client.user.get_api_credit({ headers: perCall, maxRetries: 0, timeoutInSeconds: 0.3 }).catch(() => {});",
        "TTS WebSocket": `
            const connection = await client.textToSpeech.convertRealtime({ text: "" }, [], "s2-pro", { headers: perCall });
            await new Promise((resolve) => { connection.on("error", resolve); connection.on("close", resolve); });`,
        "STT WebSocket": `
            try { for await (const _ of client.speechToText.convertRealtime({}, [], { headers: perCall })) {} } catch {}`,
    };
    const cases = Object.entries(PATHS).flatMap(([path, call]) =>
        Object.entries(VARIANTS).map(([variant, [clientHeaders, perCall]]) => [path, variant, call, clientHeaders, perCall] as const),
    );

    it.each(cases)("%s, %s: the process exits normally", async (_, __, call, clientHeaders, perCall) => {
        const child = await childSdk();
        try {
            const result = await child.run(`
                const later = new Promise((_, reject) => setTimeout(() => reject(new Error("discarded-rejection")), 20));
                const client = new sdk.FishAudioClient({ apiKey: "test-key", baseUrl: "http://127.0.0.1:9", headers: ${clientHeaders} });
                const perCall = ${perCall};
                (async () => {
                    ${call}
                    console.log("done");
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    console.log("still running");
                })();
            `);
            expect(result).toEqual({ code: 0, stdout: "done\nstill running\n", stderr: "" });
        } finally {
            await child.close();
        }
    }, 30_000);
});

describe("null removes a header the SDK sets, too", () => {
    it.each([
        ["per-call Content-Type: null", {}, { "Content-Type": null }],
        ["per-call content-type: null", {}, { "content-type": null }],
        ["client Content-Type: null", { "Content-Type": null }, {}],
    ])("HTTP TTS, %s: no Content-Type is sent", async (_, clientHeaders, perCall) => {
        const api = await fakeApi();
        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: api.url, headers: clientHeaders as Headers });
        await client.textToSpeech.convert({ text: "hi" }, "s2-pro", { headers: perCall as Headers }).catch(() => {});
        expect(headerValues(api.requests[0]!, "content-type")).toEqual([]);
    });

    it("HTTP TTS without null keeps application/msgpack", async () => {
        const api = await fakeApi();
        await new FishAudioClient({ apiKey: "test-key", baseUrl: api.url }).textToSpeech.convert({ text: "hi" }, "s2-pro");
        expect(headerValues(api.requests[0]!, "content-type")).toEqual(["application/msgpack"]);
    });

    it("Authorization and model: per-call null removes them on HTTP and both handshakes", async () => {
        const api = await fakeApi();
        const server = await realtimeServer();
        const perCall = { headers: { authorization: null, Model: null } as Headers };
        await new FishAudioClient({ apiKey: "test-key", baseUrl: api.url }).textToSpeech.convert({ text: "hi" }, "s2-pro", perCall);
        await ttsHandshake(new FishAudioClient({ apiKey: "test-key", baseUrl: api.url }), "s2-pro", perCall);
        await drain(new FishAudioClient({ apiKey: "test-key", baseUrl: server.url }).speechToText.convertRealtime({}, [], perCall)).catch(() => {});
        const sent = [api.requests[0]!.rawHeaders, api.requests[1]!.rawHeaders, server.connections[0]?.rawHeaders ?? []];
        for (const rawHeaders of sent) {
            const names = rawHeaders.filter((_, i) => i % 2 === 0).map((name) => name.toLowerCase());
            expect(names).not.toContain("authorization");
            expect(names).not.toContain("model");
        }
    });
});
