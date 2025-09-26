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
  const [isRecording, setIsRecording] = useState(false)
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
  
  const [chainedTestResults, setChainedTestResults] = useState({
    transcribedText: '',
    translatedText: '',
    isChainedTest: false
  })

  const wsRef = useRef<WebSocket | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  const languages = [
    { code: 'en', name: 'English' },
    { code: 'ja', name: 'Japanese' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'zh', name: 'Chinese' }
  ]

  const connectToRoom = async () => {
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000'
      const wsUrl = apiUrl.replace('http://', 'ws://').replace('https://', 'wss://')
      const ws = new WebSocket(`${wsUrl}/ws/${roomId}`)
      
      ws.onopen = () => {
        setIsConnected(true)
        ws.send(JSON.stringify({
          type: 'language_config',
          language: userLanguage
        }))
      }

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data)
        console.log('[DEBUG] Received WebSocket message:', message.type, message)
        
        if (message.type === 'transcript') {
          console.log('[DEBUG] Setting transcript:', message.text)
          setTranscript(message.text)
        } else if (message.type === 'translated_audio') {
          console.log('[DEBUG] Received translated audio, hex length:', message.audio?.length || 0)
          playTranslatedAudio(message.audio)
        } else if (message.type === 'latency_update') {
          setLatencyMetrics(message.metrics)
        } else if (message.type === 'room_status') {
          setConnectedUsers(message.connected_users)
          setUserLanguages(message.user_languages)
        } else if (message.type === 'test_audio') {
          console.log('[DEBUG] Received test audio, hex length:', message.audio?.length || 0)
          playTranslatedAudio(message.audio)
        } else if (message.type === 'test_result') {
          console.log('[DEBUG] Received test result:', message)
          const service = message.service
          const messageText = message.message
          const latency = message.latency
          const totalTime = message.total_time || latency
          const isChainedTest = message.chained_test
          
          setTranscript(`${service.toUpperCase()} Test Complete: ${messageText} (Processing: ${latency}ms, Total: ${totalTime}ms)`)
          
          if (service === 'deepgram_stt' && isChainedTest) {
            const transcription = message.result || ''
            setChainedTestResults(prev => ({ ...prev, transcribedText: transcription }))
            setTimeout(() => {
              if (transcription.trim()) {
                testDeepLTranslation()
              } else {
                setTranscript("STT test failed - no transcription to continue chain")
                setChainedTestResults({ transcribedText: '', translatedText: '', isChainedTest: false })
              }
            }, 1000)
          } else if (service === 'deepl_translation' && isChainedTest) {
            const translatedText = message.result || ''
            setChainedTestResults(prev => ({ ...prev, translatedText: translatedText }))
            setTimeout(() => {
              if (translatedText.trim()) {
                testAzureTTS()
              } else {
                setTranscript("Translation test failed - no translation to continue chain")
                setChainedTestResults({ transcribedText: '', translatedText: '', isChainedTest: false })
              }
            }, 1000)
          } else if (service === 'azure_tts') {
            if (message.audio) {
              console.log('[DEBUG] Playing TTS test audio, hex length:', message.audio.length)
              playTranslatedAudio(message.audio)
            }
            if (isChainedTest) {
              setTimeout(() => {
                setTranscript("Chained test complete: STT → Translation → TTS")
                setChainedTestResults({ transcribedText: '', translatedText: '', isChainedTest: false })
              }, 2000)
            }
          }
        }
      }

      ws.onclose = () => {
        setIsConnected(false)
        setIsRecording(false)
      }

      wsRef.current = ws
      startAudioCapture()
      
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'request_room_status' }))
          ws.send(JSON.stringify({ type: 'request_test_audio' }))
        }
      }, 1000)
    } catch (error) {
      console.error('Failed to connect:', error)
    }
  }

  const disconnectFromRoom = () => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    stopAudioCapture()
    setIsConnected(false)
    setIsRecording(false)
    setTranscript('')
  }

  const startAudioCapture = async () => {
    try {
      console.log('[DEBUG] Requesting microphone access...')
      
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error('[DEBUG] getUserMedia not supported')
        return
      }
      
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const audioInputs = devices.filter(device => device.kind === 'audioinput')
        console.log('[DEBUG] Available audio input devices:', audioInputs.length)
        audioInputs.forEach((device, index) => {
          console.log(`[DEBUG] Device ${index}: ${device.label || 'Unknown'} (${device.deviceId})`)
        })
      } catch (deviceError) {
        console.error('[DEBUG] Failed to enumerate devices:', deviceError)
      }
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      console.log('[DEBUG] Microphone access granted, stream:', stream)
      streamRef.current = stream
      
      const audioContext = new AudioContext()
      const analyser = audioContext.createAnalyser()
      const source = audioContext.createMediaStreamSource(stream)
      
      analyser.fftSize = 256
      source.connect(analyser)
      
      audioContextRef.current = audioContext
      analyserRef.current = analyser
      
      const mediaRecorder = new MediaRecorder(stream)
      console.log('[DEBUG] MediaRecorder created, mimeType:', mediaRecorder.mimeType)
      mediaRecorderRef.current = mediaRecorder
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          console.log('[DEBUG] Audio data available, size:', event.data.size)
          
          const audioBlob = new Blob([event.data], { type: 'audio/wav' })
          const reader = new FileReader()
          reader.onload = async () => {
            const arrayBuffer = reader.result as ArrayBuffer
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
            console.log('[DEBUG] Sending audio data, base64 length:', base64.length)
            
            wsRef.current?.send(JSON.stringify({
              type: 'audio_data',
              audio: base64
            }))
          }
          reader.readAsArrayBuffer(audioBlob)
        }
      }
      
      mediaRecorder.start(1000)
      setIsRecording(true)
      console.log('[DEBUG] MediaRecorder started')
      
      const cleanup = monitorAudioLevel()
      cleanupRef.current = cleanup
    } catch (error) {
      console.error('[DEBUG] Failed to start audio capture:', error)
      if (error instanceof Error) {
        console.error('[DEBUG] Error name:', error.name)
        console.error('[DEBUG] Error message:', error.message)
      }
    }
  }

  const stopAudioCapture = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop()
      mediaRecorderRef.current = null
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
    
    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    
    setIsRecording(false)
    setAudioLevel(0)
  }

  const monitorAudioLevel = (): (() => void) | null => {
    if (!analyserRef.current) return null
    
    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount)
    let animationId: number
    
    const updateLevel = () => {
      if (!analyserRef.current) return
      
      analyserRef.current.getByteFrequencyData(dataArray)
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length
      setAudioLevel(Math.min(100, (average / 128) * 100))
      
      animationId = requestAnimationFrame(updateLevel)
    }
    
    updateLevel()
    
    return () => {
      if (animationId) {
        cancelAnimationFrame(animationId)
      }
    }
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

  const testDeepgramSTT = async () => {
    if (!wsRef.current || !isConnected) return
    
    const startTime = Date.now()
    setChainedTestResults({ transcribedText: '', translatedText: '', isChainedTest: true })
    setTranscript("Starting Deepgram STT test...")
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      const mediaRecorder = new MediaRecorder(stream)
      const audioChunks: Blob[] = []
      
      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data)
      }
      
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/wav' })
        const arrayBuffer = await audioBlob.arrayBuffer()
        const base64Audio = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
        
        wsRef.current?.send(JSON.stringify({
          type: "test_deepgram_stt",
          audio: base64Audio,
          test_start_time: startTime,
          chained_test: true
        }))
        
        stream.getTracks().forEach(track => track.stop())
      }
      
      mediaRecorder.start()
      setTranscript("Recording 3 seconds for STT test... Speak now!")
      setTimeout(() => mediaRecorder.stop(), 3000)
      
    } catch (error) {
      console.error('Error testing Deepgram STT:', error)
      const totalTime = Date.now() - startTime
      setTranscript(`Error: Could not access microphone (${totalTime}ms)`)
      setChainedTestResults({ transcribedText: '', translatedText: '', isChainedTest: false })
    }
  }

  const testDeepLTranslation = () => {
    if (!wsRef.current || !isConnected) return
    
    const startTime = Date.now()
    let testText: string
    let sourceLanguage: string
    
    if (chainedTestResults.transcribedText) {
      testText = chainedTestResults.transcribedText
      sourceLanguage = "en"
      setTranscript(`Testing DeepL translation with Deepgram result: "${testText}" (${sourceLanguage} → ja)`)
    } else {
      testText = "Hello, this is a test message for translation."
      sourceLanguage = "en"
      setChainedTestResults({ transcribedText: testText, translatedText: '', isChainedTest: true })
      setTranscript(`Testing DeepL translation with fallback text: "${testText}" (${sourceLanguage} → ja)`)
    }
    
    const targetLang = "ja"
    
    wsRef.current.send(JSON.stringify({
      type: "test_deepl_translation",
      text: testText,
      source_language: sourceLanguage,
      target_language: targetLang,
      test_start_time: startTime,
      chained_test: true
    }))
  }

  const testAzureTTS = () => {
    if (!wsRef.current || !isConnected) return
    
    const startTime = Date.now()
    let testText: string
    let language: string
    
    if (chainedTestResults.translatedText) {
      testText = chainedTestResults.translatedText
      language = "ja"
      setTranscript(`Testing Azure TTS with DeepL result: "${testText}" (${language})`)
    } else {
      testText = "これはAzure Text-to-Speechサービスのテストです。"
      language = "ja"
      setChainedTestResults(prev => ({ ...prev, translatedText: testText, isChainedTest: true }))
      setTranscript(`Testing Azure TTS with fallback Japanese text: "${testText}" (${language})`)
    }
    
    wsRef.current.send(JSON.stringify({
      type: "test_azure_tts",
      text: testText,
      language: language,
      test_start_time: startTime,
      chained_test: true
    }))
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Simultaneous Translation</h1>
          <p className="text-lg text-gray-600">Simultaneous Translation App</p>
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
            
            {isConnected && (
              <div className="mt-4 space-y-3">
                <h3 className="text-sm font-medium text-gray-700">Individual Service Tests</h3>
                <div className="grid grid-cols-1 gap-2">
                  <Button 
                    onClick={testDeepgramSTT}
                    variant="outline"
                    size="sm"
                    className="w-full"
                  >
                    Test Deepgram STT (Record & Transcribe)
                  </Button>
                  <Button 
                    onClick={testDeepLTranslation}
                    variant="outline"
                    size="sm"
                    className="w-full"
                  >
                    Test DeepL Translation (Text → Text)
                  </Button>
                  <Button 
                    onClick={testAzureTTS}
                    variant="outline"
                    size="sm"
                    className="w-full"
                  >
                    Test Azure TTS (Text → Speech)
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mic className="h-5 w-5" />
                Speech Meter
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Audio Level</span>
                  <Badge variant={isRecording ? "default" : "secondary"}>
                    {isRecording ? "Recording" : "Inactive"}
                  </Badge>
                </div>
                <Progress value={audioLevel} className="h-3" />
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
      </div>
    </div>
  )
}

export default App
