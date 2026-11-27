export interface ASRSegment {
    text: string;
    start: number;
    end: number;
}

export interface STTResponse {
    text: string;
    duration: number;
    segments: ASRSegment[];
    /** Identifier of this request. Include it when you contact support about a transcription. */
    request_id?: string;
}
