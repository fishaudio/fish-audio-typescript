/// <reference types="node" />
import { encode } from "@msgpack/msgpack";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FishAudioClient, RealtimeEvents, type RealtimeConnection } from "../src/index.js";
import type { WebSocket } from "ws";
import { startRealtimeServer, type FakeConnection, type FakeServer, type Message } from "./realtimeServer.js";

const servers: FakeServer[] = [];

afterEach(async () => {
    vi.useRealTimers();
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

/** Sends a `/v1/tts/live` server message. */
function send(connection: FakeConnection, message: Message): void {
    connection.socket.send(encode(message));
}

/** Reads client messages until the `stop` event, as the API does before it answers `finish`. */
async function untilStop(connection: FakeConnection): Promise<void> {
    for (;;) {
        const message = await connection.next();
        if (!message) throw new Error('connection closed before "stop"');
        if (message.event === "stop") return;
    }
}

/** What a caller sees on a connection, in order. */
interface Seen {
    events: string[];
    audio: number;
    errors: Error[];
    /** Resolves on the first CLOSE. */
    closed: Promise<void>;
}

function watch(connection: RealtimeConnection): Seen {
    let resolve!: () => void;
    const seen: Seen = { events: [], audio: 0, errors: [], closed: new Promise((r) => (resolve = r)) };
    connection.on(RealtimeEvents.OPEN, () => seen.events.push("open"));
    connection.on(RealtimeEvents.AUDIO_CHUNK, (audio) => {
        seen.audio += (audio as Uint8Array).length;
    });
    connection.on(RealtimeEvents.ERROR, (error) => {
        seen.events.push("error");
        seen.errors.push(error as Error);
    });
    connection.on(RealtimeEvents.CLOSE, () => {
        seen.events.push("close");
        resolve();
    });
    return seen;
}

function connect(
    server: FakeServer,
    textStream: Iterable<string> | AsyncIterable<string> = ["Hello."],
): Promise<RealtimeConnection> {
    const client = new FishAudioClient({ apiKey: "test-key", baseUrl: server.url });
    return client.textToSpeech.convertRealtime({ text: "" }, textStream);
}

/** Sockets that keep the event loop of this process alive. */
function openSockets(): number {
    return process.getActiveResourcesInfo().filter((resource) => resource === "TCPSocketWrap").length;
}

/** Long enough for a second, wrong CLOSE to arrive. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50));
}

describe("realtime TTS connection lifetime", () => {
    it("closes the socket when the server finishes the stream, without close() from the caller", async () => {
        const server = await serve(async (connection) => {
            await untilStop(connection);
            send(connection, { event: "audio", audio: Uint8Array.of(1, 2, 3) });
            send(connection, { event: "finish", reason: "stop" });
            // The API leaves the socket open here; it is the client that closes it.
        });
        const socketsBefore = openSockets();

        // The README example: listeners only, no connection.close().
        const seen = watch(await connect(server));
        await seen.closed;

        // The client sent a close frame without a status code (1005).
        expect(await (await server.connection()).closed).toBe(1005);
        await settle();
        expect(seen.audio).toBe(3);
        expect(seen.events).toEqual(["open", "close"]);
        // Nothing of this connection is left to keep a process alive.
        expect(openSockets()).toBe(socketsBefore);
    });

    it("emits CLOSE once for a caller that calls close() when the stream ends", async () => {
        const server = await serve(async (connection) => {
            await untilStop(connection);
            send(connection, { event: "finish", reason: "stop" });
        });

        const connection = await connect(server);
        const seen = watch(connection);
        connection.on(RealtimeEvents.CLOSE, () => connection.close());
        await seen.closed;
        connection.close();

        await (await server.connection()).closed;
        await settle();
        expect(seen.events).toEqual(["open", "close"]);
    });

    it("reports a server error, then closes the socket and emits CLOSE once", async () => {
        const server = await serve(async (connection) => {
            await connection.next(); // start
            send(connection, { event: "finish", reason: "error", message: "Model overloaded" });
        });
        const socketsBefore = openSockets();

        const seen = watch(await connect(server));
        await seen.closed;

        expect(await (await server.connection()).closed).toBe(1005);
        await settle();
        expect(seen.events).toEqual(["open", "error", "close"]);
        expect(seen.errors.map((error) => error.message)).toEqual(["Model overloaded"]);
        expect(openSockets()).toBe(socketsBefore);
    });

    it("closes the socket on a finish with a reason it does not know", async () => {
        const server = await serve(async (connection) => {
            await connection.next(); // start
            send(connection, { event: "finish", reason: "timeout" });
        });

        const seen = watch(await connect(server));
        await seen.closed;

        expect(await (await server.connection()).closed).toBe(1005);
        await settle();
        expect(seen.events).toEqual(["open", "close"]);
    });

    it("stops reading the text source and emits CLOSE once when the caller closes early", async () => {
        const server = await serve(async (connection) => {
            await connection.next(); // start
            send(connection, { event: "audio", audio: Uint8Array.of(1) });
        });
        const socketsBefore = openSockets();
        let releaseText!: () => void;
        const textGate = new Promise<void>((resolve) => (releaseText = resolve));
        const text = { pulled: 0, returned: false };
        async function* slowText(): AsyncGenerator<string> {
            try {
                for (;;) {
                    text.pulled++;
                    yield "More text. ";
                    await textGate;
                }
            } finally {
                text.returned = true;
            }
        }

        const connection = await connect(server, slowText());
        const seen = watch(connection);
        await new Promise<void>((resolve) => connection.on(RealtimeEvents.AUDIO_CHUNK, () => resolve()));
        connection.close(); // the caller has heard enough
        await seen.closed;
        releaseText();

        const fake = await server.connection();
        expect(await fake.closed).toBe(1005);
        await settle();
        expect(seen.events).toEqual(["open", "close"]);
        // One more chunk was pulled after close(); sending it failed and ended the source.
        expect(text).toEqual({ pulled: 2, returned: true });
        expect(fake.received.map((message) => message.event)).toEqual(["start", "text"]);
        expect(openSockets()).toBe(socketsBefore);
    });

    it("destroys the socket when the server does not answer the close frame", async () => {
        const server = await serve(async (connection) => {
            await connection.next(); // start
            // Stop reading, so the client's close frame is never seen or answered.
            (connection.socket as unknown as { _socket: Socket })._socket.removeAllListeners("data");
            send(connection, { event: "finish", reason: "stop" });
        });
        const socketsBefore = openSockets();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        const connection = await connect(server);
        const seen = watch(connection);
        // The client has asked to close and is waiting for the server's answer.
        const websocket = (connection as unknown as { websocket: WebSocket }).websocket;
        while (websocket.readyState !== websocket.CLOSING) {
            await new Promise((resolve) => setImmediate(resolve)); // not a faked timer
        }
        await vi.advanceTimersByTimeAsync(2999);
        expect(seen.events).toEqual(["open"]);

        await vi.advanceTimersByTimeAsync(1);
        await seen.closed;
        vi.useRealTimers();

        await (await server.connection()).closed;
        await settle();
        expect(seen.events).toEqual(["open", "close"]);
        expect(openSockets()).toBe(socketsBefore);
    });

    it("emits CLOSE once when the server drops the connection", async () => {
        const server = await serve(async (connection) => {
            await connection.next(); // start
            connection.socket.terminate();
        });

        const seen = watch(await connect(server));
        await seen.closed;

        await settle();
        expect(seen.events).toEqual(["open", "close"]);
    });

    it("emits ERROR, then CLOSE once, when the connection is refused", async () => {
        const server = await serve(() => {}, { refuse: { status: 401 } });

        const seen = watch(await connect(server));
        await seen.closed;

        await settle();
        expect(seen.events).toEqual(["error", "close"]);
        expect(seen.errors[0]!.message).toContain("401");
    });
});
