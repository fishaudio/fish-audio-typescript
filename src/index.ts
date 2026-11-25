export { FishAudioClient } from "./client/FishAudioClient.js";
export type { HeaderProvider } from "./core/headerProvider.js";
export { openTelemetryHeaders, type OpenTelemetryApi, type OpenTelemetrySpanContext } from "./client/openTelemetry.js";
export { play } from "./client/play.js";
export * from "./client/websocket/index.js";
export * from "./api/index.js";
export { FishAudioError, FishAudioTimeoutError, RealtimeSTTError } from "./errors/index.js";
