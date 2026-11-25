import * as environments from "../../../environments.js";
import * as core from "../../../core/index.js";
import { mergeHeaders, mergeOnlyDefinedHeaders } from "../../../core/headers.js";
import * as errors from "../../../errors/index.js";
import * as apiErrors from "../../../api/errors/index.js";
import { STTRequest } from "./requests/STTRequest.js";
import { STTResponse } from "./types/STTResponse.js";

export declare namespace SpeechToText {
    export interface Options {
        environment?: core.Supplier<environments.FishAudioEnvironment | string>;
        /** Specify a custom URL to connect the client to. */
        baseUrl?: core.Supplier<string>;
        /** Override the Authorization header */
        apiKey?: core.Supplier<string | undefined>;
        /** Additional headers to include in requests. */
        headers?: Record<string, string | core.Supplier<string | null | undefined> | null | undefined>;
        /** Called for every request to add headers such as `traceparent`; see {@link core.HeaderProvider}. */
        headerProvider?: core.HeaderProvider;
    }

    export interface RequestOptions {
        /** The maximum time to wait for a response in seconds. */
        timeoutInSeconds?: number;
        /** The number of times to retry the request. Defaults to 2. */
        maxRetries?: number;
        /** A hook to abort the request. */
        abortSignal?: AbortSignal;
        /** Override the Authorization header */
        apiKey?: string | undefined;
        /** Additional query string parameters to include in the request. */
        queryParams?: Record<string, unknown>;
        /** Additional headers to include in the request. */
        headers?: Record<string, string | core.Supplier<string | null | undefined> | null | undefined>;
    }
}

export class SpeechToText {
    protected readonly _options: SpeechToText.Options;

    constructor(_options: SpeechToText.Options = {}) {
        this._options = _options;
    }

    /**
     * Transcribe an audio or video file.
     *
     * @param {STTRequest} request
     * @param {SpeechToText.RequestOptions} requestOptions - Request-specific configuration.
     *
     * @throws {@link apiErrors.UnprocessableEntityError}
     *
     * @example
     *     import { createReadStream } from "fs";
     *     await client.speechToText.convert({
     *         audio: new File([], "audio.mp3"),
     *         model: "transcribe-1-pro",
     *     })
     */
    public convert(
        request: STTRequest,
        requestOptions?: SpeechToText.RequestOptions,
    ): core.HttpResponsePromise<STTResponse> {
        return core.HttpResponsePromise.fromPromise(this.__convert(request, requestOptions));
    }

    private async __convert(
        request: STTRequest,
        requestOptions?: SpeechToText.RequestOptions,
    ): Promise<core.WithRawResponse<STTResponse>> {
        const _request = await core.newFormData();
        await _request.appendFile("audio", request.audio);

        if (request.language != null) {
            _request.append("language", request.language);
        }

        if (request.ignore_timestamps != null) {
            _request.append("ignore_timestamps", request.ignore_timestamps.toString());
        }

        const _maybeEncodedRequest = await _request.getRequest();
        const _authHeader =
            requestOptions?.apiKey != null
                ? `Bearer ${requestOptions.apiKey}`
                : typeof this._options?.apiKey === "string"
                    ? `Bearer ${this._options.apiKey}`
                    : undefined;

        let _headers: core.Fetcher.Args["headers"] = mergeHeaders(
            this._options?.headers,
            mergeOnlyDefinedHeaders({
                Authorization: _authHeader,
            }),
            requestOptions?.headers,
        );
        if (request.model != null) {
            _headers = withModelHeader(_headers, request.model);
        }
        const _response = await core.fetcher({
            headerProvider: this._options.headerProvider,
            url: core.url.join(
                (await core.Supplier.get(this._options.baseUrl)) ??
                    (await core.Supplier.get(this._options.environment)) ??
                    environments.FishAudioEnvironment.Production,
                "v1/asr",
            ),
            method: "POST",
            headers: _headers,
            queryParameters: { ...requestOptions?.queryParams },
            requestType: "file",
            duplex: _maybeEncodedRequest.duplex ?? "half",
            body: _maybeEncodedRequest.body,
            timeoutMs: requestOptions?.timeoutInSeconds != null ? requestOptions.timeoutInSeconds * 1000 : 240000,
            ...(requestOptions?.maxRetries != null ? { maxRetries: requestOptions.maxRetries } : {}),
            ...(requestOptions?.abortSignal != null ? { abortSignal: requestOptions.abortSignal } : {}),
        });
        if (_response.ok) {
            return { data: _response.body as STTResponse, rawResponse: _response.rawResponse };
        }

        if (_response.error.reason === "status-code") {
            switch (_response.error.statusCode) {
                case 422:
                    throw new apiErrors.UnprocessableEntityError(
                        _response.error.body as apiErrors.HttpValidationError,
                        _response.rawResponse,
                    );
                default:
                    throw new errors.FishAudioError({
                        statusCode: _response.error.statusCode,
                        body: _response.error.body,
                        rawResponse: _response.rawResponse,
                    });
            }
        }

        switch (_response.error.reason) {
            case "non-json":
                throw new errors.FishAudioError({
                    statusCode: _response.error.statusCode,
                    body: _response.error.rawBody,
                    rawResponse: _response.rawResponse,
                });
            case "timeout":
                throw new errors.FishAudioTimeoutError("Timeout exceeded when calling POST /v1/asr.");
            case "unknown":
                throw new errors.FishAudioError({
                    message: _response.error.errorMessage,
                    rawResponse: _response.rawResponse,
                });
        }
    }
}

/**
 * Sets the `model` header, dropping any header that differs from it only in
 * case (`Model`, `MODEL`), so the request never carries two of them.
 */
export function withModelHeader<THeaderValue>(
    headers: Record<string, THeaderValue>,
    model: string,
): Record<string, THeaderValue | string> {
    const result: Record<string, THeaderValue | string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== "model") {
            result[key] = value;
        }
    }
    result.model = model;
    return result;
}
