# Sankar Voice Sales Agent

A browser-based SaaS sales assistant built for the Sankar Group intern assignment. It supports model-backed voice conversations, live transcripts, explicit recording consent, post-call analysis, lead classification, and searchable call history.

**Live demo:** [sankar-voice-sales.vercel.app](https://sankar-voice-sales.vercel.app/)

## Run locally

Requirements: Node.js 20 or newer, a Groq API key, and Chrome or Edge for the browser's live speech-recognition API.

```powershell
npm install
Copy-Item .env.example .env
```

Add your key to `.env`:

```dotenv
GROQ_API_KEY=your_key_here
```

Then run:

```powershell
npm run dev
```

Open `http://localhost:3000`. The API key remains on the server and is never sent to the browser. The status in the top bar confirms whether the AI service is configured.

## Conversation flow

1. Set the prospect, product, and discovery goal in the call brief.
2. Start the call and allow microphone access. The server requests a model-generated discovery introduction, then generates its voice.
3. The browser transcribes the prospect's speech in real time. Each final speech turn is sent to the server and Groq; the AI response is transcribed into the live feed and played as generated voice.
4. Recording starts only when the operator checks the consent confirmation before starting the call. When enabled, the saved audio mixes the microphone and AI voice in the browser. It is not uploaded to the AI provider.
5. End the call to generate a model-backed summary of needs, objections, next steps, and one of the requested statuses. The transcript, summary, outcome, and recording are saved locally in this browser.

## Architecture

- `server.js`: same-origin Express API. Keeps the Groq API key server-side, calls the chat completions endpoint for every conversation turn and summary, and calls the speech endpoint for generated voice. Basic request limits are applied to API routes.
- `public/index.html`, `public/styles.css`, `public/premium.css`, `public/app.js`: responsive sales workspace, browser microphone and speech recognition, mixed audio recording, transcript and history UI.
- `api/[...path].js`: Vercel serverless entry point for the Express API.
- `localStorage`: call metadata, transcript, preferences. `IndexedDB`: call recordings. Clearing the site's browser storage removes this data.
- No scripted assistant response is used when the AI is unavailable. The app surfaces a clear setup or provider error.

## Publish

Deploy the Express project to Vercel using the Vercel CLI or by importing the repository. Frontend files are in `public/`; Vercel runs the Express app as a serverless function. Configure `GROQ_API_KEY` in Vercel's Production environment and redeploy. Keep `.env` out of version control. Browser microphone access and speech recognition require HTTPS (or localhost).

Live speech recognition is supplied by the browser and is tuned for English (India). Generated voice uses Groq Orpheus English. Browser support and recognition quality depend on the browser, microphone, network, and speech-recognition locale.

## Short walkthrough video script

“This is Sankar Voice, an AI sales workspace built for live discovery calls. I’ll set a prospect, product, and call goal, then start a real model-backed voice conversation. The prospect’s speech appears in the transcript in real time, and the assistant answers aloud using generated voice. Recording is off until I confirm the prospect has agreed; when enabled, the recording mixes both sides and stays in this browser. At the end, the AI analyzes the conversation, captures the needs and objections, recommends the next step, and assigns a sales outcome. The transcript, analysis, outcome, and recording are available in searchable call history.”
