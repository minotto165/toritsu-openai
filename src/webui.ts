import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SYSTEM_FORMAT } from "./config";
import { json, toSSE, UpstreamError, type ChatRequest } from "./http";
import { toToritsuInput, toChatCompletion } from "./translate";

export const WEBUI_API_URL =
  "https://ai-api.metro.tokyo.lg.jp/api/v1/chat/message";
const WEBUI_STATUS_URL =
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

/** モデル名 → WebUIのモデルID。ここにない名前は通常チャット扱い */
export const WEBUI_MODELS = {
  "toritsu-fast": "10",
  "toritsu-reasoning": "13",
} as const;

/** tool/status へのGETでセッション有効性を確認する（クォータ非消費） */
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

/** セッションチャット：WebUIと同じWebUI Endpointを使う */
export async function handleWebuiChat(
  req: ChatRequest,
  sessionModel: string,
): Promise<Response> {
  const token = loadSessionToken();
  if (token === "") {
    throw new UpstreamError(500, "session mode requires login — run with --login", "server_error");
  }
  try {
    const result = await sendWebuiMessage({
      input: toToritsuInput(req.messages, SYSTEM_FORMAT),
      hid: req.conversationId,
      model: sessionModel,
      token,
    });
    const completion = toChatCompletion(req.model, {
      message: result.content,
      response: { conversation: { id: result.hid } },
    });
    return req.stream ? toSSE(completion) : json(completion, 200);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("session expired")) {
      console.error("[toritsu-openai] session expired — run with --login");
      throw new UpstreamError(401, err.message, "authentication_error");
    }
    throw err;
  }
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
 * WebUI Endpointへ送信する。ボディはWebUIと同一のmultipart形式。
 * 公開Endpointと異なり {input, conversation_id} ではなく
 * message[content]/id/is_stream/model/tool_choice を送る。
 */
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
