/// <reference types="node" />
import { decode } from "@msgpack/msgpack";
import { createServer } from "node:net";
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
        expect(connection.headerValues("user-agent")).toEqual(["fish-audio"]);
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
        for (const connection of server.connections) {
            expect(await within(2000, connection.closed)).toBeTypeOf("number");
        }
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
        const stream = transcribe(server, [pcm(1)]);

        const events = await collect(stream);

        expect(events.at(-1)!.type).toBe("session_done");
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
