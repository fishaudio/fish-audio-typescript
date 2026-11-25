export interface ReferenceAudio {
    audio: File;
    text: string;
}

export interface ProsodyControl {
    speed?: number;
    volume?: number;
    /** S2 family only; accepted but ignored on s1. */
    normalize_loudness?: boolean;
}

export interface TTSRequest {
    text: string;
    temperature?: number;
    top_p?: number;
    /**
     * Zero-shot voice samples. A flat array is single-speaker; an array of
     * arrays is multi-speaker (S2 family only). Requires MessagePack.
     */
    references?: ReferenceAudio[] | ReferenceAudio[][];
    /**
     * Voice model ID, or an array of IDs for multi-speaker dialogue
     * (S2 family only).
     */
    reference_id?: string | string[];
    prosody?: ProsodyControl;
    chunk_length?: number;
    normalize?: boolean;
    /**
     * BCP-47 tag of the text's language, such as `en`, `es-MX` or `zh-CN`.
     * It only changes how text normalization spells out numbers, dates, units
     * and symbols (and word-timestamp alignment); it does not change the voice
     * or accent. Sent as given; the API checks it. Leave it unset to let the
     * API detect the language of each chunk, including for mixed-language
     * text. On `convertRealtime` it applies to the whole session.
     */
    language?: string;
    format?: 'wav' | 'pcm' | 'mp3' | 'opus';
    sample_rate?: number;
    mp3_bitrate?: 64 | 128 | 192;
    /** Opus bitrate in bps. -1000 is automatic. */
    opus_bitrate?: -1000 | 24000 | 32000 | 48000 | 64000;
    latency?: 'low' | 'normal' | 'balanced';
    max_new_tokens?: number;
    repetition_penalty?: number;
    min_chunk_length?: number;
    condition_on_previous_chunks?: boolean;
    early_stop_threshold?: number;
    features?: string[];
}
