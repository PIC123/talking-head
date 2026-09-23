// Vercel Function: one push-to-talk turn per request, streamed back. See server/pipeline.mjs.
// Env on Vercel: META_API_KEY, RELAY_TOKEN, and a voice (ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID, or TTS_URL).
import { handleTurn } from '../server/pipeline.mjs';

export const config = { maxDuration: 60 };

export function POST(request) {
  return handleTurn(request);
}

export function GET() {
  return new Response('talking-head turn endpoint: POST a turn\n', { status: 200, headers: { 'content-type': 'text/plain' } });
}
