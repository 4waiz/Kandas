# SELF PLAY — you are the training data

![SELF PLAY](media/cover.jpg)

> **A three.js arena shooter where a neural network trains on how *you* play — live, in your browser — then becomes your rival and predicts your next move.**

**▶ Play:** https://4waiz.github.io/self-play/ &nbsp;·&nbsp; **🎬 Trailer:** [watch](https://4waiz.github.io/self-play/trailer.mp4) · [`media/self-play-trailer.mp4`](media/self-play-trailer.mp4) &nbsp;·&nbsp; **Built by [Team Kanban](https://kanbanstudios.ae/team-kanban) — by Awaiz Ahmed** &nbsp;·&nbsp; Tencent × Arcade AI Hackathon · Cambridge 2026 (Game Tech track)

---

## The idea

Every game has AI enemies. They're all written by a designer, and after an hour you've seen all of them.

**SELF PLAY's enemy is written by you.** For the first 25 seconds you just play — move, aim, dash, shoot. The game quietly records **15 of your decisions every second**. Then a small neural network trains on that data **right there in the browser**, in well under a second, and spawns as your **Echo**: a clone that moves, dodges and shoots *the way you do*.

The same model also **predicts where you're about to move**. A live **PREDICTABILITY** meter shows how well it can read you, and your Echo aims at where it thinks you'll be. To win you have to **break your own habits**. Every round, another generation of you joins the fight.

When you lose, you can **send your Echo to a friend**. The trained weights fit in the link itself (~1 KB), so your friend fights *your brain* with no server, account or install.

## Meet the cast

| | Who | What it does |
|---|---|---|
| ◆ | **ECHO** (you) | A clone driven by a neural net trained on your play. Each generation takes one of your traits as a personality: **The Strafer** (you circle), **The Dasher**, **The Sniper**, **The Brawler**, **The Turret**, or **The Wildcard**. The trait tunes how it plays and shows on its nameplate, e.g. *"GEN 2 — THE STRAFER learned that you circle counter-clockwise."* |
| ▲ | **BIT** | Orange chaser. Touch hurts; dash through it to pop it. |
| ◇ | **BYTE** | Keeps its distance and lobs slow bolts. |
| ▶ | **LEECH** | Pink pack hunter. Latches on and drains your *score*, dies in one hit. |
| ⬡ | **MIRROR** | Walks your exact path from two seconds ago and fires where the model predicts you'll be. Repeating a route walks you into it. |
| ⬢ | **WARDEN** | Boss at the end of round 3+. A ring shield eats your bullets; dash through the ring to open it, then hit it fast. |

Every new character gets a name card the first time it appears. The predictability meter flinches whenever a Mirror or Echo lands a prediction-based hit.

## Screenshots

| | |
|---|---|
| ![The network trains on your recorded decisions](media/stills/training.jpg) | ![The AI's read on your playstyle](media/stills/profile.jpg) |
| **Train** — your decisions stream into a live neural network | **Profile** — what the AI learned about you |
| ![Fighting your Echo, with the prediction ghost](media/stills/echo-fight.jpg) | ![Several generations of you](media/stills/generations.jpg) |
| **Fight yourself** — the pink ring is where it predicts you'll go | **Generations** — every round, another you joins |
| ![Send your Echo as a link](media/stills/share.jpg) | ![A friend receives the challenge](media/stills/duel-invite.jpg) |
| **Share** — the weights fit in the URL | **Duel** — your friend fights your brain |

## The loop

| | | |
|---|---|---|
| **1 · PLAY** | *Round 1: Calibration* | Fight drones for 25 s. Each recorded decision leaves a glowing dot where you stood. |
| **2 · TRAIN** | *The interlude* | The dots lift off and stream into a 3D neural network floating above the arena. You watch it train: live loss curve, epochs, weights flickering. |
| **3 · PROFILE** | *"The AI thinks you are…"* | A playstyle read-out: archetype (Orbiter, Berserker, Phantom…), a six-axis radar, and concrete habits such as *"You circle counter-clockwise 94% of the time."* |
| **4 · FIGHT YOURSELF** | *Round 2+* | Your Echo plays like you and predicts you. Beat it, it retrains on your newest moves, and the next round brings every generation back. |
| **5 · SHARE** | *Async PvP* | Copy a challenge link that holds your Echo. Your friend duels your clone and can send theirs back. |

## The AI, for real (no scripted "AI")

Everything is hand-written in plain JavaScript in [`src/nn.js`](src/nn.js) and [`src/brain.js`](src/brain.js). There's no ML library, no server and no API key.

- **Observations (16 features).** These are expressed in a frame anchored on the line to your current target (+z = towards it, +x = to its right): distance and closeness, the target's velocity, the vector to the arena centre, the nearest incoming bullet's position, velocity and proximity, your previous move, dash readiness and HP. A target-relative frame makes the learned style rotation-invariant. The clone learns *"strafes right around whoever it fights"*, not *"likes the east wall"*.
- **Actions.** A 9-way movement policy (idle plus 8 directions in that frame), a dash head and a shoot head.
- **Network.** MLP `16 → 24 → 24 → 11` (tanh, **1,283 parameters**: 1,224 weights + 59 biases), cross-entropy plus BCE losses, **Adam**, minibatches of 32, a validation split with best-epoch restore, input dropout on the "previous move" features so it can't just copy its last action, and light input noise. A typical 25-second calibration (~300–375 samples) trains in **tens of milliseconds**. The interlude animates the real training run, epoch by epoch.
- **One model, two jobs.** The Echo *samples* the policy to act (temperature 0.85, re-decided 15×/s). The game also runs the latest model on *your* state to **predict your next move**. Its rolling top-1 accuracy is the PREDICTABILITY meter, its expected direction is drawn as the pink "prediction ghost", and Echoes lead their shots towards it. Being unpredictable is literally the counter-play, and it's also scored (an unpredictability bonus each round).
- **It really inherits your style.** We tested with scripted players. A pilot that circles counter-clockwise ~90% of the time produced an Echo that circled counter-clockwise **76%** of the time. A clockwise-biased pilot produced an Echo that circled **clockwise 79%** of the time. Same code, different player, different clone.
- **Brains in URLs.** Weights are quantised to 6 bits per value with per-tensor scales, packed with a few profile bytes and base64url-encoded into `#echo=…` (~1 KB of weights, a ~1.4 KB link). [`src/share.js`](src/share.js)

## Why it matters (beyond the jam)

- **Infinite content at zero cost.** Every player generates a unique rival. No designer hand-authors it, and no server runs inference. It's all on the device.
- **A viral loop built in.** "Beat my clone" links are async PvP that spreads itself (think Forza's Drivatars, for any genre).
- **Coaching for free.** The same model that fights you also tells you your habits, which is useful in competitive games.
- **Private by design.** Your gameplay data never leaves the browser unless you choose to share a link.

## Controls

| | Keyboard + mouse | Touch | Gamepad |
|---|---|---|---|
| Move | WASD / arrows | left thumb | left stick |
| Aim / shoot | mouse / hold click | right thumb (auto-fire) | right stick (auto-fire), RT |
| Dash (i-frames) | Space / Shift / right-click | DASH button | A / RB |
| Pause / mute | Esc or P / M | II button | Start |

Dash through a drone to destroy it. Bullets pass through you while dashing.

## Run it

It's a single self-contained `index.html` (~850 KB, no network needed): just open it, or serve the folder.

```bash
npm install
npm run build      # bundles src/ → index.html (three.js, CSS, fonts, logo all inlined)
npm run serve      # http://localhost:8080
```

Debug/trailer mode: `index.html?capture` exposes a deterministic, frame-stepped game for the trailer director in [`video/`](video).

## Tech

**three.js** (WebGL, instanced meshes, UnrealBloom plus a custom "ink" post pass with grain, vignette and glitch) · **hand-rolled neural network + Adam** · **WebAudio** procedural soundtrack and SFX (no audio files) · **esbuild** single-file build · zero backend. The art direction is the Kanban Studios sketch-brutalist "night" identity: hand-ruled sketchbook arena, marker headlines, highlighter swipes, wobbly ink boxes.

```
src/
  main.js       game loop + state machine (calibrate → train → profile → fight → share)
  brain.js      features, recorder, profiling, predictability
  nn.js         MLP, Adam trainer, 6-bit weight packing
  entities.js   player, Echo clones, drones, bullets, prediction ghost
  world.js      renderer, sketchbook arena, 3D neural-network visualiser, post FX
  ui.js         Kanban-style HUD, screens, radar chart, live loss curve
  audio.js      procedural music + SFX (realtime and offline render)
  pilot.js      autopilot (attract mode + trailer)
  share.js      echo ⇄ URL
video/          deterministic trailer pipeline (capture → cards → offline audio → ffmpeg)
```

## Trailer

The 90-second trailer ([`media/self-play-trailer.mp4`](media/self-play-trailer.mp4)) is generated entirely from code. The game runs in a seeded, frame-stepped capture mode with the autopilot playing. The title cards are HTML in the Kanban style. The soundtrack is the game's own procedural audio, rendered offline with every sound effect timed to the footage. See [`video/README.md`](video/README.md).

## Credits

**Team Kanban — by Awaiz Ahmed** · [kanbanstudios.ae/team-kanban](https://kanbanstudios.ae/team-kanban)

Built for the **Tencent × Arcade AI Hackathon** (Cambridge, UK, October 2026) — Game Tech track. Fonts: Caveat Brush, Architects Daughter and Shadows Into Light Two (SIL OFL). three.js is MIT-licensed.
