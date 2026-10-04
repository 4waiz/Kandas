# Submission — Cambridge × Arcade AI Hackathon 2026

Paste-ready answers for the submission form (about.tryarcade.com/submit). Pick the length each field allows.

---

**Project / game name**
SELF PLAY

**Team**
Team Kanban — https://kanbanstudios.ae/team-kanban

**Team members**
Awaiz Ahmed

**Track**
Game × AI

**Tagline** (51 chars)
The final boss is a neural network trained on you.

**One-liner** (≤140 chars)
A three.js shooter where a neural net learns how you play, live in your browser, then becomes your rival and predicts your next move.

**Short description** (≤300 chars)
SELF PLAY is a three.js arena shooter where a neural network trains on how you play, live in your browser, then spawns as your Echo: a clone that moves like you and predicts your next move. To win, break your own habits. Then send your clone to a friend as a link.

**Links**
- Play (no install, desktop + mobile + gamepad): https://4waiz.github.io/Kandas/
- Code: https://github.com/4waiz/Kandas
- Trailer (90 s): `media/self-play-trailer.mp4` in the repo (upload to YouTube/Drive if the form needs a video URL)
- Team: https://kanbanstudios.ae/team-kanban

---

## Full description

**Every game has AI enemies. Ours is trained on you.**

For the first 25 seconds of SELF PLAY you just play: move, aim, dash and shoot drones. The game quietly records 15 of your decisions every second. Each one leaves a glowing dot on the floor where you stood. When the round ends, the dots lift off and stream into a neural network floating above the arena. You watch it train on your data, with a live loss curve, epochs and flickering weights. It happens in the browser, in milliseconds.

Then the game tells you what it learned: *"THE ORBITER — you circle counter-clockwise 94% of the time, you dash about every 2 seconds, you fight from ~8 m."* Your **Echo** spawns: a holographic clone whose every move comes from that network. It strafes the way you strafe and dashes when you'd dash.

The same model also **predicts you**. A live PREDICTABILITY meter shows how often it guesses your next move. A pink ghost marks where it thinks you're going, and your Echoes aim there. The only counter-play is to break your own habits, and the game rewards it with an unpredictability bonus every round. Each round the network retrains on your newest moves, and every past generation of you comes back to fight.

When you lose, you can **send your Echo to a friend**. The trained weights (~1 KB) are packed into the link itself, so your friend duels your brain with no server, account or install. They can send theirs straight back.

## How we use AI (it's real ML, not scripted "AI")

- **Behaviour cloning, on-device.** A from-scratch multilayer perceptron (16 → 24 → 24 → 11, 1,283 parameters, tanh, Adam, written in plain JavaScript with no ML library) is trained on the player's own (state → action) pairs.
- **Smart observations.** 16 features are expressed relative to the player's current target: distance, target velocity, arena position, nearest incoming bullet, previous move, dash readiness and HP. Because of that, the learned style transfers to fighting *you* ("circles right around whoever it fights").
- **One model, two jobs.** It drives the Echo (sampled policy, 15 decisions/s) and it predicts the human (top-1 accuracy becomes the PREDICTABILITY meter, and the expected direction becomes the aim lead and the prediction ghost).
- **Verified style transfer.** With scripted test players, a counter-clockwise player produced an Echo that circled counter-clockwise 76% of the time, and a clockwise player produced one that circled clockwise 79% of the time.
- **Brains in URLs.** Weights are quantised to 6 bits, packed with profile bytes, and base64url-encoded into the share link.

## Why it matters

- **Infinite, personal content at zero marginal cost.** Every player generates a unique rival. No designer authors it and no server runs it.
- **A built-in viral loop.** "Beat my clone" links are async PvP that spreads itself, like Forza's Drivatars but for any genre.
- **Coaching and retention.** The same model reveals your habits, which is useful for competitive and esports titles.
- **Privacy by default.** Gameplay data never leaves the device unless the player shares a link.

## Tech stack

three.js (WebGL, instanced rendering, UnrealBloom plus a custom ink/grain/glitch post pass) · hand-written neural network + Adam optimiser · WebAudio procedural music and SFX (no audio files) · esbuild single-file build (~850 KB `index.html`, runs offline) · keyboard/mouse, touch twin-sticks and gamepad · zero backend. Built with Claude Code as an AI pair-programmer.

## How to play (for judges, ~2 minutes)

1. Open https://4waiz.github.io/Kandas/ and press **Start calibration**.
2. **Just play for 25 s.** WASD moves, the mouse aims, click shoots, Space dashes. (On mobile: left thumb moves, right thumb aims and fires.)
3. Watch the network train on you, read your profile, then **fight your Echo**. Watch the PREDICTABILITY meter and try to beat it by changing your habits.
4. When you lose, sign your Echo and **copy the challenge link**. Open it in another tab to duel your own clone.

## What's next

Real-time clone-vs-clone spectator mode, leaderboards of the "hardest-to-predict" players, Echo generations that persist across sessions, and porting the "your habits become the boss" loop to other genres (racing lines, fighting-game combos, MOBA positioning).
