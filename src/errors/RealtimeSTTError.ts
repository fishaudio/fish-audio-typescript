import { FishAudioError } from "./FishAudioError.js";

/**
 * A realtime speech-to-text session failed: the server sent an error that ends
 * the session, the connection closed with a code other than 1000, or the
 * connection was lost.
 */
export class RealtimeSTTError extends FishAudioError {
    /** `error_type` of the server's `error` message, such as `unsupported_audio`. Match on this field. */
    public readonly errorType?: string | undefined;
    /** `request_id` of the server's `error` message. Include it when you contact support. */
    public readonly requestId?: string | undefined;
    /** WebSocket close code, when the connection was closed with one. */
    public readonly closeCode?: number | undefined;
    /** `recoverable` of the server's `error` message. */
    public readonly recoverable?: boolean | undefined;

    constructor({
        message,
        statusCode,
        errorType,
        requestId,
        closeCode,
        recoverable,
        cause,
    }: {
        message: string;
        /** `code` of the server's `error` message (an HTTP-style status). */
        statusCode?: number | undefined;
        errorType?: string | undefined;
        requestId?: string | undefined;
        closeCode?: number | undefined;
        recoverable?: boolean | undefined;
        cause?: unknown;
    }) {
        super({ message, ...(statusCode != null ? { statusCode } : {}) });
        Object.setPrototypeOf(this, RealtimeSTTError.prototype);
        this.name = "RealtimeSTTError";
        this.errorType = errorType;
        this.requestId = requestId;
        this.closeCode = closeCode;
        this.recoverable = recoverable;
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}
