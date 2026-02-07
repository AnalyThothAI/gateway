import { Contract } from '@ethersproject/contracts';
import { Type } from '@sinclair/typebox';
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json';
import { Position, tickToPrice, computePoolAddress } from '@uniswap/v3-sdk';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { PositionInfo, PositionInfoSchema } from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { Uniswap } from '../uniswap';
import { POSITION_MANAGER_ABI, getUniswapV3NftManagerAddress, getUniswapV3FactoryAddress } from '../uniswap.contracts';
import { formatTokenAmount } from '../uniswap.utils';

// Define the request and response types
const PositionsOwnedRequest = Type.Object({
  network: Type.Optional(Type.String({ examples: ['base'], default: 'base' })),
  walletAddress: Type.String({ examples: ['<ethereum-wallet-address>'] }),
});

const PositionsOwnedResponse = Type.Array(PositionInfoSchema);

// Additional ABI methods needed for enumerating positions
const ENUMERABLE_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'uint256', name: 'index', type: 'uint256' },
    ],
    name: 'tokenOfOwnerByIndex',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

export async function getPositionsOwned(
  fastify: FastifyInstance,
  network: string,
  walletAddress?: string,
): Promise<PositionInfo[]> {
  const uniswap = await Uniswap.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  // Get wallet address if not provided
  if (!walletAddress) {
    walletAddress = await uniswap.getFirstWalletAddress();
    if (!walletAddress) {
      throw fastify.httpErrors.badRequest('No wallet address provided and no default wallet found');
    }
    logger.info(`Using first available wallet address: ${walletAddress}`);
  }

  // Get position manager address
  const positionManagerAddress = getUniswapV3NftManagerAddress(network);

  // Create position manager contract with both enumerable and position ABIs
  const positionManager = new Contract(
    positionManagerAddress,
    [...ENUMERABLE_ABI, ...POSITION_MANAGER_ABI],
    ethereum.provider,
  );

  // Get number of positions owned by the wallet
  const balanceOf = await positionManager.balanceOf(walletAddress);
  const numPositions = balanceOf.toNumber();

  if (numPositions === 0) {
    return [];
  }

  // Get all position token IDs and convert to PositionInfo format
  const positions = [];
  for (let i = 0; i < numPositions; i++) {
    try {
      const tokenId = await positionManager.tokenOfOwnerByIndex(walletAddress, i);

      // Get position details
      const positionDetails = await positionManager.positions(tokenId);

      // Skip positions with no liquidity
      if (positionDetails.liquidity.eq(0)) {
        continue;
      }

      const normalizeTick = (value: any): number => {
        if (BigNumber.isBigNumber(value)) {
          return value.fromTwos(24).toNumber();
        }
        return Number(value);
      };

      // Get the token addresses from the position
      const token0Address = positionDetails.token0;
      const token1Address = positionDetails.token1;

      // Get the tokens from addresses
      const token0 = await uniswap.getToken(token0Address);
      const token1 = await uniswap.getToken(token1Address);

      // Get position ticks
      const tickLower = normalizeTick(positionDetails.tickLower);
      const tickUpper = normalizeTick(positionDetails.tickUpper);
      const liquidity = positionDetails.liquidity;
      const fee = positionDetails.fee;

      // Get the pool associated with the position
      const pool = await uniswap.getV3Pool(token0, token1, fee);
      if (!pool) {
        logger.warn(`Pool not found for position ${tokenId}`);
        continue;
      }

      // Get the actual pool address using computePoolAddress
      const poolAddress = computePoolAddress({
        factoryAddress: getUniswapV3FactoryAddress(network),
        tokenA: token0,
        tokenB: token1,
        fee,
      });

      // Get collected + uncollected fees (tokensOwed + feeGrowthInside delta)
      const feeAmount0Raw = positionDetails.tokensOwed0;
      const feeAmount1Raw = positionDetails.tokensOwed1;
      const Q128 = BigNumber.from(2).pow(128);
      let totalFee0 = feeAmount0Raw;
      let totalFee1 = feeAmount1Raw;
      try {
        const poolContract = new Contract(poolAddress, IUniswapV3PoolABI, ethereum.provider);

        const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
        const withRetries = async <T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 250): Promise<T> => {
          let lastError: any;
          for (let i = 0; i < attempts; i++) {
            try {
              return await fn();
            } catch (error) {
              lastError = error;
              if (i < attempts - 1) {
                const delay = baseDelayMs * 2 ** i;
                await sleep(delay);
              }
            }
          }
          throw lastError;
        };

        type Slot0Result = { tick?: number } & { [index: number]: any };
        type TickInfoResult = {
          feeGrowthOutside0X128: BigNumber;
          feeGrowthOutside1X128: BigNumber;
        };

        const [feeGrowthGlobal0X128Raw, feeGrowthGlobal1X128Raw, slot0Raw, lowerTickDataRaw, upperTickDataRaw] =
          await Promise.all([
            withRetries(() => poolContract.feeGrowthGlobal0X128()),
            withRetries(() => poolContract.feeGrowthGlobal1X128()),
            withRetries(() => poolContract.slot0()),
            withRetries(() => poolContract.ticks(tickLower)),
            withRetries(() => poolContract.ticks(tickUpper)),
          ]);

        const feeGrowthGlobal0X128 = feeGrowthGlobal0X128Raw as BigNumber;
        const feeGrowthGlobal1X128 = feeGrowthGlobal1X128Raw as BigNumber;
        const slot0 = slot0Raw as Slot0Result;
        const lowerTickData = lowerTickDataRaw as TickInfoResult;
        const upperTickData = upperTickDataRaw as TickInfoResult;

        const currentTickRaw = slot0.tick ?? slot0[1];
        const currentTick = normalizeTick(currentTickRaw);

        const safeSub = (a: BigNumber, b: BigNumber): BigNumber => (a.gte(b) ? a.sub(b) : BigNumber.from(0));
        const feeGrowthInside = (
          global: BigNumber,
          lowerOutside: BigNumber,
          upperOutside: BigNumber,
          current: number,
          lower: number,
          upper: number,
        ): BigNumber => {
          const feeBelow = current >= lower ? lowerOutside : safeSub(global, lowerOutside);
          const feeAbove = current < upper ? upperOutside : safeSub(global, upperOutside);
          return safeSub(global, feeBelow.add(feeAbove));
        };

        const feeGrowthInside0X128 = feeGrowthInside(
          feeGrowthGlobal0X128,
          lowerTickData.feeGrowthOutside0X128,
          upperTickData.feeGrowthOutside0X128,
          currentTick,
          tickLower,
          tickUpper,
        );
        const feeGrowthInside1X128 = feeGrowthInside(
          feeGrowthGlobal1X128,
          lowerTickData.feeGrowthOutside1X128,
          upperTickData.feeGrowthOutside1X128,
          currentTick,
          tickLower,
          tickUpper,
        );

        const lastFeeGrowthInside0X128 = positionDetails.feeGrowthInside0LastX128;
        const lastFeeGrowthInside1X128 = positionDetails.feeGrowthInside1LastX128;
        const deltaFeeGrowth0 = feeGrowthInside0X128.gte(lastFeeGrowthInside0X128)
          ? feeGrowthInside0X128.sub(lastFeeGrowthInside0X128)
          : BigNumber.from(0);
        const deltaFeeGrowth1 = feeGrowthInside1X128.gte(lastFeeGrowthInside1X128)
          ? feeGrowthInside1X128.sub(lastFeeGrowthInside1X128)
          : BigNumber.from(0);

        const uncollected0 = liquidity.mul(deltaFeeGrowth0).div(Q128);
        const uncollected1 = liquidity.mul(deltaFeeGrowth1).div(Q128);

        totalFee0 = feeAmount0Raw.add(uncollected0);
        totalFee1 = feeAmount1Raw.add(uncollected1);
      } catch (feeError) {
        const message = (feeError as any)?.message ?? String(feeError);
        logger.warn(
          `Could not calculate uncollected fees for position ${tokenId.toString()}, using tokensOwed only: ${message}`,
        );
      }

      const feeAmount0 = formatTokenAmount(totalFee0.toString(), token0.decimals);
      const feeAmount1 = formatTokenAmount(totalFee1.toString(), token1.decimals);

      // Calculate price range
      const lowerPrice = tickToPrice(token0, token1, tickLower).toSignificant(6);
      const upperPrice = tickToPrice(token0, token1, tickUpper).toSignificant(6);

      // Calculate current price
      const price = pool.token0Price.toSignificant(6);

      // Create a Position instance to calculate token amounts
      const position = new Position({
        pool,
        tickLower,
        tickUpper,
        liquidity: liquidity.toString(),
      });

      // Get token amounts in the position
      const token0Amount = formatTokenAmount(position.amount0.quotient.toString(), token0.decimals);
      const token1Amount = formatTokenAmount(position.amount1.quotient.toString(), token1.decimals);

      // Determine which token is base and which is quote
      const isBaseToken0 =
        token0.symbol === 'WETH' ||
        (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

      const [baseTokenAddress, quoteTokenAddress] = isBaseToken0
        ? [token0.address, token1.address]
        : [token1.address, token0.address];

      const [baseTokenAmount, quoteTokenAmount] = isBaseToken0
        ? [token0Amount, token1Amount]
        : [token1Amount, token0Amount];

      const [baseFeeAmount, quoteFeeAmount] = isBaseToken0 ? [feeAmount0, feeAmount1] : [feeAmount1, feeAmount0];

      positions.push({
        address: tokenId.toString(),
        poolAddress,
        baseTokenAddress,
        quoteTokenAddress,
        baseTokenAmount,
        quoteTokenAmount,
        baseFeeAmount,
        quoteFeeAmount,
        lowerBinId: tickLower,
        upperBinId: tickUpper,
        lowerPrice: parseFloat(lowerPrice),
        upperPrice: parseFloat(upperPrice),
        price: parseFloat(price),
      });
    } catch (err) {
      logger.warn(`Error fetching position ${i} for wallet ${walletAddress}: ${err.message}`);
    }
  }

  return positions;
}

export const positionsOwnedRoute: FastifyPluginAsync = async (fastify) => {
  await fastify.register(require('@fastify/sensible'));
  const walletAddressExample = await Ethereum.getWalletAddressExample();

  fastify.get<{
    Querystring: typeof PositionsOwnedRequest.static;
    Reply: typeof PositionsOwnedResponse.static;
  }>(
    '/positions-owned',
    {
      schema: {
        description: 'Get all Uniswap V3 positions owned by a wallet',
        tags: ['/connector/uniswap'],
        querystring: {
          ...PositionsOwnedRequest,
          properties: {
            ...PositionsOwnedRequest.properties,
            walletAddress: { type: 'string', examples: [walletAddressExample] },
          },
        },
        response: {
          200: PositionsOwnedResponse,
        },
      },
    },
    async (request) => {
      try {
        const { walletAddress } = request.query;
        const network = request.query.network;
        return await getPositionsOwned(fastify, network, walletAddress);
      } catch (e) {
        logger.error(e);
        if (e.statusCode) {
          throw e;
        }
        throw fastify.httpErrors.internalServerError('Failed to fetch positions');
      }
    },
  );
};

export default positionsOwnedRoute;
