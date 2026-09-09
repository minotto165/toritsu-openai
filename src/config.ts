import { readFileSync, watch } from "node:fs";
import type { SystemFormat } from "./translate";

export const TORITSU_API_URL =
  process.env.TORITSU_API_URL ?? "https://ai-api.metro.tokyo.lg.jp/api/v1/public/message";
export const PORT = Number(process.env.PORT ?? "3000");
export const SYSTEM_FORMAT: SystemFormat = process.env.TORITSU_SYSTEM_FORMAT === "b" ? "b" : "a";
export const KEY_FILE = process.env.TORITSU_KEY_FILE;

let currentApiKey = process.env.TORITSU_API_KEY ?? "";
const keyFingerprint = currentApiKey ? currentApiKey.slice(-4) : "";

if (KEY_FILE) {
  try {
    currentApiKey = readFileSync(KEY_FILE, "utf-8").trim();
    console.log(
      `[toritsu-openai] loaded key from ${KEY_FILE} (fingerprint: ${currentApiKey.slice(-4)})`,
    );
  } catch (err) {
    console.error(`[toritsu-openai] failed to read KEY_FILE: ${err}`);
  }

  try {
    const watcher = watch(KEY_FILE, (eventType: string) => {
      if (eventType === "change") {
        try {
          const newKey = readFileSync(KEY_FILE, "utf-8").trim();
          if (newKey && newKey !== currentApiKey) {
            currentApiKey = newKey;
            console.log(`[toritsu-openai] key reloaded (fingerprint: ${newKey.slice(-4)})`);
          }
        } catch (err) {
          console.error(`[toritsu-openai] failed to reload key: ${err}`);
        }
      }
    });
    watcher.on("error", (err: Error) => {
      console.error(`[toritsu-openai] key file watcher error: ${err}`);
    });
  } catch (err) {
    console.error(`[toritsu-openai] failed to watch KEY_FILE: ${err}`);
  }
} else if (keyFingerprint !== "") {
  console.log(`[toritsu-openai] using TORITSU_API_KEY (fingerprint: ${keyFingerprint})`);
}

export function getApiKey(): string {
  return currentApiKey;
}
