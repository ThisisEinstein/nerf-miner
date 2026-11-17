// 音效與音樂都用 Web Audio 即時合成，不需要任何音檔。
const flag = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : v === '1';
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v ? '1' : '0');
    } catch {
      // 不能存就算了
    }
  },
};

// 和弦進行：Am – F – C – G
const CHORDS = [
  [220, 261.63, 329.63, 440],
  [174.61, 220, 261.63, 349.23],
  [130.81, 164.81, 196, 261.63],
  [196, 246.94, 293.66, 392],
];
const ARP = [0, 1, 2, 1, 3, 2, 1, 2, 0, 2, 3, 2, 1, 2, 3, -1];
// 同一種音效最短要隔多久才會再響（秒）
const GAP = { dig: 0.11, torch: 0.25, coin: 0.08, hit: 0.07, click: 0.03, alert: 1.2, bad: 0.25, good: 0.2, tick: 0.5 };

class AudioKit {
  constructor() {
    this.ctx = null;
    this.sfxOn = flag.get('nm_sfx', true);
    this.musicOn = flag.get('nm_music', true);
    this.last = {};
    this.timer = null;
    this.step = 0;
    this.nextT = 0;
    this.intense = false;
    this.wantMusic = false;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 0.9;
      this.sfxBus.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.5;
      this.musicBus.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, len);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // 瀏覽器規定要使用者先點過畫面才能出聲；在第一次點擊時呼叫
  unlock() {
    if (this.ensure() && this.wantMusic) this.startMusic();
  }

  tone(freq, dur, o = {}) {
    const ctx = this.ctx;
    const t = ctx.currentTime + (o.delay || 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type || 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + dur);
    const vol = o.vol ?? 0.1;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.02, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(o.bus || this.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  noise(dur, o = {}) {
    const ctx = this.ctx;
    const t = ctx.currentTime + (o.delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.filter || 'lowpass';
    f.frequency.setValueAtTime(o.freq || 1000, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    f.Q.value = o.q || 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(o.vol ?? 0.1, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(o.bus || this.sfxBus);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }

  play(name) {
    if (!this.sfxOn || !this.ensure()) return;
    const now = this.ctx.currentTime;
    if (now - (this.last[name] ?? -9) < (GAP[name] || 0.04)) return;
    this.last[name] = now;
    const T = (f, d, o) => this.tone(f, d, o);
    const N = (d, o) => this.noise(d, o);
    switch (name) {
      case 'click':
        T(700, 0.04, { type: 'square', vol: 0.04 });
        break;
      case 'order':
        T(520, 0.05, { vol: 0.08 });
        T(780, 0.07, { vol: 0.08, delay: 0.05 });
        break;
      case 'dig':
        N(0.08, { freq: 900, vol: 0.16 });
        T(120, 0.06, { type: 'sine', vol: 0.12, to: 70 });
        break;
      case 'torch':
        N(0.2, { filter: 'bandpass', freq: 1400, to: 3000, vol: 0.06 });
        break;
      case 'coin':
        T(988, 0.07, { type: 'square', vol: 0.05 });
        T(1319, 0.14, { type: 'square', vol: 0.05, delay: 0.07 });
        break;
      case 'buy':
        T(523, 0.06, { vol: 0.09 });
        T(659, 0.09, { vol: 0.09, delay: 0.06 });
        break;
      case 'bad':
        T(196, 0.16, { type: 'sawtooth', vol: 0.06, to: 140 });
        break;
      case 'good':
        T(659, 0.08, { vol: 0.09 });
        T(880, 0.13, { vol: 0.09, delay: 0.08 });
        break;
      case 'alert':
        for (let k = 0; k < 2; k++) {
          T(880, 0.11, { type: 'square', vol: 0.07, delay: k * 0.3 });
          T(660, 0.11, { type: 'square', vol: 0.07, delay: k * 0.3 + 0.13 });
        }
        break;
      case 'boom':
        N(0.7, { freq: 500, to: 80, vol: 0.55 });
        T(95, 0.6, { type: 'sine', vol: 0.5, to: 32 });
        break;
      case 'laser':
        T(1500, 0.26, { type: 'sawtooth', vol: 0.1, to: 180 });
        break;
      case 'hit':
        N(0.05, { filter: 'highpass', freq: 1800, vol: 0.16 });
        T(210, 0.05, { type: 'square', vol: 0.06 });
        break;
      case 'death':
        T(440, 0.4, { vol: 0.12, to: 105 });
        break;
      case 'freeze':
        T(1700, 0.32, { type: 'sine', vol: 0.07, to: 2700 });
        N(0.3, { filter: 'highpass', freq: 5000, vol: 0.05 });
        break;
      case 'capture':
        [523, 659, 784, 1047].forEach((f, k) => T(f, 0.1, { vol: 0.09, delay: k * 0.08 }));
        break;
      case 'spike':
        T(300, 0.06, { type: 'square', vol: 0.07 });
        N(0.1, { filter: 'highpass', freq: 3000, vol: 0.1 });
        break;
      case 'snuff':
        N(0.35, { filter: 'bandpass', freq: 900, to: 300, vol: 0.1 });
        break;
      case 'announce':
        T(587, 0.18, { vol: 0.1 });
        T(784, 0.26, { vol: 0.1, delay: 0.18 });
        break;
      case 'pop':
        T(700, 0.09, { type: 'sine', vol: 0.1, to: 950 });
        break;
      case 'tick':
        T(1000, 0.035, { type: 'square', vol: 0.05 });
        break;
      case 'start':
        [392, 523, 784].forEach((f, k) => T(f, 0.14, { vol: 0.1, delay: k * 0.11 }));
        break;
      case 'win':
        [523, 659, 784, 1047, 1319].forEach((f, k) => T(f, 0.2, { vol: 0.11, delay: k * 0.12 }));
        break;
      case 'lose':
        [392, 330, 262, 196].forEach((f, k) => T(f, 0.26, { vol: 0.1, delay: k * 0.18 }));
        break;
    }
  }

  setSfx(on) {
    this.sfxOn = on;
    flag.set('nm_sfx', on);
  }

  setMusic(on) {
    this.musicOn = on;
    flag.set('nm_music', on);
    if (on && this.wantMusic) this.startMusic();
    else this.stopMusic(true);
  }

  // ---------- 音樂：一段會一直變化的簡單循環 ----------

  startMusic() {
    this.wantMusic = true;
    if (!this.musicOn || this.timer || !this.ctx || this.ctx.state !== 'running') return;
    this.nextT = this.ctx.currentTime + 0.1;
    this.step = 0;
    this.timer = setInterval(() => this.schedule(), 110);
  }

  stopMusic(keepWant = false) {
    if (!keepWant) this.wantMusic = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  schedule() {
    const ctx = this.ctx;
    const spb = this.intense ? 0.29 : 0.36;
    if (this.nextT < ctx.currentTime) this.nextT = ctx.currentTime + 0.05;
    while (this.nextT < ctx.currentTime + 0.45) {
      this.beat(this.step, this.nextT - ctx.currentTime, spb);
      this.nextT += spb;
      this.step++;
    }
  }

  beat(s, delay, spb) {
    const bus = this.musicBus;
    const chord = CHORDS[Math.floor(s / 16) % 4];
    const k = s % 16;
    if (k === 0) {
      for (const f of [chord[0], chord[2]]) {
        this.tone(f, spb * 15, { type: 'sine', vol: 0.045, delay, bus });
        this.tone(f * 1.006, spb * 15, { type: 'sine', vol: 0.03, delay, bus });
      }
    }
    if (k % 4 === 0) this.tone(chord[0] / 2, spb * 3.4, { type: 'triangle', vol: 0.11, delay, bus });
    const n = ARP[k];
    if (n >= 0 && (k % 2 === 0 || Math.random() < 0.55)) this.tone(chord[n] * 2, spb * 1.6, { type: 'triangle', vol: 0.05, delay, bus });
    if (this.intense && k % 2 === 0) this.noise(0.04, { filter: 'highpass', freq: 6000, vol: 0.05, delay, bus });
  }
}

export const audio = new AudioKit();
