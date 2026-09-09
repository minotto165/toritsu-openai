import type { ChatCompletion, ChatMessage } from "./translate";

/** ハンドラ間で受け渡す正規化済みリクエスト */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  conversationId: string;
}

export function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function invalidRequest(message: string): Response {
  return json({ error: { message, type: "invalid_request_error" } }, 400);
}

export class UpstreamError extends Error {
  status: number;
  errType: string;
  code?: number;
  constructor(status: number, message: string, errType: string, code?: number) {
    super(message);
    this.status = status;
    this.errType = errType;
    this.code = code;
  }
}

export function toErrorJson(err: UpstreamError): Response {
  const e: { message: string; type: string; code?: number } = {
    message: err.message,
    type: err.errType,
  };
  if (err.code !== undefined) {
    e.code = err.code;
  }
  return json({ error: e }, err.status);
}

/**
 * 疑似SSE：上流は一括応答のみのため、全文をチャンク分割して
 * OpenAI形式の chat.completion.chunk ストリームとして返す。
 * tool_calls の場合は構造化deltaとして1発で流す。
 */
export function toSSE(completion: ChatCompletion): Response {
  const choice = completion.choices[0];
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };
  let body = "";
  const toolCalls = choice?.message.tool_calls;
  if (toolCalls !== undefined && toolCalls.length > 0) {
    body += `data: ${JSON.stringify({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: null, tool_calls: toolCalls },
          finish_reason: null,
        },
      ],
    })}\n\n`;
    body += `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\n`;
    body += "data: [DONE]\n\n";
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
  const content = choice?.message.content ?? "";
  const SIZE = 60;
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += SIZE) {
    chunks.push(content.slice(i, i + SIZE));
  }
  if (chunks.length === 0) {
    chunks.push("");
  }
  for (const text of chunks) {
    body += `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}\n\n`;
  }
  body += `data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`;
  body += "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
