App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    // 环境 ID 为 CloudBase 体验版环境(PG 模式),与小程序 AppID 关联后生效
    wx.cloud.init({
      env: 'shaggy-possum-d7gyhg1we9a1871da',
      traceUser: true,
    });
  },
});
