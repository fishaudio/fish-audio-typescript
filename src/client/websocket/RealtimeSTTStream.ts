import WebSocket from "ws";
import { decode, encode } from "@msgpack/msgpack";
import type { IncomingMessage } from "node:http";
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
    #droppedByClient = false;

    readonly #configSent = deferred();
    readonly #sessionStarted = deferred();
    #sessionDone: RealtimeSTTSessionDoneEvent | undefined;
    #fatalError: RealtimeSTTErrorEvent | undefined;
    #lastError: RealtimeSTTErrorEvent | undefined;

    readonly #abortSignal: AbortSignal | undefined;
    readonly #onAbort = (): void => {
        this.#end(abortReason(this.#abortSignal));
    };

    /** @internal Use `client.speechToText.convertRealtime()`. */
    constructor(params: {
        connect: () => Promise<RealtimeSTTConnectParams>;
        request: RealtimeSTTRequest;
        audio: Iterable<RealtimeSTTAudioInput> | AsyncIterable<RealtimeSTTAudioInput>;
        abortSignal?: AbortSignal | undefined;
    }) {
        this.#abortSignal = params.abortSignal;
        if (this.#abortSignal?.aborted) {
            this.#end(abortReason(this.#abortSignal));
            return;
        }
        this.#abortSignal?.addEventListener("abort", this.#onAbort, { once: true });
        void this.#open(params.connect, buildConfigMessage(params.request));
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
        return this.send({ type: "configure", ...update });
    }

    /** Keeps an idle session open. A session closes after 30 seconds without any client message. */
    public keepalive(): Promise<void> {
        return this.send({ type: "keepalive" });
    }

    /**
     * Sends a control message. Resolves once it is handed to the connection.
     *
     * @throws {RealtimeSTTError} If the session has ended.
     */
    public async send(message: RealtimeSTTControlMessage): Promise<void> {
        try {
            await this.#configSent.promise;
            await this.#sendFrame(message);
        } catch {
            throw new RealtimeSTTError({ message: "The realtime session is closed." });
        }
    }

    /**
     * Ends the session and closes the connection. Events not read yet are
     * dropped, and a pending or later read reports the end of the stream.
     * Safe to call more than once.
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

    async #open(connect: () => Promise<RealtimeSTTConnectParams>, config: Record<string, unknown>): Promise<void> {
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

        websocket.on("open", () => {
            websocket.send(encodeClientMessage(config), (error) => {
                if (error) {
                    this.#end(connectionError("Could not start the realtime session", error));
                } else {
                    this.#configSent.resolve();
                }
            });
        });
        websocket.on("message", (data, isBinary) => {
            if (this.#ended || !isBinary) {
                return;
            }
            const event = decodeServerEvent(toBytes(data));
            if (event !== undefined) {
                this.#receive(event);
            }
        });
        websocket.on("unexpected-response", (request, response) => {
            void readRefusalBody(response).then((body) => {
                request.destroy();
                this.#end(handshakeError(response.statusCode ?? 0, body));
            });
        });
        websocket.on("error", (error) => {
            this.#end(connectionError("The realtime connection failed", error));
        });
        websocket.on("close", (code, reason) => {
            clearTimeout(this.#closeTimer);
            this.#onClose(code, reason.toString());
        });
    }

    #receive(event: RealtimeSTTEvent): void {
        if (event.type !== "error") {
            this.#lastError = undefined;
        }
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
                this.#lastError = event;
                if (event.recoverable) {
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
        const error = this.#fatalError ?? (code === 1000 ? undefined : this.#lastError);
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
        this.#configSent.reject();
        this.#sessionStarted.reject();
        this.#closeWebSocket();

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
        try {
            for await (const item of audio) {
                if (this.#ended) {
                    // Leaving the loop closes the audio source if it is a generator.
                    break;
                }
                await this.#sendFrame(isBytes(item) ? { type: "audio", data: toUint8Array(item) } : item);
            }
            if (!this.#ended) {
                await this.#sendFrame({ type: "audio_done" });
            }
        } catch (error) {
            if (error instanceof SendFailed) {
                // The connection went away; its close or error event ends the session.
                return;
            }
            // The audio source failed: the session ends with its error.
            this.#end(error);
        }
    }

    #sendFrame(message: Record<string, unknown> | RealtimeSTTControlMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            const websocket = this.#websocket;
            if (this.#ended || websocket === undefined || websocket.readyState !== WebSocket.OPEN) {
                reject(new SendFailed());
                return;
            }
            websocket.send(encodeClientMessage(message), (error) => {
                if (error) {
                    reject(new SendFailed());
                } else {
                    resolve();
                }
            });
        });
    }
}

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

function abortReason(signal: AbortSignal | undefined): unknown {
    return signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
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

function isBytes(item: RealtimeSTTAudioInput): item is Uint8Array | ArrayBuffer {
    return item instanceof Uint8Array || item instanceof ArrayBuffer;
}

function toUint8Array(bytes: Uint8Array | ArrayBuffer): Uint8Array {
    return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
}

function nonEmpty<T extends object>(value: T): T | undefined {
    const cleaned = dropUndefined(value as Record<string, unknown>);
    return Object.keys(cleaned).length > 0 ? (cleaned as T) : undefined;
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
