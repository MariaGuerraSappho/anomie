console.log("app.js loaded");
import { FaceLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import * as Tone from 'tone';

class GraphiteDrawingSystem {
    constructor() {
        this.canvas = document.getElementById('drawing-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.cursor = document.getElementById('cursor');
        this.video = document.getElementById('video');
        this.statusEl = document.getElementById('status');
        
        // Initialize sizes
        this.resizeCanvas();
        
        // Set charcoal drawing style defaults
        this.params = this.getCharcoalParams();
        
        // Drawing state
        this.isDrawing = false;
        this.lastPoint = { x: 0, y: 0 };
        this.currentPoint = { x: 0, y: 0 };
        this.points = [];
        this.strokes = [];
        this.pressure = 0.5;
        this.opacity = 0.6;
        this.strokeWidth = 0.5;
        this.smudgeFactor = 0;
        
        // Tracking data
        this.faceData = null;
        this.handData = null;
        this.audioLevel = 0;
        this.handVelocity = { x: 0, y: 0 };
        this.lastHandPosition = null;
        
        // Audio system flags and objects
        this.liveAudioEnabled = false;
        this.audioRecordings = [];
        this.currentRecording = null;
        this.isRecording = false;
        this.effectMappings = [];
        this.audioStream = null;
        this.audioContext = null;
        this.recorder = null;
        this.playerReady = false;
        
        // Initialize systems
        this.setupEventListeners();
        
        // Start animation loop
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }
    
    async initializeTrackers() {
        try {
            this.statusEl.textContent = "Loading tracking models...";
            
            // Initialize MediaPipe vision tasks
            const vision = await FilesetResolver.forVisionTasks(
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
            );
            
            this.statusEl.textContent = "Initializing face tracking...";
            
            // Face tracker
            this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
                    delegate: 'GPU'
                },
                runningMode: 'VIDEO',
                numFaces: 1
            });
            
            this.statusEl.textContent = "Initializing hand tracking...";
            
            // Hand tracker
            this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
                    delegate: 'GPU'
                },
                runningMode: 'VIDEO',
                numHands: 1
            });
            
            this.statusEl.textContent = "Requesting camera access...";
            
            // Start video
            if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({
                        video: { width: 640, height: 480 },
                        audio: true
                    });
                    
                    this.video.srcObject = stream;
                    this.video.style.display = 'block';
                    this.audioStream = stream;
                    
                    this.video.onloadedmetadata = () => {
                        this.video.play().catch(e => {
                            console.error("Video play error:", e);
                            this.statusEl.textContent = 'Video playback error';
                        });
                    };
                    
                    // Connect audio stream to analyzer
                    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    const source = this.audioContext.createMediaStreamSource(stream);
                    const analyzer = this.audioContext.createAnalyser();
                    analyzer.fftSize = 256;
                    source.connect(analyzer);
                    
                    const bufferLength = analyzer.frequencyBinCount;
                    const dataArray = new Uint8Array(bufferLength);
                    
                    // Audio level monitoring
                    const getAudioLevel = () => {
                        analyzer.getByteFrequencyData(dataArray);
                        let sum = 0;
                        for (let i = 0; i < bufferLength; i++) {
                            sum += dataArray[i];
                        }
                        this.audioLevel = sum / bufferLength / 255;
                        setTimeout(getAudioLevel, 50);
                    };
                    
                    getAudioLevel();
                    this.statusEl.textContent = 'Tracking active';
                    
                    // Initialize Tone.js
                    await Tone.start();
                    this.initializeAudioSystem();
                    
                } catch (streamError) {
                    console.error("Media stream error:", streamError);
                    this.statusEl.textContent = 'Camera/Mic access denied';
                }
            } else {
                this.statusEl.textContent = 'Media devices not supported in this browser';
            }
        } catch (error) {
            console.error('Error initializing trackers:', error);
            this.statusEl.textContent = 'Error initializing tracking: ' + error.message;
        }
    }
    
    initializeAudioSystem() {
        // Create Tone.js audio effects
        this.effects = {
            reverb: new Tone.Reverb(3).toDestination(),
            delay: new Tone.FeedbackDelay("8n", 0.5).toDestination(),
            distortion: new Tone.Distortion(0.8).toDestination(),
            pitchShift: new Tone.PitchShift(5).toDestination(),
            chorus: new Tone.Chorus(4, 2.5, 0.5).toDestination(),
            tremolo: new Tone.Tremolo(9, 0.75).toDestination(),
            autoFilter: new Tone.AutoFilter("4n").toDestination(),
            bitCrusher: new Tone.BitCrusher(4).toDestination()
        };
        
        // Start the effects
        Object.values(this.effects).forEach(effect => {
            if (typeof effect.start === 'function') {
                effect.start();
            }
        });
        
        // Create players for playback
        this.player = new Tone.Player().toDestination();
        this.player.loop = false;
        this.player.volume.value = -10;
        this.playerReady = true;
        
        // Generate random mappings
        this.generateRandomMappings();
    }
    
    generateRandomMappings() {
        // Create random gesture-to-effect mappings
        const gestures = [
            'indexPointing', 'fist', 'openPalm', 'pinch', 'twoFingers',
            'fingerSnap', 'circleMotion', 'swipeLeft', 'swipeRight', 'swipeUp'
        ];
        
        const actions = [
            'startRecording', 'stopRecording', 'playLastRecording',
            'applyReverb', 'applyDelay', 'applyDistortion', 'applyPitchShift',
            'applyChorus', 'applyTremolo', 'applyAutoFilter', 'applyBitCrusher',
            'clearEffects', 'loopToggle', 'deleteLastRecording'
        ];
        
        // Shuffle actions for random mapping
        const shuffledActions = [...actions].sort(() => Math.random() - 0.5);
        
        this.effectMappings = gestures.map((gesture, index) => {
            return {
                gesture: gesture,
                action: shuffledActions[index % shuffledActions.length],
                threshold: 0.6 + Math.random() * 0.3, // Random confidence threshold
                cooldown: 1000 + Math.random() * 2000 // Random cooldown in ms
            };
        });
        
        // Add random probability of triggering
        this.recordingProbability = 0.15;
        this.playbackProbability = 0.2;
        this.effectApplyProbability = 0.25;
        
        console.log("Audio mappings generated (secret):", this.effectMappings);
    }
    
    startAudioRecording() {
        if (!this.liveAudioEnabled || this.isRecording || !this.audioStream) return;
        
        // Random recording length between 2-7 seconds
        const recordingLength = 2000 + Math.floor(Math.random() * 5000);
        
        try {
            const options = { mimeType: 'audio/webm' };
            this.recorder = new MediaRecorder(this.audioStream, options);
            const audioChunks = [];
            
            this.recorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunks.push(e.data);
            };
            
            this.recorder.onstop = async () => {
                const audioBlob = new Blob(audioChunks);
                const audioUrl = URL.createObjectURL(audioBlob);
                
                // Add to recordings
                this.audioRecordings.push({
                    url: audioUrl,
                    blob: audioBlob,
                    timestamp: Date.now()
                });
                
                // Limit to 10 recordings
                if (this.audioRecordings.length > 10) {
                    const oldestRecording = this.audioRecordings.shift();
                    URL.revokeObjectURL(oldestRecording.url);
                }
                
                this.isRecording = false;
                
                // Maybe play back what was just recorded
                if (Math.random() < this.playbackProbability) {
                    this.playLastRecording();
                }
            };
            
            this.recorder.start();
            this.isRecording = true;
            this.statusEl.textContent = 'Recording audio...';
            
            // Stop recording after random time
            setTimeout(() => {
                if (this.recorder && this.recorder.state === 'recording') {
                    this.recorder.stop();
                    this.statusEl.textContent = 'Tracking active';
                }
            }, recordingLength);
            
        } catch (error) {
            console.error('Recording error:', error);
            this.isRecording = false;
        }
    }
    
    playLastRecording() {
        if (!this.liveAudioEnabled || this.audioRecordings.length === 0 || !this.playerReady) return;
        
        const recording = this.audioRecordings[this.audioRecordings.length - 1];
        
        // Randomly select an effect
        const effectKeys = Object.keys(this.effects);
        const randomEffect = this.effects[effectKeys[Math.floor(Math.random() * effectKeys.length)]];
        
        try {
            // Disconnect existing connections
            if (this.player.connected) {
                this.player.disconnect();
            }
            
            // Randomly decide if we should apply an effect
            if (Math.random() < this.effectApplyProbability) {
                this.player.connect(randomEffect);
            } else {
                this.player.toDestination();
            }
            
            // Load and play
            this.player.load(recording.url).then(() => {
                this.player.start();
                this.statusEl.textContent = 'Playing audio...';
                
                // Reset status after playback
                this.player.onstop = () => {
                    this.statusEl.textContent = 'Tracking active';
                };
            });
        } catch (error) {
            console.error('Playback error:', error);
        }
    }
    
    detectHandGesture() {
        if (!this.handData || !this.liveAudioEnabled) return null;
        
        // Simple gesture detection based on hand landmarks
        const indexTip = this.handData[8]; // Index fingertip
        const thumbTip = this.handData[4]; // Thumb fingertip
        const middleTip = this.handData[12]; // Middle fingertip
        const wrist = this.handData[0]; // Wrist
        
        // Calculate distances for gesture recognition
        const indexThumbDistance = this.calculateDistance(indexTip, thumbTip);
        const indexMiddleDistance = this.calculateDistance(indexTip, middleTip);
        const indexWristDistance = this.calculateDistance(indexTip, wrist);
        
        // Detect different gestures (simplified version)
        if (indexThumbDistance < 0.1) return 'pinch';
        if (indexMiddleDistance < 0.1 && indexThumbDistance > 0.2) return 'twoFingers';
        if (indexWristDistance < 0.2) return 'fist';
        if (indexWristDistance > 0.4) return 'openPalm';
        if (indexTip.y < wrist.y - 0.2) return 'indexPointing';
        
        // Check velocity for swipe gestures
        const speed = Math.sqrt(
            this.handVelocity.x * this.handVelocity.x + 
            this.handVelocity.y * this.handVelocity.y
        );
        
        if (speed > 15) {
            if (Math.abs(this.handVelocity.x) > Math.abs(this.handVelocity.y)) {
                return this.handVelocity.x > 0 ? 'swipeRight' : 'swipeLeft';
            } else {
                return this.handVelocity.y > 0 ? 'swipeDown' : 'swipeUp';
            }
        }
        
        return null;
    }
    
    calculateDistance(p1, p2) {
        return Math.sqrt(
            Math.pow(p1.x - p2.x, 2) + 
            Math.pow(p1.y - p2.y, 2) + 
            Math.pow(p1.z - p2.z, 2)
        );
    }
    
    processGestureActions() {
        if (!this.liveAudioEnabled) return;
        
        const gesture = this.detectHandGesture();
        if (!gesture) return;
        
        // Find matching mapping
        const mapping = this.effectMappings.find(m => m.gesture === gesture);
        if (!mapping) return;
        
        // Check if we're past cooldown
        const now = Date.now();
        if (mapping.lastTriggered && now - mapping.lastTriggered < mapping.cooldown) {
            return;
        }
        
        // Execute action based on mapping
        switch (mapping.action) {
            case 'startRecording':
                if (!this.isRecording && Math.random() < this.recordingProbability) {
                    this.startAudioRecording();
                }
                break;
            case 'stopRecording':
                if (this.isRecording && this.recorder) {
                    this.recorder.stop();
                }
                break;
            case 'playLastRecording':
                if (Math.random() < this.playbackProbability) {
                    this.playLastRecording();
                }
                break;
            case 'applyReverb':
            case 'applyDelay':
            case 'applyDistortion':
            case 'applyPitchShift':
            case 'applyChorus':
            case 'applyTremolo':
            case 'applyAutoFilter':
            case 'applyBitCrusher':
                // These will happen randomly during playback
                break;
            case 'clearEffects':
                if (this.player.connected) {
                    this.player.disconnect();
                    this.player.toDestination();
                }
                break;
            case 'loopToggle':
                this.player.loop = !this.player.loop;
                break;
            case 'deleteLastRecording':
                if (this.audioRecordings.length > 0) {
                    const recording = this.audioRecordings.pop();
                    URL.revokeObjectURL(recording.url);
                }
                break;
        }
        
        // Update last triggered time
        mapping.lastTriggered = now;
        
        // Random chance to record
        if (!this.isRecording && Math.random() < 0.05) {
            this.startAudioRecording();
        }
    }
    
    setupEventListeners() {
        window.addEventListener('resize', this.resizeCanvas.bind(this));
        
        document.getElementById('start-tracking').addEventListener('click', () => {
            this.initializeTrackers();
            document.getElementById('start-tracking').disabled = true;
            document.getElementById('start-tracking').textContent = 'Tracking Started';
        });
        
        document.getElementById('toggle-live-audio').addEventListener('click', () => {
            this.liveAudioEnabled = !this.liveAudioEnabled;
            const button = document.getElementById('toggle-live-audio');
            button.textContent = this.liveAudioEnabled ? 'Disable Live Audio' : 'Enable Live Audio';
            
            if (this.liveAudioEnabled) {
                this.statusEl.textContent = 'Live audio enabled - try hand gestures!';
                setTimeout(() => {
                    if (this.liveAudioEnabled) this.statusEl.textContent = 'Tracking active';
                }, 2000);
                
                // Re-generate mappings when enabled
                this.generateRandomMappings();
            } else {
                this.statusEl.textContent = 'Live audio disabled';
                setTimeout(() => this.statusEl.textContent = 'Tracking active', 1000);
            }
        });
        
        document.getElementById('change-params').addEventListener('click', () => {
            this.params = this.getRandomParams();
            this.statusEl.textContent = 'Style changed';
            setTimeout(() => this.statusEl.textContent = 'Tracking active', 1000);
        });
        
        document.getElementById('clear-canvas').addEventListener('click', () => {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.strokes = [];
        });
        
        document.getElementById('save-drawing').addEventListener('click', () => {
            const link = document.createElement('a');
            link.download = 'graphite-drawing.png';
            link.href = this.canvas.toDataURL('image/png');
            link.click();
        });
    }
    
    resizeCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        
        // Redraw on resize
        if (this.ctx) {
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            
            // Apply any saved strokes
            this.applyStrokes();
        }
    }
    
    applyStrokes() {
        // Redraw all saved strokes (for resize or other events)
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.strokes.forEach(stroke => {
            if (stroke.points.length < 2) return;
            
            this.ctx.globalAlpha = stroke.opacity;
            this.ctx.strokeStyle = `rgba(10, 10, 10, ${stroke.opacity})`;
            this.ctx.lineWidth = stroke.width;
            
            this.ctx.beginPath();
            this.ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
            
            for (let i = 1; i < stroke.points.length; i++) {
                const p0 = stroke.points[i - 1];
                const p1 = stroke.points[i];
                
                if (stroke.smudge > 0.3) {
                    // Smudging effect
                    const midX = (p0.x + p1.x) / 2;
                    const midY = (p0.y + p1.y) / 2;
                    this.ctx.quadraticCurveTo(p0.x, p0.y, midX, midY);
                } else {
                    this.ctx.lineTo(p1.x, p1.y);
                }
            }
            
            this.ctx.stroke();
            
            // Add texture if needed
            if (stroke.texture > 0.5) {
                this.addStrokeTexture(stroke);
            }
        });
    }
    
    addStrokeTexture(stroke) {
        // Add graphite-like texturing to a stroke
        const texturePoints = [];
        
        // Generate texture points around the stroke path
        stroke.points.forEach(point => {
            const count = Math.floor(Math.random() * 3) + 1;
            for (let i = 0; i < count; i++) {
                const spread = stroke.width * 2 * stroke.texture;
                const jitterX = (Math.random() - 0.5) * spread;
                const jitterY = (Math.random() - 0.5) * spread;
                
                texturePoints.push({
                    x: point.x + jitterX,
                    y: point.y + jitterY,
                    size: Math.random() * stroke.width * 0.7,
                    alpha: Math.random() * 0.3 * stroke.opacity
                });
            }
        });
        
        // Draw texture points
        texturePoints.forEach(point => {
            this.ctx.globalAlpha = point.alpha;
            this.ctx.beginPath();
            this.ctx.arc(point.x, point.y, point.size, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(10, 10, 10, ${point.alpha})`;
            this.ctx.fill();
        });
    }
    
    getRandomParams() {
        // Create a new parameter mapping for the drawing style
        return {
            // How inputs affect the brush
            pressureFromAudio: Math.random() > 0.5,
            widthFromHandSpeed: Math.random() > 0.3,
            opacityFromFaceTilt: Math.random() > 0.4,
            smudgeFromStillness: Math.random() > 0.2,
            
            // Coefficients to adjust sensitivity
            audioSensitivity: 0.5 + Math.random() * 2,
            handSpeedSensitivity: 0.2 + Math.random() * 1.5,
            faceTiltSensitivity: 0.5 + Math.random(),
            
            // Visual style
            baseWidth: 0.5 + Math.random() * 1.5,
            baseOpacity: 0.3 + Math.random() * 0.5,
            textureAmount: Math.random() * 0.7,
            smudgeThreshold: 0.1 + Math.random() * 0.3,
            
            // Dynamics
            inertia: 0.5 + Math.random() * 0.4,
            jitter: Math.random() * 0.3,
            
            // Special effects
            occasionalErase: Math.random() > 0.7,
            eraseThreshold: 0.85 + Math.random() * 0.1
        };
    }
    
    getCharcoalParams() {
        // Create a charcoal drawing style parameter set
        return {
            pressureFromAudio: true,
            widthFromHandSpeed: true,
            opacityFromFaceTilt: true,
            smudgeFromStillness: true,
            
            audioSensitivity: 2.0,
            handSpeedSensitivity: 1.2,
            faceTiltSensitivity: 1.0,
            
            baseWidth: 1.8,
            baseOpacity: 0.7,
            textureAmount: 0.6,
            smudgeThreshold: 0.25,
            
            inertia: 0.7,
            jitter: 0.2,
            
            occasionalErase: true,
            eraseThreshold: 0.92
        };
    }
    
    updateTracking() {
        if (this.video.readyState === 4) {
            // Update face tracking
            if (this.faceLandmarker) {
                const results = this.faceLandmarker.detectForVideo(this.video, performance.now());
                if (results.faceLandmarks && results.faceLandmarks.length > 0) {
                    this.faceData = results.faceLandmarks[0];
                }
            }
            
            // Update hand tracking
            if (this.handLandmarker) {
                const results = this.handLandmarker.detectForVideo(this.video, performance.now());
                if (results.landmarks && results.landmarks.length > 0) {
                    this.handData = results.landmarks[0];
                    
                    // Calculate hand position (index finger tip)
                    const indexTip = this.handData[8]; // Index fingertip
                    
                    if (indexTip) {
                        // Convert normalized coordinates to canvas coordinates
                        const x = (1 - indexTip.x) * this.canvas.width; // Mirror horizontally
                        const y = indexTip.y * this.canvas.height;
                        
                        // Calculate velocity
                        if (this.lastHandPosition) {
                            this.handVelocity = {
                                x: x - this.lastHandPosition.x,
                                y: y - this.lastHandPosition.y
                            };
                        }
                        
                        // Update position with inertia for smoother movement
                        const inertia = this.params.inertia;
                        this.currentPoint.x = this.currentPoint.x * inertia + x * (1 - inertia);
                        this.currentPoint.y = this.currentPoint.y * inertia + y * (1 - inertia);
                        
                        // Add slight jitter for natural hand feel
                        const jitter = this.params.jitter;
                        if (jitter > 0) {
                            this.currentPoint.x += (Math.random() - 0.5) * jitter * 10;
                            this.currentPoint.y += (Math.random() - 0.5) * jitter * 10;
                        }
                        
                        // Start drawing when hand is detected
                        if (!this.isDrawing) {
                            this.isDrawing = true;
                            this.lastPoint = { ...this.currentPoint };
                            this.points = [{ ...this.currentPoint }];
                        }
                        
                        this.lastHandPosition = { x, y };
                        this.cursor.style.display = 'block';
                        this.cursor.style.left = `${this.currentPoint.x}px`;
                        this.cursor.style.top = `${this.currentPoint.y}px`;
                        
                        // Process audio gestures
                        this.processGestureActions();
                    }
                } else {
                    if (this.isDrawing) {
                        // End the current stroke
                        this.finishStroke();
                    }
                    this.cursor.style.display = 'none';
                }
            }
        }
    }
    
    updateDrawingParameters() {
        if (!this.isDrawing) return;
        
        // Calculate the speed of hand movement
        const speed = Math.sqrt(
            this.handVelocity.x * this.handVelocity.x + 
            this.handVelocity.y * this.handVelocity.y
        );
        const normalizedSpeed = Math.min(1, speed / 30);
        
        // Update pressure based on audio or hand speed
        if (this.params.pressureFromAudio) {
            this.pressure = this.audioLevel * this.params.audioSensitivity;
        } else {
            this.pressure = 1 - normalizedSpeed;
        }
        this.pressure = Math.max(0.1, Math.min(1, this.pressure));
        
        // Update stroke width based on parameters
        if (this.params.widthFromHandSpeed) {
            this.strokeWidth = this.params.baseWidth * (1 - normalizedSpeed * this.params.handSpeedSensitivity);
        } else {
            this.strokeWidth = this.params.baseWidth * this.pressure;
        }
        this.strokeWidth = Math.max(0.2, Math.min(5, this.strokeWidth));
        
        // Update opacity based on face tilt if available
        if (this.faceData && this.params.opacityFromFaceTilt) {
            // Calculate face tilt using landmarks
            const leftEye = this.faceData[133]; // Left eye center
            const rightEye = this.faceData[362]; // Right eye center
            if (leftEye && rightEye) {
                const tilt = Math.abs(leftEye.y - rightEye.y);
                this.opacity = this.params.baseOpacity * (1 + tilt * this.params.faceTiltSensitivity);
            }
        } else {
            this.opacity = this.params.baseOpacity;
        }
        this.opacity = Math.max(0.1, Math.min(0.9, this.opacity));
        
        // Determine if we should smudge based on stillness
        if (this.params.smudgeFromStillness && normalizedSpeed < this.params.smudgeThreshold) {
            this.smudgeFactor = 1 - normalizedSpeed / this.params.smudgeThreshold;
        } else {
            this.smudgeFactor = 0;
        }
        
        // Occasional erasing effect
        if (this.params.occasionalErase && Math.random() > this.params.eraseThreshold) {
            this.opacity *= 0.1; // Much lighter stroke for erasing effect
            this.strokeWidth *= 2; // Wider stroke for erasing
            this.smudgeFactor = 0.8; // More smudging
        }
        
        // Update cursor size to reflect current stroke width
        this.cursor.style.width = `${this.strokeWidth * 2}px`;
        this.cursor.style.height = `${this.strokeWidth * 2}px`;
        this.cursor.style.opacity = this.opacity;
    }
    
    draw() {
        if (!this.isDrawing || !this.lastPoint) return;
        
        // Only add points if we've moved enough
        const dx = this.currentPoint.x - this.lastPoint.x;
        const dy = this.currentPoint.y - this.lastPoint.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance > 2) {
            // Add point to current stroke
            this.points.push({ ...this.currentPoint });
            
            // Draw the new line segment
            this.ctx.globalAlpha = this.opacity;
            this.ctx.strokeStyle = `rgba(10, 10, 10, ${this.opacity})`;
            this.ctx.lineWidth = this.strokeWidth;
            
            this.ctx.beginPath();
            
            if (this.points.length < 3) {
                // Not enough points for a curve, draw a line
                this.ctx.moveTo(this.lastPoint.x, this.lastPoint.y);
                this.ctx.lineTo(this.currentPoint.x, this.currentPoint.y);
            } else {
                // Use curve for smoother lines
                const p1 = this.points[this.points.length - 3];
                const p2 = this.points[this.points.length - 2];
                const p3 = this.points[this.points.length - 1];
                
                if (this.smudgeFactor > 0.3) {
                    // Smudging effect - more random and spread out
                    this.ctx.moveTo(p1.x, p1.y);
                    const cp1x = p2.x + (Math.random() - 0.5) * 10 * this.smudgeFactor;
                    const cp1y = p2.y + (Math.random() - 0.5) * 10 * this.smudgeFactor;
                    this.ctx.quadraticCurveTo(cp1x, cp1y, p3.x, p3.y);
                    
                    // Add some texture points for smudge
                    if (Math.random() > 0.7) {
                        this.addSmudgeTexture(p2, p3);
                    }
                } else {
                    // Normal smooth curve
                    this.ctx.moveTo(p1.x, p1.y);
                    const cp1x = p2.x;
                    const cp1y = p2.y;
                    this.ctx.quadraticCurveTo(cp1x, cp1y, p3.x, p3.y);
                }
            }
            
            this.ctx.stroke();
            this.lastPoint = { ...this.currentPoint };
        }
    }
    
    addSmudgeTexture(p1, p2) {
        // Add texture points to simulate charcoal smudging
        const count = Math.floor(Math.random() * 8) + 5;
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        
        this.ctx.globalAlpha = this.opacity * 0.4;
        
        for (let i = 0; i < count; i++) {
            const spread = this.strokeWidth * 6 * this.smudgeFactor;
            const x = midX + (Math.random() - 0.5) * spread;
            const y = midY + (Math.random() - 0.5) * spread;
            const size = Math.random() * this.strokeWidth;
            
            this.ctx.beginPath();
            this.ctx.arc(x, y, size, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(10, 10, 10, ${this.opacity * 0.3})`;
            this.ctx.fill();
        }
    }
    
    finishStroke() {
        if (this.points.length > 1) {
            // Save the completed stroke
            this.strokes.push({
                points: [...this.points],
                width: this.strokeWidth,
                opacity: this.opacity,
                smudge: this.smudgeFactor,
                texture: this.params.textureAmount
            });
        }
        
        // Reset for next stroke
        this.isDrawing = false;
        this.points = [];
    }
    
    animate() {
        this.updateTracking();
        this.updateDrawingParameters();
        this.draw();
        requestAnimationFrame(this.animate);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    try {
        new GraphiteDrawingSystem();
    } catch(e) {
        console.error("Error starting app:", e);
        document.getElementById('status').textContent = 'Error starting app. Check console.';
    }
});
