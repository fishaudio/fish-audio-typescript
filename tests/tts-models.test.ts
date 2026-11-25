/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from "vitest";

const wsConstructor = vi.hoisted(() => vi.fn());

vi.mock("ws", () => ({
    default: class FakeWebSocket {
        constructor(url: string, options: unknown) {
            wsConstructor(url, options);
        }
        on(): this {
            return this;
        }
        send(): void {}
        close(): void {}
    },
}));

import type { Backends } from "../src/index.js";
import { FishAudioClient } from "../src/index.js";

const DEFAULT_MODEL = "s2.1-pro";
// `satisfies` keeps this list in sync with the Backends union at type-check time.
const MODELS = ["s2.1-pro", "s2.1-pro-free", "drama-3", "s3-pro", "s2-pro", "s1"] as const satisfies readonly Backends[];

function stubFetch() {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(Uint8Array.of(1, 2, 3)));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

function sentModel(init: RequestInit | undefined): string | null {
    return new Headers(init?.headers).get("model");
}

afterEach(() => {
    vi.unstubAllGlobals();
    wsConstructor.mockClear();
});

describe("TTS model selection", () => {
    it(`convert defaults to ${DEFAULT_MODEL}`, async () => {
        const fetchMock = stubFetch();
        const client = new FishAudioClient({ apiKey: "test-key" });

        await client.textToSpeech.convert({ text: "hi" });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sentModel(fetchMock.mock.calls[0]?.[1])).toBe(DEFAULT_MODEL);
    });

    it.each(MODELS)("convert sends %s in the model header", async (model) => {
        const fetchMock = stubFetch();
        const client = new FishAudioClient({ apiKey: "test-key" });

        await client.textToSpeech.convert({ text: "hi" }, model);

        expect(sentModel(fetchMock.mock.calls[0]?.[1])).toBe(model);
    });

    it(`convertRealtime defaults to ${DEFAULT_MODEL}`, async () => {
        const client = new FishAudioClient({ apiKey: "test-key" });

        await client.textToSpeech.convertRealtime({ text: "" }, []);

        expect(wsConstructor).toHaveBeenCalledTimes(1);
        expect(wsConstructor.mock.calls[0]?.[1]).toMatchObject({ headers: { model: DEFAULT_MODEL } });
    });

    it("convertRealtime sends an explicit model", async () => {
        const client = new FishAudioClient({ apiKey: "test-key" });

        await client.textToSpeech.convertRealtime({ text: "" }, [], "drama-3");

        expect(wsConstructor.mock.calls[0]?.[1]).toMatchObject({ headers: { model: "drama-3" } });
    });
});
