# Sankar Voice Sales Agent

A browser-based voice sales workspace built around an explicit stage-driven agent, validated Groq tool loop, acoustic turn detection, sentence-level speech, prospect memory, call evaluation, and operational telemetry.

**Live demo:** [sankar-voice-sales.vercel.app](https://sankar-voice-sales.vercel.app/)

## Architecture

```mermaid
flowchart LR
  UI[Browser workspace] -->|SSE user turn| API[Express / Vercel]
  UI -->|Web Speech STT + acoustic VAD| UI
  API --> CORE[Agent stage + prompt]
  CORE --> LOOP[Groq streamed tool loop]
  LOOP --> TOOLS[Validated server tools]
  TOOLS --> CATALOG[Verified product catalog]
  TOOLS --> WEBHOOKS[Optional CRM / scheduling webhooks]
  LOOP --> GROQ[Groq chat completions]
  UI -->|sentence TTS| API
  API --> GROQ
  API --> EVAL[Call evaluator + re-score API]
  UI --> MEMORY[IndexedDB semantic + episodic memory]
  UI --> LOCAL[IndexedDB recordings + local history]
  API --> METRICS[Instance-local metrics + structured logs]
```

The browser owns the live audio and local call archive. The server owns provider credentials, tool validation, product facts, retries, and evaluation. No transcript, recording, or prospect memory is sent to the metrics logger.

### Design decisions

- **Parallel reads, ordered writes:** independent catalog lookups and quotes may run concurrently; follow-up, lead updates, and call-ending actions stay ordered to avoid side effects racing each other.
- **Bounded agent loop:** at most three tool-bearing generations are allowed before a final answer generation. This limits cost and protects the UI from an unproductive tool cycle.
- **Local memory and recording:** IndexedDB keeps the demo deployable without a database and gives the operator control of browser-local data. It also means data does not sync across devices and is not suitable for shared production workspaces.
- **Acoustic VAD:** adaptive RMS detection and a short hangover give low-latency barge-in without shipping a large model. It is less robust than a neural detector in noisy rooms.
- **Process-local telemetry:** an in-memory rolling window is simple and Vercel-compatible, but it is diagnostic only; serverless instances do not share counters.
- **Webhook integrations:** adapters avoid binding the agent core to a specific CRM or calendar SDK. The external service owns authentication, durable scheduling, and idempotent processing.

## Run locally

Requirements: Node.js 20+, a Groq API key, and Chrome or Edge for Web Speech recognition.

```powershell
npm install
Copy-Item .env.example .env
```

Set `GROQ_API_KEY` in `.env`, then:

```powershell
npm run dev
```

Open `http://localhost:3000`. Keep credentials server-side. Never put the Groq key in browser code or commit it.

## Agent behavior and tool loop

The server carries the six stages: introduction, discovery, pitch, objection handling, closing, and summary generation. Intent and turn history guide stage transitions; the LLM determines what to say within that stage. Groq tool calls run through a bounded loop (up to three tool-bearing generations and a final response generation). Arguments and results are validated before the model sees tool output. Catalog reads can execute in parallel; state-changing tools execute in request order.

Read-only product and quote tools use only `GROQ_PRODUCT_CATALOG`. Example:

```json
{"Example SaaS":{"description":"Verified product description","features":["Verified feature"],"integrations":["Verified integration"],"price":29,"currency":"USD","billing_period":"per seat per month"}}
```

Do not configure prices or claims without approval. Missing catalog facts cause the agent to say that it cannot verify the answer.

### Optional calendar and CRM adapters

The app accepts HTTPS JSON webhooks to avoid coupling the agent to one CRM/calendar vendor. Each event includes bounded call context (`call_id`, prospect, and product) plus the action fields:

- `FOLLOWUP_WEBHOOK_URL` receives `{ call_id, prospect, product, requested_time, channel, notes }`. It is treated as booked only when the response is JSON containing `{ "booked": true }`; otherwise the assistant describes it as a captured request needing confirmation.
- `CRM_WEBHOOK_URL` receives `{ call_id, prospect, product, status, reason }` when the agent updates the lead outcome.
- `INTEGRATION_WEBHOOK_SECRET` is sent as a Bearer credential to either endpoint. Configure a receiver-side secret and use HTTPS.

The receiver must be idempotent because network retries can repeat a webhook. These adapters do not claim to be a direct Google Calendar or CRM SDK integration; connect the endpoint to an approved workflow (for example a small server-side adapter or automation service) and verify its booking response contract.

## Voice experience

The browser uses Web Speech API for STT and Groq Orpheus for server-side TTS. Responses stream over SSE; complete sentences are synthesized as soon as they arrive. Barge-in cancels the current generation and playback. An adaptive RMS acoustic VAD with onset debounce and a 420ms hangover manages turn boundaries and activity indicators. It is dependency-free and avoids shipping a large model, but it is not neural Silero VAD; noisy rooms may require a neural VAD or hosted STT adapter. The recognizer language is currently `en-IN`.

Audio is mixed and recorded in-browser only when the operator confirms prospect consent. Recordings are stored in IndexedDB; they are not uploaded to Groq. Timestamped transcript turns can seek the saved audio.

## Memory and privacy

- Short-term memory is the current transcript, bounded to 80 messages.
- Semantic facts (needs, preferences, objections, company, outcomes) have importance and heuristic confidence values. Retrieval ranks by query relevance, decayed importance, and confidence, then injects the strongest bounded set into the prompt. Confidence is a ranking hint, not a calibrated probability.
- Episodic memory stores a compact summary/status/next-step record per call, with separate importance/confidence ranking and a slower decay curve.
- The previous IndexedDB profile format is migrated lazily. Memory is local to the browser and is not a secure multi-user database.

## Evaluation and analytics

After a call, Groq returns structured needs, objections, next steps, buying signals, quality flags, status, and judge dimensions: discovery, objection handling, need alignment, factuality/compliance, empathy/tone, next-step clarity, and overall effectiveness. Talk/listen ratio is calculated from transcript word counts. Saved calls can be re-scored with the current rubric. CSV export includes the local transcript and evaluation. The analytics view reports saved-call trends.

Run the deterministic, no-network regression suite:

```powershell
npm run eval:offline
```

The default command runs deterministic no-network checks for intent/stage decisions, tool schemas, memory ranking, talk/listen math, and circuit-breaker transitions. For LLM judge replay of call-shaped JSON fixtures, start the app with a configured Groq key and run `npm run eval:offline -- --rescore` (optionally pass a fixture path after the flag). Set `EVAL_BASE_URL` to target another deployment. The report is written to `eval/latest-report.json` (override with `EVAL_OUTPUT`). In `--rescore` mode, transcripts are sent to the configured Groq evaluation endpoint.

## Reliability and observability

- Transient Groq failures (timeouts, rate limits, and server errors) use bounded exponential backoff with jitter. A process-local circuit breaker rejects calls during a short cooldown after repeated failures.
- Tool execution has input/output schema checks, bounded results, safe fallback messages, and structured completion/error logs.
- `/api/metrics` exposes rolling 15-minute request/error percentiles, token usage, client-reported time-to-first-token/audio, tool frequency/success, and circuit state. The history view also surfaces turn errors and tool call volume. `/api/telemetry` accepts bounded latency samples.
- Browser analytics are persisted per call. Server metrics are in-memory and per serverless instance; Vercel may scale or recycle instances, so these are operational diagnostics, not durable aggregate observability. Use a hosted metrics/logging backend for production operations.
- `/api/health` indicates provider configuration. The local rate limiter is also process-local.

Query runtime metrics directly:

```bash
curl https://your-deployment.example/api/metrics
```

The response groups provider counts/errors/tokens under `groq`, turn latency/errors under `turns`, client voice percentiles under `voice`, per-tool calls/success under `tools`, and breaker state under `circuit`. Client voice timings are submitted at call completion; the dashboard can refresh after the call.

## Human-in-the-loop

During an active call, the operator can take control, type a response for Groq TTS playback, and resume the AI when ready. The AI remains paused during operator control. Operator messages are tagged in the live and saved transcript, forwarded to the agent as human context when control resumes, counted as assistant speech in the talk/listen ratio, and labeled as human operator turns for evaluation.

## Limitations

- This is a portfolio/demo architecture, not a multi-tenant production deployment. Browser history, recordings, and prospect memory are not authenticated, encrypted for shared access, or synchronized across devices.
- Server metrics and rate limits are process-local; Vercel may route requests to different instances or recycle them. Use centralized telemetry and a shared rate-limit store for durable production monitoring.
- RMS VAD and Web Speech recognition depend on browser and microphone conditions. The current recognizer locale is `en-IN`; noisy environments may need hosted STT and neural VAD.
- Calendar and CRM behavior depends on customer-configured webhooks. The project does not ship a Google Calendar, Calendly, or CRM SDK integration.
- Call recording is browser-local and consent-gated. Production use still needs jurisdiction-specific consent, retention, deletion, and vendor policy review.

## Code map

- `server.js`: Express/Vercel HTTP routes, SSE generation, provider calls, request limits.
- `agent/stages.js`, `agent/prompt.js`: stage transitions, intent, sales policy, memory injection.
- `agent/tools.js`, `agent/tool-runtime.js`: tool schemas, server handlers, validation, concurrency.
- `agent/reliability.js`, `agent/observability.js`: retries, circuit breaker, structured logs and metrics.
- `agent/evaluation.js`: normalized structured judge output and transcript-derived measures.
- `public/app.js`, `public/voice-activity.js`: call lifecycle, voice playback, VAD, operator mode, transcript/history/analytics.
- `public/memory.js`: ranked semantic and episodic IndexedDB memory with migration and decay.
- `eval/fixtures.json`, `scripts/offline-eval.js`: deterministic no-network checks and optional Groq judge replay.
- `api/[...path].js`: Vercel serverless adapter for Express.

## Deploy

Deploy on Vercel and configure `GROQ_API_KEY` in the server environment. Add catalog and webhook variables only when they point at approved, HTTPS integrations. Redeploy after environment changes. Microphone and recognition require HTTPS or localhost. Browser support and recognition accuracy vary.
