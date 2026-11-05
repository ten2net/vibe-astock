const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const rdb = app.rdb();

const LEVEL_LABEL = {
  hot: '亢奋',
  warm: '偏热',
  neutral: '平稳',
  cool: '偏冷',
  cold: '冰点',
};

exports.main = async () => {
  const res = await rdb
    .from('review_summaries')
    .select('trade_date,limit_up,limit_down,promotion_rate,emotion_level,summary')
    .order('trade_date', { ascending: false })
    .limit(7);

  const list = (res.data || []).map((r) => ({
    ...r,
    level_label: LEVEL_LABEL[r.emotion_level] || r.emotion_level,
  }));

  return { ok: true, list };
};
