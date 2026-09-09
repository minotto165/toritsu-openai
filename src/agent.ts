// エージェントモード：モデル名 toritsu-agent で有効。
// クライアントの tools 定義をテキスト指示に変換し、モデルが出した
// tool_calls JSON をそのままクライアントに返す「翻訳者」方式。
// 実行はクライアント側（pi等）が担い、プロキシは実行しない。
import { SYSTEM_FORMAT, getApiKey } from "./config";
import { json, toSSE, UpstreamError, type ChatRequest } from "./http";
import { callPublicUpstream } from "./public";
import {
  toToritsuInput,
  toChatCompletion,
  parseAssistantOutput,
} from "./translate";

export const AGENT_MODEL = "toritsu-agent";

/** クライアントの tools 定義をそのまま埋め込んだ指示文を作る */
export function agentToolPreamble(tools: unknown[]): string {
  const defs = tools.map((t, i) => {
    const o = (t ?? {}) as { type?: unknown; function?: unknown };
    const fn = (o.function ?? {}) as {
      name?: unknown;
      description?: unknown;
      parameters?: unknown;
    };
    const name = typeof fn.name === "string" ? fn.name : `tool_${i}`;
    const desc = typeof fn.description === "string" ? fn.description : "";
    const params = fn.parameters !== undefined ? JSON.stringify(fn.parameters) : "{}";
    return `- ${name}: ${desc} (parameters: ${params})`;
  });
  return `system: Output-format check in progress. Do NOT answer the user's question directly.
Functions you may call (JSON schemas):
${defs.join("\n")}
First, output exactly one JSON object and nothing else: {"tool_calls": [{"id": "call_1", "name": "<one of the functions above>", "arguments": {...matching its schema...}}]}
When the user replies starting with "call <id> result:", use the result and either call again (same JSON format) or give the final answer as plain text.`;
}

/**
 * エージェントチャット：1往復ごとに tool_calls または回答を返す。
 * 反復はクライアント側が駆動する（tool実行→結果送信→次往復）。
 */
export async function handleAgentChat(
  req: ChatRequest,
  tools: unknown[],
): Promise<Response> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new UpstreamError(
      500,
      "TORITSU_API_KEY or TORITSU_KEY_FILE is not set",
      "server_error",
    );
  }
  // クライアントのsystemは捨てる：API提供ツール前提の記述が
  // テキスト指示と矛盾し、モデルが実行を拒む原因になるため
  const messages = req.messages.filter((m) => m.role !== "system");
  const input = toToritsuInput(messages, SYSTEM_FORMAT, agentToolPreamble(tools));
  const res = await callPublicUpstream(input, req.conversationId, apiKey);
  const parsed = parseAssistantOutput(res.message);
  if (parsed.type === "tool_calls") {
    const completion = toChatCompletion(req.model, {
      message: "",
      response: { conversation: { id: res.conversationId } },
    });
    const choice = completion.choices[0];
    if (choice !== undefined) {
      choice.message.content = null;
      choice.message.tool_calls = parsed.calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.args },
      }));
      choice.finish_reason = "tool_calls";
    }
    return req.stream ? toSSE(completion) : json(completion, 200);
  }
  const completion = toChatCompletion(req.model, {
    message: parsed.text,
    response: { conversation: { id: res.conversationId } },
  });
  return req.stream ? toSSE(completion) : json(completion, 200);
}
