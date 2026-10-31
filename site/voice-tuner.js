// VoiceTunning — motor de afinação (AudioWorklet)
// Detecção de pitch (YIN, em taxa reduzida) + ressíntese PSOLA com várias vozes:
// principal, terça, quinta, oitava abaixo e dobra; cada voz com timbre (formante), ganho e pan.
class TunerEngine {
  constructor(sr, opts) {
    opts = opts || {};
    this.sr = sr;
    this.N = 16384; this.mask = this.N - 1;
    this.inBuf = new Float32Array(this.N);
    this.outL = new Float32Array(this.N);
    this.outR = new Float32Array(this.N);
    this.pos = 0;
    this.q = 128;
    this.dec = Math.max(1, Math.round(sr / 16000));
    this.dsr = sr / this.dec;
    this.DN = 4096; this.dmask = this.DN - 1;
    this.dBuf = new Float32Array(this.DN);
    this.dPos = 0; this.dAcc = 0; this.dCnt = 0;
    this.FR = 512;
    this.fPeriod = new Float32Array(this.FR);
    this.fVoiced = new Uint8Array(this.FR);
    this.fGate = new Float32Array(this.FR);
    this.fCorr = new Float32Array(this.FR);
    this.fTarget = new Int16Array(this.FR).fill(-1);
    this.fCount = 0;
    this.scale = [true,false,true,false,true,true,false,true,false,true,false,true];
    this.tau = 0.04; this.enabled = true;
    this.gateDb = -52; this.gate = 0;
    this.corr = 0; this.target = -1; this.hist = [];
    this.lastVoiced = false; this.silent = 0; this.rmsDb = -120;
    this.Tu = Math.round(sr * 0.006);
    this.FMIN = 0.75;          // menor fator de formante aceito (define a folga de atraso)
    this.MAXDELAY = Math.round(sr * 0.04);
    this.voices = [];
    this.setRange(opts.minHz || 80, opts.maxHz || 1100);
    this.setVoices([{ kind: 'main' }]);
  }
  setRange(minHz, maxHz) {
    this.maxT = Math.ceil(this.sr / minHz);
    this.dMaxLag = Math.ceil(this.dsr / minHz);
    this.dMinLag = Math.max(2, Math.floor(this.dsr / maxHz));
    this.L = this.dMaxLag;
    this.W = this.L + this.dMaxLag;
    this.halfWin = this.dMaxLag * this.dec;
    this.cmnd = new Float32Array(this.dMaxLag + 2);
    this.tmp = new Float32Array(this.W + 2);
    this.recalc(true);
  }
  // Atraso do motor: só reserva folga extra quando alguma voz escurece o timbre (formante < 1).
  recalc(force) {
    let fmin = 1;
    for (const v of this.voices) if (v.formant < fmin) fmin = v.formant;
    const TgMax = Math.ceil(this.maxT / fmin);
    const D = this.maxT + TgMax + this.q;
    if (!force && D === this.D && TgMax === this.TgMax) return false;
    this.TgMax = TgMax; this.D = D;
    this.outL.fill(0); this.outR.fill(0);
    for (const v of this.voices) this.resetVoice(v);
    return true;
  }
  resetVoice(v) { v.sMark = this.pos + this.D + v.delay; v.aMark = this.pos; }
  setVoices(list) {
    const old = this.voices || [];
    this.voices = list.slice(0, 4).map((c, i) => {
      const pan = Math.max(-1, Math.min(1, c.pan || 0));
      const ang = (pan + 1) * Math.PI / 4;
      const v = {
        kind: c.kind || 'main',
        gain: c.gain == null ? 1 : c.gain,
        formant: Math.max(this.FMIN, Math.min(1.5, c.formant || 1)),
        detune: c.detune || 0,
        delay: Math.min(this.MAXDELAY, Math.round((c.delayMs || 0) * this.sr / 1000)),
        gL: Math.SQRT2 * Math.cos(ang), gR: Math.SQRT2 * Math.sin(ang)
      };
      const o = old[i];
      if (o && o.delay === v.delay && this.D) { v.sMark = o.sMark; v.aMark = o.aMark; } else if (this.D) this.resetVoice(v);
      return v;
    });
    if (this.maxT) this.recalc(false);
  }
  config(m) {
    if (!m) return;
    if (m.type === 'scale') this.scale = m.notes.slice();
    else if (m.type === 'tau') this.tau = m.v;
    else if (m.type === 'enabled') this.enabled = !!m.v;
    else if (m.type === 'gate') this.gateDb = m.v;
    else if (m.type === 'range') this.setRange(m.min, m.max);
    else if (m.type === 'voices') this.setVoices(m.list || [{ kind: 'main' }]);
  }
  isChromatic() { for (let i = 0; i < 12; i++) if (!this.scale[i]) return false; return true; }
  nearest(m) {
    const r = Math.round(m); let best = r, bd = 1e9;
    for (let k = r - 3; k <= r + 3; k++) {
      const pc = ((k % 12) + 12) % 12;
      if (this.scale[pc]) { const d = Math.abs(m - k); if (d < bd) { bd = d; best = k; } }
    }
    return best;
  }
  // nota 'steps' graus acima na escala (2 = terça, 4 = quinta)
  harm(t, steps) {
    if (this.isChromatic()) return t + (steps === 2 ? 4 : 7);
    let n = t, c = 0, guard = 0;
    while (c < steps && guard++ < 24) { n++; if (this.scale[((n % 12) + 12) % 12]) c++; }
    return n;
  }
  frameAt(t) {
    if (this.fCount === 0) return -1;
    let j = Math.floor((t + this.halfWin) / this.q) - 1;
    const last = this.fCount - 1;
    if (j > last) j = last;
    if (j < 0 || j < this.fCount - this.FR) return -1;
    return j % this.FR;
  }
  analyze() {
    const j = this.fCount % this.FR;
    let voiced = false, period = this.Tu, midi = 0;
    if (this.dPos > this.W) {
      const W = this.W, start = this.dPos - W, b = this.dBuf, m = this.dmask, x = this.tmp;
      let e = 0;
      for (let i = 0; i < W; i++) { const v = b[(start + i) & m]; x[i] = v; e += v * v; }
      this.rmsDb = 10 * Math.log10(e / W + 1e-12);
      if (this.rmsDb > this.gateDb - 6) {
        const c = this.cmnd, L = this.L, maxLag = this.dMaxLag;
        let run = 0; c[0] = 1;
        for (let t = 1; t <= maxLag; t++) {
          let s = 0;
          for (let i = 0; i < L; i++) { const d = x[i] - x[i + t]; s += d * d; }
          run += s;
          c[t] = run > 0 ? s * t / run : 1;
        }
        let tau = -1;
        for (let t = this.dMinLag; t <= maxLag; t++) {
          if (c[t] < 0.15) { while (t + 1 <= maxLag && c[t + 1] < c[t]) t++; tau = t; break; }
        }
        if (tau > 1 && tau < maxLag) {
          const y0 = c[tau - 1], y1 = c[tau], y2 = c[tau + 1];
          const den = y0 - 2 * y1 + y2;
          let dl = den !== 0 ? 0.5 * (y0 - y2) / den : 0;
          if (dl > 1) dl = 1; if (dl < -1) dl = -1;
          period = (tau + dl) * this.dec;
          voiced = true;
        }
      }
    }
    const open = this.rmsDb > this.gateDb;
    this.gate += ((open ? 1 : 0) - this.gate) * (open ? 0.35 : 0.04);

    if (voiced) {
      midi = 69 + 12 * Math.log2(this.sr / period / 440);
      this.hist.push(midi); if (this.hist.length > 3) this.hist.shift();
      const s = this.hist.slice().sort((a, b) => a - b);
      const mm = s[s.length >> 1];
      const n = this.nearest(mm);
      if (this.target < 0 || Math.abs(mm - this.target) > Math.abs(mm - n) + 0.12) this.target = n;
      if (this.enabled) {
        const desired = this.target - midi;
        if (!this.lastVoiced) this.corr = this.tau < 0.02 ? desired : 0;
        const a = this.tau <= 0 ? 1 : 1 - Math.exp(-(this.q / this.sr) / this.tau);
        this.corr += (desired - this.corr) * a;
        if (this.corr > 12) this.corr = 12; if (this.corr < -12) this.corr = -12;
      } else this.corr = 0;
      this.silent = 0;
    } else {
      this.hist.length = 0;
      if (++this.silent > 60) this.target = -1;
    }
    this.lastVoiced = voiced;
    this.fPeriod[j] = period;
    this.fVoiced[j] = voiced ? 1 : 0;
    this.fGate[j] = this.gate;
    this.fCorr[j] = this.corr;
    this.fTarget[j] = this.target;
    this.fCount++;
    this.cur = voiced ? { raw: midi, out: midi + this.corr, tgt: this.target } : null;
  }
  // deslocamento em semitons de uma voz para o quadro fi
  semis(v, fi) {
    const corr = this.fCorr[fi], tgt = this.fTarget[fi];
    switch (v.kind) {
      case 'double': return corr + v.detune / 100;
      case 'octave': return corr - 12;
      case 'third': return tgt < 0 ? corr + 4 : corr + this.harm(tgt, 2) - tgt;
      case 'fifth': return tgt < 0 ? corr + 7 : corr + this.harm(tgt, 4) - tgt;
      default: return corr;
    }
  }
  renderVoice(v, end) {
    const mask = this.mask, ib = this.inBuf, oL = this.outL, oR = this.outR;
    let guard = 0;
    while (v.sMark - this.TgMax < end && guard++ < 128) {
      const t = v.sMark - this.D - v.delay;
      let fi = this.frameAt(v.aMark);
      let P = fi < 0 || !this.fVoiced[fi] ? this.Tu : this.fPeriod[fi];
      while (v.aMark + P <= t) {
        v.aMark += P;
        fi = this.frameAt(v.aMark);
        P = fi < 0 || !this.fVoiced[fi] ? this.Tu : this.fPeriod[fi];
      }
      const voiced = fi >= 0 && this.fVoiced[fi] === 1;
      let ratio = 1;
      if (voiced) { ratio = Math.pow(2, this.semis(v, fi) / 12); if (ratio < 0.25) ratio = 0.25; if (ratio > 4) ratio = 4; }
      else if (v.kind === 'octave') ratio = 1;
      // consoantes: vozes de harmonia/oitava entram mais baixas para não embolar
      const uv = voiced || v.kind === 'main' || v.kind === 'double' ? 1 : 0.3;
      const g = (fi >= 0 ? this.fGate[fi] : 0) * v.gain * uv;
      const beta = v.formant;
      const T = Math.max(8, Math.round(P));
      const Tg = Math.max(8, Math.round(T / beta));
      const Ts = P / ratio;
      const norm = (Ts / Tg) * g;
      if (norm > 1e-5) {
        const c = Math.round(v.sMark), w = Math.PI / Tg, gl = norm * v.gL, gr = norm * v.gR;
        if (beta === 1) {
          const a = Math.round(v.aMark);
          for (let k = -Tg; k < Tg; k++) {
            const s = ib[(a + k) & mask] * (0.5 - 0.5 * Math.cos(w * (k + Tg)));
            const o = (c + k) & mask;
            oL[o] += s * gl; oR[o] += s * gr;
          }
        } else {
          const a = v.aMark;
          for (let k = -Tg; k < Tg; k++) {
            const p = a + k * beta, i0 = Math.floor(p), fr = p - i0;
            const x0 = ib[i0 & mask], x1 = ib[(i0 + 1) & mask];
            const s = (x0 + (x1 - x0) * fr) * (0.5 - 0.5 * Math.cos(w * (k + Tg)));
            const o = (c + k) & mask;
            oL[o] += s * gl; oR[o] += s * gr;
          }
        }
      }
      v.sMark += Ts;
    }
  }
  process(inp, outL, outR) {
    const n = outL.length, mask = this.mask;
    for (let i = 0; i < n; i++) {
      const x = inp ? inp[i] : 0;
      this.inBuf[(this.pos + i) & mask] = x;
      this.dAcc += x;
      if (++this.dCnt === this.dec) { this.dBuf[this.dPos & this.dmask] = this.dAcc / this.dec; this.dPos++; this.dAcc = 0; this.dCnt = 0; }
    }
    const end = this.pos + n;
    this.analyze();
    for (const v of this.voices) this.renderVoice(v, end);
    for (let i = 0; i < n; i++) {
      const idx = (this.pos + i) & mask;
      outL[i] = this.outL[idx]; this.outL[idx] = 0;
      if (outR) outR[i] = this.outR[idx];
      this.outR[idx] = 0;
    }
    this.pos = end;
  }
}
if (typeof AudioWorkletProcessor !== 'undefined') {
  class TunerProcessor extends AudioWorkletProcessor {
    constructor(o) {
      super();
      this.e = new TunerEngine(sampleRate, (o && o.processorOptions) || {});
      this.k = 0;
      this.port.onmessage = (ev) => {
        this.e.config(ev.data);
        if (ev.data && (ev.data.type === 'range' || ev.data.type === 'voices')) this.port.postMessage({ type: 'lat', v: this.e.D / sampleRate });
      };
      this.port.postMessage({ type: 'lat', v: this.e.D / sampleRate });
    }
    process(inputs, outputs) {
      const inp = inputs[0] && inputs[0][0];
      const out = outputs[0];
      this.e.process(inp, out[0], out[1]);
      if (++this.k >= 8) {
        this.k = 0;
        const r = this.e.cur;
        this.port.postMessage(r ? { type: 'r', raw: r.raw, out: r.out, tgt: r.tgt } : { type: 'r', raw: 0 });
      }
      return true;
    }
  }
  registerProcessor('voice-tuner', TunerProcessor);
}
