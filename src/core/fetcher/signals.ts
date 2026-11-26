const TIMEOUT = "timeout";

export function getTimeoutSignal(timeoutMs: number): { signal: AbortSignal; abortId: NodeJS.Timeout } {
    const controller = new AbortController();
    const abortId = setTimeout(() => controller.abort(TIMEOUT), timeoutMs);
    return { signal: controller.signal, abortId };
}

/**
 * Returns an abort signal that is getting aborted when
 * at least one of the specified abort signals is aborted.
 *
 * Requires at least node.js 18.
 */
export function anySignal(...args: AbortSignal[] | [AbortSignal[]]): AbortSignal {
    // Allowing signals to be passed either as array
    // of signals or as multiple arguments.
    const signals = (args.length === 1 && Array.isArray(args[0]) ? args[0] : args) as AbortSignal[];

    const controller = new AbortController();

    for (const signal of signals) {
        if (signal.aborted) {
            // Exiting early if one of the signals
            // is already aborted.
            controller.abort((signal as any)?.reason);
            break;
        }

        // Listening for signals and removing the listeners
        // when at least one symbol is aborted.
        signal.addEventListener("abort", () => controller.abort((signal as any)?.reason), {
            signal: controller.signal,
        });
    }

    return controller.signal;
}

/**
 * Like {@link anySignal}: a signal that aborts when one of `signals` does.
 * `unlink` removes the listeners it put on `signals` without aborting, for a
 * request that ended on its own; a signal reused across requests would
 * otherwise keep one listener for every request that failed.
 */
export function linkedSignal(signals: AbortSignal[]): { signal: AbortSignal; unlink: () => void } {
    const controller = new AbortController();
    const listeners = new AbortController();
    // Once aborted, the listeners have done their work.
    controller.signal.addEventListener("abort", () => listeners.abort(), { once: true });

    for (const signal of signals) {
        if (signal.aborted) {
            controller.abort((signal as any)?.reason);
            break;
        }
        signal.addEventListener("abort", () => controller.abort((signal as any)?.reason), {
            signal: listeners.signal,
        });
    }

    return { signal: controller.signal, unlink: () => listeners.abort() };
}
