/// <reference types="node" />
import { decode } from "@msgpack/msgpack";
import { File as NodeFile } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { serializeTtsRequest } from "../src/api/resources/textToSpeech/serialize.js";

function decodeBody(body: Uint8Array): Record<string, unknown> {
    return decode(body) as Record<string, unknown>;
}

describe("serializeTtsRequest", () => {
    it("encodes a single-speaker request without references as MessagePack", async () => {
        const body = await serializeTtsRequest({
            text: "Hello from Fish Audio",
            reference_id: "voice-1",
            format: "mp3",
        });

        expect(decodeBody(body)).toEqual({
            text: "Hello from Fish Audio",
            reference_id: "voice-1",
            format: "mp3",
        });
    });

    it("converts File reference audio to raw bytes", async () => {
        const audio = new File([Uint8Array.of(1, 2, 3)], "clip.wav");
        const body = await serializeTtsRequest({
            text: "cloned",
            references: [{ audio, text: "transcript" }],
        });

        const payload = decodeBody(body);
        expect(payload.text).toBe("cloned");
        expect(payload.references).toEqual([
            { audio: Uint8Array.of(1, 2, 3), text: "transcript" },
        ]);
    });

    it("preserves nested multi-speaker references and converts each File", async () => {
        const speaker0 = new File([Uint8Array.of(9, 9)], "a.wav");
        const speaker1 = new File([Uint8Array.of(8, 7, 6)], "b.wav");
        const body = await serializeTtsRequest({
            text: "<|speaker:0|>Hi<|speaker:1|>Hello",
            reference_id: ["alice", "bob"],
            references: [
                [{ audio: speaker0, text: "hi" }],
                [{ audio: speaker1, text: "hello" }],
            ],
        });

        const payload = decodeBody(body);
        expect(payload.reference_id).toEqual(["alice", "bob"]);
        expect(payload.references).toEqual([
            [{ audio: Uint8Array.of(9, 9), text: "hi" }],
            [{ audio: Uint8Array.of(8, 7, 6), text: "hello" }],
        ]);
    });

    it("converts node:buffer.File audio when globalThis.File is unavailable", async () => {
        vi.stubGlobal("File", undefined);

        try {
            const audio = new NodeFile([Uint8Array.of(4, 5, 6)], "clip.wav") as File;
            const body = await serializeTtsRequest({
                text: "cloned",
                references: [{ audio, text: "transcript" }],
            });

            expect(decodeBody(body).references).toEqual([
                { audio: Uint8Array.of(4, 5, 6), text: "transcript" },
            ]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("round-trips OpenAPI body fields including opus bitrate in bps", async () => {
        const body = await serializeTtsRequest({
            text: "Hello",
            opus_bitrate: 24000,
            latency: "low",
            max_new_tokens: 1024,
            repetition_penalty: 1.2,
            min_chunk_length: 50,
            condition_on_previous_chunks: true,
            early_stop_threshold: 1,
            features: ["quality-guard"],
            prosody: { speed: 1, volume: 0, normalize_loudness: true },
        });

        expect(decodeBody(body)).toEqual({
            text: "Hello",
            opus_bitrate: 24000,
            latency: "low",
            max_new_tokens: 1024,
            repetition_penalty: 1.2,
            min_chunk_length: 50,
            condition_on_previous_chunks: true,
            early_stop_threshold: 1,
            features: ["quality-guard"],
            prosody: { speed: 1, volume: 0, normalize_loudness: true },
        });
    });
});
