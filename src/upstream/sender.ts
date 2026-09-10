import { getApiKey } from "../infra/config";
import { UpstreamError, type ChatRequest } from "../infra/http";
import { callPublicUpstream } from "./public";
import { loadSessionToken, sendWebuiMessage, WEBUI_MODELS } from "./webui";

export interface SendResult {
  text: string;
  cid: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const ZERO_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

/**
 * モデル名で送信先を決めて1往復する。
 * webuiモデルはセッションEndpoint、それ以外は公開Endpoint。
 * 失敗時は UpstreamError を投げる。
 */
export async function sendUpstream(
  req: Pick<ChatRequest, "model" | "conversationId">,
  input: string,
): Promise<SendResult> {
  const webuiModel = WEBUI_MODELS[req.model as keyof typeof WEBUI_MODELS];
  if (webuiModel !== undefined) {
    const token = loadSessionToken();
    if (token === "") {
      throw new UpstreamError(500, "session mode requires login — run with --login", "server_error");
    }
    const r = await sendWebuiMessage({ input, hid: req.conversationId, model: webuiModel, token });
    return { text: r.content, cid: r.hid, usage: ZERO_USAGE };
  }
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new UpstreamError(
      500,
      "TORITSU_API_KEY or TORITSU_KEY_FILE is not set",
      "server_error",
    );
  }
  const r = await callPublicUpstream(input, req.conversationId, apiKey);
  const u = r.data.response?.usage;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    text: r.message,
    cid: r.conversationId,
    usage: {
      prompt_tokens: num(u?.input_tokens),
      completion_tokens: num(u?.output_tokens),
      total_tokens: num(u?.total_tokens),
    },
  };
}
