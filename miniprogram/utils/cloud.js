function call(name, data = {}) {
  return wx.cloud.callFunction({ name, data }).then((res) => {
    const result = res.result || {};
    if (result.ok === false) {
      throw new Error(result.message || `云函数 ${name} 调用失败`);
    }
    return result;
  });
}

module.exports = { call };
