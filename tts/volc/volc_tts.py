"""火山引擎豆包语音合成 2.0（seed-tts-2.0）HTTP 单向流式 V3 客户端。

凭证在同目录 credentials.json（权限 600，不进代码）：appid / access_token / resource_id / speaker。
synth(text, context=..., speech_rate=0) -> (pcm int16 ndarray, sample_rate)
"""
from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
SR = 24000


def creds() -> dict:
    p = HERE / "credentials.json"
    if not p.exists():  # 凭证沿用 movie4（用户在 movie4 指定的豆包 2.0 账号），不复制、不打印
        p = Path("/Users/yednc/Dev/movie4/tts/volc/credentials.json")
    return json.loads(p.read_text())


def synth(text: str, context: str | None = None, speech_rate: int = 0, loudness_rate: int = 0,
          speaker: str | None = None, retries: int = 3, timeout: float = 60.0) -> tuple[np.ndarray, int, dict]:
    """返回 (单声道 int16 PCM, 采样率, 调试信息)。context 为自然语言情绪/语气描述（additions.context_texts，只取第一条）。"""
    c = creds()
    additions = {}
    if context:
        additions["context_texts"] = [context]
    body = {
        "user": {"uid": "movie5-baixun"},
        "req_params": {
            "text": text,
            "speaker": speaker or c["speaker"],
            "audio_params": {"format": "pcm", "sample_rate": SR, "speech_rate": int(speech_rate),
                             "loudness_rate": int(loudness_rate)},
            "additions": json.dumps(additions, ensure_ascii=False),
        },
    }
    headers = {
        "Content-Type": "application/json",
        "X-Api-App-Id": c["appid"],
        "X-Api-Access-Key": c["access_token"],
        "X-Api-Resource-Id": c.get("resource_id", "seed-tts-2.0"),
        "X-Api-Request-Id": str(uuid.uuid4()),
    }
    last = None
    for k in range(retries):
        req = urllib.request.Request(URL, data=json.dumps(body, ensure_ascii=False).encode(), headers=headers,
                                     method="POST")
        chunks, info = [], {"lines": 0, "codes": []}
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                info["logid"] = r.headers.get("X-Tt-Logid")
                buf = b""
                while True:
                    part = r.read(65536)
                    if not part:
                        break
                    buf += part
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        _eat(line, chunks, info)
                if buf.strip():
                    _eat(buf, chunks, info)
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}: {e.read()[:400].decode('utf-8', 'replace')}"
        except Exception as e:  # 网络抖动
            last = f"{type(e).__name__}: {e}"
        else:
            bad = [x for x in info["codes"] if x not in (0, 20000000)]
            if chunks and not bad:
                pcm = np.frombuffer(b"".join(chunks), dtype="<i2")
                return pcm, SR, info
            last = f"codes {info['codes'][:5]} msg {info.get('message')}"
        time.sleep(1.5 * (k + 1))
    raise RuntimeError(f"volc tts failed: {last}")


def _eat(line: bytes, chunks: list, info: dict):
    line = line.strip()
    if not line:
        return
    j = json.loads(line)
    info["lines"] += 1
    code = j.get("code", 0)
    info["codes"].append(code)
    if j.get("message"):
        info["message"] = j["message"]
    if j.get("data"):
        chunks.append(base64.b64decode(j["data"]))
    for k in ("sentence", "usage"):
        if j.get(k):
            info.setdefault(k, []).append(j[k])


if __name__ == "__main__":
    import sys
    import soundfile as sf
    text = sys.argv[1] if len(sys.argv) > 1 else "只剩一周了。"
    ctx = sys.argv[2] if len(sys.argv) > 2 else None
    pcm, sr, info = synth(text, ctx)
    out = HERE / "raw" / "smoke.wav"
    sf.write(str(out), pcm, sr, subtype="PCM_16")
    print(f"ok {len(pcm) / sr:.2f}s  lines={info['lines']} codes={sorted(set(info['codes']))} logid={info.get('logid')}")
    for k in ("sentence", "usage"):
        if k in info:
            print(k, json.dumps(info[k][-1], ensure_ascii=False)[:300])
