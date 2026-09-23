// 共通ロガー（consola: TTYでは色付き、非TTYではプレーン）
import { consola } from "consola";

export const logger = consola.withTag("toritsu-openai");
