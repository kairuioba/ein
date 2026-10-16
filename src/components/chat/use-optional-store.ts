import { useStore } from "@/state/store";

/** The app store, or null where a card renders on its own (static markup in
 * tests, previews). useStore always reads its context first, so the hook
 * order is the same either way; only the "outside provider" error is caught. */
export function useOptionalStore(): ReturnType<typeof useStore> | null {
  try {
    return useStore();
  } catch {
    return null;
  }
}
