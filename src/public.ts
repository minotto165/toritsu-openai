import { TORITSU_API_URL, KEY_FILE, SYSTEM_FORMAT, getApiKey } from "./config";
import { json, toSSE, UpstreamError, type ChatRequest } from "./http";
import {
  toToritsuInput,
  toChatCompletion,
  upstreamErrorMessage,
} from "./translate";

export interface PublicResult {
  data: Parameters<typeof toChatCompletion>[1];
  message: string;
  conversationId: string;
}

/** 公開Endpointへの送信を1往復する。失敗時は UpstreamError を投げる */
export async function callPublicUpstream(
  input: string,
  cid: string,
  apiKey: string,
): Promise<PublicResult> {
  let upstream: Response;
  try {
    upstream = await fetch(TORITSU_API_URL, {
      method: "POST",
      headers: {
        // 上流は Accept-Encoding なしのリクエストを401で拒否するため必須
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      // 上流は {input, conversation_id} 以外のトップレベル field を401で拒否するため厳密にこの2つのみ送る
      body: JSON.stringify({ input, conversation_id: cid }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new UpstreamError(502, "upstream unreachable", "upstream_unreachable");
  }
  const data = (await upstream.json().catch(() => null)) as PublicResult["data"] | null;
  if (!upstream.ok) {
    if (upstream.status === 401 && KEY_FILE) {
      console.error(`[toritsu-openai] 401 from upstream - key may be expired, refresh ${KEY_FILE}`);
    }
    throw new UpstreamError(
      upstream.status,
      upstreamErrorMessage(data),
      "toritsu_api_error",
      upstream.status,
    );
  }
  if (data === null) {
    throw new UpstreamError(502, "invalid upstream response", "toritsu_api_error");
  }
  const msg = typeof data.message === "string" ? data.message : "";
  const id = data.response?.conversation?.id;
  return { data, message: msg, conversationId: typeof id === "string" ? id : "" };
}

/** 通常チャット：公開Endpointにそのまま中継する */
export async function handlePublicChat(req: ChatRequest): Promise<Response> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new UpstreamError(
      500,
      "TORITSU_API_KEY or TORITSU_KEY_FILE is not set",
      "server_error",
    );
  }
  const input = toToritsuInput(req.messages, SYSTEM_FORMAT);
  const pub = await callPublicUpstream(input, req.conversationId, apiKey);
  const completion = toChatCompletion(req.model, pub.data);
  return req.stream ? toSSE(completion) : json(completion, 200);
}
