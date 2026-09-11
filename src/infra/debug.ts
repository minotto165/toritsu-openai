// デバッグ記録（秘密値は置換）
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { getApiKey, readSessionFile } from "./config";

export type DebugLevel = "off" | "sizes" | "full";

// デバッグ記録（秘密値は置換）: TORITSU_DEBUG=1(sizes)/full(payload保存)
/** デバッグ水準の解決 */
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

const STR_CAP = 8000;

/** 文字列フィールドを事前に丸める（ stringify 後の切断はJSONを壊すため） */
function truncateDeep(v: unknown): unknown {
  if (typeof v === "string") {
    if (v.length <= STR_CAP) {
      return v;
    }
    return `${Array.from(v).slice(0, STR_CAP).join("")}...[truncated ${v.length - STR_CAP} chars]`;
  }
  if (Array.isArray(v)) {
    return v.map(truncateDeep);
  }
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      o[k] = truncateDeep(val);
    }
    return o;
  }
  return v;
}

/** 秘密値の収集 */
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

/** 生ログを1行JSONで保存する（失敗時は無視、full時のみ） */
export function debugRecord(event: string, data: Record<string, unknown>): void {
  if (debugLevel() !== "full") {
    return;
  }
  try {
    let line = JSON.stringify({
      t: new Date().toISOString(),
      event,
      ...(truncateDeep(data) as Record<string, unknown>),
    });
    for (const s of collectSecrets()) {
      if (line.includes(s)) {
        line = line.split(s).join("[REDACTED]");
      }
    }
    const file = debugFile();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
    if ((process.env.TORITSU_DEBUG_STDOUT ?? "") === "1") {
      console.log(`[debug] ${line}`);
    }
  } catch {
    // ignore
  }
}
