const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { spawn, spawnSync } = require('child_process');

class AvatarServer {
    constructor(port = 8080) {
        this.port = port;
        this.clients = new Map();
        this.wss = null;
        
        // Video files directory
        this.videosDir = path.join(__dirname, 'videos');
        
        // Streaming configuration
        this.STREAM_DURATION = 5; // Always stream for 5 seconds
        this.FRAME_RATE = 25; // 25 FPS
        this.FRAMES_PER_STREAM = this.FRAME_RATE * this.STREAM_DURATION; // 125 frames
        
        // Ensure directories exist
        this.ensureDirectories();
        
        // Load video data on startup
        console.log('Loading video and audio data from video files...');
        this.mediaData = this.loadMediaData();
        console.log('Media data loading complete');
        console.log(`Server configured for ${this.STREAM_DURATION}s streams (${this.FRAMES_PER_STREAM} frames at ${this.FRAME_RATE} FPS)`);
    }

    ensureDirectories() {
        if (!fs.existsSync(this.videosDir)) {
            fs.mkdirSync(this.videosDir, { recursive: true });
            console.log(`Created videos directory: ${this.videosDir}`);
        }
    }

    start() {
        this.wss = new WebSocket.Server({ 
            port: this.port,
            perMessageDeflate: false,
            maxPayload: 50 * 1024 * 1024 // 50MB max payload
        });

        console.log(`Avatar WebSocket server started on port ${this.port}`);

        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });

        this.wss.on('error', (error) => {
            console.error('WebSocket server error:', error);
        });
    }

    handleConnection(ws, req) {
        const sessionId = uuidv4();
        const clientInfo = {
            sessionId,
            ws,
            connected: true,
            lastActivity: Date.now()
        };

        this.clients.set(sessionId, clientInfo);
        
        console.log(`Client connected: ${sessionId} from ${req.socket.remoteAddress}`);

        // Send connection established message
        this.sendMessage(ws, {
            type: 'connection_established',
            session_id: sessionId,
            timestamp: new Date().toISOString(),
            stream_config: {
                duration: this.STREAM_DURATION,
                frame_rate: this.FRAME_RATE,
                frames_per_stream: this.FRAMES_PER_STREAM
            }
        });

        // Set up message handler
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                this.handleClientMessage(sessionId, message);
            } catch (error) {
                console.error('Error parsing client message:', error);
                this.sendError(ws, 'Invalid JSON message format');
            }
        });

        // Handle disconnection
        ws.on('close', () => {
            console.log(`Client disconnected: ${sessionId}`);
            this.clients.delete(sessionId);
        });

        // Handle errors
        ws.on('error', (error) => {
            console.error(`WebSocket error for client ${sessionId}:`, error);
            this.clients.delete(sessionId);
        });

        // Set up ping/pong for connection health
        ws.on('pong', () => {
            if (this.clients.has(sessionId)) {
                this.clients.get(sessionId).lastActivity = Date.now();
            }
        });
    }

    async handleClientMessage(sessionId, message) {
        const client = this.clients.get(sessionId);
        if (!client || !client.connected) {
            console.log(`Message from disconnected client: ${sessionId}`);
            return;
        }

        console.log(`Received message from ${sessionId}:`, message.type);

        try {
            switch (message.type) {
                case 'text_input':
                    await this.handleTextInput(client, message);
                    break;
                case 'audio_input':
                    await this.handleAudioInput(client, message);
                    break;
                default:
                    console.log(`Unknown message type: ${message.type}`);
                    this.sendError(client.ws, `Unknown message type: ${message.type}`);
            }
        } catch (error) {
            console.error(`Error handling message from ${sessionId}:`, error);
            this.sendError(client.ws, 'Internal server error');
        }
    }

    async handleTextInput(client, message) {
        const text = message.text;
        console.log(`Processing text input: "${text}"`);
        
        // Generate response based on text
        const response = this.generateTextResponse(text);
        console.log(`Generated response: "${response}"`);
        
        // Start 5-second video stream
        await this.streamFixedDurationResponse(client, response, text);
    }

    async handleAudioInput(client, message) {
        const audioData = message.audio;
        console.log(`Processing audio input, size: ${audioData.length} characters (base64)`);
        
        // Process audio (you can integrate with speech-to-text here)
        const transcription = this.processAudio(audioData);
        console.log(`Audio transcription: "${transcription}"`);
        
        // Generate response
        const response = this.generateTextResponse(transcription);
        
        // Start 5-second video stream
        await this.streamFixedDurationResponse(client, response, transcription);
    }

    async streamFixedDurationResponse(client, responseText, originalInput) {
        const sequenceId = uuidv4();
        
        // Determine which video to use based on response content
        const videoType = this.determineVideoType(responseText);
        const mediaSet = this.mediaData[videoType];
        
        console.log(`Starting ${this.STREAM_DURATION}s stream for input: "${originalInput}"`);
        console.log(`Using video type: ${videoType}`);
        
        if (!mediaSet || mediaSet.frames.length === 0) {
            console.error(`No media data available for type: ${videoType}`);
            
            // Try to use any available media as fallback
            let fallbackMedia = null;
            let fallbackType = 'unknown';
            
            for (const [type, data] of Object.entries(this.mediaData)) {
                if (data && data.frames.length > 0) {
                    fallbackMedia = data;
                    fallbackType = type;
                    console.log(`Using emergency fallback media from type: ${type}`);
                    break;
                }
            }
            
            if (!fallbackMedia) {
                this.sendError(client.ws, 'No media data available on server. Please add video files to the videos/ directory.');
                return;
            }
            
            // Stream exactly 5 seconds of fallback media
            await this.streamFixedDuration(client, fallbackMedia, sequenceId, responseText, originalInput, fallbackType);
            return;
        }

        // Stream exactly 5 seconds of the selected media
        await this.streamFixedDuration(client, mediaSet, sequenceId, responseText, originalInput, videoType);
    }

    async streamFixedDuration(client, mediaSet, sequenceId, responseText, originalInput, videoType) {
        const frameDelay = 1000 / this.FRAME_RATE; // milliseconds between frames
        const availableFrames = mediaSet.frames.length;
        const availableAudioChunks = mediaSet.audioChunks.length;
        
        console.log(`Streaming ${this.FRAMES_PER_STREAM} frames (${this.STREAM_DURATION}s) of ${videoType} video`);
        console.log(`Source video has ${availableFrames} frames, ${availableAudioChunks} audio chunks`);

        try {
            // Send stream start
            this.sendMessage(client.ws, {
                type: 'stream_start',
                sequence_id: sequenceId,
                response_text: responseText,
                original_input: originalInput,
                estimated_duration: this.STREAM_DURATION,
                video_type: videoType,
                total_frames: this.FRAMES_PER_STREAM,
                frame_rate: this.FRAME_RATE,
                timestamp: new Date().toISOString()
            });

            // Stream exactly 125 frames (5 seconds at 25 FPS)
            for (let i = 0; i < this.FRAMES_PER_STREAM; i++) {
                // Check if client is still connected
                if (!client.connected || client.ws.readyState !== WebSocket.OPEN) {
                    console.log('Client disconnected during streaming');
                    break;
                }

                // Calculate which frame to use (loop if video is shorter than 5 seconds)
                const frameIndex = i % availableFrames;
                const audioIndex = i % availableAudioChunks;
                
                // Get frame and audio data
                const frameData = mediaSet.frames[frameIndex].data;
                const audioData = mediaSet.audioChunks[audioIndex] ? mediaSet.audioChunks[audioIndex].data : null;

                // Send frame with audio
                this.sendMessage(client.ws, {
                    type: 'frame',
                    sequence_id: sequenceId,
                    frame_index: i, // Use sequential counter (0-124)
                    source_frame_index: frameIndex, // Which frame from source video
                    frame_data: frameData,
                    audio_data: audioData,
                    timestamp: new Date().toISOString(),
                    progress: {
                        current_frame: i + 1,
                        total_frames: this.FRAMES_PER_STREAM,
                        elapsed_time: (i + 1) / this.FRAME_RATE,
                        remaining_time: (this.FRAMES_PER_STREAM - i - 1) / this.FRAME_RATE
                    }
                });

                // Wait for next frame (maintain 25 FPS timing)
                await this.sleep(frameDelay);
            }

            // Send stream end
            this.sendMessage(client.ws, {
                type: 'stream_end',
                sequence_id: sequenceId,
                total_frames: this.FRAMES_PER_STREAM,
                actual_duration: this.STREAM_DURATION,
                video_type: videoType,
                timestamp: new Date().toISOString()
            });

            console.log(`✅ Completed ${this.STREAM_DURATION}s stream (${this.FRAMES_PER_STREAM} frames) for sequence ${sequenceId}`);
            console.log('💬 Ready for next text input...');

        } catch (error) {
            console.error('❌ Error during fixed duration streaming:', error);
            this.sendError(client.ws, `Streaming error: ${error.message}`);
        }
    }

    determineVideoType(responseText) {
        const textLower = responseText.toLowerCase();
        
        // Determine preferred video type based on response content
        let preferredType = 'neutral'; // Default fallback
        
        if (textLower.includes('hello') || textLower.includes('hi') || textLower.includes('welcome')) {
            preferredType = 'greeting';
        } else if (textLower.includes('?') || textLower.includes('question')) {
            preferredType = 'listening';
        } else if (textLower.includes('think') || textLower.includes('consider')) {
            preferredType = 'thinking';
        } else if (responseText.length > 100) {
            preferredType = 'explaining';
        } else {
            preferredType = 'speaking';
        }
        
        // Check if the preferred type has media data
        if (this.mediaData[preferredType] && this.mediaData[preferredType].frames.length > 0) {
            return preferredType;
        }
        
        // Fallback hierarchy: try to find any available media
        const fallbackOrder = ['speaking', 'neutral', 'greeting', 'explaining', 'listening', 'thinking'];
        
        for (const fallbackType of fallbackOrder) {
            if (this.mediaData[fallbackType] && this.mediaData[fallbackType].frames.length > 0) {
                console.log(`📹 Using fallback video type: ${fallbackType} (preferred: ${preferredType})`);
                return fallbackType;
            }
        }
        
        // If no media data available at all, return the preferred type
        console.error(`❌ No media data available for any video type`);
        return preferredType;
    }

    generateTextResponse(input) {
        // Generate concise responses suitable for 5-second videos
        const inputLower = input.toLowerCase();
        
        if (inputLower.includes('hello') || inputLower.includes('hi')) {
            return 'Hello there! Welcome!';
        } else if (inputLower.includes('newton')) {
            return 'Newton was a brilliant physicist and mathematician.';
        } else if (inputLower.includes('help')) {
            return 'I am here to help you!';
        } else if (inputLower.includes('how are you')) {
            return 'I am doing very well, thank you!';
        } else if (inputLower.includes('goodbye') || inputLower.includes('bye')) {
            return 'Goodbye! Take care!';
        } else if (inputLower.includes('thank')) {
            return 'You are very welcome!';
        } else if (inputLower.includes('name')) {
            return 'I am your AI avatar assistant.';
        } else if (inputLower.includes('weather')) {
            return 'I hope you have wonderful weather today!';
        } else if (inputLower.includes('time')) {
            return 'Time is precious, let me help you!';
        } else {
            return `I understand: "${input}". How can I assist you?`;
        }
    }

    processAudio(base64AudioData) {
        // Mock audio processing - replace with actual speech-to-text
        console.log('🎤 Processing audio data...');
        return 'Hello, this is audio input transcription';
    }

    loadMediaData() {
        const mediaData = {
            neutral: { frames: [], audioChunks: [] },
            speaking: { frames: [], audioChunks: [] },
            listening: { frames: [], audioChunks: [] },
            thinking: { frames: [], audioChunks: [] },
            greeting: { frames: [], audioChunks: [] },
            explaining: { frames: [], audioChunks: [] }
        };

        try {
            // Look for video files in the videos directory
            const videoFiles = fs.readdirSync(this.videosDir).filter(file => 
                file.endsWith('.mp4') || file.endsWith('.avi') || file.endsWith('.mov') || file.endsWith('.mkv')
            );

            console.log(`📁 Found ${videoFiles.length} video files`);

            if (videoFiles.length === 0) {
                console.log('⚠️  No video files found. Place video files in the videos/ directory');
                console.log('📋 Expected filenames: neutral.mp4, speaking.mp4, listening.mp4, thinking.mp4, greeting.mp4, explaining.mp4');
                return this.generateFallbackMedia();
            }

            for (const videoFile of videoFiles) {
                const videoPath = path.join(this.videosDir, videoFile);
                const videoName = path.parse(videoFile).name.toLowerCase();
                
                // Determine video type based on filename
                let videoType = 'neutral';
                if (videoName.includes('speak')) videoType = 'speaking';
                else if (videoName.includes('listen')) videoType = 'listening';
                else if (videoName.includes('think')) videoType = 'thinking';
                else if (videoName.includes('greet') || videoName.includes('hello')) videoType = 'greeting';
                else if (videoName.includes('explain')) videoType = 'explaining';

                console.log(`🎬 Processing video: ${videoFile} as type: ${videoType}`);

                // Extract frames and audio from video
                const mediaContent = this.extractMediaFromVideo(videoPath);
                
                if (mediaContent.frames.length > 0) {
                    mediaData[videoType] = mediaContent;
                    console.log(`✅ Loaded ${mediaContent.frames.length} frames and ${mediaContent.audioChunks.length} audio chunks for ${videoType}`);
                } else {
                    console.log(`⚠️  No frames extracted from ${videoFile}`);
                }
            }

        } catch (error) {
            console.error('❌ Error loading media data:', error);
            return this.generateFallbackMedia();
        }

        return mediaData;
    }

    extractMediaFromVideo(videoPath) {
        const frames = [];
        const audioChunks = [];
        const tempDir = path.join(__dirname, 'temp_media');
        
        try {
            // Create temp directory
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            // Check if FFmpeg is available
            const ffmpegCheck = spawnSync('ffmpeg', ['-version'], { stdio: 'pipe' });
            if (ffmpegCheck.error) {
                console.error('❌ FFmpeg not available, using fallback method');
                return this.generateFallbackMediaContent();
            }

            // Extract frames from video
            console.log(`🎞️  Extracting frames from ${videoPath}...`);
            const frameResult = spawnSync('ffmpeg', [
                '-i', videoPath,
                '-vf', 'fps=25,scale=640:480', // 25 FPS, 640x480 resolution
                '-f', 'image2',
                '-q:v', '2', // High quality JPEG
                path.join(tempDir, 'frame_%04d.jpg')
            ], { stdio: 'pipe' });

            if (frameResult.status !== 0) {
                console.error('⚠️  Error extracting frames:', frameResult.stderr.toString());
                console.log('🔄 Attempting to continue with audio extraction...');
            }

            // Extract audio from video - try multiple approaches
            console.log(`🔊 Extracting audio from ${videoPath}...`);
            const audioPath = path.join(tempDir, 'audio.wav');
            
            // First try: standard extraction
            let audioResult = spawnSync('ffmpeg', [
                '-i', videoPath,
                '-acodec', 'pcm_s16le',
                '-ar', '16000',
                '-ac', '1',
                '-f', 'wav',
                '-y', // Overwrite output file
                audioPath
            ], { stdio: 'pipe' });

            // If first attempt fails, try without audio codec specification
            if (audioResult.status !== 0) {
                console.log('🔄 First audio extraction failed, trying alternative method...');
                audioResult = spawnSync('ffmpeg', [
                    '-i', videoPath,
                    '-ar', '16000',
                    '-ac', '1',
                    '-y',
                    audioPath
                ], { stdio: 'pipe' });
            }

            // If still fails, try extracting any audio and converting
            if (audioResult.status !== 0) {
                console.log('🔄 Second audio extraction failed, trying basic extraction...');
                const tempAudioPath = path.join(tempDir, 'temp_audio.wav');
                const extractResult = spawnSync('ffmpeg', [
                    '-i', videoPath,
                    '-vn', // No video
                    '-y',
                    tempAudioPath
                ], { stdio: 'pipe' });
                
                if (extractResult.status === 0) {
                    // Convert the extracted audio
                    audioResult = spawnSync('ffmpeg', [
                        '-i', tempAudioPath,
                        '-ar', '16000',
                        '-ac', '1',
                        '-acodec', 'pcm_s16le',
                        '-y',
                        audioPath
                    ], { stdio: 'pipe' });
                    
                    // Clean up temp file
                    if (fs.existsSync(tempAudioPath)) {
                        fs.unlinkSync(tempAudioPath);
                    }
                }
            }

            if (audioResult.status !== 0) {
                console.error('⚠️  All audio extraction methods failed. Video may not contain audio.');
                console.error('🔊 Audio error:', audioResult.stderr.toString());
            }

            // Read generated frame files
            const frameFiles = fs.readdirSync(tempDir)
                .filter(file => file.startsWith('frame_') && file.endsWith('.jpg'))
                .sort();

            console.log(`📸 Found ${frameFiles.length} extracted frames`);

            for (const frameFile of frameFiles) {
                const framePath = path.join(tempDir, frameFile);
                try {
                    const frameData = fs.readFileSync(framePath);
                    frames.push({
                        data: frameData.toString('base64'),
                        index: frames.length,
                        timestamp: Date.now()
                    });
                    
                    // Clean up frame file
                    fs.unlinkSync(framePath);
                } catch (error) {
                    console.error(`❌ Error reading frame ${frameFile}:`, error);
                }
            }

            // Process extracted audio into chunks if available
            if (fs.existsSync(audioPath)) {
                try {
                    const audioBuffer = fs.readFileSync(audioPath);
                    const processedAudio = this.processWavFile(audioBuffer);
                    audioChunks.push(...processedAudio);
                    
                    // Clean up audio file
                    fs.unlinkSync(audioPath);
                    console.log(`🔊 Successfully processed ${audioChunks.length} audio chunks`);
                } catch (error) {
                    console.error('❌ Error processing audio file:', error);
                }
            } else {
                console.log('🔇 No audio file generated, creating silent audio chunks');
            }

            // If no frames were extracted, generate fallback
            if (frames.length === 0) {
                console.log('🎨 No frames extracted, generating fallback frames');
                const fallbackContent = this.generateFallbackMediaContent();
                frames.push(...fallbackContent.frames);
            }

            // Ensure we have audio for each frame (repeat audio chunks if needed or create silent ones)
            while (audioChunks.length < frames.length) {
                if (audioChunks.length > 0) {
                    // Repeat existing audio chunks
                    const sourceIndex = audioChunks.length % audioChunks.length;
                    audioChunks.push({...audioChunks[sourceIndex], index: audioChunks.length});
                } else {
                    // Create silent audio chunk
                    audioChunks.push(this.createSilentAudioChunk());
                }
            }

            // Clean up temp directory
            this.cleanupTempDirectory(tempDir);

        } catch (error) {
            console.error(`❌ Error extracting media from ${videoPath}:`, error);
            this.cleanupTempDirectory(tempDir);
            return this.generateFallbackMediaContent();
        }

        console.log(`✅ Extracted ${frames.length} frames and ${audioChunks.length} audio chunks`);
        return { frames, audioChunks };
    }

    cleanupTempDirectory(tempDir) {
        try {
            if (fs.existsSync(tempDir)) {
                const remainingFiles = fs.readdirSync(tempDir);
                remainingFiles.forEach(file => {
                    try {
                        fs.unlinkSync(path.join(tempDir, file));
                    } catch (error) {
                        console.error(`❌ Error deleting file ${file}:`, error);
                    }
                });
                fs.rmdirSync(tempDir);
            }
        } catch (error) {
            console.error('❌ Error cleaning up temp directory:', error);
        }
    }

    processWavFile(audioBuffer) {
        const chunks = [];
        
        try {
            // Skip WAV header (typically 44 bytes)
            const headerSize = 44;
            const audioData = audioBuffer.slice(headerSize);
            
            const chunkSize = 16000 * 0.2 * 2; // 200ms at 16kHz, 16-bit (0.2 seconds per chunk)
            const numChunks = Math.floor(audioData.length / chunkSize);
            
            for (let i = 0; i < numChunks; i++) {
                const start = i * chunkSize;
                const end = Math.min(start + chunkSize, audioData.length);
                const chunk = audioData.slice(start, end);
                
                chunks.push({
                    data: chunk.toString('base64'),
                    index: i,
                    duration: 0.2,
                    sampleRate: 16000,
                    timestamp: Date.now()
                });
            }
            
        } catch (error) {
            console.error('❌ Error processing WAV file:', error);
        }
        
        return chunks;
    }

    createSilentAudioChunk() {
        const sampleRate = 16000;
        const duration = 0.2; // 200ms
        const samples = Math.floor(sampleRate * duration);
        const buffer = Buffer.alloc(samples * 2); // 16-bit audio, all zeros = silence
        
        return {
            data: buffer.toString('base64'),
            index: 0,
            duration: duration,
            sampleRate: sampleRate,
            timestamp: Date.now()
        };
    }

    generateFallbackMedia() {
        console.log('🎨 Generating fallback media data...');
        const mediaData = {
            neutral: { frames: [], audioChunks: [] },
            speaking: { frames: [], audioChunks: [] },
            listening: { frames: [], audioChunks: [] },
            thinking: { frames: [], audioChunks: [] },
            greeting: { frames: [], audioChunks: [] },
            explaining: { frames: [], audioChunks: [] }
        };

        Object.keys(mediaData).forEach(type => {
            mediaData[type] = this.generateFallbackMediaContent();
        });

        return mediaData;
    }

    generateFallbackMediaContent() {
        const frames = [];
        const audioChunks = [];
        
        // Generate enough frames for 5+ seconds (150 frames for safety)
        for (let i = 0; i < 150; i++) {
            const frame = this.generateSimpleFrame(i);
            frames.push({
                data: frame,
                index: i,
                timestamp: Date.now()
            });
            
            const audioChunk = this.generateSimpleAudioChunk(i);
            audioChunks.push(audioChunk);
        }
        
        console.log(`🎨 Generated ${frames.length} fallback frames and ${audioChunks.length} audio chunks`);
        return { frames, audioChunks };
    }

    generateSimpleFrame(frameIndex) {
        const width = 640;
        const height = 480;
        const channels = 3;
        const frameSize = width * height * channels;
        const buffer = Buffer.alloc(frameSize);
        
        for (let i = 0; i < frameSize; i += 3) {
            const intensity = (frameIndex * 5 + i / 3) % 255;
            buffer[i] = intensity; // R
            buffer[i + 1] = (intensity + 85) % 255; // G
            buffer[i + 2] = (intensity + 170) % 255; // B
        }

        return buffer.toString('base64');
    }

    generateSimpleAudioChunk(frameIndex) {
        const sampleRate = 16000;
        const duration = 0.2;
        const samples = Math.floor(sampleRate * duration);
        const buffer = Buffer.alloc(samples * 2);
        
        for (let i = 0; i < samples; i++) {
            const frequency = 440 + (frameIndex * 10);
            const sample = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 0.1;
            const intSample = Math.round(sample * 32767);
            buffer.writeInt16LE(intSample, i * 2);
        }
        
        return {
            data: buffer.toString('base64'),
            index: frameIndex,
            duration: duration,
            sampleRate: sampleRate,
            timestamp: Date.now()
        };
    }

    sendMessage(ws, message) {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(message));
            } catch (error) {
                console.error('❌ Error sending message:', error);
            }
        }
    }

    sendError(ws, errorMessage) {
        this.sendMessage(ws, {
            type: 'error',
            message: errorMessage,
            timestamp: new Date().toISOString()
        });
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Health check and cleanup
    startHealthCheck() {
        setInterval(() => {
            const now = Date.now();
            for (const [sessionId, client] of this.clients.entries()) {
                if (now - client.lastActivity > 60000) { // 1 minute timeout
                    console.log(`🧹 Cleaning up inactive client: ${sessionId}`);
                    client.ws.terminate();
                    this.clients.delete(sessionId);
                }
            }
        }, 30000); // Check every 30 seconds
    }

    stop() {
        if (this.wss) {
            this.wss.close(() => {
                console.log('🛑 WebSocket server stopped');
            });
        }
    }
}

// Create and start the server
const server = new AvatarServer(8080);
server.start();
server.startHealthCheck();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Shutting down server...');
    server.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Shutting down server...');
    server.stop();
    process.exit(0);
});

module.exports = AvatarServer;