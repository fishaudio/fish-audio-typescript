import { encode } from "@msgpack/msgpack";
import { ReferenceAudio, TTSRequest } from "./requests/TTSRequest.js";

async function encodeReference(ref: ReferenceAudio): Promise<{ audio: Uint8Array; text: string }> {
    return { text: ref.text, audio: new Uint8Array(await ref.audio.arrayBuffer()) };
}

async function encodeReferences(
    references: NonNullable<TTSRequest["references"]>,
): Promise<unknown> {
    return Promise.all(
        references.map((entry) =>
            Array.isArray(entry) ? Promise.all(entry.map(encodeReference)) : encodeReference(entry),
        ),
    );
}

/** Builds the MessagePack body for POST /v1/tts. */
export async function serializeTtsRequest(request: TTSRequest): Promise<Uint8Array> {
    const payload = Array.isArray(request.references)
        ? { ...request, references: await encodeReferences(request.references) }
        : request;
    return encode(payload);
}
