import { Home, Radio, Swords, Eye, LineChart, Briefcase, FlaskConical } from 'lucide-react';
// Primary navigation follows daily workflows; existing deep links remain valid.
export const MODULES = [
  { title: '首页', to: '/', icon: Home, pages: [{ to: '/', title: '首页' }] },
  { title: '盯盘', to: '/daily-review', icon: Eye, pages: [
    { to: '/daily-review', title: '盘面数据' }, { to: '/watch', title: '实时动态' },
    { to: '/yesterday-ladder', title: '昨日梯队' }, { to: '/agent/intraday', title: '盘中核验' },
  ] },
  { title: '复盘', to: '/agent/review', icon: Swords, pages: [
    { to: '/agent/review', title: '复盘报告' }, { to: '/first-board', title: '首板分析' },
    { to: '/heat', title: '近5天热度' }, { to: '/backtest', title: '历史统计' },
  ] },
  { title: '资讯雷达', to: '/intel', icon: Radio, pages: [{ to: '/intel', title: '资讯雷达' }] },
  { title: '个股研究', to: '/stock-data', icon: LineChart, pages: [
    { to: '/stock-data', title: '个股研究' }, { to: '/agent/deepdive', title: '多空辩论' },
  ] },
  { title: '回测', to: '/backtest-agent', icon: FlaskConical, pages: [{ to: '/backtest-agent', title: '回测' }] },
  { title: '我的股票', to: '/my-stocks', icon: Briefcase, pages: [
    { to: '/my-stocks', title: '持仓自选' }, { to: '/journal', title: '交易日志' }, { to: '/notes', title: '研究记录' },
  ] },
];
export function navigationPath(pathname: string) {
  return ['/portfolio', '/watchlist'].includes(pathname) ? '/my-stocks' : pathname;
}
export function moduleFor(pathname: string) {
  return MODULES.find(module => module.pages.some(page => page.to === navigationPath(pathname)));
}

// These legacy identities are persisted in conversation records and browser recovery keys.
// Keep them stable when navigation labels change; never migrate by display title.
const CHAT_PAGES: Record<string, string> = {
  '/notes': '研究记录',
  '/': '首页', '/intel': '资讯雷达', '/agent/review': '复盘看板',
  '/daily-review': '盘面数据', '/first-board': '首板分析', '/heat': '近5天热度',
  '/backtest': '涨停样本统计', '/watch': '盯盘', '/agent/intraday': '盘中核验',
  '/stock-data': '个股数据', '/agent/deepdive': '个股深挖',
  '/portfolio': '持仓股', '/watchlist': '自选股', '/journal': '交易日志',
  '/settings': '接入 AI', '/account': '账号与订阅', '/my-stocks': '我的股票',
  '/yesterday-ladder': '昨日梯队', '/backtest-agent': '策略回测',
};
export function chatPageFor(pathname: string) { return CHAT_PAGES[pathname] ?? '工作空间'; }
