const {
  app, BrowserWindow, ipcMain, globalShortcut, session, screen: electronScreen, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const extractZip = require('extract-zip');
const FormData = require('form-data');
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

// ─── Whisper Setup & Download ─────────────────────────────────────────────────
const engineDir = path.join(app.getPath('userData'), 'whisper-engine');
const streamExeUrl = 'https://github.com/ggerganov/whisper.cpp/releases/download/v1.8.4/whisper-bin-cublas-cu12.2.0-x64.zip';

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const WHISPER_MODELS = {
  base: { file: 'ggml-base.bin', size: '74MB' },
  small: { file: 'ggml-small.bin', size: '244MB' },
  medium: { file: 'ggml-medium.bin', size: '769MB' },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo.bin', size: '809MB' },
};

function getModelInfo(modelKey) {
  return WHISPER_MODELS[modelKey] || WHISPER_MODELS['small'];
}

const https = require('https');

function downloadFile(url, dest, updateMsg) {
  return new Promise((resolve, reject) => {
    if (mainWindow) mainWindow.webContents.send('download:progress', updateMsg);
    console.log(`Baixando URL: ${url} para ${dest}`);

    https.get(url, (response) => {
      console.log(`HTTP Status [${url}]: ${response.statusCode}`);
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
        return downloadFile(response.headers.location, dest, updateMsg).then(resolve).catch(reject);
      }
      if (response.statusCode >= 400) {
        return reject(new Error(`Falha ao baixar ${url} (HTTP ${response.statusCode})`));
      }

      const fileStream = fs.createWriteStream(dest);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`Download concluído: ${dest}`);
        resolve();
      });

      fileStream.on('error', (err) => {
        console.error(`Erro ao escrever arquivo ${dest}:`, err);
        fs.unlink(dest, () => reject(err));
      });
    }).on('error', (err) => {
      console.error(`Erro na requisição HTTPS para ${url}:`, err);
      fs.unlink(dest, () => reject(err));
    });
  });
}

// Helper to find whisper-cli.exe
function getCliExePath() {
  const dirs = [path.join(engineDir, 'Release'), engineDir];
  for (const dir of dirs) {
    const p = path.join(dir, 'whisper-cli.exe');
    if (fs.existsSync(p)) return p;
  }
  return path.join(engineDir, 'Release', 'whisper-cli.exe');
}

ipcMain.handle('whisper:setup', async (_, { model } = {}) => {
  if (!fs.existsSync(engineDir)) fs.mkdirSync(engineDir, { recursive: true });

  const cliPath = getCliExePath();
  const info = getModelInfo(model);
  const modelPath = path.join(engineDir, info.file);

  try {
    if (!fs.existsSync(cliPath)) {
      const zipPath = path.join(engineDir, 'whisper.zip');
      await downloadFile(streamExeUrl, zipPath, 'Baixando engine Whisper (NVIDIA GPU)...');
      if (mainWindow) mainWindow.webContents.send('download:progress', 'Extraindo engine...');
      await extractZip(zipPath, { dir: engineDir });
      fs.unlinkSync(zipPath);
    }

    if (!fs.existsSync(modelPath)) {
      const url = `${HF_BASE}/${info.file}`;
      await downloadFile(url, modelPath, `Baixando modelo ${model || 'small'} (${info.size})...`);
    }

    if (mainWindow) mainWindow.webContents.send('download:progress', 'Pronto!');
    return { success: true };
  } catch (err) {
    console.error('Erro no setup do Whisper:', err);
    return { success: false, error: err.message };
  }
});

// ─── Captura de Áudio do Sistema + Transcrição (desktopCapturer → whisper-cli) ─

let isCapturing = false;
let whisperQueue = Promise.resolve();
let activeModel = 'small';
let activeProvider = 'local';
let lastPromptText = '';

// Encode PCM Int16 samples into a valid WAV buffer
function encodeWAV(int16Buffer, sampleRate) {
  const dataLen = int16Buffer.byteLength;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);               // PCM
  buf.writeUInt16LE(1, 22);               // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);  // byte rate
  buf.writeUInt16LE(2, 32);               // block align
  buf.writeUInt16LE(16, 34);              // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  Buffer.from(int16Buffer).copy(buf, 44);
  return buf;
}

function runWhisperCli(wavFile, language) {
  return new Promise((resolve) => {
    const cliPath = getCliExePath();
    const modelPath = path.join(engineDir, getModelInfo(activeModel).file);

    if (!fs.existsSync(cliPath) || !fs.existsSync(modelPath)) {
      console.error('whisper-cli.exe ou modelo não encontrado');
      return resolve([]);
    }

    const args = [
      '-m', modelPath,
      '-f', wavFile,
      '-l', language || 'pt',
      '-t', '4',
      '--no-timestamps',
    ];

    // Passa as últimas falas como contexto para o Whisper continuar corretamente
    if (lastPromptText) {
      args.push('--prompt', lastPromptText);
    }

    const proc = spawn(cliPath, args, { cwd: path.dirname(cliPath) });

    let stdout = '';
    proc.stdout.on('data', d => stdout += d.toString('utf8'));
    proc.stderr.on('data', () => { });
    proc.on('error', err => { console.error('whisper-cli error:', err); resolve([]); });
    proc.on('close', () => {
      const lines = stdout.split('\n')
        .map(l => l.replace(/^\[[\d:.,]+ --> [\d:.]+\]\s*/, '').trim())
        .filter(l => l && l !== '(silence)' && l !== '[BLANK_AUDIO]' && !l.startsWith('whisper_'));

      // Atualizar o prompt com as últimas falas deste chunk (máx ~400 chars)
      if (lines.length > 0) {
        const combined = lines.join(' ');
        lastPromptText = combined.length > 400 ? combined.slice(-400) : combined;
      }

      resolve(lines);
    });
  });
}


// Transcreve via insanely-fast-whisper local (GPU)
// Roteador: local (whisper-cli)
function transcribeChunk(wavFile, language) {
  return runWhisperCli(wavFile, language);
}

// Retorna fontes de tela para getUserMedia no renderer
ipcMain.handle('desktop:get-sources', async () => {
  const { desktopCapturer } = require('electron');
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

// Inicia o modo de captura
ipcMain.handle('capture:start', (_, { language, model }) => {
  isCapturing = true;
  activeModel = model || 'small';
  activeProvider = 'local';
  lastPromptText = '';
  whisperQueue = Promise.resolve();
  console.log(`Captura iniciada. Provider: ${activeProvider}, Idioma: ${language}, Modelo: ${activeModel}`);
  return { success: true };
});

// Para a captura
ipcMain.handle('capture:stop', () => {
  isCapturing = false;
  lastPromptText = '';
  console.log('Captura parada.');
  return true;
});

// Recebe chunks de áudio PCM Int16 do renderer, salva como WAV e transcreve
ipcMain.on('audio:pcm-chunk', (event, { buffer, sampleRate, language }) => {
  if (!isCapturing) return;

  const tmpFile = path.join(os.tmpdir(), `ca_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  const wav = encodeWAV(buffer, sampleRate);
  fs.writeFileSync(tmpFile, wav);

  // Fila sequencial: evita rodar dois whisper-cli ao mesmo tempo
  whisperQueue = whisperQueue.then(async () => {
    if (!isCapturing) { fs.unlink(tmpFile, () => { }); return; }
    const lines = await transcribeChunk(tmpFile, language);
    fs.unlink(tmpFile, () => { });
    for (const line of lines) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('transcribe:chunk', line);
      }
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

  // Suporte a mensagens com imagem (screenshot)
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
      model: 'gemini-2.0-flash',
      contents: formattedMessages,
      config: {
        systemInstruction: { parts: [{ text: systemContent }] },
        temperature: 0.7,
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

// ─── IPC: Compressão de Transcrição / Chat ────────────────────────────────────
// Usado tanto para comprimir chunks antigos da transcrição quanto para comprimir o histórico do chat
ipcMain.handle('ai:compress', async (_, { text, prompt, apiKey }) => {
  if (!apiKey) return { error: 'API Key não configurada' };
  if (!text?.trim()) return { error: 'Sem conteúdo para comprimir' };

  const ai = new GoogleGenAI({ apiKey });
  const finalPrompt = prompt || `Crie um resumo denso e completo do seguinte trecho de reunião, preservando todos os pontos discutidos, decisões, nomes próprios e dados técnicos. O resumo será usado como contexto comprimido:\n\n${text}`;

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-2.0-flash-lite',
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
  console.log('Histórico salvo:', filePath);
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
        parts: [{ text: `Resuma esta reunião em pt-br contendo: Resumo Executivo, Pontos Principais, Decisões e Próximos Passos.\n\n${transcript}` }]
      }],
    });
    return { summary: result.text };
  } catch (err) {
    return { error: err.message };
  }
});
