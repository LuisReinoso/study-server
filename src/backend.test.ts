import {
  getEndpoints,
  isLikelyNonChatModel,
  pickChatModelIds,
  resolveCandidateModels,
  discoverBackend,
  askJson,
  askText,
  getBackendStatus,
  invalidateCache,
  parseJsonFromText,
} from "./backend";

function jsonResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("backend", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    invalidateCache();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.LLM_ENDPOINTS;
    delete process.env.LLM_MODEL;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // ===== getEndpoints =====

  describe("getEndpoints", () => {
    it("returns the four default llama.cpp/Ollama endpoints when LLM_ENDPOINTS is unset", () => {
      expect(getEndpoints()).toEqual([
        "http://127.0.0.1:8898/v1",
        "http://127.0.0.1:8899/v1",
        "http://127.0.0.1:8897/v1",
        "http://127.0.0.1:11434/v1",
      ]);
    });

    it("parses a custom comma-separated LLM_ENDPOINTS, trimming whitespace", () => {
      process.env.LLM_ENDPOINTS = " http://a/v1 , http://b/v1 ,http://c/v1";
      expect(getEndpoints()).toEqual(["http://a/v1", "http://b/v1", "http://c/v1"]);
    });
  });

  // ===== embedding/rerank filtering =====

  describe("isLikelyNonChatModel", () => {
    it("flags ids containing embed/bge/rerank, case-insensitively", () => {
      expect(isLikelyNonChatModel("nomic-embed-text:latest")).toBe(true);
      expect(isLikelyNonChatModel("bge-large-en")).toBe(true);
      expect(isLikelyNonChatModel("BGE-M3")).toBe(true);
      expect(isLikelyNonChatModel("bge-reranker-v2")).toBe(true);
      expect(isLikelyNonChatModel("some-RERANK-model")).toBe(true);
      expect(isLikelyNonChatModel("EMBEDDING-ada-002")).toBe(true);
    });

    it("does not flag ordinary chat model ids", () => {
      expect(isLikelyNonChatModel("laguna-xs-2.1:latest")).toBe(false);
      expect(isLikelyNonChatModel("glm-5.2:cloud")).toBe(false);
      expect(isLikelyNonChatModel("qwen2.5-14b-instruct")).toBe(false);
    });
  });

  describe("pickChatModelIds", () => {
    it("filters out embedding/rerank ids and keeps chat models in order", () => {
      const response = {
        data: [
          { id: "nomic-embed-text:latest" },
          { id: "laguna-xs-2.1:latest" },
          { id: "bge-reranker-v2" },
          { id: "glm-5.2:cloud" },
        ],
      };
      expect(pickChatModelIds(response)).toEqual(["laguna-xs-2.1:latest", "glm-5.2:cloud"]);
    });

    it("returns an empty array when there is no usable data or all models are non-chat", () => {
      expect(pickChatModelIds({})).toEqual([]);
      expect(pickChatModelIds(null)).toEqual([]);
      expect(pickChatModelIds({ data: [{ id: "nomic-embed-text:latest" }, { id: "bge-m3" }] })).toEqual([]);
    });
  });

  describe("resolveCandidateModels", () => {
    it("prefers LLM_MODEL env var, unfiltered, over discovered chat models", () => {
      process.env.LLM_MODEL = "custom-model";
      expect(resolveCandidateModels(["chat-a", "chat-b"])).toEqual(["custom-model"]);
    });

    it("falls back to the discovered chat-model candidates when LLM_MODEL is unset", () => {
      expect(resolveCandidateModels(["chat-a", "chat-b"])).toEqual(["chat-a", "chat-b"]);
    });

    it("returns an empty array when neither LLM_MODEL nor any discovered model is available", () => {
      expect(resolveCandidateModels([])).toEqual([]);
    });
  });

  // ===== discovery / fallback order =====

  describe("discoverBackend", () => {
    it("picks the first endpoint whose /models returns 200, in configured order", async () => {
      process.env.LLM_ENDPOINTS = "http://a/v1,http://b/v1,http://c/v1";
      const fetchMock = jest
        .fn()
        .mockRejectedValueOnce(new Error("connection refused")) // a: down
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-b" }] })); // b: up
      (global as any).fetch = fetchMock;

      const backend = await discoverBackend();
      expect(backend).toEqual({ endpoint: "http://b/v1", models: ["model-b"] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe("http://a/v1/models");
      expect(fetchMock.mock.calls[1][0]).toBe("http://b/v1/models");
    });

    it("auto-selects the first CHAT-capable model, skipping embedding models Ollama lists first", async () => {
      // This reproduces the real bug: Ollama's /models lists an embedding
      // model before the chat model, and naive first-id selection picked it.
      process.env.LLM_ENDPOINTS = "http://ollama/v1";
      (global as any).fetch = jest.fn().mockResolvedValue(
        jsonResponse({
          data: [
            { id: "nomic-embed-text:latest" },
            { id: "laguna-xs-2.1:latest" },
            { id: "glm-5.2:cloud" },
          ],
        }),
      );

      const backend = await discoverBackend();
      expect(backend).toEqual({
        endpoint: "http://ollama/v1",
        models: ["laguna-xs-2.1:latest", "glm-5.2:cloud"],
      });
    });

    it("skips an endpoint entirely when every model it lists is non-chat", async () => {
      process.env.LLM_ENDPOINTS = "http://embed-only/v1,http://chat/v1";
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "bge-m3" }, { id: "nomic-embed-text" }] }))
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "chat-model" }] }));
      (global as any).fetch = fetchMock;

      const backend = await discoverBackend();
      expect(backend?.endpoint).toBe("http://chat/v1");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("returns null when no configured endpoint is healthy", async () => {
      process.env.LLM_ENDPOINTS = "http://a/v1,http://b/v1";
      (global as any).fetch = jest.fn().mockResolvedValue(jsonResponse({}, 500));

      const backend = await discoverBackend();
      expect(backend).toBeNull();
    });

    it("caches the selection and does not re-probe within the TTL", async () => {
      process.env.LLM_ENDPOINTS = "http://a/v1";
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: [{ id: "m" }] }));
      (global as any).fetch = fetchMock;

      await discoverBackend();
      await discoverBackend();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("honors the skip option, excluding one endpoint from the scan", async () => {
      process.env.LLM_ENDPOINTS = "http://a/v1,http://b/v1";
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: [{ id: "model-b" }] }));
      (global as any).fetch = fetchMock;

      const backend = await discoverBackend({ skip: "http://a/v1" });
      expect(backend?.endpoint).toBe("http://b/v1");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("http://b/v1/models");
    });
  });

  // ===== resilience: cascade through models on the same endpoint =====

  describe("model-level cascade on a non-chat-model error", () => {
    it("advances to the next candidate model on the SAME endpoint without re-probing /models", async () => {
      process.env.LLM_ENDPOINTS = "http://ollama/v1";
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ data: [{ id: "nomic-embed-text:latest" }, { id: "chat-a" }, { id: "chat-b" }] }),
        ) // discovery: filters out the embed id, leaves [chat-a, chat-b]
        .mockResolvedValueOnce(
          jsonResponse(
            { error: { message: '"chat-a" does not support chat', type: "invalid_request_error" } },
            400,
          ),
        ) // chat-a: rejected as non-chat (edge case even after filtering)
        .mockResolvedValueOnce(
          jsonResponse({ choices: [{ message: { content: "hello from chat-b" } }] }),
        ); // chat-b: succeeds
      (global as any).fetch = fetchMock;

      const result = await askText("sys", "usr");
      expect(result).toBe("hello from chat-b");
      expect(fetchMock).toHaveBeenCalledTimes(3); // one /models call, two /chat/completions calls, NO extra /models
      expect(fetchMock.mock.calls[1][0]).toBe("http://ollama/v1/chat/completions");
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe("chat-a");
      expect(fetchMock.mock.calls[2][0]).toBe("http://ollama/v1/chat/completions");
      expect(JSON.parse(fetchMock.mock.calls[2][1].body).model).toBe("chat-b");
    });

    it("only falls to the next ENDPOINT once every model on the current endpoint has failed", async () => {
      process.env.LLM_ENDPOINTS = "http://a/v1,http://b/v1";
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "a-model-1" }, { id: "a-model-2" }] })) // discover a
        .mockResolvedValueOnce(
          jsonResponse({ error: { message: '"a-model-1" does not support chat' } }, 400),
        ) // a-model-1 fails (non-chat)
        .mockResolvedValueOnce(
          jsonResponse({ error: { message: '"a-model-2" does not support chat' } }, 400),
        ) // a-model-2 also fails (non-chat) -> endpoint a exhausted
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "b-model" }] })) // re-discover, skip a -> b
        .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" } }] })); // b-model succeeds
      (global as any).fetch = fetchMock;

      const result = await askText("sys", "usr");
      expect(result).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(fetchMock.mock.calls[4][0]).toBe("http://b/v1/chat/completions");
    });

    it("does NOT cascade through other models on a plain network/500 error, and moves to the next endpoint immediately", async () => {
      process.env.LLM_ENDPOINTS = "http://a/v1,http://b/v1";
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "a-model-1" }, { id: "a-model-2" }] })) // discover a
        .mockResolvedValueOnce(jsonResponse({ error: "internal server error" }, 500)) // a-model-1: generic 500, NOT a chat-support error
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "b-model" }] })) // re-discover, skip a -> b (a-model-2 never tried)
        .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" } }] })); // b-model succeeds
      (global as any).fetch = fetchMock;

      const result = await askText("sys", "usr");
      expect(result).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(4);
      // a-model-2 must never have been attempted:
      const bodies = fetchMock.mock.calls
        .filter((c: any[]) => typeof c[1]?.body === "string")
        .map((c: any[]) => JSON.parse(c[1].body).model);
      expect(bodies).not.toContain("a-model-2");
    });

    it("caches the confirmed-working model at the front, so a later call on the same endpoint uses it first without re-probing", async () => {
      process.env.LLM_ENDPOINTS = "http://ollama/v1";
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "chat-a" }, { id: "chat-b" }] })) // discovery
        .mockResolvedValueOnce(jsonResponse({ error: { message: "does not support chat" } }, 400)) // chat-a fails
        .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "first" } }] })) // chat-b succeeds
        .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "second" } }] })); // second call
      (global as any).fetch = fetchMock;

      const first = await askText("sys", "usr1");
      expect(first).toBe("first");
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const second = await askText("sys", "usr2");
      expect(second).toBe("second");
      // No extra /models probe, and the 4th call goes straight to chat-b (the confirmed model).
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock.mock.calls[3][0]).toBe("http://ollama/v1/chat/completions");
      expect(JSON.parse(fetchMock.mock.calls[3][1].body).model).toBe("chat-b");
    });
  });

  // ===== retry across endpoints (generic failure, not model-specific) =====

  describe("endpoint-level retry on request failure", () => {
    it("invalidates the cache and retries once against the next healthy endpoint", async () => {
      process.env.LLM_ENDPOINTS = "http://a/v1,http://b/v1";
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-a" }] })) // discover: a healthy
        .mockResolvedValueOnce(jsonResponse({}, 500)) // chat completion on a: fails (generic)
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-b" }] })) // re-discover, skip a -> b healthy
        .mockResolvedValueOnce(
          jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }),
        ); // chat completion on b: succeeds
      (global as any).fetch = fetchMock;

      const result = await askJson("system", "user");
      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock.mock.calls[3][0]).toBe("http://b/v1/chat/completions");
    });

    it("propagates the original error when the retry also fails to find a backend", async () => {
      process.env.LLM_ENDPOINTS = "http://a/v1";
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-a" }] })) // discover: a healthy
        .mockResolvedValueOnce(jsonResponse({}, 500)); // chat completion on a: fails, no other endpoint configured
      (global as any).fetch = fetchMock;

      await expect(askJson("system", "user")).rejects.toThrow(/LLM backend/);
    });
  });

  // ===== askJson / askText request shape =====

  describe("askJson", () => {
    it("sends response_format json_object and parses the returned content", async () => {
      process.env.LLM_ENDPOINTS = "http://a/v1";
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-a" }] }))
        .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '{"cards":[]}' } }] }));
      (global as any).fetch = fetchMock;

      const result = await askJson("sys", "usr");
      expect(result).toEqual({ cards: [] });

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.temperature).toBe(0.7);
      expect(body.stream).toBe(false);
      expect(body.model).toBe("model-a");
      expect(body.messages).toEqual([
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ]);
    });
  });

  describe("askText", () => {
    it("omits response_format and honors a model override (bypassing the candidate list)", async () => {
      process.env.LLM_ENDPOINTS = "http://a/v1";
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-a" }] }))
        .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "hello" } }] }));
      (global as any).fetch = fetchMock;

      const result = await askText("sys", "usr", "override-model");
      expect(result).toBe("hello");

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.response_format).toBeUndefined();
      expect(body.model).toBe("override-model");
    });
  });

  // ===== /api/health backend status =====

  describe("getBackendStatus", () => {
    it("reports endpoint 'none' and model null when nothing is healthy", async () => {
      process.env.LLM_ENDPOINTS = "http://a/v1";
      (global as any).fetch = jest.fn().mockRejectedValue(new Error("down"));

      const status = await getBackendStatus();
      expect(status).toEqual({ endpoint: "none", model: null });
    });

    it("reports the selected endpoint and a CHAT-capable model when healthy", async () => {
      process.env.LLM_ENDPOINTS = "http://a/v1";
      (global as any).fetch = jest.fn().mockResolvedValue(
        jsonResponse({ data: [{ id: "nomic-embed-text:latest" }, { id: "chat-model" }] }),
      );

      const status = await getBackendStatus();
      expect(status).toEqual({ endpoint: "http://a/v1", model: "chat-model" });
    });
  });

  // ===== parseJsonFromText safety net =====

  describe("parseJsonFromText", () => {
    it("parses plain JSON", () => {
      expect(parseJsonFromText('{"a":1}')).toEqual({ a: 1 });
    });

    it("parses JSON wrapped in a markdown code fence", () => {
      expect(parseJsonFromText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    });

    it("extracts JSON via bracket matching when embedded in prose", () => {
      expect(parseJsonFromText('here is the answer: {"a":1} thanks')).toEqual({ a: 1 });
    });

    it("throws on empty input", () => {
      expect(() => parseJsonFromText("")).toThrow("Empty response from model");
    });

    it("throws when no JSON can be found", () => {
      expect(() => parseJsonFromText("no json here")).toThrow("Could not parse JSON from response");
    });
  });
});
