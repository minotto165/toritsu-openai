// WebUI Endpointへの送信とセッション管理
import { writeFileSync } from "node:fs";
import { SESSION_FILE, ensureConfigDir, readSessionFile } from "../infra/config";
import { UpstreamError } from "../infra/http";
import { debugRecord } from "../infra/debug";


export const WEBUI_API_URL =
  "https://ai-api.metro.tokyo.lg.jp/api/v1/chat/message";
const WEBUI_STATUS_URL =
  "https://ai-api.metro.tokyo.lg.jp/api/v1/chat/tool/status";

// WebUI Endpointへの送信とセッション管理
/** トークン読込（env優先・0600ファイル） */
export function loadSessionToken(): string {
  const env = process.env.TORITSU_SESSION;
  if (env !== undefined && env.trim() !== "") {
    return env.trim();
  }
  return readSessionFile();
}

/** トークンを0600保存 */
export function saveSessionToken(token: string): void {
  ensureConfigDir();
  writeFileSync(SESSION_FILE, `${token.trim()}\n`, { mode: 0o600 });
}

/** モデル名→WebUI ID */
export const WEBUI_MODELS = {
  "toritsu-fast": "10",
  "toritsu-reasoning": "13",
} as const;

/** セッション有効性確認（無償） */
export async function checkSession(token: string): Promise<boolean> {
  try {
    const res = await fetch(WEBUI_STATUS_URL, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface SessionResult {
  content: string;
  hid: string;
}

export function adaptSessionResponse(data: unknown): SessionResult {
  if (data === null || typeof data !== "object") {
    throw new UpstreamError(502, "invalid session response", "toritsu_api_error");
  }
  const record = data as Record<string, unknown>;
  const msg = record.message as { content?: unknown } | undefined;
  const content = msg !== undefined && typeof msg.content === "string" ? msg.content : "";
  const hid = typeof record.id === "string" ? record.id : "";
  return { content, hid };
}

/** WebUI Endpointへ送信（multipart形式） */
export async function sendWebuiMessage(opts: {
  input: string;
  hid: string;
  model: string;
  token: string;
}): Promise<SessionResult> {
  const form = new FormData();
  if (opts.hid !== "") {
    form.append("id", opts.hid);
  }
  form.append("message[content]", opts.input);
  form.append("is_stream", "0");
  form.append("model", opts.model);
  form.append("tool_choice", "1");
  let res: Response;
  try {
    res = await fetch(WEBUI_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        Authorization: `Bearer ${opts.token}`,
      },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new UpstreamError(502, "upstream unreachable", "upstream_unreachable");
  }
  if (!res.ok) {
    if (res.status === 401) {
      console.error("[toritsu-openai] session expired — run with --login");
      throw new UpstreamError(
        401,
        "session expired — run with --login to re-authenticate",
        "authentication_error",
      );
    }
    const bodyText = (await res.text().catch(() => "")).slice(0, 300);
    throw new UpstreamError(
      res.status,
      bodyText !== "" ? bodyText : `session upstream error: ${res.status}`,
      "toritsu_api_error",
      res.status,
    );
  }
  const data = (await res.json().catch(() => null)) as unknown;
  return adaptSessionResponse(data);
}
