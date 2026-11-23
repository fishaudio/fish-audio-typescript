/// <reference types="node" />
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FishAudioClient } from "../src/index.js";

let server: Server | undefined;

afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
});

/** Starts a fake `POST /v1/asr` and returns a client for it plus the requests it received. */
async function fakeAsr(): Promise<{ client: FishAudioClient; requests: IncomingMessage[] }> {
    const requests: IncomingMessage[] = [];
    server = createServer((request, response) => {
        requests.push(request);
        request.resume();
        request.on("end", () => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ text: "hello", duration: 1, segments: [] }));
        });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { client: new FishAudioClient({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}` }), requests };
}

/** Every value the request carries for a header name, compared without regard to case. */
function headerValues(request: IncomingMessage, name: string): string[] {
    const values: string[] = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
        if (request.rawHeaders[i]!.toLowerCase() === name) {
            values.push(request.rawHeaders[i + 1]!);
        }
    }
    return values;
}

const audio = () => new File([Uint8Array.of(1, 2, 3)], "audio.wav");

describe("speechToText.convert model", () => {
    it("sends no model header by default", async () => {
        const { client, requests } = await fakeAsr();

        const result = await client.speechToText.convert({ audio: audio() });

        expect(result.text).toBe("hello");
        expect(requests[0]!.url).toBe("/v1/asr");
        expect(headerValues(requests[0]!, "model")).toEqual([]);
    });

    it("sends the model as the model header", async () => {
        const { client, requests } = await fakeAsr();

        await client.speechToText.convert({ audio: audio(), model: "transcribe-1-pro" });

        expect(headerValues(requests[0]!, "model")).toEqual(["transcribe-1-pro"]);
    });

    it("keeps a model header from the request options when no model is given", async () => {
        const { client, requests } = await fakeAsr();

        await client.speechToText.convert({ audio: audio() }, { headers: { model: "transcribe-1-pro" } });

        expect(headerValues(requests[0]!, "model")).toEqual(["transcribe-1-pro"]);
    });

    it.each(["model", "Model", "MODEL"])(
        "wins over a %s header in the request options, and only one is sent",
        async (name) => {
            const { client, requests } = await fakeAsr();

            await client.speechToText.convert(
                { audio: audio(), model: "transcribe-1-pro" },
                { headers: { [name]: "transcribe-1" } },
            );

            expect(headerValues(requests[0]!, "model")).toEqual(["transcribe-1-pro"]);
        },
    );

    it("wins over a differently cased model header set on the client", async () => {
        const { requests } = await fakeAsr();
        const { port } = server!.address() as AddressInfo;
        const client = new FishAudioClient({
            apiKey: "test-key",
            baseUrl: `http://127.0.0.1:${port}`,
            headers: { Model: "transcribe-1" },
        });

        await client.speechToText.convert({ audio: audio(), model: "transcribe-1-pro" });

        expect(headerValues(requests[0]!, "model")).toEqual(["transcribe-1-pro"]);
    });
});
