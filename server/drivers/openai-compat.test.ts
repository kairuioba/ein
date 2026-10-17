import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver, settleOpenAICompatModels } from "./openai-compat.ts";

describe("OpenAICompatDriver", () => {
  const savedUrl = process.env.OPENAI_COMPAT_URL;
  const savedKey = process.env.OPENAI_COMPAT_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_COMPAT_URL;
    delete process.env.OPENAI_COMPAT_API_KEY;
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.OPENAI_COMPAT_URL;
    else process.env.OPENAI_COMPAT_URL = savedUrl;
    if (savedKey === undefined) delete process.env.OPENAI_COMPAT_API_KEY;
    else process.env.OPENAI_COMPAT_API_KEY = savedKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers with the openai-compat kind and a display name", () => {
    expect(OpenAICompatDriver.driverKind).toBe("openai-compat");
    expect(OpenAICompatDriver.metadata.displayName).toMatch(/OpenRouter|Groq/);
  });

  it("falls back to the OpenRouter endpoint by default", () => {
    const cfg = OpenAICompatDriver.defaultConfig();
    expect(cfg.url).toBe("https://openrouter.ai/api/v1");
    expect(cfg.apiKeyEnv).toBe("OPENAI_COMPAT_API_KEY");
  });

  it("honours an explicit url and apiKeyEnv override", () => {
    const cfg = OpenAICompatDriver.decodeConfig({
      url: "https://api.groq.com/openai/v1/",
      apiKeyEnv: "GROQ_KEY",
    });
    expect(cfg.url).toBe("https://api.groq.com/openai/v1");
    expect(cfg.apiKeyEnv).toBe("GROQ_KEY");
  });

  it("reports unavailable without an API key", async () => {
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-1",
      displayName: "Free",
      enabled: true,
      config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
      environment: {},
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("unavailable");
    await inst.dispose();
  });

  it("advertises mid-turn steering for the API engines", async () => {
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-steering-capability",
      displayName: "Steering",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    expect(inst.adapter.capabilities.queueing).toBe(true);
    expect(typeof inst.adapter.steer).toBe("function");
    await inst.dispose();
  });

  it("seeds the picker from the disk cache and probes /models in the background", async () => {
    let releaseProbe = () => {};
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await probeGate;
      return new Response(
        JSON.stringify({
          data: [
            { id: "vendor/model-a", name: "Model A" },
            { id: "vendor/model-b" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-models",
      displayName: "Models",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret", EIN_PROBE_LIVE_MODELS: "1" },
    });

    // Creating the instance (and the first picker open) must not wait on the
    // endpoint: the seeded catalog renders while the probe is still hanging.
    expect(fetchMock).not.toHaveBeenCalled();
    await inst.refreshModels?.();
    expect(inst.models.default).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(inst.models.options.some((option) => option.id === "vendor/model-a")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The background answer lands on the next picker open.
    releaseProbe();
    await settleOpenAICompatModels("https://example.test/v1", "secret");
    await inst.refreshModels?.();

    // Every option carries `custom: true`: this engine advertises
    // `access: "custom"`, and the picker renders only custom-flagged options
    // for such engines — an unflagged one is invisible in its own picker.
    expect(inst.models).toEqual({
      default: "vendor/model-a",
      options: [
        { id: "vendor/model-a", label: "Model A", custom: true },
        { id: "vendor/model-b", label: "vendor/model-b", custom: true },
      ],
    });
    // A fresh answer is served from the cache: another open sends nothing.
    await inst.refreshModels?.();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await inst.dispose();
  });

  it("includes streamed token totals and bounds the cancellable stream", async () => {
    const anySignal = vi.spyOn(AbortSignal, "any");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-turn",
      displayName: "Turn",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread", text: "private prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
    expect(anySignal).toHaveBeenCalledTimes(1);
    recorder.stop();
    await inst.dispose();
  });

  it("streams reasoning separately and completes only actual assistant text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n' +
            'data: {"choices":[{"delta":{"content":"answer"}}]}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-stream",
      displayName: "Reasoning",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "reasoning-thread", text: "question", model: "vendor/model" });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "content.delta", streamKind: "reasoning_text", delta: "thinking" }),
      expect.objectContaining({ type: "content.delta", streamKind: "assistant_text", delta: "answer" }),
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "answer" }),
    ]));
    expect(recorder.events).not.toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "thinking" }),
    );
    recorder.stop();
    await inst.dispose();
  });

  it("uses reasoning as a helper-model fallback when normal content is whitespace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "  ", reasoning_content: "usable result" } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-helper",
      displayName: "Reasoning helper",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });

    await expect(inst.generateText?.("question")).resolves.toBe("usable result");
    await inst.dispose();
  });

  it("falls back to reasoning_content when content is empty (streaming)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking through the problem"}}]}\n' +
            'data: {"choices":[{"delta":{"content":""}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-fallback-stream",
      displayName: "Reasoning Fallback",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-rf", text: "prompt", model: "vendor/model" });
    const item = await recorder.until((e) => e.type === "item.completed");
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(item).toMatchObject({
      type: "item.completed",
      itemType: "assistant_text",
      text: "thinking through the problem",
    });
    expect(completed).toMatchObject({ ok: true, usage: { input: 10, output: 5 } });

    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    expect(deltas.some((d: any) => d.streamKind === "reasoning_text" && d.delta === "thinking through the problem")).toBe(true);

    recorder.stop();
    await inst.dispose();
  });

  it("decodes a default model and provider from config", () => {
    const cfg = OpenAICompatDriver.decodeConfig({
      model: "deepseek/deepseek-v4-flash-0731",
      provider: "fireworks",
    });
    expect(cfg.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(cfg.provider).toBe("fireworks");
  });

  it("seeds the picker with the configured default model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-default-model",
      displayName: "Default model",
      enabled: true,
      config: {
        url: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_KEY",
        model: "deepseek/deepseek-v4-flash-0731",
      },
      environment: { TEST_KEY: "secret" },
    });
    expect(inst.models.default).toBe("deepseek/deepseek-v4-flash-0731");
    expect(inst.models.options.some((o) => o.id === "deepseek/deepseek-v4-flash-0731")).toBe(true);
    await inst.dispose();
  });

  it("pins the OpenRouter upstream provider in the request body", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-provider-route",
      displayName: "Provider route",
      enabled: true,
      config: {
        url: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_KEY",
        provider: "fireworks",
      },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({
      threadId: "thread-p",
      text: "prompt",
      model: "deepseek/deepseek-v4-flash-0731",
    });
    await recorder.until((e) => e.type === "turn.completed");

    expect(sentBody?.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(sentBody?.provider).toEqual({ order: ["fireworks"], allow_fallbacks: false });
    recorder.stop();
    await inst.dispose();
  });

  it("omits provider routing on non-OpenRouter endpoints even when configured", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-groq-no-provider",
      displayName: "Groq strict",
      enabled: true,
      config: {
        url: "https://api.groq.com/openai/v1",
        apiKeyEnv: "TEST_KEY",
        provider: "fireworks",
      },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-g", text: "prompt", model: "vendor/model" });
    await recorder.until((e) => e.type === "turn.completed");

    // Strict OpenAI-compatible endpoints (Groq et al.) reject unknown
    // top-level fields — `provider` is OpenRouter-only routing.
    expect(sentBody).not.toBeNull();
    expect("provider" in sentBody).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("does not treat a lookalike host as OpenRouter", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-lookalike",
      displayName: "Lookalike host",
      enabled: true,
      config: {
        // hostname is NOT openrouter.ai — substring matching on the whole
        // URL would be fooled by a lookalike domain or a path segment
        url: "https://notopenrouter.ai/api/v1",
        apiKeyEnv: "TEST_KEY",
        provider: "fireworks",
      },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-l", text: "prompt", model: "vendor/model" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(sentBody).not.toBeNull();
    expect("provider" in sentBody).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("pins the provider on an OpenRouter subdomain", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-subdomain",
      displayName: "OpenRouter subdomain",
      enabled: true,
      config: {
        url: "https://gateway.openrouter.ai/api/v1",
        apiKeyEnv: "TEST_KEY",
        provider: "fireworks",
      },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-s", text: "prompt", model: "vendor/model" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(sentBody?.provider).toEqual({ order: ["fireworks"], allow_fallbacks: false });
    recorder.stop();
    await inst.dispose();
  });

  it("takes a mid-turn message into the running turn with one more request", async () => {
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const bodies: any[] = [];
    const sse = (body: string) =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) {
          await firstGate;
          return sse(
            'data: {"choices":[{"delta":{"content":"first answer"}}]}\n' +
              'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n' +
              "data: [DONE]\n",
          );
        }
        return sse(
          'data: {"choices":[{"delta":{"content":"second answer"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n' +
            "data: [DONE]\n",
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-steer-turn",
      displayName: "Steer",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY", model: "vendor/model" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);
    const { turnId } = await inst.adapter.sendTurn({ threadId: "t-steer", text: "first question" });
    expect(bodies).toHaveLength(1);

    await expect(inst.adapter.steer!("t-steer", "also answer this", { steerId: "s1" })).resolves.toBe(true);
    releaseFirst();
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    // ONE turn, and one usage total across both requests
    expect(done).toMatchObject({ ok: true, usage: { input: 14, output: 3 } });
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    const replies = recorder.events
      .filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(replies).toEqual(["first answer", "second answer"]);

    // The second request sees the reply that just landed, then the user's
    // message framed as a mid-turn interjection (steer.ts), not a new task.
    expect(bodies[1].messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: expect.stringContaining("also answer this") },
    ]);
    expect(bodies[1].messages[2].content).toContain("not a request to stop");
    recorder.stop();
    await inst.dispose();
  });

  it("hands an accepted steer back as undelivered when the turn fails first", async () => {
    let failFirst: (error: Error) => void = () => {};
    const firstGate = new Promise<Response>((_resolve, reject) => {
      failFirst = reject;
    });
    vi.stubGlobal("fetch", vi.fn(async () => firstGate));
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-steer-undelivered",
      displayName: "Undelivered",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY", model: "vendor/model" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);
    const { turnId } = await inst.adapter.sendTurn({ threadId: "t-fail", text: "first" });

    await expect(inst.adapter.steer!("t-fail", "correction", { steerId: "s1" })).resolves.toBe(true);
    failFirst(new Error("upstream exploded"));
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    // the harness runs undelivered steers next; they must not be lost here
    expect(done).toMatchObject({ ok: false, stopReason: "error", undeliveredSteers: ["s1"] });
    expect(inst.adapter.hasSession("t-fail")).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("omits provider routing when none is configured", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-no-provider",
      displayName: "No provider",
      enabled: true,
      config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-np", text: "prompt", model: "vendor/model" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(sentBody).not.toBeNull();
    expect("provider" in sentBody).toBe(false);
    recorder.stop();
    await inst.dispose();
  });
});
