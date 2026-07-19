# study-server

> **Part of the Study Framework**: a small ecosystem of tools designed to work together for evidence-based learning in Obsidian. The framework is made of four independent pieces:
>
> | Component | Role |
> |---|---|
> | [**obsidian-speed-reading**](https://github.com/LuisReinoso/obsidian-speed-reading) | RSVP reader with recall practice, streaks, and session tracking |
> | [**obsidian-study-spaced-repetition**](https://github.com/LuisReinoso/obsidian-study-spaced-repetition) (fork of `st3v3nmw/obsidian-spaced-repetition`) | Review-time flashcard scheduling using `question::answer` notes |
> | [**obsidian-study-quiz**](https://github.com/LuisReinoso/obsidian-study-quiz) (fork of `ECuiDev/obsidian-quiz-generator`) | In-note quiz UI, simplified to use this server as its only provider |
> | **study-server** *(this repo)* | Backend that generates the summaries, flashcards, and quiz questions the plugins consume |
>
> Each piece is independent and can be used on its own. The full framework is grounded in learning-science research (Roediger & Karpicke on retrieval practice, Dunlosky on effective study strategies, Xiao et al. 2023 on LLM-generated educational content, among others).

Self-hosted HTTP backend that turns a local LLM into a study assistant. Given a chunk of text it returns:

- **Summaries** with key terms and topics (latency-optimized for mobile)
- **Flashcards** (`front`/`back`) that spread across six learning archetypes
- **Quiz questions** (true/false, multiple-choice, fill-in-the-blank, short-answer, matching) spread across Bloom-style cognitive levels
- **Answer grading**: compares a free-text answer to the correct one by meaning, not exact wording

The endpoints are plain JSON-over-HTTP so any client can use them. You don't need the companion Obsidian plugins to benefit from the server.

## Backend: OpenAI-compatible, with discovery

The server does not talk to any specific LLM provider. It speaks the OpenAI chat-completions API (`POST {base}/chat/completions`) against any server that implements it: llama.cpp's built-in server, Ollama's `/v1` compatibility layer, vLLM, LM Studio, and so on.

Because a local setup often has several of these processes started and stopped on demand (a few llama.cpp servers running different models, an Ollama daemon as a catch-all), the server does not hardcode a single host. Instead:

1. On the first request (or 60 seconds after the last successful discovery), it probes each URL in `LLM_ENDPOINTS`, in order, with `GET {url}/models`.
2. The first one that answers with `200` and lists at least one chat-capable model wins. Its choice (endpoint + candidate model list) is cached for 60 seconds so every request doesn't re-probe.
3. The model name comes from `LLM_MODEL` if set, otherwise from the first CHAT-capable model id the winning endpoint reported in `/models`. llama.cpp only reports the one model it currently has loaded, so first-id is correct there. Ollama lists every model it has ever pulled, including embedding/rerank models that its chat endpoint rejects, so ids containing "embed", "bge", or "rerank" (case-insensitive) are skipped during auto-selection.
4. If a chat request fails because the chosen model turns out not to support chat, the server tries the endpoint's next candidate model before giving up on that endpoint. If a request fails for any other reason (network error, 5xx, timeout), the cache is invalidated and the server retries once against the next healthy endpoint. The 60-second cache is refreshed to whichever (endpoint, model) pair last completed a request successfully.

If none of the configured endpoints are reachable (or none lists a usable chat model), requests fail with a clear error naming the endpoints that were tried, and `/api/health` reports `"backend": "none"`.

## Why not just call a cloud API directly from the plugin?

Two reasons:

1. **Quality filtering**: the server over-generates candidates and runs a diversity filter (Jaccard similarity + archetype balancing) before returning them. This counters the "obvious patterns, lack variation" failure mode that [Xiao et al. (BEA 2023)](https://aclanthology.org/2023.bea-1.52/) documented for LLM-generated questions.
2. **Latency shaping**: `/api/summary` is tuned for mobile clients (~30 s HTTP timeout) with a tight input trim and strict output caps.

## Endpoints

All endpoints take JSON and return JSON. `text` must contain at least ~20-30 words. If `STUDY_SERVER_TOKEN` is set, every endpoint below except `/api/health` requires `Authorization: Bearer <token>` (see [Auth](#auth)).

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Health check, reports the selected backend endpoint and model |
| `POST /api/summary` | Digest + key terms + topics, latency-critical |
| `POST /api/flashcards` | Front/back cards with archetype tagging |
| `POST /api/quiz` | Mixed-type questions with cognitive-level tagging |
| `POST /api/grade` | Grades a free-text answer against the correct one, by meaning |
| `POST /api/generate` | Raw text proxy (no schema, used by obsidian-study-quiz) |

### Request shape examples

```bash
curl -X POST http://localhost:3457/api/summary \
  -H "Content-Type: application/json" \
  -d '{"text":"Retrieval practice is a learning technique...","language":"es"}'
```

```bash
curl -X POST http://localhost:3457/api/flashcards \
  -H "Content-Type: application/json" \
  -d '{"text":"...","language":"es","count":6}'
```

```bash
curl -X POST http://localhost:3457/api/quiz \
  -H "Content-Type: application/json" \
  -d '{"text":"...","language":"es","count":5,"types":["multiple-choice","short-answer"]}'
```

```bash
curl -X POST http://localhost:3457/api/grade \
  -H "Content-Type: application/json" \
  -d '{"answer":"Mitochondria produce ATP through cellular respiration","userAnswer":"they make energy for the cell"}'
```

### Response shapes

```jsonc
// GET /api/health
{
  "status": "ok",
  "backend": "http://127.0.0.1:8898/v1", // or "none" if nothing responded
  "model": "qwen2.5-14b-instruct"        // or null
}

// POST /api/summary
{
  "summary": "2-3 sentence digest",
  "keyTerms": [{ "term": "...", "definition": "..." }],
  "topics": ["...", "...", "..."]
}

// POST /api/flashcards
{
  "cards": [
    { "front": "...", "back": "...", "archetype": "application" }
  ]
}

// POST /api/quiz
{
  "questions": [
    { "type": "multiple-choice", "question": "...", "options": ["a","b","c","d"], "answer": 0, "level": "analyze" }
  ]
}

// POST /api/grade
{
  "score": 0.85 // clamped to [0, 1]
}

// POST /api/generate
{
  "text": "raw model output",
  "stopReason": "end_turn"
}
```

`/api/generate` also accepts an optional `model` field in the request body to override the discovered model for that one call.

## Flashcard archetypes

The server requires every card to be tagged with one of these six archetypes and enforces an even spread across them via a post-hoc diversity filter:

| Archetype | Probe |
|---|---|
| `application` | When would you use this? |
| `discrimination` | How does A differ from B? |
| `causal` | Why does this work? |
| `transfer` | How would this apply to a new situation? |
| `counterexample` | Where does this fail? |
| `consequence` | What follows if this is true? |

Trivial "definition" cards (`What is X?` → `X is...`) are explicitly forbidden in the prompt.

## Quiz cognitive levels

Questions are required to spread across four Bloom-inspired levels:

| Level | Probe |
|---|---|
| `understand` | Paraphrase / explain in own words |
| `apply` | Use the idea in a new situation |
| `analyze` | Compare, contrast, find assumptions |
| `evaluate` | Judge a claim, find a flaw |

## Requirements

- Node.js 18+
- `pnpm` (or `npm` / `yarn`)
- At least one OpenAI-compatible LLM server reachable (llama.cpp, Ollama, vLLM, LM Studio, etc.)

## Install & run

```bash
git clone https://github.com/LuisReinoso/study-server.git
cd study-server
pnpm install
pnpm run build

cp .env.example .env
# edit .env if the defaults in LLM_ENDPOINTS don't match your setup

pnpm start
```

By default the server binds `0.0.0.0:3457`. Change the port with `STUDY_SERVER_PORT`, the bind address with `BIND_HOST`.

### Accessing from Obsidian mobile

The server binds to `0.0.0.0` by default, so any device on the same network can reach it. For cross-network access (e.g. Obsidian on mobile + server on a home machine) the recommended setup is [Tailscale](https://tailscale.com/): install it on both devices, point the Obsidian plugin at the server's Tailscale IP, and you're done. If the server is reachable outside a network you fully trust, set `STUDY_SERVER_TOKEN` (see below).

## Auth

By default the server has no authentication, which is fine on a trusted LAN or over Tailscale. To require a bearer token, set `STUDY_SERVER_TOKEN` in `.env`:

```
STUDY_SERVER_TOKEN=some-long-random-value
```

Every `/api/*` request except `/api/health` must then send:

```
Authorization: Bearer some-long-random-value
```

Requests without a matching header get `401 { "error": "unauthorized" }`. `/api/health` stays open so uptime checks don't need the token.

## Running as a systemd service (Linux)

A template unit file ships as `study-server.service`. It runs `node dist/server.js`, reads its environment from `.env` via `EnvironmentFile`, and restarts on failure. Copy it and fill in the two placeholders (`<USER>`, `<INSTALL>`):

```bash
sudo cp study-server.service /etc/systemd/system/
sudo sed -i "s|<USER>|$USER|; s|<INSTALL>|$PWD|" /etc/systemd/system/study-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now study-server
```

Check status/logs with `systemctl status study-server` / `journalctl -u study-server -f`.

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `STUDY_SERVER_PORT` | `3457` | HTTP port |
| `BIND_HOST` | `0.0.0.0` | Interface to bind |
| `LLM_ENDPOINTS` | `http://127.0.0.1:8898/v1,http://127.0.0.1:8899/v1,http://127.0.0.1:8897/v1,http://127.0.0.1:11434/v1` | Comma-separated OpenAI-compatible base URLs, probed in order |
| `LLM_MODEL` | *(unset)* | Force a specific model name; otherwise auto-selects the first chat-capable model id the selected endpoint reports (skips ids containing "embed", "bge", or "rerank") |
| `STUDY_SERVER_TOKEN` | *(unset)* | If set, requires `Authorization: Bearer <token>` on every `/api/*` route except `/api/health` |

## How the diversity filter works

Both `/api/flashcards` and `/api/quiz` over-generate by 1.25x, then use a greedy selection pass to:

1. Reject near-duplicates by computing Jaccard similarity on content-word tokens (Spanish + English stopwords filtered, accents normalized). Items sharing ≥ 55% of tokens with an already-kept item are dropped.
2. Enforce a cap of `ceil(count / N) + 1` per bucket (archetype or level), choosing from the currently least-represented bucket at each step.
3. Do a relaxed second pass if the first pass starved the output: only the bucket cap is enforced the second time.

The result is tagged back out to the client without the archetype/level fields leaking into the consumer's data model (though they are included for clients that want them).

## Latency budget for `/api/summary`

`/api/summary` blocks the pre-reading flow on mobile, where HTTP clients enforce roughly a 10-20 s socket timeout. To stay inside that budget:

- Input is trimmed to 5,000 characters, keeping the first 70% and last 30% of the text (intro + conclusion: the highest-signal regions for a pre-reading digest, dropping the middle where filler tends to live).
- The prompt caps output to 2-3 summary sentences, exactly 3 key terms, and exactly 3 topics. Fewer output tokens means a faster response regardless of which model answers.
- Actual latency depends on which backend answered the discovery probe and how large that model is; a small local model on a fast GPU is what keeps this endpoint responsive.

## Testing

```bash
npx jest
```

Tests cover the diversity filter, the input trimmer, backend discovery/fallback/model-resolution logic (with `fetch` mocked, no real network calls), the auth middleware, and score clamping for `/api/grade`, all without binding a port.

## License

MIT, see [LICENSE](./LICENSE).
