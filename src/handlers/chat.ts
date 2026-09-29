// 通常チャットハンドラ
import { json, toSSE, type ChatRequest } from "../infra/http";
import { toToritsuInput, toChatCompletion, selectMessages } from "../text/translate";
import { sendUpstream } from "../upstream/sender";
import { forgetSession, isContentLimitError, isStaleSessionError, recordSession } from "../infra/sessionmap";

// 通常チャットハンドラ
/** 畳んで送信しOpenAI形式で返す */
export async function handleChat(req: ChatRequest): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const input = toToritsuInput(selectMessages(req.messages, req.conversationId));
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
    // 対応表のcidが失効していたら捨てて全文で再送1回
    // 上流蓄積の上限超過 (422) は対応表の有無に関わらず新規セッションで再送
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
