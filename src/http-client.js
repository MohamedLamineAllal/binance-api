import crypto from 'crypto'
import zip from 'lodash.zipobject'

import 'isomorphic-fetch'

const BASE = 'https://api.binance.com'
const FUTURE_BASE = 'https://fapi.binance.com';
const API_PATH_BASE = 'api';
const FUTURES_API_PATH_BASE = 'fapi';

const defaultGetTime = () => Date.now()

/**
 * Build query string for uri encoded url based on json object
 */
const makeQueryString = q =>
  q
    ? `?${Object.keys(q)
        .filter(k => !!q[k])
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(q[k])}`)
        .join('&')}`
    : ''

/**
 * Finalize API response
 */
const sendResult = call =>
  call.then(res => {
    // If response is ok, we can safely assume it is valid JSON
    // TODO: add headers easy access
    if (res.ok) {
      return res.json()
    }

    // Errors might come from the API itself or the proxy Binance is using.
    // For API errors the response will be valid JSON,but for proxy errors
    // it will be HTML
    return res.text().then(text => {
      let error;
      try {
        const json = JSON.parse(text)
        // The body was JSON parsable, assume it is an API response error
        error = new Error(json.msg || `${res.status} ${res.statusText}`)
        error.code = json.code
      } catch (e) {
        // The body was not JSON parsable, assume it is proxy error
        error = new Error(`${res.status} ${res.statusText} ${text}`)
        error.response = res
        error.responseText = text
      }
      throw error
    })
  })

/**
 * Util to validate existence of required parameter(s)
 */
const checkParams = (name, payload, requires = []) => {
  if (!payload) {
    throw new Error('You need to pass a payload object.')
  }

  requires.forEach(r => {
    if (!payload[r] && isNaN(payload[r])) {
      throw new Error(`Method ${name} requires ${r} parameter.`)
    }
  })

  return true
}

/**
 * Make public calls against the api
 *
 * @param {string} path Endpoint path
 * @param {object} data The payload to be sent
 * @param {string} method HTTB VERB, GET by default
 * @param {object} headers
 * @returns {object} The api response
 */
const publicCall = ({ base, apiPathBase }) => ({
  path,
  data,
  method = 'GET',
  headers = {},
  agent
}) =>
  sendResult(
    fetch(`${base}/${apiPathBase}${path}${makeQueryString(data)}`, {
      method,
      json: true,
      headers,
      agent
    }),
  )

/**
 * Factory method for partial private calls against the api
 *
 * @param {string} path Endpoint path
 * @param {object} data The payload to be sent
 * @param {string} method HTTB VERB, GET by default
 * @param {http.Agent} object http Agent object (can be used to setup proxy use) 
 * @returns {object} The api response
 */
const keyCall = ({ apiKey, pubCall }) => ({
  path,
  data,
  method = 'GET',
  agent
}) => {
  if (!apiKey) {
    throw new Error('You need to pass an API key to make this call.')
  }

  return pubCall({
    path,
    data,
    method,
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
    agent
  })
}

/**
 * Factory method for private calls against the api
 *
 * @param {string} path Endpoint path
 * @param {object} data The payload to be sent
 * @param {string} method HTTB VERB, GET by default
 * @param {object} headers
 * @returns {object} The api response
 */
const privateCall = ({ apiKey, apiSecret, base, apiPathBase, getTime = defaultGetTime, pubCall }) => ({
    path,
    data = {},
    method = 'GET',
    noData,
    noExtra,
    agent
}) => {
  if (!apiKey || !apiSecret) {
    throw new Error('You need to pass an API key and secret to make authenticated calls.')
  }

  return (data && data.useServerTime
    ? pubCall({ path: '/v1/time', agent }).then(r => r.serverTime)
    : Promise.resolve(getTime())
  ).then(timestamp => {
    if (data) {
      delete data.useServerTime
    }

    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(makeQueryString({ ...data, timestamp }).substr(1))
      .digest('hex')

    const newData = noExtra ? data : { ...data, timestamp, signature }

    return sendResult(
      fetch(
        `${base}${(path.includes('/wapi') || path.includes('/sapi')) ? '' : `/${apiPathBase}`}${path}${noData
          ? ''
          : makeQueryString(newData)}`,
        {
          method,
          headers: { 'X-MBX-APIKEY': apiKey },
          json: true,
          agent
        },
      ),
    )
  })
}

export const candleFields = [
  'openTime',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'closeTime',
  'quoteAssetVolume', // TODO: update the doc
  'trades',
  'buyBaseAssetVolume',
  'buyQuoteAssetVolume'
]

/**
 * Get candles for a specific pair and interval and convert response
 * to a user friendly collection.
 */
const candles = (pubCall, payload, agent) =>
  pubCall({ path: '/v1/klines', data: payload, agent }).then(candles =>
    candles.map(candle => zip(candleFields, candle)),
  )

/**
 * Create a new order wrapper for market order simplicity
 */
const order = (privCall, payload = {}, url, agent) => {
  const newPayload =
    (['LIMIT', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT_LIMIT'].includes(payload.type) || !payload.type) // TODO: check
      ? { timeInForce: 'GTC', ...payload }
      : payload
  return checkParams('order', newPayload, ['symbol', 'side', 'quantity']) && privCall({
    path: url, data: { type: 'LIMIT', ...newPayload }, method: 'POST', agent }) // TODO: check params
}

/**
 * Zip asks and bids response from order book
 */
const book = (pubCall, payload, agent) =>
  pubCall({ path: '/v1/depth', data: payload, agent }).then(({ lastUpdateId, asks, bids }) => ({
    lastUpdateId,
    asks: asks.map(a => zip(['price', 'qty'], a)),
    bids: bids.map(b => zip(['price', 'qty'], b)),
  }))

const aggTrades = (pubCall, payload, agent) =>
  pubCall({ path: '/v1/aggTrades', data: payload, agent }).then(trades =>
    trades.map(trade => ({
      aggId: trade.a,
      price: trade.p,
      qty: trade.q,
      firstTradeId: trade.f, // TODO: change the doc (And Exchange api)
      lastTradeId: trade.l,
      time: trade.T,
      isBuyerMaker: trade.m
    })),
  )



const futuresCandles = candles;
/**
 * Create a new order wrapper for market order simplicity
 */
const futuresOrder = (privCall, payload = {}, url, agent) => {
  const newPayload =
    (['LIMIT', 'STOP', 'TAKE_PROFIT'].includes(payload.type) || !payload.type) // TODO: TO CHECK
      ? { timeInForce: 'GTC', ...payload }
      : payload

  if (!payload.type) payload.type = 'LIMIT';

  if (payload.type && payload.type === 'MARKET' && payload.timeInForce) {
    throw new Error('timeInForce parameter cannot be send with type MARKET');
  }

  return (
    checkParams('futuresOrder', newPayload, [
      'symbol',
      'side',
      'type',
      'quantity',
      ...((payload.type && payload.type === 'LIMIT' && ['price', 'timeInForce']) || []),
      ...((payload.type && ['STOP', 'TAKE_PROFIT'].includes(payload.type) && ['price', 'stopPrice']) || []),
      ...((payload.type && ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(payload.type) && ['stopPrice']) || []),
    ]) &&
    privCall({ path: url, data: newPayload, method: 'POST', agent })
  )
}
const futuresBook = book;
const futuresAggTrades = aggTrades;


export default opts => {
  const base = opts && opts.httpBase || BASE;
  const futureBase = opts && opts.httpFutureBase || FUTURE_BASE;
  const pubCall = publicCall({ ...opts, base, apiPathBase: API_PATH_BASE })
  const privCall = privateCall({ ...opts, base, apiPathBase: API_PATH_BASE, pubCall })
  const kCall = keyCall({ ...opts, pubCall })
  const futuresPubCall = publicCall({ ...opts, base: futureBase, apiPathBase: FUTURES_API_PATH_BASE });
  const futuresPrivCall = privateCall({ ...opts, base: futureBase, apiPathBase: FUTURES_API_PATH_BASE, pubCall: futuresPubCall });
  const futuresKCall = keyCall({ ...opts, pubCall: futuresPubCall });

  return {
    // _______________________________________ normal binance api
    ping: (agent) => pubCall({ path: '/v1/ping', agent }).then(() => true),
    time: (agent) => pubCall({ path: '/v1/time', agent }).then(r => r.serverTime),
    exchangeInfo: (agent) => pubCall({ path: '/v3/exchangeInfo', agent }),
    book: (payload, agent) => checkParams('book', payload, ['symbol']) && book(pubCall, payload, agent),
    trades: (payload, agent) => checkParams('trades', payload, ['symbol']) && pubCall({ path: '/v1/trades', data: payload,  agent }),
    tradesHistory: (payload, agent) => checkParams('tradesHistory', payload, ['symbol']) && kCall({ path: '/v1/historicalTrades', data: payload, agent }),
    aggTrades: (payload, agent) => checkParams('aggTrades', payload, ['symbol']) && aggTrades(pubCall, payload, agent),
    candles: (payload, agent) => checkParams('candles', payload, ['symbol', 'interval']) &&  candles(pubCall, payload, agent),
    dailyStats: (payload, agent) => pubCall({ path: '/v1/ticker/24hr', data: payload, agent }),
    prices: (agent) =>
      pubCall({ path: '/v1/ticker/allPrices',  agent }).then(r =>
        r.reduce((out, cur) => ((out[cur.symbol] = cur.price), out), {}),
      ),
    avgPrice: (payload, agent) => pubCall({ path: '/v3/avgPrice', data: payload, agent }),
    allBookTickers: (agent) =>
      pubCall({ path: '/v1/ticker/allBookTickers', agent }).then(r =>
        r.reduce((out, cur) => ((out[cur.symbol] = cur), out), {}),
      ),
    order: (payload, agent) => order(privCall, payload, '/v3/order', agent),
    orderTest: (payload, agent) => order(privCall, payload, '/v3/order/test', agent),
    getOrder: (payload, agent) => privCall({
      path: '/v3/order', data: payload, method: 'GET', agent }),
    cancelOrder: (payload, agent) => privCall({
      path: '/v3/order', data: payload, method: 'DELETE', agent }),
    openOrders: (payload, agent) => privCall({
      path: '/v3/openOrders', data: payload, method: 'GET', agent }), // TODO: to check (cancel)
    allOrders: (payload, agent) => privCall({
      path: '/v3/allOrders', data: payload, method: 'GET', agent }),
    accountInfo: (payload, agent) => privCall({
      path: '/v3/account', data: payload, method: 'GET', agent }),
    myTrades:  (payload, agent) => privCall({
      path: '/v3/myTrades', data: payload, method: 'GET', agent }),
    withdraw: (payload, agent) => privCall({
      path: '/wapi/v3/withdraw.html', data: payload, method: 'POST', agent }),
    withdrawHistory: (payload, agent) => privCall({ path: '/wapi/v3/withdrawHistory.html', data: payload, method: 'GET', agent }),
    depositHistory: (payload, agent) => privCall({ path: '/wapi/v3/depositHistory.html', data: payload, method: 'GET', agent }),
    depositAddress: (payload, agent) => privCall({ path: '/wapi/v3/depositAddress.html', data: payload, method: 'GET', agent }),
    tradeFee: (payload, agent) => privCall({ path: '/wapi/v3/tradeFee.html', data: payload, method: 'GET', agent }).then(res => res.tradeFee),
    assetDetail: (payload, agent) => privCall({ path: '/wapi/v3/assetDetail.html', data: payload, method: 'GET', agent }),
    getDataStream: (agent) => privCall({ path: '/v1/userDataStream', data: null, method: 'POST', noData: true, agent }),
    keepDataStream: (payload, agent) => privCall({ path: '/v1/userDataStream', data: payload, method: 'PUT', noData: false, noExtraData: true, agent }),
    closeDataStream: (payload, agent) => privCall({ path: '/v1/userDataStream', data: payload, method: 'DELETE', noData: false, noExtraData: true, agent }),

    // ______________________________________ futures binance api

    futuresPing: (agent) => futuresPubCall({ path: '/v1/ping', method: 'GET', agent }).then(() => true),
    futuresTime: (agent) => futuresPubCall({ path: '/v1/time', method: 'GET', agent }).then(r => r.serverTime),
    futuresExchangeInfo: (agent) => futuresPubCall({ path: '/v1/exchangeInfo', method: 'GET', agent }),
    futuresBook: (payload, agent) => checkParams('futuresBook', payload, ['symbol']) && futuresBook(futuresPubCall, payload, agent),
    futuresTrades: (payload, agent) => checkParams('futuresTrades', payload, ['symbol']) && futuresPubCall({ path: '/v1/trades', method: 'GET', data: payload, agent }),
    futuresTradesHistory: (payload, agent) => checkParams('futuresTradesHistory', payload, ['symbol']) && futuresKCall({ path: '/v1/historicalTrades', method: 'GET', data: payload, agent }),
    futuresAggTrades: (payload, agent) => checkParams('futuresAggTrades', payload, ['symbol']) && futuresAggTrades(futuresPubCall, payload, agent),
    futuresCandles: (payload, agent) => checkParams('futuresCandles', payload, ['symbol', 'interval']) && futuresCandles(futuresPubCall, payload, agent),
    // ______________ futures exclusive
    futuresChangePositionMode: (payload, agent) => checkParams('futuresChangePositionMode', payload, ['dualSidePosition']) && futuresPrivCall({ path: '/v1/positionSide/dual', data: { ...payload, dualSidePosition: payload.dualSidePosition? 'true': 'false'}, method: 'POST',  agent }),
    futuresGetPositionMode: (payload, agent) => futuresPrivCall({ path: '/v1/positionSide/dual', data: payload, method: 'GET', agent }),

    futuresMarkPrice: (payload, agent) => futuresPubCall({ path: '/v1/premiumIndex', data: payload, method: 'GET', agent }),
    futuresFundingRate: (payload, agent) => checkParams('futuresFundingRate', payload, ['symbol']) && futuresKCall({ path: '/v1/fundingRate', data: payload, method: 'GET', agent }),
    futuresDailyStats: (payload, agent) => futuresPubCall({ path: '/v1/ticker/24hr', data: payload, method: 'GET', agent }),
    futuresPrice: (payload, agent) =>
      futuresPubCall({ path: '/v1/ticker/price', data: payload, method: 'GET', agent }).then(r =>
        Array.isArray(r) ?
          (
            (payload.reduce && r.reduce((out, cur) => ((out[cur.symbol] = cur.price), out), {})) || r
          ):
          r // TODO: docs
      ), // TODO: verify that adding reduce to the payload doesn't cause a problem
    // futuresAvgPrice: payload => futuresPubCall('/v3/avgPrice', payload),
    futuresBookTicker: (payload, agent) =>
      futuresPubCall({path: '/v1/ticker/bookTicker', data: payload, method: 'GET', agent }).then(r =>
        (
          payload.reduce && Array.isArray(r) && 
          r.reduce((out, cur) => ((out[cur.symbol] = cur), out), {})
        ) || r // TODO: docs
      ),
    futuresAllForceOrders: (payload, agent) => futuresPubCall({path: '/v1/allForceOrders', data: payload, method: 'GET', agent }),
    futuresOpenInterest: (payload, agent) => checkParams('futuresOpenInterest', payload, ['symbol']) && futuresPubCall({path: '/v1/openInterest', data: payload, method: 'GET', agent }),
    futuresLeverageBracket: (payload, agent) => futuresPubCall({path: '/v1/leverageBracket', data: payload, method: 'GET', agent }).then(r => 
        Array.isArray(r) ?
          (
            (payload.reduce && r.reduce((out, cur) => ((out[cur.symbol] = cur.brackets), out), {}) || r)
          ):
          r.brackets // TODO: docs
    ),
    futuresAccountTransfer: (payload, agent) => checkParams('futuresAccountTransfer', payload, ['asset', 'amount', 'type']) && privCall({path: '/sapi/v1/futures/transfer ', data: payload, method: 'POST', agent }),
    // eslint-disable-next-line id-length
    futuresAccountTransactionHistory: (payload, agent) => checkParams('futuresAccountTransactionHistory', payload, ['asset', 'startTime']) && privCall({ path: '/sapi/v1/futures/transfer', data: payload, method: 'GET', agent }),
    futuresOrder: (payload, agent) => futuresOrder(futuresPrivCall, payload, '/v1/order', agent),
    futuresOrderTest: (payload, agent) => futuresOrder(futuresPrivCall, payload, '/v3/order/test', agent), // TODO: remove
    futuresBatchOrders: (payload, agent) => checkParams('futuresBatchOrders', payload, ['batchOrders']) && futuresPrivCall({ path: '/v1/batchOrders', data: payload, method: 'POST', agent }),
    futuresGetOrder: (payload, agent) => checkParams('futuresQueryOrder', payload, ['symbol']) && futuresPrivCall({ path: '/v1/order', data: payload, agent }),
    futuresCancelOrder: (payload, agent) => checkParams('futuresCancelOrder', payload, ['symbol']) && futuresPrivCall({ path: '/v1/order', data: payload, method: 'DELETE', agent }),
    futuresCancelAllOpenOrders: (payload, agent) => checkParams('futuresCancelOrder', payload, ['symbol']) && futuresPrivCall({ path: '/v1/allOpenOrders', data: payload, method: 'DELETE', agent }),
    futuresCancelMultipleOrders: (payload, agent) => checkParams('futuresCancelMultipleOrders', payload, ['symbol']) && futuresPrivCall({ path: '/v1/batchOrders', data: payload, method: 'DELETE', agent }),
    futuresCountDownCancelAllOrders: (payload, agent) => checkParams('futuresCountDownCancelAllOrders', payload, ['symbol', 'countdownTime']) && futuresPrivCall({ path: '/v1/countdownCancelAll', data: payload, method: 'POST', agent }),
    futuresGetOpenOrder: (payload, agent) => checkParams('futuresGetOpenOrder', payload, ['symbol']) && futuresPrivCall({ path: '/v1/openOrder', data: payload, method: 'GET', agent }),
    futuresGetAllOpenOrders: (payload, agent) => futuresPrivCall({ path: '/v1/openOrders', data: payload, method: 'GET', agent }),
    futuresGetAllOrders: (payload, agent) => checkParams('futuresGetAllOrders', payload, ['symbol']) && futuresPrivCall({ path: '/v1/allOrders', data: payload, method: 'GET', agent }),
    futuresAccountBalance: (payload, agent) => futuresPrivCall({ path: '/v2/balance', data: payload, method: 'GET', agent }),
    futuresAccountInfo: (payload, agent) => futuresPrivCall({ path: '/v2/account', data: payload, method: 'GET', agent }),
    futuresChangeLeverage: (payload, agent) => checkParams('futuresChange<Leverage', payload, ['symbol', 'leverage']) && futuresPrivCall({ path: '/v1/leverage', data: payload, method: 'POST', agent }),
    futuresChangeMarginType: (payload, agent) => checkParams('futuresChangeMarginType', payload, ['symbol', 'marginType']) && futuresPrivCall({ path: '/v1/marginType', data: payload, method: 'POST', agent }),
    futuresModifyPositionMargin: (payload, agent) => checkParams('futuresModifyPositionMargin', payload, ['symbol', 'amount']) && futuresPrivCall({ path: '/v1/positionMargin', data: payload, method: 'POST', agent }),
    futuresPositionMarginHistory: (payload, agent) => checkParams('futuresPositionMarginHistory', payload, ['symbol']) && futuresPrivCall({ path: '/v1/positionMargin/history', data: payload, method: 'GET', agent }),
    futuresPositionRisk: (payload, agent) => futuresPrivCall({ path: '/v1/positionRisk', data: payload, method: 'GET', agent }),
    futuresUserTrades: (payload, agent) => checkParams('futuresUserTrades', payload, ['symbol']) && futuresPrivCall({ path: '/v1/userTrades', data: payload, method: 'GET', agent }),
    futuresIncomeHistory: (payload, agent) => futuresPrivCall({ path: '/v1/income', data: payload, method: 'GET', agent }),
    futuresGetUserDataStream: (payload, agent) => futuresPrivCall({ path: '/v1/listenKey', data: payload, method: 'POST', noData: true, agent }),
    futuresKeepUserDataStream: (payload, agent) => futuresPrivCall({ path: '/v1/listenKey', data: payload, method: 'PUT', noData: false, noExtraData: true, agent }),
    futuresCloseUserDataStream: (payload, agent) => futuresPrivCall({ path: '/v1/listenKey', data: payload, method: 'DELETE', noData: false, noExtraData: true, agent })
  }
}


/**
 * TODO: think about adding easy wait access (of every end point) (see local caching too)
 */
