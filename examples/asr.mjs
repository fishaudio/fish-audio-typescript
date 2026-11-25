import { FishAudioClient } from "../dist/esm/index.js";
import { createReadStream } from "fs";

async function main() {
    const fishAudio = new FishAudioClient();

    const audioFile = createReadStream("/path/to/your/audio/file");

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
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
