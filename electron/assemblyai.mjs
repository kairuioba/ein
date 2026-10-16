// AssemblyAI's permanent credential stays in Electron's encrypted main
// process store. The renderer receives only a short-lived, single-use token
// for one browser WebSocket session.
import { t } from "./i18n.cjs";

const TOKEN_ENDPOINT = "https://streaming.assemblyai.com/v3/token";

export function assemblyAICredential(credentials, env = process.env) {
  const stored = String(credentials?.assemblyAiApiKey ?? "").trim();
  if (stored) return stored;
  return String(env.ASSEMBLYAI_API_KEY ?? "").trim();
}

export async function mintAssemblyAIStreamingToken(
  apiKey,
  { fetchImpl = fetch, expiresInSeconds = 480 } = {},
) {
  const secret = String(apiKey ?? "").trim();
  if (!secret) throw new Error(t("Add an AssemblyAI API key before recording."));
  const lifetime = Math.max(1, Math.min(600, Math.round(expiresInSeconds)));
  let response;
  try {
    response = await fetchImpl(`${TOKEN_ENDPOINT}?expires_in_seconds=${lifetime}`, {
      headers: { authorization: secret },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(t("Could not reach AssemblyAI. Check your connection and try again."));
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(t("AssemblyAI rejected this API key. Replace it in Transcription settings."));
    }
    throw new Error(t("Could not start cloud transcription (HTTP {status}).", { status: response.status }));
  }
  const token = String(body?.token ?? "").trim();
  if (!token) throw new Error(t("AssemblyAI returned an invalid temporary token."));
  return { token, expiresInSeconds: lifetime };
}
