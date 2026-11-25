/// <reference types="node" />
import { decode } from "@msgpack/msgpack";
import { createServer } from "node:net";
import { getEventListeners } from "node:events";
import { runInNewContext } from "node:vm";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
    FishAudioClient,
    FishAudioError,
    RealtimeSTTError,
    UnauthorizedError,
    type RealtimeSTTAudioInput,
    type RealtimeSTTEvent,
    type RealtimeSTTRequest,
    type RealtimeSTTStream,
} from "../src/index.js";
import {
    buildConfigMessage,
    decodeServerEvent,
    encodeClientMessage,
} from "../src/client/websocket/RealtimeSTTStream.js";
import { encode } from "@msgpack/msgpack";
import { startRealtimeServer, type FakeConnection, type FakeServer, type Message } from "./realtimeServer.js";
import { SDK_USER_AGENT } from "../src/core/userAgent.js";

const servers: FakeServer[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(
    handler: (connection: FakeConnection) => void | Promise<void>,
    options?: { refuse?: { status: number; body?: string } },
): Promise<FakeServer> {
    const server = await startRealtimeServer(handler, options);
    servers.push(server);
    return server;
}

function transcribe(
    server: { url: string },
    audio: Iterable<RealtimeSTTAudioInput> | AsyncIterable<RealtimeSTTAudioInput>,
    request: RealtimeSTTRequest = {},
    abortSignal?: AbortSignal,
): RealtimeSTTStream {
    const client = new FishAudioClient({ apiKey: "test-key", baseUrl: server.url });
    return client.speechToText.convertRealtime(request, audio, abortSignal ? { abortSignal } : {});
}

async function collect(stream: AsyncIterable<RealtimeSTTEvent>): Promise<RealtimeSTTEvent[]> {
    const events: RealtimeSTTEvent[] = [];
    for await (const event of stream) {
        events.push(event);
    }
    return events;
}

/** Reads the stream to its end and returns the error it throws. */
async function failure(stream: AsyncIterable<RealtimeSTTEvent>): Promise<{ events: RealtimeSTTEvent[]; error: any }> {
    const events: RealtimeSTTEvent[] = [];
    try {
        for await (const event of stream) {
            events.push(event);
        }
    } catch (error) {
        return { events, error };
    }
    throw new Error(`the stream ended without an error after ${events.length} events`);
}

function within<T>(ms: number, promise: Promise<T>, what = "promise"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pcm = (fill: number, bytes = 1280) => new Uint8Array(bytes).fill(fill);

/** An audio source that never yields, like a muted microphone. */
async function* silentMicrophone(): AsyncGenerator<Uint8Array> {
    await new Promise(() => {});
}

/** A live audio source: one chunk every few milliseconds until the consumer stops it. */
async function* liveMicrophone(onClosed?: () => void): AsyncGenerator<Uint8Array> {
    try {
        for (;;) {
            yield pcm(1);
            await sleep(5);
        }
    } finally {
        onClosed?.();
    }
}

/** Collects errors that escape to the process instead of reaching the stream. */
async function escaped(run: () => Promise<void>): Promise<unknown[]> {
    const errors: unknown[] = [];
    const onError = (error: unknown) => errors.push(error);
    process.on("uncaughtException", onError);
    process.on("unhandledRejection", onError);
    try {
        await run();
        await sleep(30);
    } finally {
        process.off("uncaughtException", onError);
        process.off("unhandledRejection", onError);
    }
    return errors;
}

const committed = (text: string, extra: Message = {}): Message => ({
    type: "committed",
    turn_index: 0,
    text,
    audio_start_ms: 0,
    audio_end_ms: 1000,
    reason: "eot",
    degraded: false,
    user_turn: true,
    turn_kind: "user",
    ...extra,
});

const draft = (text: string): Message => ({ type: "draft", turn_index: 0, text, settled_text: "", audio_ms: 100 });

const errorMessage = (errorType: string, code: number, recoverable: boolean): Message => ({
    type: "error",
    code,
    error_type: errorType,
    message: `${errorType} happened`,
    request_id: "req_test",
    recoverable,
});

describe("realtime STT encoding", () => {
    it("config defaults send only the audio format", () => {
        expect(buildConfigMessage({})).toEqual({
            type: "config",
            audio: { format: "pcm_s16le", sample_rate: 16000, channels: 1 },
        });
    });

    it("config carries every option", () => {
        expect(
            buildConfigMessage({
                sample_rate: 48000,
                turn_detection: { mode: "vad", silence_timeout_ms: 900 },
                results: {
                    drafts: true,
                    ignore_timestamps: false,
                    diarize: false,
                    tag_audio_events: false,
                    vad_events: true,
                    eot_events: true,
                },
                context: {
                    history: [{ role: "assistant", text: "Which day works for you?" }],
                    terms: ["Fish Audio"],
                },
                client_reference_id: "call-42",
            }),
        ).toEqual({
            type: "config",
            audio: { format: "pcm_s16le", sample_rate: 48000, channels: 1 },
            turn_detection: { mode: "vad", silence_timeout_ms: 900 },
            results: {
                drafts: true,
                ignore_timestamps: false,
                diarize: false,
                tag_audio_events: false,
                vad_events: true,
                eot_events: true,
            },
            context: {
                history: [{ role: "assistant", text: "Which day works for you?" }],
                terms: ["Fish Audio"],
            },
            client_reference_id: "call-42",
        });
    });

    it("top-level settings win over nested ones and keep the rest", () => {
        const request: RealtimeSTTRequest = {
            turn_detection: "auto",
            eager: true,
            drafts: true,
            diarize: false,
            terms: ["Fish Audio"],
            results: { drafts: false, vad_events: true },
            context: { terms: ["ignored"], history: [{ role: "user", text: "hi" }] },
        };
        const before = structuredClone(request);

        expect(buildConfigMessage(request)).toEqual({
            type: "config",
            audio: { format: "pcm_s16le", sample_rate: 16000, channels: 1 },
            turn_detection: { mode: "auto", eager: true },
            results: { drafts: true, diarize: false, vad_events: true },
            context: { terms: ["Fish Audio"], history: [{ role: "user", text: "hi" }] },
        });
        expect(request).toEqual(before);
    });

    it("audio is packed as MessagePack bin, also from a Buffer", () => {
        for (const data of [Uint8Array.of(1, 2, 3), Buffer.from([1, 2, 3])]) {
            const frame = encodeClientMessage({ type: "audio", data });
            // fixmap(2), "type", "audio", "data", then bin 8 (0xc4) with length 3.
            expect(Buffer.from(frame).subarray(-5)).toEqual(Buffer.from([0xc4, 3, 1, 2, 3]));
        }
    });

    it("leaves out undefined fields instead of sending nil", () => {
        const frame = encodeClientMessage({ type: "configure", results: { drafts: undefined, diarize: false } });
        expect(decode(frame)).toEqual({ type: "configure", results: { diarize: false } });
    });
});

describe("realtime STT decoding", () => {
    it("decodes a committed turn with its fields", () => {
        const event = decodeServerEvent(encode({ seq: 6, ...committed("Hello.", { language_code: "en" }) }));
        expect(event).toEqual({ seq: 6, ...committed("Hello.", { language_code: "en" }) });
    });

    it("treats a committed turn without user_turn as the user's", () => {
        const message = committed("Hello.");
        delete message.user_turn;
        const event = decodeServerEvent(encode(message));
        expect(event?.type === "committed" && event.user_turn).toBe(true);
    });

    it("keeps fields it does not know", () => {
        const event = decodeServerEvent(encode({ ...draft("hi"), seq: 1, added_in_v2: [1, 2] }));
        expect(event).toMatchObject({ type: "draft", added_in_v2: [1, 2] });
    });

    it("ignores unknown message types and unreadable frames", () => {
        expect(decodeServerEvent(encode({ type: "added_in_v2", seq: 1 }))).toBeUndefined();
        expect(decodeServerEvent(encode("not a map"))).toBeUndefined();
        expect(decodeServerEvent(Uint8Array.of(0xc1))).toBeUndefined();
    });
});

describe("realtime STT session", () => {
    it("sends config first, audio only after session_started, and yields typed events", async () => {
        const server = await serve(async (connection) => {
            const config = await connection.next();
            expect(config).toEqual({
                type: "config",
                audio: { format: "pcm_s16le", sample_rate: 24000, channels: 1 },
                results: { drafts: true },
            });
            // Audio must wait for session_started.
            await sleep(50);
            expect(connection.received).toHaveLength(1);
            connection.send({ type: "session_started", session_id: "s_1", request_id: "req_1", config: {}, limits: {} });

            await connection.until("audio_done");
            connection.send({ type: "speech_start", turn_index: 0, audio_ms: 0 });
            connection.send(draft("hel"));
            connection.send(committed("hello"));
            connection.done({ audio_ms: 80, turns: 1 });
        });

        const events = await collect(transcribe(server, [pcm(1), pcm(2)], { sample_rate: 24000, drafts: true }));

        expect(events.map((event) => event.type)).toEqual([
            "session_started",
            "speech_start",
            "draft",
            "committed",
            "session_done",
        ]);
        const last = events.at(-1)!;
        expect(last.type === "session_done" && last.stats).toEqual({ audio_ms: 80, turns: 1 });

        const connection = server.connections[0]!;
        expect(connection.headers.authorization).toBe("Bearer test-key");
        expect(connection.headers.model).toBe("transcribe-stream-1");
        expect(connection.received.map((message) => message.type)).toEqual(["config", "audio", "audio", "audio_done"]);
        expect(connection.received[1]!.data).toEqual(pcm(1));
        expect(connection.received[2]!.data).toEqual(pcm(2));
    });

    it("sends the model header that the request names", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });

        await collect(transcribe(server, [], { model: "transcribe-1-pro-realtime" }));

        expect(server.connections[0]!.headers.model).toBe("transcribe-1-pro-realtime");
    });

    it("sends diarize: false in config", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });

        await collect(transcribe(server, [], { diarize: false }));

        expect(server.connections[0]!.received[0]).toEqual({
            type: "config",
            audio: { format: "pcm_s16le", sample_rate: 16000, channels: 1 },
            results: { diarize: false },
        });
    });

    it("sends the client's extra headers in the handshake", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: server.url,
            headers: {
                "X-Gateway-Token": "gateway-secret",
                "X-From-Supplier": () => Promise.resolve("supplied"),
                "X-Removed": null,
            },
        });

        await collect(client.speechToText.convertRealtime({}, []));

        const connection = server.connections[0]!;
        expect(connection.headerValues("x-gateway-token")).toEqual(["gateway-secret"]);
        expect(connection.headerValues("x-from-supplier")).toEqual(["supplied"]);
        expect(connection.headerValues("x-removed")).toEqual([]);
        expect(connection.headerValues("user-agent")).toEqual([SDK_USER_AGENT]);
        expect(connection.headerValues("authorization")).toEqual(["Bearer test-key"]);
        expect(connection.headerValues("model")).toEqual(["transcribe-stream-1"]);
    });

    it("the API key and the realtime model win over extra headers of any casing, and each is sent once", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });
        const client = new FishAudioClient({
            apiKey: () => "test-key",
            baseUrl: server.url,
            headers: { authorization: "Bearer from-headers", MODEL: "transcribe-1-pro" },
        });

        await collect(client.speechToText.convertRealtime({}, []));

        const connection = server.connections[0]!;
        expect(connection.headerValues("authorization")).toEqual(["Bearer test-key"]);
        expect(connection.headerValues("model")).toEqual(["transcribe-stream-1"]);
    });

    it("joins the endpoint onto a base URL that has a path and a query", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });

        await collect(transcribe({ url: `${server.url}/gateway/?tenant=a` }, []));

        expect(server.connections[0]!.url).toBe("/gateway/v1/asr/realtime?tenant=a");
    });

    it("sends audio from any typed array or ArrayBuffer as bin, keeping a view's byte window", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });
        const samples = Int16Array.of(1, -2, 300);
        const window = new Uint8Array(Uint8Array.of(9, 9, 5, 6, 9).buffer, 2, 2);
        const otherRealm = runInNewContext("Uint8Array.of(7, 8)") as Uint8Array;
        const otherRealmBuffer = runInNewContext("Uint8Array.of(4, 2).buffer") as ArrayBuffer;
        expect(otherRealm instanceof Uint8Array).toBe(false);

        await collect(transcribe(server, [samples, window, otherRealm, otherRealmBuffer]));

        const received = server.connections[0]!.received.slice(1);
        expect(received.map((message) => message.type)).toEqual(["audio", "audio", "audio", "audio", "audio_done"]);
        expect(Array.from(received[0]!.data)).toEqual([1, 0, 0xfe, 0xff, 0x2c, 0x01]);
        expect(Array.from(received[1]!.data)).toEqual([5, 6]);
        expect(Array.from(received[2]!.data)).toEqual([7, 8]);
        expect(Array.from(received[3]!.data)).toEqual([4, 2]);
    });

    it("configure() always sends a configure message", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("keepalive");
            connection.done();
        });
        const stream = transcribe(server, silentMicrophone());
        // An object with a stray `type` is assignable to the configure request.
        const update = { type: "finalize" as const, results: { drafts: true } };

        await stream.configure(update);
        await stream.keepalive();
        await collect(stream);

        expect(server.connections[0]!.received[1]).toEqual({ type: "configure", results: { drafts: true } });
    });

    it("control messages in the audio stream keep their position", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });

        await collect(
            transcribe(server, [
                pcm(1),
                { type: "agent_speaking", speaking: true },
                pcm(2),
                { type: "finalize" },
                new Uint8Array([3, 3]).buffer,
            ]),
        );

        const received = server.connections[0]!.received;
        expect(received.slice(1).map((message) => message.type)).toEqual([
            "audio",
            "agent_speaking",
            "audio",
            "finalize",
            "audio",
            "audio_done",
        ]);
        expect(received[2]).toEqual({ type: "agent_speaking", speaking: true });
        expect(received[5]!.data).toEqual(Uint8Array.of(3, 3));
    });

    it("control methods send their messages during the session", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("keepalive");
            connection.send({ type: "configured", ok: true, config: { results: { drafts: true } } });
        });
        const stream = transcribe(server, silentMicrophone());

        expect((await stream.next()).value.type).toBe("session_started");
        await stream.finalize();
        await stream.agentSpeaking(true);
        await stream.addContext([{ role: "assistant", text: "Which day works for you?" }]);
        await stream.addContext([{ role: "user", text: "Monday" }], { resetHistory: true });
        await stream.configure({ turn_detection: { mode: "vad", silence_timeout_ms: 900 }, context: { terms: ["Fish"] } });
        await stream.keepalive();

        expect((await stream.next()).value).toMatchObject({ type: "configured", ok: true });
        expect(server.connections[0]!.received.slice(1)).toEqual([
            { type: "finalize" },
            { type: "agent_speaking", speaking: true },
            { type: "context_add", items: [{ role: "assistant", text: "Which day works for you?" }] },
            { type: "context_add", items: [{ role: "user", text: "Monday" }], reset_history: true },
            {
                type: "configure",
                turn_detection: { mode: "vad", silence_timeout_ms: 900 },
                context: { terms: ["Fish"] },
            },
            { type: "keepalive" },
        ]);
        await stream.close();
    });

    it("a control method called before the connection is open waits for config", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("finalize");
            connection.done();
        });
        const stream = transcribe(server, silentMicrophone());

        await stream.finalize();

        await collect(stream);
        expect(server.connections[0]!.received.map((message) => message.type)).toEqual(["config", "finalize"]);
    });

    it("control methods reject once the session is closed", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        const stream = transcribe(server, silentMicrophone());
        await stream.next();
        await stream.close();

        await expect(stream.keepalive()).rejects.toBeInstanceOf(RealtimeSTTError);
    });

    it("skips server messages of an unknown type", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.send({ type: "added_in_v2", detail: "new" });
            connection.socket.send("a text frame");
            connection.socket.send(Uint8Array.of(0xc1));
            connection.send(committed("still here"));
            connection.done();
        });

        const events = await collect(transcribe(server, [pcm(1)]));

        expect(events.map((event) => event.type)).toEqual(["session_started", "committed", "session_done"]);
    });
});

describe("realtime STT errors", () => {
    it("a recoverable error is an event and the session continues", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.send(errorMessage("invalid_request", 400, true));
            connection.send(committed("after the error"));
            connection.done();
        });

        const events = await collect(transcribe(server, [pcm(1)]));

        expect(events.map((event) => event.type)).toEqual(["session_started", "error", "committed", "session_done"]);
        expect(events[1]).toMatchObject({ error_type: "invalid_request", code: 400, recoverable: true });
    });

    it("an unrecoverable error throws with error type, code, request ID and close code", async () => {
        const server = await serve(async (connection) => {
            await connection.next();
            connection.send(errorMessage("unsupported_audio", 400, false));
            connection.socket.close(4400);
        });

        const { events, error } = await failure(transcribe(server, [pcm(1)]));

        expect(events).toEqual([]);
        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect(error).toBeInstanceOf(FishAudioError);
        expect(error).toMatchObject({
            errorType: "unsupported_audio",
            statusCode: 400,
            requestId: "req_test",
            closeCode: 4400,
            recoverable: false,
        });
        expect(error.message).toContain("unsupported_audio happened");
    });

    it("an unrecoverable error still throws when the server never closes", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            connection.send(errorMessage("engine_error", 500, false));
        });

        const { error } = await within(3000, failure(transcribe(server, silentMicrophone())));

        expect(error).toMatchObject({ errorType: "engine_error", statusCode: 500, closeCode: undefined });
        expect(await server.connections[0]!.closed).toBeTypeOf("number");
    });

    it("server_restarting is yielded, then thrown with close code 1012", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            connection.send(committed("last turn"));
            connection.send(errorMessage("server_restarting", 503, true));
            connection.socket.close(1012);
        });

        const { events, error } = await failure(transcribe(server, silentMicrophone()));

        expect(events.map((event) => event.type)).toEqual(["session_started", "committed", "error"]);
        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect(error).toMatchObject({ errorType: "server_restarting", closeCode: 1012, recoverable: true });
    });

    it("a close code other than 1000 without an error message throws with the close code", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            connection.socket.close(4500, "engine gone");
        });

        const { error } = await failure(transcribe(server, silentMicrophone()));

        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect(error).toMatchObject({ closeCode: 4500, errorType: undefined });
        expect(error.message).toContain("engine gone");
    });

    it("an earlier recoverable error is not blamed for a later abnormal close", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            connection.send(errorMessage("invalid_request", 400, true));
            connection.send(committed("fine"));
            connection.socket.close(4500);
        });

        const { error } = await failure(transcribe(server, silentMicrophone()));

        expect(error).toMatchObject({ closeCode: 4500, errorType: undefined });
    });

    it("an earlier recoverable error is not blamed for a connection that drops afterwards", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            connection.send(errorMessage("invalid_request", 400, true));
            await sleep(30);
            connection.socket.terminate();
        });

        const { events, error } = await failure(transcribe(server, silentMicrophone()));

        expect(events.map((event) => event.type)).toEqual(["session_started", "error"]);
        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect(error).toMatchObject({ closeCode: 1006, errorType: undefined, statusCode: undefined });
    });

    it("a server that accepts the connection but never answers the handshake times out", async () => {
        const sockets: Array<{ destroy(): void }> = [];
        const silent = createServer((socket) => sockets.push(socket));
        await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
        const { port } = silent.address() as AddressInfo;
        try {
            const client = new FishAudioClient({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}` });
            const stream = client.speechToText.convertRealtime({}, [pcm(1)], { timeoutInSeconds: 0.2 });

            const { error } = await within(2000, failure(stream));

            expect(error).toBeInstanceOf(RealtimeSTTError);
            expect(error.message).toMatch(/timed out/i);
        } finally {
            sockets.forEach((socket) => socket.destroy());
            await new Promise((resolve) => silent.close(resolve));
        }
    });

    it("a dropped connection throws RealtimeSTTError with close code 1006", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            connection.socket.terminate();
        });

        const { events, error } = await failure(transcribe(server, silentMicrophone()));

        expect(events.map((event) => event.type)).toEqual(["session_started"]);
        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect(error.closeCode).toBe(1006);
    });

    it("a connection lost while config is being sent throws RealtimeSTTError", async () => {
        const server = await serve((connection) => {
            // Drop the TCP connection as soon as the handshake is done.
            connection.socket.terminate();
        });

        const { events, error } = await failure(transcribe(server, [pcm(1)]));

        expect(events).toEqual([]);
        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect(error).toBeInstanceOf(FishAudioError);
    });

    it("an unreachable server throws RealtimeSTTError with the cause", async () => {
        // A port that was just free: nothing listens on it.
        const probe = createServer();
        await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
        const { port } = probe.address() as AddressInfo;
        await new Promise((resolve) => probe.close(resolve));

        const { error } = await failure(transcribe({ url: `http://127.0.0.1:${port}` }, [pcm(1)]));

        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect(error.cause).toMatchObject({ code: "ECONNREFUSED" });
    });

    it.each([
        ["a base URL that is not a URL", { apiKey: "test-key", baseUrl: "not a url" }],
        ["an API key that is not a valid header value", { apiKey: "line one\nline two", baseUrl: "http://127.0.0.1:9" }],
        [
            "an extra header that is not a valid header value",
            { apiKey: "test-key", baseUrl: "http://127.0.0.1:9", headers: { "X-Gateway-Token": "line one\nline two" } },
        ],
    ])("%s throws RealtimeSTTError from the stream instead of escaping it", async (_name, options) => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);
        try {
            const stream = new FishAudioClient(options).speechToText.convertRealtime({}, [pcm(1)]);
            // A reader that is already waiting must be woken with the error.
            const pending = stream.next();

            await expect(within(1000, pending, "the pending read")).rejects.toBeInstanceOf(RealtimeSTTError);
            expect(await stream.next()).toEqual({ done: true, value: undefined });
            await expect(stream.keepalive()).rejects.toBeInstanceOf(RealtimeSTTError);
            await sleep(20);
            expect(unhandled).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    it.each([
        [401, UnauthorizedError],
        [402, FishAudioError],
        [429, FishAudioError],
    ])("a handshake refused with %i throws the SDK's API error", async (status, errorClass) => {
        const server = await serve(() => {}, {
            refuse: { status, body: JSON.stringify({ status, message: "refused" }) },
        });
        let audioRead = false;
        function* audio(): Generator<Uint8Array> {
            audioRead = true;
            yield pcm(1);
        }

        const { events, error } = await failure(transcribe(server, audio()));

        expect(events).toEqual([]);
        expect(error).toBeInstanceOf(errorClass);
        expect(error).not.toBeInstanceOf(RealtimeSTTError);
        expect(error.statusCode).toBe(status);
        expect(error.body).toEqual({ status, message: "refused" });
        expect(audioRead).toBe(false);
    });
});

describe("realtime STT messages that cannot be encoded", () => {
    // MessagePack has no encoding for a function.
    const unencodable = [() => "Fish Audio"] as unknown as string[];

    it("a config that cannot be encoded rejects a pending read with RealtimeSTTError", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        let error: any;

        const errors = await escaped(async () => {
            const stream = transcribe(server, [pcm(1)], { terms: unencodable });
            const pending = stream.next();
            error = await within(1000, pending, "the pending read").catch((reason) => reason);
            expect(await stream.next()).toEqual({ done: true, value: undefined });
            await expect(stream.keepalive()).rejects.toBeInstanceOf(RealtimeSTTError);
        });

        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect(error.message).toMatch(/config/);
        expect(error.cause).toBeInstanceOf(Error);
        expect(errors).toEqual([]);
        // Nothing was sent: either no connection, or one that was closed again.
        for (const connection of server.connections) {
            expect(connection.received).toEqual([]);
        }
    });

    it("a control message that cannot be encoded rejects that call and the session goes on", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("keepalive");
            connection.done();
        });
        const stream = transcribe(server, silentMicrophone());
        let error: any;

        const errors = await escaped(async () => {
            error = await stream.configure({ context: { terms: unencodable } }).catch((reason) => reason);
            await stream.keepalive();
        });

        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect(error.message).toMatch(/encode/);
        expect(error.message).not.toMatch(/closed/);
        expect(errors).toEqual([]);
        const events = await collect(stream);
        expect(events.map((event) => event.type)).toEqual(["session_started", "session_done"]);
        expect(server.connections[0]!.received.map((message) => message.type)).toEqual(["config", "keepalive"]);
    });

    it("an item of the audio stream that cannot be encoded ends the session with RealtimeSTTError", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        const bad = { type: "configure", context: { terms: unencodable } } as const;
        let result: any;

        const errors = await escaped(async () => {
            result = await within(2000, failure(transcribe(server, [pcm(1), bad, pcm(2)])));
        });

        expect(result.error).toBeInstanceOf(RealtimeSTTError);
        expect(result.error.message).toMatch(/encode/);
        expect(errors).toEqual([]);
        expect(await within(2000, server.connections[0]!.closed)).toBe(1000);
    });
});

describe("realtime STT audio source failures", () => {
    class MicrophoneError extends Error {}

    async function* failingMicrophone(): AsyncGenerator<Uint8Array> {
        yield pcm(1);
        await sleep(30);
        throw new MicrophoneError("microphone unplugged");
    }

    it("ends the session with the audio source's error and closes the connection", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));

        const { events, error } = await within(2000, failure(transcribe(server, failingMicrophone())));

        expect(events.map((event) => event.type)).toEqual(["session_started"]);
        expect(error).toBeInstanceOf(MicrophoneError);
        const connection = server.connections[0]!;
        expect(await within(2000, connection.closed)).toBe(1000);
        // The session did not end as if the audio were complete.
        expect(connection.received.map((message) => message.type)).toEqual(["config", "audio"]);
    });

    it("is not delayed by a server that keeps sending events", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            const timer = setInterval(() => connection.send(draft("still talking")), 2);
            await connection.closed;
            clearInterval(timer);
        });

        const started = Date.now();
        const { error } = await within(2000, failure(transcribe(server, failingMicrophone())));

        expect(error).toBeInstanceOf(MicrophoneError);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it("is not swallowed when the server then closes normally", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            // The real server answers a client close with 1000, and may have
            // session_done on the way: neither may hide the audio failure.
            await connection.until("audio");
            await sleep(40);
            connection.done();
        });

        const { events, error } = await within(2000, failure(transcribe(server, failingMicrophone())));

        expect(error).toBeInstanceOf(MicrophoneError);
        expect(events.map((event) => event.type)).not.toContain("session_done");
    });

    it("does not replace an unrecoverable server error that is waiting for the close", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio");
            // The error arrives; the close frame is late.
            connection.send(errorMessage("engine_error", 500, false));
        });

        const { error } = await within(3000, failure(transcribe(server, failingMicrophone())));

        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect(error).toMatchObject({ errorType: "engine_error", requestId: "req_test" });
    });

    it("does not start the audio source when the session is closed as it starts", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        let microphoneOpened = false;
        async function* microphone(): AsyncGenerator<Uint8Array> {
            microphoneOpened = true;
            yield pcm(1);
        }
        const stream = transcribe(server, microphone());

        expect((await stream.next()).value.type).toBe("session_started");
        const closed = stream.close();
        await closed;
        await sleep(30);

        expect(microphoneOpened).toBe(false);
        expect(server.connections[0]!.received.map((message) => message.type)).toEqual(["config"]);
    });

    it("aborting with null as the reason throws null, as the signal says", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        const controller = new AbortController();
        const stream = transcribe(server, silentMicrophone(), {}, controller.signal);
        await stream.next();

        const pending = stream.next();
        controller.abort(null);

        await expect(pending).rejects.toBeNull();
    });

    it("aborting ends the session with the abort reason, even while audio is flowing", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        const controller = new AbortController();
        let microphoneClosed = false;
        const stream = transcribe(
            server,
            liveMicrophone(() => (microphoneClosed = true)),
            {},
            controller.signal,
        );

        expect((await stream.next()).value.type).toBe("session_started");
        const pending = stream.next();
        setTimeout(() => controller.abort(new Error("call ended")), 30);

        await expect(within(2000, pending)).rejects.toThrow("call ended");
        expect(await within(2000, server.connections[0]!.closed)).toBe(1000);
        await sleep(30);
        expect(microphoneClosed).toBe(true);
        expect(await stream.next()).toEqual({ done: true, value: undefined });
    });

    it("a signal that is already aborted fails without connecting", async () => {
        const server = await serve(() => {});

        const { error } = await failure(transcribe(server, [pcm(1)], {}, AbortSignal.abort(new Error("too late"))));

        expect(error.message).toBe("too late");
        await sleep(30);
        expect(server.connections).toHaveLength(0);
    });
});

describe("the fake realtime server", () => {
    it("reports a failed assertion in a handler instead of leaving the client waiting", async () => {
        const server = await startRealtimeServer(async (connection) => {
            await connection.next();
            expect("the config").toBe("something else");
        });

        // The connection is dropped, so the client is not left waiting for session_started.
        // Closed in `finally`: afterEach does not know this server, and its
        // close() is expected to reject.
        let closeError: unknown;
        try {
            const { error } = await within(2000, failure(transcribe(server, silentMicrophone())));
            expect(error).toBeInstanceOf(RealtimeSTTError);
        } finally {
            closeError = await server.close().then(
                () => undefined,
                (error: unknown) => error,
            );
        }
        expect(String(closeError)).toMatch(/something else/);
    });
});

describe("realtime STT closing", () => {
    it("close() wakes a consumer that is waiting for the next event", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        const stream = transcribe(server, silentMicrophone());
        await stream.next();

        const pending = stream.next();
        setTimeout(() => void stream.close(), 30);

        expect(await within(2000, pending, "the pending read")).toEqual({ done: true, value: undefined });
        expect(await within(2000, server.connections[0]!.closed)).toBe(1000);
    });

    it("close() before the connection is open does not connect or hang", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        const stream = transcribe(server, silentMicrophone());

        await within(2000, stream.close());

        expect(await stream.next()).toEqual({ done: true, value: undefined });
        await sleep(50);
        expect(server.connections).toHaveLength(0);
    });

    it("leaving the loop early closes the connection, stops the sender and closes the audio source", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio");
            connection.send(committed("enough"));
        });
        let microphoneClosed = false;

        for await (const event of transcribe(
            server,
            liveMicrophone(() => (microphoneClosed = true)),
        )) {
            if (event.type === "committed") {
                break;
            }
        }

        const connection = server.connections[0]!;
        expect(await within(2000, connection.closed)).toBe(1000);
        await sleep(30);
        expect(microphoneClosed).toBe(true);
        const sent = connection.received.length;
        await sleep(30);
        expect(connection.received).toHaveLength(sent);
        expect(connection.received.map((message) => message.type)).not.toContain("audio_done");
    });

    /**
     * An audio source that waits for its next chunk like a blocked microphone
     * read. Unlike an async generator, its `return()` can release that read.
     */
    function interruptibleMicrophone(options: { returnResult?: () => Promise<IteratorResult<Uint8Array>> } = {}) {
        const state = { reads: 0, returns: 0, pendingReadSettled: false };
        let release: ((result: IteratorResult<Uint8Array>) => void) | undefined;
        const source: AsyncIterable<Uint8Array> = {
            [Symbol.asyncIterator]: () => ({
                next() {
                    state.reads++;
                    if (state.reads === 1) {
                        return Promise.resolve({ done: false, value: pcm(1) });
                    }
                    return new Promise<IteratorResult<Uint8Array>>((resolve) => {
                        release = (result) => {
                            state.pendingReadSettled = true;
                            resolve(result);
                        };
                    });
                },
                return() {
                    state.returns++;
                    release?.({ done: true, value: undefined });
                    return options.returnResult?.() ?? Promise.resolve({ done: true, value: undefined });
                },
            }),
        };
        return { source, state };
    }

    it("close() calls return() on an audio source that is waiting for its next chunk", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio");
            connection.send(committed("heard it"));
        });
        const { source, state } = interruptibleMicrophone();
        const stream = transcribe(server, source);
        await stream.next();
        expect((await stream.next()).value.type).toBe("committed");
        expect(state.reads).toBe(2);

        await within(700, stream.close(), "close()");

        expect(state.returns).toBe(1);
        expect(state.pendingReadSettled).toBe(true);
        await sleep(30);
        expect(state.reads).toBe(2);
        expect(state.returns).toBe(1);
        expect(server.connections[0]!.received.map((message) => message.type)).toEqual(["config", "audio"]);
    });

    it.each([
        ["the server ends the session", (connection: FakeConnection) => connection.done()],
        ["the server reports an unrecoverable error", (connection: FakeConnection) => {
            connection.send(errorMessage("engine_error", 500, false));
            connection.socket.close(4500);
        }],
        ["the connection drops", (connection: FakeConnection) => connection.socket.terminate()],
    ])("return() is also called on a waiting audio source when %s", async (_name, endSession) => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio");
            endSession(connection);
        });
        const { source, state } = interruptibleMicrophone();

        await within(2000, collect(transcribe(server, source)).catch(() => {}));
        await sleep(30);

        expect(state.returns).toBe(1);
        expect(state.pendingReadSettled).toBe(true);
    });

    it("close() does not wait for an audio source that cannot be interrupted", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio");
            connection.send(committed("heard it"));
        });
        let finished = false;
        // An async generator: return() only runs once the pending await settles.
        async function* blockedMicrophone(): AsyncGenerator<Uint8Array> {
            try {
                yield pcm(1);
                await new Promise(() => {});
            } finally {
                finished = true;
            }
        }
        const stream = transcribe(server, blockedMicrophone());
        await stream.next();
        await stream.next();

        await within(700, stream.close(), "close()");

        expect(await stream.next()).toEqual({ done: true, value: undefined });
        expect(await within(2000, server.connections[0]!.closed)).toBe(1000);
        expect(finished).toBe(false);
    });

    it.each([
        ["never settles", () => new Promise<IteratorResult<Uint8Array>>(() => {})],
        ["rejects", () => Promise.reject(new Error("cleanup failed"))],
        ["throws", (): Promise<IteratorResult<Uint8Array>> => {
            throw new Error("cleanup failed");
        }],
    ])("close() is not held up or failed by a return() that %s", async (_name, returnResult) => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio");
            connection.send(committed("heard it"));
        });
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);
        try {
            const { source, state } = interruptibleMicrophone({ returnResult });
            const stream = transcribe(server, source);
            await stream.next();
            await stream.next();

            await within(700, stream.close(), "close()");

            expect(state.returns).toBe(1);
            expect(await stream.next()).toEqual({ done: true, value: undefined });
            await sleep(30);
            expect(unhandled).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    it("the connection is closed by the time session_done is returned", async () => {
        let serverSawClose = false;
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            // Unlike the real server, do not close: the client must.
            connection.send({ type: "session_done", stats: { audio_ms: 40, turns: 0 } });
            await connection.closed;
            serverSawClose = true;
        });
        let stateAtSessionDone: number | undefined;

        for await (const event of transcribe(server, [pcm(1)])) {
            if (event.type === "session_done") {
                // Observed at the moment the event is handed over, not afterwards.
                stateAtSessionDone = server.connections[0]!.socket.readyState;
            }
        }

        // 2 is CLOSING, 3 is CLOSED: the client's close frame has arrived.
        expect(stateAtSessionDone).toBeGreaterThanOrEqual(2);
        expect(await within(2000, server.connections[0]!.closed)).toBe(1000);
        expect(serverSawClose).toBe(true);
    });

    it("a normal close without session_done ends the stream", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            connection.socket.close(1000);
        });

        const events = await collect(transcribe(server, silentMicrophone()));

        expect(events.map((event) => event.type)).toEqual(["session_started"]);
    });
});

describe("realtime STT backpressure", () => {
    const TOTAL = 4000;
    const FILLER = "x".repeat(4096);

    /** Sends far more than the client may buffer (about 16 MB), then ends the session. */
    async function flood(connection: FakeConnection): Promise<void> {
        await connection.start();
        for (let i = 0; i < TOTAL; i++) {
            connection.send({ ...draft(FILLER), turn_index: i });
        }
        connection.done({ turns: TOTAL });
    }

    it("a slow consumer makes the client stop reading instead of buffering without limit", async () => {
        const server = await serve(flood);
        const stream = transcribe(server, silentMicrophone());

        expect((await stream.next()).value.type).toBe("session_started");
        await sleep(300);
        // The client has stopped reading, so most of the flood is still on the server.
        const connection = server.connections[0]!;
        expect(connection.socket.bufferedAmount).toBeGreaterThan((TOTAL * FILLER.length) / 2);

        // Once the consumer reads, everything arrives, in order, and the session ends normally.
        const events = await collect(stream);
        expect(events).toHaveLength(TOTAL + 1);
        expect(events.slice(0, TOTAL).every((event, i) => event.type === "draft" && event.turn_index === i)).toBe(true);
        expect(events.at(-1)).toMatchObject({ type: "session_done", stats: { turns: TOTAL } });
    });

    it("an error after a full buffer is delivered after the buffered events", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            for (let i = 0; i < TOTAL; i++) {
                connection.send({ ...draft(FILLER), turn_index: i });
            }
            connection.send(errorMessage("engine_error", 500, false));
            connection.socket.close(4500);
        });

        const stream = transcribe(server, silentMicrophone());
        await sleep(300);
        const { events, error } = await failure(stream);

        expect(events).toHaveLength(TOTAL + 1);
        expect(error).toMatchObject({ errorType: "engine_error", closeCode: 4500 });
    });

    it("close() with a full buffer does not hang and closes the connection", async () => {
        const server = await serve(flood);
        const stream = transcribe(server, silentMicrophone());
        await stream.next();
        await sleep(300);

        // Well inside the time after which a stuck connection is dropped: the
        // closing handshake itself must finish, although reading had stopped.
        await within(700, stream.close(), "close()");

        expect(await stream.next()).toEqual({ done: true, value: undefined });
        expect(await within(3000, server.connections[0]!.closed)).toBe(1000);
    });

    it("leaving the loop with a full buffer closes the connection", async () => {
        const server = await serve(flood);
        let seen = 0;

        for await (const event of transcribe(server, silentMicrophone())) {
            await sleep(event.type === "session_started" ? 300 : 0);
            if (++seen === 10) {
                break;
            }
        }

        expect(await within(3000, server.connections[0]!.closed)).toBeTypeOf("number");
    });
});

describe("realtime STT connection deadline", () => {
    it("covers the time before the socket is created, such as an API key that never resolves", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        const client = new FishAudioClient({ apiKey: () => new Promise<string>(() => {}), baseUrl: server.url });
        const stream = client.speechToText.convertRealtime({}, [pcm(1)], { timeoutInSeconds: 0.2 });

        const { error } = await within(2000, failure(stream));

        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect(error.message).toMatch(/timed out/i);
        expect(server.connections).toHaveLength(0);
    });

    it("does not end a session that opened in time", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            await sleep(400);
            connection.done();
        });
        const client = new FishAudioClient({ apiKey: "test-key", baseUrl: server.url });
        const stream = client.speechToText.convertRealtime({}, [pcm(1)], { timeoutInSeconds: 0.2 });

        const events = await within(3000, collect(stream));

        expect(events.map((event) => event.type)).toEqual(["session_started", "session_done"]);
    });

    it("does not run the supplier of a header the SDK sets itself", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });
        let calls = 0;
        const reserved = () => {
            calls++;
            throw new Error("this header is replaced, so its supplier is not needed");
        };
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: server.url,
            headers: { authorization: reserved, MODEL: reserved, "X-Extra": () => "kept" },
        });

        const events = await within(2000, collect(client.speechToText.convertRealtime({}, [pcm(1)])));

        expect(events.map((event) => event.type)).toEqual(["session_started", "session_done"]);
        expect(calls).toBe(0);
        const connection = server.connections[0]!;
        expect(connection.headerValues("x-extra")).toEqual(["kept"]);
        expect(connection.headerValues("authorization")).toEqual(["Bearer test-key"]);
        expect(connection.headerValues("model")).toEqual(["transcribe-stream-1"]);
    });
});

describe("realtime STT audio source iterator", () => {
    /** A hand-written audio iterator that counts what the stream does with it. */
    function countingSource(read: (index: number) => Promise<IteratorResult<RealtimeSTTAudioInput>>) {
        const state = { reads: 0, returns: 0 };
        const iterator = {
            next: () => read(state.reads++),
            return: async (): Promise<IteratorResult<RealtimeSTTAudioInput>> => {
                state.returns++;
                return { done: true, value: undefined };
            },
        };
        return { state, iterator, source: { [Symbol.asyncIterator]: () => iterator } };
    }

    it("uses the sync iterator when Symbol.asyncIterator is present but undefined", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });
        const chunks = [pcm(1), pcm(2)];
        const source = {
            [Symbol.asyncIterator]: undefined,
            [Symbol.iterator]: () => chunks[Symbol.iterator](),
        } as unknown as Iterable<RealtimeSTTAudioInput>;

        const events = await within(2000, collect(transcribe(server, source)));

        expect(events.map((event) => event.type)).toEqual(["session_started", "session_done"]);
        expect(server.connections[0]!.received.map((message) => message.type)).toEqual([
            "config",
            "audio",
            "audio",
            "audio_done",
        ]);
    });

    it("does not read a source whose creation ended the session, and still stops it", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        const controller = new AbortController();
        const { state, iterator } = countingSource(async () => ({ done: false, value: pcm(1) }));
        const source = {
            [Symbol.asyncIterator]: () => {
                controller.abort(new Error("stopped while starting the microphone"));
                return iterator;
            },
        };

        const { error } = await within(2000, failure(transcribe(server, source, {}, controller.signal)));
        await sleep(30);

        expect(error.message).toBe("stopped while starting the microphone");
        expect(state).toEqual({ reads: 0, returns: 1 });
    });

    it("calls return() on a source whose read failed", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        const { state, source } = countingSource(async (index) => {
            if (index === 0) return { done: false, value: pcm(1) };
            throw new Error("microphone unplugged");
        });

        const { error } = await within(2000, failure(transcribe(server, source)));
        await sleep(30);

        expect(error.message).toBe("microphone unplugged");
        expect(state).toEqual({ reads: 2, returns: 1 });
    });

    it("does not call return() on a source that finished by itself", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });
        const { state, source } = countingSource(async (index) =>
            index === 0 ? { done: false, value: pcm(1) } : { done: true, value: undefined },
        );

        await within(2000, collect(transcribe(server, source)));
        await sleep(30);

        expect(state).toEqual({ reads: 2, returns: 0 });
    });

    it("an item that cannot be encoded stops the source and does not replace a waiting server error", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio");
            // The error arrives; the close frame is late.
            connection.send(errorMessage("engine_error", 500, false));
        });
        const { state, source } = countingSource(async (index) => {
            if (index === 0) return { done: false, value: pcm(1) };
            await sleep(60);
            return { done: false, value: { type: "configure", terms: [() => "x"] } as unknown as RealtimeSTTAudioInput };
        });

        const { error } = await within(3000, failure(transcribe(server, source)));

        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect(error).toMatchObject({ errorType: "engine_error", requestId: "req_test" });
        expect(state).toEqual({ reads: 2, returns: 1 });
    });

    it("close() still wakes a waiting reader when looking up return() throws", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        const iterator = {
            next: () => new Promise<IteratorResult<RealtimeSTTAudioInput>>(() => {}),
            get return(): never {
                throw new Error("broken iterator");
            },
        };
        const stream = transcribe(server, { [Symbol.asyncIterator]: () => iterator });
        await stream.next();
        await sleep(20);
        const pending = stream.next();

        const errors = await escaped(async () => {
            await within(700, stream.close(), "close()");
            expect(await within(700, pending, "the pending read")).toEqual({ done: true, value: undefined });
        });

        expect(errors).toEqual([]);
    });

    it("a thrown value that cannot be turned into a string still fails the stream, not the call", async () => {
        const thrown = Object.create(null) as object;
        const request = {
            get terms(): string[] {
                throw thrown;
            },
        };

        const stream = transcribe({ url: "http://127.0.0.1:1" }, [pcm(1)], request);
        const error = await stream.next().catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(RealtimeSTTError);
        expect((error as RealtimeSTTError).cause).toBe(thrown);
    });
});

// The README's "stop a microphone" example, with a recorder that can be observed.
describe("README example: stopping a blocking audio source with an AbortSignal", () => {
    interface Recorder {
        read(): Promise<Uint8Array>;
        close(): void;
    }

    // ----- copied from README.md ------------------------------------------
    async function* microphone(openRecorder: () => Recorder, signal: AbortSignal) {
        const recorder = openRecorder(); // your own capture code
        try {
            while (!signal.aborted) {
                let stop!: () => void;
                const aborted = new Promise<undefined>((resolve) => {
                    stop = () => resolve(undefined);
                });
                signal.addEventListener("abort", stop, { once: true });
                let chunk: Uint8Array | undefined;
                try {
                    // read() resolves with the next 20–40 ms of PCM.
                    chunk = await Promise.race([recorder.read(), aborted]);
                } finally {
                    signal.removeEventListener("abort", stop);
                }
                if (chunk === undefined) {
                    break; // aborted while waiting for audio
                }
                yield chunk;
            }
        } finally {
            recorder.close(); // releases the device, and a read that is still pending
        }
    }
    // -----------------------------------------------------------------------

    /** A recorder that gives `chunks` chunks at once and then stays silent, as a muted microphone does. */
    function fakeRecorder(chunks: number) {
        const state = { opened: 0, closed: 0, reads: 0, mostListeners: 0, signal: undefined as AbortSignal | undefined };
        const open = (): Recorder => {
            state.opened++;
            return {
                read: () => {
                    if (state.signal) {
                        state.mostListeners = Math.max(
                            state.mostListeners,
                            getEventListeners(state.signal, "abort").length,
                        );
                    }
                    return state.reads++ < chunks ? Promise.resolve(pcm(1, 32)) : new Promise<Uint8Array>(() => {});
                },
                close: () => {
                    state.closed++;
                },
            };
        };
        return { state, open };
    }

    it("a session that ends before the microphone is read leaves nothing behind", async () => {
        const server = await serve(() => {}, { refuse: { status: 401, body: '{"message":"Invalid token"}' } });
        const recorder = fakeRecorder(0);
        let error: unknown;

        const errors = await escaped(async () => {
            const controller = new AbortController();
            const stream = transcribe(server, microphone(recorder.open, controller.signal));
            try {
                await collect(stream);
            } catch (reason) {
                error = reason;
            } finally {
                controller.abort();
            }
        });

        expect(error).toBeInstanceOf(UnauthorizedError);
        expect(errors).toEqual([]);
        expect(recorder.state).toMatchObject({ opened: 0, closed: 0 });
    });

    it("a long session keeps one abort listener, and leaving the loop then abort() stops the recorder", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            for (let received = 0; received < 500; received++) {
                await connection.until("audio");
            }
            connection.send(committed("five hundred chunks"));
        });
        const recorder = fakeRecorder(500);
        const controller = new AbortController();
        recorder.state.signal = controller.signal;

        const errors = await escaped(async () => {
            const stream = transcribe(server, microphone(recorder.open, controller.signal));
            try {
                for await (const event of stream) {
                    if (event.type === "committed") break;
                }
            } finally {
                controller.abort();
            }
        });

        expect(errors).toEqual([]);
        // The source is still waiting for chunk 501: only the abort ends that read.
        expect(recorder.state).toMatchObject({ opened: 1, closed: 1, reads: 501 });
        expect(recorder.state.mostListeners).toBeLessThanOrEqual(1);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    });

    it("without abort(), close() alone leaves a recorder that is waiting for audio open", async () => {
        const server = await serve((connection) => connection.start().then(() => {}));
        const recorder = fakeRecorder(0);
        const controller = new AbortController();
        const stream = transcribe(server, microphone(recorder.open, controller.signal));
        await stream.next();
        await sleep(20);

        await within(700, stream.close(), "close()");
        await sleep(30);
        expect(recorder.state).toMatchObject({ opened: 1, closed: 0 });

        controller.abort();
        await sleep(10);
        expect(recorder.state).toMatchObject({ opened: 1, closed: 1 });
    });

    it("abort() alone ends the audio, and the session then finishes normally", async () => {
        const server = await serve(async (connection) => {
            await connection.start();
            await connection.until("audio_done");
            connection.done();
        });
        const recorder = fakeRecorder(3);
        const controller = new AbortController();
        const stream = transcribe(server, microphone(recorder.open, controller.signal));
        await stream.next();
        await sleep(30);

        controller.abort();
        const events = await within(2000, collect(stream));

        expect(events.map((event) => event.type)).toEqual(["session_done"]);
        expect(recorder.state).toMatchObject({ opened: 1, closed: 1 });
        expect(server.connections[0]!.received.map((message) => message.type)).toEqual([
            "config",
            "audio",
            "audio",
            "audio",
            "audio_done",
        ]);
    });
});
