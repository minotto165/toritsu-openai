import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { getApiKey, readSessionFile } from "./config";

export type DebugLevel = "off" | "sizes" | "full";

/** TORITSU_DEBUG=1(sizes) / full(payloadまで保存) */
export function debugLevel(): DebugLevel {
  const v = (process.env.TORITSU_DEBUG ?? "").trim().toLowerCase();
  if (v === "full" || v === "payload" || v === "2") {
    return "full";
  }
  if (v === "1" || v === "sizes") {
    return "sizes";
  }
  return "off";
}

function debugFile(): string {
  const custom = (process.env.TORITSU_DEBUG_FILE ?? "").trim();
  if (custom !== "") {
    return custom;
  }
  return join(homedir(), ".config", "toritsu-openai", "debug.log");
}

const LINE_CAP = 32000;

/** 秘密値の収集。ログ記録直前に毎回取得する */
function collectSecrets(): string[] {
  const out: string[] = [];
  const push = (v: string | undefined | null) => {
    if (typeof v === "string") {
      const t = v.trim();
      if (t.length >= 8) {
        out.push(t);
      }
    }
  };
  push(process.env.TORITSU_API_KEY);
  push(process.env.TORITSU_SESSION);
  push(getApiKey());
  push(readSessionFile());
  return out;
}

/**
 * 生ログを1行JSONで保存する。秘密値は [REDACTED] に置換する。
 * 保存失敗はサーブに影響させない。debugLevel()!=="full" のときは何もしない。
 */
export function debugRecord(event: string, data: Record<string, unknown>): void {
  if (debugLevel() !== "full") {
    return;
  }
  try {
    let line = JSON.stringify({ t: new Date().toISOString(), event, ...data });
    for (const s of collectSecrets()) {
      if (line.includes(s)) {
        line = line.split(s).join("[REDACTED]");
      }
    }
    if (line.length > LINE_CAP) {
      line = `${line.slice(0, LINE_CAP)}...[truncated ${line.length - LINE_CAP} chars]`;
    }
    const file = debugFile();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
    if ((process.env.TORITSU_DEBUG_STDOUT ?? "") === "1") {
      console.log(`[debug] ${line}`);
    }
  } catch {
    // 保存失敗は無視する
  }
}
