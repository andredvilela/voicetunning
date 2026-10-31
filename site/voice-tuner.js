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
    this.fLevel = new Float32Array(this.FR);
    this.fCount = 0;
    this.scale = [true,false,true,false,true,true,false,true,false,true,false,true];
    this.tau = 0.04; this.enabled = true;
    this.gateDb = -52; this.gate = 0;
    this.corr = 0; this.target = -1; this.hist = [];
    this.lastVoiced = false; this.silent = 0; this.rmsDb = -120;
    this.Tu = Math.round(sr * 0.006);
    this.FMIN = 0.6;           // menor fator de formante aceito
    this.transpose = 0;        // tom da voz, em semitons
    this.timbre = 1;           // multiplicador de formante para todas as vozes
    this.vibDepth = 0; this.vibRate = 5.5; this.vibDelay = 0.35; this.vibPhase = 0; this.vibAmt = 0; this.hold = 0;
    this.breath = 0; this.lvl = 0; this.nL = 0; this.nR = 0;
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
        fBase: c.formant || 1, formant: 1,
        detune: c.detune || 0,
        dir: c.dir === -1 ? -1 : 1,
        rough: Math.max(0, Math.min(1, c.rough || 0)), flip: false,
        delay: Math.min(this.MAXDELAY, Math.round((c.delayMs || 0) * this.sr / 1000)),
        gL: Math.SQRT2 * Math.cos(ang), gR: Math.SQRT2 * Math.sin(ang)
      };
      v.formant = this.clampF(v.fBase * this.timbre);
      const o = old[i];
      if (o && o.delay === v.delay && this.D) { v.sMark = o.sMark; v.aMark = o.aMark; } else if (this.D) this.resetVoice(v);
      return v;
    });
    if (this.maxT) this.recalc(false);
  }
  clampF(f) { return Math.max(this.FMIN, Math.min(1.6, f)); }
  setTimbre(t) {
    this.timbre = t;
    for (const v of this.voices) v.formant = this.clampF(v.fBase * t);
    this.recalc(false);
  }
  config(m) {
    if (!m) return;
    if (m.type === 'transpose') { this.transpose = Math.max(-12, Math.min(12, m.v)); return; }
    if (m.type === 'timbre') { this.setTimbre(Math.max(0.6, Math.min(1.5, m.v))); return; }
    if (m.type === 'vibrato') { this.vibDepth = m.depth; this.vibRate = m.rate || 5.5; return; }
    if (m.type === 'breath') { this.breath = m.v; return; }
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
  // nota 'steps' graus da escala acima (positivo) ou abaixo (negativo): ±2 = terça, ±4 = quinta
  harm(t, steps) {
    const dir = steps < 0 ? -1 : 1, want = Math.abs(steps);
    if (this.isChromatic()) return t + dir * (want === 2 ? 4 : 7);
    let n = t, c = 0, guard = 0;
    while (c < want && guard++ < 24) { n += dir; if (this.scale[((n % 12) + 12) % 12]) c++; }
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
      const sh = mm + this.transpose;          // nota já deslocada pelo "tom da voz"
      if (this.enabled) {
        const n = this.nearest(sh);
        if (this.target < 0 || Math.abs(sh - this.target) > Math.abs(sh - n) + 0.12) { if (n !== this.target) this.hold = 0; this.target = n; }
        const desired = this.target - midi;
        if (!this.lastVoiced) this.corr = this.tau < 0.02 ? desired : this.transpose;
        const a = this.tau <= 0 ? 1 : 1 - Math.exp(-(this.q / this.sr) / this.tau);
        this.corr += (desired - this.corr) * a;
      } else {
        const n = Math.round(sh);
        if (n !== this.target) this.hold = 0;
        this.target = n;
        this.corr = this.transpose;
      }
      if (this.corr > 24) this.corr = 24; if (this.corr < -24) this.corr = -24;
      // vibrato automático: entra depois de segurar a nota por um instante
      this.hold += this.q / this.sr;
      const ramp = Math.min(1, Math.max(0, (this.hold - this.vibDelay) / 0.3));
      this.vibAmt += (ramp - this.vibAmt) * 0.2;
      this.silent = 0;
    } else {
      this.hist.length = 0; this.hold = 0; this.vibAmt *= 0.8;
      if (++this.silent > 60) this.target = -1;
    }
    this.vibPhase += 2 * Math.PI * this.vibRate * this.q / this.sr;
    if (this.vibPhase > 2 * Math.PI) this.vibPhase -= 2 * Math.PI;
    const vib = this.vibDepth / 100 * Math.sin(this.vibPhase) * this.vibAmt;
    this.lastVoiced = voiced;
    this.fPeriod[j] = period;
    this.fVoiced[j] = voiced ? 1 : 0;
    this.fGate[j] = this.gate;
    this.fCorr[j] = this.corr + vib;
    this.fTarget[j] = this.target;
    this.fLevel[j] = Math.pow(10, this.rmsDb / 20) * this.gate;
    this.fCount++;
    this.cur = voiced ? { raw: midi, out: midi + this.corr + vib, tgt: this.target, tr: this.transpose } : null;
  }
  // deslocamento em semitons de uma voz para o quadro fi
  semis(v, fi) {
    const corr = this.fCorr[fi], tgt = this.fTarget[fi];
    switch (v.kind) {
      case 'double': return corr + v.detune / 100;
      case 'octave': return corr - 12;
      case 'third': return tgt < 0 ? corr + 4 * v.dir : corr + this.harm(tgt, 2 * v.dir) - tgt;
      case 'fifth': return tgt < 0 ? corr + 7 * v.dir : corr + this.harm(tgt, 4 * v.dir) - tgt;
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
      let g = (fi >= 0 ? this.fGate[fi] : 0) * v.gain * uv;
      const beta = v.formant;
      const T = Math.max(8, Math.round(P));
      const Tg = Math.max(8, Math.round(T / beta));
      let Ts = P / ratio;
      // voz rasgada: pulsos alternados (sub-harmônico, o "rosnado") + pequenas variações de amplitude e período
      if (v.rough > 0 && voiced) {
        v.flip = !v.flip;
        g *= 1 + (v.flip ? 1 : -1) * v.rough * 0.28 + (Math.random() * 2 - 1) * v.rough * 0.18;
        Ts *= 1 + (Math.random() * 2 - 1) * v.rough * 0.012;
      }
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
    // sopro: ruído suave que segue o volume da voz (no mesmo atraso da voz processada)
    let l0 = this.lvl, l1 = l0;
    if (this.breath > 0) {
      const fo = this.frameAt(this.pos - this.D);
      const want = fo >= 0 ? this.fLevel[fo] : 0;
      l1 = l0 + (want - l0) * 0.35;
      this.lvl = l1;
    }
    const bAmt = this.breath * 1.6;
    for (let i = 0; i < n; i++) {
      const idx = (this.pos + i) & mask;
      let L = this.outL[idx], R = this.outR[idx];
      if (bAmt > 0) {
        const lv = (l0 + (l1 - l0) * i / n) * bAmt;
        const wl = Math.random() * 2 - 1, wr = Math.random() * 2 - 1;
        L += (wl - this.nL) * 0.5 * lv; R += (wr - this.nR) * 0.5 * lv;
        this.nL = wl; this.nR = wr;
      }
      outL[i] = L; this.outL[idx] = 0;
      if (outR) outR[i] = R;
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
        if (ev.data && (ev.data.type === 'range' || ev.data.type === 'voices' || ev.data.type === 'timbre')) this.port.postMessage({ type: 'lat', v: this.e.D / sampleRate });
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
        this.port.postMessage(r ? { type: 'r', raw: r.raw, out: r.out, tgt: r.tgt, tr: r.tr } : { type: 'r', raw: 0 });
      }
      return true;
    }
  }
  registerProcessor('voice-tuner', TunerProcessor);
}
