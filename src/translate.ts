// OpenAI messages[] <-> Toritsu AI input 変換

export interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
}

/** systemブロックの畳み込み形式。a: system行のまま先頭配置 / b: 【システム指示】ヘッダー化 */
export type SystemFormat = "a" | "b";

function toText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * OpenAI messages[] を都立AIの input 文字列1本に畳む。
 * system role は全て抽出して文頭ブロック化し、残りを "role: content" 行で連結する。
 * role:tool のメッセージはツール実行結果として "tool: ..." 行にする。
 * assistant の tool_calls は文脈維持のためJSON行として残す。
 * extraSystem があれば system ブロックに追記する（エージェント規約用）。
 */
export function toToritsuInput(
  messages: ChatMessage[],
  format: SystemFormat = "a",
  extraSystem?: string,
): string {
  const systems = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const lines = rest.map((m) => {
    if (m.role === "tool") {
      return `tool: ${toText(m.content)}`;
    }
    if (m.role === "assistant" && m.tool_calls !== undefined) {
      const head = `assistant: ${toText(m.content)}`;
      return `${head}\nassistant tool_calls: ${JSON.stringify(m.tool_calls)}`;
    }
    return `${m.role}: ${toText(m.content)}`;
  });
  const sysTexts = systems.map((m) => toText(m.content));
  if (extraSystem !== undefined && extraSystem !== "") {
    sysTexts.push(extraSystem);
  }
  if (sysTexts.length === 0) {
    return lines.join("\n");
  }
  if (format === "b") {
    return `【システム指示】\n${sysTexts.join("\n")}\n\n【会話】\n${lines.join("\n")}`;
  }
  const sysLines = sysTexts.map((t) => `system: ${t}`);
  return [...sysLines, ...lines].join("\n");
}

export interface ToritsuResponse {
  message?: unknown;
  response?: {
    conversation?: {
      id?: unknown;
    };
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      total_tokens?: unknown;
    };
  };
  error?: unknown;
  /** バリデーションエラー時の形状 {errors:{field:[msg]}} */
  errors?: Record<string, unknown>;
}

/** 上流エラー応答から表示用メッセージを抜き出す */
export function upstreamErrorMessage(data: ToritsuResponse | null): string {
  if (data === null || typeof data !== "object") {
    return "upstream error";
  }
  if (typeof data.message === "string" && data.message.length > 0) {
    return data.message;
  }
  if (typeof data.error === "string" && data.error.length > 0) {
    return data.error;
  }
  if (data.errors !== undefined && data.errors !== null && typeof data.errors === "object") {
    for (const v of Object.values(data.errors)) {
      const items = Array.isArray(v) ? v : [v];
      for (const item of items) {
        if (typeof item === "string" && item.length > 0) {
          return item;
        }
      }
    }
  }
  return "upstream error";
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: "stop" | "tool_calls";
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  /** 上流がトークン数を返すため実測値をマッピング（欠落時のみゼロ） */
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** 非標準の付加フィールド：上流の conversation.id をそのまま返す */
  conversation_id: string;
}

/** 都立AIの応答を OpenAI chat.completion 形式に変換する */
export function toChatCompletion(model: string, data: ToritsuResponse): ChatCompletion {
  const conversationId = data.response?.conversation?.id;
  const upstreamUsage = data.response?.usage;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const now = Date.now();
  return {
    id: `chatcmpl-toritsu-${now}`,
    object: "chat.completion",
    created: Math.floor(now / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: toText(data.message ?? "") },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: num(upstreamUsage?.input_tokens),
      completion_tokens: num(upstreamUsage?.output_tokens),
      total_tokens: num(upstreamUsage?.total_tokens),
    },
    conversation_id: typeof conversationId === "string" ? conversationId : "",
  };
}
