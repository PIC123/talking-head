# Talking Head

A glowing line-drawn face on pure black, projected onto a white mask, that holds a live voice
conversation with visitors. Single-page Vite + TypeScript app, no UI framework.

```
Mic (hold Space) -> voice agent (ElevenLabs) -> output audio level -> behavior engine -> face canvas -> output stage -> projector
```

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173  (mic works on localhost without HTTPS)
```

1. Open the page in Chrome, click **Start** (grants the mic, goes fullscreen, hides the cursor).
2. Press **E** for edit mode. The default provider is **Mic loop**: talk into the laptop mic and the mouth follows your voice. Blinks and eye drift run on their own.
3. Switch provider to **Echo** to test the whole turn loop with no API: hold Space, talk, release, and the head "thinks" then plays your recording back through the mouth.
4. Switch provider to **ElevenLabs**, paste your agent ID, press E to leave edit mode, hold Space and talk.

URL parameters: `?windowed` skips auto-fullscreen, `?edit` starts in edit mode, `?agent=<id>` sets the ElevenLabs agent ID (handy for a kiosk launch command).

## ElevenLabs setup

1. Create a Conversational AI agent at elevenlabs.io. Paste `config/persona.md` into its system prompt, pick a voice, set a short first message (it plays as soon as the visitor first presses talk).
2. In the agent's **Security** tab, enable authentication-free (public) access so the browser can connect with just the agent ID. No backend needed.
3. Put the agent ID in the edit panel (it is saved to localStorage) or export/import a config JSON.
4. Optional: to push `config/persona.md` from the app instead of the dashboard, enable **prompt overrides** in the agent's Security tab and run with `VITE_PROMPT_OVERRIDE=1 npm run dev`.

Turn-taking is push-to-talk by default: the SDK's mic stays muted except while Space is held, so a loud room never triggers the agent. Pressing talk while the head is speaking interrupts it. **Open mic** mode (provider VAD) is in the panel if the room is quiet.

## Deploying

The app is static, so hosting only decides where Chrome loads the files from; the laptop on the projector does all the work.

**Vercel (recommended).** Import the repo; Vercel detects Vite and serves `dist/`. Optionally set the env var `VITE_ELEVENLABS_AGENT_ID` in the project settings so the agent is preset (the ID is then in the public bundle, so only do this if you are fine with anyone who finds the URL talking to your agent). Otherwise leave it out and set the ID once in the edit panel on the laptop, where it stays in localStorage.

**Local fallback.** Venue wifi can fail at the worst moment, so also keep a build on the laptop:

```bash
npm run build && npm run preview   # http://localhost:4173
```

The mic needs a secure context, which both `localhost` and Vercel's HTTPS satisfy. A LAN IP over plain HTTP will not get mic access.

## Keyboard map

| Key | Action |
| --- | --- |
| Space (hold), right mouse button (hold), or finger on screen (hold, show mode) | Push to talk |
| E | Toggle edit mode (panel, HUD, log, cursor) |
| T | Toggle test pattern (grid, crosshair, circle, orientation marks) |
| F | Toggle fullscreen |
| H / V | Flip horizontal / vertical (flip H for rear projection) |
| U | Toggle the reference photo (edit mode) |
| 1–4 | Edit stage: transform / corner pin / ellipse mask / output |
| Arrows (+Shift) | Nudge the active stage 1 / 10 px |
| + / − (+Shift) | Scale (stage 1) |
| Tab / Shift+Tab | Select next / previous corner (stage 2); corners are also draggable |
| R | Reset the active stage |
| Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) | Undo / redo mapping changes |
| Ctrl+S | Export config JSON |
| Ctrl+1–3 / Alt+1–3 | Save / load preset slot |

Config autosaves to localStorage 500 ms after any change and restores on reload.

## On a phone

The same URL works on a phone or tablet: tap Start, then hold a finger anywhere on the screen to talk. Editing is still possible (the panel is cramped) but the phone is mainly a handy way to demo the agent without the projector. iOS ignores fullscreen requests; add the page to the home screen for a full-screen face.

## Aligning to the mask

1. Press E, then T for the test pattern. Press H if you are projecting from behind.
2. Stage 1: arrows and +/− move and scale the square onto the mask. Fine-tune scaleX/scaleY/rotation in the panel.
3. Stage 2: drag the four orange corners until the grid sits flat on the mask (a true homography, so lines stay straight).
4. Stage 3: enable the ellipse mask and feather it to cut spill past the mask edge.
5. Stage 4: enable hotspot compensation to dim the bright center of a rear projection.
6. Press T, then tune the face **Layout** (eye spacing, eye Y, mouth Y, mouth width) until the features land on the mask's features. Press E. Ctrl+S to back up the config.

## Painting mode

The same app maps onto a flat painting instead of a mask. Three things make that look intentional:

- **Reference photo.** In the edit panel, *Reference photo → Load photo of surface*. Take the photo from roughly where the projector will sit. It shows behind the face in edit mode only (U toggles it), so you can align eye spacing, mouth Y and the corner pin at the desk. It is stored in the browser, not in the config export.
- **Feature toggles.** *Face → Features* hides the eye outlines, pupils, brows or mouth individually, so the painting can supply what it already has and the projector adds only what moves. Paint the animated regions pale: projected light shows on light paint and dies on dark paint.
- **Light wash.** *Face → Light wash* adds a soft colored ellipse under the features so the projector lights the painting from within. It breathes in idle, brightens on speech and dims when disconnected. Warm off-white at 0.3 to 0.5 opacity in a dim room is a good start.

Save the painting and mask setups as presets (Ctrl+1 / Ctrl+2) and switch with Alt+1 / Alt+2.

## Show mode and robustness

- One click on Start, then the app runs unattended: fullscreen, no cursor, screen wake lock held.
- Session lifecycle (push-to-talk): connect on the first talk press, end after 45 s of silence from both sides (limits cost and clears context between visitors). The idle face keeps animating while disconnected.
- Reconnect: unexpected drops retry with 1 s, 2 s, 5 s, 10 s backoff. The face shows a dim half-lidded "disconnected" look, never an error message. Errors and the transcript go to the console and to the edit-mode log panel.
- After 60 s idle the head goes into attract mode: brighter glow, slow looks around the room.

Kiosk launch (Chrome, second display, after `npm run build && npm run preview`):

```bash
google-chrome --kiosk --autoplay-policy=no-user-gesture-required \
  --use-fake-ui-for-media-stream --window-position=1920,0 \
  "http://localhost:4173/"
```

`--use-fake-ui-for-media-stream` auto-accepts the mic prompt (it does not fake the device). Set the laptop to never sleep and mirror-off so the projector is its own display.

## Layout

| Module | Responsibility |
| --- | --- |
| `src/agent/` | `VoiceAgent` interface, ElevenLabs adapter, `MicLoopAgent` and `EchoAgent` test adapters, `SessionManager` (connect on demand, idle timeout, reconnect). |
| `src/audio/analyzer.ts` | Frequency data to loudness + brightness. |
| `src/behavior/` | Mouth envelope follower; behavior engine turning state + level into `FaceParams` (blinks, saccades, brows, glow). |
| `src/face/` | Draws `FaceParams` to a 1024×1024 canvas; test pattern. |
| `src/mapping/` | Output stage: 2D transform, ellipse mask, hotspot, corner pin via CSS `matrix3d` homography; edit interactions and undo. |
| `src/config/` | Versioned config schema, defaults, migration, localStorage store, presets, import/export. |
| `src/ui/` | Start overlay, tweakpane panel, log panel. |
| `config/persona.md` | The head's system prompt. |

See `docs/SPEC.md` for the build spec and what changed from the original plan.
