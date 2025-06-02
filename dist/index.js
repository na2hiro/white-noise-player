import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { dirname } from "path";
import playSound from "play-sound";
import http from "http";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MUSIC_DIR = path.join(__dirname, "..", "music");
const DEFAULT_DURATION_MS = 1.5 * 60 * 60 * 1000; // 1.5h
const FADE_IN_DURATION = 5; // seconds
const FADE_OUT_DURATION = 5; // seconds
let isPlaying = false;
let timeout = null;
let ffmpegProcess = null;
let currentlyPlayingFile = undefined;
const audioPlayer = playSound({ player: 'ffplay' });
const getMp3Files = () => fs.readdirSync(MUSIC_DIR).filter(file => file.endsWith(".mp3"));
const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];
function startPlayback() {
    const files = getMp3Files();
    if (!files.length) {
        console.error("❌ No MP3 files found in ./music");
        return;
    }
    const selectedFile = pickRandom(files);
    currentlyPlayingFile = selectedFile;
    const inputFile = path.join(MUSIC_DIR, selectedFile);
    const fadeIn = `afade=t=in:ss=0:d=${FADE_IN_DURATION}`;
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
        stopPlayback({ fadeOut: true });
    }, DEFAULT_DURATION_MS);
    return selectedFile;
}
function stopPlayback(options = { fadeOut: true }) {
    isPlaying = false;
    if (timeout)
        clearTimeout(timeout);
    const oldProcess = ffmpegProcess;
    const oldFile = currentlyPlayingFile;
    ffmpegProcess = null;
    currentlyPlayingFile = undefined;
    if (oldProcess) {
        if (options.fadeOut && oldFile) {
            console.log(`Initiating fade-out for ${oldFile}...`);
            const inputFile = path.join(MUSIC_DIR, oldFile);
            audioPlayer.play(inputFile, {
                ffplay: [
                    "-hide_banner",
                    "-nodisp",
                    "-autoexit",
                    "-t", FADE_OUT_DURATION.toString(),
                    "-af", `afade=t=out:d=${FADE_OUT_DURATION}`
                ]
            }, (err) => {
                if (err && err !== 123) {
                    console.error(`Error during fade-out for ${oldFile}:`, err);
                    return;
                }
                console.log(`Fade-out complete for ${oldFile}`);
            });
            setTimeout(() => {
                console.log(`Killing old process for ${oldFile}...`);
                try {
                    oldProcess.kill('SIGINT');
                }
                catch (error) {
                    console.error(`Error killing old process for ${oldFile}:`, error);
                }
            }, 100);
        }
        else {
            try {
                oldProcess.kill('SIGINT');
            }
            catch (error) {
                console.error("Error stopping playback:", error);
            }
        }
    }
}
function startPlaybackWithDifferentTrack() {
    const files = getMp3Files();
    if (!files.length) {
        console.error("❌ No MP3 files found in ./music");
        return;
    }
    // Filter out the currently playing file if it exists
    const availableFiles = currentlyPlayingFile
        ? files.filter(file => file !== currentlyPlayingFile)
        : files;
    // If there's only one file or no files left after filtering, use all files
    const filesToPickFrom = availableFiles.length > 0 ? availableFiles : files;
    const selectedFile = pickRandom(filesToPickFrom);
    currentlyPlayingFile = selectedFile;
    const inputFile = path.join(MUSIC_DIR, selectedFile);
    const fadeIn = `afade=t=in:ss=0:d=${FADE_IN_DURATION}`;
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
        stopPlayback({ fadeOut: true });
    }, DEFAULT_DURATION_MS);
    return selectedFile;
}
function togglePlayback() {
    if (isPlaying) {
        console.log("🔇 Stopping...");
        stopPlayback({ fadeOut: true });
    }
    else {
        isPlaying = true;
        const fileName = startPlayback();
        console.log(`🎵 Starting... Playing: ${fileName}`);
    }
}
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on("keypress", (_str, key) => {
    if (key.name === "space")
        togglePlayback();
    if (key.ctrl && key.name === "c")
        process.exit();
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
    // HTML content for the web interface
    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>White Noise Controller</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            text-align: center;
        }
        h1 {
            color: #333;
        }
        .button-container {
            display: flex;
            justify-content: center;
            gap: 10px;
            margin: 20px 0;
        }
        button {
            padding: 10px 20px;
            font-size: 16px;
            cursor: pointer;
            border: none;
            border-radius: 4px;
            transition: background-color 0.3s;
        }
        #onButton {
            background-color: #4CAF50;
            color: white;
        }
        #offButton {
            background-color: #f44336;
            color: white;
        }
        #changeButton {
            background-color: #2196F3;
            color: white;
        }
        button:hover {
            opacity: 0.8;
        }
        #status {
            margin-top: 20px;
            padding: 10px;
            border-radius: 4px;
            background-color: #f1f1f1;
        }
    </style>
</head>
<body>
    <h1>White Noise Controller</h1>
    <div class="button-container">
        <button id="onButton">Turn On</button>
        <button id="offButton">Turn Off</button>
        <button id="changeButton">Change Track</button>
    </div>
    <div id="status">Status: Checking...</div>

    <script>
        // Function to update status display
        async function updateStatus() {
            try {
                const response = await fetch('/status');
                const data = await response.json();

                const statusElement = document.getElementById('status');
                if (data.playing) {
                    statusElement.textContent = 'Status: Playing';
                    statusElement.style.backgroundColor = '#e8f5e9';
                } else {
                    statusElement.textContent = 'Status: Stopped';
                    statusElement.style.backgroundColor = '#ffebee';
                }
            } catch (error) {
                console.error('Error fetching status:', error);
                document.getElementById('status').textContent = 'Status: Error connecting to server';
                document.getElementById('status').style.backgroundColor = '#ffebee';
            }
        }

        // Function to handle button clicks
        async function handleButtonClick(endpoint) {
            try {
                const response = await fetch('/' + endpoint);
                const data = await response.json();
                console.log(data);

                // Update status after action
                setTimeout(updateStatus, 500);
            } catch (error) {
                console.error('Error:', error);
                document.getElementById('status').textContent = 'Error: Failed to connect to server';
                document.getElementById('status').style.backgroundColor = '#ffebee';
            }
        }

        // Add event listeners to buttons
        document.getElementById('onButton').addEventListener('click', () => handleButtonClick('on'));
        document.getElementById('offButton').addEventListener('click', () => handleButtonClick('off'));
        document.getElementById('changeButton').addEventListener('click', () => handleButtonClick('change'));

        // Check status on page load
        document.addEventListener('DOMContentLoaded', updateStatus);

        // Periodically update status
        setInterval(updateStatus, 5000);
    </script>
</body>
</html>
`;
    // Route handling
    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(htmlContent);
    }
    else if (req.url === '/on') {
        if (!isPlaying) {
            isPlaying = true;
            const fileName = startPlayback();
            console.log(`🎵 Web hook: Starting... Playing: ${fileName}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', message: 'Playback started', file: fileName }));
        }
        else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'info', message: 'Playback already active' }));
        }
    }
    else if (req.url === '/off') {
        if (isPlaying) {
            console.log("🔇 Web hook: Stopping...");
            stopPlayback({ fadeOut: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', message: 'Playback stopped' }));
        }
        else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'info', message: 'Playback already stopped' }));
        }
    }
    else if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', playing: isPlaying }));
    }
    else if (req.url === '/change') {
        if (isPlaying) {
            // Stop current playback
            stopPlayback({ fadeOut: true });
            // Wait for the previous playback to fully terminate before starting a new one
            setTimeout(() => {
                // Start new random playback with a different track
                isPlaying = true;
                const fileName = startPlaybackWithDifferentTrack();
                console.log(`🎵 Web hook: Changing... Now playing: ${fileName}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'success', message: 'Changed to new track', file: fileName }));
            }, 150); // Wait 150ms to ensure previous process is fully terminated
        }
        else {
            // If not playing, start immediately
            isPlaying = true;
            const fileName = startPlayback(); // Regular startPlayback is fine when not already playing
            console.log(`🎵 Web hook: Starting... Playing: ${fileName}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', message: 'Started new track', file: fileName }));
        }
    }
    else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP server running at http://0.0.0.0:${PORT}`);
    console.log(`   Web interface available at http://0.0.0.0:${PORT}/`);
    console.log(`   API endpoints: /on, /off, /status, /change`);
});
console.log("🎧 Press [space] to toggle playback. Ctrl+C to exit.");
