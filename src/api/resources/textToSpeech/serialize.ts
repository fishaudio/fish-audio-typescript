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

/**
 * Drops `language` when it is unset. MessagePack encodes an `undefined`
 * property as nil, so `{ language: undefined }` would otherwise reach the API.
 */
export function omitUnsetLanguage(request: TTSRequest): TTSRequest {
    if (request.language != null) return request;
    const { language: _unset, ...rest } = request;
    return rest;
}

/** Builds the MessagePack body for POST /v1/tts. */
export async function serializeTtsRequest(request: TTSRequest): Promise<Uint8Array> {
    const unsetDropped = omitUnsetLanguage(request);
    const payload = Array.isArray(unsetDropped.references)
        ? { ...unsetDropped, references: await encodeReferences(unsetDropped.references) }
        : unsetDropped;
    return encode(payload);
}
