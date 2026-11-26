# Changelog

All notable changes to the `fish-audio` npm package are listed here.
This project follows [Semantic Versioning](https://semver.org/). Before 1.0, a minor version may contain breaking changes; they are listed under "Upgrade notes".

## [Unreleased]

### Changed

- **The licence is now Apache-2.0.** `package.json` states `"license": "Apache-2.0"` and the repository and the npm package contain a `LICENSE` file with the Apache License 2.0 text. Versions 0.1.0 and 0.2.0 were published with `"license": "MIT"` in their metadata and without a `LICENSE` file.

### Fixes

- **A process that used `textToSpeech.convertRealtime()` exits when the stream is over.** The connection now closes its WebSocket when the server finishes the stream or ends it with an error. Before, the socket stayed open until `connection.close()` was called, which the README example did not do, so a Node.js script never exited. If the server does not answer the close within 3 seconds, the socket is destroyed.
- **`RealtimeEvents.CLOSE` is emitted exactly once per connection**, when the socket has closed. Before, a caller that called `connection.close()` after a finished stream received it twice, and a stream that the server ended with an error never emitted it.

## [0.2.0] - 2026-11-25

### Features

- **Realtime speech-to-text (Preview).** `client.speechToText.convertRealtime(request, audioStream)` streams 16-bit PCM audio to the `transcribe-stream-1` model and returns the session as an async iterable of typed events (`draft`, `committed`, `session_done` and others). The session object also sends control messages: `finalize()`, `agentSpeaking()`, `addContext()`, `configure()` and `keepalive()`. Failures are thrown as the new `RealtimeSTTError`. Node.js only. ([#8](https://github.com/fishaudio/fish-audio-typescript/pull/8))
- **Model selection for batch speech-to-text.** `speechToText.convert()` accepts an optional `model` (`"transcribe-1"` or `"transcribe-1-pro"`). ([#8](https://github.com/fishaudio/fish-audio-typescript/pull/8))
- **New TTS models.** `s2.1-pro`, `s2.1-pro-free` and `drama-3` are named in the `Backends` type. `Backends` now also accepts any other string, so a model released later works without an SDK update. ([#2](https://github.com/fishaudio/fish-audio-typescript/pull/2), [#9](https://github.com/fishaudio/fish-audio-typescript/pull/9))
- **Multi-speaker TTS.** `TTSRequest.reference_id` accepts an array of voice IDs, and `TTSRequest.references` accepts one array of samples per speaker. ([#4](https://github.com/fishaudio/fish-audio-typescript/pull/4))
- **More TTS request fields.** `prosody.normalize_loudness`, `latency: "low"`, `max_new_tokens`, `repetition_penalty`, `min_chunk_length`, `condition_on_previous_chunks`, `early_stop_threshold` and `features`. The `ProsodyControl` type is exported. ([#4](https://github.com/fishaudio/fish-audio-typescript/pull/4))

### Fixes

- **CommonJS works again.** In 0.1.0, `require("fish-audio")` threw `ReferenceError: exports is not defined in ES module scope`. The CommonJS build is now marked as CommonJS, and it ships its own type declarations. ([#3](https://github.com/fishaudio/fish-audio-typescript/pull/3), fixes [#1](https://github.com/fishaudio/fish-audio-typescript/issues/1))
- **TypeScript finds the types under every module setting.** The `exports` map now has a `types` entry for `require` and for `import`. ([#3](https://github.com/fishaudio/fish-audio-typescript/pull/3))
- **Types of the realtime TTS connection resolve without extra setup.** `@types/ws` is now a dependency, so a project with `skipLibCheck: false` no longer gets `TS7016: Could not find a declaration file for module 'ws'`.
- **Reference audio for zero-shot cloning is sent correctly** when `File` comes from `node:buffer`, and inside multi-speaker `references`. ([#4](https://github.com/fishaudio/fish-audio-typescript/pull/4))

### Upgrade notes

- **The default TTS model is now `s2.1-pro`**, for both `textToSpeech.convert()` and `textToSpeech.convertRealtime()`. The 0.1.0 package on npm sent `s1`: its source set `s2-pro`, but the published build did not include that change. To choose another model, pass it as the second argument, for example `convert(request, "s2-pro")`. Passing `"s1"` keeps the model that npm 0.1.0 used, but `s1` retires on 2026-12-31. ([#2](https://github.com/fishaudio/fish-audio-typescript/pull/2))
- **`TTSRequest.opus_bitrate` is in bits per second.** The type now allows `-1000 | 24000 | 32000 | 48000 | 64000` (it was `24 | 32 | 48 | 64`), which is what the API expects. TypeScript code that passes `24`, `32`, `48` or `64` no longer compiles: multiply the value by 1000. ([#4](https://github.com/fishaudio/fish-audio-typescript/pull/4))
- **`ReferenceAudio.audio` must be a `File` or `Blob`.** The type always said `File`, but 0.1.0 also sent any other value unchanged. A `Buffer` or `Uint8Array` passed with a type cast now fails with `ref.audio.arrayBuffer is not a function`. Wrap it: `new File([new Uint8Array(buffer)], "sample.mp3")`. ([#4](https://github.com/fishaudio/fish-audio-typescript/pull/4))
- **Old model names were removed from the `Backends` type** (`speech-1.5`, `speech-1.6`, `agent-x0`, `s1-mini`). This does not break compilation, because any string is accepted, but these names no longer autocomplete. `s1` retires on 2026-12-31; use `s2.1-pro`. ([#9](https://github.com/fishaudio/fish-audio-typescript/pull/9))
- **Node.js 20 or later is required**, and is now declared in `engines`.

## [0.1.0] - 2026-03-10

- Default TTS model `s2-pro` in the source; the package published to npm sends `s1`.

[Unreleased]: https://github.com/fishaudio/fish-audio-typescript/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/fishaudio/fish-audio-typescript/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fishaudio/fish-audio-typescript/releases/tag/v0.1.0
