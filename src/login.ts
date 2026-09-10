// --login：実Chromeで手動ログイン後にトークン自動取得
import { chromium } from "playwright-core";
import { checkSession, saveSessionToken } from "./upstream/webui";

const LOGIN_URL = "https://ai.metro.tokyo.lg.jp/";
const TOKEN_KEY = "auth._token.local";
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 300_000;

function stripBearer(raw: string): string {
  return raw.replace(/^Bearer\s+/i, "").trim();
}

// --login の実処理：実ChromeのlocalStorageからトークンを自動取得
/** 手動ログイン待ち→取得→保存。Chromeなしはfalse */
export async function autoLogin(): Promise<boolean> {
  let browser;
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: false,
    });
  } catch (err) {
    console.log(`(Chromeを起動できませんでした: ${err})`);
    return false;
  }
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(LOGIN_URL);
    console.log("開いたChromeで都立AIにログインしてください（最大5分待ちます）。");
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const raw = await page
        .evaluate((key: string) => window.localStorage.getItem(key), TOKEN_KEY)
        .catch(() => null);
      if (typeof raw === "string" && raw.trim() !== "") {
        const token = stripBearer(raw);
        console.log("トークンを検出。検証中...");
        if (await checkSession(token)) {
          saveSessionToken(token);
          console.log("saved. Use model toritsu-fast (高速) or toritsu-reasoning (推論).");
          return true;
        }
        console.log("トークンが無効でした。ログインし直してください。");
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    console.error("タイムアウトしました。");
    return false;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
