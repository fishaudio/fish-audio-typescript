import * as environments from "../../../environments.js";
import * as core from "../../../core/index.js";
import { mergeHeaders, mergeOnlyDefinedHeaders } from "../../../core/headers.js";
import * as errors from "../../../errors/index.js";
import * as apiErrors from "../../../api/errors/index.js";
import { Ivc } from "./ivc/Client.js";
import { ModelEntity } from "./types/ModelEntity.js";
import { ModelListRequest } from "./requests/ModelListRequest.js";
import { UpdateModelRequest } from "./requests/UpdateModelRequest.js";
import { ModelListResponse } from "./types/ModelListResponse.js";
import { DeleteVoiceResponse } from "./types/DeleteVoiceResponse.js";
import { UpdateVoiceResponse } from "./types/UpdateVoiceResponse.js";

export declare namespace Voices {
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

/**
 * Access to voices created either by you or Fish Audio.
 */
export class Voices {
    protected readonly _options: Voices.Options;
    protected _ivc: Ivc | undefined;

    constructor(_options: Voices.Options = {}) {
        this._options = _options;
    }

    public get ivc(): Ivc {
        return (this._ivc ??= new Ivc(this._options));
    }

    /**
     * Returns a list of all available voices for a user.
     *
     * @param {ModelListRequest} request
     * @param {Voices.RequestOptions} requestOptions - Request-specific configuration.
     *
     * @throws {@link apiErrors.UnprocessableEntityError}
     *
     * @example
     *     await client.voices.search()
     */
    public search(
        request: ModelListRequest = {},
        requestOptions?: Voices.RequestOptions,
    ): core.HttpResponsePromise<ModelListResponse> {
        return core.HttpResponsePromise.fromPromise(this.__search(request, requestOptions));
    }

    private async __search(
        request: ModelListRequest = {},
        requestOptions?: Voices.RequestOptions,
    ): Promise<core.WithRawResponse<ModelListResponse>> {
        const _queryParams: Record<string, string | string[] | object | object[] | null> = {};
        for (const [key, value] of Object.entries(request)) {
            if (value != null) {
                _queryParams[key] = value;
            }
        }
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
            method: "GET",
            headers: _headers,
            queryParameters: { ..._queryParams, ...requestOptions?.queryParams },
            timeoutMs: requestOptions?.timeoutInSeconds != null ? requestOptions.timeoutInSeconds * 1000 : 240000,
            ...(requestOptions?.maxRetries != null ? { maxRetries: requestOptions.maxRetries } : {}),
            ...(requestOptions?.abortSignal != null ? { abortSignal: requestOptions.abortSignal } : {}),
        });
        if (_response.ok) {
            return {
                data: _response.body as ModelListResponse,
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
                throw new errors.FishAudioTimeoutError("Timeout exceeded when calling GET /model.");
            case "unknown":
                throw new errors.FishAudioError({
                    message: _response.error.errorMessage,
                    rawResponse: _response.rawResponse,
                });
        }
    }
    
    /**
     * Returns metadata about a specific voice.
     *
     * @param {string} voiceId - ID of the voice to be used.
     * @param {Voices.RequestOptions} requestOptions - Request-specific configuration.
     *
     * @throws {@link apiErrors.UnprocessableEntityError}
     *
     * @example
     *     await client.voices.get("21m00Tcm4TlvDq8ikWAM")
     */
    public get(
        voiceId: string,
        requestOptions?: Voices.RequestOptions,
    ): core.HttpResponsePromise<ModelEntity> {
        return core.HttpResponsePromise.fromPromise(this.__get(voiceId, requestOptions));
    }

    private async __get(
        voiceId: string,
        requestOptions?: Voices.RequestOptions,
    ): Promise<core.WithRawResponse<ModelEntity>> {
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
                `model/${encodeURIComponent(voiceId)}`,
            ),
            method: "GET",
            headers: _headers,
            queryParameters: requestOptions?.queryParams ?? {},
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
                throw new errors.FishAudioTimeoutError("Timeout exceeded when calling GET /model/{voice_id}.");
            case "unknown":
                throw new errors.FishAudioError({
                    message: _response.error.errorMessage,
                    rawResponse: _response.rawResponse,
                });
        }
    }

    /**
     * Deletes a voice by its ID.
     *
     * @param {string} voiceId - ID of the voice to be used.
     * @param {Voices.RequestOptions} requestOptions - Request-specific configuration.
     *
     * @throws {@link apiErrors.UnprocessableEntityError}
     *
     * @example
     *     await client.voices.delete("21m00Tcm4TlvDq8ikWAM")
     */
    public delete(
        voiceId: string,
        requestOptions?: Voices.RequestOptions,
    ): core.HttpResponsePromise<DeleteVoiceResponse> {
        return core.HttpResponsePromise.fromPromise(this.__delete(voiceId, requestOptions));
    }

    private async __delete(
        voiceId: string,
        requestOptions?: Voices.RequestOptions,
    ): Promise<core.WithRawResponse<DeleteVoiceResponse>> {
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
                `model/${encodeURIComponent(voiceId)}`,
            ),
            method: "DELETE",
            headers: _headers,
            queryParameters: requestOptions?.queryParams ?? {},
            timeoutMs: requestOptions?.timeoutInSeconds != null ? requestOptions.timeoutInSeconds * 1000 : 240000,
            ...(requestOptions?.maxRetries != null ? { maxRetries: requestOptions.maxRetries } : {}),
            ...(requestOptions?.abortSignal != null ? { abortSignal: requestOptions.abortSignal } : {}),
        });
        if (_response.ok) {
            return {
                data: _response.body as DeleteVoiceResponse,
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
                throw new errors.FishAudioTimeoutError("Timeout exceeded when calling DELETE /model/{voice_id}.");
            case "unknown":
                throw new errors.FishAudioError({
                    message: _response.error.errorMessage,
                    rawResponse: _response.rawResponse,
                });
        }
    }

    /**
     * Edit a voice created by you.
     *
     * @param {string} voiceId
     * @param {UpdateModelRequest} request
     * @param {Voices.RequestOptions} requestOptions - Request-specific configuration.
     *
     * @throws {@link apiErrors.UnprocessableEntityError}
     *
     * @example
     *     import { createReadStream } from "fs";
     *     await client.voices.update("21m00Tcm4TlvDq8ikWAM", {
     *         title: "title"
     *     })
     */
    public update(
        voiceId: string,
        request: UpdateModelRequest,
        requestOptions?: Voices.RequestOptions,
    ): core.HttpResponsePromise<UpdateVoiceResponse> {
        return core.HttpResponsePromise.fromPromise(this.__update(voiceId, request, requestOptions));
    }

    private async __update(
        voiceId: string,
        request: UpdateModelRequest,
        requestOptions?: Voices.RequestOptions,
    ): Promise<core.WithRawResponse<UpdateVoiceResponse>> {
        const _request = await core.newFormData();
        if (request.title != null) {
            _request.append("title", request.title);
        }

        if (request.description != null) {
            _request.append("description", request.description);
        }

        if (request.cover_image != null) {
            await _request.appendFile("cover_image", request.cover_image);
        }

        if (request.visibility != null) {
            _request.append("visibility", request.visibility);
        }

        if (request.tags != null) {
            _request.append("tags", request.tags);
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
                `model/${encodeURIComponent(voiceId)}`,
            ),
            method: "PATCH",
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
                data: _response.body as UpdateVoiceResponse,
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
                throw new errors.FishAudioTimeoutError(
                    "Timeout exceeded when calling PATCH /model/{voice_id}.",
                );
            case "unknown":
                throw new errors.FishAudioError({
                    message: _response.error.errorMessage,
                    rawResponse: _response.rawResponse,
                });
        }
    }

    // /**
    //  * Add a shared voice to your collection of Voices
    //  *
    //  * @param {string} publicUserId - Public user ID used to publicly identify ElevenLabs users.
    //  * @param {string} voiceId - ID of the voice to be used. You can use the [Get voices](/docs/api-reference/voices/search) endpoint list all the available voices.
    //  * @param {ElevenLabs.BodyAddSharedVoiceV1VoicesAddPublicUserIdVoiceIdPost} request
    //  * @param {Voices.RequestOptions} requestOptions - Request-specific configuration.
    //  *
    //  * @throws {@link ElevenLabs.UnprocessableEntityError}
    //  *
    //  * @example
    //  *     await client.voices.share("63e06b7e7cafdc46be4d2e0b3f045940231ae058d508589653d74d1265a574ca", "21m00Tcm4TlvDq8ikWAM", {
    //  *         newName: "John Smith"
    //  *     })
    //  */
    // public share(
    //     publicUserId: string,
    //     voiceId: string,
    //     request: ElevenLabs.BodyAddSharedVoiceV1VoicesAddPublicUserIdVoiceIdPost,
    //     requestOptions?: Voices.RequestOptions,
    // ): core.HttpResponsePromise<ElevenLabs.AddVoiceResponseModel> {
    //     return core.HttpResponsePromise.fromPromise(this.__share(publicUserId, voiceId, request, requestOptions));
    // }

    // private async __share(
    //     publicUserId: string,
    //     voiceId: string,
    //     request: ElevenLabs.BodyAddSharedVoiceV1VoicesAddPublicUserIdVoiceIdPost,
    //     requestOptions?: Voices.RequestOptions,
    // ): Promise<core.WithRawResponse<ElevenLabs.AddVoiceResponseModel>> {
    //     let _headers: core.Fetcher.Args["headers"] = mergeHeaders(
    //         this._options?.headers,
    //         mergeOnlyDefinedHeaders({ "xi-api-key": requestOptions?.apiKey ?? this._options?.apiKey }),
    //         requestOptions?.headers,
    //     );
    //     const _response = await core.fetcher({
    //         url: core.url.join(
    //             (await core.Supplier.get(this._options.baseUrl)) ??
    //                 (await core.Supplier.get(this._options.environment)) ??
    //                 environments.ElevenLabsEnvironment.Production,
    //             `v1/voices/add/${encodeURIComponent(publicUserId)}/${encodeURIComponent(voiceId)}`,
    //         ),
    //         method: "POST",
    //         headers: _headers,
    //         contentType: "application/json",
    //         queryParameters: requestOptions?.queryParams,
    //         requestType: "json",
    //         body: serializers.BodyAddSharedVoiceV1VoicesAddPublicUserIdVoiceIdPost.jsonOrThrow(request, {
    //             unrecognizedObjectKeys: "strip",
    //         }),
    //         timeoutMs: requestOptions?.timeoutInSeconds != null ? requestOptions.timeoutInSeconds * 1000 : 240000,
    //         maxRetries: requestOptions?.maxRetries,
    //         abortSignal: requestOptions?.abortSignal,
    //     });
    //     if (_response.ok) {
    //         return {
    //             data: serializers.AddVoiceResponseModel.parseOrThrow(_response.body, {
    //                 unrecognizedObjectKeys: "passthrough",
    //                 allowUnrecognizedUnionMembers: true,
    //                 allowUnrecognizedEnumValues: true,
    //                 breadcrumbsPrefix: ["response"],
    //             }),
    //             rawResponse: _response.rawResponse,
    //         };
    //     }

    //     if (_response.error.reason === "status-code") {
    //         switch (_response.error.statusCode) {
    //             case 422:
    //                 throw new ElevenLabs.UnprocessableEntityError(
    //                     serializers.HttpValidationError.parseOrThrow(_response.error.body, {
    //                         unrecognizedObjectKeys: "passthrough",
    //                         allowUnrecognizedUnionMembers: true,
    //                         allowUnrecognizedEnumValues: true,
    //                         breadcrumbsPrefix: ["response"],
    //                     }),
    //                     _response.rawResponse,
    //                 );
    //             default:
    //                 throw new errors.ElevenLabsError({
    //                     statusCode: _response.error.statusCode,
    //                     body: _response.error.body,
    //                     rawResponse: _response.rawResponse,
    //                 });
    //         }
    //     }

    //     switch (_response.error.reason) {
    //         case "non-json":
    //             throw new errors.ElevenLabsError({
    //                 statusCode: _response.error.statusCode,
    //                 body: _response.error.rawBody,
    //                 rawResponse: _response.rawResponse,
    //             });
    //         case "timeout":
    //             throw new errors.ElevenLabsTimeoutError(
    //                 "Timeout exceeded when calling POST /v1/voices/add/{public_user_id}/{voice_id}.",
    //             );
    //         case "unknown":
    //             throw new errors.ElevenLabsError({
    //                 message: _response.error.errorMessage,
    //                 rawResponse: _response.rawResponse,
    //             });
    //     }
    // }

    // /**
    //  * Retrieves a list of shared voices.
    //  *
    //  * @param {ElevenLabs.VoicesGetSharedRequest} request
    //  * @param {Voices.RequestOptions} requestOptions - Request-specific configuration.
    //  *
    //  * @throws {@link ElevenLabs.UnprocessableEntityError}
    //  *
    //  * @example
    //  *     await client.voices.getShared({
    //  *         pageSize: 1,
    //  *         category: "professional",
    //  *         gender: "gender",
    //  *         age: "age",
    //  *         accent: "accent",
    //  *         language: "language",
    //  *         locale: "locale",
    //  *         search: "search",
    //  *         featured: true,
    //  *         minNoticePeriodDays: 1,
    //  *         includeCustomRates: true,
    //  *         includeLiveModerated: true,
    //  *         readerAppEnabled: true,
    //  *         ownerId: "owner_id",
    //  *         sort: "sort",
    //  *         page: 1
    //  *     })
    //  */
    // public getShared(
    //     request: ElevenLabs.VoicesGetSharedRequest = {},
    //     requestOptions?: Voices.RequestOptions,
    // ): core.HttpResponsePromise<ElevenLabs.GetLibraryVoicesResponse> {
    //     return core.HttpResponsePromise.fromPromise(this.__getShared(request, requestOptions));
    // }

    // private async __getShared(
    //     request: ElevenLabs.VoicesGetSharedRequest = {},
    //     requestOptions?: Voices.RequestOptions,
    // ): Promise<core.WithRawResponse<ElevenLabs.GetLibraryVoicesResponse>> {
    //     const {
    //         pageSize,
    //         category,
    //         gender,
    //         age,
    //         accent,
    //         language,
    //         locale,
    //         search,
    //         useCases,
    //         descriptives,
    //         featured,
    //         minNoticePeriodDays,
    //         includeCustomRates,
    //         includeLiveModerated,
    //         readerAppEnabled,
    //         ownerId,
    //         sort,
    //         page,
    //     } = request;
    //     const _queryParams: Record<string, string | string[] | object | object[] | null> = {};
    //     if (pageSize != null) {
    //         _queryParams["page_size"] = pageSize.toString();
    //     }

    //     if (category != null) {
    //         _queryParams["category"] = serializers.VoicesGetSharedRequestCategory.jsonOrThrow(category, {
    //             unrecognizedObjectKeys: "strip",
    //         });
    //     }

    //     if (gender != null) {
    //         _queryParams["gender"] = gender;
    //     }

    //     if (age != null) {
    //         _queryParams["age"] = age;
    //     }

    //     if (accent != null) {
    //         _queryParams["accent"] = accent;
    //     }

    //     if (language != null) {
    //         _queryParams["language"] = language;
    //     }

    //     if (locale != null) {
    //         _queryParams["locale"] = locale;
    //     }

    //     if (search != null) {
    //         _queryParams["search"] = search;
    //     }

    //     if (useCases != null) {
    //         if (Array.isArray(useCases)) {
    //             _queryParams["use_cases"] = useCases.map((item) => item);
    //         } else {
    //             _queryParams["use_cases"] = useCases;
    //         }
    //     }

    //     if (descriptives != null) {
    //         if (Array.isArray(descriptives)) {
    //             _queryParams["descriptives"] = descriptives.map((item) => item);
    //         } else {
    //             _queryParams["descriptives"] = descriptives;
    //         }
    //     }

    //     if (featured != null) {
    //         _queryParams["featured"] = featured.toString();
    //     }

    //     if (minNoticePeriodDays != null) {
    //         _queryParams["min_notice_period_days"] = minNoticePeriodDays.toString();
    //     }

    //     if (includeCustomRates != null) {
    //         _queryParams["include_custom_rates"] = includeCustomRates.toString();
    //     }

    //     if (includeLiveModerated != null) {
    //         _queryParams["include_live_moderated"] = includeLiveModerated.toString();
    //     }

    //     if (readerAppEnabled != null) {
    //         _queryParams["reader_app_enabled"] = readerAppEnabled.toString();
    //     }

    //     if (ownerId != null) {
    //         _queryParams["owner_id"] = ownerId;
    //     }

    //     if (sort != null) {
    //         _queryParams["sort"] = sort;
    //     }

    //     if (page != null) {
    //         _queryParams["page"] = page.toString();
    //     }

    //     let _headers: core.Fetcher.Args["headers"] = mergeHeaders(
    //         this._options?.headers,
    //         mergeOnlyDefinedHeaders({ "xi-api-key": requestOptions?.apiKey ?? this._options?.apiKey }),
    //         requestOptions?.headers,
    //     );
    //     const _response = await core.fetcher({
    //         url: core.url.join(
    //             (await core.Supplier.get(this._options.baseUrl)) ??
    //                 (await core.Supplier.get(this._options.environment)) ??
    //                 environments.ElevenLabsEnvironment.Production,
    //             "v1/shared-voices",
    //         ),
    //         method: "GET",
    //         headers: _headers,
    //         queryParameters: { ..._queryParams, ...requestOptions?.queryParams },
    //         timeoutMs: requestOptions?.timeoutInSeconds != null ? requestOptions.timeoutInSeconds * 1000 : 240000,
    //         maxRetries: requestOptions?.maxRetries,
    //         abortSignal: requestOptions?.abortSignal,
    //     });
    //     if (_response.ok) {
    //         return {
    //             data: serializers.GetLibraryVoicesResponse.parseOrThrow(_response.body, {
    //                 unrecognizedObjectKeys: "passthrough",
    //                 allowUnrecognizedUnionMembers: true,
    //                 allowUnrecognizedEnumValues: true,
    //                 breadcrumbsPrefix: ["response"],
    //             }),
    //             rawResponse: _response.rawResponse,
    //         };
    //     }

    //     if (_response.error.reason === "status-code") {
    //         switch (_response.error.statusCode) {
    //             case 422:
    //                 throw new ElevenLabs.UnprocessableEntityError(
    //                     serializers.HttpValidationError.parseOrThrow(_response.error.body, {
    //                         unrecognizedObjectKeys: "passthrough",
    //                         allowUnrecognizedUnionMembers: true,
    //                         allowUnrecognizedEnumValues: true,
    //                         breadcrumbsPrefix: ["response"],
    //                     }),
    //                     _response.rawResponse,
    //                 );
    //             default:
    //                 throw new errors.ElevenLabsError({
    //                     statusCode: _response.error.statusCode,
    //                     body: _response.error.body,
    //                     rawResponse: _response.rawResponse,
    //                 });
    //         }
    //     }

    //     switch (_response.error.reason) {
    //         case "non-json":
    //             throw new errors.ElevenLabsError({
    //                 statusCode: _response.error.statusCode,
    //                 body: _response.error.rawBody,
    //                 rawResponse: _response.rawResponse,
    //             });
    //         case "timeout":
    //             throw new errors.ElevenLabsTimeoutError("Timeout exceeded when calling GET /v1/shared-voices.");
    //         case "unknown":
    //             throw new errors.ElevenLabsError({
    //                 message: _response.error.errorMessage,
    //                 rawResponse: _response.rawResponse,
    //             });
    //     }
    // }

    // /**
    //  * Returns a list of shared voices similar to the provided audio sample. If neither similarity_threshold nor top_k is provided, we will apply default values.
    //  *
    //  * @param {ElevenLabs.BodyGetSimilarLibraryVoicesV1SimilarVoicesPost} request
    //  * @param {Voices.RequestOptions} requestOptions - Request-specific configuration.
    //  *
    //  * @throws {@link ElevenLabs.UnprocessableEntityError}
    //  *
    //  * @example
    //  *     import { createReadStream } from "fs";
    //  *     await client.voices.findSimilarVoices({})
    //  */
    // public findSimilarVoices(
    //     request: ElevenLabs.BodyGetSimilarLibraryVoicesV1SimilarVoicesPost,
    //     requestOptions?: Voices.RequestOptions,
    // ): core.HttpResponsePromise<ElevenLabs.GetLibraryVoicesResponse> {
    //     return core.HttpResponsePromise.fromPromise(this.__findSimilarVoices(request, requestOptions));
    // }

    // private async __findSimilarVoices(
    //     request: ElevenLabs.BodyGetSimilarLibraryVoicesV1SimilarVoicesPost,
    //     requestOptions?: Voices.RequestOptions,
    // ): Promise<core.WithRawResponse<ElevenLabs.GetLibraryVoicesResponse>> {
    //     const _request = await core.newFormData();
    //     if (request.audioFile != null) {
    //         await _request.appendFile("audio_file", request.audioFile);
    //     }

    //     if (request.similarityThreshold != null) {
    //         _request.append("similarity_threshold", request.similarityThreshold.toString());
    //     }

    //     if (request.topK != null) {
    //         _request.append("top_k", request.topK.toString());
    //     }

    //     const _maybeEncodedRequest = await _request.getRequest();
    //     let _headers: core.Fetcher.Args["headers"] = mergeHeaders(
    //         this._options?.headers,
    //         mergeOnlyDefinedHeaders({
    //             "xi-api-key": requestOptions?.apiKey ?? this._options?.apiKey,
    //             ..._maybeEncodedRequest.headers,
    //         }),
    //         requestOptions?.headers,
    //     );
    //     const _response = await core.fetcher({
    //         url: core.url.join(
    //             (await core.Supplier.get(this._options.baseUrl)) ??
    //                 (await core.Supplier.get(this._options.environment)) ??
    //                 environments.ElevenLabsEnvironment.Production,
    //             "v1/similar-voices",
    //         ),
    //         method: "POST",
    //         headers: _headers,
    //         queryParameters: requestOptions?.queryParams,
    //         requestType: "file",
    //         duplex: _maybeEncodedRequest.duplex,
    //         body: _maybeEncodedRequest.body,
    //         timeoutMs: requestOptions?.timeoutInSeconds != null ? requestOptions.timeoutInSeconds * 1000 : 240000,
    //         maxRetries: requestOptions?.maxRetries,
    //         abortSignal: requestOptions?.abortSignal,
    //     });
    //     if (_response.ok) {
    //         return {
    //             data: serializers.GetLibraryVoicesResponse.parseOrThrow(_response.body, {
    //                 unrecognizedObjectKeys: "passthrough",
    //                 allowUnrecognizedUnionMembers: true,
    //                 allowUnrecognizedEnumValues: true,
    //                 breadcrumbsPrefix: ["response"],
    //             }),
    //             rawResponse: _response.rawResponse,
    //         };
    //     }

    //     if (_response.error.reason === "status-code") {
    //         switch (_response.error.statusCode) {
    //             case 422:
    //                 throw new ElevenLabs.UnprocessableEntityError(
    //                     serializers.HttpValidationError.parseOrThrow(_response.error.body, {
    //                         unrecognizedObjectKeys: "passthrough",
    //                         allowUnrecognizedUnionMembers: true,
    //                         allowUnrecognizedEnumValues: true,
    //                         breadcrumbsPrefix: ["response"],
    //                     }),
    //                     _response.rawResponse,
    //                 );
    //             default:
    //                 throw new errors.ElevenLabsError({
    //                     statusCode: _response.error.statusCode,
    //                     body: _response.error.body,
    //                     rawResponse: _response.rawResponse,
    //                 });
    //         }
    //     }

    //     switch (_response.error.reason) {
    //         case "non-json":
    //             throw new errors.ElevenLabsError({
    //                 statusCode: _response.error.statusCode,
    //                 body: _response.error.rawBody,
    //                 rawResponse: _response.rawResponse,
    //             });
    //         case "timeout":
    //             throw new errors.ElevenLabsTimeoutError("Timeout exceeded when calling POST /v1/similar-voices.");
    //         case "unknown":
    //             throw new errors.ElevenLabsError({
    //                 message: _response.error.errorMessage,
    //                 rawResponse: _response.rawResponse,
    //             });
    //     }
    // }
}
