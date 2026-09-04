// Shared chain constants for the indexer. Topic hashes are computed from
// canonical event signatures (not guessed) and cross-checked against the
// ones already verified and shipped in app/terminal.html — V3_FACTORY,
// V3 PoolCreated, and both V4 topics match exactly.
const { ethers } = require('ethers');

const ARC = {
  chainId: 5042,
  usdc: '0x3600000000000000000000000000000000000000',
  usdcDecimals: 6,
  v3Factory: '0xf0db7b58379503491d857db50ac9ece64c653918',
  v4PoolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
};

const TOPICS = {
  poolCreated: ethers.id('PoolCreated(address,address,uint24,int24,address)'),
  v3Swap: ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  v4Initialize: ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'),
  v4Swap: ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
  erc20Transfer: ethers.id('Transfer(address,address,uint256)'),
};

const IFACES = {
  v3Factory: new ethers.Interface([
    'event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)',
  ]),
  v3Pool: new ethers.Interface([
    'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
    'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
    'function liquidity() view returns (uint128)',
  ]),
  v4PoolManager: new ethers.Interface([
    'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)',
    'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
  ]),
  erc20: new ethers.Interface([
    'event Transfer(address indexed from,address indexed to,uint256 value)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
  ]),
};

/** sqrtPriceX96 -> price of token1 in token0, decimal-adjusted. Ported
 *  unchanged from app/terminal.html's priceFromSqrt — same trap (get dec0/
 *  dec1 wrong and the price is off by 10^12), same fix. */
function priceFromSqrt(sqrtX96, dec0, dec1) {
  const q96 = 2n ** 96n;
  const num = sqrtX96 * sqrtX96;
  const scaled = (num * 10n ** 18n) / (q96 * q96);
  return (Number(scaled) / 1e18) * Math.pow(10, dec0 - dec1);
}

module.exports = { ARC, TOPICS, IFACES, priceFromSqrt };
