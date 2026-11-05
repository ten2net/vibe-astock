const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const rdb = app.rdb();

// 简化费用模型:佣金 万 2.5(最低 5 元),卖出加收 0.05% 印花税
function calcFee(side, price, volume) {
  const amount = price * volume;
  const commission = Math.max(amount * 0.00025, 5);
  const stamp = side === 'SELL' ? amount * 0.0005 : 0;
  return Math.round((commission + stamp) * 100) / 100;
}

exports.main = async (event) => {
  const { OPENID } = cloudbase.getCloudbaseContext();
  const { action } = event || {};

  if (action === 'list') {
    const res = await rdb
      .from('trades')
      .select('id,code,name,side,price,volume,fee,trade_time,note')
      .eq('openid', OPENID)
      .order('trade_time', { ascending: false })
      .limit(50);
    return { ok: true, list: res.data || [] };
  }

  if (action === 'add') {
    const { code, name, side, price, volume, note } = event;
    if (!code || !name || !['BUY', 'SELL'].includes(side)) {
      return { ok: false, message: '参数不合法:code/name/side' };
    }
    if (!(price > 0) || !(Number.isInteger(volume) && volume > 0 && volume % 100 === 0)) {
      return { ok: false, message: 'A 股买入/卖出数量必须为 100 的整数倍' };
    }
    const fee = calcFee(side, price, volume);
    const res = await rdb.from('trades').insert({
      openid: OPENID,
      code: String(code).trim(),
      name: String(name).trim(),
      side,
      price,
      volume,
      fee,
      trade_time: new Date().toISOString(),
      note: note ? String(note).slice(0, 200) : null,
    });
    if (res.error) return { ok: false, message: res.error.message };
    return { ok: true, fee };
  }

  return { ok: false, message: '未知 action,支持 list / add' };
};
