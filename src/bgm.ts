// BGM：アンビエント。ゆっくり移り変わるパッドの和音と、低い音だけで作る（リズムやメロディはない）。
// Web Audio でその場で演奏するので、音のファイルは使わない。昼は3曲を順番に、夜は暗めの曲を流す。

export const bgmSettings = { enabled: true, volume: 0.5 };

interface Song {
  name: string;
  chords: string[];
  len: number; // 1つの和音の長さ（秒）
  bright: number; // パッドの明るさ（ローパスの上限、Hz）
  night?: boolean;
}

export const SONGS: Song[] = [
  { name: '朝もや', len: 9, bright: 1100, chords: ['Dmaj9', 'Bm9', 'Gmaj9', 'Asus2', 'Dmaj9', 'Gbm7', 'Gmaj9', 'Aadd9'] },
  { name: '川べりの午後', len: 10, bright: 1000, chords: ['Fmaj9', 'Am7', 'Bbmaj9', 'Csus2', 'Fmaj9', 'Dm9', 'Bbmaj9', 'Cadd9'] },
  { name: '遠くの線路', len: 9, bright: 1050, chords: ['Ebmaj9', 'Cm9', 'Abmaj9', 'Bbsus2', 'Gm7', 'Cm9', 'Abmaj9', 'Bbadd9'] },
  { name: '夜の港', len: 12, bright: 750, night: true, chords: ['Am9', 'Fmaj9', 'Dm9', 'Esus2', 'Am9', 'Cmaj9', 'Fmaj9', 'Gsus2'] },
];

const NOTE: Record<string, number> = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const QUAL: Record<string, number[]> = {
  maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], add9: [0, 4, 7, 14], sus2: [0, 2, 7, 14],
};
const freq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
// 和音の音（基準の高さ base の上に、ルートから積む）
function chordNotes(name: string, base: number) {
  const m = /^([A-G]b?)(.*)$/.exec(name)!;
  const r = NOTE[m[1]];
  const root = base + ((r - (base % 12) + 12) % 12);
  return (QUAL[m[2]] ?? QUAL.maj9).map((x) => root + x);
}

export class Bgm {
  private ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private song: Song | null = null;
  private songIdx = 0;
  private chordIdx = 0;
  private loops = 0;
  private nextTime = 0; // 次の和音を鳴らす時刻
  private timer = 0;
  private silent: HTMLAudioElement | null = null;
  night = false;
  onSong: ((name: string) => void) | null = null;

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // タップのたびに呼ぶ：音の準備をして、止まっていたら動かす（iPhone は操作のあとでないと音を出せない）
  unlock() {
    // iOS 17 以降：消音スイッチがオンでも音楽として鳴らす
    try {
      const nav = navigator as unknown as { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'playback';
    } catch { /* 対応していない */ }
    // それより前の iOS：無音の音声を流しておくと、Web Audio も消音スイッチの影響を受けなくなる
    if (!this.silent) {
      const a = document.createElement('audio');
      a.src = silentWav();
      a.loop = true;
      a.setAttribute('playsinline', '');
      this.silent = a;
    }
    void this.silent.play().catch(() => {});
    if (!this.ctx) this.start();
    const c = this.ctx as AudioContext | null;
    if (c && c.state !== 'running' && bgmSettings.enabled) void c.resume();
    if (c) {
      const b = c.createBuffer(1, 1, 22050), src = c.createBufferSource();
      src.buffer = b;
      src.connect(c.destination);
      src.start(0);
    }
  }

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
    this.timer = window.setInterval(() => this.tick(), 250);
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
    comp.threshold.value = -20;
    comp.ratio.value = 2.5;
    this.master.connect(comp).connect(a.destination);
    // 長い残響
    const conv = a.createConvolver();
    const len = Math.floor(a.sampleRate * 5);
    const ir = a.createBuffer(2, len, a.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    }
    conv.buffer = ir;
    this.wet = a.createGain();
    this.wet.gain.value = 0.7;
    this.wet.connect(conv).connect(this.master);
    this.dry = a.createGain();
    this.dry.gain.value = 0.6;
    this.dry.connect(this.master);
  }

  applyVolume() {
    if (!this.ctx) return;
    const v = bgmSettings.enabled ? bgmSettings.volume * 1.6 : 0;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.6);
    if (bgmSettings.enabled && this.ctx.state === 'suspended') void (this.ctx as AudioContext).resume();
  }

  // 次の曲へ（夜は夜の曲、昼はほかの曲を順番に）
  private nextSong() {
    if (!this.ctx) return;
    const day = SONGS.filter((s) => !s.night), nightSongs = SONGS.filter((s) => s.night);
    if (this.night) this.song = nightSongs[0];
    else this.song = day[this.songIdx++ % day.length];
    this.chordIdx = 0;
    this.loops = 0;
    if (this.nextTime < this.ctx.currentTime) this.nextTime = this.ctx.currentTime + 0.5;
    this.onSong?.(this.song.name);
  }

  private tick() {
    const a = this.ctx;
    if (!a || !this.song || a.state !== 'running') return;
    // 3秒先までの和音を予約する（和音どうしは重なって、ゆっくり入れ替わる）
    while (this.nextTime < a.currentTime + 3) {
      const s = this.song;
      this.chord(this.nextTime, s.chords[this.chordIdx], s.len, s.bright);
      this.nextTime += s.len;
      this.chordIdx++;
      if (this.chordIdx >= s.chords.length) {
        this.chordIdx = 0;
        this.loops++;
        // 2回くり返したら次の曲（昼と夜が変わったら、その場で）
        if (this.loops >= 2 || this.night !== !!s.night) this.nextSong();
      }
    }
  }

  // 1つの和音：少しずつずらしたのこぎり波を、暗いローパスに通して、ゆっくり出し入れする
  private chord(t: number, name: string, len: number, bright: number) {
    const a = this.ctx!;
    const notes = chordNotes(name, 50);
    for (const n of notes)
      for (const det of [-6, 5]) {
        const o = a.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = freq(n);
        o.detune.value = det;
        const f = a.createBiquadFilter();
        f.type = 'lowpass';
        f.Q.value = 0.4;
        f.frequency.setValueAtTime(bright * 0.45, t);
        f.frequency.linearRampToValueAtTime(bright, t + len * 0.5);
        f.frequency.linearRampToValueAtTime(bright * 0.55, t + len + 3);
        const g = a.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.018, t + 3.5);
        g.gain.setValueAtTime(0.018, t + len - 1);
        g.gain.linearRampToValueAtTime(0, t + len + 3.5);
        const p = a.createStereoPanner();
        p.pan.value = det < 0 ? -0.4 : 0.4;
        o.connect(f).connect(g).connect(p);
        p.connect(this.dry);
        p.connect(this.wet);
        o.start(t);
        o.stop(t + len + 4);
      }
    // 低い音（ルート）
    const bo = a.createOscillator();
    bo.frequency.value = freq(notes[0] - 12);
    const bg = a.createGain();
    bg.gain.setValueAtTime(0, t);
    bg.gain.linearRampToValueAtTime(0.07, t + 3);
    bg.gain.linearRampToValueAtTime(0, t + len + 2);
    bo.connect(bg).connect(this.dry);
    bo.start(t);
    bo.stop(t + len + 3);
  }

  // 確認用：曲を1回分、オフラインで書き出す
  static async renderOffline(songIdx: number) {
    const s = SONGS[songIdx];
    const secs = s.chords.length * s.len + 5;
    const off = new OfflineAudioContext(2, Math.ceil(44100 * secs), 44100);
    const b = new Bgm();
    b.ctx = off;
    b.setup(off);
    b.master.gain.value = 0.8;
    s.chords.forEach((c, k) => b.chord(0.3 + k * s.len, c, s.len, s.bright));
    return off.startRendering();
  }

  dispose() {
    clearInterval(this.timer);
  }
}

export const bgm = new Bgm();

// 0.5 秒の無音の WAV（data: URL）
function silentWav() {
  const rate = 8000, n = 4000;
  const buf = new DataView(new ArrayBuffer(44 + n));
  const w = (o: number, t: string) => { for (let k = 0; k < t.length; k++) buf.setUint8(o + k, t.charCodeAt(k)); };
  w(0, 'RIFF'); buf.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true); buf.setUint32(28, rate, true); buf.setUint16(32, 1, true); buf.setUint16(34, 8, true); w(36, 'data'); buf.setUint32(40, n, true);
  for (let k = 0; k < n; k++) buf.setUint8(44 + k, 128);
  let bin = '';
  const u = new Uint8Array(buf.buffer);
  for (let k = 0; k < u.length; k++) bin += String.fromCharCode(u[k]);
  return 'data:audio/wav;base64,' + btoa(bin);
}
