export const TRANSCRIPTION_STATUS_EVENT = "ein:transcription-status";

declare global {
  interface WindowEventMap {
    "ein:transcription-status": CustomEvent<{ configured: boolean }>;
  }
}

export function announceTranscriptionStatus(configured: boolean) {
  window.dispatchEvent(new CustomEvent(TRANSCRIPTION_STATUS_EVENT, { detail: { configured } }));
}
