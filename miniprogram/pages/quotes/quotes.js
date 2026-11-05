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
    return call('getQuotes')
      .then((res) => this.setData({ list: res.list || [], loading: false, error: '' }))
      .catch((e) => this.setData({ error: e.message, loading: false }));
  },

  onToggleWatch(e) {
    const { code, watched } = e.currentTarget.dataset;
    call('toggleWatch', { code, watch: !watched })
      .then((res) => {
        const list = this.data.list.map((s) =>
          s.code === code ? { ...s, watched: res.watched } : s
        );
        this.setData({ list });
        wx.showToast({ title: res.watched ? '已加入自选' : '已移除自选', icon: 'none' });
      })
      .catch((e) => wx.showToast({ title: e.message, icon: 'none' }));
  },
});
