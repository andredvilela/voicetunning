# VoiceTunning

Afinação de voz em tempo real no navegador: microfone → afinação no tom da música → presets de voz (dupla, coral, robô, rádio AM…) → fone ou caixa de som.

- `site/` — o que vai ao ar no Netlify (`index.html` + `voice-tuner.js`).
- `src/` — modelo da página e script de build: `node src/build.js` gera `site/index.html` embutindo o motor de `site/voice-tuner.js`.

Precisa ser aberto por https (Netlify) no Chrome. Uso caseiro.
