#!/usr/bin/env python3
"""Stitch card frames + gameplay frames into the trailer, following timeline.json.

    python3 video/assemble.py <gameFramesDir> <cardFramesDir> <soundtrack.wav> <out.mp4>

Hard cuts between segments, each opened with a 4-frame "glitch-in" (RGB split +
sliced rows) to match the game's look. Missing trailing frames hold the last one.
"""
import json
import os
import random
import shutil
import subprocess
import sys

from PIL import Image, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
timeline = json.load(open(os.path.join(HERE, 'timeline.json')))
FPS = timeline['fps']
game_dir, card_dir, wav, out = sys.argv[1:5]
seq = os.path.join(os.path.dirname(os.path.abspath(out)), '_seq')
shutil.rmtree(seq, ignore_errors=True)
os.makedirs(seq)


def glitch(img, k, rng):
    """k = 1..0 strength."""
    w, h = img.size
    r, g, b = img.split()
    shift = int(28 * k)
    r = ImageChops.offset(r, shift, 0)
    b = ImageChops.offset(b, -shift, 0)
    img = Image.merge('RGB', (r, g, b))
    for _ in range(int(10 * k) + 2):
        y = rng.randrange(0, h - 40)
        hh = rng.randrange(8, 60)
        dx = int(rng.uniform(-90, 90) * k)
        band = img.crop((0, y, w, y + hh))
        img.paste(ImageChops.offset(band, dx, 0), (0, y))
    return img


n = 0
rng = random.Random(4)
for s in timeline['segments']:
    src = os.path.join(game_dir if s['type'] == 'game' else card_dir, s['id'])
    files = sorted(f for f in os.listdir(src) if f.endswith('.jpg'))
    if not files:
        sys.exit(f'no frames for {s["id"]} in {src}')
    count = round(s['dur'] * FPS)
    for i in range(count):
        f = os.path.join(src, files[min(i, len(files) - 1)])
        dst = os.path.join(seq, f'{n:05d}.jpg')
        if i < 4 and n > 0:
            im = Image.open(f).convert('RGB')
            glitch(im, 1 - i / 4, rng).save(dst, quality=93)
        else:
            os.symlink(os.path.abspath(f), dst)
        n += 1
    print(f'{s["id"]:>6}: {count} frames ({len(files)} captured)')

print(f'total {n} frames = {n / FPS:.2f}s')
dur = timeline['duration']
cmd = [
    'ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', os.path.join(seq, '%05d.jpg'), '-i', wav,
    # CRF with a VBV cap keeps the grainy footage under ~50 MB for GitHub.
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-maxrate', '4500k', '-bufsize', '9000k',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-af', f'loudnorm=I=-15:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.3,afade=t=out:st={dur - 2.5}:d=2.5',
    '-ar', '48000',
    '-c:a', 'aac', '-b:a', '192k', '-t', str(dur), '-movflags', '+faststart', out,
]
subprocess.run(cmd, check=True)
shutil.rmtree(seq, ignore_errors=True)
print('wrote', out, f'{os.path.getsize(out) / 1e6:.1f} MB')
