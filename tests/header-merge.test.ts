/// <reference types="node" />
/**
 * Header names are case-insensitive, so a header set in two places under two
 * spellings is one header: the later place wins. Sent under both spellings,
 * fetch joins the values ("Bearer a, Bearer b"), which no server accepts.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FishAudioClient } from "../src/index.js";
import { mergeHeaders } from "../src/core/headers.js";
import { SDK_USER_AGENT } from "../src/core/userAgent.js";

let server: Server;
let baseUrl: string;
const requests: IncomingMessage[] = [];

beforeAll(async () => {
    server = createServer((request, response) => {
        requests.push(request);
        request.resume();
        response.setHeader("Content-Type", "application/json");
        response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

const last = () => requests[requests.length - 1]!.headers;

describe("a header named in two places, in different case", () => {
    it.each(["authorization", "AUTHORIZATION", "Authorization"])(
        "a per-call %s replaces the API key's",
        async (name) => {
            const client = new FishAudioClient({ apiKey: "key", baseUrl });
            await client.user.get_api_credit({ headers: { [name]: "Bearer other" } });
            expect(last().authorization).toBe("Bearer other");
            await client.user.get_api_credit();
            expect(last().authorization).toBe("Bearer key");
        },
    );

    it("the client's User-Agent is sent once, after the SDK's", async () => {
        const client = new FishAudioClient({ apiKey: "key", baseUrl, headers: { "user-agent": "mine" } });
        await client.user.get_api_credit();
        expect(last()["user-agent"]).toBe(`${SDK_USER_AGENT} mine`);
    });

    it("a per-call header replaces the client's", async () => {
        const client = new FishAudioClient({ apiKey: "key", baseUrl, headers: { "X-Tenant": "a" } });
        await client.user.get_api_credit({ headers: { "x-tenant": "b" } });
        expect(last()["x-tenant"]).toBe("b");
    });

    it("a per-call null removes the client's", async () => {
        const client = new FishAudioClient({ apiKey: "key", baseUrl, headers: { "X-Tenant": "a" } });
        await client.user.get_api_credit({ headers: { "x-tenant": null } });
        expect(last()["x-tenant"]).toBeUndefined();
    });

    it("a per-call content-type replaces the body's", async () => {
        const client = new FishAudioClient({ apiKey: "key", baseUrl });
        await client.textToSpeech.convert({ text: "hi" }, "s1", { headers: { "content-type": "application/x-test" } });
        expect(last()["content-type"]).toBe("application/x-test");
    });

    it("mergeHeaders keeps the spelling of the place that wins", () => {
        expect(mergeHeaders({ Authorization: "a", "X-One": "1" }, { authorization: "b" })).toEqual({
            "X-One": "1",
            authorization: "b",
        });
    });
});
