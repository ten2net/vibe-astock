const { call } = require('../../utils/cloud');

Page({
  data: { list: [], loading: true, error: '' },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  load() {
    return call('getQuotes', { onlyWatched: true })
      .then((res) => this.setData({ list: res.list || [], loading: false, error: '' }))
      .catch((e) => this.setData({ error: e.message, loading: false }));
  },

  onRemove(e) {
    const { code } = e.currentTarget.dataset;
    call('toggleWatch', { code, watch: false })
      .then(() => this.load())
      .catch((e2) => wx.showToast({ title: e2.message, icon: 'none' }));
  },
});
