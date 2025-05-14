import fs from "fs";
import path from "path";
import readline from "readline";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { spawn } from "child_process";
import playSound from "play-sound";
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MUSIC_DIR = path.join(__dirname, "..", "music");
const DEFAULT_DURATION_MS = 1.5 * 60 * 60 * 1000; // 1.5h
const FADE_DURATION = 5; // seconds

let isPlaying = false;
let timeout: NodeJS.Timeout | null = null;
let ffmpegProcess: ReturnType<typeof spawn> | null = null;
const audioPlayer = playSound({ player: 'ffplay' });

const getMp3Files = () =>
    fs.readdirSync(MUSIC_DIR).filter(file => file.endsWith(".mp3"));

const pickRandom = <T>(arr: T[]): T =>
    arr[Math.floor(Math.random() * arr.length)];

function startPlayback(): string | undefined {
    const files = getMp3Files();
    if (!files.length) {
        console.error("❌ No MP3 files found in ./music");
        return;
    }

    const selectedFile = pickRandom(files);
    const inputFile = path.join(MUSIC_DIR, selectedFile);

    const fadeIn = `afade=t=in:ss=0:d=${FADE_DURATION}`;
    // We'll only use fade-in for now, as we'll handle fade-out differently

    ffmpegProcess = audioPlayer.play(inputFile, {
        ffplay: [
            "-hide_banner",
            "-nodisp",
            "-autoexit",
            "-loop", "0",
            "-af", fadeIn
        ]
    }, (err) => {
        if (err && err !== 123) { // Ignore error code 123 which is normal when process is terminated
            console.error("Error playing audio:", err);
            return;
        }

        // Restart playback when the current file ends
        if (isPlaying) {
            const newFileName = startPlayback();
            console.log(`🎵 Playing next file: ${newFileName}`);
        }
    });

    timeout = setTimeout(() => {
        console.log("🛑 Auto-stopping after 1.5h");
        stopPlayback();
    }, DEFAULT_DURATION_MS);

    return selectedFile;
}

function stopPlayback() {
    isPlaying = false;
    if (timeout) clearTimeout(timeout);
    if (ffmpegProcess) {
        try {
            // Send SIGINT signal which is equivalent to pressing Ctrl+C
            // This allows ffplay to exit more gracefully than SIGTERM
            ffmpegProcess.kill('SIGINT');

            // Set ffmpegProcess to null after a short delay to allow for proper cleanup
            setTimeout(() => {
                ffmpegProcess = null;
            }, 100);
        } catch (error) {
            console.error("Error stopping playback:", error);
            ffmpegProcess = null;
        }
    }
}

function togglePlayback() {
    if (isPlaying) {
        console.log("🔇 Stopping...");
        stopPlayback();
    } else {
        isPlaying = true;
        const fileName = startPlayback();
        console.log(`🎵 Starting... Playing: ${fileName}`);
    }
}

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on("keypress", (_str, key) => {
    if (key.name === "space") togglePlayback();
    if (key.ctrl && key.name === "c") process.exit();
});

// Create HTTP server for web hooks
const PORT = 3456;
const server = http.createServer((req, res) => {
    // Set CORS headers to allow requests from any origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    // Handle OPTIONS requests for CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Only handle GET requests
    if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
    }

    // Route handling
    if (req.url === '/on') {
        if (!isPlaying) {
            isPlaying = true;
            const fileName = startPlayback();
            console.log(`🎵 Web hook: Starting... Playing: ${fileName}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', message: 'Playback started', file: fileName }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'info', message: 'Playback already active' }));
        }
    } else if (req.url === '/off') {
        if (isPlaying) {
            console.log("🔇 Web hook: Stopping...");
            stopPlayback();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', message: 'Playback stopped' }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'info', message: 'Playback already stopped' }));
        }
    } else if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', playing: isPlaying }));
    } else if (req.url === '/change') {
        if (isPlaying) {
            // Stop current playback
            stopPlayback();
        }

        // Start new random playback
        isPlaying = true;
        const fileName = startPlayback();
        console.log(`🎵 Web hook: Changing... Now playing: ${fileName}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', message: 'Changed to new track', file: fileName }));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP server running at http://0.0.0.0:${PORT}`);
    console.log(`   Available endpoints: /on, /off, /status, /change`);
});

console.log("🎧 Press [space] to toggle playback. Ctrl+C to exit.");
