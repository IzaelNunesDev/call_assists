const {
  app, BrowserWindow, ipcMain, globalShortcut, session, screen: electronScreen, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { GoogleGenAI } = require('@google/genai');

const isDev = process.env.NODE_ENV === 'development';

let mainWindow;
let isProtected = true;

// ─── Settings ────────────────────────────────────────────────────────────────
const settingsPath = path.join(app.getPath('userData'), 'callassist-settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (_) { }
  return { apiKey: '', language: 'pt' };
}

function saveSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const { workAreaSize } = electronScreen.getPrimaryDisplay();

  mainWindow = new BrowserWindow({
    width: 390,
    height: 700,
    x: workAreaSize.width - 410,
    y: Math.floor((workAreaSize.height - 700) / 2),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setContentProtection(true);

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    mainWindow?.webContents.send('shortcut:toggle-recording');
  });
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    mainWindow?.webContents.send('shortcut:open-chat');
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  isCapturing = false;
  stopSidecar();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─── IPC: Window Controls ─────────────────────────────────────────────────────
ipcMain.on('window:drag', (_, { x, y }) => mainWindow?.setPosition(x, y, false));
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:get-position', () => mainWindow?.getPosition() ?? [0, 0]);

ipcMain.handle('settings:load', () => loadSettings());
ipcMain.handle('settings:save', (_, settings) => {
  saveSettings(settings);
  return true;
});

ipcMain.handle('protection:toggle', (_, enabled) => {
  if (mainWindow) {
    mainWindow.setContentProtection(enabled);
    isProtected = enabled;
  }
  return isProtected;
});

// ─── Engine directory (shared between whisper.cpp legacy and faster-whisper) ─
const engineDir = path.join(app.getPath('userData'), 'whisper-engine');
if (!fs.existsSync(engineDir)) fs.mkdirSync(engineDir, { recursive: true });

// ─── Progress helper ──────────────────────────────────────────────────────────
function notify(msg) {
  if (mainWindow) mainWindow.webContents.send('download:progress', msg);
  console.log(`[setup] ${msg}`);
}

// ─── Python helpers ───────────────────────────────────────────────────────────

/**
 * Runs a command, captures stdout+stderr, returns {code, stdout, stderr}.
 * Uses shell:false so Python -c args are never split by cmd.exe.
 */
function runSilent(exe, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(exe, args, { shell: false, windowsHide: true, ...opts });
    let stdout = '', stderr = '';
    proc.stdout?.on('data', d => stdout += d.toString());
    proc.stderr?.on('data', d => stderr += d.toString());
    proc.on('error', () => resolve({ code: 1, stdout, stderr }));
    proc.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Runs a command, streams output to console, rejects on non-zero exit. */
function runStreaming(exe, args, progressPrefix = '') {
  return new Promise((resolve, reject) => {
    console.log(`[setup] $ ${exe} ${args.join(' ')}`);
    const proc = spawn(exe, args, { shell: false, windowsHide: true });

    proc.stdout?.on('data', d => {
      const text = d.toString().trim();
      if (!text) return;
      console.log(text);
      // Forward last non-empty line to the UI
      const last = text.split('\n').filter(Boolean).pop() ?? '';
      if (last) notify(`${progressPrefix}${last.slice(0, 70)}`);
    });
    proc.stderr?.on('data', d => {
      const text = d.toString().trim();
      if (text) console.log(text);
    });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`Comando saiu com código ${code}: ${exe} ${args.join(' ')}`));
      else resolve();
    });
  });
}

/**
 * Returns the full path to a Python 3.8+ executable.
 * On Windows the Python Launcher (py) is tried first, then python/python3.
 * Uses shell:false so the -c argument is never split by cmd.exe.
 */
async function findPython() {
  const candidates = [
    { cmd: 'py',      vargs: ['-3', '--version'], pargs: ['-3', '-c', 'import sys\nprint(sys.executable)'] },
    { cmd: 'python',  vargs: ['--version'],        pargs: ['-c',       'import sys\nprint(sys.executable)'] },
    { cmd: 'python3', vargs: ['--version'],        pargs: ['-c',       'import sys\nprint(sys.executable)'] },
  ];

  for (const { cmd, vargs, pargs } of candidates) {
    try {
      const vr = await runSilent(cmd, vargs);
      if (vr.code !== 0) continue;
      const ver = (vr.stdout + vr.stderr).trim();
      // Accept Python 3.8 and above (handles 3.8, 3.9, 3.10 … 3.13+)
      if (!/Python 3\.([89]|[1-9]\d)/.test(ver)) continue;

      const pr = await runSilent(cmd, pargs);
      if (pr.code !== 0) continue;
      const exePath = pr.stdout.trim();
      if (!exePath) continue;

      console.log(`[setup] Python: ${ver}  →  ${exePath}`);
      return exePath;
    } catch (_) { /* try next candidate */ }
  }

  throw new Error(
    'Python 3.8+ não encontrado.\n' +
    'Instale em https://python.org (marque "Add to PATH") e reinicie o app.'
  );
}

// ─── Faster-Whisper Setup ─────────────────────────────────────────────────────

const VENV_DIR    = path.join(engineDir, 'fw-env');
const VENV_PYTHON = path.join(VENV_DIR, 'Scripts', 'python.exe');
const SERVER_DEST = path.join(engineDir, 'transcribe_server.py');
const MODEL_DIR   = path.join(engineDir, 'fw-models');

ipcMain.handle('whisper:setup', async (_, { model } = {}) => {
  const modelSize = model || 'small';

  try {
    // ── 1. Find system Python ─────────────────────────────────────────────────
    notify('Verificando Python...');
    const sysPython = await findPython();

    // ── 2. Create venv (once) ─────────────────────────────────────────────────
    if (!fs.existsSync(VENV_PYTHON)) {
      notify('Criando ambiente virtual Python...');
      await runStreaming(sysPython, ['-m', 'venv', VENV_DIR]);
      console.log('[setup] Venv criado em:', VENV_DIR);
    } else {
      console.log('[setup] Venv já existe:', VENV_DIR);
    }

    // ── 3. Install / upgrade faster-whisper + CUDA 12 runtime libs ───────────
    const check = await runSilent(VENV_PYTHON, ['-c', 'import faster_whisper; print(faster_whisper.__version__)']);
    if (check.code !== 0) {
      notify('Instalando faster-whisper (ctranslate2 + CUDA DLLs ~400 MB, aguarde)...');
      await runStreaming(
        VENV_PYTHON,
        ['-m', 'pip', 'install', '--upgrade', 'faster-whisper'],
        'pip: '
      );
      console.log('[setup] faster-whisper instalado com sucesso');
    } else {
      console.log(`[setup] faster-whisper já instalado: v${check.stdout.trim()}`);
    }

    // Install CUDA 12 runtime libs as pip packages so the GPU works without a
    // system-wide CUDA Toolkit install.  nvidia-cublas-cu12 pulls in
    // nvidia-cuda-runtime-cu12 as a dependency; nvidia-cudnn-cu12 is needed
    // for float16 compute types.
    const cudaCheck = await runSilent(VENV_PYTHON, [
      '-c', 'import nvidia.cublas; import nvidia.cudnn; print("ok")',
    ]);
    if (cudaCheck.code !== 0) {
      notify('Instalando CUDA 12 runtime (cuBLAS + cuDNN ~600 MB, aguarde)...');
      await runStreaming(
        VENV_PYTHON,
        ['-m', 'pip', 'install', '--upgrade',
          'nvidia-cublas-cu12', 'nvidia-cudnn-cu12'],
        'pip cuda: '
      );
      console.log('[setup] CUDA runtime instalado com sucesso');
    } else {
      console.log('[setup] CUDA runtime (cuBLAS + cuDNN) já instalado');
    }

    // ── 4. Copy sidecar script to engineDir ───────────────────────────────────
    const serverSrc = path.join(__dirname, '..', 'python', 'transcribe_server.py');
    fs.copyFileSync(serverSrc, SERVER_DEST);
    console.log('[setup] transcribe_server.py → ', SERVER_DEST);

    // ── 5. Ensure model cache directory exists ────────────────────────────────
    if (!fs.existsSync(MODEL_DIR)) fs.mkdirSync(MODEL_DIR, { recursive: true });

    // ── 6. Start (or restart) the persistent sidecar process ─────────────────
    notify(`Carregando modelo '${modelSize}' na GPU (primeira vez faz download ~244 MB)...`);
    await startSidecar(modelSize);

    notify('Pronto!');
    return { success: true };

  } catch (err) {
    console.error('[setup] ERRO:', err.message);
    return { success: false, error: err.message };
  }
});

// ─── Faster-Whisper Sidecar ───────────────────────────────────────────────────

let sidecarProcess      = null;
let sidecarReady        = false;
let sidecarModel        = null;   // which model is currently loaded
let sidecarPendingResolve = null; // resolve for the in-flight transcription request
let sidecarStdoutBuf    = '';     // partial-line buffer

/**
 * Starts (or restarts) the Python sidecar with the given model.
 * Resolves when the sidecar sends {"status":"ready"}.
 */
function startSidecar(modelSize) {
  // Nothing to do if the same model is already running
  if (sidecarProcess && sidecarReady && sidecarModel === modelSize) {
    console.log(`[sidecar] Já em execução com modelo '${modelSize}' — reutilizando`);
    return Promise.resolve();
  }

  // Kill existing process if model changed
  if (sidecarProcess) {
    console.log('[sidecar] Modelo diferente — reiniciando sidecar...');
    stopSidecar();
  }

  if (!fs.existsSync(VENV_PYTHON)) {
    return Promise.reject(new Error('Venv não encontrado. Execute o setup primeiro.'));
  }
  if (!fs.existsSync(SERVER_DEST)) {
    return Promise.reject(new Error('transcribe_server.py não encontrado no engineDir.'));
  }

  const env = {
    ...process.env,
    FW_MODEL:       modelSize,
    FW_DEVICE:      'cuda',
    FW_COMPUTE:     'int8_float16',
    FW_MODEL_DIR:   MODEL_DIR,
    FW_CPU_THREADS: String(Math.max(4, os.cpus().length / 2 | 0)),
    PYTHONUNBUFFERED:   '1',
    PYTHONIOENCODING:   'utf-8',
    // Desativa o protocolo XetHub do HuggingFace Hub (usa HTTP padrão para model.bin)
    HF_HUB_DISABLE_XET: '1',
  };

  console.log(`[sidecar] Iniciando — modelo='${modelSize}'`);

  sidecarProcess   = spawn(VENV_PYTHON, [SERVER_DEST], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  sidecarReady     = false;
  sidecarModel     = modelSize;
  sidecarStdoutBuf = '';

  return new Promise((resolve, reject) => {
    // 10-minute timeout (first run downloads the CTranslate2 model)
    const timeout = setTimeout(() => {
      reject(new Error('[sidecar] Timeout de 10 min aguardando inicialização'));
    }, 10 * 60 * 1000);

    // ── stdout: JSON protocol ─────────────────────────────────────────────────
    sidecarProcess.stdout.on('data', d => {
      sidecarStdoutBuf += d.toString('utf8');
      const parts = sidecarStdoutBuf.split('\n');
      sidecarStdoutBuf = parts.pop(); // keep incomplete trailing line

      for (const line of parts) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); }
        catch { console.warn('[sidecar] JSON inválido ignorado:', line); continue; }

        if (msg.status === 'ready') {
          clearTimeout(timeout);
          sidecarReady = true;
          console.log(
            `[sidecar] ✓ Pronto!  device=${msg.device}  compute=${msg.compute}  model=${msg.model}`
          );
          resolve();
        } else if (sidecarPendingResolve) {
          const cb = sidecarPendingResolve;
          sidecarPendingResolve = null;
          cb(msg);
        } else {
          console.warn('[sidecar] Resposta inesperada sem requisição pendente:', line);
        }
      }
    });

    // ── stderr: diagnostic logs forwarded verbatim ────────────────────────────
    sidecarProcess.stderr.on('data', d => {
      const text = d.toString('utf8');
      // Log every line from the Python process
      text.split('\n').forEach(l => { if (l.trim()) console.log(l); });
      // Forward progress keywords to the UI overlay
      if (/baixando|downloading|carregando|loading|pronto|ready/i.test(text)) {
        const last = text.split('\n').filter(Boolean).pop()?.replace(/^\[fw\]\s*\w+\s+/, '') ?? '';
        if (last) notify(last.slice(0, 80));
      }
    });

    // ── process error / exit ──────────────────────────────────────────────────
    sidecarProcess.on('error', err => {
      console.error('[sidecar] Erro no processo:', err.message);
      clearTimeout(timeout);
      sidecarReady   = false;
      sidecarProcess = null;
      if (sidecarPendingResolve) { sidecarPendingResolve({ error: err.message, lines: [] }); sidecarPendingResolve = null; }
      reject(err);
    });

    sidecarProcess.on('exit', (code, signal) => {
      console.log(`[sidecar] Processo encerrado (code=${code}, signal=${signal})`);
      sidecarReady   = false;
      sidecarProcess = null;
      if (sidecarPendingResolve) {
        sidecarPendingResolve({ error: 'Sidecar encerrado inesperadamente', lines: [] });
        sidecarPendingResolve = null;
      }
    });
  });
}

/** Gracefully stops the sidecar (closes stdin, then force-kills after 3 s). */
function stopSidecar() {
  if (!sidecarProcess) return;
  console.log('[sidecar] Encerrando...');
  try { sidecarProcess.stdin.end(); } catch (_) {}
  const proc = sidecarProcess;
  sidecarProcess = null;
  sidecarReady   = false;
  setTimeout(() => { try { proc.kill(); } catch (_) {} }, 3000);
}

// ─── Captura de Áudio do Sistema + Transcrição ────────────────────────────────

let isCapturing  = false;
let whisperQueue = Promise.resolve();
let activeModel  = 'small';

/** Encode raw PCM Int16 samples into a WAV buffer. */
function encodeWAV(int16Buffer, sampleRate) {
  const dataLen = int16Buffer.byteLength;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);              // PCM
  buf.writeUInt16LE(1, 22);             // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);             // block align
  buf.writeUInt16LE(16, 34);            // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  Buffer.from(int16Buffer).copy(buf, 44);
  return buf;
}

/**
 * Sends a WAV file to the persistent sidecar and waits for the transcription.
 * The whisperQueue already serialises calls, so we never have two in-flight.
 */
function runFasterWhisper(wavFile, language) {
  return new Promise((resolve) => {
    if (!sidecarProcess || !sidecarReady) {
      console.error('[sidecar] Processo não disponível — chunk ignorado');
      return resolve([]);
    }

    sidecarPendingResolve = (msg) => {
      if (msg.error) {
        console.error(`[sidecar] Erro na transcrição: ${msg.error}`);
        return resolve([]);
      }
      const { lines = [], elapsed_ms, lang_detected } = msg;
      if (lines.length > 0) {
        console.log(`[sidecar] ${elapsed_ms} ms  |  ${lines.length} linha(s)  |  lang=${lang_detected}`);
      }
      resolve(lines);
    };

    sidecarProcess.stdin.write(
      JSON.stringify({ file: wavFile, language: language || 'pt' }) + '\n'
    );
  });
}

function transcribeChunk(wavFile, language) {
  return runFasterWhisper(wavFile, language);
}

// ─── IPC: Desktop Sources ─────────────────────────────────────────────────────
ipcMain.handle('desktop:get-sources', async () => {
  const { desktopCapturer } = require('electron');
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

// ─── IPC: Capture Start / Stop ────────────────────────────────────────────────
ipcMain.handle('capture:start', (_, { language, model }) => {
  isCapturing  = true;
  activeModel  = model || 'small';
  whisperQueue = Promise.resolve();
  console.log(`[capture] Iniciada  idioma=${language}  modelo=${activeModel}  sidecar=${sidecarReady ? 'pronto' : 'NÃO PRONTO'}`);
  return { success: true };
});

ipcMain.handle('capture:stop', () => {
  isCapturing = false;
  console.log('[capture] Parada.');
  return true;
});

// ─── IPC: Audio PCM Chunks ────────────────────────────────────────────────────
ipcMain.on('audio:pcm-chunk', (event, { buffer, sampleRate, language }) => {
  if (!isCapturing) return;

  const tmpFile = path.join(
    os.tmpdir(),
    `ca_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`
  );
  fs.writeFileSync(tmpFile, encodeWAV(buffer, sampleRate));

  // Serial queue — never runs two transcriptions concurrently
  whisperQueue = whisperQueue.then(async () => {
    if (!isCapturing) { fs.unlink(tmpFile, () => {}); return; }
    const lines = await transcribeChunk(tmpFile, language);
    fs.unlink(tmpFile, () => {});
    for (const line of lines) {
      if (!event.sender.isDestroyed()) event.sender.send('transcribe:chunk', line);
    }
  });
});

// ─── IPC: AI Chat (Gemini) ────────────────────────────────────────────────────
ipcMain.handle('chat:send', async (event, { messages, transcript, apiKey }) => {
  if (!apiKey) {
    event.sender.send('chat:stream-chunk', '⚠️ Configure sua Google API Key nas configurações.');
    event.sender.send('chat:stream-done');
    return;
  }

  const ai = new GoogleGenAI({ apiKey });

  const systemContent = `Você é um assistente de reuniões.
CONTEXTO DA REUNIÃO ATÉ AGORA:
───────────────────────────────
${transcript || '(Ainda não há transcrição disponível)'}
───────────────────────────────
Responda sempre em português do Brasil de forma concisa.`;

  const formattedMessages = messages.map(m => {
    const parts = [{ text: m.content || '' }];
    if (m.image) {
      const base64 = m.image.replace(/^data:image\/\w+;base64,/, '');
      parts.push({ inlineData: { mimeType: 'image/png', data: base64 } });
    }
    return { role: m.role === 'assistant' ? 'model' : m.role, parts };
  });

  try {
    const stream = await ai.models.generateContentStream({
      model: 'gemini-3.1-flash-lite-preview',
      contents: formattedMessages,
      config: {
        systemInstruction: { parts: [{ text: systemContent }] },
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 1024,
      },
    });
    for await (const chunk of stream) {
      if (chunk.text) event.sender.send('chat:stream-chunk', chunk.text);
    }
  } catch (err) {
    event.sender.send('chat:stream-chunk', `\n\n⚠️ Erro: ${err.message}`);
  } finally {
    event.sender.send('chat:stream-done');
  }
});

// ─── IPC: Compressão de Transcrição ──────────────────────────────────────────
ipcMain.handle('ai:compress', async (_, { text, prompt, apiKey }) => {
  if (!apiKey) return { error: 'API Key não configurada' };
  if (!text?.trim()) return { error: 'Sem conteúdo para comprimir' };

  const ai = new GoogleGenAI({ apiKey });
  const finalPrompt = prompt ||
    `Crie um resumo denso e completo do seguinte trecho de reunião, preservando todos os pontos discutidos, decisões, nomes próprios e dados técnicos. O resumo será usado como contexto comprimido:\n\n${text}`;

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview',
      contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
    });
    return { summary: result.text };
  } catch (err) {
    return { error: err.message };
  }
});

// ─── IPC: Screenshot ──────────────────────────────────────────────────────────
ipcMain.handle('screenshot:capture', async () => {
  const { desktopCapturer } = require('electron');
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 },
    });
    if (!sources.length) return { error: 'Nenhuma tela encontrada' };
    return { dataUrl: sources[0].thumbnail.toDataURL() };
  } catch (err) {
    return { error: err.message };
  }
});

// ─── IPC: Histórico de Transcrições ──────────────────────────────────────────
ipcMain.handle('history:save', (_, { filename, content }) => {
  const histDir = path.join(app.getPath('userData'), 'transcripts');
  if (!fs.existsSync(histDir)) fs.mkdirSync(histDir, { recursive: true });
  const filePath = path.join(histDir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('[history] Salvo:', filePath);
  return { path: filePath };
});

ipcMain.handle('history:open-folder', () => {
  const histDir = path.join(app.getPath('userData'), 'transcripts');
  if (!fs.existsSync(histDir)) fs.mkdirSync(histDir, { recursive: true });
  shell.openPath(histDir);
});

// ─── IPC: Meeting Summary ─────────────────────────────────────────────────────
ipcMain.handle('summary:generate', async (_, { transcript, apiKey }) => {
  if (!apiKey) return { error: 'API Key não configurada' };
  if (!transcript?.trim()) return { error: 'Nenhuma transcrição disponível' };

  const ai = new GoogleGenAI({ apiKey });

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview',
      contents: [{
        role: 'user',
        parts: [{ text: `Resuma esta reunião em pt-br contendo: Resumo Executivo, Pontos Principais, Decisões e Próximos Passos.\n\n${transcript}` }],
      }],
    });
    return { summary: result.text };
  } catch (err) {
    return { error: err.message };
  }
});
