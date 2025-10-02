from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import json
import asyncio
import time
from typing import Dict, List
import os
import base64
import tempfile
from dotenv import load_dotenv
import logging

load_dotenv()

try:
    from azure.keyvault.secrets import SecretClient
    from azure.identity import DefaultAzureCredential
    AZURE_AVAILABLE = True
except ImportError:
    AZURE_AVAILABLE = False
    logging.warning("Azure SDK not available. Using environment variables for secrets.")

from deepgram import DeepgramClient, PrerecordedOptions, LiveTranscriptionEvents, LiveOptions
import deepl
import azure.cognitiveservices.speech as speechsdk
import pyttsx3
import io
import wave

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Simultaneous Translation Service", version="1.0.0")

def get_secret(secret_name: str, default_value: str = None) -> str:
    """Get secret from Azure Key Vault or environment variable"""
    if AZURE_AVAILABLE and os.getenv("AZURE_KEY_VAULT_URL"):
        try:
            credential = DefaultAzureCredential()
            client = SecretClient(vault_url=os.getenv("AZURE_KEY_VAULT_URL"), credential=credential)
            secret = client.get_secret(secret_name)
            return secret.value
        except Exception as e:
            logger.warning(f"Failed to get secret {secret_name} from Key Vault: {e}")
    
    return os.getenv(secret_name.upper().replace("-", "_"), default_value)

cors_origins_str = os.getenv("CORS_ORIGINS", '["*"]')
try:
    cors_origins = json.loads(cors_origins_str)
except json.JSONDecodeError:
    cors_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

rooms: Dict[str, List[WebSocket]] = {}
user_languages: Dict[WebSocket, Dict[str, str]] = {}

deepgram_api_key = get_secret("deepgram-api-key", os.getenv("DEEPGRAM_API_KEY", ""))
deepl_api_key = get_secret("deepl-api-key", os.getenv("DEEPL_API_KEY", ""))
azure_speech_key = get_secret("azure-speech-key", os.getenv("AZURE_SPEECH_KEY", ""))
azure_speech_region = os.getenv("AZURE_SPEECH_REGION", "germanywestcentral")

try:
    deepgram_client = DeepgramClient(deepgram_api_key) if deepgram_api_key else None
    logger.info(f"Deepgram client initialized: {'✓' if deepgram_client else '✗'}")
except Exception as e:
    logger.error(f"Failed to initialize Deepgram client: {e}")
    deepgram_client = None

try:
    deepl_translator = deepl.Translator(deepl_api_key) if deepl_api_key else None
    logger.info(f"DeepL translator initialized: {'✓' if deepl_translator else '✗'}")
except Exception as e:
    logger.error(f"Failed to initialize DeepL translator: {e}")
    deepl_translator = None

speech_config = speechsdk.SpeechConfig(
    subscription=azure_speech_key,
    region=azure_speech_region
) if azure_speech_key else None

class TranslationService:
    def __init__(self):
        self.deepgram_api_key = get_secret("deepgram-api-key", os.getenv("DEEPGRAM_API_KEY"))
        self.deepl_api_key = get_secret("deepl-api-key", os.getenv("DEEPL_API_KEY"))
        self.azure_speech_key = get_secret("azure-speech-key", os.getenv("AZURE_SPEECH_KEY"))
        self.azure_speech_region = os.getenv("AZURE_SPEECH_REGION", "germanywestcentral")
        
        self.latency_metrics = {
            "deepgram": 0.0,
            "deepl": 0.0,
            "azure_tts": 0.0
        }
    
    async def measure_deepgram_latency(self, audio_data: bytes, language: str, mime_type: str = "unknown") -> tuple:
        start_time = time.time()
        try:
            if not deepgram_client:
                print("[DEBUG] Deepgram client not initialized - API key missing")
                end_time = time.time()
                return "", (end_time - start_time) * 1000
                
            print(f"[DEBUG] Deepgram STT - Audio data size: {len(audio_data)} bytes")
            print(f"[DEBUG] Deepgram STT - Language: {language}")
            print(f"[DEBUG] Deepgram STT - First 50 bytes: {audio_data[:50].hex()}")
            
            if len(audio_data) < 500:
                print(f"[DEBUG] Audio data too small: {len(audio_data)} bytes")
                end_time = time.time()
                return "", (end_time - start_time) * 1000
            
            wav_audio_data = self._convert_to_wav(audio_data, mime_type)
            print(f"[DEBUG] Deepgram STT - Converted to WAV, size: {len(wav_audio_data)} bytes")
                
            options = PrerecordedOptions(
                model="nova-2",
                language=language,
                smart_format=True,
                punctuate=True,
                utterances=True,
                detect_language=False,
                diarize=False
            )
            
            print(f"[DEBUG] Deepgram STT - Sending WAV audio to Deepgram")
            response = deepgram_client.listen.prerecorded.v("1").transcribe_file(
                {"buffer": wav_audio_data}, options
            )
            
            end_time = time.time()
            self.latency_metrics["deepgram"] = (end_time - start_time) * 1000
            
            print(f"[DEBUG] Deepgram STT - Response received, latency: {self.latency_metrics['deepgram']}ms")
            print(f"[DEBUG] Deepgram STT - Response structure: {type(response)}")
            
            if response.results and response.results.channels and len(response.results.channels) > 0:
                print(f"[DEBUG] Deepgram STT - Found {len(response.results.channels)} channels")
                if response.results.channels[0].alternatives and len(response.results.channels[0].alternatives) > 0:
                    transcript = response.results.channels[0].alternatives[0].transcript
                    print(f"[DEBUG] Deepgram STT - Transcript: '{transcript}'")
                    return transcript, self.latency_metrics["deepgram"]
                else:
                    print("[DEBUG] Deepgram STT - No alternatives found in first channel")
            else:
                print("[DEBUG] Deepgram STT - No channels found in response")
            
            print("[DEBUG] No transcript found in Deepgram response")
            return "", self.latency_metrics["deepgram"]
        except Exception as e:
            print(f"[DEBUG] Deepgram error: {e}")
            print(f"[DEBUG] Deepgram error type: {type(e)}")
            import traceback
            print(f"[DEBUG] Deepgram traceback: {traceback.format_exc()}")
            end_time = time.time()
            self.latency_metrics["deepgram"] = (end_time - start_time) * 1000
            return "", self.latency_metrics["deepgram"]
    
    def _convert_to_wav(self, audio_data: bytes, mime_type: str = "unknown") -> bytes:
        """Convert raw audio data to WAV format for Deepgram compatibility"""
        try:
            print(f"[DEBUG] Audio conversion - Input size: {len(audio_data)} bytes")
            
            if audio_data.startswith(b'RIFF') and b'WAVE' in audio_data[:20]:
                print("[DEBUG] Audio data is already in WAV format - fast path")
                return audio_data
            
            if audio_data.startswith(b'\x1a\x45\xdf\xa3'):
                print("[DEBUG] Detected WebM format - fast conversion")
                try:
                    from pydub import AudioSegment
                    import io
                    
                    audio_segment = AudioSegment.from_file(io.BytesIO(audio_data), format="webm")
                    
                    if audio_segment.channels != 1 or audio_segment.frame_rate != 16000:
                        audio_segment = audio_segment.set_channels(1).set_frame_rate(16000).set_sample_width(2)
                    
                    wav_buffer = io.BytesIO()
                    audio_segment.export(wav_buffer, format="wav")
                    wav_data = wav_buffer.getvalue()
                    
                    print(f"[DEBUG] Fast WebM conversion completed, size: {len(wav_data)} bytes")
                    return wav_data
                except Exception as e:
                    print(f"[DEBUG] WebM conversion failed: {e}, using original")
                    return audio_data
            
            if (b'ftyp' in audio_data[:50] or b'moov' in audio_data[:50] or 
                'mp4' in mime_type.lower() or 'mov' in mime_type.lower()):
                print(f"[DEBUG] Detected MP4/MOV container format (mimeType: {mime_type})")
                try:
                    print("[DEBUG] Attempting to process MP4 audio with pydub...")
                    from pydub import AudioSegment
                    import io
                    
                    audio_segment = AudioSegment.from_file(io.BytesIO(audio_data), format="mp4")
                    
                    print(f"[DEBUG] Original audio - Duration: {len(audio_segment)}ms, Channels: {audio_segment.channels}, Sample Rate: {audio_segment.frame_rate}Hz")
                    
                    if len(audio_segment) < 100:  # Less than 100ms
                        print(f"[DEBUG] Audio too short ({len(audio_segment)}ms), skipping")
                        return audio_data
                    
                    if audio_segment.channels != 1 or audio_segment.frame_rate != 16000:
                        audio_segment = audio_segment.set_channels(1).set_frame_rate(16000).set_sample_width(2)
                    
                    if audio_segment.max_possible_amplitude > 0 and audio_segment.rms < 1000:
                        audio_segment = audio_segment.normalize()
                    
                    wav_buffer = io.BytesIO()
                    audio_segment.export(wav_buffer, format="wav")
                    wav_data = wav_buffer.getvalue()
                    
                    print(f"[DEBUG] Successfully converted MP4 to WAV, size: {len(wav_data)} bytes")
                    print(f"[DEBUG] WAV header check: {wav_data[:12].hex()}")
                    
                    if len(wav_data) < 1000:
                        print(f"[DEBUG] Converted WAV too small ({len(wav_data)} bytes), generating test tone")
                        import wave
                        import struct
                        import math
                        
                        sample_rate = 16000
                        duration = 1.0
                        frequency = 440
                        
                        wav_buffer = io.BytesIO()
                        with wave.open(wav_buffer, 'wb') as wav_file:
                            wav_file.setnchannels(1)
                            wav_file.setsampwidth(2)
                            wav_file.setframerate(sample_rate)
                            
                            for i in range(int(sample_rate * duration)):
                                value = int(16384 * math.sin(2 * math.pi * frequency * i / sample_rate) * 0.1)
                                wav_file.writeframes(struct.pack('<h', value))
                        
                        return wav_buffer.getvalue()
                    
                    return wav_data
                    
                except Exception as e:
                    print(f"[DEBUG] MP4 conversion failed: {e}")
                    import traceback
                    print(f"[DEBUG] MP4 conversion traceback: {traceback.format_exc()}")
                    print("[DEBUG] Generating fallback test audio")
                    
                    import wave
                    import struct
                    import math
                    import io
                    
                    sample_rate = 16000
                    duration = 1.0
                    frequency = 440
                    
                    wav_buffer = io.BytesIO()
                    with wave.open(wav_buffer, 'wb') as wav_file:
                        wav_file.setnchannels(1)
                        wav_file.setsampwidth(2)
                        wav_file.setframerate(sample_rate)
                        
                        for i in range(int(sample_rate * duration)):
                            value = int(16384 * math.sin(2 * math.pi * frequency * i / sample_rate) * 0.1)
                            wav_file.writeframes(struct.pack('<h', value))
                    
                    return wav_buffer.getvalue()
            
            sample_rate = 16000
            bits_per_sample = 16
            channels = 1
            
            if len(audio_data) > 44:
                print("[DEBUG] Converting raw audio data to WAV format")
                
                wav_header = bytearray()
                wav_header.extend(b'RIFF')
                wav_header.extend((len(audio_data) + 36).to_bytes(4, 'little'))
                wav_header.extend(b'WAVE')
                wav_header.extend(b'fmt ')
                wav_header.extend((16).to_bytes(4, 'little'))
                wav_header.extend((1).to_bytes(2, 'little'))
                wav_header.extend(channels.to_bytes(2, 'little'))
                wav_header.extend(sample_rate.to_bytes(4, 'little'))
                wav_header.extend((sample_rate * channels * bits_per_sample // 8).to_bytes(4, 'little'))
                wav_header.extend((channels * bits_per_sample // 8).to_bytes(2, 'little'))
                wav_header.extend(bits_per_sample.to_bytes(2, 'little'))
                wav_header.extend(b'data')
                wav_header.extend(len(audio_data).to_bytes(4, 'little'))
                
                wav_data = bytes(wav_header) + audio_data
                print(f"[DEBUG] Created WAV with header, total size: {len(wav_data)} bytes")
                return wav_data
            else:
                print("[DEBUG] Audio data too small for conversion, generating test tone")
                import wave
                import struct
                import math
                import io
                
                sample_rate = 16000
                duration = 1.0
                frequency = 440
                
                wav_buffer = io.BytesIO()
                with wave.open(wav_buffer, 'wb') as wav_file:
                    wav_file.setnchannels(1)
                    wav_file.setsampwidth(2)
                    wav_file.setframerate(sample_rate)
                    
                    for i in range(int(sample_rate * duration)):
                        value = int(16384 * math.sin(2 * math.pi * frequency * i / sample_rate) * 0.1)
                        wav_file.writeframes(struct.pack('<h', value))
                
                return wav_buffer.getvalue()
                
        except Exception as e:
            print(f"[DEBUG] Error converting audio to WAV: {e}")
            print("[DEBUG] Generating fallback test audio")
            
            import wave
            import struct
            import math
            import io
            
            sample_rate = 16000
            duration = 1.0
            frequency = 440
            
            wav_buffer = io.BytesIO()
            with wave.open(wav_buffer, 'wb') as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(sample_rate)
                
                for i in range(int(sample_rate * duration)):
                    value = int(16384 * math.sin(2 * math.pi * frequency * i / sample_rate) * 0.1)
                    wav_file.writeframes(struct.pack('<h', value))
            
            return wav_buffer.getvalue()
    
    async def measure_deepl_latency(self, text: str, source_lang: str, target_lang: str) -> tuple:
        start_time = time.time()
        try:
            deepl_source_map = {
                "en": "EN",
                "ja": "JA", 
                "es": "ES",
                "fr": "FR",
                "de": "DE",
                "zh": "ZH"
            }
            
            deepl_target_map = {
                "en": "EN-US",
                "ja": "JA", 
                "es": "ES",
                "fr": "FR",
                "de": "DE",
                "zh": "ZH"
            }
            
            deepl_source = deepl_source_map.get(source_lang, source_lang.upper())
            deepl_target = deepl_target_map.get(target_lang, target_lang.upper())
            
            print(f"[DEBUG] DeepL translation: '{text}' from {source_lang} ({deepl_source}) to {target_lang} ({deepl_target})")
            
            max_retries = 3
            for attempt in range(max_retries):
                try:
                    result = await asyncio.to_thread(
                        deepl_translator.translate_text,
                        text, 
                        source_lang=deepl_source, 
                        target_lang=deepl_target
                    )
                    
                    end_time = time.time()
                    self.latency_metrics["deepl"] = (end_time - start_time) * 1000
                    print(f"[DEBUG] DeepL result: '{result.text}', latency: {self.latency_metrics['deepl']}ms")
                    
                    return result.text, self.latency_metrics["deepl"]
                    
                except Exception as retry_error:
                    print(f"[WARNING] DeepL translation attempt {attempt + 1} failed: {retry_error}")
                    print(f"[DEBUG] Failed translation details - Text: '{text}', Source: {source_lang} ({deepl_source}), Target: {target_lang} ({deepl_target})")
                    if attempt == max_retries - 1:
                        raise
                    await asyncio.sleep(0.5)  # Brief delay before retry
                    
        except Exception as e:
            print(f"[ERROR] DeepL translation failed after all retries: {e}")
            print(f"[DEBUG] DeepL error type: {type(e)}")
            print(f"[DEBUG] Final failed translation details - Text: '{text}', Source: {source_lang}, Target: {target_lang}")
            import traceback
            print(f"[DEBUG] DeepL traceback: {traceback.format_exc()}")
            end_time = time.time()
            self.latency_metrics["deepl"] = (end_time - start_time) * 1000
            return text, self.latency_metrics["deepl"]  # Return original text on error
    
    async def measure_azure_tts_latency(self, text: str, language: str, voice: str) -> tuple:
        start_time = time.time()
        try:
            if not text or not text.strip():
                print("[DEBUG] Empty text provided to TTS")
                return b"", 0
            
            try:
                azure_key = os.getenv('AZURE_SPEECH_KEY', '')
                azure_region = os.getenv('AZURE_SPEECH_REGION', '')
                
                print(f"[DEBUG] Azure Speech Key: {azure_key[:20]}...")
                print(f"[DEBUG] Azure Speech Region: {azure_region}")
                print(f"[DEBUG] TTS Language: {language}, Voice: {voice}")
                
                fresh_speech_config = speechsdk.SpeechConfig(
                    subscription=azure_key,
                    region=azure_region
                )
                fresh_speech_config.speech_synthesis_voice_name = voice
                fresh_speech_config.set_speech_synthesis_output_format(speechsdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm)
                
                synthesizer = speechsdk.SpeechSynthesizer(speech_config=fresh_speech_config, audio_config=None)
                result = synthesizer.speak_text_async(text).get()
                
                print(f"[DEBUG] Azure TTS result reason: {result.reason}")
                
                if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
                    end_time = time.time()
                    self.latency_metrics["azure_tts"] = (end_time - start_time) * 1000
                    print(f"[DEBUG] Azure TTS success: {len(result.audio_data)} bytes generated")
                    return result.audio_data, self.latency_metrics["azure_tts"]
                else:
                    print(f"[DEBUG] Azure TTS failed: {result.reason}, falling back to espeak")
                    if result.reason == speechsdk.ResultReason.Canceled:
                        cancellation_details = result.cancellation_details
                        print(f"[DEBUG] Cancellation reason: {cancellation_details.reason}")
                        print(f"[DEBUG] Error details: {cancellation_details.error_details}")
                        if cancellation_details.reason == speechsdk.CancellationReason.Error:
                            print(f"[DEBUG] Error code: {cancellation_details.error_code}")
                    raise Exception("Azure TTS failed")
            except Exception as azure_error:
                print(f"[DEBUG] Azure TTS error: {azure_error}, using fallback TTS")
                
                try:
                    print("[DEBUG] Using espeak directly as fallback TTS")
                    
                    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as temp_file:
                        temp_filename = temp_file.name
                    print(f"[DEBUG] Temp file created: {temp_filename}")
                    
                    import subprocess
                    espeak_cmd = [
                        'espeak', 
                        '-s', '150',  # speed
                        '-a', '100',  # amplitude
                        '-w', temp_filename,  # write to file
                        text
                    ]
                    
                    print(f"[DEBUG] Running espeak command: {' '.join(espeak_cmd)}")
                    result = subprocess.run(espeak_cmd, capture_output=True, text=True)
                    
                    if result.returncode != 0:
                        print(f"[DEBUG] Espeak failed: {result.stderr}")
                        raise Exception(f"Espeak failed: {result.stderr}")
                    
                    print("[DEBUG] Espeak completed successfully")
                    
                    if not os.path.exists(temp_filename):
                        print("[DEBUG] Temp file was not created")
                        raise Exception("Audio file not created")
                    
                    with open(temp_filename, 'rb') as audio_file:
                        audio_data = audio_file.read()
                    print(f"[DEBUG] Read {len(audio_data)} bytes from temp file")
                    
                    os.unlink(temp_filename)
                    print("[DEBUG] Temp file deleted")
                    
                    if len(audio_data) == 0:
                        print("[DEBUG] Generated audio file is empty")
                        raise Exception("Generated audio is empty")
                    
                    end_time = time.time()
                    self.latency_metrics["azure_tts"] = (end_time - start_time) * 1000
                    print(f"[DEBUG] Fallback TTS success: {len(audio_data)} bytes generated")
                    return audio_data, self.latency_metrics["azure_tts"]
                    
                except Exception as fallback_error:
                    print(f"[DEBUG] Fallback TTS error: {fallback_error}")
                    end_time = time.time()
                    self.latency_metrics["azure_tts"] = (end_time - start_time) * 1000
                    return b"", self.latency_metrics["azure_tts"]
                
        except Exception as e:
            print(f"[DEBUG] TTS exception: {e}")
            end_time = time.time()
            self.latency_metrics["azure_tts"] = (end_time - start_time) * 1000
            return b"", self.latency_metrics["azure_tts"]

translation_service = TranslationService()

@app.get("/health")
async def health_check():
    """Health check endpoint with detailed status"""
    health_status = {
        "status": "healthy",
        "timestamp": time.time(),
        "version": "1.0.0",
        "environment": os.getenv("ENVIRONMENT", "development"),
        "services": {
            "deepgram": bool(translation_service.deepgram_api_key),
            "deepl": bool(translation_service.deepl_api_key),
            "azure_speech": bool(translation_service.azure_speech_key),
        },
        "azure": {
            "key_vault_enabled": AZURE_AVAILABLE and bool(os.getenv("AZURE_KEY_VAULT_URL")),
            "region": translation_service.azure_speech_region,
        },
        "performance": {
            "active_connections": len(rooms.get("default", [])),
            "rooms": list(rooms.keys()),
        }
    }
    
    if not all(health_status["services"].values()):
        health_status["status"] = "degraded"
        health_status["warnings"] = []
        for service, configured in health_status["services"].items():
            if not configured:
                health_status["warnings"].append(f"{service} API key not configured")
    
    return health_status

@app.get("/healthz")
async def healthz():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

@app.get("/api/latency")
async def get_latency():
    return translation_service.latency_metrics

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    await websocket.accept()
    
    if room_id not in rooms:
        rooms[room_id] = []
    rooms[room_id].append(websocket)
    
    print(f"[DEBUG] WebSocket connected to room {room_id}, total connections: {len(rooms[room_id])}")
    print(f"[DEBUG] WebSocket ID: {id(websocket)}")
    
    user_languages[websocket] = {
        "language": "en"
    }
    
    room_users = rooms.get(room_id, [])
    user_langs = [user_languages.get(client, {}).get("language", "en") for client in room_users]
    for client in room_users:
        try:
            await client.send_text(json.dumps({
                "type": "room_status",
                "connected_users": len(room_users),
                "user_languages": user_langs
            }))
        except:
            pass
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            message_type = message.get('type', 'unknown')
            
            if message_type == "heartbeat":
                if websocket.client_state.value == 1:
                    await websocket.send_text(json.dumps({"type": "heartbeat_ack"}))
                continue
            
            if message_type == "language_config":
                old_language = user_languages.get(websocket, {}).get("language", None)
                
                user_languages[websocket] = {
                    "language": message["language"]
                }
                
                print(f"[DEBUG] Language changed from {old_language} to {message['language']} for websocket {id(websocket)}")
                
                await websocket.send_text(json.dumps({
                    "type": "language_config_updated",
                    "language": message["language"],
                    "previous_language": old_language
                }))
                
                room_users = rooms.get(room_id, [])
                active_clients = []
                clients_to_remove = []
                
                for client in room_users:
                    try:
                        if client.client_state.value == 1:
                            active_clients.append(client)
                        else:
                            clients_to_remove.append(client)
                    except Exception as e:
                        print(f"[DEBUG] Client state check failed: {e}")
                        clients_to_remove.append(client)
                
                for client in clients_to_remove:
                    if client in rooms.get(room_id, []):
                        rooms[room_id].remove(client)
                    if client in user_languages:
                        del user_languages[client]
                
                user_langs = [user_languages.get(client, {}).get("language", "en") for client in active_clients]
                
                for client in active_clients:
                    try:
                        await client.send_text(json.dumps({
                            "type": "room_status",
                            "connected_users": len(active_clients),
                            "user_languages": user_langs
                        }))
                    except Exception as e:
                        print(f"[DEBUG] Failed to send room status to client: {e}")
            
            elif message["type"] == "audio_data":
                print(f"[DEBUG] Received audio_data message")
                try:
                    if "audio" not in message:
                        print(f"[DEBUG] ERROR: No audio field in message")
                        await websocket.send_text(json.dumps({
                            "type": "error",
                            "message": "No audio data received"
                        }))
                        continue
                    
                    audio_data = base64.b64decode(message["audio"])
                    mime_type = message.get("mimeType", "unknown")
                    user_lang = user_languages[websocket]["language"]
                    print(f"[DEBUG] Audio data size: {len(audio_data)} bytes, mimeType: {mime_type}, user language: {user_lang}")
                    
                    if len(audio_data) == 0:
                        print(f"[DEBUG] ERROR: Empty audio data")
                        await websocket.send_text(json.dumps({
                            "type": "error", 
                            "message": "Empty audio data received"
                        }))
                        continue
                    
                    print(f"[DEBUG] Calling Deepgram STT service...")
                    transcript, deepgram_latency = await translation_service.measure_deepgram_latency(
                        audio_data, user_lang, mime_type
                    )
                    print(f"[DEBUG] Deepgram transcript: '{transcript}', latency: {deepgram_latency}ms")
                    
                    print(f"[DEBUG] Sending transcript to client: '{transcript}'")
                    await websocket.send_text(json.dumps({
                        "type": "transcript",
                        "text": transcript if transcript else ""
                    }))
                    print(f"[DEBUG] Successfully sent transcript to client: '{transcript}'")
                    
                    if transcript and transcript.strip():
                        room_clients = rooms.get(room_id, [])
                        print(f"[DEBUG] Room has {len(room_clients)} clients, processing transcript: '{transcript}'")
                        
                        for other_ws in room_clients:
                            if other_ws != websocket and other_ws in user_languages:
                                other_lang = user_languages[other_ws]["language"]
                                print(f"[DEBUG] Processing for other user with language: {other_lang}")
                                
                                if other_lang != user_lang:
                                    max_retries = 3
                                    retry_count = 0
                                    translated_text = None
                                    
                                    while retry_count < max_retries and not translated_text:
                                        try:
                                            translated_text, deepl_latency = await translation_service.measure_deepl_latency(
                                                transcript, user_lang, other_lang
                                            )
                                            print(f"[DEBUG] DeepL translation ({user_lang}→{other_lang}): '{translated_text}', latency: {deepl_latency}ms, attempt: {retry_count + 1}")
                                            
                                            if not translated_text or not translated_text.strip():
                                                retry_count += 1
                                                if retry_count < max_retries:
                                                    print(f"[DEBUG] Empty translation result, retrying... ({retry_count}/{max_retries})")
                                                    await asyncio.sleep(0.1)
                                                continue
                                            break
                                        except Exception as deepl_error:
                                            retry_count += 1
                                            print(f"[ERROR] DeepL translation failed (attempt {retry_count}/{max_retries}): {deepl_error}")
                                            if retry_count < max_retries:
                                                await asyncio.sleep(0.2)
                                    
                                    if translated_text and translated_text.strip():
                                        voice_map = {
                                            "en": "en-US-JennyNeural",
                                            "ja": "ja-JP-NanamiNeural",
                                            "es": "es-ES-ElviraNeural",
                                            "fr": "fr-FR-DeniseNeural",
                                            "de": "de-DE-KatjaNeural",
                                            "zh": "zh-CN-XiaoxiaoNeural"
                                        }
                                        
                                        try:
                                            audio_output, azure_latency = await translation_service.measure_azure_tts_latency(
                                                translated_text, other_lang, voice_map.get(other_lang, "en-US-JennyNeural")
                                            )
                                            print(f"[DEBUG] Azure TTS audio size: {len(audio_output)} bytes, latency: {azure_latency}ms")
                                            
                                            if audio_output and len(audio_output) > 0:
                                                hex_audio = audio_output.hex()
                                                print(f"[DEBUG] Sending translated audio to other user, hex length: {len(hex_audio)}")
                                                
                                                try:
                                                    if other_ws.client_state.value == 1:  # CONNECTED state
                                                        await other_ws.send_text(json.dumps({
                                                            "type": "translated_audio",
                                                            "audio": hex_audio,
                                                            "original_text": transcript,
                                                            "translated_text": translated_text,
                                                            "original_language": user_lang,
                                                            "translated_language": other_lang
                                                        }))
                                                        print(f"[DEBUG] Successfully sent translated audio ({user_lang}→{other_lang})")
                                                    else:
                                                        print(f"[WARNING] WebSocket not in connected state, skipping audio transmission")
                                                except Exception as send_error:
                                                    print(f"[ERROR] Failed to send translated audio to client: {send_error}")
                                                    print(f"[DEBUG] Error details - Original: {user_lang}, Target: {other_lang}, Text: '{translated_text[:50]}...'")
                                            else:
                                                print(f"[ERROR] Azure TTS failed to generate audio for: '{translated_text}'")
                                        except Exception as tts_error:
                                            print(f"[ERROR] Azure TTS processing failed: {tts_error}")
                                    else:
                                        print(f"[ERROR] DeepL translation failed after {max_retries} attempts ({user_lang}→{other_lang}): '{transcript}'")
                except Exception as e:
                    print(f"[DEBUG] ERROR in audio_data processing: {e}")
                    print(f"[DEBUG] Exception type: {type(e).__name__}")
                    import traceback
                    print(f"[DEBUG] Full traceback: {traceback.format_exc()}")
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": f"Audio processing error: {str(e)}"
                    }))
            
            elif message["type"] == "request_latency":
                await websocket.send_text(json.dumps({
                    "type": "latency_update",
                    "metrics": translation_service.latency_metrics
                }))
            
            elif message["type"] == "request_room_status":
                room_users = rooms.get(room_id, [])
                user_langs = [user_languages.get(client, {}).get("language", "en") for client in room_users]
                await websocket.send_text(json.dumps({
                    "type": "room_status",
                    "connected_users": len(room_users),
                    "user_languages": user_langs
                }))
            
            elif message["type"] == "request_test_audio":
                user_lang = user_languages[websocket]["language"]
                test_text = "Audio test successful. Translation pipeline is working."
                print(f"[DEBUG] Test audio requested for language: {user_lang}")
                
                dummy_audio = b'dummy_audio_data_for_testing' * 20
                _, stt_latency = await translation_service.measure_deepgram_latency(dummy_audio, user_lang)
                print(f"[DEBUG] STT test completed for latency metrics: {stt_latency}ms")
                
                voice_map = {
                    "en": "en-US-JennyNeural",
                    "ja": "ja-JP-NanamiNeural",
                    "es": "es-ES-ElviraNeural",
                    "fr": "fr-FR-DeniseNeural",
                    "de": "de-DE-KatjaNeural",
                    "zh": "zh-CN-XiaoxiaoNeural"
                }
                
                audio_output, _ = await translation_service.measure_azure_tts_latency(
                    test_text, user_lang, voice_map.get(user_lang, "en-US-JennyNeural")
                )
                print(f"[DEBUG] Test audio generated, size: {len(audio_output)} bytes")
                
                hex_audio = audio_output.hex() if audio_output else ""
                print(f"[DEBUG] Hex audio length: {len(hex_audio)}")
                print(f"[DEBUG] First 100 chars of hex: {hex_audio[:100]}")
                
                message = {
                    "type": "test_audio",
                    "audio": hex_audio,
                    "text": test_text
                }
                print(f"[DEBUG] Message before JSON: audio field length = {len(message['audio'])}")
                
                json_message = json.dumps(message)
                print(f"[DEBUG] JSON message length: {len(json_message)}")
                print(f"[DEBUG] JSON message preview: {json_message[:200]}...")
                
                await websocket.send_text(json_message)
                print(f"[DEBUG] Test audio sent to client (hex length: {len(hex_audio)})")
            
            elif message["type"] == "test_deepgram_stt":
                print(f"[DEBUG] Individual Deepgram STT test requested")
                test_start_time = message.get("test_start_time", time.time() * 1000)
                chained_test = message.get("chained_test", False)
                
                if "audio" in message:
                    audio_data = base64.b64decode(message["audio"])
                    mime_type = message.get("mimeType", "unknown")
                    user_lang = user_languages[websocket]["language"]
                    print(f"[DEBUG] STT Test - User language: {user_lang}, audio data size: {len(audio_data)} bytes, chained: {chained_test}")
                    
                    transcript, deepgram_latency = await translation_service.measure_deepgram_latency(
                        audio_data, user_lang, mime_type
                    )
                    print(f"[DEBUG] STT Test - Deepgram transcript: '{transcript}', latency: {deepgram_latency}ms")
                else:
                    print(f"[DEBUG] STT Test - Using synthetic speech audio for latency measurement")
                    user_lang = user_languages[websocket]["language"]
                    
                    test_text = "Hello, this is a test of the speech transcription system."
                    voice_map = {
                        "en": "en-US-JennyNeural",
                        "ja": "ja-JP-NanamiNeural",
                        "es": "es-ES-ElviraNeural",
                        "fr": "fr-FR-DeniseNeural",
                        "de": "de-DE-KatjaNeural",
                        "zh": "zh-CN-XiaoxiaoNeural"
                    }
                    
                    print(f"[DEBUG] Generating synthetic speech: '{test_text}' in {user_lang}")
                    test_audio, _ = await translation_service.measure_azure_tts_latency(
                        test_text, user_lang, voice_map.get(user_lang, "en-US-JennyNeural")
                    )
                    print(f"[DEBUG] Generated synthetic speech audio: {len(test_audio)} bytes")
                    
                    transcript, deepgram_latency = await translation_service.measure_deepgram_latency(
                        test_audio, user_lang
                    )
                    print(f"[DEBUG] STT Test - Synthetic speech transcript: '{transcript}', latency: {deepgram_latency}ms")
                
                total_time = time.time() * 1000 - test_start_time
                
                await websocket.send_text(json.dumps({
                    "type": "test_result",
                    "service": "deepgram_stt",
                    "success": bool(transcript and transcript.strip()),
                    "result": transcript,
                    "latency": deepgram_latency,
                    "total_time": total_time,
                    "chained_test": chained_test,
                    "message": f"STT Result: '{transcript}'" if transcript else "STT failed - no transcript"
                }))
            
            elif message["type"] == "test_deepl_translation":
                print(f"[DEBUG] Individual DeepL translation test requested")
                test_start_time = message.get("test_start_time", time.time() * 1000)
                chained_test = message.get("chained_test", False)
                text = message["text"]
                source_lang = message["source_language"]
                target_lang = message["target_language"]
                print(f"[DEBUG] Translation Test - Text: '{text}', {source_lang} -> {target_lang}, chained: {chained_test}")
                
                translated_text, deepl_latency = await translation_service.measure_deepl_latency(
                    text, source_lang, target_lang
                )
                print(f"[DEBUG] Translation Test - Result: '{translated_text}', latency: {deepl_latency}ms")
                
                total_time = time.time() * 1000 - test_start_time
                
                await websocket.send_text(json.dumps({
                    "type": "test_result",
                    "service": "deepl_translation",
                    "success": bool(translated_text and translated_text.strip()),
                    "result": translated_text,
                    "latency": deepl_latency,
                    "total_time": total_time,
                    "chained_test": chained_test,
                    "message": f"Translation: '{text}' -> '{translated_text}'"
                }))
            
            elif message["type"] == "test_azure_tts":
                print(f"[DEBUG] Individual Azure TTS test requested")
                test_start_time = message.get("test_start_time", time.time() * 1000)
                chained_test = message.get("chained_test", False)
                text = message["text"]
                user_lang = message["language"]
                print(f"[DEBUG] TTS Test - Text: '{text}', language: {user_lang}, chained: {chained_test}")
                
                voice_map = {
                    "en": "en-US-JennyNeural",
                    "ja": "ja-JP-NanamiNeural",
                    "es": "es-ES-ElviraNeural",
                    "fr": "fr-FR-DeniseNeural",
                    "de": "de-DE-KatjaNeural",
                    "zh": "zh-CN-XiaoxiaoNeural"
                }
                
                audio_output, azure_latency = await translation_service.measure_azure_tts_latency(
                    text, user_lang, voice_map.get(user_lang, "en-US-JennyNeural")
                )
                print(f"[DEBUG] TTS Test - Audio size: {len(audio_output)} bytes, latency: {azure_latency}ms")
                
                total_time = time.time() * 1000 - test_start_time
                hex_audio = audio_output.hex() if audio_output else ""
                
                await websocket.send_text(json.dumps({
                    "type": "test_result",
                    "service": "azure_tts",
                    "success": bool(audio_output and len(audio_output) > 0),
                    "result": hex_audio,
                    "latency": azure_latency,
                    "total_time": total_time,
                    "chained_test": chained_test,
                    "message": f"TTS generated {len(audio_output)} bytes" if audio_output else "TTS failed - no audio generated",
                    "audio": hex_audio
                }))
            
            elif message["type"] == "test_transcription_fallback":
                print(f"[DEBUG] Transcription fallback requested")
                fallback_text = message["text"]
                user_lang = message["language"]
                print(f"[DEBUG] Fallback text: '{fallback_text}', language: {user_lang}")
                
                await websocket.send_text(json.dumps({
                    "type": "transcript",
                    "text": fallback_text
                }))
                
                if fallback_text and fallback_text.strip():
                    room_clients = rooms.get(room_id, [])
                    for other_ws in room_clients:
                        if other_ws != websocket and other_ws in user_languages:
                            other_lang = user_languages[other_ws]["language"]
                            if other_lang != user_lang:
                                translated_text, _ = await translation_service.measure_deepl_latency(
                                    fallback_text, user_lang, other_lang
                                )
                                if translated_text:
                                    try:
                                        if other_ws.client_state.value == 1:
                                            await other_ws.send_text(json.dumps({
                                                "type": "transcript",
                                                "text": f"[Translated] {translated_text}"
                                            }))
                                    except Exception as e:
                                        print(f"[DEBUG] Failed to send translated transcript: {e}")
    
    except WebSocketDisconnect:
        print(f"[INFO] WebSocket disconnected")
    except Exception as e:
        print(f"[ERROR] WebSocket error: {e}")
    finally:
        try:
            if websocket in user_languages:
                user_lang = user_languages[websocket].get("language", "unknown")
                del user_languages[websocket]
                print(f"[DEBUG] Cleaned up language config for {user_lang} client")
            
            if room_id in rooms and websocket in rooms[room_id]:
                rooms[room_id].remove(websocket)
                print(f"[INFO] Removed client from room: {room_id}")
                
                if rooms[room_id]:
                    room_users = rooms[room_id]
                    user_langs = [user_languages.get(client, {}).get("language", "en") for client in room_users]
                    clients_to_remove = []
                    
                    for client in room_users:
                        try:
                            if client.client_state.value == 1:
                                await client.send_text(json.dumps({
                                    "type": "room_status",
                                    "connected_users": len(room_users),
                                    "user_languages": user_langs
                                }))
                        except Exception as e:
                            print(f"[DEBUG] Failed to send room status to client: {e}")
                            clients_to_remove.append(client)
                    
                    for client in clients_to_remove:
                        if client in rooms.get(room_id, []):
                            rooms[room_id].remove(client)
                        if client in user_languages:
                            del user_languages[client]
                else:
                    del rooms[room_id]
                    print(f"[DEBUG] Cleaned up empty room: {room_id}")
            
            print(f"[INFO] WebSocket connection closed and cleaned up")
        except Exception as cleanup_error:
            print(f"[ERROR] Error during cleanup: {cleanup_error}")
