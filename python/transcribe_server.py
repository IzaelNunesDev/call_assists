#!/usr/bin/env python3
"""
Faster-Whisper persistent transcription sidecar for call-assists.

Protocol — line-delimited JSON over stdin / stdout:
  Request  → {"file": "/abs/path.wav", "language": "pt"}
  Response ← {"lines": ["...", "..."], "elapsed_ms": 421, "lang_detected": "pt"}
           ← {"error": "...", "lines": []}   (on failure)
  Ready    ← {"status": "ready", "device": "cuda", "compute": "int8_float16", "model": "small"}

All diagnostic output goes to stderr (forwarded to the Electron console by main.js).
"""

import sys
import json
import time
import os
import logging

# ── Logging (stderr only — stdout is reserved for the JSON protocol) ──────────
logging.basicConfig(
    level=logging.DEBUG,
    format="[fw] %(levelname)-8s %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger(__name__)

# ── Config from env vars (injected by main.js) ────────────────────────────────
MODEL_SIZE   = os.environ.get("FW_MODEL",     "small")
DEVICE       = os.environ.get("FW_DEVICE",    "cuda")
COMPUTE_TYPE = os.environ.get("FW_COMPUTE",   "int8_float16")
MODEL_DIR    = os.environ.get("FW_MODEL_DIR", None)  # where CTranslate2 models are cached
CPU_THREADS  = int(os.environ.get("FW_CPU_THREADS", str(max(4, (os.cpu_count() or 4) // 2))))


def _model_is_cached(model_size: str, model_dir) -> bool:
    """Return True if the CTranslate2 snapshot is already on disk."""
    base = model_dir or os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
    snapshots = os.path.join(base, f"models--Systran--faster-whisper-{model_size}", "snapshots")
    return os.path.isdir(snapshots) and bool(os.listdir(snapshots))


def _cuda_runtime_available() -> bool:
    """Check that the CUDA 12 runtime DLLs are loadable before trying GPU.

    Handles two install scenarios:
      • System-wide CUDA Toolkit → DLLs are on PATH, ctypes finds them directly.
      • pip nvidia-cublas-cu12 / nvidia-cudnn-cu12 → DLLs live inside the venv
        under site-packages/nvidia/<pkg>/bin/; must be registered via
        os.add_dll_directory() before ctypes can load them.
    """
    import ctypes
    import site

    # Register every nvidia pip-package bin dir so ctypes can find the DLLs.
    try:
        sp_dirs = site.getsitepackages()
    except AttributeError:
        sp_dirs = [os.path.dirname(os.__file__)]  # fallback for some envs

    for sp in sp_dirs:
        nvidia_root = os.path.join(sp, "nvidia")
        if not os.path.isdir(nvidia_root):
            continue
        for pkg in os.listdir(nvidia_root):
            bin_dir = os.path.join(nvidia_root, pkg, "bin")
            if os.path.isdir(bin_dir):
                try:
                    os.add_dll_directory(bin_dir)
                except Exception:
                    pass

    # cublas64_12.dll is the only hard requirement for CTranslate2 GPU inference.
    # cudart64_12.dll is bundled inside cublas on pip installs and loaded implicitly.
    try:
        ctypes.cdll.LoadLibrary("cublas64_12.dll")
        return True
    except OSError:
        log.warning("CUDA runtime ausente (cublas64_12.dll) — GPU será ignorada")
        return False


# ── Model loader ─────────────────────────────────────────────────────────────
def load_model():
    from faster_whisper import WhisperModel

    # If the model is already on disk, skip all Hub network calls.
    if _model_is_cached(MODEL_SIZE, MODEL_DIR):
        log.info("Modelo encontrado em cache local — ativando modo offline (sem rede)")
        os.environ["HF_HUB_OFFLINE"] = "1"
    else:
        log.info("Modelo não encontrado localmente — será feito download do HuggingFace Hub")

    cuda_ok = _cuda_runtime_available()

    # Try configurations from best to most compatible; skip GPU if DLLs are missing.
    attempts = [
        (DEVICE,  COMPUTE_TYPE),   # primary  — GPU int8_float16 (least VRAM)
        ("cuda",  "float16"),      # fallback — GPU float16
        ("cpu",   "int8"),         # last resort — CPU int8 (no CUDA dependency)
    ]

    for device, compute in attempts:
        if device == "cuda" and not cuda_ok:
            log.info(f"Pulando {device}/{compute} — CUDA runtime indisponível")
            continue

        log.info(f"Tentando: model={MODEL_SIZE!r}  device={device}  compute={compute}")
        t0 = time.time()

        # Retry loop: handles HuggingFace 429 rate-limit during download
        last_exc = None
        for attempt in range(5):
            try:
                model = WhisperModel(
                    MODEL_SIZE,
                    device=device,
                    compute_type=compute,
                    download_root=MODEL_DIR,
                    num_workers=2,
                    cpu_threads=CPU_THREADS,
                )
                ms = int((time.time() - t0) * 1000)
                log.info(f"Modelo carregado em {ms} ms  (device={device}, compute={compute})")
                return model, device, compute

            except Exception as exc:
                msg = str(exc)
                if "429" in msg and attempt < 4:
                    wait = 10 * (2 ** attempt)   # 10 s, 20 s, 40 s, 80 s
                    log.warning(
                        f"HuggingFace Hub rate-limited (429) — "
                        f"aguardando {wait}s antes do retry {attempt + 1}/4..."
                    )
                    time.sleep(wait)
                    last_exc = exc
                else:
                    last_exc = exc
                    break   # non-429 error or retries exhausted → try next config

        log.warning(f"Falha em {device}/{compute}: {last_exc}")

    raise RuntimeError("Não foi possível carregar o modelo em nenhuma configuração disponível.")


# ── Core transcription ────────────────────────────────────────────────────────
def transcribe(model, wav_file: str, language: str):
    t0 = time.time()

    # language=None triggers auto-detect
    lang_arg = None if language in ("auto", "") else language

    # model.transcribe() returns a lazy generator — iterate to completion
    segments_iter, info = model.transcribe(
        wav_file,
        language=lang_arg,
        beam_size=5,
        best_of=5,
        temperature=0.0,
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
        condition_on_previous_text=False,  # prevents hallucination across chunks
        vad_filter=True,
        vad_parameters=dict(
            min_silence_duration_ms=300,
            speech_pad_ms=200,
            threshold=0.5,
        ),
        without_timestamps=True,
    )

    lines = []
    for seg in segments_iter:
        text = seg.text.strip()
        if text and text.lower() not in {"(silence)", "[blank_audio]", ""}:
            lines.append(text)

    elapsed_ms = int((time.time() - t0) * 1000)
    lp = f"{info.language_probability:.0%}" if info.language_probability else "n/a"
    log.info(
        f"Transcrito em {elapsed_ms} ms  |  "
        f"lang={info.language}({lp})  |  "
        f"{len(lines)} segmento(s)"
    )
    return lines, elapsed_ms, info.language


# ── I/O helpers ───────────────────────────────────────────────────────────────
def send(obj: dict):
    """Write a JSON line to stdout (the protocol channel)."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle(model, raw_line: str):
    """Process one incoming JSON request."""
    try:
        req  = json.loads(raw_line)
        wav  = req["file"]
        lang = req.get("language", "pt")
        log.debug(f"Recebido: {os.path.basename(wav)}  lang={lang}")

        lines, elapsed_ms, detected = transcribe(model, wav, lang)
        send({"lines": lines, "elapsed_ms": elapsed_ms, "lang_detected": detected})

    except Exception as exc:
        log.error(f"Erro ao transcrever: {exc}", exc_info=True)
        send({"error": str(exc), "lines": []})


# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    log.info("=== Sidecar iniciando ===")
    log.info(f"Python {sys.version.split()[0]}  |  PID {os.getpid()}")

    model, used_device, used_compute = load_model()

    # Announce readiness to Electron (triggers sidecarReadyResolve in main.js)
    send({
        "status":  "ready",
        "device":  used_device,
        "compute": used_compute,
        "model":   MODEL_SIZE,
    })
    log.info(f"=== Sidecar pronto — aguardando requisições ===")

    buf = ""
    for raw in sys.stdin:
        buf += raw
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            line = line.strip()
            if line:
                handle(model, line)

    log.info("stdin fechado — encerrando.")


if __name__ == "__main__":
    main()
