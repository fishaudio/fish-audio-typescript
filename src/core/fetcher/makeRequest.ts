import { getTimeoutSignal, linkedSignal } from "./signals.js";

export const makeRequest = async (
    fetchFn: (url: string, init: RequestInit) => Promise<Response>,
    url: string,
    method: string,
    headers: Record<string, string>,
    requestBody: BodyInit | undefined,
    timeoutMs?: number,
    abortSignal?: AbortSignal,
    withCredentials?: boolean,
    duplex?: "half",
): Promise<Response> => {
    const signals: AbortSignal[] = [];

    // Add timeout signal
    let timeoutAbortId: NodeJS.Timeout | undefined = undefined;
    if (timeoutMs != null) {
        const { signal, abortId } = getTimeoutSignal(timeoutMs);
        timeoutAbortId = abortId;
        signals.push(signal);
    }

    // Add arbitrary signal
    if (abortSignal != null) {
        signals.push(abortSignal);
    }
    const { signal: newSignals, unlink } = linkedSignal(signals);
    try {
        return await fetchFn(url, {
            method: method,
            headers,
            body: requestBody,
            signal: newSignals,
            credentials: withCredentials ? "include" : undefined,
            // @ts-ignore
            duplex,
        });
    } catch (error) {
        // The request is over, so nothing is left to abort: stop listening to
        // the caller's signal, which may be reused for many requests. (After
        // a response the link stays, so the caller can still abort the body.)
        unlink();
        throw error;
    } finally {
        // Also when fetch rejects (a refused connection, an invalid header):
        // a timer left running keeps the Node process alive until it fires.
        if (timeoutAbortId != null) {
            clearTimeout(timeoutAbortId);
        }
    }
};
