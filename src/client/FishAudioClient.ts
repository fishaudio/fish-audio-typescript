import * as environments from "../environments.js";
import { mergeHeaders } from "../core/headers.js";
import { HeaderProvider, Supplier } from "../core/index.js";
import { checkHeaderProvider } from "../core/headerProvider.js";
import * as errors from "../errors/index.js";
import { TextToSpeechWebSocket } from "./websocket/TextToSpeechWebSocketClient.js";
import { Voices } from "../api/resources/voices/Client.js";
import { SpeechToTextWebSocket } from "./websocket/SpeechToTextWebSocketClient.js";
import { User } from "../api/resources/user/Client.js";

export declare namespace FishAudioClient {
    export interface Options {
        environment?: Supplier<environments.FishAudioEnvironment | string>;
        /** Specify a custom URL to connect the client to. */
        baseUrl?: Supplier<string>;
        /** Override the Authorization header */
        apiKey?: Supplier<string | undefined>;
        /** Additional headers to include in requests. */
        headers?: Record<string, string | Supplier<string | null | undefined> | null | undefined>;
        /**
         * Called for every HTTP request (once per attempt) and every WebSocket
         * handshake, right before it is sent, to add headers such as the W3C
         * `traceparent` of your current request. Synchronous; runs in the call's
         * async context, so `AsyncLocalStorage` and OpenTelemetry's
         * `context.active()` see the caller's values. Headers the SDK sets win
         * over it, and so does a name in the `headers` above or in per-call
         * `requestOptions.headers`, also with a `null` or `undefined` value,
         * which sends no such header. An error it throws fails the call
         * unchanged. A value must be empty, or visible ASCII with spaces or
         * tabs only between characters; any other value throws `TypeError`
         * (without the value) before anything is sent. Do not return
         * `traceparent` when `@opentelemetry/instrumentation-undici` is active:
         * it adds its own, and two make the API start a new trace. For
         * OpenTelemetry without HTTP instrumentation, use
         * `openTelemetryHeaders(api)`.
         *
         * When the trace the API used (its `x-fish-trace-id` response header) is
         * not the one in the `traceparent` the SDK sent, the SDK warns once per
         * process: a `FishAudioTraceWarning`, code
         * `FISH_AUDIO_TRACE_NOT_CONTINUED`. Usual causes: on HTTP, the undici
         * instrumentation plus this provider (keep only one); on the WebSocket
         * handshakes, the http instrumentation replacing a trace that is not the
         * active span's. See the README's "Tracing".
         */
        headerProvider?: HeaderProvider;
    }

    export interface RequestOptions {
        /** The maximum time to wait for a response in seconds. */
        timeoutInSeconds?: number;
        /** The number of times to retry the request. Defaults to 2. */
        maxRetries?: number;
        /** A hook to abort the request. */
        abortSignal?: AbortSignal;
        /** Override the Authorization header */
        apiKey?: string | undefined;
        /** Additional query string parameters to include in the request. */
        queryParams?: Record<string, unknown>;
        /** Additional headers to include in the request. */
        headers?: Record<string, string | Supplier<string | null | undefined> | null | undefined>;
    }
}

export class FishAudioClient {
    protected readonly _options: FishAudioClient.Options;
    protected _textToSpeech: TextToSpeechWebSocket | undefined;
    protected _voices: Voices | undefined;
    protected _speechToText: SpeechToTextWebSocket | undefined;
    protected _user: User | undefined;

    constructor(_options: FishAudioClient.Options = {}) {
        const apiKey = _options.apiKey ?? process.env.FISH_API_KEY;
        if (apiKey == null) {
            throw new errors.FishAudioError({
                message: "Please pass in your FishAudio API Key or export FISH_API_KEY in your environment.",
            });
        }
        _options.apiKey = apiKey;
        checkHeaderProvider(_options.headerProvider);
        this._options = {
            ..._options,
            // User-Agent is added to every request and handshake by withUserAgent();
            // a User-Agent in these headers is appended to it.
            headers: mergeHeaders(
                typeof _options?.apiKey === "string" ? { Authorization: `Bearer ${_options.apiKey}` } : {},
                _options?.headers,
            ),
        };
    }

    public get textToSpeech(): TextToSpeechWebSocket {
        return (this._textToSpeech ??= new TextToSpeechWebSocket(this._options));
    }

    public get voices(): Voices {
        return (this._voices ??= new Voices(this._options));
    }

    public get speechToText(): SpeechToTextWebSocket {
        return (this._speechToText ??= new SpeechToTextWebSocket(this._options));
    }

    public get user(): User {
        return (this._user ??= new User(this._options));
    }
}
