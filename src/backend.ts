// OpenAI-compatible backend with discovery.
//
// The owner runs several llama.cpp servers (each exposing an OpenAI-compatible
// HTTP API) plus an Ollama fallback (Ollama also exposes an OpenAI-compatible
// layer under /v1). Only some of these are up at any given time. Instead of
// hardcoding one host, this module probes a configurable list of candidate
// base URLs and uses whichever one answers first, caching the choice briefly
// so we don't re-probe on every single request.
//
// Model auto-selection is trickier than "first id in /models": llama.cpp only
// reports the one model it currently has loaded, so first-id is correct there.
// Ollama, though, lists every model it has ever pulled, including
// embedding/rerank models that its /v1/chat/completions endpoint flatly
// refuses ("<model> does not support chat"). So auto-selection filters those
// out, and if a chat call still fails because the chosen model turns out to
// be non-chat-capable, the caller cascades through the endpoint's other
// candidate models before giving up on that endpoint entirely.

export const DEFAULT_ENDPOINTS =
  "http://127.0.0.1:8898/v1,http://127.0.0.1:8899/v1,http://127.0.0.1:8897/v1,http://127.0.0.1:11434/v1";

const CACHE_TTL_MS = 60_000;
const DISCOVERY_TIMEOUT_MS = 2_000;

// Substrings (case-insensitive) that mark a model id as not a chat model:
// embedding and reranking models. These exist alongside chat models on a
// single Ollama instance and are listed in /models the same way chat models
// are, with no other structured signal to tell them apart.
const NON_CHAT_MODEL_SUBSTRINGS = ["embed", "bge", "rerank"];

export interface DiscoveredEndpoint {
  endpoint: string;
  /** Ordered candidate model ids to try on this endpoint; always non-empty. */
  models: string[];
}

interface CacheEntry extends DiscoveredEndpoint {
  cachedAt: number;
}

let cache: CacheEntry | null = null;

/** Test-only: clear the cached backend selection. */
export function invalidateCache(): void {
  cache = null;
}

export function getEndpoints(): string[] {
  const raw = process.env.LLM_ENDPOINTS || DEFAULT_ENDPOINTS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when a model id looks like an embedding/rerank model, not a chat model. */
export function isLikelyNonChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return NON_CHAT_MODEL_SUBSTRINGS.some((s) => lower.includes(s));
}

/**
 * Pulls chat-capable model ids out of an OpenAI-compatible /models response
 * (`{ data: [{ id: "..." }, ...] }`), in the order the endpoint reported
 * them, skipping anything that looks like an embedding/rerank model.
 */
export function pickChatModelIds(modelsResponse: any): string[] {
  const data = Array.isArray(modelsResponse?.data) ? modelsResponse.data : [];
  return data
    .map((m: any) => m?.id)
    .filter((id: any): id is string => typeof id === "string" && id.length > 0)
    .filter((id: string) => !isLikelyNonChatModel(id));
}

/**
 * Resolves the ordered list of candidate model ids to try: an explicit
 * LLM_MODEL env var always wins (and is used as-is, unfiltered — an explicit
 * pin overrides the embedding/rerank heuristic). Otherwise falls back to the
 * discovered, already-filtered chat-model candidates.
 */
export function resolveCandidateModels(discoveredChatModelIds: string[]): string[] {
  const envModel = process.env.LLM_MODEL;
  if (envModel && envModel.trim()) return [envModel.trim()];
  return discoveredChatModelIds;
}

async function probeEndpoint(base: string): Promise<DiscoveredEndpoint | null> {
  try {
    const resp = await fetch(`${base}/models`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const models = resolveCandidateModels(pickChatModelIds(data));
    if (models.length === 0) return null; // no usable chat model on this endpoint
    return { endpoint: base, models };
  } catch {
    return null;
  }
}

/**
 * Finds the first healthy endpoint (GET {base}/models returns 200 AND has at
 * least one chat-capable model) among the configured candidates, and caches
 * the choice for CACHE_TTL_MS. Pass `skip` to exclude one endpoint from the
 * scan (used by the single retry pass after a request-time failure).
 */
export async function discoverBackend(opts: { skip?: string } = {}): Promise<DiscoveredEndpoint | null> {
  const now = Date.now();
  if (cache && now - cache.cachedAt < CACHE_TTL_MS && cache.endpoint !== opts.skip) {
    return { endpoint: cache.endpoint, models: cache.models };
  }

  for (const base of getEndpoints()) {
    if (base === opts.skip) continue;
    const found = await probeEndpoint(base);
    if (found) {
      cache = { ...found, cachedAt: now };
      return found;
    }
  }

  cache = null;
  return null;
}

/**
 * Moves a confirmed-working model to the front of the cached candidate list
 * for its endpoint and refreshes the TTL, so the 60s cache is keyed to the
 * (endpoint, model) pair that actually completed a chat request — not just
 * whatever /models happened to list first.
 */
function markModelConfirmed(endpoint: string, model: string): void {
  if (!cache || cache.endpoint !== endpoint) return; // stale (cache moved on); ignore
  const rest = cache.models.filter((m) => m !== model);
  cache = { endpoint, models: [model, ...rest], cachedAt: Date.now() };
}

/**
 * Extracts a JSON object from a model response. Chat completions with
 * response_format: json_object already guarantee valid JSON from
 * spec-compliant backends, but some llama.cpp grammar modes / models still
 * wrap output in markdown fences, so this fallback is kept as a safety net.
 */
export function parseJsonFromText(text: string): any {
  if (!text) throw new Error("Empty response from model");
  try {
    return JSON.parse(text.trim());
  } catch {}
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlock) {
    try {
      return JSON.parse(codeBlock[1]);
    } catch {}
  }
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }
  throw new Error("Could not parse JSON from response");
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Thrown when a /chat/completions call returns a non-2xx response. */
export class ChatCompletionError extends Error {
  status: number;
  endpoint: string;

  constructor(message: string, status: number, endpoint: string) {
    super(message);
    this.name = "ChatCompletionError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

// Matches the family of 400 errors backends return when the selected model
// exists but isn't a chat model (e.g. Ollama's
// `"<model>" does not support chat` for embedding/rerank models). This is
// the signal to try the next candidate model on the SAME endpoint, rather
// than treating the endpoint itself as unhealthy.
const NON_CHAT_MODEL_ERROR_PATTERN =
  /does\s*(?:n't|not)\s*support\s*chat|not\s*a\s*chat\s*model|unsupported\s*model|invalid\s*model/i;

function isNonChatModelError(err: unknown): boolean {
  return (
    err instanceof ChatCompletionError &&
    err.status === 400 &&
    NON_CHAT_MODEL_ERROR_PATTERN.test(err.message)
  );
}

async function postChatCompletions(
  endpoint: string,
  model: string,
  messages: ChatMessage[],
  json: boolean,
): Promise<string> {
  const resp = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0.7,
      messages,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new ChatCompletionError(
      `LLM backend ${endpoint} ${resp.status}: ${body.substring(0, 300)}`,
      resp.status,
      endpoint,
    );
  }

  const data: any = await resp.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

/**
 * Tries each candidate model on one endpoint in order. A "does not support
 * chat"-style 400 advances to the next candidate on the SAME endpoint; any
 * other error (network failure, 5xx, timeout, ...) is thrown immediately so
 * the caller can fall back to a different endpoint instead of wasting the
 * retry budget on doomed candidates.
 */
async function tryModelsOnEndpoint(
  endpoint: string,
  models: string[],
  messages: ChatMessage[],
  json: boolean,
  modelOverride?: string,
): Promise<{ content: string; model: string }> {
  const candidates = modelOverride ? [modelOverride] : models;
  let lastErr: unknown;
  for (const model of candidates) {
    try {
      const content = await postChatCompletions(endpoint, model, messages, json);
      return { content, model };
    } catch (err) {
      lastErr = err;
      if (isNonChatModelError(err)) continue;
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Runs a chat completion against the currently discovered backend, cascading
 * through that endpoint's candidate models on a "not a chat model" error. If
 * every candidate on the endpoint fails (of any kind), invalidates the cache
 * and retries once against the next healthy endpoint before giving up.
 */
async function chatCompletion(
  messages: ChatMessage[],
  json: boolean,
  modelOverride?: string,
): Promise<string> {
  const discovered = await discoverBackend();
  if (!discovered) {
    throw new Error(`No LLM backend available. Tried: ${getEndpoints().join(", ")}`);
  }

  try {
    const result = await tryModelsOnEndpoint(discovered.endpoint, discovered.models, messages, json, modelOverride);
    markModelConfirmed(discovered.endpoint, result.model);
    return result.content;
  } catch (err) {
    invalidateCache();
    const fallback = await discoverBackend({ skip: discovered.endpoint });
    if (!fallback) throw err;
    const result = await tryModelsOnEndpoint(fallback.endpoint, fallback.models, messages, json, modelOverride);
    markModelConfirmed(fallback.endpoint, result.model);
    return result.content;
  }
}

/**
 * JSON-constrained chat call. Sends response_format: json_object and parses
 * the result with parseJsonFromText as a safety net.
 */
export async function askJson(systemPrompt: string, userMessage: string): Promise<any> {
  const text = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    true,
  );
  return parseJsonFromText(text);
}

/**
 * Free-form text chat call (no JSON constraint). `modelOverride` lets
 * callers (e.g. /api/generate) pin a specific model for one request.
 */
export async function askText(
  systemPrompt: string,
  userMessage: string,
  modelOverride?: string,
): Promise<string> {
  const messages: ChatMessage[] = [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
    { role: "user" as const, content: userMessage },
  ];
  return chatCompletion(messages, false, modelOverride);
}

/** Backend info for /api/health: currently selected endpoint (or none) + model. */
export async function getBackendStatus(): Promise<{ endpoint: string; model: string | null }> {
  const discovered = await discoverBackend();
  if (!discovered) return { endpoint: "none", model: null };
  return { endpoint: discovered.endpoint, model: discovered.models[0] ?? null };
}
