// エージェントモード：モデル名 toritsu-agent で有効。
// クライアントの tools 定義をテキスト指示に変換し、モデルが出した
// tool_calls JSON をそのままクライアントに返す「翻訳者」方式。
// 実行はクライアント側（pi等）が担い、プロキシは実行しない。
import { SYSTEM_FORMAT, getApiKey } from "./config";
import { json, toSSE, UpstreamError, type ChatRequest } from "./http";
import { callPublicUpstream } from "./public";
import { loadSessionToken, sendWebuiMessage, WEBUI_MODELS } from "./webui";
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
  return `system: You are a request converter. Convert the user request below into exactly one tool-call JSON object and nothing else. Do not answer it.
The tool_calls array MUST contain at least one call. An empty array is a format violation.
Refusing with phrases like "cannot access" or "not available" is a format violation.
Do NOT use web search.
Functions you may call (JSON schemas):
${defs.join("\n")}
Output format: {"tool_calls": [{"id": "call_1", "name": "<one of the functions above>", "arguments": {...matching its schema...}}]}`;
}

/** 結果受領ターン用：回答許可＋追加呼出し継続の両立 */
export function agentResultPreamble(): string {
  return `system: Use the tool results below. If you have enough information, give the final answer as plain text. Do NOT use web search; local questions MUST be answered from the tool results only. Otherwise output exactly one JSON object and nothing else: {"tool_calls": [{"id": "call_n", "name": "<function>", "arguments": {...}}]} (non-empty).`;
}

/**
 * エージェントチャット：tools定義をテキスト指示に変換し、モデルが出した
 * tool_calls JSON をそのまま返す。呼出しが出なければ直接回答として返す。
 * モデル名で送信先を決める：webuiモデルはセッションEndpoint、それ以外は公開Endpoint。
 */
export async function handleAgentChat(
  req: ChatRequest,
  tools: unknown[],
): Promise<Response> {
  const webuiModel = WEBUI_MODELS[req.model as keyof typeof WEBUI_MODELS];
  // 結果ターン（role:tool あり）では回答許可の指示に切替える。
  // そうしないと呼出しを繰返し、最終回答に到達しない
  const hasResults = req.messages.some((m) => m.role === "tool");
  const preamble = hasResults ? agentResultPreamble() : agentToolPreamble(tools);
  // クライアントのsystemは捨てる：API提供ツール前提の記述が
  // テキスト指示と矛盾し、モデルが実行を拒む原因になるため
  const messages = req.messages.filter((m) => m.role !== "system");
  const input = toToritsuInput(messages, SYSTEM_FORMAT, preamble);

  const sendOnce = async (): Promise<{
    text: string;
    cid: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }> => {
    if (webuiModel !== undefined) {
      const token = loadSessionToken();
      if (token === "") {
        throw new UpstreamError(
          500,
          "session mode requires login — run with --login",
          "server_error",
        );
      }
      const r = await sendWebuiMessage({
        input,
        hid: req.conversationId,
        model: webuiModel,
        token,
      });
      return {
        text: r.content,
        cid: r.hid,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
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
  };

  // 呼出しターンと結果ターンで1往復ずつ送信する。再試行はしない
  let text = "";
  let cid = req.conversationId;
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  ({ text, cid, usage } = await sendOnce());
  const parsed = parseAssistantOutput(text);
  if (parsed.type === "tool_calls") {
    const completion = toChatCompletion(req.model, {
      message: "",
      response: { conversation: { id: cid } },
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
    completion.usage = usage;
    return req.stream ? toSSE(completion) : json(completion, 200);
  }
  const completion = toChatCompletion(req.model, {
    message: parsed.text,
    response: { conversation: { id: cid } },
  });
  completion.usage = usage;
  return req.stream ? toSSE(completion) : json(completion, 200);
}
