#!/usr/bin/env node
/**
 * Talking Head relay: runs the voice pipeline on Meta Model API so the browser never holds a key.
 *
 *   browser  --PCM16 24k-->  relay  --WebSocket-->  Muse Voice Transcribe   (speech to text)
 *                            relay  --HTTPS----->   Muse Spark              (reply, streamed)
 *                            relay  --HTTPS----->   text-to-speech provider (voice, streamed)
 *   browser  <--PCM16 24k--  relay
 *
 * Protocol with the browser (one WebSocket per face):
 *   client -> relay   JSON {type:'hello', turnMode:'pushToTalk'|'openMic'}
 *                     JSON {type:'talk', on:true|false}      push-to-talk edges
 *                     binary                                  PCM16 mono 24 kHz mic audio
 *                     JSON {type:'interrupt'}                  stop the current reply
 *                     JSON {type:'reset'}                      forget the conversation
 *   relay -> client   JSON {type:'state', state}               listening | thinking | speaking | idle
 *                     JSON {type:'transcript', role, text}     user | agent
 *                     binary                                  PCM16 mono 24 kHz reply audio
 *                     JSON {type:'speechEnd'}                  no more audio for this reply
 *                     JSON {type:'error', message}
 *
 * Env: META_API_KEY (or MODEL_API_KEY), MUSE_MODEL, TTS_PROVIDER (elevenlabs | custom | none),
 *      ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_TTS_MODEL, TTS_URL, PERSONA, PORT, MOCK.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d = '') => process.env[k] ?? d;
const MOCK = env('MOCK') === '1' || process.argv.includes('--mock');
const PORT = Number(env('PORT', '8787'));
// Hosting platforms set PORT and expect 0.0.0.0; local runs stay on loopback unless HOST is given.
const HOST = env('HOST', process.env.PORT ? '0.0.0.0' : '127.0.0.1');
/** Shared secret the browser must present in its hello. Required whenever the relay is reachable beyond localhost. */
const RELAY_TOKEN = env('RELAY_TOKEN');
const META_KEY = env('META_API_KEY') || env('MODEL_API_KEY');
const META_BASE = env('META_API_BASE', 'https://api.meta.ai/v1');
const ASR_URL = env('META_ASR_URL', 'wss://api.meta.ai/v1/asr/realtime');
const LLM_MODEL = env('MUSE_MODEL', 'muse-spark-1.3');
const ASR_MODEL = env('MUSE_ASR_MODEL', 'muse-voice-transcribe-1.0');
const TTS = env('TTS_PROVIDER', env('ELEVENLABS_API_KEY') ? 'elevenlabs' : 'none');
const PERSONA = readFileSync(env('PERSONA', path.join(here, '..', 'config', 'persona.md')), 'utf8');
const SAMPLE_RATE = 24000;
const MAX_HISTORY = 12;

if (!MOCK && !META_KEY) {
  console.error('Set META_API_KEY (from dev.meta.ai) or run with --mock');
  process.exit(1);
}
if (HOST !== '127.0.0.1' && !RELAY_TOKEN && !MOCK) {
  console.error('Relay is listening beyond localhost: set RELAY_TOKEN so strangers cannot spend your credits');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const DEBUG = env('DEBUG') === '1';
const dbg = (...a) => DEBUG && log('  ·', ...a);

// ---------------------------------------------------------------- speech to text
/** One Voice Transcribe stream. Push PCM with send(); end() resolves with the final transcript. */
function openAsr(mode, onPartial, onSpeechComplete) {
  if (MOCK) return mockAsr(onSpeechComplete);
  const ws = new WebSocket(ASR_URL);
  let finalText = '';
  let lastText = '';
  let resolveEnd;
  const ended = new Promise((r) => (resolveEnd = r));
  const ready = new Promise((resolve, reject) => {
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          mode,
          authorization: { accessToken: `Bearer ${META_KEY}` },
          audioEncoding: 'PCM_24KHZ',
          model: ASR_MODEL,
          partialMode: 'CUMULATIVE',
          emitAudioProgress: false,
        }),
      );
      resolve();
    });
    ws.once('error', reject);
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let ev;
    try {
      ev = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (ev.type) {
      case 'transcript':
        lastText = ev.transcript ?? lastText;
        if (ev.final) finalText = lastText;
        onPartial?.(lastText, !!ev.final);
        break;
      case 'speechComplete':
        finalText = ev.transcript ?? finalText ?? lastText;
        onSpeechComplete?.(finalText);
        break;
      case 'error':
        log('asr error', ev.message);
        break;
    }
  });
  ws.on('close', () => resolveEnd(finalText || lastText));
  ws.on('error', (e) => log('asr socket error', e.message));
  return {
    ready,
    send: (buf) => ws.readyState === WebSocket.OPEN && ws.send(buf, { binary: true }),
    end: async () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'endStream' }));
      // The server flushes pending results then closes; give it a bounded wait.
      const t = setTimeout(() => ws.close(), 4000);
      const text = await ended;
      clearTimeout(t);
      return text;
    },
    close: () => ws.close(),
  };
}

function mockAsr(onSpeechComplete) {
  const chunks = [];
  let bytes = 0;
  return {
    ready: Promise.resolve(),
    send: (buf) => {
      chunks.push(Buffer.from(buf));
      bytes += buf.length;
    },
    end: async () => {
      const secs = bytes / (SAMPLE_RATE * 2);
      const text = secs < 0.3 ? '' : `(mock transcript, ${secs.toFixed(1)} s of audio)`;
      mockAsr.lastAudio = Buffer.concat(chunks);
      onSpeechComplete?.(text);
      return text;
    },
    close: () => {},
  };
}
mockAsr.lastAudio = Buffer.alloc(0);

// ---------------------------------------------------------------- reply
/** Stream a Muse Spark reply. Calls onText(delta) as tokens arrive; resolves with the full text. */
async function* streamReply(history, signal) {
  if (MOCK) {
    const canned = 'Well, that came through loud and clear. I am a mock brain, so all I can do is hand your own voice back to you. What would you ask a real one?';
    for (const w of canned.split(' ')) {
      if (signal.aborted) return;
      yield w + ' ';
      await new Promise((r) => setTimeout(r, 30));
    }
    return;
  }
  const res = await fetch(`${META_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${META_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      stream: true,
      max_tokens: 200,
      messages: [{ role: 'system', content: PERSONA }, ...history],
    }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Muse Spark HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        /* ignore keepalives */
      }
    }
  }
}

/** Split streamed text into sentences so speech can start before the reply is finished. */
async function* sentences(deltas) {
  let acc = '';
  for await (const d of deltas) {
    acc += d;
    let m;
    while ((m = acc.match(/^(.*?[.!?…]+)(\s+|$)/s)) && m[1].trim().length > 0) {
      const s = m[1].trim();
      acc = acc.slice(m[0].length);
      if (s.length >= 2) yield s;
    }
  }
  if (acc.trim()) yield acc.trim();
}

// ---------------------------------------------------------------- text to speech
/** Stream PCM16 24 kHz audio for one sentence into onAudio(buffer). */
async function speak(text, onAudio, signal) {
  if (MOCK) {
    // Hand the visitor's own recording back, like the Echo agent, so the mouth has something to chew on.
    const audio = mockAsr.lastAudio.length ? mockAsr.lastAudio : tone(0.6);
    for (let i = 0; i < audio.length && !signal.aborted; i += 4800) {
      onAudio(audio.subarray(i, i + 4800));
      await new Promise((r) => setTimeout(r, 100));
    }
    mockAsr.lastAudio = Buffer.alloc(0);
    return;
  }
  if (TTS === 'none') return;
  let res;
  if (TTS === 'elevenlabs') {
    const voice = env('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM');
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=pcm_24000`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': env('ELEVENLABS_API_KEY') },
      body: JSON.stringify({ text, model_id: env('ELEVENLABS_TTS_MODEL', 'eleven_flash_v2_5') }),
      signal,
    });
  } else if (TTS === 'custom') {
    // The slot for an internal voice: POST {text} -> raw PCM16 mono 24 kHz body, streamed.
    res = await fetch(env('TTS_URL'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env('TTS_API_KEY', META_KEY)}` },
      body: JSON.stringify({ text, sampleRate: SAMPLE_RATE }),
      signal,
    });
  } else {
    throw new Error(`unknown TTS_PROVIDER ${TTS}`);
  }
  if (!res.ok || !res.body) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  let carry = Buffer.alloc(0);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    // Keep frames on 16-bit sample boundaries.
    let b = Buffer.concat([carry, Buffer.from(value)]);
    const even = b.length - (b.length % 2);
    carry = b.subarray(even);
    b = b.subarray(0, even);
    if (b.length) onAudio(b);
  }
}

function tone(seconds) {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.sin((Math.PI * i) / n);
    b.writeInt16LE(Math.round(6000 * env * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * (0.6 + 0.4 * Math.sin(i / 900))), i * 2);
  }
  return b;
}

// ---------------------------------------------------------------- per-connection session
class Session {
  constructor(ws) {
    this.ws = ws;
    this.turnMode = 'pushToTalk';
    this.history = [];
    this.asr = null;
    this.reply = null; // AbortController for the reply in flight
    this.speaking = false;
    this.authed = !RELAY_TOKEN;
  }
  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
  audio(buf) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(buf, { binary: true });
  }
  state(s) {
    dbg('-> state', s);
    this.send({ type: 'state', state: s });
  }

  async onMessage(data, isBinary) {
    if (isBinary) {
      if (this.authed) this.asr?.send(data);
      return;
    }
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    dbg('<-', m.type, m.on ?? '', m.turnMode ?? '');
    if (!this.authed && m.type !== 'hello') return;
    switch (m.type) {
      case 'hello':
        if (RELAY_TOKEN && m.token !== RELAY_TOKEN) {
          this.send({ type: 'error', message: 'relay token missing or wrong (set it in the Agent folder or ?token=)' });
          this.ws.close(4001, 'unauthorized');
          return;
        }
        this.authed = true;
        this.turnMode = m.turnMode === 'openMic' ? 'openMic' : 'pushToTalk';
        this.history = [];
        if (this.turnMode === 'openMic') await this.openMicStream();
        this.state('idle');
        break;
      case 'talk':
        if (this.turnMode !== 'pushToTalk') break;
        if (m.on) await this.beginTurn();
        else await this.endTurn();
        break;
      case 'interrupt':
        this.interrupt();
        break;
      case 'reset':
        this.history = [];
        break;
    }
  }

  async beginTurn() {
    this.interrupt();
    this.asr?.close();
    this.asr = openAsr('PUSH_TO_TALK', null, null);
    try {
      await this.asr.ready;
    } catch (e) {
      this.send({ type: 'error', message: `speech-to-text connect failed: ${e.message}` });
      this.asr = null;
      return;
    }
    this.state('listening');
  }

  async endTurn() {
    const asr = this.asr;
    this.asr = null;
    if (!asr) return;
    this.state('thinking');
    const text = (await asr.end()).trim();
    if (!text) {
      this.state('idle');
      return;
    }
    await this.respond(text);
  }

  async openMicStream() {
    this.asr?.close();
    this.asr = openAsr(
      'ENDPOINTING',
      () => {
        // The visitor started talking over the head: stop the reply.
        if (this.speaking) this.interrupt();
      },
      (text) => text?.trim() && this.respond(text.trim()),
    );
    try {
      await this.asr.ready;
      this.state('listening');
    } catch (e) {
      this.send({ type: 'error', message: `speech-to-text connect failed: ${e.message}` });
    }
  }

  interrupt() {
    if (this.reply) {
      this.reply.abort();
      this.reply = null;
    }
    if (this.speaking) {
      this.speaking = false;
      this.send({ type: 'speechEnd', interrupted: true });
    }
  }

  async respond(userText) {
    this.interrupt();
    this.send({ type: 'transcript', role: 'user', text: userText });
    this.history.push({ role: 'user', content: userText });
    this.history = this.history.slice(-MAX_HISTORY);
    const ctl = new AbortController();
    this.reply = ctl;
    this.state('thinking');
    let full = '';
    try {
      for await (const sentence of sentences(streamReply(this.history, ctl.signal))) {
        if (ctl.signal.aborted) break;
        full += (full ? ' ' : '') + sentence;
        this.send({ type: 'transcript', role: 'agent', text: sentence });
        if (!this.speaking) {
          this.speaking = true;
          this.state('speaking');
        }
        await speak(sentence, (buf) => !ctl.signal.aborted && this.audio(buf), ctl.signal);
      }
    } catch (e) {
      if (!ctl.signal.aborted) this.send({ type: 'error', message: e.message });
    }
    if (full) this.history.push({ role: 'assistant', content: full });
    if (this.reply === ctl) {
      this.reply = null;
      if (this.speaking) {
        this.speaking = false;
        this.send({ type: 'speechEnd' });
      }
      this.state(this.turnMode === 'openMic' ? 'listening' : 'idle');
    }
  }

  close() {
    this.interrupt();
    this.asr?.close();
  }
}

// ---------------------------------------------------------------- server
// Plain HTTP answers health checks (hosting platforms poll GET /); WebSocket upgrades carry the faces.
const http = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`talking-head relay ok (${MOCK ? 'mock' : 'live'})\n`);
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws, req) => {
  const s = new Session(ws);
  log('face connected from', req.socket.remoteAddress);
  ws.on('message', (d, b) => s.onMessage(d, b).catch((e) => s.send({ type: 'error', message: e.message })));
  ws.on('close', () => {
    s.close();
    log('face disconnected');
  });
});
http.listen(PORT, HOST, () => {
  log(`relay on ws://${HOST}:${PORT}  mode=${MOCK ? 'MOCK' : 'live'}  llm=${LLM_MODEL}  asr=${ASR_MODEL}  tts=${TTS}  auth=${RELAY_TOKEN ? 'token' : 'none'}`);
});
