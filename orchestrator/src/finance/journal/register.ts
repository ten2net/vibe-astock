/**
 * 交易日志的界面视图登记(和 VR 原有视图分开放)。由 `../register_tasks.ts` 导入一次。
 * 🔴 个人交易数据只经带令牌的本机接口给界面,不进 AI 上下文、不进 MCP。
 */
import { registerView } from "../../views.ts";
import { journalAttribution } from "./attribution.ts";
import { journalEnvironment } from "./environment.ts";
import { journalAct, journalExcursion, journalView } from "./view.ts";
import { vaImportAct, vaImportView } from "../va_import.ts";

registerView({ id: "journal", label: "交易日志", run: journalView, act: journalAct });
registerView({ id: "journal_excursion", label: "交易日志 · 最大浮盈浮亏", run: journalExcursion });
registerView({ id: "journal_attribution", label: "交易日志 · 判断与执行归因", run: journalAttribution });
registerView({ id: "journal_env", label: "交易日志 · 按入场日环境分组", run: journalEnvironment });
// 旧版(Python 版)数据导入:交易日志、模式卡、AI 复盘、明日验证、盘中快照、个股深挖;同样只走本机接口
registerView({ id: "va_import", label: "从旧版导入", run: vaImportView, act: (ctx, body, signal) => vaImportAct(ctx, body, signal) });
