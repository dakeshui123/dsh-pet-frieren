"""Regenerate the sprite payload embedded in lib/client.js.

Reads the canonical lossless atlas (spritesheet.webp at the repo root),
lossy-re-encodes it with cwebp (q84, m6, alpha_q 90) to keep the client
bundle small, and swaps the base64 payload into the `__DSH_PET_SPRITE_B64__`
placeholder inside lib/client.js.

Requirements: cwebp on PATH (https://developers.google.com/speed/webp/download)
and Python 3.8+.

Usage:  python scripts/build-assets.py
"""

import base64
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "spritesheet.webp"
TARGET = ROOT / "lib" / "client.js"
TMP = ROOT / "spritesheet.embedded.webp"
PLACEHOLDER = "__DSH_PET_SPRITE_B64__"
QUALITY = "84"


def main() -> int:
    if not SRC.is_file():
        print(f"error: {SRC} not found", file=sys.stderr)
        return 1

    cmd = [
        "cwebp", "-q", QUALITY, "-m", "6", "-alpha_q", "90",
        str(SRC), "-o", str(TMP),
    ]
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)

    payload = base64.b64encode(TMP.read_bytes()).decode("ascii")
    TMP.unlink(missing_ok=True)

    text = TARGET.read_text(encoding="utf-8")
    if PLACEHOLDER not in text:
        print(f"error: placeholder {PLACEHOLDER} not found in {TARGET}", file=sys.stderr)
        return 1
    TARGET.write_text(text.replace(PLACEHOLDER, payload), encoding="utf-8")
    print(f"embedded {len(payload)} base64 chars into {TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
