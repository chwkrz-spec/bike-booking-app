import { createHash, timingSafeEqual } from 'node:crypto';

const sandboxOrigin = 'https://sandbox.przelewy24.pl';
const currency = 'PLN';

function sign(fields, crc) {
  return createHash('sha384').update(JSON.stringify({ ...fields, crc })).digest('hex');
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label}`);
}

function validSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 100 ||
      sessionId === '.' || sessionId === '..') {
    throw new Error('Invalid sandbox sessionId');
  }
}

function validPayment({ sessionId, amount }) {
  validSessionId(sessionId);
  positiveInteger(amount, 'sandbox payment amount');
}

function callbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href.length > 250) {
    throw new Error('Expected a sandbox callback HTTPS URL');
  }
  return url.href;
}

export function createP24Sandbox({ merchantId, posId, apiKey, crc, marketplaceApiKey }, fetcher = fetch) {
  positiveInteger(merchantId, 'sandbox merchant ID');
  positiveInteger(posId, 'sandbox POS ID');
  if (!apiKey?.trim() || !crc?.trim()) throw new Error('Sandbox API key and CRC are required');

  async function request(method, path, body, { marketplace = false, status = 200 } = {}) {
    const id = marketplace ? merchantId : posId;
    const key = marketplace ? marketplaceApiKey : apiKey;
    if (!key?.trim()) throw new Error('Sandbox Marketplace API key is required');
    const headers = {
      Authorization: `Basic ${Buffer.from(`${id}:${key}`).toString('base64')}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(new URL(`/api/v1/${path}`, sandboxOrigin), {
      method,
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== status) {
      throw new Error(`P24 sandbox ${method} ${path.split('/').slice(0, 2).join('/')} returned HTTP ${response.status}`);
    }
    return response.json();
  }

  async function read(path, options) {
    const response = await request('GET', path, undefined, options);
    if (response.responseCode !== 0 || !response.data) throw new Error('P24 sandbox did not return details');
    return response.data;
  }

  function notificationOrder(payment, notification) {
    validPayment(payment);
    const {
      merchantId: actualMerchantId, posId: actualPosId, sessionId, amount, originAmount,
      currency: actualCurrency, orderId, methodId, statement, sign: actualSign,
    } = notification;
    if (actualMerchantId !== merchantId || actualPosId !== posId || sessionId !== payment.sessionId ||
        amount !== payment.amount || originAmount !== payment.amount || actualCurrency !== currency) {
      throw new Error('Notification does not match the registered sandbox payment');
    }
    positiveInteger(orderId, 'P24 order ID');
    if (!Number.isSafeInteger(methodId) || typeof statement !== 'string') {
      throw new Error('Invalid sandbox notification');
    }
    const expectedSign = sign({
      merchantId, posId, sessionId, amount, originAmount, currency, orderId, methodId, statement,
    }, crc);
    if (typeof actualSign !== 'string' || !/^[a-f0-9]{96}$/i.test(actualSign) ||
        !timingSafeEqual(Buffer.from(actualSign, 'hex'), Buffer.from(expectedSign, 'hex'))) {
      throw new Error('Invalid sandbox notification signature');
    }
    return orderId;
  }

  return {
    notificationOrder,
    async register({ sessionId, amount, urlReturn, urlStatus, timeLimit }) {
      validPayment({ sessionId, amount });
      if (!Number.isSafeInteger(timeLimit) || timeLimit < 1 || timeLimit > 99) {
        throw new Error('Expected a sandbox timeLimit of 1 to 99 minutes');
      }
      const response = await request('POST', 'transaction/register', {
        merchantId, posId, sessionId, amount, currency,
        description: 'Sandbox bike rental',
        email: 'sandbox@example.test',
        country: 'PL',
        language: 'pl',
        urlReturn: callbackUrl(urlReturn),
        urlStatus: callbackUrl(urlStatus),
        timeLimit,
        sign: sign({ sessionId, merchantId, amount, currency }, crc),
      });
      const token = response.data?.token;
      if (response.responseCode !== 0 || typeof token !== 'string' || !/^[a-z0-9_-]+$/i.test(token)) {
        throw new Error('P24 sandbox did not return a checkout token');
      }
      return new URL(`/trnRequest/${token}`, sandboxOrigin).href;
    },
    async verify(payment, notification) {
      const orderId = notificationOrder(payment, notification);
      const { sessionId, amount } = payment;
      const response = await request('PUT', 'transaction/verify', {
        merchantId, posId, sessionId, amount, orderId, currency,
        sign: sign({ sessionId, orderId, amount, currency }, crc),
      });
      if (response.responseCode !== 0 || response.data?.status !== 'success') {
        throw new Error('P24 sandbox did not verify the payment');
      }
      return orderId;
    },
    async dispatch({ batchId, orderId, sessionId, sellerId, amount }) {
      validPayment({ sessionId, amount });
      positiveInteger(batchId, 'sandbox batch ID');
      positiveInteger(orderId, 'P24 order ID');
      positiveInteger(sellerId, 'sandbox submerchant ID');
      const details = [{ orderId, sessionId, sellerId, amount }];
      const response = await request('POST', 'multiStore/dispatchTransaction', { batchId, details }, {
        marketplace: true,
      });
      const result = response.result?.[0];
      if (response.result?.length !== 1 || result?.status !== true || result.orderId !== orderId ||
          result.sessionId !== sessionId || result.sellerId !== sellerId || result.amount !== amount) {
        throw new Error('P24 sandbox did not accept the dispatch');
      }
      positiveInteger(result.orderIdNew, 'P24 dispatched order ID');
      return result.orderIdNew;
    },
    async refund({ requestId, refundsUuid, orderId, sessionId, amount, data, urlStatus }) {
      validPayment({ sessionId, amount });
      positiveInteger(orderId, 'P24 order ID');
      if (typeof requestId !== 'string' || !requestId.trim() ||
          typeof refundsUuid !== 'string' || !refundsUuid.trim()) {
        throw new Error('Expected unique sandbox refund IDs');
      }
      if (!Array.isArray(data) || !data.length) throw new Error('Expected explicit sandbox refund debits');
      const debits = data.map(({ spId, spAmount }) => {
        positiveInteger(spId, 'sandbox refund merchant ID');
        positiveInteger(spAmount, 'sandbox refund debit amount');
        return { spId, spAmount };
      });
      if (new Set(debits.map(({ spId }) => spId)).size !== debits.length ||
          debits.reduce((total, { spAmount }) => total + spAmount, 0) !== amount) {
        throw new Error('Sandbox refund debits must add up to the refund amount with one debit per merchant');
      }
      const body = { requestId, refundsUuid, refunds: [{ orderId, sessionId, amount, data: debits }] };
      if (urlStatus !== undefined) body.urlStatus = callbackUrl(urlStatus);
      const response = await request('POST', 'multiStore/refund', body, { marketplace: true, status: 201 });
      const result = response.data?.[0];
      if (![0, '0'].includes(response.responseCode) || response.data?.length !== 1 || result?.status !== true ||
          result.orderId !== orderId || result.sessionId !== sessionId || result.amount !== amount ||
          result.data?.length !== debits.length ||
          !debits.every(debit => result.data.some(row => row.spId === debit.spId && row.spAmount === debit.spAmount))) {
        throw new Error('P24 sandbox did not accept the submitted refund debits');
      }
    },
    transaction(sessionId) {
      validSessionId(sessionId);
      return read(`transaction/by/sessionId/${encodeURIComponent(sessionId)}`);
    },
    dispatchInfo(orderId) {
      positiveInteger(orderId, 'P24 order ID');
      return read(`multiStore/dispatchInfo/${orderId}`, { marketplace: true });
    },
    refunds(orderId) {
      positiveInteger(orderId, 'P24 order ID');
      return read(`refund/by/orderId/${orderId}`);
    },
    async balance(id) {
      positiveInteger(id, 'sandbox balance merchant ID');
      const response = await request('GET', `multiStore/funds?merchantId=${id}`, undefined, { marketplace: true });
      if (response.code !== 200 || !Number.isSafeInteger(response.result)) {
        throw new Error('P24 sandbox did not return a balance');
      }
      return response.result;
    },
  };
}

export function p24SandboxFromEnv() {
  return createP24Sandbox({
    merchantId: Number(process.env.P24_SANDBOX_MERCHANT_ID),
    posId: Number(process.env.P24_SANDBOX_POS_ID),
    apiKey: process.env.P24_SANDBOX_API_KEY,
    crc: process.env.P24_SANDBOX_CRC,
    marketplaceApiKey: process.env.P24_SANDBOX_MARKETPLACE_API_KEY,
  });
}
