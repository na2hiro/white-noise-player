import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { spawn, ChildProcess } from "child_process"; // Added ChildProcess
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MUSIC_DIR = path.join(__dirname, "..", "music");
const DEFAULT_DURATION_MS = 1.5 * 60 * 60 * 1000; // 1.5h
const FADE_IN_DURATION = 5; // seconds
const FADE_OUT_DURATION = 5; // seconds

// PCM Audio Stream Constants
const PCM_SAMPLE_RATE = 44100;
const PCM_FORMAT = 's16le'; // signed 16-bit little-endian
const PCM_CHANNELS = 2;

let isPlaying = false;
let timeout: NodeJS.Timeout | null = null;
let mainFfmpegProcess: ChildProcess | null = null; // Changed type
let playerProcess: ChildProcess | null = null; // Changed type
let playbackStartTime: number | null = null;
let currentlyPlayingFile: string | undefined = undefined;

const getMp3Files = () =>
    fs.readdirSync(MUSIC_DIR).filter(file => file.endsWith(".mp3"));

const pickRandom = <T>(arr: T[]): T =>
    arr[Math.floor(Math.random() * arr.length)];

function startPlayback(): string | undefined {
    // Initial Cleanup
    if (playerProcess) {
        console.log("Killing existing player process (SIGKILL)...");
        playerProcess.kill('SIGKILL');
        playerProcess = null;
    }
    if (mainFfmpegProcess) {
        console.log("Killing existing main ffmpeg process (SIGKILL)...");
        mainFfmpegProcess.kill('SIGKILL');
        mainFfmpegProcess = null;
    }
    if (timeout) {
        clearTimeout(timeout);
        timeout = null;
    }

    const files = getMp3Files();
    if (!files.length) {
        console.error("❌ No MP3 files found in ./music");
        return undefined;
    }

    const selectedFile = pickRandom(files);
    currentlyPlayingFile = selectedFile;
    const inputFile = path.join(MUSIC_DIR, selectedFile);
    console.log(`🎵 Starting playback: ${selectedFile}`);

    playbackStartTime = Date.now();

    mainFfmpegProcess = spawn('ffmpeg', [
        '-i', inputFile,
        '-filter:a', `afade=t=in:ss=0:d=${FADE_IN_DURATION}`,
        '-f', PCM_FORMAT,
        '-ar', PCM_SAMPLE_RATE.toString(),
        '-ac', PCM_CHANNELS.toString(),
        'pipe:1' // Output to stdout
    ]);

    mainFfmpegProcess.on('error', (err) => {
        console.error('Error spawning main ffmpeg process:', err);
        if (playerProcess) playerProcess.kill();
        isPlaying = false;
    });

    mainFfmpegProcess.on('exit', (code, signal) => {
        console.log(`Main ffmpeg process exited with code ${code}, signal ${signal}`);
        if (isPlaying) { // Not a user-initiated stop
            console.log('Attempting to play next file (looping)...');
            startPlayback(); // Loop playback
        }
    });
    
    if (!mainFfmpegProcess.stdout) {
        console.error('Main ffmpeg process stdout is null.');
        if (mainFfmpegProcess) mainFfmpegProcess.kill();
        isPlaying = false;
        return undefined;
    }

    playerProcess = spawn('ffplay', [
        '-nodisp',
        '-autoexit',
        '-hide_banner',
        '-i', 'pipe:0', // Input from stdin
        '-f', PCM_FORMAT,
        '-ar', PCM_SAMPLE_RATE.toString(),
        '-ac', PCM_CHANNELS.toString(),
    ]);

    playerProcess.on('error', (err) => {
        console.error('Error spawning ffplay process:', err);
        if (mainFfmpegProcess) mainFfmpegProcess.kill();
        isPlaying = false;
    });

    playerProcess.on('exit', (code, signal) => {
        console.log(`Player process (ffplay) exited with code ${code}, signal ${signal}`);
        // If ffplay exits, but ffmpeg is still running, it might be an issue or ffmpeg might be about to exit.
        // If ffmpeg doesn't exit on its own (e.g. due to an error it handles internally after ffplay dies),
        // we might want to kill it. The 'exit' handler for mainFfmpegProcess should handle looping.
        // For now, we'll assume mainFfmpegProcess's exit handler will take care of things.
    });

    if (mainFfmpegProcess.stdout && playerProcess.stdin) {
        mainFfmpegProcess.stdout.pipe(playerProcess.stdin)
            .on('error', (err) => {
                console.error('Error piping ffmpeg stdout to ffplay stdin:', err);
                if (mainFfmpegProcess) mainFfmpegProcess.kill();
                if (playerProcess) playerProcess.kill();
                isPlaying = false;
            });
    } else {
        console.error('Cannot pipe: mainFfmpegProcess.stdout or playerProcess.stdin is null.');
        if (mainFfmpegProcess) mainFfmpegProcess.kill();
        if (playerProcess) playerProcess.kill(); // playerProcess might be null if spawn failed
        isPlaying = false;
        return undefined;
    }
    
    isPlaying = true;

    // Setup timeout
    if (timeout) clearTimeout(timeout); // Clear any existing timeout first
    timeout = setTimeout(() => {
        console.log("🛑 Auto-stopping after 1.5h"); // Log message still uses 1.5h for consistency
        stopPlayback({ fadeOut: true });
    }, DEFAULT_DURATION_MS);

    return selectedFile;
}

function killProcess(process: ChildProcess | null, signal: NodeJS.Signals = 'SIGINT', name: string = 'process') {
    if (process && !process.killed) {
        try {
            console.log(`Attempting to kill ${name} with signal ${signal}...`);
            const result = process.kill(signal);
            if (result) {
                console.log(`${name} killed successfully or already terminating.`);
            } else {
                console.warn(`${name} kill command returned false (may already be dead or unkillable).`);
            }
        } catch (error) {
            console.error(`Error killing ${name}:`, error);
        }
    } else {
        // console.log(`${name} is null or already killed.`);
    }
}

function stopPlayback(options: { fadeOut?: boolean } = { fadeOut: true }) {
    console.log(`Stopping playback. Fade out: ${options.fadeOut}`);
    isPlaying = false;
    if (timeout) {
        clearTimeout(timeout);
        timeout = null;
    }

    const oldMainFfmpegProcess = mainFfmpegProcess;
    const oldPlayerProcess = playerProcess;
    const oldCurrentlyPlayingFile = currentlyPlayingFile;
    const oldPlaybackStartTime = playbackStartTime;

    mainFfmpegProcess = null;
    playerProcess = null;
    playbackStartTime = null;
    currentlyPlayingFile = null; // Use a different variable for fade out

    // Kill the main playback processes first
    // Using SIGINT to allow graceful exit if possible, though ffmpeg might not respond to it quickly when piped.
    killProcess(oldPlayerProcess, 'SIGINT', 'oldPlayerProcess');
    killProcess(oldMainFfmpegProcess, 'SIGINT', 'oldMainFfmpegProcess');


    if (options.fadeOut && oldCurrentlyPlayingFile && oldPlaybackStartTime !== null) {
        const elapsedTimeMs = Date.now() - oldPlaybackStartTime;
        const seekTimeSec = Math.max(0, elapsedTimeMs / 1000); // Ensure non-negative

        console.log(`🔇 Initiating fade-out for ${oldCurrentlyPlayingFile} from approximately ${seekTimeSec.toFixed(2)}s...`);
        const inputFileForFade = path.join(MUSIC_DIR, oldCurrentlyPlayingFile);

        const fadeFfmpegArgs = [
            '-ss', seekTimeSec.toString(),
            '-i', inputFileForFade,
            '-t', FADE_OUT_DURATION.toString(),
            '-filter:a', `afade=t=out:st=0:d=${FADE_OUT_DURATION}`,
            '-f', PCM_FORMAT,
            '-ar', PCM_SAMPLE_RATE.toString(),
            '-ac', PCM_CHANNELS.toString(),
            'pipe:1'
        ];
        const fadeFfmpegProcess = spawn('ffmpeg', fadeFfmpegArgs);
        console.log('Spawning fade ffmpeg process with args:', fadeFfmpegArgs.join(' '));


        fadeFfmpegProcess.on('error', (err) => {
            console.error('Error spawning fade ffmpeg process:', err);
        });
        fadeFfmpegProcess.on('exit', (code, signal) => {
            console.log(`Fade ffmpeg process exited with code ${code}, signal ${signal}`);
        });

        if (!fadeFfmpegProcess.stdout) {
            console.error('Fade ffmpeg process stdout is null.');
            return;
        }

        const fadePlayerArgs = [
            '-nodisp', '-autoexit', '-hide_banner',
            '-i', 'pipe:0',
            '-f', PCM_FORMAT,
            '-ar', PCM_SAMPLE_RATE.toString(),
            '-ac', PCM_CHANNELS.toString()
        ];
        const fadePlayerProcess = spawn('ffplay', fadePlayerArgs);
        console.log('Spawning fade ffplay process with args:', fadePlayerArgs.join(' '));


        fadePlayerProcess.on('error', (err) => {
            console.error('Error spawning fade ffplay process:', err);
        });
        fadePlayerProcess.on('exit', (code, signal) => {
            console.log(`Fade ffplay process exited with code ${code}, signal ${signal}`);
        });

        if (fadeFfmpegProcess.stdout && fadePlayerProcess.stdin) {
            fadeFfmpegProcess.stdout.pipe(fadePlayerProcess.stdin)
                .on('error', (err) => {
                    console.error('Error piping fade ffmpeg stdout to ffplay stdin:', err);
                    if (fadeFfmpegProcess) fadeFfmpegProcess.kill();
                    if (fadePlayerProcess) fadePlayerProcess.kill();
                });
        } else {
            console.error('Cannot pipe fade: fadeFfmpegProcess.stdout or fadePlayerProcess.stdin is null.');
            if (fadeFfmpegProcess) fadeFfmpegProcess.kill();
            if (fadePlayerProcess) fadePlayerProcess.kill();
        }
    } else {
        console.log("⏹️ Stopping playback without fade-out (or missing data for fade-out).");
    }
}

function startPlaybackWithDifferentTrack(): string | undefined {
    // Initial Cleanup
    if (playerProcess) {
        console.log("Killing existing player process (SIGKILL)...");
        playerProcess.kill('SIGKILL');
        playerProcess = null;
    }
    if (mainFfmpegProcess) {
        console.log("Killing existing main ffmpeg process (SIGKILL)...");
        mainFfmpegProcess.kill('SIGKILL');
        mainFfmpegProcess = null;
    }
    if (timeout) {
        clearTimeout(timeout);
        timeout = null;
    }

    const files = getMp3Files();
    if (!files.length) {
        console.error("❌ No MP3 files found in ./music");
        return undefined;
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
    console.log(`🎵 Starting playback (different track): ${selectedFile}`);

    playbackStartTime = Date.now();

    mainFfmpegProcess = spawn('ffmpeg', [
        '-i', inputFile,
        '-filter:a', `afade=t=in:ss=0:d=${FADE_IN_DURATION}`,
        '-f', PCM_FORMAT,
        '-ar', PCM_SAMPLE_RATE.toString(),
        '-ac', PCM_CHANNELS.toString(),
        'pipe:1' // Output to stdout
    ]);

    mainFfmpegProcess.on('error', (err) => {
        console.error('Error spawning main ffmpeg process:', err);
        if (playerProcess) playerProcess.kill();
        isPlaying = false;
    });

    mainFfmpegProcess.on('exit', (code, signal) => {
        console.log(`Main ffmpeg process exited with code ${code}, signal ${signal}`);
        if (isPlaying) { // Not a user-initiated stop
            console.log('Attempting to play next file (looping)...');
            // Note: Original logic for startPlaybackWithDifferentTrack doesn't imply
            // it should always pick a *different* one on auto-loop.
            // For simplicity, auto-looping calls plain startPlayback.
            startPlayback(); 
        }
    });

    if (!mainFfmpegProcess.stdout) {
        console.error('Main ffmpeg process stdout is null.');
        if (mainFfmpegProcess) mainFfmpegProcess.kill();
        isPlaying = false;
        return undefined;
    }
    
    playerProcess = spawn('ffplay', [
        '-nodisp',
        '-autoexit',
        '-hide_banner',
        '-i', 'pipe:0', // Input from stdin
        '-f', PCM_FORMAT,
        '-ar', PCM_SAMPLE_RATE.toString(),
        '-ac', PCM_CHANNELS.toString(),
    ]);

    playerProcess.on('error', (err) => {
        console.error('Error spawning ffplay process:', err);
        if (mainFfmpegProcess) mainFfmpegProcess.kill();
        isPlaying = false;
    });

    playerProcess.on('exit', (code, signal) => {
        console.log(`Player process (ffplay) exited with code ${code}, signal ${signal}`);
    });

    if (mainFfmpegProcess.stdout && playerProcess.stdin) {
        mainFfmpegProcess.stdout.pipe(playerProcess.stdin)
            .on('error', (err) => {
                console.error('Error piping ffmpeg stdout to ffplay stdin:', err);
                if (mainFfmpegProcess) mainFfmpegProcess.kill();
                if (playerProcess) playerProcess.kill();
                isPlaying = false;
            });
    } else {
        console.error('Cannot pipe: mainFfmpegProcess.stdout or playerProcess.stdin is null.');
        if (mainFfmpegProcess) mainFfmpegProcess.kill();
        if (playerProcess) playerProcess.kill();
        isPlaying = false;
        return undefined;
    }

    isPlaying = true;

    // Setup timeout
    if (timeout) clearTimeout(timeout); // Clear any existing timeout first
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
    } else if (req.url === '/on') {
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
            stopPlayback({ fadeOut: true });
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
        } else {
            // If not playing, start immediately
            isPlaying = true;
            const fileName = startPlayback(); // Regular startPlayback is fine when not already playing
            console.log(`🎵 Web hook: Starting... Playing: ${fileName}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', message: 'Started new track', file: fileName }));
        }
    } else {
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
