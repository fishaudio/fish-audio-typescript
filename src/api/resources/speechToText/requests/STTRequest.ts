/**
 * Speech-to-text models: `transcribe-1`, `transcribe-1-pro` and `transcribe-2-pro`.
 * `transcribe-1-pro` is recommended; the API's default is `transcribe-1`.
 */
export type STTModel = "transcribe-1" | "transcribe-1-pro" | "transcribe-2-pro" | (string & {});

export interface STTRequest {
    audio: File;
    /**
     * Model to transcribe with, such as `"transcribe-1-pro"`. Sent as the `model`
     * header, and takes precedence over a `model` header in the request options.
     * When omitted and no `model` header is configured either, the request runs
     * on the API's default model.
     */
    model?: STTModel;
    language?: string;
    ignore_timestamps?: boolean;
}
