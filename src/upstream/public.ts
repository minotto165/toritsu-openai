import { TORITSU_API_URL, KEY_FILE, getApiKey } from "../infra/config";
import { UpstreamError } from "../infra/http";
import { debugRecord } from "../infra/debug";
import { upstreamErrorMessage, type ToritsuResponse } from "../text/translate";

export interface PublicResult {
  data: ToritsuResponse;
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
  debugRecord("public_upstream", { input, status: upstream.status, body: data });
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
