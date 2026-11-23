/**
 * Types for realtime speech-to-text (`wss://api.fish.audio/v1/asr/realtime`).
 *
 * Field names match the wire protocol, so events and messages use snake_case.
 */

/** Sample rates the realtime endpoint accepts, in Hz. Audio is always 16-bit little-endian mono PCM. */
export type RealtimeSTTSampleRate = 8000 | 12000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;

/**
 * How the server decides that a turn has ended.
 * - `auto`: the server's turn detection decides, and tells user turns from noise and other voices.
 * - `vad`: a turn ends after `silence_timeout_ms` of silence.
 * - `manual`: a turn ends when you call `finalize()`.
 */
export type RealtimeSTTTurnDetectionMode = "auto" | "vad" | "manual";

export interface RealtimeSTTTurnDetection {
    /** Defaults to `auto`. */
    mode?: RealtimeSTTTurnDetectionMode;
    /** Send `eager_end_of_turn` in auto mode. Defaults to `false`. */
    eager?: boolean;
    /** auto: 3000–60000 (default 5000). vad: 300–60000 (default 700). manual: 300–60000 (default 60000). */
    silence_timeout_ms?: number;
}

export interface RealtimeSTTResults {
    /** Send live `draft` events. Defaults to `false`. */
    drafts?: boolean;
    /** `false` adds `words` with timings to `committed`. Defaults to `true`. */
    ignore_timestamps?: boolean;
    /** Speaker tags such as `<|speaker:0|>` in the text. Defaults to `true`; `false` removes them. */
    diarize?: boolean | "auto" | "true" | "false";
    /** Sound tags such as `[laughter]` in the text. Defaults to `true`; `false` removes them. */
    tag_audio_events?: boolean;
    /** Send `vad` events. Defaults to `false`. */
    vad_events?: boolean;
    /** Send `eot_prob` events. Defaults to `false`. */
    eot_events?: boolean;
}

export interface RealtimeSTTContextItem {
    role: "user" | "assistant";
    text: string;
}

export interface RealtimeSTTContext {
    /** Earlier conversation, oldest first (at most 32 items). */
    history?: RealtimeSTTContextItem[];
    /** Names, products and jargon to recognize (at most 100 terms of 32 characters). */
    terms?: string[];
}

/** Realtime speech-to-text models. `transcribe-stream-1` (Preview) is the default and the only one today. */
export type RealtimeSTTModel = "transcribe-stream-1" | (string & {});

/**
 * Settings for a realtime speech-to-text session.
 *
 * The common settings are top-level (`drafts`, `diarize`, `eager`, `terms`); the nested
 * `results` and `context` objects reach every field of the protocol. A top-level
 * setting wins over the same setting in a nested object.
 */
export interface RealtimeSTTRequest {
    /** Sample rate of the audio you send, in Hz. Defaults to 16000. */
    sample_rate?: RealtimeSTTSampleRate;
    /** A mode name, or the full turn detection settings. Defaults to `auto`. */
    turn_detection?: RealtimeSTTTurnDetectionMode | RealtimeSTTTurnDetection;
    /** Send `eager_end_of_turn` in auto mode, so a voice agent can prepare its reply early. */
    eager?: boolean;
    /** Send live `draft` events while a turn is open. */
    drafts?: boolean;
    /**
     * Speaker tags in the text. The server default is `true`, so transcripts start
     * with a tag such as `<|speaker:0|>`; pass `false` for plain text.
     */
    diarize?: boolean;
    /** Names, products and jargon to recognize. */
    terms?: string[];
    /** Every result setting of the protocol. */
    results?: RealtimeSTTResults;
    /** Conversation history and terms. */
    context?: RealtimeSTTContext;
    /** Your own ID for the session (at most 256 characters). Recorded with the session; not sent back. */
    client_reference_id?: string;
    /** Defaults to `transcribe-stream-1`. */
    model?: RealtimeSTTModel;
}

export interface RealtimeSTTRequestOptions {
    /** Ends the session when aborted; the stream then throws the signal's reason. */
    abortSignal?: AbortSignal;
}

/** Settings `configure()` can change during a session. A field you leave out keeps its value. */
export interface RealtimeSTTConfigureRequest {
    turn_detection?: RealtimeSTTTurnDetection;
    results?: RealtimeSTTResults;
    /** Replaces the list of terms. History cannot be changed here; use `addContext()`. */
    context?: { terms?: string[] };
}

// ---------------------------------------------------------------------------
// Client messages
// ---------------------------------------------------------------------------

export interface RealtimeSTTFinalizeMessage {
    type: "finalize";
}

export interface RealtimeSTTAgentSpeakingMessage {
    type: "agent_speaking";
    speaking: boolean;
}

export interface RealtimeSTTContextAddMessage {
    type: "context_add";
    items: RealtimeSTTContextItem[];
    reset_history?: boolean;
}

export interface RealtimeSTTConfigureMessage extends RealtimeSTTConfigureRequest {
    type: "configure";
}

export interface RealtimeSTTKeepaliveMessage {
    type: "keepalive";
}

/**
 * Control messages a client can send during a session. `config`, `audio` and
 * `audio_done` are sent by the SDK.
 */
export type RealtimeSTTControlMessage =
    | RealtimeSTTFinalizeMessage
    | RealtimeSTTAgentSpeakingMessage
    | RealtimeSTTContextAddMessage
    | RealtimeSTTConfigureMessage
    | RealtimeSTTKeepaliveMessage;

/** One item of the audio input: a chunk of PCM bytes, or a control message to send at that position. */
export type RealtimeSTTAudioInput = Uint8Array | ArrayBuffer | RealtimeSTTControlMessage;

// ---------------------------------------------------------------------------
// Server events
// ---------------------------------------------------------------------------

/** Audio positions the server reports on some events. */
export interface RealtimeSTTWatermarks {
    audio_received_ms?: number;
    audio_processed_ms?: number;
    audio_committed_ms?: number;
}

export interface RealtimeSTTLimits {
    max_session_ms?: number;
    max_turn_ms?: number;
    max_frame_bytes?: number;
}

/** The session is ready. The SDK starts sending audio after this event. */
export interface RealtimeSTTSessionStartedEvent {
    type: "session_started";
    seq: number;
    session_id: string;
    /** Include it when you contact support. */
    request_id: string;
    /** The configuration in effect, with defaults filled in. */
    config: Record<string, unknown>;
    limits: RealtimeSTTLimits;
}

/** A turn opened on voice activity. In auto mode, wait for `user_turn_taken` before treating it as the user's. */
export interface RealtimeSTTSpeechStartEvent {
    type: "speech_start";
    seq: number;
    turn_index: number;
    audio_ms: number;
}

/** Auto mode: the user is taking their turn. For a voice agent that is speaking, the signal to stop. */
export interface RealtimeSTTUserTurnTakenEvent {
    type: "user_turn_taken";
    seq: number;
    turn_index: number;
    audio_ms: number;
}

/** Live draft of the open turn (with `drafts: true`). Not final. */
export interface RealtimeSTTDraftEvent extends RealtimeSTTWatermarks {
    type: "draft";
    seq: number;
    turn_index: number;
    /** The whole turn so far. Replaces the previous draft. */
    text: string;
    /** The beginning of `text` that the server is confident will not change. Often empty. */
    settled_text: string;
    language?: string;
    language_code?: string;
    audio_ms: number;
}

/** With `eager: true` in auto mode: the turn has probably ended. `turn_resumed` cancels it. */
export interface RealtimeSTTEagerEndOfTurnEvent {
    type: "eager_end_of_turn";
    seq: number;
    turn_index: number;
    /** Exactly what `committed` will say unless `turn_resumed` follows. */
    text: string;
    language?: string;
    language_code?: string;
    audio_ms?: number;
}

/** The speaker went on after `eager_end_of_turn`: discard that text. */
export interface RealtimeSTTTurnResumedEvent {
    type: "turn_resumed";
    seq: number;
    turn_index: number;
}

/** Auto mode, while your agent is speaking: the user acknowledged without taking the turn. */
export interface RealtimeSTTUserBackchannelEvent {
    type: "user_backchannel";
    seq: number;
    turn_index: number;
    audio_ms: number;
}

export interface RealtimeSTTWord {
    text: string;
    start_ms: number;
    end_ms: number;
}

export type RealtimeSTTCommitReason =
    | "eot"
    | "finalize"
    | "silence_timeout"
    | "max_turn_duration"
    | "audio_done"
    | (string & {});

export type RealtimeSTTTurnKind = "user" | "backchannel" | "other" | (string & {});

/** The final transcript of a turn. Every turn has exactly one. */
export interface RealtimeSTTCommittedEvent extends RealtimeSTTWatermarks {
    type: "committed";
    seq: number;
    turn_index: number;
    /**
     * The final transcript. Starts with a speaker tag such as `<|speaker:0|>` unless
     * the session runs with `diarize: false`. Can be empty.
     */
    text: string;
    /** Present when `results.ignore_timestamps` is `false` and the commit is not degraded. */
    words?: RealtimeSTTWord[];
    language?: string;
    language_code?: string;
    audio_start_ms: number;
    audio_end_ms: number;
    /** Why the turn ended. Treat an unknown value like `eot`. */
    reason: RealtimeSTTCommitReason;
    /** `true` when the final pass failed and the text comes from the last draft. */
    degraded: boolean;
    /** `true` for the user's turn. The SDK fills in `true` when the server leaves it out. */
    user_turn: boolean;
    turn_kind: RealtimeSTTTurnKind;
}

/** Voice activity (with `results.vad_events: true`). */
export interface RealtimeSTTVadEvent {
    type: "vad";
    seq: number;
    audio_ms: number;
    score: number;
}

/** End-of-turn likelihood (with `results.eot_events: true`). */
export interface RealtimeSTTEotProbEvent {
    type: "eot_prob";
    seq: number;
    turn_index: number;
    audio_ms: number;
    prob: number;
}

/** The reply to `configure()`. `ok: false` means nothing changed. */
export interface RealtimeSTTConfiguredEvent {
    type: "configured";
    seq: number;
    ok: boolean;
    config: Record<string, unknown>;
    /** Present when `ok` is `false`. */
    message?: string;
}

/** Watermarks, every 5 seconds while the client sends nothing. */
export interface RealtimeSTTProgressEvent extends RealtimeSTTWatermarks {
    type: "progress";
    seq: number;
}

export type RealtimeSTTErrorType =
    | "invalid_config"
    | "unsupported_audio"
    | "invalid_request"
    | "idle_timeout"
    | "max_duration_exceeded"
    | "frame_too_large"
    | "engine_error"
    | "internal"
    | "server_restarting"
    | (string & {});

/**
 * An error the session survives (`recoverable: true`). An error that ends the
 * session is thrown as {@link RealtimeSTTError} instead of being yielded.
 */
export interface RealtimeSTTErrorEvent {
    type: "error";
    seq: number;
    /** HTTP-style status. */
    code: number;
    /** Match on this field, not on `message`. */
    error_type: RealtimeSTTErrorType;
    message: string;
    request_id: string;
    recoverable: boolean;
}

/** The last event of a session that ended with `audio_done`. */
export interface RealtimeSTTSessionDoneEvent {
    type: "session_done";
    seq: number;
    stats: {
        audio_ms?: number;
        turns?: number;
        request_id?: string;
    };
}

/** Every event a realtime speech-to-text session yields. Narrow it by `type`. */
export type RealtimeSTTEvent =
    | RealtimeSTTSessionStartedEvent
    | RealtimeSTTSpeechStartEvent
    | RealtimeSTTUserTurnTakenEvent
    | RealtimeSTTDraftEvent
    | RealtimeSTTEagerEndOfTurnEvent
    | RealtimeSTTTurnResumedEvent
    | RealtimeSTTUserBackchannelEvent
    | RealtimeSTTCommittedEvent
    | RealtimeSTTVadEvent
    | RealtimeSTTEotProbEvent
    | RealtimeSTTConfiguredEvent
    | RealtimeSTTProgressEvent
    | RealtimeSTTErrorEvent
    | RealtimeSTTSessionDoneEvent;
