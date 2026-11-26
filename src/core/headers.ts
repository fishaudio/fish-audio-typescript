/**
 * Sets `name` in `headers` to `value`, first removing the header under any
 * other spelling of the name: header names are case-insensitive, so a later
 * source replaces an earlier one whatever its casing, and the spelling that
 * set the value is the one kept. `onReplaced` gets each value replaced.
 */
export function setHeaderIgnoringCase<T>(
    headers: Record<string, T>,
    name: string,
    value: T,
    onReplaced?: (replaced: T) => void,
): void {
    const lowered = name.toLowerCase();
    for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === lowered) {
            onReplaced?.(headers[existing]!);
            delete headers[existing];
        }
    }
    headers[name] = value;
}

/**
 * For a header value that is dropped unused: if it is a promise (a supplier
 * may be one, already running), handles its rejection, which nothing else
 * will, so it cannot end the Node process as an unhandled rejection. It is
 * not awaited, and a function supplier is not called.
 */
export function ignoreRejection(value: unknown): void {
    if (value != null && typeof (value as { then?: unknown }).then === "function") {
        try {
            Promise.resolve(value).catch(() => {});
        } catch {
            // Nothing to handle.
        }
    }
}

/**
 * Merges header sets in order; for each name, compared without regard to
 * case, the last set that names it wins, with its spelling. A value it
 * replaces is dropped unused (see {@link ignoreRejection}).
 *
 * A `null` or `undefined` value removes the header (it is not sent), but the
 * name is kept with that value rather than deleted, so the fetcher can tell
 * that the caller named it and the header provider does not add it back.
 */
export function mergeHeaders<THeaderValue>(
    ...headersArray: (Record<string, THeaderValue> | null | undefined)[]
): Record<string, string | THeaderValue> {
    const result: Record<string, THeaderValue> = {};

    for (const [key, value] of headersArray
        .filter((headers) => headers != null)
        .flatMap((headers) => Object.entries(headers))) {
        setHeaderIgnoringCase(result, key, value, ignoreRejection);
    }

    return result;
}

export function mergeOnlyDefinedHeaders<THeaderValue>(
    ...headersArray: (Record<string, THeaderValue> | null | undefined)[]
): Record<string, THeaderValue> {
    const result: Record<string, THeaderValue> = {};

    for (const [key, value] of headersArray
        .filter((headers) => headers != null)
        .flatMap((headers) => Object.entries(headers))) {
        if (value != null) {
            result[key] = value;
        }
    }

    return result;
}
