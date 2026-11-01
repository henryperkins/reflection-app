"""Build lossless, alpha-preserving delivery images; never rewrite the originals.

Run with Python 3 + Pillow: python3 scripts/optimize-illustrations.py
"""

import hashlib
import json
from pathlib import Path

from PIL import Image


root = Path(__file__).resolve().parents[1] / 'src/client/design/art'
output = root / 'optimized'
output.mkdir(exist_ok=True)
widths = {
    'spread-ribbon': [320, 640, 960],
    'account-sprig': [160, 320, 560],
    'three-card-spread': [320, 640],
    'mobile-corner': [80, 160, 240],
}
manifest = {}
for name, sizes in widths.items():
    original = root / f'{name}.png'
    image = Image.open(original)
    assert image.mode == 'RGBA' and image.getextrema()[3] == (0, 255), name
    variants = []
    for width in sizes:
        height = round(image.height * width / image.width)
        resized = image.resize((width, height), Image.Resampling.LANCZOS)
        target = output / f'{name}-{width}.webp'
        resized.save(target, format='WEBP', lossless=True, quality=100, method=6, exact=True)
        # Lossless applies to every RGBA channel, including the antialiased alpha edge.
        decoded = Image.open(target).convert('RGBA')
        assert decoded.tobytes() == resized.tobytes(), target
        assert decoded.getextrema()[3] == (0, 255), target
        variants.append({'file': target.name, 'width': width, 'height': height,
                         'bytes': target.stat().st_size})
    manifest[name] = {
        'original': original.name,
        'width': image.width,
        'height': image.height,
        'originalBytes': original.stat().st_size,
        'sha256': hashlib.sha256(original.read_bytes()).hexdigest(),
        'variants': variants,
    }
(output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
for name, data in manifest.items():
    print(name, data['originalBytes'], '->',
          ', '.join(f"{v['width']}w: {v['bytes']} bytes" for v in data['variants']))
