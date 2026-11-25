import * as environments from "../../../../environments.js";
import * as core from "../../../../core/index.js";
import { mergeHeaders, mergeOnlyDefinedHeaders } from "../../../../core/headers.js";
import * as errors from "../../../../errors/index.js";
import * as apiErrors from "../../../../api/errors/index.js";
import { ModelEntity } from "../types/ModelEntity.js";
import { ModelCreateRequest } from "./requests/ModelCreateRequest.js";

export declare namespace Ivc {
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
        /** Override the xi-api-key header */
        apiKey?: string | undefined;
        /** Additional query string parameters to include in the request. */
        queryParams?: Record<string, unknown>;
        /** Additional headers to include in the request. */
        headers?: Record<string, string | core.Supplier<string | null | undefined> | null | undefined>;
    }
}

export class Ivc {
    protected readonly _options: Ivc.Options;

    constructor(_options: Ivc.Options = {}) {
        this._options = _options;
    }

    /**
     * Create a voice clone and add it to your Voices
     *
     * @param {ModelCreateRequest} request
     * @param {Ivc.RequestOptions} requestOptions - Request-specific configuration.
     *
     * @throws {@link apiErrors.UnprocessableEntityError}
     *
     * @example
     *     import { createReadStream } from "fs";
     *     await client.voices.ivc.create({
     *         title: "title",
     *         voices: [fs.createReadStream("/path/to/your/file")],
     *     })
     */
    public create(
        request: ModelCreateRequest,
        requestOptions?: Ivc.RequestOptions,
    ): core.HttpResponsePromise<ModelEntity> {
        return core.HttpResponsePromise.fromPromise(this.__create(request, requestOptions));
    }

    private async __create(
        request: ModelCreateRequest,
        requestOptions?: Ivc.RequestOptions,
    ): Promise<core.WithRawResponse<ModelEntity>> {
        const _request = await core.newFormData();
        _request.append("type", request.type ?? "tts");
        _request.append("title", request.title);
        _request.append("train_mode", request.train_mode ?? "fast");
        for (const _file of request.voices) {
            await _request.appendFile("voices", _file);
        }

        if (request.visibility != null) {
            _request.append("visibility", request.visibility);
        }

        if (request.description != null) {
            _request.append("description", request.description);
        }

        if (request.cover_image != null) {
            await _request.appendFile("cover_image", request.cover_image);
        }

        if (request.texts != null) {
            _request.append("texts", request.texts);
        }

        if (request.tags != null) {
            _request.append("tags", request.tags);
        }

        if (request.enhance_audio_quality != null) {
            _request.append("enhance_audio_quality", request.enhance_audio_quality.toString());
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

        const _response = await core.fetcher({
            headerProvider: this._options.headerProvider,
            url: core.url.join(
                (await core.Supplier.get(this._options.baseUrl)) ??
                    (await core.Supplier.get(this._options.environment)) ??
                    environments.FishAudioEnvironment.Production,
                "model",
            ),
            method: "POST",
            headers: _headers,
            queryParameters: requestOptions?.queryParams ?? {},
            requestType: "file",
            duplex: _maybeEncodedRequest.duplex ?? "half",
            body: _maybeEncodedRequest.body,
            timeoutMs: requestOptions?.timeoutInSeconds != null ? requestOptions.timeoutInSeconds * 1000 : 240000,
            ...(requestOptions?.maxRetries != null ? { maxRetries: requestOptions.maxRetries } : {}),
            ...(requestOptions?.abortSignal != null ? { abortSignal: requestOptions.abortSignal } : {}),
        });
        if (_response.ok) {
            return {
                data: _response.body as ModelEntity,
                rawResponse: _response.rawResponse,
            };
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
                throw new errors.FishAudioTimeoutError("Timeout exceeded when calling POST /model.");
            case "unknown":
                throw new errors.FishAudioError({
                    message: _response.error.errorMessage,
                    rawResponse: _response.rawResponse,
                });
        }
    }
}
