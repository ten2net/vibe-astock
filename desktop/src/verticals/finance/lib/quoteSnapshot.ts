/** 各标的取数时刻可能不同，汇总显示最早的有效价格快照；缺时间不伪造当前时间。 */
export function quoteSnapshotTime(quotes: Record<string, { price: number | null; fetched_at?: string | null }>): number | null {
  const priced = Object.values(quotes).filter((q) => q.price !== null && Number.isFinite(q.price));
  if (!priced.length) return null;
  const times = priced.map((q) => q.fetched_at ? Date.parse(q.fetched_at) : NaN);
  return times.every(Number.isFinite) ? Math.min(...times) : null;
}

/**
 * 自动轮询只拉开盘市场：和休市市场已有的快照合并。但**这一轮问了的股票先把旧报价拿掉**，
 * 这轮没返回的就显示「—」，不能留着上一轮的价当成刚刷新的（Codex 审计 2026-10-09 C5）。
 * 不传 asked（首次 / 手动刷新）= 整体替换。
 */
export function mergePolledQuotes<Q>(prev: Record<string, Q>, data: Record<string, Q>, asked?: readonly string[]): Record<string, Q> {
  if (!asked) return data;
  const next = { ...prev };
  for (const c of asked) delete next[c];
  return { ...next, ...data };
}

/**
 * 取数**成功**但这一轮一只都没拿到（空表 / 全部代码对不上）时的判据。
 * 🔴 以前只判「请求抛错」：接口返回 200 + 空 evidence 时算成功，把空表当成新数据整体替换，
 *    页面上每只都显示「—」，又因为没有 error 不显示任何提示，点刷新也还是空 —— 看起来就是
 *    「行情获取失败，刷新不起作用」。
 */
export function noQuotesBack(asked: readonly string[] | undefined, data: Record<string, unknown>): boolean {
  return !!asked?.length && Object.keys(data).length === 0;
}

/** 这一轮问的代码里，有哪几只确实没有回报价（部分缺失也要让用户看见，而不是显示成空行） */
export function missingQuotes(asked: readonly string[] | undefined, data: Record<string, unknown>): string[] {
  return (asked ?? []).filter((c) => !(c in data));
}

/**
 * 取数失败后怎么处理（第四轮审计 C1）：旧价不能继续当现价显示。
 * - 首次 / 手动刷新（不传 asked）失败：马上撤下这一轮问的全部报价并提示——自动取数关着时没有下一拍来纠正。
 * - 自动轮询第一次失败先不打扰（多半是网络抖一下，3 秒后就重试），连续失败再撤下这轮问的报价并提示。
 */
export function quoteFailure(failures: number, asked?: readonly string[], reason?: string): { drop: <Q>(prev: Record<string, Q>) => Record<string, Q>; error: string } | null {
  if (asked && failures < 2) return null;
  const drop = <Q>(prev: Record<string, Q>): Record<string, Q> => {
    if (!asked) return {};
    const next = { ...prev };
    for (const c of asked) delete next[c];
    return next;
  };
  // 🔴 失败原因必须带出来：以前一律显示「可以点刷新再试」，用户和排查者永远不知道
  //    是 401 未授权、连不上编排器、上游超时还是空信封，只能反复点一个不会有
  //    任何不同的刷新 —— 就是「刷新后依旧失败」却查不出根因。
  const why = reason ? `（${reason}）` : "";
  return { drop, error: asked ? `行情获取失败，正在重试…${why}` : `行情获取失败，可以点刷新再试${why}` };
}

/** 把异常压成能直接显示给用户的一句话：截断、去换行，不泄露凭据。 */
export function quoteErrorReason(e: unknown, fallback = "原因不明"): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const one = raw.replace(/\s+/g, " ").trim();
  if (!one) return fallback;
  return one.length > 120 ? `${one.slice(0, 117)}…` : one;
}
