import WebSocket from "ws";
import { encode, decode } from "@msgpack/msgpack";
import { EventEmitter } from "node:events";
import type { TTSRequest } from "../../api/resources/textToSpeech/requests/TTSRequest.js";

export class StartEvent {
    readonly event = "start";
    readonly request: TTSRequest;

    constructor(request: TTSRequest) {
        this.request = request;
    }

    toJSON() {
        return {
            event: this.event,
            request: this.request,
        };
    }
}

export class TextEvent {
    readonly event = "text";
    readonly text: string;

    constructor(text: string) {
        this.text = text;
    }

    toJSON() {
        return {
            event: this.event,
            text: this.text,
        };
    }
}

export class FlushEvent {
    readonly event = "flush";

    toJSON() {
        return {
            event: this.event,
        };
    }
}

export class CloseEvent {
    readonly event = "stop";

    toJSON() {
        return { event: this.event };
    }
}

type WebSocketMessage = StartEvent | TextEvent | FlushEvent | CloseEvent;

/**
 * Events emitted by the RealtimeConnection.
 */
export enum RealtimeEvents {
    /** Emitted when audio chunk is received */
    AUDIO_CHUNK = "audio_chunk",
    /** Emitted when an error occurs */
    ERROR = "error",
    /** Emitted when the WebSocket connection is opened */
    OPEN = "open",
    /** Emitted when the WebSocket connection is closed */
    CLOSE = "close",
}

/**
 * Manages a real-time Text-to-Speech WebSocket connection.
 *
 * @remarks
 * **Node.js only**: This class uses Node.js-specific WebSocket implementation.
 *
 * @example
 * ```typescript
 * const connection = await client.textToSpeech.convertRealtime({
 *     request: TTSRequestOptions,
 *     text_stream: "...",
 *     model: "s2.1-pro",
 * });
 *
 * connection.on(RealtimeEvents.OPEN, (data) => {
 *     console.log("WebSocket opened");
 * });
 *
 * connection.on(RealtimeEvents.AUDIO_CHUNK, (data) => {
 *     console.log("Audio chunk received");
 * });
 *
 * connection.on(RealtimeEvents.ERROR, (error) => {
 *     console.error("Error:", error);
 * });
 *
 * connection.on(RealtimeEvents.CLOSE, () => {
 *     console.log("WebSocket closed");
 * });
 * ```
 */
export class RealtimeConnection {
    private websocket: WebSocket | null = null;
    private eventEmitter: EventEmitter = new EventEmitter();

    /**
     * @internal
     * Used internally by TextToSpeechWebSocket to attach the WebSocket after connection is created.
     */
    public setWebSocket(websocket: WebSocket): void {
        this.websocket = websocket;

        // If WebSocket is already open, emit OPEN event immediately
        if (this.websocket.readyState === WebSocket.OPEN) {
            this.eventEmitter.emit(RealtimeEvents.OPEN);
        } else {
            // Otherwise, wait for the open event
            this.websocket.on("open", () => {
                this.eventEmitter.emit(RealtimeEvents.OPEN);
            });
        }

        this.websocket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
            try {
                if (!isBinary) return;

                const bytes: Uint8Array | Buffer = Array.isArray(data)
                    ? Buffer.concat(data)
                    : Buffer.isBuffer(data)
                        ? data
                        : new Uint8Array(data as ArrayBuffer);

                const decoded: unknown = decode(bytes);

                if (!decoded || typeof decoded !== "object" || !("event" in decoded)) return;
                const eventType = (decoded as { event?: unknown }).event;

                if (eventType === "audio") {
                    const audio = (decoded as { audio?: unknown }).audio;
                    if (audio instanceof Uint8Array || Buffer.isBuffer(audio)) {
                        this.eventEmitter.emit(RealtimeEvents.AUDIO_CHUNK, audio);
                    }
                    return;
                }

                if (eventType === "finish") {
                    const reason = (decoded as { reason?: unknown }).reason;
                    if (reason === "error") {
                        const message = (decoded as { message?: unknown }).message;
                        this.eventEmitter.emit(RealtimeEvents.ERROR, new Error(typeof message === "string" ? message : "WebSocket error"));
                    } else if (reason === "stop") {
                        this.eventEmitter.emit(RealtimeEvents.CLOSE);
                    }
                    return;
                }
            } catch (err) {
                this.eventEmitter.emit(RealtimeEvents.ERROR, err);
            }
        });

        this.websocket.on("error", (error: Error) => {
            this.eventEmitter.emit(RealtimeEvents.ERROR, error);
        });

        this.websocket.on("close", () => {
            this.eventEmitter.emit(RealtimeEvents.CLOSE);
        });
    }

    /**
     * Attaches an event listener for the specified event.
     *
     * @param event - The event to listen for (use RealtimeEvents enum)
     * @param listener - The callback function to execute when the event fires
     *
     * @example
     * ```typescript
     * connection.on(RealtimeEvents.OPEN, (data) => {
     *     console.log("WebSocket opened");
     * });
     *
     * connection.on(RealtimeEvents.AUDIO_CHUNK, (data) => {
     *     console.log("Audio chunk received");
     * });
     *
     * connection.on(RealtimeEvents.ERROR, (error) => {
     *     console.error("Error:", error);
     * });
     *
     * connection.on(RealtimeEvents.CLOSE, () => {
     *     console.log("WebSocket closed");
     * });
     * ```
     */
    public on(event: RealtimeEvents, listener: (...args: unknown[]) => void): void {
        this.eventEmitter.on(event, listener);
    }

    /**
     * Removes an event listener for the specified event.
     *
     * @param event - The event to stop listening for
     * @param listener - The callback function to remove
     *
     * @example
     * ```typescript
     * const handler = (data) => console.log(data);
     * connection.on(RealtimeEvents.AUDIO_CHUNK, handler);
     *
     * // Later, remove the listener
     * connection.off(RealtimeEvents.AUDIO_CHUNK, handler);
     * ```
     */
    public off(event: RealtimeEvents, listener: (...args: unknown[]) => void): void {
        this.eventEmitter.off(event, listener);
    }

    /**
     * Sends a realtime message to the service.
     *
     * @throws {Error} If the WebSocket connection is not open
     */
    public send(message: WebSocketMessage): void {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket is not connected");
        }

        const payload = encode(message.toJSON());
        this.websocket.send(payload);
    }

    /**
     * Closes the WebSocket connection and cleans up resources.
     * This will terminate any ongoing text-to-speech conversion.
     *
     * @remarks
     * After calling close(), this connection cannot be reused.
     * Create a new connection if you need to start converting again.
     *
     */
    public close(): void {
        if (this.websocket) {
            this.websocket.close();
        }
    }
}

