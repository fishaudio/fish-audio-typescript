import { SpeechToText } from "../../api/resources/speechToText/Client.js";
import * as core from "../../core/index.js";
import * as environments from "../../environments.js";
import { withUserAgent } from "../../core/userAgent.js";
import { FishAudioError } from "../../errors/FishAudioError.js";
import { RealtimeSTTStream } from "./RealtimeSTTStream.js";
import type { RealtimeSTTAudioInput, RealtimeSTTRequest, RealtimeSTTRequestOptions } from "./realtimeSTTTypes.js";

/**
 * Speech-to-text client with realtime transcription over WebSocket.
 * @remarks
 * **Node.js only**: `convertRealtime` uses the `ws` package and authenticates
 * with a request header, which browsers cannot set on a WebSocket.
 */
export class SpeechToTextWebSocket extends SpeechToText {
    constructor(options: SpeechToText.Options = {}) {
        super(options);
    }

    /**
     * Transcribes live audio in realtime (Preview).
     *
     * Send 16-bit little-endian mono PCM in chunks of 20–40 ms as you capture
     * it. The SDK opens the session, sends each chunk as the audio source
     * yields it, and ends the session when the source is exhausted.
     *
     * @param request - Session settings. `{}` is valid: 16 kHz audio, automatic turn detection.
     * @param audioStream - Chunks of PCM audio (`Buffer`, a typed array or `ArrayBuffer`). A control message such as
     * `{ type: "agent_speaking", speaking: true }` in the stream is sent at that position.
     * @param requestOptions - Request-specific configuration.
     * When the session ends, the stream calls `return()` on this source's iterator without
     * waiting for it. An async generator suspended on a read is not interrupted by that; see
     * {@link RealtimeSTTStream} for how to stop such a source.
     * @returns The session: iterate it for events, call its methods to send control messages.
     *
     * @remarks
     * **Node.js only**: This method uses Node.js-specific APIs.
     *
     * @example
     * ```typescript
     * const stream = client.speechToText.convertRealtime({ drafts: true, diarize: false }, microphone());
     * for await (const event of stream) {
     *     if (event.type === "draft") console.log("...", event.text);
     *     if (event.type === "committed") console.log(event.text);
     * }
     * ```
     */
    public convertRealtime(
        request: RealtimeSTTRequest,
        audioStream: Iterable<RealtimeSTTAudioInput> | AsyncIterable<RealtimeSTTAudioInput>,
        requestOptions: RealtimeSTTRequestOptions = {},
    ): RealtimeSTTStream {
        return new RealtimeSTTStream({
            request,
            audio: audioStream,
            abortSignal: requestOptions.abortSignal,
            connectTimeoutMs:
                requestOptions.timeoutInSeconds != null ? requestOptions.timeoutInSeconds * 1000 : undefined,
            connect: async () => {
                const apiKey = await core.Supplier.get(this._options.apiKey);
                if (!apiKey) {
                    throw new FishAudioError({ message: "API key is required" });
                }
                const baseUrl =
                    (await core.Supplier.get(this._options.baseUrl)) ??
                    (await core.Supplier.get(this._options.environment)) ??
                    environments.FishAudioEnvironment.Production;
                // The client's extra headers go along, as they do on HTTP requests
                // (a gateway in front of a custom baseUrl may need them). The API
                // key and the realtime model replace a header of the same name in
                // any casing, so the handshake never carries two of either.
                const headers: Record<string, string> = {};
                for (const [name, supplier] of Object.entries(this._options.headers ?? {})) {
                    if (["authorization", "model"].includes(name.toLowerCase())) {
                        // Replaced below, so its supplier is not run either.
                        continue;
                    }
                    const value = await core.Supplier.get(supplier);
                    if (value != null) {
                        headers[name] = value;
                    }
                }
                headers.Authorization = `Bearer ${apiKey}`;
                headers.model = request.model ?? "transcribe-stream-1";
                return {
                    // Joined as HTTP requests are, so a path or query on baseUrl is kept.
                    url: core.url.join(baseUrl.replace(/^http/i, "ws"), "v1/asr/realtime"),
                    headers: withUserAgent(headers),
                };
            },
        });
    }
}
