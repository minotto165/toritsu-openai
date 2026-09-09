import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const SESSION_API_URL =
  "https://ai-api.metro.tokyo.lg.jp/api/v1/chat/message";
const SESSION_STATUS_URL =
  "https://ai-api.metro.tokyo.lg.jp/api/v1/chat/tool/status";
const CONFIG_DIR = join(homedir(), ".config", "toritsu-openai");
const SESSION_FILE = join(CONFIG_DIR, "session");

/** セッショントークンを読む（env優先、なければ0600ファイル）。値は返却のみで出力しない */
export function loadSessionToken(): string {
  const env = process.env.TORITSU_SESSION;
  if (env !== undefined && env.trim() !== "") {
    return env.trim();
  }
  try {
    return readFileSync(SESSION_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

/** セッショントークンを0600で保存する */
export function saveSessionToken(token: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_FILE, `${token.trim()}\n`, { mode: 0o600 });
}

/** TORITSU_MODEL を解決する。"10"（高速）/"13"（推論）のみ有効、それ以外はnull */
export function resolveSessionModel(): string | null {
  const m = (process.env.TORITSU_MODEL ?? "").trim();
  return m === "10" || m === "13" ? m : null;
}

/** tool/status へのGETでセッション有効性を確認する（クォータ非消費） */
export async function checkSession(token: string): Promise<boolean> {
  try {
    const res = await fetch(SESSION_STATUS_URL, {
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
    throw new Error("invalid session response");
  }
  const record = data as Record<string, unknown>;
  const msg = record.message as { content?: unknown } | undefined;
  const content = msg !== undefined && typeof msg.content === "string" ? msg.content : "";
  const hid = typeof record.id === "string" ? record.id : "";
  return { content, hid };
}

/**
 * セッションEndpointへ送信する。ボディはWebUIと同一のmultipart形式。
 * 公開Endpointと異なり {input, conversation_id} ではなく
 * message[content]/id/is_stream/model/tool_choice を送る。
 */
export async function sendSessionMessage(opts: {
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
    res = await fetch(SESSION_API_URL, {
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
    throw new Error("upstream unreachable");
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("session expired — run with --login to re-authenticate");
    }
    throw new Error(`session upstream error: ${res.status}`);
  }
  const data = (await res.json().catch(() => null)) as unknown;
  return adaptSessionResponse(data);
}
