// 共通ロガー（tslog: TTYでは色付きpretty、非TTYでは自動でプレーン）
import { Logger } from "tslog";

export const logger = new Logger({
  name: "toritsu-openai",
  type: "pretty",
  pretty: {
    timeZone: "local",
    template: "{{hh}}:{{MM}}:{{ss}} {{logLevelName}} [{{name}}] ",
  },
});
