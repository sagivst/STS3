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
            print(f"[DEBUG] Deepgram STT - Audio data size: {len(audio_data)} bytes")
            print(f"[DEBUG] Deepgram STT - Language: {language}")
            print(f"[DEBUG] Deepgram STT - First 50 bytes: {audio_data[:50].hex()}")
            
            if len(audio_data) < 1000:
                print(f"[DEBUG] Audio data too small: {len(audio_data)} bytes")
                return "", 0
                
            options = PrerecordedOptions(
                model="nova-2",
                language=language,
                smart_format=True,
            )
            
            print(f"[DEBUG] Deepgram STT - Sending request with mimetype: audio/webm")
            response = deepgram_client.listen.prerecorded.v("1").transcribe_file(
                {"buffer": audio_data, "mimetype": "audio/webm"}, options
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
                print(f"[DEBUG] Received audio_data message")
                try:
                    audio_data = base64.b64decode(message["audio"])
                    user_lang = user_languages[websocket]["language"]
                    print(f"[DEBUG] Audio data size: {len(audio_data)} bytes, user language: {user_lang}")
                    
                    transcript, deepgram_latency = await translation_service.measure_deepgram_latency(
                        audio_data, user_lang
                    )
                    print(f"[DEBUG] Deepgram transcript: '{transcript}', latency: {deepgram_latency}ms")
                    
                    if transcript and transcript.strip():
                        await websocket.send_text(json.dumps({
                            "type": "transcript",
                            "text": transcript
                        }))
                        print(f"[DEBUG] Sent transcript to client: '{transcript}'")
                        
                        room_clients = rooms.get(room_id, [])
                        print(f"[DEBUG] Room has {len(room_clients)} clients, processing for {len(room_clients)-1} other clients")
                        
                        for other_ws in room_clients:
                            if other_ws != websocket and other_ws in user_languages:
                                other_lang = user_languages[other_ws]["language"]
                                print(f"[DEBUG] Processing for other user with language: {other_lang}")
                                
                                if other_lang != user_lang:
                                    translated_text, deepl_latency = await translation_service.measure_deepl_latency(
                                        transcript, user_lang, other_lang
                                    )
                                    print(f"[DEBUG] DeepL translation: '{translated_text}', latency: {deepl_latency}ms")
                                    
                                    if translated_text and translated_text.strip():
                                        voice_map = {
                                            "en": "en-US-JennyNeural",
                                            "ja": "ja-JP-NanamiNeural",
                                            "es": "es-ES-ElviraNeural",
                                            "fr": "fr-FR-DeniseNeural",
                                            "de": "de-DE-KatjaNeural",
                                            "zh": "zh-CN-XiaoxiaoNeural"
                                        }
                                        
                                        audio_output, azure_latency = await translation_service.measure_azure_tts_latency(
                                            translated_text, other_lang, voice_map.get(other_lang, "en-US-JennyNeural")
                                        )
                                        print(f"[DEBUG] Azure TTS audio size: {len(audio_output)} bytes, latency: {azure_latency}ms")
                                        
                                        if audio_output:
                                            hex_audio = audio_output.hex()
                                            print(f"[DEBUG] Sending translated audio to other user, hex length: {len(hex_audio)}")
                                            
                                            await other_ws.send_text(json.dumps({
                                                "type": "translated_audio",
                                                "audio": hex_audio,
                                                "original_text": transcript,
                                                "translated_text": translated_text
                                            }))
                                            print(f"[DEBUG] Sent translated audio to other user")
                                        else:
                                            print(f"[DEBUG] No audio output from Azure TTS")
                                    else:
                                        print(f"[DEBUG] No translation from DeepL")
                                else:
                                    print(f"[DEBUG] Same language, no translation needed")
                    else:
                        print(f"[DEBUG] No transcript from Deepgram")
                except Exception as e:
                    print(f"[DEBUG] Error processing audio_data: {e}")
                    import traceback
                    traceback.print_exc()
            
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
            
            elif message["type"] == "test_deepgram_stt":
                print(f"[DEBUG] Individual Deepgram STT test requested")
                test_start_time = message.get("test_start_time", time.time() * 1000)
                chained_test = message.get("chained_test", False)
                audio_data = base64.b64decode(message["audio"])
                user_lang = user_languages[websocket]["language"]
                print(f"[DEBUG] STT Test - User language: {user_lang}, audio data size: {len(audio_data)} bytes, chained: {chained_test}")
                
                transcript, deepgram_latency = await translation_service.measure_deepgram_latency(
                    audio_data, user_lang
                )
                print(f"[DEBUG] STT Test - Deepgram transcript: '{transcript}', latency: {deepgram_latency}ms")
                
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
