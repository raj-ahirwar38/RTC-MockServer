const { Server } = require('socket.io');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { spawn, spawnSync } = require('child_process');

class AvatarServer {
    constructor(port = 8080) {
        this.port = port;
        this.clients = new Map();
        this.httpServer = null;
        this.io = null;
        
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
        // Create HTTP server
        this.httpServer = http.createServer();

        // Create Socket.IO server with CORS configuration
        this.io = new Server(this.httpServer, {
            cors: {
                origin: "*", // Allow all origins - adjust as needed for production
                methods: ["GET", "POST"],
                allowedHeaders: ["*"],
                credentials: true
            },
            // Socket.IO specific options
            allowEIO3: true, // Allow Engine.IO v3 clients
            transports: ['websocket', 'polling'],
            pingTimeout: 60000,
            pingInterval: 25000,
            maxHttpBufferSize: 50 * 1024 * 1024, // 50MB max payload
            // Additional CORS headers for preflight requests
            handlePreflightRequest: (req, res) => {
                res.writeHead(200, {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                    "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control",
                    "Access-Control-Allow-Credentials": true
                });
                res.end();
            }
        });

        // Start HTTP server
        this.httpServer.listen(this.port, () => {
            console.log(`Avatar Socket.IO server started on port ${this.port}`);
            console.log(`Server URL: http://localhost:${this.port}`);
            console.log(`CORS enabled for all origins`);
        });

        // Handle Socket.IO connections
        this.io.on('connection', (socket) => {
            this.handleConnection(socket);
        });

        // Handle server errors
        this.httpServer.on('error', (error) => {
            console.error('HTTP server error:', error);
        });

        this.io.on('error', (error) => {
            console.error('Socket.IO server error:', error);
        });
    }

    handleConnection(socket) {
        const sessionId = uuidv4();
        const clientInfo = {
            sessionId,
            socket,
            connected: true,
            lastActivity: Date.now(),
            remoteAddress: socket.handshake.address
        };

        this.clients.set(sessionId, clientInfo);
        
        console.log(`Client connected: ${sessionId} from ${socket.handshake.address}`);
        console.log(`Total clients connected: ${this.clients.size}`);

        // Send connection established message
        socket.emit('connection_established', {
            session_id: sessionId,
            timestamp: new Date().toISOString(),
            stream_config: {
                duration: this.STREAM_DURATION,
                frame_rate: this.FRAME_RATE,
                frames_per_stream: this.FRAMES_PER_STREAM
            }
        });

        // Set up event handlers
        socket.on('text_input', async (data) => {
            await this.handleTextInput(clientInfo, data);
        });

        socket.on('audio_input', async (data) => {
            await this.handleAudioInput(clientInfo, data);
        });

        // Handle client ping for connection health
        socket.on('ping', () => {
            if (this.clients.has(sessionId)) {
                this.clients.get(sessionId).lastActivity = Date.now();
                socket.emit('pong');
            }
        });

        // Handle disconnection
        socket.on('disconnect', (reason) => {
            console.log(`Client disconnected: ${sessionId}, reason: ${reason}`);
            console.log(`Total clients connected: ${this.clients.size - 1}`);
            this.clients.delete(sessionId);
        });

        // Handle connection errors
        socket.on('error', (error) => {
            console.error(`Socket error for client ${sessionId}:`, error);
            this.clients.delete(sessionId);
        });

        // Update last activity on any message
        socket.onAny(() => {
            if (this.clients.has(sessionId)) {
                this.clients.get(sessionId).lastActivity = Date.now();
            }
        });
    }

    async handleTextInput(client, data) {
        const text = data.text || data;
        console.log(`Processing text input from ${client.sessionId}: "${text}"`);
        
        try {
            // Generate response based on text
            const response = this.generateTextResponse(text);
            console.log(`Generated response: "${response}"`);
            
            // Start 5-second video stream
            await this.streamFixedDurationResponse(client, response, text);
        } catch (error) {
            console.error(`Error handling text input from ${client.sessionId}:`, error);
            this.sendError(client.socket, 'Error processing text input');
        }
    }

    async handleAudioInput(client, data) {
        const audioData = data.audio || data;
        console.log(`Processing audio input from ${client.sessionId}, size: ${audioData.length} characters (base64)`);
        
        try {
            // Process audio (you can integrate with speech-to-text here)
            const transcription = this.processAudio(audioData);
            console.log(`Audio transcription: "${transcription}"`);
            
            // Generate response
            const response = this.generateTextResponse(transcription);
            
            // Start 5-second video stream
            await this.streamFixedDurationResponse(client, response, transcription);
        } catch (error) {
            console.error(`Error handling audio input from ${client.sessionId}:`, error);
            this.sendError(client.socket, 'Error processing audio input');
        }
    }

    async streamFixedDurationResponse(client, responseText, originalInput) {
        const sequenceId = uuidv4();
        
        // Check if client is still connected
        if (!client.connected || !client.socket.connected) {
            console.log('Client disconnected before streaming');
            return;
        }
        
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
                this.sendError(client.socket, 'No media data available on server. Please add video files to the videos/ directory.');
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
            client.socket.emit('stream_start', {
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
                if (!client.connected || !client.socket.connected) {
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
                client.socket.emit('frame', {
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
            client.socket.emit('stream_end', {
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
            this.sendError(client.socket, `Streaming error: ${error.message}`);
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
        const duration = 0.5;
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

    sendError(socket, errorMessage) {
        socket.emit('error', {
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
                    client.socket.disconnect(true);
                    this.clients.delete(sessionId);
                }
            }
        }, 30000); // Check every 30 seconds
    }

    // Get server statistics
    getStats() {
        return {
            connectedClients: this.clients.size,
            serverUptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            availableVideoTypes: Object.keys(this.mediaData).filter(type => 
                this.mediaData[type] && this.mediaData[type].frames.length > 0
            )
        };
    }

    // Broadcast message to all connected clients
    broadcast(event, data) {
        this.io.emit(event, data);
    }

    // Send message to specific client
    sendToClient(sessionId, event, data) {
        const client = this.clients.get(sessionId);
        if (client && client.socket.connected) {
            client.socket.emit(event, data);
            return true;
        }
        return false;
    }

    stop() {
        if (this.io) {
            console.log('🛑 Closing Socket.IO connections...');
            this.io.close(() => {
                console.log('🛑 Socket.IO server stopped');
            });
        }
        
        if (this.httpServer) {
            this.httpServer.close(() => {
                console.log('🛑 HTTP server stopped');
            });
        }
    }
}

// Create and start the server
const server = new AvatarServer(8080);
server.start();
server.startHealthCheck();

// Add endpoint for health check and stats (optional)
server.httpServer.on('request', (req, res) => {
    // Handle CORS for HTTP requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            ...server.getStats()
        }));
    } else if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Avatar Socket.IO Server</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 40px; }
                    .status { color: green; font-weight: bold; }
                    .info { background: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0; }
                    code { background: #eee; padding: 2px 5px; border-radius: 3px; }
                </style>
            </head>
            <body>
                <h1>Avatar Socket.IO Server</h1>
                <p class="status">✅ Server is running</p>
                <div class="info">
                    <h3>Connection Info:</h3>
                    <p><strong>Server URL:</strong> <code>http://localhost:${server.port}</code></p>
                    <p><strong>Connected Clients:</strong> ${server.clients.size}</p>
                    <p><strong>Available Video Types:</strong> ${server.getStats().availableVideoTypes.join(', ')}</p>
                </div>
                <div class="info">
                    <h3>Client Events:</h3>
                    <ul>
                        <li><code>text_input</code> - Send text input: <code>{text: "your message"}</code></li>
                        <li><code>audio_input</code> - Send audio input: <code>{audio: "base64_audio_data"}</code></li>
                        <li><code>ping</code> - Health check ping</li>
                    </ul>
                </div>
                <div class="info">
                    <h3>Server Events:</h3>
                    <ul>
                        <li><code>connection_established</code> - Connection successful</li>
                        <li><code>stream_start</code> - Video stream starting</li>
                        <li><code>frame</code> - Video frame data</li>
                        <li><code>stream_end</code> - Video stream complete</li>
                        <li><code>error</code> - Error message</li>
                        <li><code>pong</code> - Response to ping</li>
                    </ul>
                </div>
            </body>
            </html>
        `);
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Shutting down server...');
    server.stop();
    setTimeout(() => {
        process.exit(0);
    }, 2000);
});

process.on('SIGTERM', () => {
    console.log('🛑 Shutting down server...');
    server.stop();
    setTimeout(() => {
        process.exit(0);
    }, 2000);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    server.stop();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = AvatarServer;
