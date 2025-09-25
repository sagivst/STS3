from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import json
import asyncio
import time
from typing import Dict, List
import os
from dotenv import load_dotenv

load_dotenv()

from deepgram import DeepgramClient, PrerecordedOptions, LiveTranscriptionEvents, LiveOptions
import deepl
import azure.cognitiveservices.speech as speechsdk

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
            options = PrerecordedOptions(
                model="nova-2",
                language=language,
                smart_format=True,
            )
            
            response = deepgram_client.listen.prerecorded.v("1").transcribe_file(
                {"buffer": audio_data, "mimetype": "audio/wav"}, options
            )
            
            end_time = time.time()
            self.latency_metrics["deepgram"] = (end_time - start_time) * 1000
            
            transcript = response.results.channels[0].alternatives[0].transcript
            return transcript, self.latency_metrics["deepgram"]
        except Exception as e:
            print(f"Deepgram error: {e}")
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
            speech_config.speech_synthesis_language = language
            speech_config.speech_synthesis_voice_name = voice
            
            synthesizer = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=None)
            result = synthesizer.speak_text_async(text).get()
            
            end_time = time.time()
            self.latency_metrics["azure_tts"] = (end_time - start_time) * 1000
            
            if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
                return result.audio_data, self.latency_metrics["azure_tts"]
            else:
                print(f"Azure TTS error: {result.reason}")
                return b"", 0
        except Exception as e:
            print(f"Azure TTS error: {e}")
            return b"", 0

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
        "speaking": "en",
        "listening": "ja"
    }
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message["type"] == "language_config":
                user_languages[websocket] = {
                    "speaking": message["speaking"],
                    "listening": message["listening"]
                }
                await websocket.send_text(json.dumps({
                    "type": "language_config_updated",
                    "speaking": message["speaking"],
                    "listening": message["listening"]
                }))
            
            elif message["type"] == "audio_data":
                audio_data = message["audio"].encode('latin-1')  # Convert base64 to bytes
                speaking_lang = user_languages[websocket]["speaking"]
                listening_lang = user_languages[websocket]["listening"]
                
                transcript, deepgram_latency = await translation_service.measure_deepgram_latency(
                    audio_data, speaking_lang
                )
                
                if transcript:
                    await websocket.send_text(json.dumps({
                        "type": "transcript",
                        "text": transcript,
                        "language": speaking_lang
                    }))
                    
                    translated_text, deepl_latency = await translation_service.measure_deepl_latency(
                        transcript, speaking_lang, listening_lang
                    )
                    
                    voice_map = {
                        "en": "en-US-JennyNeural",
                        "ja": "ja-JP-NanamiNeural"
                    }
                    audio_output, azure_latency = await translation_service.measure_azure_tts_latency(
                        translated_text, listening_lang, voice_map.get(listening_lang, "en-US-JennyNeural")
                    )
                    
                    for client in rooms[room_id]:
                        if client != websocket:
                            try:
                                await client.send_text(json.dumps({
                                    "type": "translated_audio",
                                    "audio": audio_output.hex() if audio_output else "",
                                    "text": translated_text,
                                    "source_language": speaking_lang,
                                    "target_language": listening_lang
                                }))
                            except:
                                pass
            
            elif message["type"] == "request_latency":
                await websocket.send_text(json.dumps({
                    "type": "latency_update",
                    "metrics": translation_service.latency_metrics
                }))
    
    except WebSocketDisconnect:
        if room_id in rooms:
            rooms[room_id].remove(websocket)
            if not rooms[room_id]:
                del rooms[room_id]
        
        if websocket in user_languages:
            del user_languages[websocket]
