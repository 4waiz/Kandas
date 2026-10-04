# Trailer pipeline

The 90-second trailer is generated from code, so it can be re-rendered after any change to the game.

1. **Gameplay** — `capture-game.cjs` loads `index.html?capture` (seeded RNG, no realtime loop), lets the autopilot play, and steps the game at exactly 1/60 s, two steps per 30 fps frame. It screenshots the segments listed in `timeline.json`. Each job replays the whole run but renders only the segments it owns, so jobs can run in parallel and still line up:

   ```bash
   npm run build && npx http-server -p 8766 -c-1 . &
   for J in calib,train echo1 multi,over duel; do node video/capture-game.cjs frames $J & done; wait
   ```

   Every SFX the game triggers is logged against video time (`frames/audio-*.json`) instead of being played.

2. **Cards** — `cards.html` holds the hook/title/how/pitch/end cards in the Kanban Studios style. `capture-cards.cjs` renders them frame by frame (animations are a pure function of time).

3. **Soundtrack** — `render-audio.cjs` feeds the music cues from `timeline.json` plus the logged SFX into the game's own `AudioEngine.renderOfflineWav()`. The music and every shot and explosion are synthesized offline, in sync with the footage.

4. **Assemble** — `assemble.py` stitches the frames per `timeline.json` (hard cuts with a short glitch-in) and muxes the soundtrack with ffmpeg into a 1080p30 H.264 MP4.
