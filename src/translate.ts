// OpenAI messages[] <-> Toritsu AI input 変換

export interface ChatMessage {
  role: string;
  content: unknown;
}

/** systemブロックの畳み込み形式。a: system行のまま先頭配置 / b: 【システム指示】ヘッダー化 */
export type SystemFormat = "a" | "b";

function toText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * OpenAI messages[] を都立AIの input 文字列1本に畳む。
 * system role は全て抽出して文頭ブロック化し、残りを "role: content" 行で連結する。
 */
export function toToritsuInput(messages: ChatMessage[], format: SystemFormat = "a"): string {
  const systems = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const lines = rest.map((m) => `${m.role}: ${toText(m.content)}`);
  if (systems.length === 0) {
    return lines.join("\n");
  }
  if (format === "b") {
    const sys = systems.map((m) => toText(m.content)).join("\n");
    return `【システム指示】\n${sys}\n\n【会話】\n${lines.join("\n")}`;
  }
  const sysLines = systems.map((m) => `system: ${toText(m.content)}`);
  return [...sysLines, ...lines].join("\n");
}

export interface ToritsuResponse {
  message?: unknown;
  response?: {
    conversation?: {
      id?: unknown;
    };
  };
  error?: unknown;
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
  return "upstream error";
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop";
  }>;
  /** 上流がトークン数を返さないためゼロ埋め */
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** 非標準の付加フィールド：上流の conversation.id をそのまま返す */
  conversation_id: string;
}

/** 都立AIの応答を OpenAI chat.completion 形式に変換する */
export function toChatCompletion(model: string, data: ToritsuResponse): ChatCompletion {
  const conversationId = data.response?.conversation?.id;
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
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    conversation_id: typeof conversationId === "string" ? conversationId : "",
  };
}
