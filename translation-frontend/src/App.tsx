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
  
  const VAD_THRESHOLD = 12  // Reduced from 15 for better sensitivity
  const SILENCE_DURATION = 800  // Reduced from 1000ms for faster response
  const PREBUFFER_DURATION = 500  // 500ms of pre-VAD audio
  const TIMESLICE_INTERVAL = 100  // 100ms chunks for consistent timing
  
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
  const audioStreamRef = useRef<MediaStream | null>(null)
  const isRecordingRef = useRef<boolean>(false)
  const lastVoiceTimeRef = useRef<number>(0)
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
            setTranscript(message.text)
          } else if (message.type === 'translated_audio') {
            console.log('[DEBUG] Received translated audio data')
            playTranslatedAudio(message.audio)
          } else if (message.type === 'latency_update') {
            console.log('[DEBUG] Received latency metrics:', message.metrics)
            setLatencyMetrics(message.metrics)
          } else if (message.type === 'room_status') {
            console.log('[DEBUG] Received room status:', message)
            setConnectedUsers(message.connected_users)
            setUserLanguages(message.user_languages)
          } else if (message.type === 'test_audio') {
            console.log('[DEBUG] Received test audio data')
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
    
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    
    analyserRef.current = null
    preBufferRef.current = []
    setAudioLevel(0)
  }

  const startRecording = () => {
    if (!audioStreamRef.current || isRecordingRef.current) return
    
    console.log('[DEBUG] Starting MediaRecorder for continuous capture with pre-buffer')
    const mediaRecorder = new MediaRecorder(audioStreamRef.current, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 128000
    })
    
    const audioChunks: Blob[] = []
    
    if (preBufferRef.current.length > 0) {
      console.log('[DEBUG] Including', preBufferRef.current.length, 'pre-buffered chunks')
      audioChunks.push(...preBufferRef.current)
      preBufferRef.current = []
    }
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data)
        console.log('[DEBUG] Audio chunk received, size:', event.data.size)
      }
    }
    
    mediaRecorder.onstop = () => {
      console.log('[DEBUG] MediaRecorder stopped, processing audio chunks')
      if (audioChunks.length > 0) {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' })
        console.log('[DEBUG] Created audio blob with pre-buffer, size:', audioBlob.size)
        
        const reader = new FileReader()
        reader.onloadend = () => {
          const base64Audio = (reader.result as string).split(',')[1]
          const clientId = new URL(wsRef.current?.url || '').searchParams.get('clientId') || 'unknown'
          
          console.log('[DEBUG] Preparing audio_data message for asymmetric routing test')
          console.log('[DEBUG] Client ID:', clientId, 'Language:', userLanguage, 'Room:', roomId)
          console.log('[DEBUG] Base64 audio length:', base64Audio.length)
          console.log('[DEBUG] WebSocket state:', wsRef.current?.readyState)
          console.log('[DEBUG] WebSocket URL:', wsRef.current?.url)
          
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            const audioMessage = {
              type: 'audio_data',
              audio: base64Audio,
              language: userLanguage,
              clientId: clientId,
              client_info: `${userLanguage}_${clientId}_${Date.now()}`,
              timestamp: Date.now(),
              routing_debug: `from_${clientId}_lang_${userLanguage}`
            }
            
            console.log('[DEBUG] Sending audio_data message:', {
              type: audioMessage.type,
              clientId: audioMessage.clientId,
              language: audioMessage.language,
              audioLength: audioMessage.audio.length,
              timestamp: audioMessage.timestamp
            })
            
            wsRef.current.send(JSON.stringify(audioMessage))
            console.log('[DEBUG] Audio_data message sent successfully from client:', clientId)
          } else {
            console.log('[ERROR] WebSocket not open for client:', clientId, 'state:', wsRef.current?.readyState)
          }
        }
        reader.readAsDataURL(audioBlob)
      }
      audioChunks.length = 0
    }
    
    mediaRecorderRef.current = mediaRecorder
    isRecordingRef.current = true
    setIsVoiceActive(true)
    
    mediaRecorder.start(TIMESLICE_INTERVAL)
    console.log('[DEBUG] MediaRecorder started for continuous capture with', TIMESLICE_INTERVAL, 'ms timeslice')
  }
  
  const stopRecording = () => {
    if (!mediaRecorderRef.current || !isRecordingRef.current) return
    
    console.log('[DEBUG] Stopping MediaRecorder for continuous capture')
    mediaRecorderRef.current.stop()
    isRecordingRef.current = false
    setIsVoiceActive(false)
  }

  const startPreBuffering = () => {
    if (!audioStreamRef.current || preBufferRecorderRef.current) return
    
    console.log('[DEBUG] Starting pre-buffer recording')
    const preBufferRecorder = new MediaRecorder(audioStreamRef.current, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 128000
    })
    
    preBufferRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        preBufferRef.current.push(event.data)
        
        const maxChunks = Math.ceil(PREBUFFER_DURATION / TIMESLICE_INTERVAL)
        if (preBufferRef.current.length > maxChunks) {
          preBufferRef.current = preBufferRef.current.slice(-maxChunks)
        }
      }
    }
    
    preBufferRecorderRef.current = preBufferRecorder
    preBufferRecorder.start(TIMESLICE_INTERVAL)
  }

  const monitorAudioLevel = () => {
    if (!analyserRef.current || !audioContextRef.current) return
    
    const analyser = analyserRef.current
    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    
    console.log('[DEBUG] Audio level monitoring started')
    
    startPreBuffering()
    
    let smoothedLevel = 0
    const smoothingFactor = 0.3
    
    const checkAudioLevel = () => {
      if (!analyser || audioContextRef.current?.state === 'closed') return
      
      analyser.getByteFrequencyData(dataArray)
      
      let sum = 0
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i] * dataArray[i]
      }
      const rms = Math.sqrt(sum / bufferLength)
      const rawLevel = Math.round((rms / 255) * 100)
      
      smoothedLevel = smoothedLevel * (1 - smoothingFactor) + rawLevel * smoothingFactor
      const audioLevel = Math.round(smoothedLevel)
      
      console.log(`[DEBUG] Audio level: ${audioLevel} (raw: ${rawLevel}), VAD threshold: ${VAD_THRESHOLD}, Currently recording: ${isRecordingRef.current}`)
      
      setAudioLevel(audioLevel)
      
      if (audioLevel > VAD_THRESHOLD) {
        if (!isRecordingRef.current) {
          console.log('[DEBUG] Voice detected, starting recording with pre-buffer')
          startRecording()
        }
        lastVoiceTimeRef.current = Date.now()
      } else if (isRecordingRef.current && Date.now() - lastVoiceTimeRef.current > SILENCE_DURATION) {
        console.log('[DEBUG] Silence detected, stopping recording')
        stopRecording()
      }
      
      if (audioStreamRef.current && audioStreamRef.current.active) {
        requestAnimationFrame(checkAudioLevel)
      }
    }
    
    checkAudioLevel()
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
      let mimeType = 'audio/webm;codecs=opus'
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        console.warn('[DEBUG] Opus codec not supported, trying WebM without codec specification')
        mimeType = 'audio/webm'
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          console.warn('[DEBUG] WebM not supported, falling back to MP4 - may cause transcription issues')
          mimeType = 'audio/mp4'
        }
      }
      console.log('[DEBUG] Selected mimeType for MediaRecorder:', mimeType)
      
      const mediaRecorder = new MediaRecorder(stream, { mimeType })
      const audioChunks: Blob[] = []
      
      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data)
      }
      
      mediaRecorder.onstop = async () => {
        const actualMimeType = mediaRecorder.mimeType
        const audioBlob = new Blob(audioChunks, { type: actualMimeType })
        const arrayBuffer = await audioBlob.arrayBuffer()
        const base64Audio = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
        
        wsRef.current?.send(JSON.stringify({
          type: "test_deepgram_stt",
          audio: base64Audio,
          mimeType: actualMimeType,
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
      setTranscript(`Microphone access failed, testing with synthetic audio...`)
      
      wsRef.current?.send(JSON.stringify({
        type: "test_deepgram_stt",
        test_start_time: startTime,
        chained_test: true
      }))
    }
  }

  const testDeepLTranslation = () => {
    if (!wsRef.current || !isConnected) return
    
    const startTime = Date.now()
    let testText: string
    let sourceLanguage: string
    let targetLang: string
    
    if (chainedTestResults.transcribedText) {
      testText = chainedTestResults.transcribedText
      sourceLanguage = userLanguage
      targetLang = userLanguage === "en" ? "ja" : "en"
      setTranscript(`Testing DeepL translation with Deepgram result: "${testText}" (${sourceLanguage} → ${targetLang})`)
    } else {
      if (userLanguage === "ja") {
        testText = "こんにちは、これは翻訳のためのテストメッセージです。"
        sourceLanguage = "ja"
        targetLang = "en"
      } else {
        testText = "Hello, this is a test message for translation."
        sourceLanguage = "en"
        targetLang = "ja"
      }
      setChainedTestResults({ transcribedText: testText, translatedText: '', isChainedTest: true })
      setTranscript(`Testing DeepL translation with fallback text: "${testText}" (${sourceLanguage} → ${targetLang})`)
    }
    
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

  useEffect(() => {
    if (isConnected) {
      console.log('[DEBUG] User connected to room, starting continuous audio capture automatically')
      startContinuousAudioCapture()
    }
  }, [isConnected])

  const startContinuousAudioCapture = async () => {
    console.log('[DEBUG] Starting continuous audio capture')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      })
      
      audioStreamRef.current = stream
      streamRef.current = stream
      
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
      const analyser = audioContext.createAnalyser()
      const microphone = audioContext.createMediaStreamSource(stream)
      
      analyser.smoothingTimeConstant = 0.8
      analyser.fftSize = 1024
      microphone.connect(analyser)
      
      audioContextRef.current = audioContext
      analyserRef.current = analyser
      
      console.log('[DEBUG] Starting audio level monitoring')
      monitorAudioLevel()
      
      console.log('[DEBUG] Continuous audio capture started successfully')
      
      setTranscript('Recording initialized. Speak to see transcription...')
      
      cleanupRef.current = () => {
        console.log('[DEBUG] Cleaning up continuous audio capture')
        stream.getTracks().forEach(track => track.stop())
        audioContext.close()
        audioStreamRef.current = null
        streamRef.current = null
        isRecordingRef.current = false
      }
    } catch (error) {
      console.error('[DEBUG] Error starting continuous audio capture:', error)
      console.log('[DEBUG] Sending fallback test_deepgram_stt message')
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'test_deepgram_stt',
          language: userLanguage
        }))
      }
    }
  }

  const getTotalLatency = () => {
    return latencyMetrics.deepgram + latencyMetrics.deepl + latencyMetrics.azure_tts
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
                  <Button 
                    onClick={() => {
                      console.log('[CRITICAL] *** MANUAL TEST BUTTON CLICKED ***')
                      const clientId = new URL(wsRef.current?.url || '').searchParams.get('clientId') || 'unknown'
                      console.log('[CRITICAL] Manually triggering audio_data message for asymmetric routing test')
                      console.log('[CRITICAL] Client ID:', clientId, 'Language:', userLanguage)
                      console.log('[CRITICAL] WebSocket state:', wsRef.current?.readyState)
                      console.log('[CRITICAL] WebSocket URL:', wsRef.current?.url)
                      
                      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                        const syntheticAudio = "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=" +
                          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
                        
                        const message = {
                          type: 'audio_data',
                          audio: syntheticAudio,
                          language: userLanguage,
                          clientId: clientId,
                          client_info: `${userLanguage}_${clientId}_manual_test_${Date.now()}`
                        };
                        
                        console.log('[CRITICAL] Sending message:', JSON.stringify(message).substring(0, 200) + '...')
                        wsRef.current.send(JSON.stringify(message))
                        console.log('[CRITICAL] *** MANUAL AUDIO_DATA MESSAGE SENT SUCCESSFULLY ***')
                        console.log('[CRITICAL] Message sent from client:', clientId, 'Language:', userLanguage)
                      } else {
                        console.log('[CRITICAL] *** WEBSOCKET NOT OPEN FOR MANUAL TEST ***')
                        console.log('[CRITICAL] WebSocket state:', wsRef.current?.readyState)
                        console.log('[CRITICAL] Expected state: 1 (OPEN)')
                      }
                    }}
                    variant="outline"
                    size="sm"
                    className="w-full bg-yellow-50 border-yellow-200 hover:bg-yellow-100"
                  >
                    🔧 Manual Audio_Data Test (Debug Routing)
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
                  <Badge variant={isVoiceActive ? "default" : "secondary"}>
                    {isVoiceActive ? "Recording" : "Inactive"}
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
