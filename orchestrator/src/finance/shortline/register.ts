/**
 * 短线(Vibe AStock)的界面视图登记。和 VR 原有的视图分开放,VR 合并上游时这边不打架。
 * 由 `../register_tasks.ts` 导入一次(提供 API 的入口才需要视图)。
 */
import { registerView } from "../../views.ts";
import { shortlineHistory } from "./history.ts";
import { shortlineIntraday, shortlineIntradayAct } from "./intraday.ts";
import { shortlineReview, shortlineReviewAct } from "./review.ts";
import { shortlineSamples } from "./samples.ts";
import { shortlineStructure } from "./structure.ts";
import { shortlineVerify, shortlineVerifyAct } from "./verification.ts";
import { shortlineWatchAct, shortlineWatchAlerts } from "./watch.ts";
import { shortlineWeekly } from "./weekly.ts";
import { shortlineWeeklyReview, shortlineWeeklyReviewAct } from "./weekly_review.ts";

registerView({ id: "shortline_history", label: "情绪历史", run: shortlineHistory });
registerView({ id: "shortline_verify", label: "明日验证", run: shortlineVerify, act: shortlineVerifyAct });
registerView({ id: "shortline_samples", label: "涨停样本统计", run: shortlineSamples });
registerView({ id: "shortline_structure", label: "结构变化", run: shortlineStructure });
registerView({ id: "shortline_review", label: "AI 复盘", run: shortlineReview, act: shortlineReviewAct });
registerView({ id: "shortline_weekly", label: "近 5 天热度与龙头谱系", run: shortlineWeekly });
registerView({ id: "shortline_weekly_review", label: "AI 周报", run: shortlineWeeklyReview, act: shortlineWeeklyReviewAct });
registerView({ id: "shortline_intraday", label: "竞价与盘中路径", run: shortlineIntraday, act: (ctx, body, signal) => shortlineIntradayAct(ctx, body, signal) });
registerView({ id: "shortline_watch", label: "盯盘 · 实时动态", run: shortlineWatchAlerts, act: (ctx, body, signal) => shortlineWatchAct(ctx, body, signal) });
