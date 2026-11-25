/// <reference types="node" />
import { decode, encode } from "@msgpack/msgpack";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { FishAudioClient, RealtimeEvents, type TTSRequest } from "../src/index.js";
import { serializeTtsRequest } from "../src/api/resources/textToSpeech/serialize.js";

type Body = Record<string, unknown>;

// [request fields, expected language on the wire; undefined means the key is absent]
const CASES: Array<[string, Partial<TTSRequest>, string | undefined]> = [
    ["unset", {}, undefined],
    ["explicit undefined", { language: undefined }, undefined],
    ["a tag", { language: "es-MX" }, "es-MX"],
    ["a tag as given", { language: "ES_mx" }, "ES_mx"],
    ["an empty string as given", { language: "" }, ""],
];

function expectLanguage(body: Body, expected: string | undefined): void {
    if (expected === undefined) {
        expect(Object.keys(body)).not.toContain("language");
    } else {
        expect(body.language).toBe(expected);
    }
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("language on POST /v1/tts", () => {
    it.each(CASES)("serializeTtsRequest: %s", async (_name, fields, expected) => {
        const body = decode(await serializeTtsRequest({ text: "Hola", ...fields })) as Body;
        expectLanguage(body, expected);
    });

    it.each(CASES)("convert: %s", async (_name, fields, expected) => {
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(Uint8Array.of(1)));
        vi.stubGlobal("fetch", fetchMock);
        const client = new FishAudioClient({ apiKey: "test-key" });

        await client.textToSpeech.convert({ text: "La entrada cuesta $300.", ...fields });

        const init = fetchMock.mock.calls[0]?.[1];
        expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/v1\/tts$/);
        expectLanguage(decode(init?.body as Uint8Array) as Body, expected);
    });

    it("keeps the other fields when language is dropped", async () => {
        const body = decode(
            await serializeTtsRequest({ text: "Hola", language: undefined, reference_id: "voice-1" }),
        ) as Body;
        expect(body).toEqual({ text: "Hola", reference_id: "voice-1" });
    });
});

interface TtsServer {
    url: string;
    starts: Body[];
    close(): Promise<void>;
}

/** A local /v1/tts/live that records start events and answers with `reply`. */
async function startTtsServer(reply: (send: (message: Body) => void) => void): Promise<TtsServer> {
    const http: Server = createServer();
    const wss = new WebSocketServer({ server: http, path: "/v1/tts/live" });
    const starts: Body[] = [];
    wss.on("connection", (socket) => {
        socket.on("message", (data) => {
            const message = decode(new Uint8Array(data as Buffer)) as Body;
            if (message.event === "start") {
                starts.push(message.request as Body);
                reply((out) => socket.send(encode(out)));
            }
        });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        starts,
        async close() {
            for (const client of wss.clients) client.terminate();
            http.closeAllConnections();
            await new Promise<void>((resolve) => http.close(() => resolve()));
        },
    };
}

describe("language on the /v1/tts/live start event", () => {
    it.each(CASES)("convertRealtime: %s", async (_name, fields, expected) => {
        const server = await startTtsServer((send) => {
            send({ event: "audio", audio: Uint8Array.of(7) });
            send({ event: "finish", reason: "stop" });
        });
        try {
            const client = new FishAudioClient({ apiKey: "test-key", baseUrl: server.url });
            const connection = await client.textToSpeech.convertRealtime({ text: "", ...fields }, ["Hola"]);
            await new Promise<void>((resolve) => connection.on(RealtimeEvents.CLOSE, () => resolve()));
            connection.close();

            expect(server.starts).toHaveLength(1);
            expectLanguage(server.starts[0]!, expected);
        } finally {
            await server.close();
        }
    });

    it("reports a rejected start event as an error and closes instead of hanging", async () => {
        // What the API does with an invalid tag: an error event, then silence.
        const server = await startTtsServer((send) => {
            send({ event: "error", error: 'Invalid language "en us".' });
        });
        try {
            const client = new FishAudioClient({ apiKey: "test-key", baseUrl: server.url });
            const connection = await client.textToSpeech.convertRealtime({ text: "", language: "en US" }, ["Hola"]);
            const errors: unknown[] = [];
            connection.on(RealtimeEvents.ERROR, (error) => errors.push(error));
            await new Promise<void>((resolve) => connection.on(RealtimeEvents.CLOSE, () => resolve()));

            expect(errors).toHaveLength(1);
            expect((errors[0] as Error).message).toBe('Invalid language "en us".');
            expect(server.starts[0]!.language).toBe("en US");
        } finally {
            await server.close();
        }
    });
});
