import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KeyRound, RefreshCw, Sparkles, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  BillingError, billingApi, billingRequestId, clearAccountToken,
  formatPrice, getAccountToken, setAccountToken,
  type Entitlement, type Product, type TurnStatus,
} from '@/lib/billing-api';

const TERMINAL = new Set(['complete', 'incomplete', 'failed', 'cancelled']);

function message(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

export function Account() {
  const [params] = useSearchParams();
  const returnedOrder = params.get('order_id');

  // 账号 JWT：只存内存，不落 localStorage（设计文档 §11）。
  const [tokenInput, setTokenInput] = useState(getAccountToken());
  const [tokenSaved, setTokenSaved] = useState(!!getAccountToken());

  const [products, setProducts] = useState<Product[]>([]);
  const [productsError, setProductsError] = useState('');
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [entError, setEntError] = useState('');
  const [buying, setBuying] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [turn, setTurn] = useState<TurnStatus | null>(null);
  const [explaining, setExplaining] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadProducts = useCallback(async () => {
    setProductsError('');
    try {
      const r = await billingApi.products();
      setProducts(r.products);
    } catch (e) {
      setProductsError(message(e));
    }
  }, []);

  const loadEntitlement = useCallback(async () => {
    setEntError('');
    if (!getAccountToken()) {
      setEntitlement(null);
      return;
    }
    try {
      setEntitlement(await billingApi.entitlement());
    } catch (e) {
      if (e instanceof BillingError && e.status === 401) setTokenSaved(false);
      setEntError(message(e));
      setEntitlement(null);
    }
  }, []);

  useEffect(() => {
    void loadProducts();
    void loadEntitlement();
  }, [loadProducts, loadEntitlement]);

  // 组件卸载时停掉轮询，避免向已卸载组件 setState。
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const saveToken = () => {
    setAccountToken(tokenInput);
    setTokenSaved(!!getAccountToken());
    toast.success(getAccountToken() ? '账号令牌已载入（仅本次会话）' : '已清除账号令牌');
    void loadEntitlement();
  };

  const dropToken = () => {
    clearAccountToken();
    setTokenInput('');
    setTokenSaved(false);
    setEntitlement(null);
    toast.success('已清除账号令牌');
  };

  const buy = async (productId: string) => {
    if (!tokenSaved) {
      toast.error('请先填写账号令牌');
      return;
    }
    setBuying(productId);
    try {
      const r = await billingApi.checkout(productId);
      // 收银台是 Waffo 托管页；支付成功以验签 Webhook 为准，不靠前端跳转判定。
      // 跳走前留个提示，回来后用户需手动刷新额度。
      window.location.assign(r.checkout_url);
    } catch (e) {
      toast.error(message(e));
      setBuying(null);
    }
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const explain = async () => {
    const q = question.trim();
    if (!q) {
      toast.error('请输入要解读的问题');
      return;
    }
    if (!tokenSaved) {
      toast.error('请先填写账号令牌');
      return;
    }
    setExplaining(true);
    setTurn(null);
    stopPolling();
    try {
      const r = await billingApi.explain(q, billingRequestId());
      toast.success(`已发起解读（扣 ${r.charged_credits} 额度）`);
      void loadEntitlement();
      // 轮询终态；Manager.submit 是异步的，前端只轮询、不阻塞。
      pollRef.current = setInterval(async () => {
        try {
          const t = await billingApi.turn(r.turn_id);
          setTurn(t);
          if (TERMINAL.has(t.status)) {
            stopPolling();
            setExplaining(false);
            if (t.status === 'failed' || t.status === 'cancelled') toast.error(t.error || '解读未完成');
          }
        } catch (e) {
          stopPolling();
          setExplaining(false);
          toast.error(message(e));
        }
      }, 1500);
    } catch (e) {
      setExplaining(false);
      toast.error(message(e));
      if (e instanceof BillingError && e.status === 402) void loadEntitlement();
    }
  };

  return <div className="space-y-6">
    <PageHeader title="账号与订阅" subtitle="v2 Pro · 托管 AI 额度与订阅。付费状态以服务端为准，本机不缓存。" />

    {returnedOrder && <div role="status" className="glass rounded-2xl border-l-4 border-l-primary p-4 text-sm">
      已从收银台返回（订单 {returnedOrder.slice(0, 8)}…）。支付成功以验签回调为准，额度到账可能有短暂延迟——请点下方「刷新额度」确认。
    </div>}

    {/* 账号令牌：独立头 X-Account-Token，仅内存，不与 VR_API_KEY 冲突 */}
    <section className="glass rounded-2xl p-5">
      <h2 className="mb-1 flex items-center gap-2 font-semibold"><KeyRound size={16} />账号令牌</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        服务端签发的短期 JWT，走 <code>X-Account-Token</code> 头；只保存在本次页面内存，刷新即失效、不写入浏览器存储。
        后端的访问密钥（VR_API_KEY）仍在「接入 AI」页单独配置，二者互不冲突。
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          type="password" value={tokenInput} onChange={e => setTokenInput(e.target.value)}
          placeholder="粘贴账号 JWT" aria-label="账号令牌"
          className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2"
        />
        <button type="button" onClick={saveToken} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground">载入</button>
        <button type="button" onClick={dropToken} className="rounded-lg border border-border px-4 py-2">清除</button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">当前状态：{tokenSaved ? '已载入令牌' : '未载入'}</p>
    </section>

    {/* 额度 */}
    <section className="glass rounded-2xl p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold"><Wallet size={16} />我的额度</h2>
        <button type="button" onClick={() => void loadEntitlement()} aria-label="刷新额度"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted">
          <RefreshCw size={13} />刷新额度
        </button>
      </div>
      {entError && <p role="alert" className="text-sm text-destructive">{entError}</p>}
      {!entError && !entitlement && <p className="text-sm text-muted-foreground">载入账号令牌后显示额度。</p>}
      {entitlement && <div className="flex flex-wrap gap-6 text-sm">
        <div><span className="text-muted-foreground">剩余额度</span><p className="text-xl font-semibold tabular-nums">{entitlement.credits.toLocaleString()}</p></div>
        <div><span className="text-muted-foreground">等级</span><p className="text-xl font-semibold">{entitlement.tier === 'pro' ? 'Pro' : '社区版'}</p></div>
        {entitlement.expires_at && <div><span className="text-muted-foreground">到期</span><p className="text-sm">{entitlement.expires_at}</p></div>}
      </div>}
    </section>

    {/* 商品 */}
    <section className="glass rounded-2xl p-5">
      <h2 className="mb-3 font-semibold">订阅与积分包</h2>
      {productsError && <p role="alert" className="text-sm text-destructive">{productsError}</p>}
      {!productsError && products.length === 0 && <p className="text-sm text-muted-foreground">商品加载中，或付费功能未启用。</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {products.map(p => <div key={p.product_id} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-2">
            <div><p className="font-medium">{p.label}</p><p className="text-xs text-muted-foreground">{p.kind === 'subscription' ? '订阅' : '一次性'} · {p.credits.toLocaleString()} 额度</p></div>
            <span className="text-lg font-semibold tabular-nums">{formatPrice(p.price_cents, p.currency)}</span>
          </div>
          <button type="button" disabled={!tokenSaved || buying !== null} onClick={() => void buy(p.product_id)}
            className="mt-3 w-full rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
            {buying === p.product_id ? '正在创建收银台…' : '购买'}
          </button>
        </div>)}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">价格由服务端商品表确定，收银台由 Waffo 托管；支付成功后额度自动到账。</p>
    </section>

    {/* 托管 AI 解读 */}
    <section className="glass rounded-2xl p-5">
      <h2 className="mb-1 flex items-center gap-2 font-semibold"><Sparkles size={16} />托管 AI 解读</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        用 Pro 托管额度发起一次受控解读（服务端注入模型、无工具/联网、产品政策拦截）。每次调用扣固定额度。
        本产品不输出投资建议、买卖动作或仓位指令。
      </p>
      <textarea value={question} onChange={e => setQuestion(e.target.value)} maxLength={2000} rows={3}
        placeholder="例如：解释一下今日盘面的资金结构" aria-label="解读问题"
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm" />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={() => void explain()} disabled={!tokenSaved || explaining}
          className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
          {explaining ? '解读中…' : '发起解读'}
        </button>
        {explaining && <span role="status" className="text-xs text-muted-foreground">已提交，正在等待结果…</span>}
      </div>
      {turn && <div role="status" className="mt-3 rounded-lg border border-border bg-card p-3 text-sm">
        <p className="mb-1 text-xs text-muted-foreground">回合状态：{turn.status}</p>
        {turn.error && <p className="text-destructive">{turn.error}</p>}
        {turn.result !== undefined && <pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(turn.result, null, 2)}</pre>}
      </div>}
    </section>
  </div>;
}
