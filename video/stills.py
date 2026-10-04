#!/usr/bin/env python3
"""Pull README stills from captured trailer frames.

    python3 video/stills.py <gameFramesDir> <outDir>
"""
import os
import sys

from PIL import Image

frames, out = sys.argv[1:3]
os.makedirs(out, exist_ok=True)
# (segment, frame index, name) — picked by eye from the capture.
PICKS = [
    ('train', 75, 'training'),
    ('train', 200, 'profile'),
    ('echo1', 230, 'echo-fight'),
    ('multi', 150, 'generations'),
    ('over', 175, 'share'),
    ('duel', 45, 'duel-invite'),
]
for seg, i, name in PICKS:
    src = os.path.join(frames, seg, f'{i:05d}.jpg')
    if not os.path.exists(src):
        print('missing', src)
        continue
    im = Image.open(src).convert('RGB').resize((960, 540), Image.LANCZOS)
    dst = os.path.join(out, f'{name}.jpg')
    im.save(dst, quality=86, optimize=True, progressive=True)
    print(dst, os.path.getsize(dst) // 1024, 'KB')
