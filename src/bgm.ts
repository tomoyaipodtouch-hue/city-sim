// BGM：アンビエント。ゆっくり移り変わるパッドの和音と、低い音だけで作る（リズムやメロディはない）。
// Web Audio でその場で演奏するので、音のファイルは使わない。4曲を順番に、昼も夜も同じようにくり返し流す。
// 音の出口（AudioContext）は効果音と合わせて1つだけにする（iPhone は2つ目を作ると BGM が止まることがある）

export const bgmSettings = { enabled: true, volume: 0.5 };
// 効果音のオンとオフ（音の準備で使うので、ここに置く。sound.ts から同じものを使う）
export const soundSettings = { enabled: true };

interface Song {
  name: string;
  chords: string[];
  len: number; // 1つの和音の長さ（秒）
  bright: number; // パッドの明るさ（ローパスの上限、Hz）
}

// この順番でくり返す（1曲は和音の並びを2回）
export const SONGS: Song[] = [
  { name: '朝もや', len: 9, bright: 1100, chords: ['Dmaj9', 'Bm9', 'Gmaj9', 'Asus2', 'Dmaj9', 'Gbm7', 'Gmaj9', 'Aadd9'] },
  { name: '川べりの午後', len: 10, bright: 1000, chords: ['Fmaj9', 'Am7', 'Bbmaj9', 'Csus2', 'Fmaj9', 'Dm9', 'Bbmaj9', 'Cadd9'] },
  { name: '遠くの線路', len: 9, bright: 1050, chords: ['Ebmaj9', 'Cm9', 'Abmaj9', 'Bbsus2', 'Gm7', 'Cm9', 'Abmaj9', 'Bbadd9'] },
  { name: '夜の港', len: 12, bright: 750, chords: ['Am9', 'Fmaj9', 'Dm9', 'Esus2', 'Am9', 'Cmaj9', 'Fmaj9', 'Gsus2'] },
];
const LOOPS = 2;
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
  private fx: GainNode | null = null; // 効果音の出口
  private song: Song = SONGS[0];
  private songIdx = 0;
  private chordIdx = 0;
  private loops = 0;
  private nextTime = 0; // 次の和音を鳴らす時刻
  private timer = 0;
  private silent: HTMLAudioElement | null = null;
  // 'running' なのに時間が進まないことがある（iOS で電話などのあと）。そのときは次のタップで作り直す
  private stuck = false;
  private ctLast = 0;
  private ctWall = 0;
  onSong: ((name: string) => void) | null = null;

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // BGM か効果音のどちらかがオンなら、音を出せる状態にしておく
  private get wanted() {
    return bgmSettings.enabled || soundSettings.enabled;
  }

  // タップのたびに呼ぶ（iPhone は操作の中でないと音を出せない）。鳴っているときは何もしない
  unlock() {
    if (this.ctx?.state === 'closed') this.ctx = null;
    if (this.stuck && this.ctx) {
      const old = this.ctx as AudioContext;
      this.ctx = null;
      void old.close().catch(() => {});
    }
    if (!this.ctx) this.start();
    if (!this.wanted || document.hidden) return;
    if (this.running && (!bgmSettings.enabled || (this.silent && !this.silent.paused))) return;
    this.wake();
  }

  // 止まっていたら動かす（電話やほかのアプリの音で止められたとき、iOS は 'interrupted' になる）。
  // BGM がオンのときだけ消音スイッチを無視して鳴らす。効果音だけのときは、ほかのアプリの音楽を止めず、消音スイッチにしたがう
  private wake() {
    const music = bgmSettings.enabled;
    // iOS 17 以降：BGM は音楽として鳴らす（消音スイッチがオンでも鳴る）。効果音だけなら 'ambient'（ほかの音とまざる）
    try {
      const nav = navigator as unknown as { audioSession?: { type: string } };
      const type = music ? 'playback' : 'ambient';
      if (nav.audioSession && nav.audioSession.type !== type) nav.audioSession.type = type;
    } catch { /* 対応していない */ }
    // それより前の iOS：無音の音声を流しておくと、Web Audio も消音スイッチの影響を受けなくなる（BGM のときだけ）
    if (music && !this.silent) {
      const a = document.createElement('audio');
      a.src = silentWav();
      a.loop = true;
      a.setAttribute('playsinline', '');
      this.silent = a;
    }
    if (!music) this.silent?.pause();
    else if (this.silent?.paused) void this.silent.play().catch(() => {});
    const c = this.ctx as AudioContext | null;
    if (!c || c.state === 'running' || c.state === 'closed') return;
    void c.resume().catch(() => {});
    // 古い iOS は、操作の中で音を1つ鳴らさないと動き出さない
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, 22050);
    src.connect(c.destination);
    src.start(0);
  }

  private start() {
    let c: AudioContext;
    try {
      c = new AudioContext();
    } catch {
      return;
    }
    this.ctx = c;
    this.fx = null;
    this.stuck = false;
    this.ctWall = 0;
    this.setup(c);
    this.nextTime = c.currentTime + 0.5;
    // 止められたら（こちらで止めたのでなければ）すぐに動かし直してみる。だめなら次のタップで。
    // ほかのアプリに止められた（'interrupted'）ときは、BGM がオンのときだけ取りもどす
    c.addEventListener('statechange', () => {
      if (this.ctx !== c) return;
      if (c.state === 'running') this.tick();
      else if (c.state !== 'closed' && this.wanted && !document.hidden && (c.state !== 'interrupted' || bgmSettings.enabled)) void c.resume().catch(() => {});
    });
    this.applyVolume();
    if (this.timer) return;
    this.timer = window.setInterval(() => this.tick(), 250);
    // 画面が隠れたら止めて、戻ったら動かす（動かせなければ次のタップで）
    document.addEventListener('visibilitychange', () => {
      const a = this.ctx as AudioContext | null;
      if (!a || a.state === 'closed') return;
      if (document.hidden) {
        void a.suspend().catch(() => {});
        this.silent?.pause();
      } else if (this.wanted) this.wake();
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

  // 設定（BGM のオンとオフ、音量、効果音のオンとオフ）を反映する
  applyVolume() {
    const a = this.ctx as AudioContext | null;
    if (!a || a.state === 'closed') return;
    const v = bgmSettings.enabled ? bgmSettings.volume * 1.6 : 0;
    this.master.gain.cancelScheduledValues(a.currentTime);
    this.master.gain.setTargetAtTime(v, a.currentTime, 0.6);
    if (!this.wanted) {
      // どちらもオフなら止めておく（電池のため）
      if (a.state === 'running') void a.suspend().catch(() => {});
      this.silent?.pause();
    } else if (!document.hidden) this.wake(); // BGM のオンとオフで、消音スイッチの扱いも変わる
  }

  // 効果音の出口（音を出せないときは null）
  sfxOut(): { ctx: AudioContext; out: GainNode } | null {
    const a = this.ctx as AudioContext | null;
    if (!a || a.state === 'closed') return null;
    // 止まっている間に予約すると、動き出したときにまとめて鳴るので、鳴らさない
    if (a.state !== 'running') {
      if (!document.hidden) void a.resume().catch(() => {});
      return null;
    }
    // 'running' でも時間が止まっていることがある（音の出口の切り替えなど）。そのときも鳴らさない
    if (this.frozen(a, 400) || this.stuck) return null;
    if (!this.fx) {
      this.fx = a.createGain();
      this.fx.connect(a.destination);
    }
    return { ctx: a, out: this.fx };
  }

  // 音の時間が ms ミリ秒より長く進んでいなければ true（進んでいれば、見張りの記録を新しくする）
  private frozen(a: BaseAudioContext, ms: number) {
    const now = a.currentTime, wall = performance.now();
    if (!this.ctWall || now > this.ctLast + 0.01) {
      this.ctWall = wall;
      this.ctLast = now;
      this.stuck = false;
      return false;
    }
    return wall - this.ctWall > ms;
  }

  // 次の曲へ（4曲を順番に）
  private nextSong() {
    this.songIdx = (this.songIdx + 1) % SONGS.length;
    this.song = SONGS[this.songIdx];
    this.chordIdx = 0;
    this.loops = 0;
  }

  private tick() {
    const a = this.ctx;
    if (!a || a.state !== 'running') {
      this.ctWall = 0;
      return;
    }
    // 時間が進んでいるかを見張る（2秒たっても進まなければ、止まっているとみなす）
    if (this.frozen(a, 2000)) this.stuck = true;
    if (!bgmSettings.enabled) return;
    const now = a.currentTime;
    // 予約が遅れたとき（BGM をオフにしていた、タイマーが止まっていた）は、たまった和音をまとめて鳴らさず、今から続ける
    if (this.nextTime < now - 0.25 || this.nextTime > now + 30) this.nextTime = now + 0.3;
    // 3秒先までの和音を予約する（和音どうしは重なって、ゆっくり入れ替わる）
    while (this.nextTime < now + 3) {
      const s = this.song;
      if (this.chordIdx === 0 && this.loops === 0) this.onSong?.(s.name);
      this.chord(this.nextTime, s.chords[this.chordIdx], s.len, s.bright);
      this.nextTime += s.len;
      if (++this.chordIdx >= s.chords.length) {
        this.chordIdx = 0;
        // 2回くり返したら次の曲
        if (++this.loops >= LOOPS) this.nextSong();
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
