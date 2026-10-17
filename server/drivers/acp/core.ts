// Generic ACP (Agent Client Protocol) driver core — one JSON-RPC-2.0-over-
// stdio session runtime that every ACP CLI harness (Grok Build, Gemini CLI,
// …) rides. Modeled on t3code's AcpSessionRuntime + per-agent AcpSupport
// split: the protocol mechanics live here, the per-harness quirks (spawn
// argv, auth method, model catalog, sign-in check) live in a small support
// object. Adding a harness = write server/drivers/acp/<name>.ts.
//
// ACP has no `turn/completed` notification: the `session/prompt` RPC *result*
// is the completion signal (it carries stopReason + usage). Permission
// requests arrive as server→client `session/request_permission` and surface
// as canonical request.opened events, answered fail-closed (nothing approved
// unless the agent explicitly offered an `allow`-kind option — option ORDER
// is never a security contract). session/load REPLAYS history as ordinary
// session/update notifications, so updates are double-gated: nothing emits
// before the prompt is sent, and `_meta.isReplay` updates are dropped.
import { homedir } from "node:os";

import { PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import { decodeInjectId } from "../local-inject.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../../procs.ts";
import { msg, t } from "../../../shared/i18n.ts";

/**
 * A `host::model` pick talks to a loopback server with its own key.
 * Subscription ACP login (grok.com cached_token) must not fail that turn.
 */
export function skipSubscriptionAuthForLocalInject(model: string | undefined): boolean {
  return Boolean(decodeInjectId(model));
}

import type {
  DriverCreateInput,
  EffortLevel,
  EngineInstall,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  ModelCatalog,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ProviderErrorCode,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { computerProxyEnv } from "../../container-computer.ts";
import { augmentedPath } from "../../env-path.ts";

// Resolved from the server root, never relative to this file: bundling inlines
// this module two directories up, so the `".."` pair here would climb past the
// packaged server dir entirely. See server/proxy-paths.ts.
const COMPUTER_PROXY_PATH = SPAWNED_PROXIES.computer;
import { appendNative } from "../native.ts";
import { steerContinuationPrompt, undeliveredField, withEarlySteers, type PendingSteer } from "../steer.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  /** Optional home for this instance's sessions. */
  workspace?: string;
}

/** Per-harness specifics — everything that differs between Grok, Gemini, … */
export interface AcpSupport {
  driverKind: string;
  displayName: string;
  /** Omit for subscription CLIs (the default). Custom-only CLIs sit below
   *  the picker-rail divider and have no first-party cloud catalog. */
  access?: "subscription" | "custom";
  models: { default: string; options: Array<{ id: string; label: string }> };
  /** Effort levels this harness's CLI accepts, ascending. Omit when it has
   * no reasoning-effort control. Static for the same reason `models` is:
   * describe() runs before any session exists, so there is no _meta to read
   * — eventually both should come from initialize's _meta.modelState. */
  effortLevels?: readonly EffortLevel[];
  /** Default CLI binary name if the instance config doesn't override it. */
  defaultCli: string;
  /** Optional live model catalog. A failed lookup keeps the last usable catalog.
   *  `config` is the instance decode so a support can ask the same binary it
   *  will spawn (custom `cli` paths), not whatever happens to be named on PATH. */
  resolveModels?(
    environment: Record<string, string | undefined>,
    config: AcpConfig,
  ): ModelCatalog | Promise<ModelCatalog>;
  /** Native-protocol log label, e.g. "grok.acp". */
  nativeSource: string;
  /** Whether models behind this ACP harness can consume a referenced image.
   * Most coding agents can open local files; opt out for text-only agents. */
  images?: boolean;
  /** Message shown when the CLI is present but not signed in. */
  loginNote: string;
  /** How a user installs this harness's CLI; surfaced by the setup UI. */
  install?: EngineInstall;
  /** CLI argv AFTER the binary name to enter ACP stdio mode. */
  spawnArgs(config: AcpConfig, turn: SendTurnInput): string[];
  /** Provider credential variables this ACP child is allowed to inherit. */
  credentialEnv?: readonly string[];
  /** Select the model through a session config option instead of argv, for
   *  harnesses whose ACP subcommand takes no -m (opencode). The agent must
   *  CONFIRM the requested model before we prompt: silently running a model
   *  other than the one the picker shows is the failure this guards. */
  selectModel?: { configId: string };
  /** Mutate the child env in place: strip a key, inject a policy. Receives the
   *  instance config so a support can vary with fullAuto. */
  transformEnv?(env: Record<string, string | undefined>, config: AcpConfig): void;
  /** Mutate the child env after the turn model is known. Catalog refresh and
   *  snapshot share `transformEnv` and must not see a per-turn overlay. */
  applyTurnEnv?(
    env: Record<string, string | undefined>,
    ctx: { model?: string; requestedModel?: string },
  ): void;
  /** Pick the ACP authenticate methodId from initialize's advertised
   * authMethods; return null to skip the authenticate step. */
  pickAuthMethod(authMethods: Array<{ id?: string }>): string | null;
  /** "fail": abort the turn if auth is missing/errors (subscription CLIs).
   *  "continue": proceed anyway (CLIs that work off an ambient login). */
  authFailure: "fail" | "continue";
  /** snapshot(): can this harness actually run a turn? (env already carries the
   *  merged config). May be async for harnesses that have to ask the CLI. */
  isAuthenticated(env: Record<string, string | undefined>, config: AcpConfig): boolean | Promise<boolean>;
  /** Refuse a first-party cloud turn before spawning when snapshot auth is
   * false. Local injected models deliberately bypass this subscription gate. */
  requireAuthenticationBeforeSpawn?: boolean;
  /** Classify provider-native failures without coupling the core to messages. */
  classifyError?(error: unknown): ProviderErrorCode | undefined;
  /** Compose the session/prompt text. Default prepends the persona. */
  buildPromptText?(turn: SendTurnInput): string;
  /** Rewrite a picker id (`omlx::model`) into the CLI-native id before spawn
   * and session/select. Local inject writers live here so the child sees a
   * model it already knows. */
  resolveTurnModel?(
    model: string | undefined,
    env: Record<string, string | undefined>,
  ): string | undefined;
  /** Apply per-session settings between session/new (or session/load) and the
   * first session/prompt. Some CLIs ignore argv and take the model/mode over
   * the wire instead (droid), so this is the only place the pick can land; a
   * throw here fails the turn rather than silently running another model. */
  configureSession?(ctx: {
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    sessionId: string;
    config: AcpConfig;
    turn: SendTurnInput;
    /** `session/new` (or `session/load`) advertised model list, verbatim. Some
     * CLIs namespace their ACP model ids differently from their argv `--model`
     * slugs (Cursor answers `default[]` where the CLI calls it `auto`), so a
     * driver that only knows the argv slug cannot form a valid set_model
     * without this. Empty when the agent advertised none. */
    sessionModels: Array<{ modelId?: string; name?: string }>;
  }): Promise<void>;
}

const INIT_TIMEOUT = 20_000;
const SESSION_CONFIG_TIMEOUT = 20_000; // configureSession's per-request default
const NEW_SESSION_TIMEOUT = 30_000;
const LOAD_SESSION_TIMEOUT = 120_000; // history replay on a long thread is slow
const NATIVE_STEER_TIMEOUT = 10_000; // _session/steering answers at once or not at all

function decodeAcpConfig(defaultCli: string) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    };
  };
}

/**
 * ACP JSON-RPC-over-stdio driver. Harness differences (argv, auth, catalog)
 * live in `support`; this is the shared handshake and turn runtime.
 */
export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const decodeConfig = decodeAcpConfig(support.defaultCli);
  const DENY_TIMEOUT_NOTE =
    msg("Ein: nobody answered this permission request in time. Skip this action and finish what you can without it.");

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: support.displayName,
      supportsMultipleInstances: true,
      access: support.access ?? "subscription",
    },
    install: support.install,
    models: support.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const childEnv = () => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...input.environment,
          PATH: augmentedPath(),
        };
        const allowedCredentials = new Set(support.credentialEnv ?? []);
        // two lists, one rule: foreign PROVIDER keys must not flip a CLI's
        // billing off its own login, and WORKSPACE credentials (box token,
        // voice key, …) are the harness's secrets — riding along in
        // `...process.env` is not a grant. A driver keeps only what its
        // credentialEnv allowlist names.
        for (const key of [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]) {
          if (!allowedCredentials.has(key)) delete env[key];
        }
        support.transformEnv?.(env, config);
        return env;
      };
      let models = support.models;
      const refreshModels = async () => {
        if (!support.resolveModels) return;
        try {
          const resolved = await support.resolveModels(childEnv(), config);
          if (resolved.options.length) models = resolved;
        } catch {
          // Keep the last usable catalog when an optional discovery source is down.
        }
      };
      await refreshModels();
      const listeners = new Set<RuntimeEventListener>();
      interface Turn {
        stop: () => void;
        interrupt: () => void;
        turnId: string;
        asks: Map<string, (behavior: string, source?: "user" | "timeout" | "system") => void>;
        steer: (text: string, steerId?: string) => boolean;
      }
      const active = new Map<string, Turn>();

      const emit = (event: RuntimeEvent) => {
        for (const l of [...listeners]) l(event);
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      // ACP session mcpServers: stdio is the baseline every ACP agent
      // supports (mcpCapabilities.http/.sse only add EXTRA transports), so
      // an injected stdio proxy — e.g. the peer-agent comms tool — attaches
      // fine here. env is the ACP {name,value}[] shape.
      const acpMcpServers = (turn: SendTurnInput) => {
        const servers: Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> = [];
        const acpEnv = (env: Record<string, string>) =>
          Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
        const agents = turn.integrations?.agents;
        if (agents) {
          servers.push({ name: "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
        }
        const composio = turn.integrations?.composio;
        if (composio) {
          servers.push({
            name: "composio",
            command: composio.command,
            args: composio.args,
            env: acpEnv(composio.env),
          });
        }
        const browser = turn.integrations?.browser;
        if (browser) {
          servers.push({ name: "browser", command: browser.command, args: browser.args, env: acpEnv(browser.env) });
        }
        // The bot's computer, mounted exactly like the Claude driver does.
        // Cloud boxes use the REST adapter; host and sandbox Cua connections
        // expose Cua Driver's official MCP server directly.
        const computer = turn.integrations?.computer;
        if (computer) {
          servers.push({
            name: "computer",
            command: process.execPath,
            args: [COMPUTER_PROXY_PATH],
            env: acpEnv({ ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(computer) }),
          });
        } else if (turn.integrations?.localComputer) {
          const local = turn.integrations.localComputer;
          servers.push({
            name: "computer",
            command: local.command,
            args: local.args,
            env: acpEnv(local.env ?? {}),
          });
        }
        return servers;
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error(t("a turn is already running on this thread"));
        const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
        if (controlsHost && config.fullAuto) {
          throw new Error(t("local computer control requires interactive provider approvals"));
        }
        const turnId = newId();
        const cwd = turn.cwd ?? config.workspace ?? homedir();
        const env = childEnv();
        if (
          support.requireAuthenticationBeforeSpawn
          && !skipSubscriptionAuthForLocalInject(turn.model)
          && !(await support.isAuthenticated(env, config))
        ) {
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({ ...base(threadId, turnId), type: "runtime.error", message: support.loginNote, setup: true });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required", cost: null });
          return { turnId };
        }
        const resolvedModel = support.resolveTurnModel?.(turn.model, env);
        support.applyTurnEnv?.(env, { model: resolvedModel, requestedModel: turn.model });
        const cliTurn =
          resolvedModel !== undefined && resolvedModel !== turn.model
            ? { ...turn, model: resolvedModel }
            : turn;
        const mcpServers = acpMcpServers(turn);

        const child = spawnCli(config.cli, support.spawnArgs(config, cliTurn), {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });

        const state = { settled: false, promptSent: false, text: "" };
        const asks = new Map<string, (behavior: string, source?: "user" | "timeout" | "system") => void>();
        let nextId = 1;
        let sessionId: string | null = null;
        let interruptTimer: ReturnType<typeof setTimeout> | null = null;
        const rpcPending = new Map<
          number,
          { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }
        >();

        // ── steer: user messages that arrive while this turn runs ─────────
        // Accepted at once, never at the cost of the agent's work. An agent
        // that advertises the `_session/steering` extension (initialize's
        // `_meta.steering.supported`; @agentclientprotocol/claude-agent-acp
        // 0.93.0) injects them into its running prompt itself. Any other
        // agent gets them at the next safe boundary: no tool executing and no
        // permission card open, we session/cancel the prompt and, when it
        // resolves, send the messages as a new session/prompt in the same
        // session — all inside this one turn. A message that lands before the
        // first prompt went out simply joins it.
        const steering = {
          native: false,
          /** accepted, not yet in front of the model */
          pending: [] as PendingSteer[],
          /** handed to _session/steering, no answer yet */
          inFlight: new Set<PendingSteer>(),
          /** riding the session/prompt in flight */
          carried: [] as PendingSteer[],
          /** a session/prompt is in flight */
          prompting: false,
          /** our boundary session/cancel is out; the result continues the turn */
          cancelSent: false,
          /** a real Stop: no more prompts, and nothing more is accepted */
          userStop: false,
          /** the agent said its prompt is over (promptRequired): hold the
           * rest for the follow-up prompt instead of asking again */
          held: false,
          /** wakes the prompt loop once every native answer is in */
          onIdle: null as (() => void) | null,
        };
        /** tool calls the agent reported and has not finished */
        const runningTools = new Set<string>();

        const send = (obj: unknown) => {
          try {
            child.stdin.write(JSON.stringify(obj) + "\n");
          } catch {}
          appendNative(threadId, { dir: "out", source: SOURCE, msg: obj });
        };
        const request = (method: string, params: unknown, timeoutMs?: number) =>
          new Promise<any>((resolve, reject) => {
            const id = nextId++;
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs) {
              timer = setTimeout(() => {
                rpcPending.delete(id);
                reject(new Error(t("{method} timed out", { method })));
              }, timeoutMs);
              timer.unref?.();
            }
            rpcPending.set(id, { resolve, reject, timer });
            send({ jsonrpc: "2.0", id, method, params });
          });

        const stop = () => killCliTree(child);

        /** Emit buffered assistant text as its own item, then clear it. */
        const flushAssistantText = () => {
          const text = state.text;
          state.text = "";
          if (!text.trim()) return;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };

        const settle = (ok: boolean, stopReason: string | null) => {
          if (state.settled) return;
          state.settled = true;
          if (interruptTimer) clearTimeout(interruptTimer);
          for (const finish of [...asks.values()]) finish("cancel", "system");
          for (const p of rpcPending.values()) {
            if (p.timer) clearTimeout(p.timer);
            p.reject(new Error("turn settled"));
          }
          rpcPending.clear();
          active.delete(threadId);
          flushAssistantText();
          // accepted messages the model never got go back to the harness,
          // which runs them next — the turn ending must not lose them
          const undelivered = [...steering.carried, ...steering.inFlight, ...steering.pending];
          steering.carried = [];
          steering.inFlight.clear();
          steering.pending = [];
          steering.onIdle?.();
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null, ...undeliveredField(undelivered) });
          stop(); // the agent process does not exit on its own
        };

        /** Hand one message to the agent's own steering. An agent with no
         * prompt to inject into (`promptRequired`), or one whose extension
         * fails, gets it at the boundary instead. */
        const injectNative = async (item: PendingSteer) => {
          steering.inFlight.add(item);
          let outcome: unknown = null;
          try {
            const answer = await request(
              "_session/steering",
              {
                sessionId,
                prompt: [{ type: "text", text: item.text }],
                // never let an idle agent start a turn of its own: we run the
                // follow-up ourselves, inside this turn
                _meta: { steering: { idleBehavior: "promptRequired" } },
              },
              NATIVE_STEER_TIMEOUT,
            );
            outcome = answer?.outcome;
          } catch {
            /* treated like a refusal below */
          }
          // settle already handed it back to the harness
          if (!steering.inFlight.delete(item)) return;
          if (outcome === "promptRequired") {
            // its prompt is ending: the follow-up prompt carries this one
            steering.held = true;
            steering.pending.push(item);
          } else if (outcome !== "injected" && outcome !== "startedNewTurn") {
            // a broken extension is not retried for the rest of the turn
            steering.native = false;
            steering.pending.push(item);
            pump();
          }
          if (!steering.inFlight.size) steering.onIdle?.();
        };

        /** Move pending messages toward the model, but only at a safe point. */
        const pump = () => {
          if (state.settled || steering.userStop || !steering.prompting || !steering.pending.length) return;
          if (steering.held) return;
          // an open permission card means a tool is mid-flight: never cut in
          if (asks.size > 0) return;
          if (steering.native) {
            for (const item of steering.pending.splice(0)) void injectNative(item);
            return;
          }
          // a tool is executing: its completion update calls pump() again
          if (runningTools.size > 0 || steering.cancelSent || !sessionId) return;
          steering.cancelSent = true;
          send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
        };

        const steerTurn = (text: string, steerId?: string): boolean => {
          if (state.settled || steering.userStop) return false;
          steering.pending.push({ text, steerId });
          pump();
          return true;
        };

        // server→client permission request → canonical request.opened
        const handleServerRequest = (msg: any) => {
          if (msg.method !== "session/request_permission") {
            // never leave an unknown server request hanging — the agent blocks
            return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          }
          const params = msg.params ?? {};
          flushAssistantText();
          const options: Array<{ optionId?: string; kind?: string }> = Array.isArray(params.options) ? params.options : [];
          const optionFor = (want: "allow" | "reject") =>
            options.find((o) => String(o.kind ?? "").startsWith(want) && typeof o.optionId === "string")?.optionId ?? null;
          const cancelled = { outcome: { outcome: "cancelled" } };
          const missing = (want: string) =>
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: t('{engine} offered no "{option}" permission option — cancelling the request instead of guessing', { engine: DRIVER_KIND, option: want }),
            });

          const toolCall = params.toolCall ?? {};
          // the tool asking runs right after the answer: a waiting steer must
          // let it finish (its completion update clears it)
          if (typeof toolCall.toolCallId === "string") runningTools.add(toolCall.toolCallId);
          if (config.fullAuto) {
            const allow = optionFor("allow");
            if (!allow) missing("allow");
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
            });
          }
          const kind = String(toolCall.kind ?? "");
          const tool = kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool";
          const summary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool).slice(0, 200);
          const requestId = newId();
          const finish = (behavior: string, source: "user" | "timeout" | "system" = "user") => {
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            // a message held back while the card was open may go now
            queueMicrotask(pump);
            const want = behavior === "allow" ? "allow" : "reject";
            const optionId = behavior === "cancel" ? null : optionFor(want);
            if (behavior !== "cancel" && !optionId) missing(want);
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: optionId ? { outcome: { outcome: "selected", optionId } } : cancelled,
            });
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: optionId && behavior === "allow" ? "allow" : "deny",
              source: optionId ? source : "system",
              approvalScope: controlsHost ? "local-computer" : undefined,
            });
          };
          const timer = setTimeout(() => {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: t(DENY_TIMEOUT_NOTE) });
            finish("deny", "timeout");
          }, 15 * 60_000);
          timer.unref?.();
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "permission",
            tool,
            summary,
            approvalScope: controlsHost ? "local-computer" : undefined,
          });
        };

        const handleNotification = (msg: any) => {
          // Vendor side-channels (e.g. grok's `_x.ai/*`) are teed to the
          // native log but never normalized: the prompt result is the settle.
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          if (!state.promptSent || p._meta?.isReplay === true) return;
          const u = p.update ?? {};
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                state.text += delta;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
              }
              break;
            }
            case "tool_call": {
              flushAssistantText();
              if (typeof u.toolCallId === "string" && u.status !== "completed" && u.status !== "failed") {
                runningTools.add(u.toolCallId);
              }
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: u.toolCallId,
                title: String(u.rawInput?.command ?? u.title ?? "tool").slice(0, 80),
              });
              break;
            }
            case "tool_call_update": {
              if (u.status === "completed" || u.status === "failed") {
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: u.toolCallId,
                  ok: u.status !== "failed",
                });
                // a finished tool is a safe boundary for a waiting message
                if (runningTools.delete(u.toolCallId)) pump();
              } else if (typeof u.toolCallId === "string" && u.status === "in_progress") {
                runningTools.add(u.toolCallId);
              }
              break;
            }
          }
        };

        let buf = "";
        // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
        // multibyte characters that straddle two reads and corrupts the text
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg: any;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            appendNative(threadId, { dir: "in", source: SOURCE, msg });
            if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
              const pend = rpcPending.get(msg.id);
              if (pend) {
                rpcPending.delete(msg.id);
                if (pend.timer) clearTimeout(pend.timer);
                if (msg.error) {
                  const error = new Error(msg.error.message ?? JSON.stringify(msg.error));
                  Object.assign(error, { code: msg.error.code, data: msg.error.data });
                  pend.reject(error);
                } else {
                  pend.resolve(msg.result);
                }
              }
            } else if (msg.id !== undefined && msg.method) {
              handleServerRequest(msg);
            } else if (msg.method) {
              handleNotification(msg);
            }
          }
        });

        let stderr = "";
        child.stderr.on("data", (c) => {
          stderr += c;
          if (stderr.length > 8192) stderr = stderr.slice(-8192);
        });
        child.on("error", (e) => {
          emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
          settle(false, "spawn_error");
        });
        child.on("close", (code) => {
          if (!state.settled) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: t("{engine} exited {code} before the prompt result", { engine: DRIVER_KIND, code: String(code) }) + (stderr ? `: ${stderr.trim().slice(-300)}` : ""),
            });
            settle(false, "exit_before_result");
          }
        });

        const interrupt = () => {
          // a real Stop outranks every steer: no follow-up prompt goes out,
          // and what never reached the model is handed back on settle
          steering.userStop = true;
          if (sessionId) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
          else stop();
          if (interruptTimer) clearTimeout(interruptTimer);
          interruptTimer = setTimeout(() => settle(true, "cancelled"), 5_000);
          interruptTimer.unref?.();
        };
        active.set(threadId, { stop, interrupt, turnId, asks, steer: steerTurn });
        emit({ ...base(threadId, turnId), type: "turn.started" });

        (async () => {
          try {
            const init = await request(
              "initialize",
              { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
              INIT_TIMEOUT,
            );
            // the steering extension advertises itself beside agentCapabilities
            steering.native = init?._meta?.steering?.supported === true;
            const methods: Array<{ id?: string }> = Array.isArray(init?.authMethods) ? init.authMethods : [];
            const methodId = support.pickAuthMethod(methods);
            if (!skipSubscriptionAuthForLocalInject(turn.model)) {
              if (methodId) {
                try {
                  await request("authenticate", { methodId }, INIT_TIMEOUT);
                } catch {
                  if (support.authFailure === "fail") throw new Error(support.loginNote);
                  // else: proceed on an ambient login
                }
              } else if (support.authFailure === "fail") {
                throw new Error(support.loginNote);
              }
            }

            const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            let sessionResult: any = null;
            if (cursor) {
              try {
                sessionResult = await request(
                  "session/load",
                  { sessionId: cursor, cwd, mcpServers },
                  LOAD_SESSION_TIMEOUT,
                );
                sessionId = cursor;
              } catch {
                /* session gone, load unsupported, or too slow — start fresh */
              }
            }
            if (!sessionId) {
              sessionResult = await request("session/new", { cwd, mcpServers }, NEW_SESSION_TIMEOUT);
              sessionId = typeof sessionResult?.sessionId === "string" ? sessionResult.sessionId : null;
              if (!sessionId) throw new Error(t("session/new returned no sessionId"));
            }
            let selectedModel: string | null = null;
            let sessionStarted = false;
            const emitSessionStarted = () => {
              if (sessionStarted) return;
              sessionStarted = true;
              emit({
                ...base(threadId, turnId),
                type: "session.started",
                sessionId,
                model: selectedModel ?? init?._meta?.modelState?.currentModelId ?? cliTurn.model ?? null,
              });
            };

            try {
              if (support.selectModel) {
                const { configId } = support.selectModel;
                const currentOf = (r: any) =>
                  (Array.isArray(r?.configOptions) ? r.configOptions : []).find((o: any) => o?.id === configId)
                    ?.currentValue ?? null;
                selectedModel = currentOf(sessionResult);
                if (cliTurn.model && cliTurn.model !== selectedModel) {
                  selectedModel = currentOf(
                    await request(
                      "session/set_config_option",
                      { sessionId, configId, value: cliTurn.model },
                      INIT_TIMEOUT,
                    ),
                  );
                  // an agent that answers OK but keeps its old model is worse than
                  // one that errors: it burns a paid turn on the wrong thing
                  if (selectedModel !== cliTurn.model) {
                    throw new Error(
                      t("{engine} did not switch to {model} (still {current})", { engine: DRIVER_KIND, model: cliTurn.model, current: selectedModel ?? t("unknown") }),
                    );
                  }
                }
              }

              if (support.configureSession) {
                await support.configureSession({
                  request: (method, params, timeoutMs) =>
                    request(method, params, timeoutMs ?? SESSION_CONFIG_TIMEOUT),
                  sessionId,
                  config,
                  turn: cliTurn,
                  sessionModels: Array.isArray(sessionResult?.models?.availableModels)
                    ? sessionResult.models.availableModels
                    : [],
                });
                // initialize's currentModelId is the CLI default (grok-4.6),
                // not the model this turn asked for. After a successful pin,
                // report the slug we set so the UI does not claim otherwise.
                if (!selectedModel && cliTurn.model) selectedModel = cliTurn.model;
              }
            } catch (error) {
              // session.started is the only place the resume cursor is recorded,
              // so a rejected setting must not orphan a session we just created.
              emitSessionStarted();
              throw error;
            }
            emitSessionStarted();
            // a Stop during setup: nothing has been asked, so nothing runs
            if (steering.userStop) {
              settle(true, "cancelled");
              return;
            }
            state.promptSent = true;
            // messages sent during setup (session/load included) join the
            // first prompt — the model has not started, so nothing to continue
            steering.carried = steering.pending.splice(0);
            const firstTurn = steering.carried.length
              ? { ...turn, text: withEarlySteers(turn.text, steering.carried) }
              : turn;
            let text = support.buildPromptText
              ? support.buildPromptText(firstTurn)
              : firstTurn.system
                ? `${firstTurn.system}\n\n${firstTurn.text}`
                : firstTurn.text;
            const used = { input: 0, output: 0 };
            for (;;) {
              steering.prompting = true;
              steering.held = false;
              let result: any = null;
              let failure: unknown = null;
              try {
                result = await request("session/prompt", {
                  sessionId,
                  prompt: [{ type: "text", text }],
                });
              } catch (error) {
                failure = error ?? new Error("session/prompt failed");
              }
              steering.prompting = false;
              runningTools.clear();
              // a native steer still in flight decides whether this prompt
              // was the last one: wait for its answer (bounded by its timeout)
              if (steering.inFlight.size && !state.settled) {
                await new Promise<void>((resolve) => {
                  steering.onIdle = resolve;
                });
                steering.onIdle = null;
              }
              if (state.settled) return;
              const ourCancel = steering.cancelSent;
              steering.cancelSent = false;
              const reason = result?.stopReason;
              // continue in this same turn when messages are waiting and the
              // prompt ended cleanly — on its own, or by our boundary cancel
              // (an agent may answer that cancel with an error instead)
              const continueWithSteers =
                !steering.userStop &&
                steering.pending.length > 0 &&
                (failure ? ourCancel : reason === "end_turn" || reason === "cancelled");
              if (failure && !continueWithSteers) {
                // the prompt that carried them never ran: hand them back
                steering.pending.unshift(...steering.carried);
                steering.carried = [];
                throw failure;
              }
              steering.carried = [];
              // opencode 1.18.18 reports usage at the result root; grok and
              // gemini put it under _meta. Read both rather than lose the count.
              // A steered turn spans several prompts: report the running sum.
              const usage = result?.usage ?? result?._meta ?? {};
              if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
                used.input += usage.inputTokens ?? 0;
                used.output += usage.outputTokens ?? 0;
                emit({
                  ...base(threadId, turnId),
                  type: "thread.token-usage.updated",
                  input: used.input,
                  output: used.output,
                });
              }
              if (continueWithSteers) {
                flushAssistantText();
                steering.carried = steering.pending.splice(0);
                text = steerContinuationPrompt(steering.carried);
                continue;
              }
              if (reason === "end_turn") settle(true, null);
              else if (reason === "cancelled") settle(true, "cancelled");
              else {
                const errorMessage = typeof result?.error === "string" && result.error
                  ? result.error
                  : typeof result?.message === "string" && result.message
                    ? result.message
                    : t("Model turn failed: {reason}", { reason: reason ?? t("unknown error") });
                emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: errorMessage,
                });
                settle(false, reason ?? "failed");
              }
              return;
            }
          } catch (e) {
            if (!state.settled) {
              const message = e instanceof Error ? e.message : String(e);
              const code = support.classifyError?.(e);
              // Authentication setup is a user action, not a retry. The
              // classifier is preferred; loginNote remains a compatibility
              // fallback for existing ACP supports.
              const needsAuth = code === "invalid_credentials" || code === "inactive_subscription"
                || message === support.loginNote;
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message,
                ...(needsAuth ? { setup: true } : {}),
              });
              settle(false, needsAuth ? "auth_required" : "rpc_error");
            }
          }
        })();

        return { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        const version = await new Promise<string | null>((resolve) => {
          execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
            resolve(err ? null : stdout.trim()),
          );
        });
        if (!version) return { state: "unavailable", reason: t("`{cli}` CLI not found", { cli: config.cli }) };
        return { state: "available", version, authenticated: await support.isAuthenticated(env, config) };
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        get models() {
          return models;
        },
        refreshModels: support.resolveModels ? refreshModels : undefined,
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: {
            sessionModelSwitch: "unsupported",
            agentsMcp: true,
            computerMcp: true,
            composioMcp: true,
            browserMcp: true,
            images: support.images !== false,
            effortLevels: support.effortLevels,
            localComputerMcp: !config.fullAuto,
            // natively where the agent advertises _session/steering,
            // otherwise at the next safe boundary inside the same turn
            queueing: true,
          },
          sendTurn,
          steer: async (threadId, text, options) => active.get(threadId)?.steer(text, options?.steerId) ?? false,
          interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) return "unavailable"; // settled, timed out, or turn gone
            finish(decision.behavior === "allow" ? "allow" : "deny", "user");
            return decision.behavior === "allow" ? "allowed-once" : "rejected";
          },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { stop } of active.values()) stop();
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          for (const { stop } of active.values()) stop();
          listeners.clear();
        },
      };
    },
  };
}
