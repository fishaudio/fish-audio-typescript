# Fish Audio Typescript SDK

To provide convenient Typescript program integration for [https://docs.fish.audio](https://docs.fish.audio)

## Install

```bash
npm install fish-audio
```

## Usage

Initialize a `FishAudioClient` to use APIs. Authenticate by setting `FISH_API_KEY="your_api_key"`
in your environment or pass it in.

```typescript
import { FishAudioClient } from fish-audio;

const fishAudio = new FishAudioClient();
```

Sometimes, you may need to change our endpoint to another address. You can use

```typescript
import { FishAudioClient } from fish-audio;

const fishAudio = new FishAudioClient({apiKey: "your_api_key", baseUrl: "https://your-proxy-domain"});
```

### Text to Speech

```typescript
import { FishAudioClient, play } from fish-audio;

const fishAudio = new FishAudioClient({ apiKey: "your_api_key" });

const request = { text: "Hello, world!" };
const audio = await fishAudio.textToSpeech.convert(request); //defaults to backend: "s1"

await play(audio);
```

#### Reference Audio

```typescript
import type { TTSRequest } from fish-audio;

const request: TTSRequest = {
    text: "Hello, world!",
    reference_id: "your_model_id",
};
```

Or just use `ReferenceAudio` in `TTSRequest`:

```typescript
const audioBuffer = await readFile(new URL("/path/to/your/audio/file",));
const referenceFile = new File([audioBuffer], "audio_file_name");

const referenceAudio: ReferenceAudio = {
    audio: referenceFile,
    text: "reference audio text"
};

const request: TTSRequest = {
    text: "Hello, world!",
    references: [referenceAudio]
};
```

#### WebSocket

The TTS websocket provides real-time streaming.

```typescript
import { FishAudioClient, RealtimeEvents } from "fish-audio";
import { writeFile } from "fs/promises";
import path from "path";

// Simple async generator that yields text chunks to speak
async function* makeTextStream() {
    const chunks = [
        "Hello from Fish Audio! ",
        "This is a realtime text-to-speech test. ",
        "We are streaming multiple chunks over WebSocket.",
    ];
    for (const chunk of chunks) {
        yield chunk;
        await new Promise((r) => setTimeout(r, 200));
    }
}

const client = new FishAudioClient();

// For realtime, set text to "" and stream the content via textStream instead
const request = {
    text: "",
    reference_id: "your_model_id"
};

// Defaults to backend: "s1"
const connection = await client.textToSpeech.convertRealtime(request, makeTextStream());

// Collect audio and write to a file when the stream ends
const chunks: Buffer[] = [];
connection.on(RealtimeEvents.OPEN, () => console.log("WebSocket opened"));
connection.on(RealtimeEvents.AUDIO_CHUNK, (audio: unknown): void => {
    if (audio instanceof Uint8Array || Buffer.isBuffer(audio)) {
        chunks.push(Buffer.from(audio));
    }
});
connection.on(RealtimeEvents.ERROR, (err) => console.error("WebSocket error:", err));
connection.on(RealtimeEvents.CLOSE, async () => {
    const outPath = path.resolve(process.cwd(), "out.mp3");
    await writeFile(outPath, Buffer.concat(chunks));
    console.log("Saved to", outPath);
});
```

### Speech to Text (ASR)

```typescript
import { FishAudioClient } from "fish-audio";
import { createReadStream } from "fs";

const fishAudio = new FishAudioClient();

const audioFile = createReadStream(new URL("/path/to/your/audio/file"));

try {
    const result = await fishAudio.speechToText.convert({
        audio: audioFile,
    });

    console.log("Transcription:", result.text);
    console.log("Duration (s):", result.duration);
    console.log("Segments:", result.segments);
} catch (err) {
    console.error("STT request failed:", err);
}
```

### Voices

#### Clone a Voice
```typescript
import { FishAudioClient } from "fish-audio";
import { createReadStream } from "fs";

const fishAudio = new FishAudioClient();

const title = "cloned-voice-name";
const audioFile = createReadStream(new URL("/path/to/your/audio/file"));
const coverImageFile = createReadStream(new URL("/path/to/your/cover/image/file"));

try {
    const response = await fishAudio.voices.ivc.create({
        title: title,
        voices: [audioFile],
        cover_image: coverImageFile,
    });

    console.log("Voice created:", {
        id: response._id,
        title: response.title,
        state: response.state,
    });
} catch (err) {
    console.error("Create voice request failed:", err);
}
```

#### List models

```typescript
fishAudio.voices.search()
```

#### Get a model info by id

```typescript
fishAudio.voices.get("your_model_id")
```

#### Update a model

```typescript
fishAudio.voices.update("your_model_id", { title: "new_title" })
```

#### Delete a model

```typescript
fishAudio.voices.delete("your_model_id")
```

### User

#### Get User API Credits

```typescript
fishAudio.user.get_api_credit()
```

#### Get User Package
```typescript
fishAudio.voices.get_package()
```
