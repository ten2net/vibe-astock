/**
 * 一个接一个跑:上一件回来(成功或失败)再开始下一件。
 * 交易日志的写动作走这里:两个表单同时提交时,后端按点的先后写,最后回来的视图就是最新的,
 * 不会出现「先点的那笔晚回来,把后点的费率盖回旧值」。
 */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}
