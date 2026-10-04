#!/usr/bin/env python3
"""/brag-slim cut: a ~22 s launch video re-edited from the trailer's frames.

    python3 video/brag_cut.py <gameFramesDir> <cardFramesDir> <outDir>

Cuts are ranges of *trailer* time (timeline.json). Writes <outDir>/brag.mp4
(poster baked in as frame 0), brag.jpg, and work/ (events for the audio render).
SFX logged during the trailer capture are re-timed onto the cut, so every shot
and explosion stays in sync; music cues are set for the short format.
"""
import glob
import json
import os
import random
import shutil
import subprocess
import sys

from PIL import Image, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
trailer = json.load(open(os.path.join(HERE, 'timeline.json')))
FPS = trailer['fps']
game_dir, card_dir, out_dir = sys.argv[1:4]

# (trailer time, duration) — hook, reveal, three highlights, punchline, CTA.
CUTS = [
    (0.0, 2.4),    # hook: WHAT IF THE FINAL BOSS WAS YOU?
    (5.0, 2.0),    # reveal: SELF PLAY
    (10.2, 2.5),   # it records 15 decisions a second
    (21.0, 2.6),   # a neural net learns you in milliseconds
    (24.6, 2.4),   # THE ORBITER profile
    (34.0, 3.0),   # it plays like you — and predicts your next move
    (64.6, 2.0),   # ~1 KB of weights, infinite rivals (duel)
    (75.6, 1.8),   # INFINITE RIVALS. ZERO CONTENT COST.
    (83.5, 3.0),   # PLAY NOW + link
]
POSTER = os.path.join(card_dir, 'title', '00120.jpg')


def source_frame(t):
    for s in trailer['segments']:
        if s['start'] - 1e-6 <= t < s['start'] + s['dur']:
            src = os.path.join(game_dir if s['type'] == 'game' else card_dir, s['id'])
            files = sorted(f for f in os.listdir(src) if f.endswith('.jpg'))
            i = min(len(files) - 1, int(round((t - s['start']) * FPS)))
            return os.path.join(src, files[i])
    raise SystemExit(f'no segment at t={t}')


def glitch(img, k, rng):
    w, h = img.size
    r, g, b = img.split()
    shift = int(28 * k)
    img = Image.merge('RGB', (ImageChops.offset(r, shift, 0), g, ImageChops.offset(b, -shift, 0)))
    for _ in range(int(10 * k) + 2):
        y = rng.randrange(0, h - 40)
        hh = rng.randrange(8, 60)
        band = img.crop((0, y, w, y + hh))
        img.paste(ImageChops.offset(band, int(rng.uniform(-90, 90) * k), 0), (0, y))
    return img


work = os.path.join(out_dir, 'work')
seq = os.path.join(work, 'seq')
shutil.rmtree(seq, ignore_errors=True)
os.makedirs(seq)
rng = random.Random(9)
n = 0
cut_starts = []
for t0, dur in CUTS:
    cut_starts.append(n / FPS)
    count = round(dur * FPS)
    for i in range(count):
        f = source_frame(t0 + i / FPS)
        dst = os.path.join(seq, f'{n:05d}.jpg')
        if n == 0:
            Image.open(POSTER).convert('RGB').save(dst, quality=95)  # poster as frame 0
        elif i < 3:
            glitch(Image.open(f).convert('RGB'), 1 - i / 3, rng).save(dst, quality=93)
        else:
            os.symlink(os.path.abspath(f), dst)
        n += 1
duration = n / FPS
print(f'{len(CUTS)} cuts, {n} frames = {duration:.2f}s')

# Re-time the trailer's logged SFX onto the cut, plus music cues for 22 s.
sfx = []
for path in glob.glob(os.path.join(game_dir, 'audio-*.json')):
    if path.endswith('audio-none.json'):
        continue
    sfx += json.load(open(path))
events = []
for (t0, dur), b0 in zip(CUTS, cut_starts):
    events += [dict(e, t=e['t'] - t0 + b0) for e in sfx if t0 <= e['t'] < t0 + dur]
s = cut_starts
events += [
    {'t': 0, 'name': 'startMusic', 'args': []},
    {'t': 0, 'name': 'setIntensity', 'args': [1]},
    {'t': s[1], 'name': 'roundStart', 'args': []},
    {'t': s[2], 'name': 'setIntensity', 'args': [2]},
    {'t': s[3], 'name': 'setDuck', 'args': [0.5]},
    {'t': s[5], 'name': 'setDuck', 'args': [0]},
    {'t': s[5], 'name': 'setIntensity', 'args': [3]},
    {'t': s[7], 'name': 'roundClear', 'args': []},
    {'t': s[8], 'name': 'setIntensity', 'args': [1]},
]
events.sort(key=lambda e: e['t'])
ev_path = os.path.join(work, 'events.json')
json.dump({'duration': duration, 'events': events}, open(ev_path, 'w'))
print(f'{len(events)} audio events')

wav = os.path.join(work, 'brag.wav')
subprocess.run(['node', os.path.join(HERE, 'render-events.cjs'), ev_path, wav], check=True)

out = os.path.join(out_dir, 'brag.mp4')
subprocess.run([
    'ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', os.path.join(seq, '%05d.jpg'), '-i', wav,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-maxrate', '6000k', '-bufsize', '12000k',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-af', f'loudnorm=I=-15:TP=-1.5:LRA=11,afade=t=out:st={duration - 1.2:.2f}:d=1.2', '-ar', '48000',
    '-c:a', 'aac', '-b:a', '192k', '-t', f'{duration:.3f}', '-movflags', '+faststart', out,
], check=True)
shutil.copy(POSTER, os.path.join(out_dir, 'brag.jpg'))
shutil.rmtree(seq, ignore_errors=True)
print('wrote', out, f'{os.path.getsize(out) / 1e6:.1f} MB')
