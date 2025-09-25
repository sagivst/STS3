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

load_dotenv()

from deepgram import DeepgramClient, PrerecordedOptions, LiveTranscriptionEvents, LiveOptions
import deepl
import azure.cognitiveservices.speech as speechsdk
import pyttsx3
import io
import wave

app = FastAPI()

# Disable CORS. Do not remove this for full-stack development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allows all methods
    allow_headers=["*"],  # Allows all headers
)

rooms: Dict[str, List[WebSocket]] = {}
user_languages: Dict[WebSocket, Dict[str, str]] = {}

deepgram_client = DeepgramClient(os.getenv("DEEPGRAM_API_KEY", ""))
deepl_translator = deepl.Translator(os.getenv("DEEPL_API_KEY", ""))

speech_config = speechsdk.SpeechConfig(
    subscription=os.getenv("AZURE_SPEECH_KEY", ""),
    region=os.getenv("AZURE_SPEECH_REGION", "")
)

class TranslationService:
    def __init__(self):
        self.latency_metrics = {
            "deepgram": 0.0,
            "deepl": 0.0,
            "azure_tts": 0.0
        }
    
    async def measure_deepgram_latency(self, audio_data: bytes, language: str) -> tuple:
        start_time = time.time()
        try:
            if len(audio_data) < 1000:
                print(f"[DEBUG] Audio data too small: {len(audio_data)} bytes")
                return "", 0
                
            options = PrerecordedOptions(
                model="nova-2",
                language=language,
                smart_format=True,
            )
            
            response = deepgram_client.listen.prerecorded.v("1").transcribe_file(
                {"buffer": audio_data, "mimetype": "audio/webm"}, options
            )
            
            end_time = time.time()
            self.latency_metrics["deepgram"] = (end_time - start_time) * 1000
            
            if response.results and response.results.channels and len(response.results.channels) > 0:
                if response.results.channels[0].alternatives and len(response.results.channels[0].alternatives) > 0:
                    transcript = response.results.channels[0].alternatives[0].transcript
                    return transcript, self.latency_metrics["deepgram"]
            
            print("[DEBUG] No transcript found in Deepgram response")
            return "", self.latency_metrics["deepgram"]
        except Exception as e:
            print(f"[DEBUG] Deepgram error: {e}")
            return "", 0
    
    async def measure_deepl_latency(self, text: str, source_lang: str, target_lang: str) -> tuple:
        start_time = time.time()
        try:
            result = deepl_translator.translate_text(
                text, 
                source_lang=source_lang, 
                target_lang=target_lang
            )
            end_time = time.time()
            self.latency_metrics["deepl"] = (end_time - start_time) * 1000
            
            return result.text, self.latency_metrics["deepl"]
        except Exception as e:
            print(f"DeepL error: {e}")
            return text, 0
    
    async def measure_azure_tts_latency(self, text: str, language: str, voice: str) -> tuple:
        start_time = time.time()
        try:
            if not text or not text.strip():
                print("[DEBUG] Empty text provided to TTS")
                return b"", 0
            
            try:
                speech_config.speech_synthesis_language = language
                speech_config.speech_synthesis_voice_name = voice
                speech_config.set_speech_synthesis_output_format(speechsdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm)
                
                synthesizer = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=None)
                result = synthesizer.speak_text_async(text).get()
                
                if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
                    end_time = time.time()
                    self.latency_metrics["azure_tts"] = (end_time - start_time) * 1000
                    print(f"[DEBUG] Azure TTS success: {len(result.audio_data)} bytes generated")
                    return result.audio_data, self.latency_metrics["azure_tts"]
                else:
                    print(f"[DEBUG] Azure TTS failed: {result.reason}, falling back to pyttsx3")
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
            
            if message["type"] == "language_config":
                user_languages[websocket] = {
                    "language": message["language"]
                }
                await websocket.send_text(json.dumps({
                    "type": "language_config_updated",
                    "language": message["language"]
                }))
                
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
            
            elif message["type"] == "audio_data":
                print(f"[DEBUG] Received audio data, size: {len(message.get('audio', ''))}")
                audio_data = base64.b64decode(message["audio"])
                user_lang = user_languages[websocket]["language"]
                print(f"[DEBUG] User language: {user_lang}, audio data size: {len(audio_data)} bytes")
                
                target_lang = "ja" if user_lang == "en" else "en"
                
                transcript, deepgram_latency = await translation_service.measure_deepgram_latency(
                    audio_data, user_lang
                )
                print(f"[DEBUG] Deepgram transcript: '{transcript}', latency: {deepgram_latency}ms")
                
                if transcript and transcript.strip():
                    await websocket.send_text(json.dumps({
                        "type": "transcript",
                        "text": transcript,
                        "language": user_lang
                    }))
                    print(f"[DEBUG] Sent transcript to client: '{transcript}'")
                    
                    translated_text, deepl_latency = await translation_service.measure_deepl_latency(
                        transcript, user_lang, target_lang
                    )
                    print(f"[DEBUG] DeepL translation: '{translated_text}', latency: {deepl_latency}ms")
                    
                    voice_map = {
                        "en": "en-US-JennyNeural",
                        "ja": "ja-JP-NanamiNeural",
                        "es": "es-ES-ElviraNeural",
                        "fr": "fr-FR-DeniseNeural",
                        "de": "de-DE-KatjaNeural",
                        "zh": "zh-CN-XiaoxiaoNeural"
                    }
                    
                    room_clients = rooms[room_id]
                    print(f"[DEBUG] Room has {len(room_clients)} clients, sending to {len(room_clients)-1} other clients")
                    
                    for client in room_clients:
                        if client != websocket:
                            try:
                                client_lang = user_languages.get(client, {}).get("language", "en")
                                print(f"[DEBUG] Generating audio for client in language: {client_lang}")
                                
                                audio_output, azure_latency = await translation_service.measure_azure_tts_latency(
                                    translated_text, client_lang, voice_map.get(client_lang, "en-US-JennyNeural")
                                )
                                print(f"[DEBUG] Azure TTS audio size: {len(audio_output)} bytes, latency: {azure_latency}ms")
                                
                                await client.send_text(json.dumps({
                                    "type": "translated_audio",
                                    "audio": audio_output.hex() if audio_output else "",
                                    "text": translated_text,
                                    "source_language": user_lang,
                                    "target_language": client_lang
                                }))
                                print(f"[DEBUG] Sent translated audio to client (hex length: {len(audio_output.hex()) if audio_output else 0})")
                            except Exception as e:
                                print(f"[DEBUG] Error sending to client: {e}")
                else:
                    print("[DEBUG] No transcript received from Deepgram or transcript is empty")
            
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
    
    except WebSocketDisconnect:
        if room_id in rooms:
            rooms[room_id].remove(websocket)
            
            if rooms[room_id]:
                room_users = rooms[room_id]
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
            else:
                del rooms[room_id]
        
        if websocket in user_languages:
            del user_languages[websocket]
