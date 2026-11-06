#!/usr/bin/env node
// 微信小程序 CI 上传:生成体验版/开发版,上传后登录 mp.weixin.qq.com 版本管理里提审发布
// 用法: node scripts/ci-upload.mjs <appid>
// 前置:
//   1. 小程序后台「开发管理 → 开发设置 → 小程序代码上传密钥」下载密钥,命名为 ci/private.<appid>.key 放在本目录
//   2. 同一页面把本机公网 IP 加入「IP 白名单」
//   3. 本机 Node >= 16
import ci from 'miniprogram-ci';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [, , appid] = process.argv;

if (!appid) {
  console.error('用法: node scripts/ci-upload.mjs <appid>');
  process.exit(1);
}

const keyPath = path.join(root, 'ci', `private.${appid}.key`);
if (!fs.existsSync(keyPath)) {
  console.error(`缺少上传密钥: ${keyPath}\n请在小程序后台「开发管理 → 开发设置 → 小程序代码上传密钥」下载后放到该路径。`);
  process.exit(1);
}

const project = new ci.Project({
  appid,
  type: 'miniProgram',
  projectPath: root,
  privateKeyPath: keyPath,
  ignores: ['ci/**', 'node_modules/**', 'scripts/**', 'cloudbase/**'],
});

const result = await ci.upload({
  project,
  version: process.env.CI_VERSION || '1.0.0',
  desc: process.env.CI_DESC || 'Vibe AStock 小程序 v2 基础版(CI 上传)',
  robot: 1,
  threads: 5,
  setting: { es6: true, minify: true, autoPrefixWXSS: true },
  onProgressUpdate: () => {},
});

console.log('上传成功,版本:', result.subPackageInfo ? 'ok' : 'ok');
console.log('下一步: 登录 mp.weixin.qq.com → 版本管理 → 开发版本 → 设为体验版/提交审核');
