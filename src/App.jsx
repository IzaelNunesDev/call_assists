import { useState, useRef, useEffect } from 'react';

// ── Utilitários de Áudio ──────────────────────────────────────────────────────

const TARGET_SR = 16000;


function floatToInt16(floatSamples) {
  const out = new Int16Array(floatSamples.length);
  for (let i = 0; i < floatSamples.length; i++) {
    const s = Math.max(-1, Math.min(1, floatSamples[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState('transcript');
  const [isRecording, setIsRecording] = useState(false);
  const [isProtected, setIsProtected] = useState(true);
  const [transcript, setTranscript] = useState([]);
  const [timer, setTimer] = useState(0);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [setupVisible, setSetupVisible] = useState(false);
  const [setupProgress, setSetupProgress] = useState('');

  const [settings, setSettings] = useState({ apiKey: '', language: 'pt', whisperModel: 'small', transcribeProvider: 'local' });

  const timerRef = useRef(null);
  const transcriptRef = useRef([]);       // espelha `transcript` state (acesso síncrono)
  const fullHistoryRef = useRef([]);      // TODOS os itens já transcritos (nunca apagados)
  const compressedContextRef = useRef(''); // resumos acumulados das compressões anteriores
  const isCompressingRef = useRef(false); // evita compressões simultâneas

  // Refs de captura de áudio
  const audioCtxRef = useRef(null);
  const processorRef = useRef(null);
  const streamRef = useRef(null);
  const pcmBufRef = useRef(new Float32Array(0));

  useEffect(() => {
    window.electronAPI.loadSettings().then(s => setSettings(prev => ({ ...prev, ...s })));

    const removeShortcutToggle = window.electronAPI.onShortcut('toggle-recording', () => {
      toggleRecording();
    });
    const removeShortcutChat = window.electronAPI.onShortcut('open-chat', () => {
      setActiveTab('chat');
    });
    const removeChunk = window.electronAPI.onTranscriptChunk((text) => {
      if (!text.trim()) return;
      const item = {
        id: Date.now() + Math.random(),
        text: text.trim(),
        time: formatTimer(timerRef.current || 0),
      };
      fullHistoryRef.current.push(item); // histórico completo nunca perde itens
      setTranscript(prev => {
        const next = [...prev, item];
        transcriptRef.current = next;
        return next;
      });
    });
    const removeProgress = window.electronAPI.onDownloadProgress((msg) => {
      setSetupProgress(msg);
    });

    return () => {
      removeShortcutToggle();
      removeShortcutChat();
      removeChunk();
      removeProgress();
    };
  }, []);

  // Compressão automática: a cada 120s comprime itens antigos da transcrição
  const triggerAutoCompress = async () => {
    if (isCompressingRef.current) return;
    const items = transcriptRef.current;
    // Manter os últimos 6 itens como "contexto fresco", comprimir o resto
    if (items.length <= 8) return;

    const toCompress = items.slice(0, items.length - 6);
    const toKeep = items.slice(items.length - 6);

    isCompressingRef.current = true;
    const rawText = toCompress.map(i => `[${i.time}] ${i.text}`).join('\n');
    const apiKey = settings.apiKey; // closure sobre o state atual

    const result = await window.electronAPI.aiCompress({ text: rawText, apiKey });

    if (result.summary) {
      const sep = compressedContextRef.current ? '\n\n' : '';
      compressedContextRef.current += sep + result.summary;
      // Remove itens comprimidos do state visível
      setTranscript(toKeep);
      transcriptRef.current = toKeep;
    }
    isCompressingRef.current = false;
  };

  // Timer + gatilho de compressão automática
  useEffect(() => {
    if (isRecording) {
      const interval = setInterval(() => {
        setTimer(t => {
          const next = t + 1;
          timerRef.current = next;
          // A cada 120s (2min) tenta comprimir
          if (next % 120 === 0) triggerAutoCompress();
          return next;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [isRecording, settings.apiKey]);

  const formatTimer = (secs) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const toggleProtection = async () => {
    const newState = await window.electronAPI.toggleProtection(!isProtected);
    setIsProtected(newState);
  };

  const stopSystemCapture = () => {
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    pcmBufRef.current = new Float32Array(0);
  };

  const startRecording = async () => {
    setSetupVisible(true);
    setSetupProgress('Verificando Whisper.cpp...');

    // Qualquer provider diferente de 'groq' usa whisper local
    if (settings.transcribeProvider !== 'groq') {
      const setupRes = await window.electronAPI.setupWhisper({ model: settings.whisperModel });
      if (!setupRes.success) {
        setSetupProgress('Erro: ' + setupRes.error);
        setTimeout(() => setSetupVisible(false), 3000);
        return;
      }
    }

    setSetupProgress('Iniciando captura de áudio do sistema...');

    try {
      // 1. Avisar main que iniciou (seta flag + idioma + modelo)
      await window.electronAPI.startCapture({
        language: settings.language,
        model: settings.whisperModel,
      });

      // 2. Pegar fonte de tela para desktopCapturer
      const sources = await window.electronAPI.getDesktopSources();
      if (!sources.length) throw new Error('Nenhuma fonte de tela encontrada');

      // 3. Capturar áudio do sistema via desktopCapturer
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sources[0].id,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sources[0].id,
            maxWidth: 1, maxHeight: 1,
          },
        },
      });

      // Para a track de vídeo imediatamente (só precisamos do áudio)
      stream.getVideoTracks().forEach(t => t.stop());
      streamRef.current = stream;

      // Força o navegador a fazer o downsampling com alta qualidade nativa em C++
      const audioCtx = new AudioContext({ sampleRate: TARGET_SR });
      audioCtxRef.current = audioCtx;
      
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      pcmBufRef.current = new Float32Array(0);

      // --- Configurações do Corte Inteligente (VAD) ---
      let silenceDuration = 0;
      const SILENCE_THRESHOLD = 0.015; // Sensibilidade de volume (ajuste se não estiver cortando)
      const MIN_CHUNK_SAMPLES = TARGET_SR * 20; // Mínimo de 20 segundos para enviar
      const MAX_CHUNK_SAMPLES = TARGET_SR * 40; // Máximo de 40s (evita delay infinito se ninguém pausar)

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);

        // 1. Calcular o volume (Root Mean Square - RMS) deste pequeno fragmento
        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          sum += input[i] * input[i];
        }
        const rms = Math.sqrt(sum / input.length);

        // 2. Acumular o áudio no buffer contínuo
        const cur = pcmBufRef.current;
        const merged = new Float32Array(cur.length + input.length);
        merged.set(cur);
        merged.set(input, cur.length);
        pcmBufRef.current = merged;

        // 3. Detectar se é silêncio ou fala
        if (rms < SILENCE_THRESHOLD) {
          silenceDuration += (input.length / TARGET_SR); // Adiciona segundos de silêncio
        } else {
          silenceDuration = 0; // Alguém está falando, reseta o cronômetro de silêncio
        }

        // 4. Lógica de Envio: Tem áudio suficiente E houve uma pausa de 1 segundo? OU bateu limite de 15s?
        const hasEnoughAudio = merged.length >= MIN_CHUNK_SAMPLES;
        const isSilent = silenceDuration > 1.0; 
        const reachedMax = merged.length >= MAX_CHUNK_SAMPLES;

        if ((hasEnoughAudio && isSilent) || reachedMax) {
          // O navegador já garantiu que está em 16kHz, não precisamos de linearResample
          const int16 = floatToInt16(merged); 
          window.electronAPI.sendAudioChunk(int16.buffer, TARGET_SR, settings.language);

          // Reseta o buffer principal e o silêncio para o próximo lote de fala
          pcmBufRef.current = new Float32Array(0);
          silenceDuration = 0;
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      setSetupVisible(false);
      setIsRecording(true);
      setTimer(0);
      timerRef.current = 0;
    } catch (err) {
      stopSystemCapture();
      window.electronAPI.stopCapture();
      setSetupProgress('Erro: ' + err.message);
      setTimeout(() => setSetupVisible(false), 4000);
    }
  };

  const stopRecording = () => {
    stopSystemCapture();
    window.electronAPI.stopCapture();
    setIsRecording(false);

    // Salva o histórico completo em arquivo
    const all = fullHistoryRef.current;
    if (all.length > 0) {
      const now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
      let content = `GRAVAÇÃO: ${now.toLocaleString('pt-BR')}\n`;
      if (compressedContextRef.current) {
        content += `\n=== CONTEXTO COMPRIMIDO DURANTE SESSÃO ===\n${compressedContextRef.current}\n\n=== TRANSCRIÇÃO COMPLETA ===\n`;
      }
      content += all.map(i => `[${i.time}] ${i.text}`).join('\n');
      window.electronAPI.saveTranscriptHistory({ filename: `reuniao_${stamp}.txt`, content });
    }
  };

  const toggleRecording = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  const getFullTranscriptText = () => {
    const recent = transcriptRef.current.map(t => `[${t.time}] ${t.text}`).join('\n');
    if (compressedContextRef.current) {
      return `=== HISTÓRICO RESUMIDO ===\n${compressedContextRef.current}\n\n=== TRANSCRIÇÃO RECENTE ===\n${recent}`;
    }
    return recent;
  };

  return (
    <div className="app">
      {/* Title Bar */}
      <div className="titlebar">
        <div className="titlebar-icon">🕵️</div>
        <div className="titlebar-name">CallAssist</div>
        <div title="Invisibilidade no Screen Share" onClick={toggleProtection} className={`shield-badge ${isProtected ? 'on' : 'off'}`}>
           {isProtected ? '🛡️ Invisível' : '👁️ Visível'}
        </div>
        <div className="titlebar-controls ml-auto">
          <button className="win-btn" onClick={() => setSettingsOpen(true)}>⚙️</button>
          <button className="win-btn" onClick={() => window.electronAPI.minimize()}>—</button>
          <button className="win-btn close" onClick={() => window.electronAPI.close()}>✕</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        <button
          className={`tab-btn ${activeTab === 'transcript' ? 'active' : ''}`}
          onClick={() => setActiveTab('transcript')}
        >
          📝 Notas
        </button>
        <button
          className={`tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          🤖 Chat IA
        </button>
        <button
          className={`tab-btn ${activeTab === 'video' ? 'active' : ''}`}
          onClick={() => setActiveTab('video')}
        >
          📹 Vídeo
        </button>
      </div>

      {/* Content */}
      <div className="panel-content">
        {activeTab === 'transcript' ? (
           <TranscriptPanel
             transcript={transcript}
             isRecording={isRecording}
             hasCompressed={!!compressedContextRef.current}
           />
        ) : activeTab === 'chat' ? (
           <ChatPanel
             apiKey={settings.apiKey}
             getFullTranscript={getFullTranscriptText}
             openSettings={() => setSettingsOpen(true)}
             hasHistory={fullHistoryRef.current.length > 0}
             onOpenHistory={() => window.electronAPI.openHistoryFolder()}
           />
        ) : (
           <VideoPanel settings={settings} />
        )}
      </div>

      {setupVisible && (
        <div style={{ padding: '8px 14px', background: 'var(--accent-dim)', color: 'var(--accent-lite)', fontSize: '11px', borderTop: '1px solid var(--border)' }}>
          🔄 {setupProgress}
        </div>
      )}

      {/* Bottom Control Bar */}
      <div className="control-bar">
        <button 
          className={`btn btn-record ${isRecording ? 'recording' : ''}`}
          onClick={toggleRecording}
        >
          {isRecording ? '⏹ Parar (Ctrl+Shift+Space)' : '⏺ Iniciar (Ctrl+Shift+Space)'}
        </button>
        
        {isRecording && (
          <div className="rec-indicator" style={{marginLeft: '10px', width: '40px'}}>
             <div className="rec-dot active"></div>
             <span className="rec-timer">{formatTimer(timer)}</span>
          </div>
        )}
        
        {!isRecording && transcript.length > 0 && (
           <button className="btn btn-primary" onClick={() => setSummaryOpen(true)}>
             Gerar Resumo
           </button>
        )}
      </div>

      {/* Modals */}
      {settingsOpen && <SettingsModal settings={settings} setSettings={setSettings} onClose={() => setSettingsOpen(false)} />}
      {summaryOpen && <SummaryModal apiKey={settings.apiKey} getFullTranscript={getFullTranscriptText} onClose={() => setSummaryOpen(false)} />}
    </div>
  );
}

// ============== Components below inline for simplicity ==============

function TranscriptPanel({ transcript, isRecording, hasCompressed }) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript, isRecording]);

  return (
    <div className="transcript-panel">
      {transcript.length === 0 && !hasCompressed ? (
        <div className="transcript-empty">
          <div className="transcript-empty-icon">🎧</div>
          <p>Motor Local Whisper.cpp integrado.<br/>Clique em Iniciar para gravar.</p>
        </div>
      ) : (
        <div className="transcript-list">
          {hasCompressed && (
            <div className="transcript-item" style={{ opacity: 0.55, fontStyle: 'italic', fontSize: '11px' }}>
              <div className="transcript-meta">📚</div>
              <div className="transcript-text">Contexto anterior comprimido e enviado ao chat</div>
            </div>
          )}
          {transcript.map(item => (
            <div key={item.id} className="transcript-item">
              <div className="transcript-meta">{item.time}</div>
              <div className="transcript-text">{item.text}</div>
            </div>
          ))}
          {isRecording && (
            <div className="transcribing-badge" style={{ alignSelf: 'flex-start', margin: '4px' }}>
              Escutando Sistema<span className="dots-anim"></span>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

function ChatPanel({ apiKey, getFullTranscript, openSettings, hasHistory, onOpenHistory }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [pendingScreenshot, setPendingScreenshot] = useState(null); // base64 da captura pendente
  const [isCompressing, setIsCompressing] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const unsubChunk = window.electronAPI.onChatChunk((chunk) => {
      setMessages(prev => {
        const last = [...prev];
        if (last.length > 0 && last[last.length - 1].role === 'assistant') {
          last[last.length - 1].content += chunk;
        } else {
          last.push({ role: 'assistant', content: chunk });
        }
        return last;
      });
    });
    const unsubDone = window.electronAPI.onChatDone(() => setIsSending(false));
    return () => { unsubChunk(); unsubDone(); };
  }, []);

  const handleSend = () => {
    if ((!input.trim() && !pendingScreenshot) || isSending) return;
    if (!apiKey) { openSettings(); return; }

    const msg = {
      role: 'user',
      content: input || (pendingScreenshot ? '📸 [screenshot anexado]' : ''),
      ...(pendingScreenshot ? { image: pendingScreenshot } : {}),
    };
    const newMsgs = [...messages, msg];
    setMessages(newMsgs);
    setInput('');
    setPendingScreenshot(null);
    setIsSending(true);

    window.electronAPI.sendChat({
      messages: newMsgs.map(m => ({ role: m.role, content: m.content, image: m.image })),
      transcript: getFullTranscript(),
      apiKey,
    });
  };

  const handleScreenshot = async () => {
    const result = await window.electronAPI.captureScreenshot();
    if (result.dataUrl) setPendingScreenshot(result.dataUrl);
    else alert('Erro ao capturar tela: ' + result.error);
  };

  // Comprime o histórico do chat em um único resumo e descarta as mensagens antigas
  const handleCompressChat = async () => {
    if (messages.length < 2 || isSending || isCompressing) return;
    if (!apiKey) { openSettings(); return; }
    setIsCompressing(true);
    const chatText = messages.map(m => `${m.role === 'assistant' ? 'Assistente' : 'Usuário'}: ${m.content}`).join('\n');
    const result = await window.electronAPI.aiCompress({
      text: chatText,
      prompt: `Resuma esta conversa de forma densa, preservando todos os pontos, decisões e dados mencionados. O resumo substituirá o histórico para continuar o contexto:\n\n${chatText}`,
      apiKey,
    });
    setIsCompressing(false);
    if (result.summary) {
      setMessages([{ role: 'assistant', content: `📋 Resumo do histórico anterior:\n\n${result.summary}` }]);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  return (
    <div className="chat-panel">
      {/* Barra de ações do chat */}
      <div style={{ display: 'flex', gap: '4px', padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
        <button
          className="btn btn-ghost"
          style={{ fontSize: '11px', flex: 1 }}
          onClick={handleScreenshot}
          title="Capturar tela e enviar como contexto"
        >
          📸 Screenshot
        </button>
        <button
          className="btn btn-ghost"
          style={{ fontSize: '11px', flex: 1 }}
          onClick={handleCompressChat}
          disabled={messages.length < 2 || isCompressing}
          title="Resumir e limpar histórico do chat"
        >
          {isCompressing ? '⏳...' : '🗜️ Comprimir Chat'}
        </button>
        {hasHistory && (
          <button
            className="btn btn-ghost"
            style={{ fontSize: '11px', flex: 1 }}
            onClick={onOpenHistory}
            title="Abrir pasta com gravações salvas"
          >
            📂 Histórico
          </button>
        )}
      </div>

      {/* Mensagens */}
      {messages.length === 0 ? (
        <div className="chat-empty">
          <div className="chat-empty-icon">🤖</div>
          <p>Gemini 3.1 Flash Lite<br/>Contexto da reunião transferido automaticamente.<br/>Use 📸 para enviar print da tela.</p>
        </div>
      ) : (
        <div className="chat-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`chat-bubble ${msg.role}`}>
              {msg.image && (
                <img src={msg.image} alt="screenshot" style={{ width: '100%', borderRadius: '4px', marginBottom: '4px', opacity: 0.85 }} />
              )}
              {msg.content.split('\n').map((p, j) => <p key={j}>{p}</p>)}
            </div>
          ))}
          {isSending && messages[messages.length - 1]?.role === 'user' && (
            <div className="chat-bubble assistant typing-cursor"></div>
          )}
          <div ref={endRef} />
        </div>
      )}

      {/* Preview do screenshot pendente */}
      {pendingScreenshot && (
        <div style={{ padding: '4px 8px', borderTop: '1px solid var(--border)', position: 'relative' }}>
          <img src={pendingScreenshot} alt="pendente" style={{ width: '100%', maxHeight: '80px', objectFit: 'cover', borderRadius: '4px', opacity: 0.7 }} />
          <button
            onClick={() => setPendingScreenshot(null)}
            style={{ position: 'absolute', top: '8px', right: '12px', background: 'var(--bg)', border: 'none', cursor: 'pointer', color: 'var(--text)', fontSize: '14px' }}
          >✕</button>
          <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>📸 Screenshot será enviado com a próxima mensagem</div>
        </div>
      )}

      <div className="chat-input-area">
        <div className="chat-input-row">
          <textarea
            className="chat-input"
            placeholder="Mensagem para o Gemini..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button className="btn btn-primary" onClick={handleSend} disabled={isSending}>
            ➤
          </button>
        </div>
      </div>
    </div>
  );
}

function VideoPanel({ settings }) {
  const [selectedFile, setSelectedFile] = useState(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [progress, setProgress] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const unsub = window.electronAPI.onVideoProgress((msg) => setProgress(msg));
    return () => unsub();
  }, []);

  const handlePickFile = async () => {
    const filePath = await window.electronAPI.pickVideoFile();
    if (filePath) {
      setSelectedFile(filePath);
      setTranscriptText('');
      setSavedPath('');
      setError('');
    }
  };

  const handleTranscribe = async () => {
    if (!selectedFile || isTranscribing) return;
    setIsTranscribing(true);
    setError('');
    setTranscriptText('');
    setProgress('Iniciando...');

    const result = await window.electronAPI.transcribeVideo({
      filePath: selectedFile,
      language: settings.language,
    });

    setIsTranscribing(false);
    if (result.error) {
      setError(result.error);
      setProgress('');
    } else {
      setTranscriptText(result.text);
      setSavedPath(result.savedPath);
    }
  };

  const fileName = selectedFile ? selectedFile.split(/[\\/]/).pop() : null;

  return (
    <div className="transcript-panel">
      {/* Seletor de arquivo */}
      <div style={{ padding: '10px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 }}>
        <button className="btn btn-ghost" style={{ width: '100%' }} onClick={handlePickFile} disabled={isTranscribing}>
          📂 Selecionar Vídeo OBS
        </button>
        {fileName && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-card)', borderRadius: 'var(--r-md)', padding: '6px 10px', border: '1px solid var(--border)' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              🎬 {fileName}
            </span>
            <button
              className="btn btn-primary"
              style={{ fontSize: '11px', padding: '4px 10px', flexShrink: 0 }}
              onClick={handleTranscribe}
              disabled={isTranscribing}
            >
              {isTranscribing ? '⏳...' : '▶ Transcrever'}
            </button>
          </div>
        )}
      </div>

      {/* Progresso */}
      {isTranscribing && (
        <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--accent-dim)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div className="spinner" style={{ flexShrink: 0 }} />
          <span style={{ fontSize: '11px', color: 'var(--accent-lite)' }}>{progress}</span>
        </div>
      )}

      {/* Erro */}
      {error && (
        <div style={{ padding: '8px 12px', fontSize: '11px', color: 'var(--danger)', background: 'var(--danger-dim)', borderBottom: '1px solid rgba(239,68,68,0.2)', flexShrink: 0 }}>
          ⚠️ {error}
        </div>
      )}

      {/* Conteúdo transcrito */}
      {transcriptText ? (
        <>
          <div className="transcript-list" style={{ flex: 1 }}>
            {transcriptText.split('\n').filter(Boolean).map((line, i) => (
              <div key={i} className="transcript-item">
                <div className="transcript-text">{line}</div>
              </div>
            ))}
          </div>
          <div style={{ padding: '8px 10px', borderTop: '1px solid var(--border)', display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
            <span style={{ fontSize: '10px', color: 'var(--text-3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={savedPath}>
              💾 {savedPath.split(/[\\/]/).pop()}
            </span>
            <button className="btn btn-ghost" style={{ fontSize: '11px' }} title="Copiar texto" onClick={() => navigator.clipboard.writeText(transcriptText)}>
              📋
            </button>
            <button className="btn btn-ghost" style={{ fontSize: '11px' }} title="Abrir pasta de transcrições" onClick={() => window.electronAPI.openHistoryFolder()}>
              📂
            </button>
          </div>
        </>
      ) : !selectedFile && !isTranscribing && !error ? (
        <div className="transcript-empty">
          <div className="transcript-empty-icon">🎬</div>
          <p>Selecione um vídeo gravado pelo OBS.<br />O áudio será extraído e transcrito com Whisper.</p>
          <div style={{ fontSize: '10px', color: 'var(--text-3)', marginTop: '6px' }}>
            Requer: ffmpeg no PATH + motor Whisper configurado<br />(inicie uma gravação ao vivo uma vez para configurar)
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SettingsModal({ settings, setSettings, onClose }) {
  const [localSettings, setLocalSettings] = useState(settings);

  const handleSave = () => {
    setSettings(localSettings);
    window.electronAPI.saveSettings(localSettings);
    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title">⚙️ Configurações</div>

        <div className="form-group">
          <label className="form-label">Google AI API Key</label>
          <input
            type="password"
            className="form-input"
            placeholder="AIzaSy..."
            value={localSettings.apiKey}
            onChange={e => setLocalSettings({ ...localSettings, apiKey: e.target.value })}
          />
          <div className="form-hint">Necessária para o Chat IA (Gemini).</div>
        </div>

        <div className="form-group">
          <label className="form-label">Idioma da Transcrição</label>
          <select
            className="form-select"
            value={localSettings.language}
            onChange={e => setLocalSettings({ ...localSettings, language: e.target.value })}
          >
            <option value="pt">Português (pt-BR)</option>
            <option value="en">Inglês (en)</option>
            <option value="es">Espanhol (es)</option>
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Engine de Transcrição</label>
          <select
            className="form-select"
            value={localSettings.transcribeProvider || 'local'}
            onChange={e => setLocalSettings({ ...localSettings, transcribeProvider: e.target.value })}
          >
            <option value="local">Local — Whisper.cpp (offline, GPU CUDA)</option>
          </select>
        </div>

        <div className="form-group">
            <label className="form-label">Modelo Whisper Local</label>
            <select
              className="form-select"
              value={localSettings.whisperModel || 'small'}
              onChange={e => setLocalSettings({ ...localSettings, whisperModel: e.target.value })}
            >
              <option value="base">base — 74MB (qualidade baixa)</option>
              <option value="small">small — 244MB (recomendado)</option>
              <option value="medium">medium — 769MB (qualidade alta)</option>
              <option value="large-v3-turbo">large-v3-turbo — 809MB (melhor local)</option>
            </select>
          <div className="form-hint">Baixado automaticamente na primeira gravação.</div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={handleSave}>Salvar</button>
        </div>
      </div>
    </div>
  );
}

function SummaryModal({ apiKey, getFullTranscript, onClose }) {
  const [summary, setSummary] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchSummary = async () => {
      const res = await window.electronAPI.generateSummary({
        transcript: getFullTranscript(),
        apiKey
      });
      setIsLoading(false);
      if (res.summary) {
        setSummary(res.summary);
      } else {
        setSummary('Erro: ' + res.error);
      }
    };
    fetchSummary();
  }, [apiKey, getFullTranscript]);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(summary);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: '90%', maxWidth: '400px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-title" style={{ display: 'flex', justifyContent: 'space-between'}}>
           📋 Notas (Flash Lite)
           <button className="win-btn close" onClick={onClose}>✕</button>
        </div>
        
        {isLoading ? (
          <div className="summary-loading">
            <div className="spinner"></div>
            O Gemini está resumindo a reunião...
          </div>
        ) : (
          <div className="summary-content" style={{ whiteSpace: 'pre-wrap' }}>
             {summary}
          </div>
        )}

        <div className="modal-actions">
           <button className="btn btn-ghost" onClick={copyToClipboard} disabled={isLoading}>
             📋 Copiar Clipboard
           </button>
        </div>
      </div>
    </div>
  );
}
