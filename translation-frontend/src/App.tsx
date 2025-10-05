import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Mic, Volume2, Users, Wifi, WifiOff } from 'lucide-react'

interface LatencyMetrics {
  deepgram: number
  deepl: number
  azure_tts: number
}

function App() {
  const [roomId, setRoomId] = useState('default-room')
  const [userLanguage, setUserLanguage] = useState('en')
  const [isConnected, setIsConnected] = useState(false)
  const [isVoiceActive, setIsVoiceActive] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [audioLevel, setAudioLevel] = useState(0)
  const [outputLevel, setOutputLevel] = useState(0)
  
  
  const [connectedUsers, setConnectedUsers] = useState(0)
  const [userLanguages, setUserLanguages] = useState<string[]>([])
  const [latencyMetrics, setLatencyMetrics] = useState<LatencyMetrics>({
    deepgram: 0,
    deepl: 0,
    azure_tts: 0
  })
  

  const [pipelineLogs, setPipelineLogs] = useState<Array<{
    timestamp: string;
    step: string;
    data: string;
    type: 'audio_to_deepgram' | 'text_from_deepgram' | 'text_to_azure_tts' | 'audio_from_azure_tts';
  }>>([])

  const addPipelineLog = (step: string, data: string, type: 'audio_to_deepgram' | 'text_from_deepgram' | 'text_to_azure_tts' | 'audio_from_azure_tts') => {
    const now = new Date()
    const timestamp = now.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit'
    }) + '.' + now.getMilliseconds().toString().padStart(3, '0')
    setPipelineLogs(prev => [...prev.slice(-19), { timestamp, step, data, type }])
  }

  const wsRef = useRef<WebSocket | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const preBufferRef = useRef<Blob[]>([])
  const preBufferRecorderRef = useRef<MediaRecorder | null>(null)
  const heartbeatIntervalRef = useRef<number | null>(null)

  const languages = [
    { code: 'en', name: 'English' },
    { code: 'ja', name: 'Japanese' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'zh', name: 'Chinese' }
  ]

  const connectToRoom = async () => {
    if (isConnected) return
    
    if (wsRef.current) {
      console.log('[DEBUG] Closing existing WebSocket connection')
      wsRef.current.close()
      wsRef.current = null
    }
    
    const wsBaseUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8001'
    
    const randomDelay = Math.floor(Math.random() * 500) + Math.random() * 300
    await new Promise(resolve => setTimeout(resolve, randomDelay))
    
    const windowUniqueId = crypto.randomUUID ? crypto.randomUUID() : `win_${Date.now()}_${Math.random()}_${performance.now()}`
    const tabSpecificEntropy = `${window.outerWidth}_${window.outerHeight}_${window.screenX}_${window.screenY}_${window.history.length}`
    const connectionUniqueId = crypto.randomUUID ? crypto.randomUUID() : `conn_${Date.now()}_${Math.random()}_${performance.now()}`
    const browserFingerprint = `${navigator.userAgent.length}_${screen.width}x${screen.height}_${window.devicePixelRatio}_${new Date().getTimezoneOffset()}`
    const connectionTimestamp = performance.now().toString().replace('.', '')
    const cryptoArray = window.crypto.getRandomValues(new Uint32Array(6))
    const extraRandomness = `${Math.random()}_${Date.now()}_${performance.now()}_${Math.random().toString(36).substr(2, 12)}`
    
    const clientId = `client_${windowUniqueId}_${connectionUniqueId}_${Date.now()}_${connectionTimestamp}_${cryptoArray.join('_')}_${tabSpecificEntropy.replace(/[^a-zA-Z0-9]/g, '')}_${extraRandomness.replace(/[^a-zA-Z0-9_]/g, '')}_${browserFingerprint.replace(/[^a-zA-Z0-9]/g, '')}`
    const uniqueWsUrl = `${wsBaseUrl}/${roomId}?clientId=${clientId}`
    console.log('[DEBUG] Attempting to connect to WebSocket URL:', uniqueWsUrl)
    console.log('[DEBUG] Client ID:', clientId)
    console.log('[DEBUG] User Language:', userLanguage)
    console.log('[DEBUG] Room ID:', roomId)
    console.log('[DEBUG] Window Unique ID:', windowUniqueId)
    console.log('[DEBUG] Tab Specific Entropy:', tabSpecificEntropy)
    console.log('[DEBUG] Browser Fingerprint:', browserFingerprint)
    
    let retryCount = 0
    const maxRetries = 3
    const retryDelay = 2000
    
    const attemptConnection = () => {
      try {
        const ws = new WebSocket(uniqueWsUrl)
        console.log('[DEBUG] Created new WebSocket instance with unique URL')
        wsRef.current = ws
        
        ws.onopen = () => {
          console.log('[DEBUG] WebSocket connection established for client:', clientId)
          console.log('[DEBUG] WebSocket readyState:', ws.readyState)
          console.log('[DEBUG] WebSocket URL:', ws.url)
          console.log('[DEBUG] WebSocket protocol:', ws.protocol)
          console.log('[DEBUG] WebSocket extensions:', ws.extensions)
          setIsConnected(true)
          retryCount = 0
          
          const languageConfigMessage = {
            type: 'language_config',
            language: userLanguage,
            clientId: clientId
          }
          console.log('[DEBUG] Sending language_config message:', languageConfigMessage)
          ws.send(JSON.stringify(languageConfigMessage))
          
          heartbeatIntervalRef.current = window.setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'heartbeat', clientId: clientId }))
            }
          }, 30000)
          
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              console.log('[DEBUG] Requesting room status for client:', clientId)
              ws.send(JSON.stringify({ type: 'request_room_status', clientId: clientId }))
            }
          }, 1000)
        }

        ws.onmessage = (event) => {
          console.log('[DEBUG] WebSocket message received:', event.data)
          const message = JSON.parse(event.data)
          console.log('[DEBUG] Parsed message type:', message.type)
          
          if (message.type === 'transcript') {
            console.log('[DEBUG] Received transcript:', message.text)
            addPipelineLog('Text from Deepgram STT', message.text, 'text_from_deepgram')
            setTranscript(message.text)
          } else if (message.type === 'translated_audio') {
            console.log('[DEBUG] Received translated audio data')
            addPipelineLog('Audio from Azure TTS', `Audio data: ${message.audio.length} chars`, 'audio_from_azure_tts')
            playTranslatedAudio(message.audio)
          } else if (message.type === 'latency_update') {
            console.log('[DEBUG] Received latency metrics:', message.metrics)
            setLatencyMetrics(message.metrics)
          } else if (message.type === 'room_status') {
            console.log('[DEBUG] Received room status:', message)
            setConnectedUsers(message.connected_users)
            setUserLanguages(message.user_languages)
            console.log('[DEBUG] User connected to room, starting continuous audio capture automatically')
            startContinuousAudioCapture()
          } else if (message.type === 'test_audio') {
            console.log('[DEBUG] Received test audio data')
            playTranslatedAudio(message.audio)
          } else if (message.type === 'test_result') {
            console.log('[DEBUG] Received test result:', message)
            const service = message.service
            const messageText = message.message
            const latency = message.latency
            const totalTime = message.total_time || latency
            
            setTranscript(`${service.toUpperCase()} Test Complete: ${messageText} (Processing: ${latency}ms, Total: ${totalTime}ms)`)
            
            if (service === 'azure_tts') {
              if (message.audio) {
                console.log('[DEBUG] Playing TTS test audio, hex length:', message.audio.length)
                playTranslatedAudio(message.audio)
              }
            }
          } else if (message.type === 'error') {
            console.error('[DEBUG] Received error from backend:', message.message)
            setTranscript(`Backend Error: ${message.message}`)
          }
        }

        ws.onclose = (event) => {
          console.log('[DEBUG] WebSocket connection closed, code:', event.code, 'reason:', event.reason)
          setIsConnected(false)
          
          if (heartbeatIntervalRef.current) {
            clearInterval(heartbeatIntervalRef.current)
            heartbeatIntervalRef.current = null
          }
          
          if (event.code !== 1000 && event.code !== 1001 && retryCount < maxRetries) {
            retryCount++
            console.log(`[DEBUG] Attempting to reconnect (${retryCount}/${maxRetries}) in ${retryDelay}ms...`)
            setTimeout(attemptConnection, retryDelay)
          }
        }

        ws.onerror = (error) => {
          console.error('[DEBUG] WebSocket error for client:', clientId, error)
          console.error('[DEBUG] WebSocket state during error:', ws.readyState)
          console.error('[DEBUG] WebSocket URL during error:', ws.url)
          if (retryCount < maxRetries) {
            retryCount++
            console.log(`[DEBUG] Connection failed for client ${clientId}, retrying (${retryCount}/${maxRetries}) in ${retryDelay}ms...`)
            setTimeout(attemptConnection, retryDelay)
          } else {
            console.error('[DEBUG] Max retries reached for client:', clientId, 'giving up')
            setIsConnected(false)
          }
        }

        wsRef.current = ws
        
      } catch (error) {
        console.error('[DEBUG] Failed to connect:', error)
        setIsConnected(false)
        if (retryCount < maxRetries) {
          retryCount++
          console.log(`[DEBUG] Connection attempt failed, retrying (${retryCount}/${maxRetries}) in ${retryDelay}ms...`)
          setTimeout(attemptConnection, retryDelay)
        }
      }
    }
    
    attemptConnection()
  }

  const disconnectFromRoom = () => {
    console.log('[DEBUG] Disconnecting from room')
    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnected')
      wsRef.current = null
    }
    
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current)
      heartbeatIntervalRef.current = null
    }
    
    stopAudioCapture()
    setIsConnected(false)
    setTranscript('')
  }


  const stopAudioCapture = () => {
    setIsVoiceActive(false)
    
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      mediaRecorderRef.current = null
    }
    
    if (preBufferRecorderRef.current) {
      if (preBufferRecorderRef.current.state === 'recording') {
        preBufferRecorderRef.current.stop()
      }
      preBufferRecorderRef.current = null
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
    
    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }
    
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.close()
      } catch (error) {
        console.log('[DEBUG] AudioContext already closed or error closing:', error)
      }
      audioContextRef.current = null
    }
    
    analyserRef.current = null
    preBufferRef.current = []
    setAudioLevel(0)
  }

  





  const playTranslatedAudio = async (hexAudio: string) => {
    console.log('[DEBUG] playTranslatedAudio called with hex length:', hexAudio?.length || 0)
    if (!hexAudio || hexAudio.length === 0) {
      console.log('[DEBUG] No audio data to play')
      return
    }
    
    try {
      const bytes = new Uint8Array(hexAudio.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || [])
      console.log('[DEBUG] Converted hex to bytes, length:', bytes.length)
      
      const blob = new Blob([bytes], { type: 'audio/wav' })
      const audioUrl = URL.createObjectURL(blob)
      const audio = new Audio(audioUrl)
      console.log('[DEBUG] Created audio element with blob URL')
      
      audio.addEventListener('loadstart', () => {
        console.log('[DEBUG] Audio loading started')
      })
      
      audio.addEventListener('canplay', () => {
        console.log('[DEBUG] Audio can play')
      })
      
      audio.addEventListener('play', () => {
        console.log('[DEBUG] Audio started playing')
        setOutputLevel(75)
        
        setTimeout(() => {
          console.log('[DEBUG] Timeout: Setting output level back to 0')
          setOutputLevel(0)
        }, 3000)
      })
      
      audio.addEventListener('ended', () => {
        console.log('[DEBUG] Audio playback ended')
        setOutputLevel(0)
        URL.revokeObjectURL(audioUrl)
      })
      
      audio.addEventListener('error', (e) => {
        console.error('[DEBUG] Audio playback error:', e)
        console.error('[DEBUG] Audio error details:', audio.error)
        setOutputLevel(0)
        URL.revokeObjectURL(audioUrl)
      })
      
      await audio.play()
      console.log('[DEBUG] Audio play() promise resolved')
    } catch (error) {
      console.error('[DEBUG] Failed to process audio:', error)
      setOutputLevel(0)
    }
  }

  const updateLanguageConfig = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'language_config',
        language: userLanguage
      }))
    }
  }


  useEffect(() => {
    updateLanguageConfig()
  }, [userLanguage])

  useEffect(() => {
    const interval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'request_latency' }))
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [isConnected])



  const getTotalLatency = () => {
    return latencyMetrics.deepgram + latencyMetrics.deepl + latencyMetrics.azure_tts
  }

  const startContinuousAudioCapture = async () => {
    console.log('[DEBUG] Manual microphone activation requested')
    addPipelineLog('Microphone Activation', 'User requested microphone access', 'audio_to_deepgram')
    
    try {
      console.log('[DEBUG] Requesting microphone permissions...')
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: true
      })
      
      console.log('[DEBUG] Microphone access granted, setting up audio monitoring')
      addPipelineLog('Microphone Access', 'Microphone permissions granted', 'audio_to_deepgram')
      
      audioStreamRef.current = stream
      
      const audioContext = new AudioContext({ sampleRate: 16000 })
      const analyser = audioContext.createAnalyser()
      const microphone = audioContext.createMediaStreamSource(stream)
      
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      microphone.connect(analyser)
      
      audioContextRef.current = audioContext
      analyserRef.current = analyser
      
      const monitorAudio = () => {
        if (!analyserRef.current || !audioStreamRef.current) return
        
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount)
        analyserRef.current.getByteFrequencyData(dataArray)
        
        const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length
        const normalizedLevel = Math.floor(average / 25.5)
        
        setAudioLevel(normalizedLevel)
        
        if (normalizedLevel > 5 && wsRef.current?.readyState === WebSocket.OPEN) {
          console.log('[VAD] Voice detected, starting recording for real speech transmission')
          addPipelineLog('Voice Detection', `Audio level: ${normalizedLevel}`, 'audio_to_deepgram')
          startRealSpeechRecording()
        }
        
        if (audioStreamRef.current && audioStreamRef.current.active) {
          requestAnimationFrame(monitorAudio)
        }
      }
      
      monitorAudio()
      console.log('[DEBUG] Audio monitoring started successfully')
      addPipelineLog('Audio Monitoring', 'Real-time audio level monitoring active', 'audio_to_deepgram')
      
    } catch (error) {
      console.error('[ERROR] Failed to start continuous audio capture:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      addPipelineLog('Microphone Error', `Failed to access microphone: ${errorMessage}`, 'audio_to_deepgram')
      setTranscript('❌ No microphone found. Please connect a microphone and refresh.')
    }
  }

  const startRealSpeechRecording = () => {
    if (!audioStreamRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.log('[RECORD] Cannot start recording - missing stream or WebSocket')
      return
    }
    
    console.log('[RECORD] Starting real speech recording')
    addPipelineLog('Recording Start', 'Capturing audio for transcription', 'audio_to_deepgram')
    
    const mediaRecorder = new MediaRecorder(audioStreamRef.current, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 128000
    })
    
    const audioChunks: Blob[] = []
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data)
        console.log(`[RECORD] Audio chunk: ${event.data.size} bytes`)
      }
    }
    
    mediaRecorder.onstop = () => {
      if (audioChunks.length > 0) {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' })
        console.log(`[RECORD] Processing ${audioBlob.size} bytes of audio`)
        addPipelineLog('Audio Processing', `Processing ${audioBlob.size} bytes`, 'audio_to_deepgram')
        
        const reader = new FileReader()
        reader.onloadend = () => {
          const base64Audio = (reader.result as string).split(',')[1]
          
          const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          const audioMessage = {
            type: 'audio_data',
            audio: base64Audio,
            language: userLanguage,
            clientId: clientId,
            timestamp: Date.now()
          }
          
          console.log('[WEBSOCKET] Sending real speech audio_data message')
          addPipelineLog('Audio Transmission', `Sending ${base64Audio.length} chars to Deepgram`, 'audio_to_deepgram')
          wsRef.current?.send(JSON.stringify(audioMessage))
        }
        
        reader.readAsDataURL(audioBlob)
      }
    }
    
    mediaRecorder.start()
    setTimeout(() => {
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.stop()
      }
    }, 3000)
  }


  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center mb-4">
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 mb-2">
                <span className="text-6xl font-black text-gray-900 tracking-tight">STS</span>
                <div className="w-8 h-8 border-2 border-gray-900 rounded-full flex items-center justify-center ml-2">
                  <span className="text-sm font-bold text-gray-900">©</span>
                </div>
              </div>
              <h1 className="text-2xl font-bold text-gray-900 mb-1">Simultaneous Translation Sys</h1>
              <p className="text-sm text-gray-600 font-medium">By Sagiv S.</p>
            </div>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Room and Language Settings
            </CardTitle>
            <CardDescription>
              Configure room and your language
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Room Name</label>
                <Input
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  placeholder="default-room"
                  disabled={isConnected}
                />
              </div>
              
              <div>
                <label className="text-sm font-medium mb-2 block">Your Language</label>
                <Select value={userLanguage} onValueChange={setUserLanguage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {languages.map(lang => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {lang.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {isConnected && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-green-600" />
                    <span className="font-medium text-green-800">
                      Connected Users: {connectedUsers}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {userLanguages.map((lang, index) => (
                      <Badge key={index} variant="secondary" className="text-xs">
                        {languages.find(l => l.code === lang)?.name || lang}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-center">
              <Button
                onClick={isConnected ? disconnectFromRoom : connectToRoom}
                size="lg"
                variant={isConnected ? "destructive" : "default"}
                className="flex items-center gap-2"
              >
                {isConnected ? (
                  <>
                    <WifiOff className="h-5 w-5" />
                    Disconnect from Room
                  </>
                ) : (
                  <>
                    <Wifi className="h-5 w-5" />
                    Join Room
                  </>
                )}
              </Button>
              
            </div>
            
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mic className="h-5 w-5" />
                Speech Meter
                {audioStreamRef.current?.active && (
                  <Badge variant="default" className="text-xs bg-green-100 text-green-800">
                    🎤 Live
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Audio Level</span>
                  <Badge variant={isVoiceActive ? "default" : "secondary"}>
                    {isVoiceActive ? "Recording" : "Inactive"}
                  </Badge>
                </div>
                <Progress value={audioLevel} className="h-3" />
                {audioLevel === 0 && isConnected && (
                  <p className="text-xs text-gray-500 mt-1">
                    💡 Speak into your microphone to see audio levels
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Volume2 className="h-5 w-5" />
                Audio Output Meter
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Output Level</span>
                  <Badge variant={outputLevel > 0 ? "default" : "secondary"}>
                    {outputLevel > 0 ? "Playing" : "Silent"}
                  </Badge>
                </div>
                <Progress value={outputLevel} className="h-3" />
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Transcribed Text</CardTitle>
            <CardDescription>
              Transcribed text in your language
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="min-h-[100px] p-4 bg-gray-50 rounded-lg border">
              {transcript ? (
                <p className="text-lg">{transcript}</p>
              ) : (
                <p className="text-gray-500 italic">
                  {isConnected ? "Waiting for speech..." : "Connect to room to start"}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Latency Measurement</CardTitle>
            <CardDescription>
              Response times of the three services (updated every 3 seconds)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">
                  {latencyMetrics.deepgram.toFixed(0)}ms
                </div>
                <div className="text-sm text-gray-600">Deepgram STT</div>
              </div>
              
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">
                  {latencyMetrics.deepl.toFixed(0)}ms
                </div>
                <div className="text-sm text-gray-600">DeepL Translation</div>
              </div>
              
              <div className="text-center">
                <div className="text-2xl font-bold text-purple-600">
                  {latencyMetrics.azure_tts.toFixed(0)}ms
                </div>
                <div className="text-sm text-gray-600">Azure TTS</div>
              </div>
              
              <div className="text-center">
                <div className={`text-2xl font-bold ${getTotalLatency() < 2000 ? 'text-green-600' : 'text-red-600'}`}>
                  {getTotalLatency().toFixed(0)}ms
                </div>
                <div className="text-sm text-gray-600">Total</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pipeline Activity Log</CardTitle>
            <CardDescription>
              Detailed timestamped log of translation pipeline activity
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-y-auto bg-gray-50 rounded-lg border p-3">
              {pipelineLogs.length === 0 ? (
                <p className="text-gray-500 italic text-sm">
                  {isConnected ? "Waiting for pipeline activity..." : "Connect to room to start logging"}
                </p>
              ) : (
                <div className="space-y-1">
                  {pipelineLogs.map((log, index) => (
                    <div key={index} className="text-xs font-mono">
                      <span className="text-gray-500">[{log.timestamp}]</span>
                      <span className={`ml-2 font-semibold ${
                        log.type === 'audio_to_deepgram' ? 'text-blue-600' :
                        log.type === 'text_from_deepgram' ? 'text-green-600' :
                        log.type === 'text_to_azure_tts' ? 'text-purple-600' :
                        'text-orange-600'
                      }`}>
                        {log.step}:
                      </span>
                      <span className="ml-1 text-gray-700">{log.data}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default App
