/**
 * The voice pipeline on Meta Model API, shared by the WebSocket relay (server/relay.mjs) and the
 * serverless HTTP turn handler (api/turn.js). No server-only dependencies here: only fetch.
 *
 *   speech to text : Muse Voice Transcribe, one-shot POST /v1/asr/transcribe (WAV)
 *   reply          : Muse Spark, streamed chat completion
 *   voice          : ElevenLabs TTS, a custom PCM endpoint, or none
 *
 * HTTP turn protocol (POST):
 *   request body   = [u32 BE jsonLength][json][pcm16 mono 24 kHz]
 *                    json: { token, history: [{role, content}], sampleRate }
 *   response body  = frames [u8 type][u32 BE length][payload], streamed
 *                    type 1 = JSON message ({type:'state'|'transcript'|'speechEnd'|'error', ...})
 *                    type 2 = PCM16 mono 24 kHz audio
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const env = (k, d = '') => process.env[k] ?? d;
export const MOCK = env('MOCK') === '1' || process.argv.includes('--mock');
export const META_KEY = env('META_API_KEY') || env('MODEL_API_KEY');
export const META_BASE = env('META_API_BASE', 'https://api.meta.ai/v1');
export const LLM_MODEL = env('MUSE_MODEL', 'muse-spark-1.3');
export const ASR_MODEL = env('MUSE_ASR_MODEL', 'muse-voice-transcribe-1.0');
export const TTS = env('TTS_PROVIDER', env('ELEVENLABS_API_KEY') ? 'elevenlabs' : 'none');
export const RELAY_TOKEN = env('RELAY_TOKEN');
export const SAMPLE_RATE = 24000;
export const MAX_HISTORY = 12;
/** Muse Spark reasons before it answers and those tokens count against the output cap, so keep the cap generous
 *  and the effort low: a spoken two-sentence reply does not need deliberation. minimal | low | medium | high | xhigh. */
export const REASONING_EFFORT = env('MUSE_REASONING_EFFORT', 'minimal');
export const MAX_COMPLETION_TOKENS = Number(env('MUSE_MAX_COMPLETION_TOKENS', '1500'));
/** Longest utterance accepted per turn (Vercel caps request bodies at 4.5 MB; 60 s of PCM is 2.9 MB). */
export const MAX_UTTERANCE_SEC = 60;

const FALLBACK_PERSONA =
  'You are a projected face on a mask at an embodied-AI meetup. Speak in one to three short sentences, warm and a little wry, and usually ask the visitor something back. You know you have no body and can only hear, not see.';

export const PERSONA = (() => {
  const candidates = [env('PERSONA'), path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'persona.md'), path.join(process.cwd(), 'config', 'persona.md')].filter(Boolean);
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      /* try the next location */
    }
  }
  return FALLBACK_PERSONA;
})();

export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- speech to text (one shot)
function wavHeader(pcmBytes, sampleRate = SAMPLE_RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcmBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcmBytes, 40);
  return h;
}

/** Transcribe a whole utterance. Returns the text ('' when nothing was said). */
export async function transcribeOnce(pcm, signal) {
  if (MOCK) {
    const secs = pcm.length / (SAMPLE_RATE * 2);
    mockState.lastAudio = Buffer.from(pcm);
    return secs < 0.3 ? '' : `(mock transcript, ${secs.toFixed(1)} s of audio)`;
  }
  const form = new FormData();
  form.append('request', JSON.stringify({ mode: 'PUSH_TO_TALK', model: ASR_MODEL, audioEncoding: 'WAV' }));
  form.append('audio', new Blob([wavHeader(pcm.length), pcm], { type: 'audio/wav' }), 'turn.wav');
  const res = await fetch(`${META_BASE}/asr/transcribe`, { method: 'POST', headers: { authorization: `Bearer ${META_KEY}` }, body: form, signal });
  if (!res.ok) throw new Error(`Voice Transcribe HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.transcript ?? data.turns?.map((t) => t.transcript).join(' ') ?? '').trim();
}

// ---------------------------------------------------------------- reply
export const mockState = { lastAudio: Buffer.alloc(0) };

/** Stream a Muse Spark reply as text deltas. */
export async function* streamReply(history, signal) {
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
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      reasoning_effort: REASONING_EFFORT,
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: PERSONA }, ...history],
    }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Muse Spark HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let emitted = 0;
  let finish = '';
  let usage = null;
  let sawDone = false;
  while (!sawDone) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        sawDone = true;
        break;
      }
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; /* keepalive */
      }
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
      // Reasoning arrives as delta.reasoning_content; only spoken text is delta.content.
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta) {
        emitted += delta.length;
        yield delta;
      } else if (Array.isArray(delta)) {
        for (const part of delta) if (part?.type === 'text' && part.text) { emitted += part.text.length; yield part.text; }
      }
    }
  }
  if (usage) log('muse spark usage', JSON.stringify(usage));
  if (!emitted) {
    const r = usage?.completion_tokens_details?.reasoning_tokens;
    throw new Error(`Muse Spark returned no text (finish_reason=${finish || 'none'}${r !== undefined ? `, reasoning_tokens=${r}` : ''}). Raise MUSE_MAX_COMPLETION_TOKENS or lower MUSE_REASONING_EFFORT.`);
  }
}

/** Split streamed text into sentences so speech can start before the reply is finished. */
export async function* sentences(deltas) {
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
export function tone(seconds) {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const e = Math.sin((Math.PI * i) / n);
    b.writeInt16LE(Math.round(6000 * e * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * (0.6 + 0.4 * Math.sin(i / 900))), i * 2);
  }
  return b;
}

/** Stream PCM16 24 kHz audio for one sentence into onAudio(buffer). */
export async function speak(text, onAudio, signal) {
  if (MOCK) {
    const audio = mockState.lastAudio.length ? mockState.lastAudio : tone(0.6);
    for (let i = 0; i < audio.length && !signal.aborted; i += 4800) {
      onAudio(audio.subarray(i, i + 4800));
      await new Promise((r) => setTimeout(r, 100));
    }
    mockState.lastAudio = Buffer.alloc(0);
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
    let b = Buffer.concat([carry, Buffer.from(value)]);
    const even = b.length - (b.length % 2);
    carry = b.subarray(even);
    b = b.subarray(0, even);
    if (b.length) onAudio(b);
  }
}

// ---------------------------------------------------------------- one full turn as a framed stream
/**
 * Run transcript -> reply -> speech, emitting framed messages through `emit(type, payload)`.
 * Returns the assistant text. `history` is the prior conversation, oldest first.
 */
export async function runTurn({ userText, history, emit, signal }) {
  const json = (o) => emit(1, Buffer.from(JSON.stringify(o)));
  json({ type: 'transcript', role: 'user', text: userText });
  json({ type: 'state', state: 'thinking' });
  const msgs = [...history, { role: 'user', content: userText }].slice(-MAX_HISTORY);
  let full = '';
  let speaking = false;
  try {
    for await (const sentence of sentences(streamReply(msgs, signal))) {
      if (signal.aborted) break;
      full += (full ? ' ' : '') + sentence;
      json({ type: 'transcript', role: 'agent', text: sentence });
      if (!speaking) {
        speaking = true;
        json({ type: 'state', state: 'speaking' });
      }
      await speak(sentence, (buf) => !signal.aborted && emit(2, buf), signal);
    }
  } catch (e) {
    if (!signal.aborted) json({ type: 'error', message: e.message });
  }
  if (speaking) json({ type: 'speechEnd' });
  json({ type: 'state', state: 'idle', assistantText: full });
  return full;
}

/** Parse the HTTP turn request body: [u32 jsonLen][json][pcm]. */
export function parseTurnBody(buf) {
  if (buf.length < 4) throw new Error('empty turn body');
  const n = buf.readUInt32BE(0);
  if (n > 1_000_000 || 4 + n > buf.length) throw new Error('malformed turn body');
  const meta = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
  const pcm = buf.subarray(4 + n);
  return { meta, pcm };
}

function frame(type, payload) {
  const h = Buffer.alloc(5);
  h.writeUInt8(type, 0);
  h.writeUInt32BE(payload.length, 1);
  return Buffer.concat([h, payload]);
}

/** Web-standard handler: POST one turn, stream back frames. Used by api/turn.js and the relay. */
export async function handleTurn(request) {
  if (request.method !== 'POST') return new Response('POST a turn', { status: 405 });
  if (!MOCK && !META_KEY) return new Response('META_API_KEY not configured', { status: 500 });
  if (!MOCK && !RELAY_TOKEN) return new Response('RELAY_TOKEN not configured; refusing to serve an open endpoint', { status: 500 });
  let meta, pcm;
  try {
    ({ meta, pcm } = parseTurnBody(Buffer.from(await request.arrayBuffer())));
  } catch (e) {
    return new Response(`bad request: ${e.message}`, { status: 400 });
  }
  if (RELAY_TOKEN && meta.token !== RELAY_TOKEN) return new Response('unauthorized: relay token missing or wrong', { status: 401 });
  if (pcm.length > MAX_UTTERANCE_SEC * SAMPLE_RATE * 2) return new Response(`utterance longer than ${MAX_UTTERANCE_SEC} s`, { status: 413 });
  const history = Array.isArray(meta.history) ? meta.history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-MAX_HISTORY) : [];

  const ctl = new AbortController();
  request.signal?.addEventListener('abort', () => ctl.abort());
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (type, payload) => {
        try {
          controller.enqueue(frame(type, payload));
        } catch {
          ctl.abort();
        }
      };
      const json = (o) => emit(1, Buffer.from(JSON.stringify(o)));
      try {
        json({ type: 'state', state: 'thinking' });
        const text = await transcribeOnce(pcm, ctl.signal);
        if (!text) json({ type: 'state', state: 'idle', assistantText: '' });
        else await runTurn({ userText: text, history, emit, signal: ctl.signal });
      } catch (e) {
        if (!ctl.signal.aborted) json({ type: 'error', message: e.message });
        json({ type: 'state', state: 'idle', assistantText: '' });
      }
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
    cancel() {
      ctl.abort();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  });
}
