// 通常チャットハンドラ
import { json, toSSE, type ChatRequest } from "../infra/http";
import { toToritsuInput, toChatCompletion, selectMessages } from "../text/translate";
import { sendUpstream } from "../upstream/sender";
import { debugRecord } from "../infra/debug";
import { UpstreamError } from "../infra/http";
import { forgetSession, isContentLimitError, isStaleSessionError, recordSession } from "../infra/sessionmap";

// 通常チャットハンドラ
/** 畳んで送信しOpenAI形式で返す */
export async function handleChat(req: ChatRequest): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const input = toToritsuInput(selectMessages(req.messages, req.conversationId, req.sentCount ?? 0));
    const r = await sendUpstream(req, input);
    recordSession(
      { keyId: req.keyId, model: req.model, messages: req.messages, tools: [] },
      r.cid,
    );
    const completion = toChatCompletion(req.model, {
      message: r.text,
      response: { conversation: { id: r.cid } },
    });
    completion.usage = r.usage;
    return req.stream ? toSSE(completion) : json(completion, 200);
  };
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
      return await attempt();
    }
    throw err;
  }
}
