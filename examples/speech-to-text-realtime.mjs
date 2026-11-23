// Realtime speech-to-text (Preview): stream a WAV file as a live microphone would.
//
//   npm run build
//   export FISH_API_KEY=...
//   node examples/speech-to-text-realtime.mjs speech.wav
//
// The WAV must be 16-bit PCM, mono, with the standard 44-byte header, at
// 8000, 12000, 16000, 22050, 24000, 32000, 44100 or 48000 Hz. To convert a recording:
//   ffmpeg -i input.mp3 -ac 1 -ar 16000 -c:a pcm_s16le -bitexact speech.wav
import { readFile } from "node:fs/promises";
import { FishAudioClient } from "../dist/esm/index.js";

const CHUNK_MS = 40; // 20-40 ms per chunk suits live audio

const wav = await readFile(process.argv[2]);
const sampleRate = wav.readUInt32LE(24);
const pcm = wav.subarray(44);
const chunkBytes = ((sampleRate * CHUNK_MS) / 1000) * 2;

/** Yields the audio at real-time speed. */
async function* microphone() {
    const start = performance.now();
    for (let sent = 0; sent * chunkBytes < pcm.length; sent++) {
        yield pcm.subarray(sent * chunkBytes, (sent + 1) * chunkBytes);
        const due = start + (sent + 1) * CHUNK_MS;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - performance.now())));
    }
}

const fishAudio = new FishAudioClient(); // reads FISH_API_KEY
const stream = fishAudio.speechToText.convertRealtime(
    { sample_rate: sampleRate, drafts: true, eager: true, diarize: false },
    microphone(),
);

for await (const event of stream) {
    switch (event.type) {
        case "session_started":
            console.log(`session ${event.session_id} (request ${event.request_id})`);
            break;
        case "draft":
            console.log(`  draft     #${event.turn_index}: ${event.text}`);
            break;
        case "eager_end_of_turn":
            console.log(`  eager     #${event.turn_index}: ${event.text}`);
            break;
        case "committed":
            console.log(`committed   #${event.turn_index} (${event.reason}): ${event.text}`);
            break;
        case "error": // recoverable: the session continues
            console.log(`error ${event.error_type} (${event.code}): ${event.message}`);
            break;
        case "session_done":
            console.log(`done: ${event.stats.audio_ms} ms of audio, ${event.stats.turns} turns`);
            break;
        default: // speech_start, user_turn_taken, turn_resumed, ...
            console.log(`  ${event.type}`);
    }
}
