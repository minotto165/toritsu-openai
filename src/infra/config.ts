// 環境変数・キー・設定ファイルの管理
import { mkdirSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger";

export const TORITSU_API_URL = "https://ai-api.metro.tokyo.lg.jp/api/v1/public/message";
export const PORT = Number(process.env.PORT ?? "3000");
export const KEY_FILE = process.env.TORITSU_KEY_FILE;

let currentApiKey = process.env.TORITSU_API_KEY ?? "";
const keyFingerprint = currentApiKey ? currentApiKey.slice(-4) : "";

if (KEY_FILE) {
  try {
    currentApiKey = readFileSync(KEY_FILE, "utf-8").trim();
    logger.info(`loaded key from ${KEY_FILE} (fingerprint: ${currentApiKey.slice(-4)})`);
  } catch (err) {
    logger.error(`failed to read KEY_FILE: ${err}`);
  }

  try {
    const watcher = watch(KEY_FILE, (eventType: string) => {
      if (eventType === "change") {
        try {
          const newKey = readFileSync(KEY_FILE, "utf-8").trim();
          if (newKey && newKey !== currentApiKey) {
            currentApiKey = newKey;
            logger.info(`key reloaded (fingerprint: ${newKey.slice(-4)})`);
          }
        } catch (err) {
          logger.error(`failed to reload key: ${err}`);
        }
      }
    });
    watcher.on("error", (err: Error) => {
      logger.error(`key file watcher error: ${err}`);
    });
  } catch (err) {
    logger.error(`failed to watch KEY_FILE: ${err}`);
  }
} else if (keyFingerprint !== "") {
  logger.info(`using TORITSU_API_KEY (fingerprint: ${keyFingerprint})`);
}

export function getApiKey(): string {
  return currentApiKey;
}

const CONFIG_DIR = join(homedir(), ".config", "toritsu-openai");
export const SESSION_FILE = join(CONFIG_DIR, "session");

/** 数値envの読込 (不正時は既定値) */
function numEnv(name: string, def: number): number {
  const v = Number((process.env[name] ?? "").trim());
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** 会話対応表 (履歴→cid) の有効化。1=有効、既定off */
export const SESSION_REUSE = process.env.TORITSU_SESSION_REUSE === "1";
/** 対応表エントリの有効期限 (ミリ秒)。既定24時間 */
export const SESSION_TTL_MS = numEnv("TORITSU_SESSION_TTL_HOURS", 24) * 3_600_000;
/** 対応表の上限件数 (超過は古い方から淘汰)。既定1000 */
export const SESSION_MAX = Math.floor(numEnv("TORITSU_SESSION_MAX", 1000));
/** 対応表の永続化先 (空=メモリのみ)。0600保存 */
export const SESSION_STORE = (process.env.TORITSU_SESSION_STORE ?? "").trim();

/** セッションファイル読込（なければ空文字） */
export function readSessionFile(): string {
  try {
    return readFileSync(SESSION_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

/** 設定dir確保（0700） */
export function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}
