"""Regenerate the runtime sprite asset served by the plugin's node half.

Reads the canonical lossless atlas (spritesheet.webp at the repo root),
lossy-re-encodes it with cwebp (q84, m6, alpha_q 90), and writes the result
to assets/spritesheet.webp — the file the node half serves at
/dsh-plugin-assets/dsh-pet-frieren/spritesheet.webp.

The root spritesheet.webp stays lossless: it is the petdex-canonical pet
asset (pet.json + spritesheet.webp), while assets/ holds the web runtime
copy optimized for transfer size.

Requirements: cwebp on PATH (https://developers.google.com/speed/webp/download)
and Python 3.8+.

Usage:  python scripts/build-assets.py
"""

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "spritesheet.webp"
TARGET = ROOT / "assets" / "spritesheet.webp"
QUALITY = "84"


def main() -> int:
    if not SRC.is_file():
        print(f"error: {SRC} not found", file=sys.stderr)
        return 1

    cmd = [
        "cwebp", "-q", QUALITY, "-m", "6", "-alpha_q", "90",
        str(SRC), "-o", str(TARGET),
    ]
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)
    print(f"wrote {TARGET} ({TARGET.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
