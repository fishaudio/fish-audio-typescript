export function mergeHeaders<THeaderValue>(
    ...headersArray: (Record<string, THeaderValue> | null | undefined)[]
): Record<string, string | THeaderValue> {
    const result: Record<string, THeaderValue> = {};

    for (const [key, value] of headersArray
        .filter((headers) => headers != null)
        .flatMap((headers) => Object.entries(headers))) {
        // Header names are case-insensitive: a later "authorization" replaces
        // (or, with null, removes) an earlier "Authorization". Left under both
        // spellings, fetch would join the two values into one header.
        removeHeader(result, key);
        if (value != null) {
            result[key] = value;
        }
    }

    return result;
}

/** Deletes the header `name` from `headers` under every spelling of the name. */
export function removeHeader(headers: Record<string, unknown>, name: string): void {
    const lowered = name.toLowerCase();
    for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === lowered) {
            delete headers[existing];
        }
    }
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
