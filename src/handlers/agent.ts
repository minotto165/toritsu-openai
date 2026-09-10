// エージェント翻訳：クライアントの tools 定義をテキスト指示に変換し、
// モデルが出した tool_calls JSON をそのままクライアントに返す。
// 実行はクライアント側（pi等）が担い、プロキシは実行しない。
import { SYSTEM_FORMAT } from "../infra/config";
import { json, toSSE, type ChatRequest } from "../infra/http";
import { debugLevel, debugRecord } from "../infra/debug";
import { sendUpstream } from "../upstream/sender";
import {
  toToritsuInput,
  toChatCompletion,
  parseAssistantOutput,
  selectMessages,
} from "../text/translate";

/** 自前の軽量system。tool変数とは別の独立変数として保持し、先頭に付与する */
const DEFAULT_AGENT_IDENTITY = "You are a helpful coding assistant.";

export function agentIdentity(): string {
  const custom = (process.env.TORITSU_AGENT_SYSTEM ?? "").trim();
  return custom !== "" ? custom : DEFAULT_AGENT_IDENTITY;
}

/** 入力上限対策：先頭（規約文）を残し、古い履歴側を削る */
const INPUT_BUDGET = 18000;
const HEAD_KEEP = 2000;

export function shrinkInput(input: string): string {
  if (input.length <= INPUT_BUDGET) {
    return input;
  }
  return (
    `${input.slice(0, HEAD_KEEP)}\n...[omitted ${input.length - INPUT_BUDGET} chars of older tool output]...\n` +
    input.slice(input.length - (INPUT_BUDGET - HEAD_KEEP))
  );
}

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
  return `${agentIdentity()}\nYou are a request converter. Convert the user request below into exactly one tool-call JSON object per turn and nothing else. Do not answer it directly.
The tool_calls array MUST contain exactly one call. An empty array is a format violation.
Refusing with phrases like "cannot access" or "not available" is a format violation.\nIf no tool is needed (greetings, chit-chat, general knowledge), output {"answer": "..."} instead.
Do NOT use web search.
Prefer scoped commands (specific files, ≤200 lines). Avoid dumping node_modules, .git, or lockfiles.
Functions you may call (JSON schemas):
${defs.join("\n")}
Output format: {"tool_calls": [{"id": "call_1", "name": "<one of the functions above>", "arguments": {...matching its schema...}}]} or {"answer": "..."}. Output valid JSON only, escape newlines, no prose outside JSON.`;
}

/** 結果受領ターン用：回答許可＋追加呼出し継続の両立 */
export function agentResultPreamble(tools: unknown[] = []): string {
  const names = tools.map((t, i) => {
    const o = (t ?? {}) as { function?: unknown };
    const fn = (o.function ?? {}) as { name?: unknown };
    return typeof fn.name === "string" ? fn.name : `tool_${i}`;
  });
  const available = names.length > 0 ? `\nAvailable functions: ${names.join(", ")}` : "";
  return `${agentIdentity()}\nUse the tool results below. If you have enough information, give the final answer as plain text. Do NOT use web search; local questions MUST be answered from the tool results only. Otherwise output exactly one JSON object and nothing else: {"tool_calls": [{"id": "call_n", "name": "<function>", "arguments": {...}}]} (non-empty). Keep follow-up reads small (≤200 lines, specific paths, no node_modules/.git).${available}`;
}

/**
 * エージェントチャット：tools定義をテキスト指示に変換し、モデルが出した
 * tool_calls JSON をそのまま返す。呼出しが出なければ直接回答として返す。
 */
export async function handleAgentChat(
  req: ChatRequest,
  tools: unknown[],
): Promise<Response> {
  // 末尾roleで判定：tool結果直後だけ回答許可、それ以外は呼出し強要に戻す
  const lastMsg = req.messages.length > 0 ? req.messages[req.messages.length - 1] : undefined;
  const isToolResultTurn = lastMsg !== undefined && lastMsg.role === "tool";
  const preamble = isToolResultTurn ? agentResultPreamble(tools) : agentToolPreamble(tools);
  // クライアントのsystemは捨てる：API提供ツール前提の記述が
  // テキスト指示と矛盾し、モデルが実行を拒む原因になるため。
  // 継続ターンは最新1件のみ送る（上流が履歴を保持しているため）
  const messages = selectMessages(
    req.messages.filter((m) => m.role !== "system"),
    req.conversationId,
  );
  const input = shrinkInput(toToritsuInput(messages, SYSTEM_FORMAT, preamble));
  if (debugLevel() !== "off") {
    const toolChars = req.messages
      .filter((m) => m.role === "tool")
      .reduce((n, m) => n + JSON.stringify(m.content ?? "").length, 0);
    console.log(
      `[toritsu-openai] agent input_len=${input.length} tool_chars=${toolChars} turns=${req.messages.length}`,
    );
  }
  debugRecord("agent_upstream_input", { input });

  const r = await sendUpstream(req, input);
  debugRecord("agent_upstream_output", { text: r.text, cid: r.cid });
  const parsed = parseAssistantOutput(r.text);
  if (parsed.type === "tool_calls") {
    const completion = toChatCompletion(req.model, {
      message: "",
      response: { conversation: { id: r.cid } },
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
    completion.usage = r.usage;
    return req.stream ? toSSE(completion) : json(completion, 200);
  }
  const completion = toChatCompletion(req.model, {
    message: parsed.text,
    response: { conversation: { id: r.cid } },
  });
  completion.usage = r.usage;
  return req.stream ? toSSE(completion) : json(completion, 200);
}
