// Pure decode/compute functions — no RPC, no DB. Kept separate from worker.js
// so they can be unit tested directly against synthetic logs (see test.js),
// the same approach used to verify the V4 topics before they shipped in
// app/terminal.html.
const { IFACES, priceFromSqrt } = require('./chain');

/** V3 PoolCreated -> new token discovery, or null if not USDC-paired. */
function decodePoolCreatedV3(log, usdcAddr) {
  let p;
  try { p = IFACES.v3Factory.parseLog(log); } catch { return null; }
  const t0 = p.args.token0.toLowerCase(), t1 = p.args.token1.toLowerCase();
  const usdc = usdcAddr.toLowerCase();
  if (t0 !== usdc && t1 !== usdc) return null;
  return {
    token: (t0 === usdc ? p.args.token1 : p.args.token0),
    poolRef: p.args.pool,
    fee: Number(p.args.fee),
    usdcIsToken0: t0 === usdc,
    block: log.blockNumber,
  };
}

/** V4 Initialize -> new token discovery, or null if not USDC-paired. */
function decodeInitializeV4(log, usdcAddr) {
  let p;
  try { p = IFACES.v4PoolManager.parseLog(log); } catch { return null; }
  const c0 = p.args.currency0.toLowerCase(), c1 = p.args.currency1.toLowerCase();
  const usdc = usdcAddr.toLowerCase();
  if (c0 !== usdc && c1 !== usdc) return null;
  return {
    token: (c0 === usdc ? p.args.currency1 : p.args.currency0),
    poolRef: p.args.id,
    fee: Number(p.args.fee),
    usdcIsToken0: c0 === usdc,
    block: log.blockNumber,
  };
}

/** V3 Swap -> a normalized trade row. `token` is the info object returned by
 *  decodePoolCreatedV3 (needs usdcIsToken0 + decimals). amount0/amount1 are
 *  signed: positive = flowed INTO the pool, negative = flowed OUT. */
function decodeSwapV3(log, tokenInfo, usdcDecimals, tokenDecimals, blockTime) {
  let p;
  try { p = IFACES.v3Pool.parseLog(log); } catch { return null; }
  const usdcDelta = tokenInfo.usdcIsToken0 ? p.args.amount0 : p.args.amount1;
  const tokenDelta = tokenInfo.usdcIsToken0 ? p.args.amount1 : p.args.amount0;
  // usdcDelta > 0 means USDC flowed IN to the pool == trader bought the token.
  const side = usdcDelta > 0n ? 'buy' : 'sell';
  const usdcAbs = usdcDelta > 0n ? usdcDelta : -usdcDelta;
  const tokenAbs = tokenDelta > 0n ? tokenDelta : -tokenDelta;
  const dec0 = tokenInfo.usdcIsToken0 ? usdcDecimals : tokenDecimals;
  const dec1 = tokenInfo.usdcIsToken0 ? tokenDecimals : usdcDecimals;
  const pRaw = priceFromSqrt(p.args.sqrtPriceX96, dec0, dec1);
  const price = tokenInfo.usdcIsToken0 ? (pRaw ? 1 / pRaw : 0) : pRaw;
  return {
    trader: p.args.recipient,
    side,
    usdcAmount: Number(usdcAbs) / 10 ** usdcDecimals,
    tokenAmount: Number(tokenAbs) / 10 ** tokenDecimals,
    price,
    block: log.blockNumber,
    blockTime,
    txHash: log.transactionHash,
    logIndex: log.index,
  };
}

/** V4 Swap -> a normalized trade row. amount0/amount1 signs follow the same
 *  convention as V3 (positive = into the pool). */
function decodeSwapV4(log, tokenInfo, usdcDecimals, tokenDecimals, blockTime) {
  let p;
  try { p = IFACES.v4PoolManager.parseLog(log); } catch { return null; }
  if (p.args.id !== tokenInfo.poolRef) return null; // not this pool
  const usdcDelta = tokenInfo.usdcIsToken0 ? p.args.amount0 : p.args.amount1;
  const tokenDelta = tokenInfo.usdcIsToken0 ? p.args.amount1 : p.args.amount0;
  const side = usdcDelta > 0n ? 'buy' : 'sell';
  const usdcAbs = usdcDelta > 0n ? usdcDelta : -usdcDelta;
  const tokenAbs = tokenDelta > 0n ? tokenDelta : -tokenDelta;
  const dec0 = tokenInfo.usdcIsToken0 ? usdcDecimals : tokenDecimals;
  const dec1 = tokenInfo.usdcIsToken0 ? tokenDecimals : usdcDecimals;
  const pRaw = priceFromSqrt(p.args.sqrtPriceX96, dec0, dec1);
  const price = tokenInfo.usdcIsToken0 ? (pRaw ? 1 / pRaw : 0) : pRaw;
  return {
    trader: p.args.sender,
    side,
    usdcAmount: Number(usdcAbs) / 10 ** usdcDecimals,
    tokenAmount: Number(tokenAbs) / 10 ** tokenDecimals,
    price,
    block: log.blockNumber,
    blockTime,
    txHash: log.transactionHash,
    logIndex: log.index,
  };
}

/** ERC-20 Transfer -> a balance delta pair. Amount stays a raw BigInt string
 *  through this layer; decimal adjustment happens at display time, same as
 *  swaps store human units but balances stay exact for correctness. */
function decodeTransfer(log, decimals) {
  let p;
  try { p = IFACES.erc20.parseLog(log); } catch { return null; }
  return {
    from: p.args.from,
    to: p.args.to,
    amount: Number(p.args.value) / 10 ** decimals,
    block: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.index,
  };
}

module.exports = { decodePoolCreatedV3, decodeInitializeV4, decodeSwapV3, decodeSwapV4, decodeTransfer };
