import * as environments from "../../../environments.js";
import * as core from "../../../core/index.js";
import { mergeHeaders, mergeOnlyDefinedHeaders } from "../../../core/headers.js";
import * as errors from "../../../errors/index.js";
import * as apiErrors from "../../../api/errors/index.js";
import { APICreditResponse } from "./types/APICreditResponse.js";
import { PackageResponse } from "./types/PackageResponse.js";

export declare namespace User {
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

export class User {
    protected readonly _options: User.Options;

    constructor(_options: User.Options = {}) {
        this._options = _options;
    }

    /**
     * Gets the user's API credit
     *
     * @throws {@link apiErrors.UnprocessableEntityError}
     *
     * @example
     *     await client.user.get_api_credit()
     */
    public get_api_credit(requestOptions?: User.RequestOptions): core.HttpResponsePromise<APICreditResponse> {
        return core.HttpResponsePromise.fromPromise(this.__get_api_credit(requestOptions));
    }

    private async __get_api_credit(requestOptions?: User.RequestOptions): Promise<core.WithRawResponse<APICreditResponse>> {
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
                "wallet/self/api-credit",
            ),
            method: "GET",
            headers: _headers,
            queryParameters: { ...requestOptions?.queryParams },
            timeoutMs: requestOptions?.timeoutInSeconds != null ? requestOptions.timeoutInSeconds * 1000 : 240000,
            ...(requestOptions?.maxRetries != null ? { maxRetries: requestOptions.maxRetries } : {}),
            ...(requestOptions?.abortSignal != null ? { abortSignal: requestOptions.abortSignal } : {}),
        });
        if (_response.ok) {
            return {
                data: _response.body as APICreditResponse,
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
                throw new errors.FishAudioTimeoutError("Timeout exceeded when calling GET /wallet/self/api-credit.");
            case "unknown":
                throw new errors.FishAudioError({
                    message: _response.error.errorMessage,
                    rawResponse: _response.rawResponse,
                });
        }
    }

    /**
     * Gets the user's package
     *
     * @throws {@link apiErrors.UnprocessableEntityError}
     *
     * @example
     *     await client.user.get_package()
     */
    public get_package(requestOptions?: User.RequestOptions): core.HttpResponsePromise<PackageResponse> {
        return core.HttpResponsePromise.fromPromise(this.__get_package(requestOptions));
    }

    private async __get_package(requestOptions?: User.RequestOptions): Promise<core.WithRawResponse<PackageResponse>> {
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
                "wallet/self/package",
            ),
            method: "GET",
            headers: _headers,
            queryParameters: { ...requestOptions?.queryParams },
            timeoutMs: requestOptions?.timeoutInSeconds != null ? requestOptions.timeoutInSeconds * 1000 : 240000,
            ...(requestOptions?.maxRetries != null ? { maxRetries: requestOptions.maxRetries } : {}),
            ...(requestOptions?.abortSignal != null ? { abortSignal: requestOptions.abortSignal } : {}),
        });
        if (_response.ok) {
            return {
                data: _response.body as PackageResponse,
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
                throw new errors.FishAudioTimeoutError("Timeout exceeded when calling GET /wallet/self/package.");
            case "unknown":
                throw new errors.FishAudioError({
                    message: _response.error.errorMessage,
                    rawResponse: _response.rawResponse,
                });
        }
    }
}
