// Share links: a trained Echo (quantised weights + a few profile bytes) packed
// into the URL hash. No server — the link *is* the opponent.

import { packModel, unpackModel } from './nn.js';
import { ARCHETYPES, TRAITS } from './brain.js';

const MAGIC = [0x53, 0x50, 1]; // "SP" v1

export function encodeEcho({ name, gen, samples, match, archetypeId, traits, net }) {
  const nameBytes = new TextEncoder().encode((name || 'ANON').slice(0, 14)).slice(0, 24);
  const model = packModel(net, 6);
  const arch = Math.max(0, ARCHETYPES.findIndex((a) => a.id === archetypeId));
  const head = [
    ...MAGIC,
    nameBytes.length,
    ...nameBytes,
    gen & 255,
    (samples >> 8) & 255,
    samples & 255,
    Math.round(match * 100) & 255,
    arch,
    ...TRAITS.map((t) => Math.round((traits?.[t] ?? 0) * 255)),
  ];
  const out = new Uint8Array(head.length + model.length);
  out.set(head, 0);
  out.set(model, head.length);
  return toB64Url(out);
}

export function decodeEcho(str) {
  try {
    const b = fromB64Url(str);
    if (b[0] !== MAGIC[0] || b[1] !== MAGIC[1] || b[2] !== MAGIC[2]) return null;
    let o = 3;
    const nl = b[o++];
    const name = new TextDecoder().decode(b.subarray(o, o + nl)).replace(/[<>&"']/g, '');
    o += nl;
    const gen = b[o++];
    const samples = (b[o] << 8) | b[o + 1];
    o += 2;
    const match = b[o++] / 100;
    const archetype = ARCHETYPES[b[o++]] || ARCHETYPES[0];
    const traits = {};
    for (const t of TRAITS) traits[t] = b[o++] / 255;
    const net = unpackModel(b.subarray(o));
    return { name: name || 'ANON', gen: Math.max(1, gen), samples, match, archetype, traits, net };
  } catch (e) {
    return null;
  }
}

export function echoLink(code) {
  const base = window.__shareBase || location.href.split('#')[0].split('?')[0];
  return `${base}#echo=${code}`;
}

export function readHashEcho() {
  const m = /[#&]echo=([A-Za-z0-9_-]+)/.exec(location.hash);
  return m ? decodeEcho(m[1]) : null;
}

function toB64Url(bytes) {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
