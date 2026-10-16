// Connected-app names for the org editor and the Bot settings panel: the
// catalog gives each slug its label, the account inventory says which ones
// are connected. Both are read once per session and shared.
import { useEffect, useState } from "react";
import { preloadConnectedApps } from "@/components/PluginsPanel";

export interface AppEntry {
  slug: string;
  label: string;
  connected: boolean;
}

let catalog: Promise<Array<{ slug: string; label: string }>> | null = null;

function loadCatalog(): Promise<Array<{ slug: string; label: string }>> {
  catalog ??= fetch("/api/connectors/catalog")
    .then((res) => (res.ok ? res.json() : { cards: [] }))
    .then((body: { cards?: Array<{ slug: string; label: string }> }) => body.cards ?? [])
    .catch(() => {
      catalog = null;
      return [];
    });
  return catalog;
}

/** Every app the catalog knows, connected ones first. */
export function useAppCatalog(): { apps: AppEntry[]; labelOf: (slug: string) => string; connected: AppEntry[] } {
  const [apps, setApps] = useState<AppEntry[]>([]);
  useEffect(() => {
    let alive = true;
    void Promise.all([loadCatalog(), preloadConnectedApps().catch(() => ({ services: {} as Record<string, { connected: boolean }> }))]).then(
      ([cards, inventory]) => {
        if (!alive) return;
        const services = inventory.services as Record<string, { connected?: boolean }>;
        const known = new Set(cards.map((card) => card.slug));
        const entries: AppEntry[] = cards.map((card) => ({ slug: card.slug, label: card.label, connected: services[card.slug]?.connected === true }));
        // a connected service the catalog does not list still counts
        for (const [slug, status] of Object.entries(services)) {
          if (!known.has(slug) && status?.connected) entries.push({ slug, label: prettySlug(slug), connected: true });
        }
        entries.sort((a, b) => Number(b.connected) - Number(a.connected));
        setApps(entries);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  const labelOf = (slug: string) => apps.find((app) => app.slug === slug)?.label ?? prettySlug(slug);
  return { apps, labelOf, connected: apps.filter((app) => app.connected) };
}

export function prettySlug(slug: string): string {
  return slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
