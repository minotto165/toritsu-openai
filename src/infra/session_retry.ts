// セッション継続の再送共通化 (stale失効・422上限超過で新規セッション1回再送)
import { debugRecord } from "./debug";
import { UpstreamError, type ChatRequest } from "./http";
import { forgetSession, isContentLimitError, isStaleSessionError } from "./sessionmap";

export async function withSessionRetry<T>(
  req: ChatRequest,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    debugRecord("agent_upstream_error", {
      message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      status: err instanceof UpstreamError ? err.status : null,
    });
    // 対応表のcidが失効していたら捨てて全文で再送1回
    // 上流蓄積の上限超過 (422) は新規セッションで再送
    if (
      (req.resolvedSession === true && isStaleSessionError(err)) ||
      isContentLimitError(err)
    ) {
      forgetSession(req.conversationId);
      req.conversationId = "";
      req.resolvedSession = false;
      req.sentCount = 0;
      return await attempt();
    }
    throw err;
  }
}
