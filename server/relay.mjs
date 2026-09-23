#!/usr/bin/env node
/**
 * Talking Head relay: the long-lived server variant of the pipeline in server/pipeline.mjs.
 * Needed for open-mic mode (streaming speech-to-text with the model's own endpointing); for
 * push-to-talk the serverless HTTP turn endpoint (api/turn.js, also served here at POST /turn)
 * is enough and needs no always-on process.
 *
 * WebSocket protocol with the browser (one socket per face):
 *   client -> relay   JSON {type:'hello', turnMode:'pushToTalk'|'openMic', token}
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
 * Env: see .env.example (META_API_KEY, RELAY_TOKEN, TTS_PROVIDER, ..., PORT, HOST, MOCK, DEBUG).
 */
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import {
  env, MOCK, META_KEY, ASR_MODEL, LLM_MODEL, TTS, RELAY_TOKEN, SAMPLE_RATE, MAX_HISTORY,
  log, mockState, streamReply, sentences, speak, handleTurn,
} from './pipeline.mjs';

const PORT = Number(env('PORT', '8787'));
// Hosting platforms set PORT and expect 0.0.0.0; local runs stay on loopback unless HOST is given.
const HOST = env('HOST', process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const ASR_URL = env('META_ASR_URL', 'wss://api.meta.ai/v1/asr/realtime');
const DEBUG = env('DEBUG') === '1';
const dbg = (...a) => DEBUG && log('  ·', ...a);

if (!MOCK && !META_KEY) {
  console.error('Set META_API_KEY (from dev.meta.ai) or run with --mock');
  process.exit(1);
}
if (HOST !== '127.0.0.1' && !RELAY_TOKEN && !MOCK) {
  console.error('Relay is listening beyond localhost: set RELAY_TOKEN so strangers cannot spend your credits');
  process.exit(1);
}

// ---------------------------------------------------------------- streaming speech to text
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
      mockState.lastAudio = Buffer.concat(chunks);
      onSpeechComplete?.(text);
      return text;
    },
    close: () => {},
  };
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
// Plain HTTP: health checks, and POST /turn (the same handler Vercel runs) for push-to-talk clients.
const http = createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (req.method === 'GET' && (url === '/' || url === '/healthz')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`talking-head relay ok (${MOCK ? 'mock' : 'live'})\n`);
    return;
  }
  if (url === '/turn' || url === '/api/turn') {
    // CORS so a page served from Vercel or localhost:5173 can call a relay on another origin.
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const ctl = new AbortController();
      req.on('close', () => ctl.abort());
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(`http://${HOST}:${PORT}${url}`, { method: req.method, headers: req.headers, body: hasBody ? Buffer.concat(chunks) : undefined, signal: ctl.signal });
      const response = await handleTurn(request);
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...cors });
      if (!response.body) return res.end();
      for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (e) {
      log('turn handler error', e.message);
      if (!res.headersSent) res.writeHead(500, cors);
      res.end(`relay error: ${e.message}`);
    }
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws, req) => {
  const s = new Session(ws);
  log('face connected from', req.headers['x-forwarded-for'] ?? req.socket.remoteAddress);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (d, b) => s.onMessage(d, b).catch((e) => s.send({ type: 'error', message: e.message })));
  ws.on('close', () => {
    s.close();
    log('face disconnected');
  });
});
// Keepalive: hosted ingresses (Azure Container Apps, load balancers) drop idle connections after a
// few minutes; a ping every 25 s keeps an idle face attached. Browsers answer pings automatically.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000).unref();
http.listen(PORT, HOST, () => {
  log(`relay on ws://${HOST}:${PORT} (+ POST /turn)  mode=${MOCK ? 'MOCK' : 'live'}  llm=${LLM_MODEL}  asr=${ASR_MODEL}  tts=${TTS}  auth=${RELAY_TOKEN ? 'token' : 'none'}`);
});
