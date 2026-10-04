// 通常チャットハンドラ
import { json, toSSE, type ChatRequest } from "../infra/http";
import { toToritsuInput, toChatCompletion, selectMessages } from "../text/translate";
import { sendUpstream } from "../upstream/sender";
import { recordSession } from "../infra/sessionmap";
import { withSessionRetry } from "../infra/session_retry";

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
  return withSessionRetry(req, attempt);
}
