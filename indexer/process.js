// Pure decode/compute functions — no RPC, no DB. Kept separate from worker.js
// so they can be unit tested directly against synthetic logs (see test.js),
// the same approach used to verify the V4 topics before they shipped in
// app/terminal.html.
const { ethers } = require('ethers');
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

/** ArclitePump TokenCreated → launch_tokens row. */
function decodeTokenCreated(log, blockTime) {
  let p;
  try { p = IFACES.pump.parseLog({ topics: [...log.topics], data: log.data }); } catch { return null; }
  if (!p || p.name !== 'TokenCreated') return null;
  return {
    address: p.args.token.toLowerCase(), creator: p.args.creator.toLowerCase(),
    name: String(p.args.name || ''), symbol: String(p.args.symbol || ''),
    block: log.blockNumber, blockTime,
  };
}

/** ArclitePump Bought / Sold → launch_trades row. Native USDC is 18dp on
 *  Arc (it is the gas token), unlike the 6dp ERC-20 the Uniswap side uses —
 *  the 10^12 trap from AUDIT.md §2.1, handled here by formatting with 18. */
function decodeLaunchTrade(log, blockTime) {
  let p;
  try { p = IFACES.pump.parseLog({ topics: [...log.topics], data: log.data }); } catch { return null; }
  if (!p || (p.name !== 'Bought' && p.name !== 'Sold')) return null;
  const buy = p.name === 'Bought';
  const usdcRaw   = buy ? p.args.usdcIn   : p.args.usdcOut;
  const tokenRaw  = buy ? p.args.tokensOut : p.args.tokensIn;
  return {
    token: p.args.token.toLowerCase(),
    trader: (buy ? p.args.buyer : p.args.seller).toLowerCase(),
    side: buy ? 'buy' : 'sell',
    usdcAmount: Number(ethers.formatUnits(usdcRaw, 18)),
    tokenAmount: Number(ethers.formatUnits(tokenRaw, 18)),
    block: log.blockNumber, blockTime,
    txHash: log.transactionHash, logIndex: log.index,
  };
}

module.exports = { decodePoolCreatedV3, decodeInitializeV4, decodeSwapV3, decodeSwapV4, decodeTransfer, decodeTokenCreated, decodeLaunchTrade };
