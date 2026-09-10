import { SYSTEM_FORMAT } from "../infra/config";
import { json, toSSE, type ChatRequest } from "../infra/http";
import { toToritsuInput, toChatCompletion, selectMessages } from "../text/translate";
import { sendUpstream } from "../upstream/sender";

/** 通常チャット：入力を畳んで送信し、OpenAI形式で返す */
export async function handleChat(req: ChatRequest): Promise<Response> {
  const input = toToritsuInput(selectMessages(req.messages, req.conversationId), SYSTEM_FORMAT);
  const r = await sendUpstream(req, input);
  const completion = toChatCompletion(req.model, {
    message: r.text,
    response: { conversation: { id: r.cid } },
  });
  completion.usage = r.usage;
  return req.stream ? toSSE(completion) : json(completion, 200);
}
