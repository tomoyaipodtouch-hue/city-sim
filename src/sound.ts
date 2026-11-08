// 効果音（Web Audio で合成）。音の出口は BGM と同じ1つの AudioContext を使い、効果音用の音量の段を通す
import { bgm, soundSettings } from './bgm';
export { soundSettings };

function ac() {
  if (!soundSettings.enabled) return null;
  return bgm.sfxOut();
}

function tone(freq: number, dur: number, type: OscillatorType, vol: number, slide = 0, delay = 0) {
  const o0 = ac();
  if (!o0) return;
  const a = o0.ctx;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(o0.out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, vol: number, lp: number) {
  const o0 = ac();
  if (!o0) return;
  const a = o0.ctx;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = a.createBufferSource();
  s.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = lp;
  const g = a.createGain();
  g.gain.value = vol;
  s.connect(f).connect(g).connect(o0.out);
  s.start();
}

export const sfx = {
  click: () => tone(880, 0.05, 'triangle', 0.06),
  road: () => { noise(0.18, 0.25, 900); tone(160, 0.12, 'sine', 0.12, -60); },
  zone: () => { tone(520, 0.08, 'sine', 0.07); tone(780, 0.1, 'sine', 0.05, 0, 0.06); },
  plop: () => { noise(0.25, 0.3, 600); tone(110, 0.25, 'sine', 0.15, -40); },
  bulldoze: () => noise(0.4, 0.35, 1600),
  error: () => { tone(180, 0.12, 'square', 0.05); tone(140, 0.16, 'square', 0.05, 0, 0.1); },
  news: () => tone(1046, 0.08, 'sine', 0.04),
};
