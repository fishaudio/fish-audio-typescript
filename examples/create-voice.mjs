import { FishAudioClient } from "../dist/esm/index.js";
import { createReadStream } from "fs";

async function main() {
    const fishAudio = new FishAudioClient();

    const title = "cloned-voice-name";
    const audioFile = createReadStream("/path/to/your/audio/file");
    const coverImageFile = createReadStream("/path/to/your/cover/image/file");

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
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
