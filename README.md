# Sankar Voice Sales Agent

A browser-based SaaS voice sales agent with Groq-powered conversation and speech, live transcript streaming, consent-based recording, structured call evaluation, lead status, and local call history.

**Live demo:** [sankar-voice-sales.vercel.app](https://sankar-voice-sales.vercel.app/)

## Run locally

Requirements: Node.js 20+, a Groq API key, and Chrome or Edge for the browser speech-recognition API.

```powershell
npm install
Copy-Item .env.example .env
```

Set `GROQ_API_KEY` in `.env`, then start the server:

```powershell
npm run dev
```

Open `http://localhost:3000`. Keep the API key on the server and out of browser code and version control. The app settings panel reports whether the server has a configured key.

Optional product catalog: set `GROQ_PRODUCT_CATALOG` to JSON in the server environment. Product keys are names and values may contain verified `description`, `features`, `integrations`, `price`, `currency`, `billing_period`, and `plan` fields. Leave price out unless approved pricing is available. `check_product_info`, `calculate_pricing`, and `generate_quote` only use catalog facts; without a configured price the agent offers a human pricing follow-up.

Example format (use facts and approved prices for your product):

```json
{"Example SaaS":{"description":"Verified product description","features":["Verified feature"],"integrations":["Verified integration"],"price":29,"currency":"USD","billing_period":"per seat per month"}}
```

## Agent workflow

The server tracks six conversation stages: introduction, discovery, pitch, objection handling, closing, and summary generation. Stage guidance shapes the system prompt. The agent detects intent on each turn and can request verified product details or pricing, capture a requested follow-up, update the lead outcome, and end a call. Follow-up capture is not a calendar booking; a calendar integration must be added before claiming that an appointment is scheduled.

Groq chat completions stream over Server-Sent Events. The browser renders each text delta and queues complete sentences for Groq Orpheus TTS as they arrive. The microphone recognizer runs during playback to allow interruption. Interim speech is finalized after a short silence window, with browser noise suppression and echo cancellation enabled.

## Memory, recording, and evaluation

- Short-term memory is the current call transcript sent to the server for each turn.
- Returning-prospect memory stores the prospect name, company when present, preferences, prior objections, last outcome, and last contact time in IndexedDB on this device. A bounded memory summary is included in Groq prompts on that prospect’s next call; there is no separate external memory database.
- Recording begins only when the operator confirms the prospect has consented. Audio is mixed in the browser and remains in IndexedDB on this device; it is not uploaded to Groq.
- When a call ends, one structured Groq analysis returns the needs, objections, next steps, buying signals, lead status, and evaluator scores. Talk-to-listen ratio is calculated from transcript word counts; discovery, objection handling, and overall effectiveness are LLM judge scores on a 0–10 scale.
- The analytics strip calculates average evaluation scores, conversion rate, and the most frequently repeated objection from this browser’s saved call history.

Call transcripts, recordings, and prospect memory are local to the browser. The Clear action removes local calls and prospect memory; clearing site data removes all of them. Different browsers or devices do not share call history or prospect memory.

## Architecture

- `server.js`: Express routes for health, Groq-backed streaming turns, structured evaluation, and Groq speech. The Groq API key remains server-side.
- `agent/stages.js`: intent classification and deterministic stage transitions.
- `agent/prompt.js`: stage-specific sales conversation guidance and bounded memory injection.
- `agent/tools.js`: Groq function schemas and server-side tool handlers with catalog validation.
- `agent/evaluation.js`: structured post-call evaluation and transcript-derived talk/listen ratio.
- `public/app.js`: browser call lifecycle, SSE rendering, sentence playback queue, interruption handling, consent-based recording, and analytics.
- `public/memory.js`: IndexedDB-backed prospect memory.
- `api/[...path].js`: Vercel serverless entry point for Express.

## Deploy

Deploy to Vercel and configure `GROQ_API_KEY` in the Production environment. Add the optional product catalog only when verified product/pricing data is available. Redeploy after environment-variable changes. The browser microphone and Web Speech API require HTTPS or localhost; recognition availability and accuracy depend on browser and locale support.

## Submission walkthrough

“This is Sankar Voice, an AI sales workspace for live discovery calls. The agent moves through introduction, discovery, value pitch, objection handling, and next steps, while the transcript streams live. It can look up verified product details and pricing when a catalog is configured. Recording starts only after I confirm consent. At the end, it saves the transcript and recording locally, evaluates the conversation, captures buying signals and follow-up actions, and updates the pipeline analytics.”
