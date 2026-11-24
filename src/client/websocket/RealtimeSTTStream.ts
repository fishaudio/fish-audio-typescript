import WebSocket from "ws";
import { decode, encode } from "@msgpack/msgpack";
import type { ClientRequest, IncomingMessage } from "node:http";
import { types } from "node:util";
import * as apiErrors from "../../api/errors/index.js";
import { FishAudioError } from "../../errors/FishAudioError.js";
import { RealtimeSTTError } from "../../errors/RealtimeSTTError.js";
import type {
    RealtimeSTTAudioInput,
    RealtimeSTTConfigureRequest,
    RealtimeSTTContextItem,
    RealtimeSTTControlMessage,
    RealtimeSTTErrorEvent,
    RealtimeSTTEvent,
    RealtimeSTTRequest,
    RealtimeSTTResults,
    RealtimeSTTSessionDoneEvent,
    RealtimeSTTTurnDetection,
} from "./realtimeSTTTypes.js";

/**
 * Events held for a consumer that reads slowly. At this many, the stream stops
 * reading from the socket, so the server sees backpressure instead of the SDK
 * buffering without limit. Messages already read from the socket are still
 * delivered, so the buffer can briefly hold a little more.
 */
const EVENT_BUFFER_SIZE = 256;

/** Default for how long the connection may take to open. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** How long a closing connection may take before it is dropped. */
const CLOSE_TIMEOUT_MS = 1000;

/** Most of a refused handshake's response body that is read. */
const MAX_REFUSAL_BODY_BYTES = 64 * 1024;

const SERVER_EVENT_TYPES: ReadonlySet<string> = new Set<RealtimeSTTEvent["type"]>([
    "session_started",
    "speech_start",
    "user_turn_taken",
    "draft",
    "eager_end_of_turn",
    "turn_resumed",
    "user_backchannel",
    "committed",
    "vad",
    "eot_prob",
    "configured",
    "progress",
    "error",
    "session_done",
]);

/** @internal */
export interface RealtimeSTTConnectParams {
    url: string;
    headers: Record<string, string>;
}

/** @internal The first message of a session, built from a {@link RealtimeSTTRequest}. */
export function buildConfigMessage(request: RealtimeSTTRequest): Record<string, unknown> {
    const turnDetection: RealtimeSTTTurnDetection =
        typeof request.turn_detection === "string"
            ? { mode: request.turn_detection }
            : { ...request.turn_detection };
    if (request.eager !== undefined) {
        turnDetection.eager = request.eager;
    }

    const results: RealtimeSTTResults = { ...request.results };
    if (request.drafts !== undefined) {
        results.drafts = request.drafts;
    }
    if (request.diarize !== undefined) {
        results.diarize = request.diarize;
    }

    const context = { ...request.context };
    if (request.terms !== undefined) {
        context.terms = request.terms;
    }

    return dropUndefined({
        type: "config",
        audio: { format: "pcm_s16le", sample_rate: request.sample_rate ?? 16000, channels: 1 },
        turn_detection: nonEmpty(turnDetection),
        results: nonEmpty(results),
        context: nonEmpty(context),
        client_reference_id: request.client_reference_id,
    });
}

/** @internal Encodes one client message as a MessagePack map. Audio bytes become MessagePack `bin`. */
export function encodeClientMessage(message: Record<string, unknown> | RealtimeSTTControlMessage): Uint8Array {
    return encode(message, { ignoreUndefined: true });
}

/**
 * @internal Decodes one server frame. Returns `undefined` for anything that is
 * not a message type this SDK knows, so new server messages are skipped.
 */
export function decodeServerEvent(frame: Uint8Array): RealtimeSTTEvent | undefined {
    let message: unknown;
    try {
        message = decode(frame);
    } catch {
        return undefined;
    }
    if (message == null || typeof message !== "object") {
        return undefined;
    }
    const type = (message as { type?: unknown }).type;
    if (typeof type !== "string" || !SERVER_EVENT_TYPES.has(type)) {
        return undefined;
    }
    const event = message as RealtimeSTTEvent;
    if (event.type === "committed" && event.user_turn == null) {
        event.user_turn = true;
    }
    return event;
}

/**
 * A realtime speech-to-text session.
 *
 * Iterate it to read the server's events; it ends after `session_done`. Call
 * its methods to send control messages while the session runs. Leaving a
 * `for await` loop early closes the connection.
 *
 * It throws {@link RealtimeSTTError} when the session fails, an API error such
 * as `UnauthorizedError` when the connection is refused, and the audio
 * source's own error when the audio source fails.
 *
 * @remarks
 * **Node.js only**: uses the `ws` package, like the realtime text-to-speech client.
 *
 * **Stopping the audio source**: whenever the session ends (`close()`, leaving
 * the loop, an error, an abort, `session_done`), the stream calls `return()` on
 * the audio source's iterator once, and does not wait for it. An iterator whose
 * `return()` releases a pending read stops at once. An async generator cannot:
 * its `return()` only runs after the `await` it is suspended on settles, so a
 * generator blocked on a read that never completes stays blocked, and its
 * `finally` block does not run. To stop such a source, end what it is waiting
 * for yourself (stop the recorder, destroy the stream it reads, or abort a
 * signal the generator races its read against) when you close the session.
 *
 * @example
 * ```typescript
 * const stream = client.speechToText.convertRealtime({ drafts: true, diarize: false }, microphone());
 * for await (const event of stream) {
 *     if (event.type === "committed") console.log(event.text);
 * }
 * ```
 */
export class RealtimeSTTStream implements AsyncIterableIterator<RealtimeSTTEvent> {
    readonly #events: RealtimeSTTEvent[] = [];
    readonly #waiters: Array<{
        resolve: (result: IteratorResult<RealtimeSTTEvent>) => void;
        reject: (error: unknown) => void;
    }> = [];
    /** No more events will be added. */
    #ended = false;
    #error: unknown;
    #hasError = false;

    #websocket: WebSocket | undefined;
    #paused = false;
    #closeTimer: ReturnType<typeof setTimeout> | undefined;
    #openTimer: ReturnType<typeof setTimeout> | undefined;
    #droppedByClient = false;

    readonly #configSent = deferred();
    readonly #sessionStarted = deferred();
    #sessionDone: RealtimeSTTSessionDoneEvent | undefined;
    #fatalError: RealtimeSTTErrorEvent | undefined;
    /** `server_restarting`, when it is the last message before the server closes. */
    #restarting: RealtimeSTTErrorEvent | undefined;
    readonly #connectTimeoutMs: number;
    /** The audio source's iterator while it may still need to be stopped. */
    #audioIterator: Iterator<unknown> | AsyncIterator<unknown> | undefined;

    readonly #abortSignal: AbortSignal | undefined;
    readonly #onAbort = (): void => {
        // The signal's own reason, whatever it is, as fetch() does.
        this.#end(this.#abortSignal?.reason);
    };

    /** @internal Use `client.speechToText.convertRealtime()`. */
    constructor(params: {
        connect: () => Promise<RealtimeSTTConnectParams>;
        request: RealtimeSTTRequest;
        audio: Iterable<RealtimeSTTAudioInput> | AsyncIterable<RealtimeSTTAudioInput>;
        abortSignal?: AbortSignal | undefined;
        connectTimeoutMs?: number | undefined;
    }) {
        this.#connectTimeoutMs = params.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.#abortSignal = params.abortSignal;
        if (this.#abortSignal?.aborted) {
            this.#end(this.#abortSignal.reason);
            return;
        }
        let config: Uint8Array;
        try {
            // Before anything is opened, so a config that cannot be encoded
            // fails the stream instead of throwing inside a socket callback.
            config = encodeClientMessage(buildConfigMessage(params.request));
        } catch (error) {
            this.#end(encodingError("the session config", error));
            return;
        }
        this.#abortSignal?.addEventListener("abort", this.#onAbort, { once: true });
        void this.#open(params.connect, config);
        void this.#sendAudio(params.audio);
    }

    // ----- reading ---------------------------------------------------------

    public next(): Promise<IteratorResult<RealtimeSTTEvent>> {
        const event = this.#events.shift();
        if (event !== undefined) {
            if (this.#paused && this.#events.length < EVENT_BUFFER_SIZE / 2) {
                this.#paused = false;
                this.#websocket?.resume();
            }
            return Promise.resolve({ done: false, value: event });
        }
        if (this.#ended) {
            if (this.#hasError) {
                const error = this.#error;
                this.#hasError = false;
                this.#error = undefined;
                return Promise.reject(error);
            }
            return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) => {
            this.#waiters.push({ resolve, reject });
        });
    }

    /** Called when a `for await` loop is left early. Closes the connection. */
    public async return(): Promise<IteratorResult<RealtimeSTTEvent>> {
        await this.close();
        return { done: true, value: undefined };
    }

    public [Symbol.asyncIterator](): this {
        return this;
    }

    // ----- control messages ------------------------------------------------

    /** Commits the open turn now (`reason: "finalize"`). Use it for push-to-talk in manual mode. */
    public finalize(): Promise<void> {
        return this.send({ type: "finalize" });
    }

    /**
     * Tells the server whether your voice agent is speaking. While it is, a short
     * acknowledgement from the user gives `user_backchannel` instead of
     * `user_turn_taken`. Send it only when the value changes.
     */
    public agentSpeaking(speaking: boolean): Promise<void> {
        return this.send({ type: "agent_speaking", speaking });
    }

    /**
     * Adds conversation context, oldest first: typically each line your agent
     * speaks, as an `assistant` item. Committed user turns are added by the server.
     */
    public addContext(items: RealtimeSTTContextItem[], options: { resetHistory?: boolean } = {}): Promise<void> {
        return this.send({
            type: "context_add",
            items,
            ...(options.resetHistory !== undefined ? { reset_history: options.resetHistory } : {}),
        });
    }

    /** Changes settings during the session. The server answers with a `configured` event. */
    public configure(update: RealtimeSTTConfigureRequest): Promise<void> {
        // `type` last: a stray `type` on the update must not change the message.
        return this.send({ ...update, type: "configure" });
    }

    /** Keeps an idle session open. A session closes after 30 seconds without any client message. */
    public keepalive(): Promise<void> {
        return this.send({ type: "keepalive" });
    }

    /**
     * Sends a control message. Resolves once it is handed to the connection.
     *
     * @throws {RealtimeSTTError} If the session has ended, or the message
     * cannot be encoded as MessagePack (the session then goes on).
     */
    public async send(message: RealtimeSTTControlMessage): Promise<void> {
        let frame: Uint8Array;
        try {
            frame = encodeClientMessage(message);
        } catch (error) {
            throw encodingError("the message", error);
        }
        try {
            await this.#configSent.promise;
            await this.#sendFrame(frame);
        } catch {
            throw new RealtimeSTTError({ message: "The realtime session is closed." });
        }
    }

    /**
     * Ends the session and closes the connection. Events not read yet are
     * dropped, and a pending or later read reports the end of the stream.
     * Safe to call more than once.
     *
     * The audio source is told to stop through its iterator's `return()`, which
     * is not awaited: `close()` resolves when the connection is closed, whatever
     * the source does. See the class remarks for sources that `return()` cannot stop.
     */
    public async close(): Promise<void> {
        this.#events.length = 0;
        this.#hasError = false;
        this.#error = undefined;
        this.#end();
        const websocket = this.#websocket;
        if (websocket === undefined || websocket.readyState === WebSocket.CLOSED) {
            return;
        }
        await new Promise<void>((resolve) => {
            websocket.once("close", () => resolve());
        });
    }

    // ----- connection ------------------------------------------------------

    async #open(connect: () => Promise<RealtimeSTTConnectParams>, config: Uint8Array): Promise<void> {
        // One deadline for the whole opening: resolving the connection
        // parameters, connecting, and the WebSocket handshake. Without it, a
        // peer that accepts the connection and never answers the upgrade (or a
        // supplier that never resolves) would leave the stream waiting forever.
        this.#openTimer = setTimeout(() => {
            this.#end(
                new RealtimeSTTError({
                    message: `The realtime connection timed out: it did not open within ${this.#connectTimeoutMs / 1000} s.`,
                }),
            );
        }, this.#connectTimeoutMs);

        let params: RealtimeSTTConnectParams;
        try {
            params = await connect();
        } catch (error) {
            this.#end(error);
            return;
        }
        if (this.#ended) {
            return;
        }

        let websocket: WebSocket;
        try {
            // Throws at once for a malformed URL or a header value that HTTP does not allow.
            websocket = new WebSocket(params.url, { headers: params.headers });
        } catch (error) {
            this.#end(connectionError("Could not open the realtime connection", toError(error)));
            return;
        }
        this.#websocket = websocket;

        // A handler that throws would throw out of the socket's event emitter,
        // past the stream and into the process, so each one is guarded.
        websocket.on(
            "open",
            this.#guarded(() => {
                clearTimeout(this.#openTimer);
                websocket.send(
                    config,
                    this.#guarded((error?: Error | null) => {
                        if (error) {
                            this.#end(connectionError("Could not start the realtime session", error));
                        } else {
                            this.#configSent.resolve();
                        }
                    }),
                );
            }),
        );
        websocket.on(
            "message",
            this.#guarded((data: WebSocket.RawData, isBinary: boolean) => {
                if (this.#ended || !isBinary) {
                    return;
                }
                const event = decodeServerEvent(toBytes(data));
                if (event !== undefined) {
                    this.#receive(event);
                }
            }),
        );
        websocket.on(
            "unexpected-response",
            this.#guarded((request: ClientRequest, response: IncomingMessage) => {
                void readRefusalBody(response).then(
                    this.#guarded((body: unknown) => {
                        request.destroy();
                        this.#end(handshakeError(response.statusCode ?? 0, body));
                    }),
                );
            }),
        );
        websocket.on(
            "error",
            this.#guarded((error: Error) => {
                this.#end(connectionError("The realtime connection failed", error));
            }),
        );
        websocket.on(
            "close",
            this.#guarded((code: number, reason: Buffer) => {
                clearTimeout(this.#closeTimer);
                this.#onClose(code, reason.toString());
            }),
        );
    }

    /**
     * Wraps a callback that runs outside the stream's own promises (socket
     * events, send callbacks): if it throws, the session ends with that error
     * instead of the exception escaping to the process.
     */
    #guarded<Args extends unknown[]>(callback: (...args: Args) => void): (...args: Args) => void {
        return (...args) => {
            try {
                callback(...args);
            } catch (error) {
                this.#end(
                    new RealtimeSTTError({
                        message: `The realtime session failed unexpectedly: ${toError(error).message}`,
                        cause: error,
                    }),
                );
            }
        };
    }

    #receive(event: RealtimeSTTEvent): void {
        this.#restarting = undefined;
        switch (event.type) {
            case "session_started":
                this.#push(event);
                this.#sessionStarted.resolve();
                return;
            case "session_done":
                // Held until the connection is closed, so the consumer never
                // sees the end of the session with the socket still open.
                this.#sessionDone = event;
                this.#closeWebSocket();
                return;
            case "error":
                if (event.recoverable) {
                    // The one recoverable error that the server follows with a
                    // close (1012): it then explains the close. Any other
                    // recoverable error says nothing about a later close.
                    if (event.error_type === "server_restarting") {
                        this.#restarting = event;
                    }
                    this.#push(event);
                } else {
                    // The server closes next, and its close code completes the
                    // error, so wait for it instead of closing from this side.
                    this.#fatalError = event;
                    this.#resumeReading();
                    this.#dropAfterTimeout();
                }
                return;
            default:
                this.#push(event);
        }
    }

    #onClose(code: number, reason: string): void {
        if (this.#ended) {
            return;
        }
        if (this.#sessionDone !== undefined) {
            this.#push(this.#sessionDone);
            this.#end();
            return;
        }
        const closeCode = this.#droppedByClient ? undefined : code;
        const error = this.#fatalError ?? (code === 1000 ? undefined : this.#restarting);
        if (error !== undefined) {
            this.#end(
                new RealtimeSTTError({
                    message: `${error.error_type}: ${error.message}`,
                    statusCode: error.code,
                    errorType: error.error_type,
                    requestId: error.request_id,
                    recoverable: error.recoverable,
                    closeCode,
                }),
            );
        } else if (code === 1000) {
            this.#end();
        } else {
            this.#end(
                new RealtimeSTTError({
                    message: `The realtime connection closed unexpectedly (code ${code}${reason ? `: ${reason}` : ""}).`,
                    closeCode,
                }),
            );
        }
    }

    #push(event: RealtimeSTTEvent): void {
        if (this.#ended) {
            return;
        }
        const waiter = this.#waiters.shift();
        if (waiter !== undefined) {
            waiter.resolve({ done: false, value: event });
            return;
        }
        this.#events.push(event);
        if (!this.#paused && this.#events.length >= EVENT_BUFFER_SIZE) {
            this.#paused = true;
            this.#websocket?.pause();
        }
    }

    /**
     * Ends the session: nothing more is read or sent, the connection is closed,
     * and everyone waiting on the stream is woken. Events already buffered are
     * still delivered, then `error` (if any) is thrown once.
     */
    #end(error?: unknown): void {
        if (this.#ended) {
            return;
        }
        this.#ended = true;
        if (arguments.length > 0) {
            this.#error = error;
            this.#hasError = true;
        }
        this.#abortSignal?.removeEventListener("abort", this.#onAbort);
        clearTimeout(this.#openTimer);
        this.#configSent.reject();
        this.#sessionStarted.reject();
        try {
            this.#closeWebSocket();
        } catch {
            // The connection is being discarded anyway; readers must still be woken.
        }
        this.#stopAudio();

        for (const waiter of this.#waiters.splice(0)) {
            if (this.#hasError) {
                this.#hasError = false;
                this.#error = undefined;
                waiter.reject(error);
            } else {
                waiter.resolve({ done: true, value: undefined });
            }
        }
    }

    #closeWebSocket(): void {
        const websocket = this.#websocket;
        if (websocket === undefined) {
            return;
        }
        this.#resumeReading();
        if (websocket.readyState === WebSocket.CONNECTING) {
            websocket.terminate();
        } else if (websocket.readyState === WebSocket.OPEN) {
            websocket.close(1000);
            this.#dropAfterTimeout();
        }
    }

    /** A paused socket would never read the server's close frame. */
    #resumeReading(): void {
        if (this.#paused) {
            this.#paused = false;
            this.#websocket?.resume();
        }
    }

    /** Drops the connection if the closing handshake does not finish in time. */
    #dropAfterTimeout(): void {
        clearTimeout(this.#closeTimer);
        this.#closeTimer = setTimeout(() => {
            this.#droppedByClient = true;
            this.#websocket?.terminate();
        }, CLOSE_TIMEOUT_MS);
    }

    // ----- sending ---------------------------------------------------------

    async #sendAudio(audio: Iterable<RealtimeSTTAudioInput> | AsyncIterable<RealtimeSTTAudioInput>): Promise<void> {
        try {
            await this.#sessionStarted.promise;
        } catch {
            return;
        }
        if (this.#ended) {
            // Closed in the same turn as session_started: do not start the audio source.
            return;
        }
        try {
            // Iterated by hand, not with `for await`: the session must be able
            // to call return() while a read is pending (see #stopAudio).
            // The async method when there is one, else the sync one, as `for await` chooses.
            const asyncMethod = (audio as Partial<AsyncIterable<RealtimeSTTAudioInput>>)[Symbol.asyncIterator];
            const iterator: Iterator<RealtimeSTTAudioInput> | AsyncIterator<RealtimeSTTAudioInput> =
                asyncMethod != null
                    ? asyncMethod.call(audio)
                    : (audio as Iterable<RealtimeSTTAudioInput>)[Symbol.iterator]();
            this.#audioIterator = iterator;
            if (this.#ended) {
                // Creating the iterator ended the session: do not read from it.
                return;
            }
            for (;;) {
                const result = await iterator.next();
                if (result.done) {
                    // The source finished by itself: nothing left to stop.
                    this.#audioIterator = undefined;
                    break;
                }
                if (this.#ended) {
                    return;
                }
                const item = await result.value;
                let frame: Uint8Array;
                try {
                    frame = encodeClientMessage(isBytes(item) ? { type: "audio", data: toUint8Array(item) } : item);
                } catch (error) {
                    // Handled below like a failing source, so that it does not
                    // replace a server error that is waiting for the close.
                    throw encodingError("an item of the audio stream", error);
                }
                await this.#sendFrame(frame);
            }
            if (!this.#ended) {
                await this.#sendFrame(AUDIO_DONE);
            }
        } catch (error) {
            if (error instanceof SendFailed) {
                // The connection went away; its close or error event ends the session.
                return;
            }
            if (this.#fatalError !== undefined) {
                // The server already ended the session with an error; that one
                // is reported, once the close (or its timeout) completes it.
                return;
            }
            // The audio source failed, or gave an item that cannot be sent: the
            // session ends with that error, and the source is stopped below.
            this.#end(error);
        } finally {
            // However the sender stopped, the source is not left running.
            this.#stopAudio();
        }
    }

    /**
     * Tells the audio source to stop, once, by calling its iterator's
     * `return()`. Not awaited: a source whose `return()` never settles (or an
     * async generator suspended on a read that never completes) must not hold
     * up the session's shutdown. A failing `return()` is ignored.
     */
    #stopAudio(): void {
        const iterator = this.#audioIterator;
        this.#audioIterator = undefined;
        if (iterator === undefined) {
            return;
        }
        try {
            // Inside the try from the lookup on: a getter may throw too.
            const stop: unknown = iterator.return;
            if (typeof stop === "function") {
                void Promise.resolve((stop as () => unknown).call(iterator)).catch(() => {});
            }
        } catch {
            // Cleanup of the caller's source must not fail the session.
        }
    }

    #sendFrame(frame: Uint8Array): Promise<void> {
        return new Promise((resolve, reject) => {
            const websocket = this.#websocket;
            if (this.#ended || websocket === undefined || websocket.readyState !== WebSocket.OPEN) {
                reject(new SendFailed());
                return;
            }
            websocket.send(frame, (error) => {
                if (error) {
                    reject(new SendFailed());
                } else {
                    resolve();
                }
            });
        });
    }
}

const AUDIO_DONE = encodeClientMessage({ type: "audio_done" });

class SendFailed extends Error {}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
    let resolve!: () => void;
    let reject!: () => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = () => rej(new SendFailed());
    });
    // Nobody may be waiting when the session ends.
    promise.catch(() => {});
    return { promise, resolve, reject };
}

function toError(value: unknown): Error {
    if (value instanceof Error) {
        return value;
    }
    try {
        return new Error(String(value));
    } catch {
        // For example an object without a prototype, which has no toString().
        return new Error("a value that cannot be shown was thrown");
    }
}

function encodingError(what: string, cause: unknown): RealtimeSTTError {
    return new RealtimeSTTError({
        message: `Could not encode ${what} as MessagePack: ${toError(cause).message}`,
        cause,
    });
}

function connectionError(prefix: string, cause: Error): RealtimeSTTError {
    return new RealtimeSTTError({ message: `${prefix}: ${cause.message}`, cause });
}

function handshakeError(statusCode: number, body: unknown): FishAudioError {
    switch (statusCode) {
        case 400:
            return new apiErrors.BadRequestError(body as apiErrors.BadRequestErrorBody);
        case 401:
            return new apiErrors.UnauthorizedError(body);
        case 403:
            return new apiErrors.ForbiddenError(body);
        case 404:
            return new apiErrors.NotFoundError(body);
        default:
            return new FishAudioError({
                message: "The realtime connection was refused.",
                statusCode,
                body,
            });
    }
}

function readRefusalBody(response: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = (): void => {
            clearTimeout(timer);
            const text = Buffer.concat(chunks).toString("utf8");
            if (text === "") {
                resolve(undefined);
                return;
            }
            try {
                resolve(JSON.parse(text));
            } catch {
                resolve(text);
            }
        };
        const timer = setTimeout(finish, CLOSE_TIMEOUT_MS);
        response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_REFUSAL_BODY_BYTES) {
                chunks.push(chunk);
            }
        });
        response.once("end", finish);
        response.once("error", finish);
        response.once("close", finish);
    });
}

function toBytes(data: WebSocket.RawData): Uint8Array {
    if (Array.isArray(data)) {
        return Buffer.concat(data);
    }
    return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

// These checks hold for values from another realm (a `node:vm` context, a
// worker), where `instanceof` does not.
function isBytes(item: RealtimeSTTAudioInput): item is ArrayBufferView | ArrayBuffer {
    return ArrayBuffer.isView(item) || types.isAnyArrayBuffer(item);
}

function toUint8Array(bytes: ArrayBufferView | ArrayBuffer): Uint8Array {
    return ArrayBuffer.isView(bytes)
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
}

function nonEmpty<T extends object>(value: T): T | undefined {
    const cleaned = dropUndefined(value as Record<string, unknown>);
    return Object.keys(cleaned).length > 0 ? (cleaned as T) : undefined;
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
