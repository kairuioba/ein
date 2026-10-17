// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import { findCliCandidates } from "../env-path.ts";
import { t } from "../../shared/i18n.ts";
import type {
  AnyProviderDriver,
  InstanceConfigMap,
  InstanceId,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";

export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  /** Raw `config.cli` from disk — an override exists only if this is set. */
  cli: string | undefined;
  shadow: true;
  reason: string;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

/** The `cli` field off a driver's default config, when it has one — the
 * placeholder an override input shows when nothing is set. */
function cliDefaultOf(driver: AnyProviderDriver | undefined): string | undefined {
  if (!driver) return undefined;
  try {
    const cfg = driver.defaultConfig() as { cli?: unknown };
    return typeof cfg?.cli === "string" ? cfg.cli : undefined;
  } catch {
    return undefined;
  }
}

/** Raw `config.cli` straight from disk — shadow snapshots can't decode, so
 * this is the only faithful way to echo back what was configured. */
function cliOfRaw(raw: unknown): string | undefined {
  const cli = (raw as { cli?: unknown } | undefined)?.cli;
  return typeof cli === "string" && cli ? cli : undefined;
}

/** Key order never matters to a driver, so it must not matter here either:
 * an entry rebuilt from the same settings has to compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Everything a driver is created from. Two entries with the same key build
 * the same instance, so a settings save that leaves it alone must not touch
 * the running instance (or the turns on it). */
function entryKey(entry: InstanceConfigMap[string]): string {
  return stableJson({
    driver: entry.driver,
    displayName: entry.displayName,
    enabled: entry.enabled,
    config: entry.config,
    environment: entry.environment,
  });
}

export interface ReconcileResult {
  /** Instances torn down because their entry changed or disappeared — any
   * turn that was running on one of them ended with it. */
  replaced: InstanceId[];
  /** Live instances created by this pass (new or rebuilt), to attach to the bus. */
  created: ProviderInstance[];
}

export class ProviderRegistry {
  private byId = new Map<InstanceId, RegistryEntry>();
  /** decoded per-instance `cli` overrides, for describe() — drivers spawn
   * from their own config; this map only reports what was configured */
  private cliByInstance = new Map<InstanceId, string>();
  /** the entry each instance was built from (see entryKey) */
  private keyById = new Map<InstanceId, string>();
  private driversByKind: Map<string, AnyProviderDriver>;

  constructor(drivers: readonly AnyProviderDriver[]) {
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
  }

  async load(configs: InstanceConfigMap) {
    for (const [instanceId, entry] of Object.entries(configs)) {
      await this.loadEntry(instanceId, entry);
    }
  }

  /** Bring the fleet in line with a new instance map, rebuilding only the
   * instances whose entry actually changed. A save that touches nothing a
   * driver reads (dispatch strategy, language, spend display…) leaves every
   * instance — and every turn running on it — exactly as it was. */
  async reconcile(configs: InstanceConfigMap): Promise<ReconcileResult> {
    const next = Object.entries(configs);
    const replaced = this.changedInstances(configs);
    await Promise.allSettled(replaced.map((instanceId) => this.byId.get(instanceId)?.live?.dispose()));
    for (const instanceId of replaced) {
      this.byId.delete(instanceId);
      this.cliByInstance.delete(instanceId);
      this.keyById.delete(instanceId);
    }
    const created: ProviderInstance[] = [];
    for (const [instanceId, entry] of next) {
      if (this.byId.has(instanceId)) continue;
      const live = await this.loadEntry(instanceId, entry);
      if (live) created.push(live);
    }
    // keep the configured order: describe() rows (and the picker) follow it
    this.byId = new Map(next.flatMap(([instanceId]) => {
      const registered = this.byId.get(instanceId);
      return registered ? [[instanceId, registered] as const] : [];
    }));
    return { replaced, created };
  }

  /** The registered instances a reconcile to `configs` would tear down:
   * entries that changed, and entries that are gone. */
  changedInstances(configs: InstanceConfigMap): InstanceId[] {
    return [...this.byId.keys()].filter((instanceId) => {
      const entry = Object.hasOwn(configs, instanceId) ? configs[instanceId] : undefined;
      return !entry || this.keyById.get(instanceId) !== entryKey(entry);
    });
  }

  private async loadEntry(instanceId: InstanceId, entry: InstanceConfigMap[string]): Promise<ProviderInstance | null> {
    this.keyById.set(instanceId, entryKey(entry));
    const driver = this.driversByKind.get(entry.driver);
    if (!driver) {
      this.byId.set(instanceId, {
        instanceId,
        shadow: {
          instanceId,
          driverKind: entry.driver,
          displayName: entry.displayName,
          cli: cliOfRaw(entry.config),
          shadow: true,
          reason: t('unknown driver "{driver}" — kept as configured, unavailable here', { driver: String(entry.driver) }),
        },
      });
      return null;
    }
    try {
      const config = entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);
      // Override detection is on the RAW config, never the decoded one:
      // decodeConfig fills in the driver default ("claude", "codex", …),
      // so reading `cli` there would flag every instance as overridden.
      const rawCli = cliOfRaw(entry.config);
      if (rawCli) this.cliByInstance.set(instanceId, rawCli);
      const live = await driver.create({
        instanceId,
        displayName: entry.displayName ?? driver.metadata.displayName,
        environment: entry.environment ?? {},
        enabled: entry.enabled ?? true,
        config,
      });
      this.byId.set(instanceId, { instanceId, live });
      return live;
    } catch (e) {
      this.byId.set(instanceId, {
        instanceId,
        shadow: {
          instanceId,
          driverKind: entry.driver,
          displayName: entry.displayName ?? driver.metadata.displayName,
          cli: cliOfRaw(entry.config),
          shadow: true,
          reason: e instanceof Error ? e.message : String(e),
        },
      });
      return null;
    }
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.byId.get(instanceId)?.live ?? null;
  }

  entries(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  instances(): ProviderInstance[] {
    return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
  }

  /** instance snapshots for the model picker: id, driver, models, health */
  async describe() {
    // Multiple instances may share a driver. Scan each default binary once
    // per response instead of repeating filesystem work for every row.
    const candidatesByName = new Map<string, string[]>();
    const candidatesFor = (driver: AnyProviderDriver | undefined): string[] => {
      const name = cliDefaultOf(driver);
      if (!name) return [];
      const cached = candidatesByName.get(name);
      if (cached) return cached;
      const found = findCliCandidates(name);
      candidatesByName.set(name, found);
      return found;
    };
    return Promise.all(
      this.entries().map(async (entry) => {
        const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
        if (entry.shadow) {
          return {
            instanceId: entry.instanceId,
            driverKind: entry.shadow.driverKind,
            displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
            snapshot: { state: "unavailable", reason: entry.shadow.reason } satisfies ProviderSnapshot,
            models: { default: "", options: [] },
            capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false },
            // an unknown driver has no driver record, hence no install path
            access: driver?.metadata.access ?? "subscription",
            install: driver?.install,
            cli: entry.shadow.cli,
            cliDefault: cliDefaultOf(driver),
            // a shadow is exactly the "your CLI is broken, pick another"
            // case where the detected-path dropdown matters most
            cliCandidates: candidatesFor(driver),
          };
        }
        const inst = entry.live;
        let snapshot: ProviderSnapshot;
        try {
          await inst.refreshModels?.();
          snapshot = await inst.snapshot();
        } catch (e) {
          snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
        }
        return {
          instanceId: inst.instanceId,
          driverKind: inst.driverKind,
          displayName: inst.displayName ?? inst.driverKind,
          snapshot,
          models: inst.models,
          capabilities: {
            computerMcp: inst.adapter.capabilities.computerMcp === true,
            agentsMcp: inst.adapter.capabilities.agentsMcp === true,
            composioMcp: inst.adapter.capabilities.composioMcp === true,
            phoneMcp: inst.adapter.capabilities.phoneMcp === true,
            browserMcp: inst.adapter.capabilities.browserMcp === true,
            images: inst.adapter.capabilities.images === true,
            effortLevels: inst.adapter.capabilities.effortLevels,
            queueing: inst.adapter.capabilities.queueing === true,
            localComputerMcp: inst.adapter.capabilities.localComputerMcp === true,
            approvalReview: inst.reviewPermission !== undefined,
          },
          access: driver?.metadata.access ?? "subscription",
          install: driver?.install,
          cli: this.cliByInstance.get(inst.instanceId),
          cliDefault: cliDefaultOf(driver),
          // every copy of the driver's default binary on the augmented PATH —
          // the dropdown's "detected" entries. Snapshotted per describe() so a
          // newly installed CLI shows up on the next refresh.
          cliCandidates: candidatesFor(driver),
        };
      }),
    );
  }

  async disposeAll() {
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
    this.cliByInstance.clear();
    this.keyById.clear();
  }
}
