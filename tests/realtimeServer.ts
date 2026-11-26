/// <reference types="node" />
import { decode, encode } from "@msgpack/msgpack";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export type Message = Record<string, any>;

/** One client connection, seen from the fake realtime server. */
export class FakeConnection {
    /** Every client message so far, decoded. */
    readonly received: Message[] = [];
    /** The raw frames of the client messages, in the same order. */
    readonly frames: Uint8Array[] = [];
    /** Resolves with the close code when the connection is gone. */
    readonly closed: Promise<number>;
    #unread: Message[] = [];
    #waiting: Array<(message: Message | undefined) => void> = [];
    #seq = 0;

    constructor(
        readonly socket: WebSocket,
        readonly headers: IncomingHttpHeaders,
        /** Header names and values as sent, alternating, so duplicates stay visible. */
        readonly rawHeaders: string[] = [],
        /** Path and query of the handshake request. */
        readonly url: string = "",
    ) {
        socket.on("message", (data, isBinary) => {
            if (!isBinary) return;
            const frame = new Uint8Array(data as Buffer);
            const message = decode(frame) as Message;
            this.frames.push(frame);
            this.received.push(message);
            const waiter = this.#waiting.shift();
            if (waiter) waiter(message);
            else this.#unread.push(message);
        });
        this.closed = new Promise((resolve) => {
            socket.on("close", (code) => {
                for (const waiter of this.#waiting.splice(0)) waiter(undefined);
                resolve(code);
            });
        });
        socket.on("error", () => {});
    }

    /** Every value the handshake carried for a header, whatever its casing. */
    headerValues(name: string): string[] {
        const values: string[] = [];
        for (let i = 0; i < this.rawHeaders.length; i += 2) {
            if (this.rawHeaders[i]!.toLowerCase() === name.toLowerCase()) {
                values.push(this.rawHeaders[i + 1]!);
            }
        }
        return values;
    }

    /** The next client message, or `undefined` once the connection is closed. */
    next(): Promise<Message | undefined> {
        const message = this.#unread.shift();
        if (message) return Promise.resolve(message);
        if (this.socket.readyState >= 2) return Promise.resolve(undefined);
        return new Promise((resolve) => this.#waiting.push(resolve));
    }

    /** Reads client messages until one of the given type arrives. */
    async until(type: string): Promise<Message> {
        for (;;) {
            const message = await this.next();
            if (!message) throw new Error(`connection closed before "${type}"`);
            if (message.type === type) return message;
        }
    }

    /** Sends a server message, adding `seq` as the real server does. */
    send(message: Message): void {
        this.socket.send(encode({ seq: this.#seq++, ...message }));
    }

    /** Reads `config` and answers with `session_started`. */
    async start(): Promise<Message> {
        const config = await this.next();
        this.send({
            type: "session_started",
            session_id: "s_test",
            request_id: "req_test",
            config: {},
            limits: { max_session_ms: 3600000, max_turn_ms: 60000, max_frame_bytes: 1048576 },
        });
        return config!;
    }

    /** Sends `session_done` and closes with 1000, as the real server does after `audio_done`. */
    done(stats: Message = { audio_ms: 0, turns: 0, request_id: "req_test" }): void {
        this.send({ type: "session_done", stats });
        this.socket.close(1000);
    }
}

export interface FakeServer {
    /** Pass as `baseUrl` to `FishAudioClient`. */
    url: string;
    connections: FakeConnection[];
    /** Resolves with the connection number `index` once the client has connected. */
    connection(index?: number): Promise<FakeConnection>;
    /** Stops the server. Rejects with the first error a handler threw, so the test fails with it. */
    close(): Promise<void>;
}

/**
 * Starts a protocol-level fake of the realtime endpoint on a real TCP port.
 * `handler` plays the server's side of each connection; `refuse` answers the
 * WebSocket handshake with an HTTP error instead.
 */
export async function startRealtimeServer(
    handler: (connection: FakeConnection) => void | Promise<void>,
    options: {
        refuse?: { status: number; body?: string };
        /** Answers the handshake with this `x-fish-trace-id`, computed from the request's raw headers. */
        traceId?: (rawHeaders: string[]) => string;
    } = {},
): Promise<FakeServer> {
    const http: Server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    const connections: FakeConnection[] = [];
    const arrivals: Array<() => void> = [];
    const handlerErrors: unknown[] = [];

    http.on("upgrade", (request, socket, head) => {
        if (!(request.url ?? "").split("?")[0]!.endsWith("/v1/asr/realtime")) {
            socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            return;
        }
        if (options.refuse) {
            const body = options.refuse.body ?? "";
            socket.end(
                `HTTP/1.1 ${options.refuse.status} Refused\r\n` +
                    "Content-Type: application/json\r\n" +
                    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                    "Connection: close\r\n\r\n" +
                    body,
            );
            return;
        }
        const traceId = options.traceId;
        if (traceId) {
            wss.once("headers", (headers) => headers.push(`x-fish-trace-id: ${traceId(request.rawHeaders)}`));
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            const connection = new FakeConnection(ws, request.headers, request.rawHeaders, request.url ?? "");
            connections.push(connection);
            for (const arrived of arrivals.splice(0)) arrived();
            // A failed assertion in the handler must fail the test, not leave it
            // waiting: drop the connection now, report the error in close().
            void (async () => handler(connection))().catch((error: unknown) => {
                handlerErrors.push(error);
                ws.terminate();
            });
        });
    });

    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        connections,
        async connection(index = 0) {
            while (connections.length <= index) {
                await new Promise<void>((resolve) => arrivals.push(resolve));
            }
            return connections[index]!;
        },
        async close() {
            for (const client of wss.clients) client.terminate();
            http.closeAllConnections();
            await new Promise<void>((resolve) => http.close(() => resolve()));
            if (handlerErrors.length > 0) {
                throw handlerErrors[0];
            }
        },
    };
}
