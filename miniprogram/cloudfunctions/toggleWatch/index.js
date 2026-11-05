const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const rdb = app.rdb();

exports.main = async (event) => {
  const { OPENID } = cloudbase.getCloudbaseContext();
  const { code, watch } = event || {};

  if (!code || typeof watch !== 'boolean') {
    return { ok: false, message: '参数缺失:code / watch' };
  }

  let res;
  if (watch) {
    res = await rdb.from('watchlist').upsert({ openid: OPENID, code }, { onConflict: 'openid,code' });
  } else {
    res = await rdb.from('watchlist').delete().eq('openid', OPENID).eq('code', code);
  }
  if (res.error) return { ok: false, message: res.error.message };

  return { ok: true, watched: watch };
};
