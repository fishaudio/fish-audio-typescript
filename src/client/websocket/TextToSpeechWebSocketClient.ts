import { TextToSpeech } from "../../api/resources/textToSpeech/Client.js";
import WebSocket from "ws";
import { RealtimeConnection, StartEvent, TextEvent, CloseEvent } from "./connection.js";
import * as core from "../../core/index.js";
import * as environments from "../../environments.js";
import { handshakeHeaders } from "./handshakeHeaders.js";
import { checkTraceContinued, TRACE_ID_RESPONSE_HEADER } from "../../core/traceContinuation.js";
import { TTSRequest } from "../../api/resources/textToSpeech/requests/TTSRequest.js";
import { Backends } from "../../api/resources/textToSpeech/Client.js";

/** Request-specific configuration for {@link TextToSpeechWebSocket.convertRealtime}. */
export interface RealtimeTTSRequestOptions {
    /**
     * Additional headers for the WebSocket handshake. They are merged as on HTTP
     * requests: they win over the client's `headers` and its `headerProvider`.
     * A value must be empty, or visible ASCII with spaces or tabs only between
     * characters; any other value throws `TypeError` before connecting.
     */
    headers?: Record<string, string | core.Supplier<string | null | undefined> | null | undefined>;
}

/**
 * Text-to-Speech WebSocket client.
 * @remarks
 * **Node.js only**: This class uses Node.js-specific APIs (WebSocket from 'ws').
 * It will not work in browsers, Deno, or Cloudflare Workers without modifications.
 */
export class TextToSpeechWebSocket extends TextToSpeech {
    constructor(options: TextToSpeech.Options = {}) {
        super(options);
    }

    private async getWebSocketUri(): Promise<string> {
        // Get base URL from options, preferring baseUrl, then environment, then default Production
        const baseUrl =
            (await core.Supplier.get(this._options.baseUrl)) ??
            (await core.Supplier.get(this._options.environment)) ??
            environments.FishAudioEnvironment.Production;

        // Convert HTTP(S) to WS(S)
        const wsUrl = baseUrl.replace(/^https?:\/\//i, (match) =>
            match.toLowerCase() === "https://" ? "wss://" : "ws://"
        );

        return `${wsUrl}/v1/tts/live`;
    }

    /**
     * Establishes a WebSocket connection for real-time text-to-speech.
     *
     * @param options - Configuration options for the connection
     * @param requestOptions - Request-specific configuration: `headers` for the handshake.
     * @returns A promise that resolves to a RealtimeConnection instance
     *
     * @remarks
     * **Node.js only**: This method uses Node.js-specific APIs.
     *
     * @example
     * ```typescript
     * const connection = await client.textToSpeech.convertRealtime({
     *     request: TTSRequest,
     *     text_stream: "...",
     *     backend: "s2.1-pro",
     * });
     * ```
     */
    public async convertRealtime(
        request: TTSRequest,
        textStream: Iterable<string> | AsyncIterable<string>,
        backend: Backends = "s2.1-pro",
        requestOptions: RealtimeTTSRequestOptions = {},
    ): Promise<RealtimeConnection> {
        let apiKey = this._options.apiKey;
        if (!apiKey) {
            throw new Error("API key is required");
        }

        // Resolve API key if it's a function or promise
        if (typeof apiKey === "function") {
            apiKey = apiKey();
        }
        if (apiKey instanceof Promise) {
            apiKey = await apiKey;
        }

        if (!apiKey) {
            throw new Error("API key is required");
        }

        const connection = new RealtimeConnection();

        const uri = await this.getWebSocketUri();

        // The client's headers go along, as on HTTP requests and the realtime STT
        // handshake; a User-Agent among them is appended to the SDK's own.
        const headers = await handshakeHeaders({
            clientHeaders: this._options.headers,
            sdkHeaders: { Authorization: `Bearer ${apiKey as string}`, model: backend },
            requestHeaders: requestOptions.headers,
            headerProvider: this._options.headerProvider,
        });

        return new Promise((resolve) => {
            const websocket = new WebSocket(uri, { headers });
            // The handshake response: did Fish Audio continue a trace we sent?
            // A refused handshake (no listener for "unexpected-response" here, so
            // ws turns it into an "error") is not checked: listening for it
            // would take over handling the refusal from ws.
            websocket.on("upgrade", (response) =>
                checkTraceContinued(headers, () => response.headers[TRACE_ID_RESPONSE_HEADER]),
            );

            // Attach websocket to connection immediately so error handlers are registered
            // This ensures errors during handshake (like 403) are properly emitted via event emitter
            connection.setWebSocket(websocket);

            // Resolve immediately with connection so users can attach listeners
            resolve(connection);

            websocket.on("open", () => {
                connection.send(new StartEvent(request));
                (async () => {
                    try {
                        for await (const chunk of textStream) {
                            connection.send(new TextEvent(chunk));
                        }
                    } catch {
                        // swallow sender errors; receiver side will emit ERROR on finish=error
                    } finally {
                        try {
                            connection.send(new CloseEvent());
                        } catch {}
                    }
                })();
            });
        });
    }
}
