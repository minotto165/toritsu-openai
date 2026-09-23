// リクエスト受付ログ（chat/agentハンドラに依存しない共通層）
import { debugLevel } from "./debug";
import { logger } from "./logger";
import type { ChatRequest } from "./http";

/** 1リクエスト1行のstdoutサマリ。詳細ペイロードはdebug.log側 */
export function logRequest(req: ChatRequest, tools: unknown[]): void {
  if (debugLevel() === "off") {
    return;
  }
  const chars = (v: unknown): number => JSON.stringify(v ?? "").length;
  const msgChars = req.messages.reduce((n, m) => n + chars(m.content), 0);
  const toolChars = req.messages
    .filter((m) => m.role === "tool")
    .reduce((n, m) => n + chars(m.content), 0);
  logger.info(
    `request model=${req.model} turns=${req.messages.length} msg_chars=${msgChars} tool_chars=${toolChars} tools=${tools.length}${req.conversationId !== "" ? " cont=1" : ""}`,
  );
}
