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
  const [latencyMetrics, setLatencyMetrics] = useState<LatencyMetrics>({
    deepgram: 0,
    deepl: 0,
    azure_tts: 0
  })

  const wsRef = useRef<WebSocket | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

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
        
        if (message.type === 'transcript') {
          setTranscript(message.text)
        } else if (message.type === 'translated_audio') {
          playTranslatedAudio(message.audio)
          setOutputLevel(80)
          setTimeout(() => setOutputLevel(0), 1000)
        } else if (message.type === 'latency_update') {
          setLatencyMetrics(message.metrics)
        }
      }

      ws.onclose = () => {
        setIsConnected(false)
        setIsRecording(false)
      }

      wsRef.current = ws
      startAudioCapture()
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      
      const audioContext = new AudioContext()
      const analyser = audioContext.createAnalyser()
      const source = audioContext.createMediaStreamSource(stream)
      
      analyser.fftSize = 256
      source.connect(analyser)
      
      audioContextRef.current = audioContext
      analyserRef.current = analyser
      
      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          const reader = new FileReader()
          reader.onload = () => {
            const arrayBuffer = reader.result as ArrayBuffer
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
            
            wsRef.current?.send(JSON.stringify({
              type: 'audio_data',
              audio: base64
            }))
          }
          reader.readAsArrayBuffer(event.data)
        }
      }
      
      mediaRecorder.start(1000)
      setIsRecording(true)
      
      monitorAudioLevel()
    } catch (error) {
      console.error('Failed to start audio capture:', error)
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
    
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    
    setIsRecording(false)
    setAudioLevel(0)
  }

  const monitorAudioLevel = () => {
    if (!analyserRef.current) return
    
    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount)
    
    const updateLevel = () => {
      if (!analyserRef.current) return
      
      analyserRef.current.getByteFrequencyData(dataArray)
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length
      setAudioLevel(Math.min(100, (average / 128) * 100))
      
      if (isRecording) {
        requestAnimationFrame(updateLevel)
      }
    }
    
    updateLevel()
  }

  const playTranslatedAudio = (hexAudio: string) => {
    if (!hexAudio) return
    
    try {
      const bytes = new Uint8Array(hexAudio.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || [])
      const blob = new Blob([bytes], { type: 'audio/wav' })
      const audio = new Audio(URL.createObjectURL(blob))
      
      audio.addEventListener('play', () => {
        setOutputLevel(80)
      })
      
      audio.addEventListener('ended', () => {
        setOutputLevel(0)
      })
      
      audio.addEventListener('error', (e) => {
        console.error('Audio playback error:', e)
        setOutputLevel(0)
      })
      
      audio.play().catch(error => {
        console.error('Failed to play audio:', error)
        setOutputLevel(0)
      })
    } catch (error) {
      console.error('Failed to process audio:', error)
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
