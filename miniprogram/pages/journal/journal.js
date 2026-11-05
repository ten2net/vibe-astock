const { call } = require('../../utils/cloud');

Page({
  data: {
    list: [],
    loading: true,
    error: '',
    showForm: false,
    form: { code: '', name: '', side: 'BUY', price: '', volume: '', note: '' },
  },

  onShow() {
    this.load();
  },

  load() {
    return call('tradeLog', { action: 'list' })
      .then((res) => this.setData({ list: res.list || [], loading: false, error: '' }))
      .catch((e) => this.setData({ error: e.message, loading: false }));
  },

  onToggleForm() {
    this.setData({ showForm: !this.data.showForm });
  },

  onInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  onSideChange(e) {
    this.setData({ 'form.side': e.detail.value });
  },

  onSubmit() {
    const { code, name, price, volume } = this.data.form;
    if (!code || !name || !price || !volume) {
      wx.showToast({ title: '请填写完整:代码/名称/价格/数量', icon: 'none' });
      return;
    }
    call('tradeLog', { action: 'add', ...this.data.form, price: Number(price), volume: Number(volume) })
      .then(() => {
        wx.showToast({ title: '已记录' });
        this.setData({ showForm: false, form: { code: '', name: '', side: 'BUY', price: '', volume: '', note: '' } });
        this.load();
      })
      .catch((e) => wx.showToast({ title: e.message, icon: 'none' }));
  },
});
