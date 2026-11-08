import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBillingHeaders, billingRequestId, clearAccountToken,
  formatPrice, getAccountToken, setAccountToken,
} from '../src/lib/billing-core.ts';

test('account token stays in memory only and can be cleared', () => {
  clearAccountToken();
  assert.equal(getAccountToken(), '');
  setAccountToken('  header.payload.sig  ');
  assert.equal(getAccountToken(), 'header.payload.sig');
  clearAccountToken();
  assert.equal(getAccountToken(), '');
});

test('billing headers keep VR_API_KEY Authorization and put JWT on X-Account-Token', () => {
  const base = { Authorization: 'Bearer vr-key' };
  const h = buildBillingHeaders('jwt-token', base);
  assert.equal(h.Authorization, 'Bearer vr-key');
  assert.equal(h['X-Account-Token'], 'jwt-token');
  // 不修改传入的 base
  assert.deepEqual(base, { Authorization: 'Bearer vr-key' });
});

test('no token means no X-Account-Token header', () => {
  const h = buildBillingHeaders(null, {});
  assert.equal(h['X-Account-Token'], undefined);
});

test('formatPrice converts cents and picks currency symbol', () => {
  assert.equal(formatPrice(2900, 'USD'), '$29.00');
  assert.equal(formatPrice(990, 'USD'), '$9.90');
  assert.equal(formatPrice(29900, 'CNY'), '¥299.00');
  assert.equal(formatPrice(0, 'USD'), '$0.00');
});

test('billingRequestId is 32 lowercase hex (backend pydantic pattern)', () => {
  for (let i = 0; i < 20; i++) {
    assert.match(billingRequestId(), /^[0-9a-f]{32}$/);
  }
});
