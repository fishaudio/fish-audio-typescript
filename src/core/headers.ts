/**
 * Sets `name` in `headers` to `value`, first removing the header under any
 * other spelling of the name: header names are case-insensitive, so a later
 * source replaces an earlier one whatever its casing, and the spelling that
 * set the value is the one kept.
 */
export function setHeaderIgnoringCase<T>(headers: Record<string, T>, name: string, value: T): void {
    const lowered = name.toLowerCase();
    for (const existing of Object.keys(headers)) {
        if (existing !== name && existing.toLowerCase() === lowered) {
            delete headers[existing];
        }
    }
    headers[name] = value;
}

/**
 * Merges header sets in order; for each name, compared without regard to
 * case, the last set that names it wins, with its spelling.
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
        setHeaderIgnoringCase(result, key, value);
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
