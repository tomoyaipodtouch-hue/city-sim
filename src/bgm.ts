// BGM：おだやかなジャズ風の曲を、Web Audio でその場で演奏する（音のファイルは使わない）
// 楽器：エレクトリックピアノ（和音）、ウッドベース（ウォーキング）、ブラシのドラム、ビブラフォン（メロディ）
// 曲は4曲。昼は3曲を順番に、夜はゆっくりしたバラードを流す。

export const bgmSettings = { enabled: true, volume: 0.5 };

interface Song {
  name: string;
  bpm: number;
  chords: string[]; // 1小節ずつ。"Gm7 C7" のように2つ書くと半分ずつ
  seed: number;
  ballad?: boolean;
  bossa?: boolean;
}

export const SONGS: Song[] = [
  { name: '朝のアベニュー', bpm: 112, seed: 11, chords: ['Fmaj7', 'Dm7', 'Gm7', 'C7', 'Am7', 'D7', 'Gm7 C7', 'Fmaj7', 'Bbmaj7', 'Bbm6', 'Am7', 'D7', 'Gm7', 'C7', 'Fmaj7 D7', 'Gm7 C7'] },
  { name: 'ブルーブリッジ', bpm: 98, seed: 23, chords: ['Cm7', 'F7', 'Bbmaj7', 'Ebmaj7', 'Am7b5', 'D7', 'Gm7', 'Gm7', 'Cm7', 'F7', 'Bbmaj7', 'Ebmaj7', 'Am7b5', 'D7', 'Gm7 C7', 'Fm7 Bb7'] },
  { name: '屋上の風', bpm: 104, seed: 37, bossa: true, chords: ['Dm9', 'Dm9', 'Em7b5', 'A7', 'Dm9', 'Gm9', 'C9', 'Fmaj7', 'Bbmaj7', 'Em7b5', 'A7', 'Dm9', 'Gm9', 'C9', 'Em7b5', 'A7'] },
  { name: '真夜中の乗りかえ', bpm: 70, seed: 53, ballad: true, chords: ['Ebmaj7', 'Cm7', 'Fm7', 'Bb7', 'Gm7', 'C7', 'Fm7', 'Bb7', 'Abmaj7', 'Abm6', 'Gm7', 'C7', 'Fm7', 'Bb7', 'Ebmaj7', 'Fm7 Bb7'] },
];

// ---------------- 和音 ----------------
const NOTE: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const QUAL: Record<string, number[]> = {
  maj7: [0, 4, 7, 11, 14],
  m7: [0, 3, 7, 10, 14],
  '7': [0, 4, 7, 10, 14],
  m7b5: [0, 3, 6, 10, 13],
  m6: [0, 3, 7, 9, 14],
  m9: [0, 3, 7, 10, 14],
  '9': [0, 4, 7, 10, 14],
  '6': [0, 4, 7, 9, 14],
};
interface Chord { root: number; iv: number[] }
function parseChord(s: string): Chord {
  const m = /^([A-G](?:b|#)?)(.*)$/.exec(s)!;
  return { root: NOTE[m[1]], iv: QUAL[m[2]] ?? QUAL.maj7 };
}
const freq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

// 決まった並びの乱数（曲ごとに同じメロディになる）
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------- 曲の組み立て ----------------
interface Ev { t: number; d: number; midi: number; v: number }
interface Arr { beats: number; piano: Ev[]; bass: Ev[]; vib: Ev[]; drums: { t: number; k: 'ride' | 'brush' | 'kick' | 'hat'; v: number }[] }

function arrange(song: Song): Arr {
  const r = rng(song.seed);
  const piano: Ev[] = [], bass: Ev[] = [], vib: Ev[] = [], drums: Arr['drums'] = [];
  // 小節ごとの和音（拍の単位）
  const slots: { t: number; len: number; c: Chord }[] = [];
  song.chords.forEach((bar, b) => {
    const cs = bar.split(' ');
    cs.forEach((c, k) => slots.push({ t: b * 4 + k * (4 / cs.length), len: 4 / cs.length, c: parseChord(c) }));
  });
  const beats = song.chords.length * 4;
  const swing = song.ballad ? 0.62 : song.bossa ? 0.5 : 0.64; // 8分音符の跳ね具合
  const off = (beat: number) => Math.floor(beat) + (beat % 1 >= 0.5 ? swing : 0) + (beat % 1 >= 0.5 ? 0 : beat % 1);
  // ピアノ：3度・7度・9度・5度の和音（ルートはベースに任せる）。中音域に収める
  let prevTop = 64;
  slots.forEach((sl, i) => {
    const { root, iv } = sl.c;
    const pick = [iv[1], iv[3], iv[4], iv[2]];
    let notes = pick.map((x) => 48 + ((root + x) % 12));
    notes = notes.map((n) => (n < 52 ? n + 12 : n)).sort((a, b) => a - b);
    // 前の和音に近い高さにする
    while (notes[notes.length - 1] - prevTop > 6) notes = notes.map((n) => n - 12);
    while (prevTop - notes[notes.length - 1] > 6) notes = notes.map((n) => n + 12);
    prevTop = notes[notes.length - 1];
    // リズム：バラードは長く、ほかは「1拍目」と「2拍目の裏」などに軽く
    const hits = song.ballad ? [[0, sl.len]] : song.bossa ? [[0, 1.4], [1.5, 1], [3, 0.9]] : r() < 0.5 ? [[0, 1.2], [2.5, 1]] : [[0.5, 1], [2, 1.2]];
    for (const [h, d] of hits) {
      if (h >= sl.len) continue;
      for (const n of notes) piano.push({ t: off(sl.t + h), d: Math.min(d, sl.len - h) + 0.3, midi: n, v: 0.06 + r() * 0.015 });
    }
    // ベース
    const nextRoot = slots[(i + 1) % slots.length].c.root;
    const low = (pc: number) => 33 + ((pc - 9 + 12) % 12); // A1..G#2
    const R = low(root);
    if (song.ballad) {
      bass.push({ t: sl.t, d: Math.min(2, sl.len) - 0.1, midi: R, v: 0.5 });
      if (sl.len >= 4) bass.push({ t: sl.t + 2, d: 1.9, midi: low(root + iv[2]), v: 0.42 });
    } else if (song.bossa) {
      bass.push({ t: sl.t, d: 1.4, midi: R, v: 0.5 });
      bass.push({ t: sl.t + 1.5, d: 0.5, midi: low(root + iv[2]), v: 0.4 });
      if (sl.len >= 4) { bass.push({ t: sl.t + 2, d: 1.4, midi: low(root + iv[2]), v: 0.45 }); bass.push({ t: sl.t + 3.5, d: 0.5, midi: R, v: 0.4 }); }
    } else {
      // ウォーキング：ルート → 和音の音 → 和音の音 → 次のルートへの半音の近づき
      const steps = Math.round(sl.len);
      const line = [R, low(root + (r() < 0.5 ? iv[1] : iv[2])), low(root + iv[2]), 0];
      const nr = low(nextRoot);
      line[steps - 1] = r() < 0.6 ? nr + (r() < 0.5 ? 1 : -1) : low(root + iv[3]);
      for (let k = 0; k < steps; k++) bass.push({ t: sl.t + k, d: 0.9, midi: line[k] || R, v: k === 0 ? 0.52 : 0.44 });
    }
  });
  // ドラム
  for (let b = 0; b < beats; b++) {
    if (song.ballad) {
      drums.push({ t: b, k: 'brush', v: 0.35 });
      if (b % 2 === 1) drums.push({ t: b, k: 'hat', v: 0.12 });
    } else if (song.bossa) {
      drums.push({ t: b, k: 'hat', v: 0.1 }, { t: b + 0.5, k: 'hat', v: 0.07 });
      if (b % 4 === 0 || b % 4 === 2.5) drums.push({ t: b, k: 'kick', v: 0.3 });
      if ([1.5, 3].includes(b % 4)) drums.push({ t: b, k: 'brush', v: 0.15 });
      if (b % 4 === 3) drums.push({ t: b + 0.5, k: 'kick', v: 0.2 });
    } else {
      // ライドの「チン、チキ」と、2・4拍目のハイハットとブラシ
      drums.push({ t: b, k: 'ride', v: 0.11 });
      if (b % 2 === 1) { drums.push({ t: off(b + 0.5), k: 'ride', v: 0.07 }); drums.push({ t: b, k: 'hat', v: 0.1 }); drums.push({ t: b, k: 'brush', v: 0.12 }); }
      if (b % 4 === 0) drums.push({ t: b, k: 'kick', v: 0.18 });
    }
  }
  // メロディ（ビブラフォン）：4小節ごとのフレーズ。和音の音を中心に、近い音へ動く。最後の小節は休む
  const scaleOf = (c: Chord) => [0, 2, 4, 5, 7, 9, 11].map((x) => (c.root + (c.iv[1] === 3 ? [0, 2, 3, 5, 7, 9, 10][[0, 2, 4, 5, 7, 9, 11].indexOf(x)] : x)) % 12);
  let cur = 72;
  const phrase: Ev[] = [];
  const bars = song.chords.length;
  const rhythms = song.ballad
    ? [[0, 1.5, 2, 2], [0, 3, 1, 1]]
    : [[0, 1, 1.5, 0.5, 2, 1, 3, 1], [0.5, 1, 1.5, 1, 2.5, 1.5], [0, 1.5, 1.5, 0.5, 2, 2], [0, 0.5, 0.5, 0.5, 1, 1, 2.5, 1.5]];
  for (let bar = 0; bar < bars; bar++) {
    if (bar % 4 === 3) continue; // 休み
    // 同じ形を A→A' のようにくり返す（8小節後は少し変える）
    if (bar >= 8 && phrase.length && r() < 0.6) {
      // 8小節前と同じ形をくり返し、和音に合わない音だけ近い和音の音に直す
      for (const e of phrase.filter((q) => q.t >= (bar - 8) * 4 && q.t < (bar - 7) * 4)) {
        const t = e.t + 32;
        const sl = slots.filter((q) => q.t <= t).pop()!;
        const tones = sl.c.iv.slice(0, 4).map((x) => (sl.c.root + x) % 12);
        const m = tones.includes(e.midi % 12) ? e.midi : nearest(e.midi, tones);
        vib.push({ t: off(t), d: e.d, midi: m, v: e.v });
        phrase.push({ ...e, t, midi: m });
      }
      continue;
    }
    const rh = rhythms[Math.floor(r() * rhythms.length)];
    for (let k = 0; k < rh.length; k += 2) {
      const t = bar * 4 + rh[k];
      const sl = slots.filter((q) => q.t <= t).pop()!;
      const tones = sl.c.iv.slice(0, 4).map((x) => (sl.c.root + x) % 12);
      const scale = scaleOf(sl.c);
      // 強い拍は和音の音、弱い拍は音階の近い音
      const strong = rh[k] % 1 === 0;
      const pool = strong ? tones : scale;
      const target = cur + (r() < 0.5 ? -1 : 1) * Math.floor(r() * 4);
      cur = Math.max(65, Math.min(81, nearest(target, pool)));
      const e = { t: off(t), d: rh[k + 1] * 0.9, midi: cur, v: 0.09 + r() * 0.03 };
      vib.push(e);
      phrase.push({ ...e, t });
    }
  }
  return { beats, piano, bass, vib, drums };
}
function nearest(m: number, pcs: number[]) {
  for (let d = 0; d < 12; d++) for (const s of [1, -1]) if (pcs.includes((((m + d * s) % 12) + 12) % 12)) return m + d * s;
  return m;
}

// ---------------- 演奏 ----------------
export class Bgm {
  private ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private wet!: GainNode;
  private noiseBuf!: AudioBuffer;
  private songIdx = 0;
  private arr: Arr | null = null;
  private song: Song | null = null;
  private startTime = 0; // 曲の0拍目の時刻
  private nextBeat = 0; // まだ予約していない最初の拍
  private loops = 0;
  private timer = 0;
  night = false;
  onSong: ((name: string) => void) | null = null;

  // 最初にタッチされたときに呼ぶ（iPhone は操作のあとでないと音を出せない）
  start(ctx?: AudioContext) {
    if (this.ctx) return;
    try {
      this.ctx = ctx ?? new AudioContext();
    } catch {
      return;
    }
    this.setup(this.ctx);
    this.applyVolume();
    this.nextSong();
    this.timer = window.setInterval(() => this.tick(), 100);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      const c = this.ctx as AudioContext;
      if (document.hidden) void c.suspend();
      else if (bgmSettings.enabled) void c.resume();
    });
  }

  private setup(a: BaseAudioContext) {
    this.master = a.createGain();
    this.master.gain.value = 0;
    const comp = a.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(a.destination);
    // 残響（短く柔らかい）
    const conv = a.createConvolver();
    const len = Math.floor(a.sampleRate * 1.8);
    const ir = a.createBuffer(2, len, a.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    conv.buffer = ir;
    this.wet = a.createGain();
    this.wet.gain.value = 0.25;
    this.wet.connect(conv).connect(this.master);
    this.noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  }

  // 確認用：曲を最初から loops 回分、オフラインで書き出す
  static async renderOffline(songIdx: number, loops = 1) {
    const song = SONGS[songIdx];
    const arr = arrange(song);
    const spb = 60 / song.bpm;
    const secs = arr.beats * spb * loops + 3;
    const off = new OfflineAudioContext(2, Math.ceil(44100 * secs), 44100);
    const b = new Bgm();
    (b as unknown as { ctx: BaseAudioContext }).ctx = off;
    b.setup(off);
    b.master.gain.value = 0.45;
    for (let l = 0; l < loops; l++) {
      const at = (t: number) => 0.1 + (l * arr.beats + t) * spb;
      for (const e of arr.piano) b.epiano(at(e.t), e.d * spb, e.midi, e.v);
      for (const e of arr.bass) b.bassNote(at(e.t), e.d * spb, e.midi, e.v);
      for (const e of arr.vib) b.vibes(at(e.t), e.d * spb, e.midi, e.v * (l === 0 ? 0.7 : 1));
      for (const e of arr.drums) b.drum(at(e.t), e.k, e.v);
    }
    return off.startRendering();
  }

  applyVolume() {
    if (!this.ctx) return;
    const v = bgmSettings.enabled ? bgmSettings.volume * 0.9 : 0;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.4);
    if (bgmSettings.enabled && this.ctx.state === 'suspended') void (this.ctx as AudioContext).resume();
  }

  // 次の曲へ（夜はバラード、昼はほかの曲を順番に）
  nextSong() {
    if (!this.ctx) return;
    const day = SONGS.filter((s) => !s.ballad), nightSongs = SONGS.filter((s) => s.ballad);
    let song: Song;
    if (this.night) song = nightSongs[0];
    else {
      song = day[this.songIdx % day.length];
      this.songIdx++;
    }
    this.song = song;
    this.arr = arrange(song);
    this.startTime = this.ctx.currentTime + 0.3;
    this.nextBeat = 0;
    this.loops = 0;
    this.onSong?.(song.name);
  }

  private tick() {
    const a = this.ctx;
    if (!a || !this.arr || !this.song || a.state !== 'running') return;
    const spb = 60 / this.song.bpm;
    const ahead = a.currentTime + 0.4;
    while (this.startTime + this.nextBeat * spb < ahead) {
      const b0 = this.nextBeat, b1 = b0 + 1;
      const at = (t: number) => this.startTime + t * spb;
      for (const e of this.arr.piano) if (e.t >= b0 && e.t < b1) this.epiano(at(e.t), e.d * spb, e.midi, e.v);
      for (const e of this.arr.bass) if (e.t >= b0 && e.t < b1) this.bassNote(at(e.t), e.d * spb, e.midi, e.v);
      // メロディは1回目は控えめ、2回目からはっきり
      for (const e of this.arr.vib) if (e.t >= b0 && e.t < b1) this.vibes(at(e.t), e.d * spb, e.midi, e.v * (this.loops === 0 ? 0.7 : 1));
      for (const e of this.arr.drums) if (e.t >= b0 && e.t < b1) this.drum(at(e.t), e.k, e.v);
      this.nextBeat++;
      if (this.nextBeat >= this.arr.beats) {
        // 曲の形をくり返す。3回くり返したら次の曲（夜と昼が変わったら早めに）
        this.loops++;
        const wantBallad = this.night;
        if (this.loops >= 3 || wantBallad !== !!this.song.ballad) {
          const end = this.startTime + this.arr.beats * spb;
          this.nextSongAt(end + spb * 2);
          return;
        }
        this.startTime += this.arr.beats * spb;
        this.nextBeat = 0;
      }
    }
  }
  private nextSongAt(t: number) {
    this.nextSong();
    this.startTime = t;
  }

  private out(g: AudioNode, wet = 0.5) {
    g.connect(this.master);
    const w = this.ctx!.createGain();
    w.gain.value = wet;
    g.connect(w).connect(this.wet);
  }

  // エレクトリックピアノ：サイン波に、少しだけ金属的な響き（FM）
  private epiano(t: number, d: number, midi: number, v: number) {
    const a = this.ctx!;
    const f = freq(midi);
    const o = a.createOscillator(), m = a.createOscillator(), mg = a.createGain(), g = a.createGain();
    o.frequency.value = f;
    m.frequency.value = f * 1.0;
    mg.gain.setValueAtTime(f * 1.2, t);
    mg.gain.exponentialRampToValueAtTime(f * 0.05, t + 0.6);
    m.connect(mg).connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.012);
    g.gain.exponentialRampToValueAtTime(v * 0.35, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.4);
    const p = a.createStereoPanner();
    p.pan.value = 0.15;
    o.connect(g).connect(p);
    this.out(p, 0.6);
    o.start(t); m.start(t);
    o.stop(t + d + 0.5); m.stop(t + d + 0.5);
  }

  // ウッドベース：三角波を低い音だけ通して、はじく音に
  private bassNote(t: number, d: number, midi: number, v: number) {
    const a = this.ctx!;
    const o = a.createOscillator(), f = a.createBiquadFilter(), g = a.createGain();
    o.type = 'triangle';
    o.frequency.value = freq(midi);
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(260, t + 0.25);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v * 0.55, t + 0.015);
    g.gain.exponentialRampToValueAtTime(v * 0.25, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.1);
    o.connect(f).connect(g);
    this.out(g, 0.15);
    o.start(t);
    o.stop(t + d + 0.15);
  }

  // ビブラフォン：サイン波と高い倍音、ゆれ（トレモロ）
  private vibes(t: number, d: number, midi: number, v: number) {
    const a = this.ctx!;
    const fq = freq(midi);
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.8, d * 1.6));
    const trem = a.createOscillator(), tg = a.createGain(), amp = a.createGain();
    trem.frequency.value = 5.2;
    tg.gain.value = 0.25;
    amp.gain.value = 0.75;
    trem.connect(tg).connect(amp.gain);
    for (const [mul, lv] of [[1, 1], [4, 0.18], [10, 0.04]] as const) {
      const o = a.createOscillator(), og = a.createGain();
      o.frequency.value = fq * mul;
      og.gain.value = lv;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + Math.max(0.8, d * 1.6) + 0.05);
    }
    const p = a.createStereoPanner();
    p.pan.value = -0.2;
    g.connect(amp).connect(p);
    this.out(p, 0.8);
    trem.start(t);
    trem.stop(t + Math.max(0.8, d * 1.6) + 0.05);
  }

  private drum(t: number, k: 'ride' | 'brush' | 'kick' | 'hat', v: number) {
    const a = this.ctx!;
    if (k === 'kick') {
      const o = a.createOscillator(), g = a.createGain();
      o.frequency.setValueAtTime(90, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g);
      this.out(g, 0.1);
      o.start(t);
      o.stop(t + 0.3);
      return;
    }
    const s = a.createBufferSource();
    s.buffer = this.noiseBuf;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = a.createBiquadFilter(), g = a.createGain();
    let dur = 0.1;
    if (k === 'ride') { f.type = 'bandpass'; f.frequency.value = 7000; f.Q.value = 1.5; dur = 0.45; }
    else if (k === 'hat') { f.type = 'highpass'; f.frequency.value = 8000; dur = 0.05; }
    else { f.type = 'bandpass'; f.frequency.value = 2500; f.Q.value = 0.6; dur = 0.3; } // ブラシ
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v * (k === 'brush' ? 0.32 : 0.38), t + (k === 'brush' ? 0.05 : 0.003));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = a.createStereoPanner();
    p.pan.value = k === 'ride' ? 0.35 : k === 'hat' ? -0.3 : 0;
    s.connect(f).connect(g).connect(p);
    this.out(p, 0.3);
    s.start(t, Math.random() * 0.5, dur + 0.05);
  }

  dispose() {
    clearInterval(this.timer);
  }
}

export const bgm = new Bgm();
