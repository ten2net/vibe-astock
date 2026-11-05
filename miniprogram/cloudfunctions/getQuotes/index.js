const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const rdb = app.rdb();

exports.main = async (event) => {
  const { OPENID } = cloudbase.getCloudbaseContext();
  const onlyWatched = Boolean(event.onlyWatched);

  const stocks = await rdb.from('stocks').select('code,name,price,change_pct,updated_at').order('code');

  const watched = await rdb.from('watchlist').select('code').eq('openid', OPENID);

  const watchedSet = new Set((watched.data || []).map((r) => r.code));

  let list = (stocks.data || []).map((s) => ({ ...s, watched: watchedSet.has(s.code) }));
  if (onlyWatched) list = list.filter((s) => s.watched);

  return { ok: true, list };
};
