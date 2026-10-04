// Tunables. Distances are metres-ish world units on the XZ plane.

export const ARENA_R = 20;
export const SAMPLE_HZ = 15; // decisions recorded per second — also the Echo "think" rate
export const CALIBRATION_TIME = 25;
export const MAX_ECHOES = 4;

export const PLAYER = {
  radius: 0.6,
  speed: 9.5,
  accel: 85,
  friction: 14,
  hp: 6,
  fireRate: 9,
  bulletSpeed: 34,
  bulletLife: 0.8,
  dashSpeed: 30,
  dashTime: 0.16,
  dashCooldown: 0.85,
  hurtIframes: 1.0,
};

export const ECHO = {
  radius: 0.62,
  speed: 8.6,
  accel: 70,
  friction: 12,
  baseHp: 26,
  hpPerGen: 5,
  fireRate: 2.6,
  bulletSpeed: 19,
  bulletLife: 1.7,
  dashSpeed: 26,
  dashTime: 0.16,
  dashCooldown: 1.2,
  temperature: 0.85,
  minFireProb: 0.35,
  aimNoise: 0.1, // radians, on top of the player's own measured aim error
};

export const BIT = { radius: 0.5, speed: 6.4, hp: 1, score: 25 };
export const BYTE = { radius: 0.75, speed: 3.4, hp: 3, score: 60, fireEvery: 2.4, bulletSpeed: 11, keepAway: 10 };

export const SCORE = { echoBase: 300, roundClear: 500, unpredictBonus: 1000 };

// Kanban Studios "night" palette.
export const C = {
  night: 0x0e0b14,
  nightShadow: 0x1a1521,
  ink: 0xf5f1e8,
  electric: 0x00e0ff,
  pink: 0xff4d9e,
  acid: 0xb8ff3d,
  sun: 0xffe34d,
  orange: 0xff7a1a,
  violet: 0x7b5bff,
};

// Echo generations cycle through these accents.
export const ECHO_COLORS = [C.pink, C.violet, C.orange, C.acid];
export const echoColor = (gen) => ECHO_COLORS[(gen - 1) % ECHO_COLORS.length];

export const LINKS = {
  team: 'https://kanbanstudios.ae/team-kanban',
  repo: 'https://github.com/4waiz/self-play',
};
