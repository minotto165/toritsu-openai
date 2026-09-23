// 中央運用専用：プロキシAPIキーの保存・検証・発行・失効（平文＋メタ、0600保存）
// 個人利用（有効キー0件）では素通しのため、本モジュールは発動しない
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../infra/logger";

export interface ProxyKeyEntry {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  revoked: boolean;
  revokedAt: string | null;
}

/** キーファイルの解決（env優先） */
export function proxyKeyFile(): string {
  const custom = (process.env.TORITSU_PROXY_KEY_FILE ?? "").trim();
  if (custom !== "") {
    return custom;
  }
  return join(homedir(), ".config", "toritsu-openai", "proxy_keys.json");
}

let cache: { mtimeMs: number; entries: ProxyKeyEntry[] } | null = null;

function normalize(v: unknown): ProxyKeyEntry | null {
  if (v === null || typeof v !== "object") {
    return null;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.key !== "string") {
    return null;
  }
  return {
    id: o.id,
    name: typeof o.name === "string" ? o.name : "",
    key: o.key,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
    revoked: o.revoked === true,
    revokedAt: typeof o.revokedAt === "string" ? o.revokedAt : null,
  };
}

/** 全件読込（mtimeキャッシュ付き・即時反映） */
export function loadProxyKeys(): ProxyKeyEntry[] {
  const file = proxyKeyFile();
  try {
    const mtimeMs = statSync(file).mtimeMs;
    if (cache !== null && cache.mtimeMs === mtimeMs) {
      return cache.entries;
    }
    const raw = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    const entries = Array.isArray(raw)
      ? raw.map(normalize).filter((e): e is ProxyKeyEntry => e !== null)
      : [];
    cache = { mtimeMs, entries };
    return entries;
  } catch {
    cache = null;
    return [];
  }
}

/** 有効キーのみ */
export function activeProxyKeys(): ProxyKeyEntry[] {
  return loadProxyKeys().filter((e) => !e.revoked && e.key !== "");
}

/** 認証が有効か（有効キーが1件以上あるか） */
export function proxyAuthEnabled(): boolean {
  return activeProxyKeys().length > 0;
}

function persist(entries: ProxyKeyEntry[]): void {
  const file = proxyKeyFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  cache = null;
}

/** Bearer候補の検証（タイミング攻撃対策の定数時間比較） */
export function verifyProxyKey(candidate: string): boolean {
  return identifyProxyKey(candidate) !== null;
}

/** Bearer候補→キーエントリ（不一致はnull）。レート制限・ログ用 */
export function identifyProxyKey(candidate: string): ProxyKeyEntry | null {
  if (candidate === "") {
    return null;
  }
  const buf = Buffer.from(candidate);
  for (const e of activeProxyKeys()) {
    const expected = Buffer.from(e.key);
    if (buf.length === expected.length && timingSafeEqual(buf, expected)) {
      return e;
    }
  }
  return null;
}

function newId(prefix: string, bytes = 8): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

/** 発行（平文キーを返すのはこの瞬間のみ運用する） */
export function issueKey(name: string): ProxyKeyEntry {
  const entries = loadProxyKeys();
  const entry: ProxyKeyEntry = {
    id: newId("pk", 6),
    name: name.trim() === "" ? "unnamed" : name.trim(),
    key: `sk-toritsu-${randomBytes(32).toString("base64url")}`,
    createdAt: new Date().toISOString(),
    revoked: false,
    revokedAt: null,
  };
  entries.push(entry);
  persist(entries);
  logger.info(`issued proxy key ${entry.id} (name: ${entry.name})`);
  return entry;
}

/** 失効（id完全一致 or キーprefix一致。見つからなければnull） */
export function revokeKey(idOrPrefix: string): ProxyKeyEntry | null {
  const q = idOrPrefix.trim();
  if (q === "") {
    return null;
  }
  const entries = loadProxyKeys();
  const found = entries.find((e) => e.id === q || e.key.startsWith(q));
  if (!found || found.revoked) {
    return null;
  }
  found.revoked = true;
  found.revokedAt = new Date().toISOString();
  persist(entries);
  logger.warn(`revoked proxy key ${found.id} (name: ${found.name})`);
  return found;
}

/** 一覧表示用（キーはprefixのみ） */
export function maskKey(key: string): string {
  return key.length <= 12 ? `${key}...` : `${key.slice(0, 12)}...`;
}
