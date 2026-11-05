const { call } = require('../../utils/cloud');

Page({
  data: { list: [], loading: true, error: '' },

  onLoad() {
    call('getReview')
      .then((res) => this.setData({ list: res.list || [], loading: false, error: '' }))
      .catch((e) => this.setData({ error: e.message, loading: false }));
  },
});
