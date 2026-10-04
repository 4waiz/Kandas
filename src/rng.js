// Seeded PRNG (mulberry32). Gameplay, training and FX all draw from it, so a run —
// and the trailer capture — can be replayed exactly from a seed.
let s = (Math.random() * 4294967296) >>> 0;

export function seed(value) {
  s = value >>> 0;
}

export function rand() {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const range = (a, b) => a + (b - a) * rand();
export const chance = (p) => rand() < p;
export const pick = (arr) => arr[Math.floor(rand() * arr.length)];
export const sign = () => (rand() < 0.5 ? -1 : 1);

export function gauss() {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}
