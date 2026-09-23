// エントリポイント：薄いルーター＋--login
import { Hono } from "hono";
import { PORT } from "./infra/config";
import { invalidRequest, toErrorJson, UpstreamError, type ChatRequest } from "./infra/http";
import { handleChat } from "./handlers/chat";
import { handleAgentChat } from "./handlers/agent";
import { checkSession, saveSessionToken } from "./upstream/webui";
import { debugRecord } from "./infra/debug";
import { logger } from "./infra/logger";
import { logRequest } from "./infra/request_log";
import type { ChatMessage } from "./text/translate";

if (process.argv.includes("--login")) {
  await runLogin();
  process.exit(0);
}

// エントリポイント：薄いルーター＋--login
/** --login：実Chromeで手動ログイン後にトークンを自動取得（学校認証情報は扱わない） */
async function runLogin(): Promise<void> {
  logger.info("=== toritsu-openai session login ===");
  logger.warn("注意: 保存されるのは都立AIのセッショントークンです。");
  logger.warn("学校アカウント全体へのアクセスに繋がるため、他人と共有しないでください。");
  logger.info("");
  const { autoLogin } = await import("./login");
  if (await autoLogin()) {
    return;
  }
  logger.info("");
  logger.info("--- 手動方式に切替えます ---");
  logger.info("1. ブラウザで都立AIにログインしてください。");
  logger.info("2. DevTools → Network で api/v1/chat/ へのリクエストを探します。");
  logger.info('3. Request Headers の authorization の値（"Bearer " を除いた部分）を貼り付けます。');
  logger.info("");
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let token = "";
  try {
    token = (await rl.question("session token: ")).trim();
  } finally {
    rl.close();
  }
  if (token === "") {
    logger.error("empty token");
    process.exit(1);
  }
  logger.info("validating...");
  if (!(await checkSession(token))) {
    logger.error("invalid or expired session token");
    process.exit(1);
  }
  saveSessionToken(token);
  logger.info("saved. Use model toritsu-fast (高速) or toritsu-reasoning (推論).");
}

const app = new Hono();

const MODELS = ["toritsu", "toritsu-fast", "toritsu-reasoning"];

/** モデル一覧。カタログ自動取得するクライアント向けの固定リスト */
app.get("/v1/models", (c) => {
  const now = Math.floor(Date.now() / 1000);
  return c.json({
    object: "list",
    data: MODELS.map((id) => ({ id, object: "model", created: now, owned_by: "toritsu-openai" })),
  });
});

/** tools付きは翻訳、なければ通常チャット（送信先はsenderが決定） */
app.post("/v1/chat/completions", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    model?: unknown;
    messages?: unknown;
    stream?: unknown;
    conversation_id?: unknown;
    tools?: unknown;
    tool_choice?: unknown;
  } | null;

  if (body === null || !Array.isArray(body.messages) || body.messages.length === 0) {
    return invalidRequest("messages is required");
  }
  const model = typeof body.model === "string" && body.model !== "" ? body.model : "toritsu";
  const req: ChatRequest = {
    model,
    messages: body.messages as ChatMessage[],
    stream: body.stream === true,
    conversationId: typeof body.conversation_id === "string" ? body.conversation_id : "",
  };
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  debugRecord("client_request", {
    model,
    stream: req.stream,
    conversationId: req.conversationId,
    messages: req.messages,
    tools,
    tool_choice: body.tool_choice ?? null,
  });
  logRequest(req, tools);

  try {
    if (tools.length > 0 && body.tool_choice !== "none") {
      return await handleAgentChat(req, tools);
    }
    return await handleChat(req);
  } catch (err) {
    if (err instanceof UpstreamError) {
      return toErrorJson(err);
    }
    throw err;
  }
});

export default {
  port: PORT,
  fetch: app.fetch,
};
