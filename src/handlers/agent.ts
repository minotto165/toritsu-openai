// 翻訳ハンドラ：tools指示化→tool_calls返却（実行はクライアント側）
import { getApiKey } from "../infra/config";
import { json, toSSE, type ChatRequest } from "../infra/http";
import { debugLevel, debugRecord } from "../infra/debug";
import { sendUpstream } from "../upstream/sender";
import {
  toToritsuInput,
  toChatCompletion,
  parseAssistantOutput,
  selectMessages,
  getTruncationStats,
} from "../text/translate";

/** 自前軽量system（先頭付与・独立変数） */
const DEFAULT_AGENT_IDENTITY = "You are a helpful coding assistant.";

export function agentIdentity(): string {
  const custom = (process.env.TORITSU_AGENT_SYSTEM ?? "").trim();
  return custom !== "" ? custom : DEFAULT_AGENT_IDENTITY;
}

/** 保持するクライアントsystemの上限。超過分は捨てる（機構部を守るため） */
const KEPT_SYSTEM_CAP = 3000;
const INPUT_BUDGET = 18000;
const HEAD_KEEP = 2000;

export function shrinkInput(input: string): { text: string; cut: number } {
  if (input.length <= INPUT_BUDGET) {
    return { text: input, cut: 0 };
  }
  return {
    text:
      `${input.slice(0, HEAD_KEEP)}\n...[omitted ${input.length - INPUT_BUDGET} chars of older tool output]...\n` +
      input.slice(input.length - (INPUT_BUDGET - HEAD_KEEP)),
    cut: input.length - INPUT_BUDGET,
  };
}

/** 呼出しターンの固定文（tools定義を間に挟んで組み立てる） */
const CALL_HEAD = `You are a request converter. Convert the user request below into exactly one tool-call JSON object per turn and nothing else. Do not answer it directly.
The tool_calls array MUST contain exactly one call. An empty array is a format violation.
If no tool is needed (greetings, chit-chat, general knowledge), output {"answer": "..."} instead.
Do NOT use web search.
Prefer scoped commands (specific files, ≤200 lines). Avoid dumping node_modules, .git, or lockfiles.
Functions you may call (JSON schemas):`;

const CALL_TAIL = `Output format: {"tool_calls": [{"id": "call_1", "name": "<one of the functions above>", "arguments": {...matching its schema...}}]} or {"answer": "..."}. Output valid JSON only: escape newlines as \\n, escape every " as \\", never use \\'. No prose outside JSON.`;
const RESULT_FALLBACK = `If a further call is impossible, provide complete copy-paste-ready code instead of lecturing about permissions. Code only, minimal explanation.`;

/** 結果ターンの固定文（末尾に利用可能関数名を付加する） */
const RESULT_HEAD = `Use the tool results below. If you have enough information, give the final answer as plain text. Do NOT use web search; local questions MUST be answered from the tool results only. Otherwise output exactly one JSON object and nothing else: {"tool_calls": [{"id": "call_n", "name": "<function>", "arguments": {...}}]} (non-empty). Keep follow-up reads small (≤200 lines, specific paths, no node_modules/.git).`;

/** クライアントsystemのtool記述部だけを除去し、残りを活かす */
export function rewriteClientSystem(texts: string[]): string {
  const joined = texts
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join("\n\n");
  // pi製のsystemに限定する。それ以外は無加工で通す
  if (!/operating inside pi/i.test(joined)) {
    return joined;
  }
  return stripToolBlocks(joined);
}

function stripToolBlocks(t: string): string {
  const lines = t.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    // (1) "Available tools" 見出し＋続く箇条書き＋tool言及パラグラフ
    if (/^\s*#{0,4}\s*available tools\s*:?\s*$/i.test(line)) {
      i++;
      while (i < lines.length && /^\s*([-*]\s+|\d+[.)]\s+)/.test(lines[i] as string)) {
        i++;
      }
      // 空行を跨いで続くtool言及パラグラフも除去する
      while (i < lines.length) {
        const l = lines[i] as string;
        if (l.trim() === "") {
          i++;
          continue;
        }
        if (/tool/i.test(l)) {
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    // (2) tool定義を含む見出し＋配下のみ除去する。
    // 定義形状（- 名前: 説明）がない行動規範（例：Tool usage policy）は残す
    if (/^\s*#{1,4}\s+.*\btools?\b/i.test(line)) {
      let j = i + 1;
      let hasDef = false;
      while (
        j < lines.length &&
        ((lines[j] as string).trim() === "" ||
          /^\s*([-*]\s+|\d+[.)]\s+|>|\s)/.test(lines[j] as string))
      ) {
        if (/^\s*[-*]\s*`?[A-Za-z_][\w-]*`?\s*:/.test(lines[j] as string)) {
          hasDef = true;
        }
        j++;
      }
      if (hasDef) {
        i = j;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** tools定義→指示文 */
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
  return `${agentIdentity()}\n${CALL_HEAD}\n${defs.join("\n")}\n${CALL_TAIL}`;
}

/** 結果ターン用指示 */
export function agentResultPreamble(tools: unknown[] = []): string {
  const names = tools.map((t, i) => {
    const o = (t ?? {}) as { function?: unknown };
    const fn = (o.function ?? {}) as { name?: unknown };
    return typeof fn.name === "string" ? fn.name : `tool_${i}`;
  });
  const available = names.length > 0 ? `\nAvailable functions: ${names.join(", ")}` : "";
  return `${agentIdentity()}\n${RESULT_HEAD}${available}\n${RESULT_FALLBACK}`;
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
  // クライアントsystemはtool記述部だけ除去して活かす。
  // 巨大systemは機構部を守るため先頭3000文字に切る
  const keptRaw = rewriteClientSystem(
    req.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
  );
  const keptSystem =
    keptRaw.length > KEPT_SYSTEM_CAP ? `${keptRaw.slice(0, KEPT_SYSTEM_CAP)}\n...[system truncated]` : keptRaw;
  const preambleBody = isToolResultTurn ? agentResultPreamble(tools) : agentToolPreamble(tools);
  // 機構部を先に置く（縮小時に守られる順序）
  const preamble = `${preambleBody}${keptSystem !== "" ? `\n${keptSystem}` : ""}`;
  // 継続ターンは最新1件のみ送る（上流が履歴を保持しているため）
  const messages = selectMessages(
    req.messages.filter((m) => m.role !== "system"),
    req.conversationId,
  );
  const shrunk = shrinkInput(toToritsuInput(messages, preamble));
  const input = shrunk.text;
  if (debugLevel() !== "off") {
    const toolChars = req.messages
      .filter((m) => m.role === "tool")
      .reduce((n, m) => n + JSON.stringify(m.content ?? "").length, 0);
    const trunc = getTruncationStats();
    console.log(
      `[toritsu-openai] agent input_len=${input.length} tool_chars=${toolChars} turns=${req.messages.length} trunc_tool=${trunc.toolCuts}:${trunc.toolCutChars} trunc_shrink=${shrunk.cut}`,
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
