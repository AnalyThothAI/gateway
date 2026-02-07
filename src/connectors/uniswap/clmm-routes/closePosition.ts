import { Contract } from '@ethersproject/contracts';
import { Percent, CurrencyAmount } from '@uniswap/sdk-core';
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json';
import { NonfungiblePositionManager, Position, computePoolAddress } from '@uniswap/v3-sdk';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  ClosePositionRequestType,
  ClosePositionRequest,
  ClosePositionResponseType,
  ClosePositionResponse,
} from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Uniswap } from '../uniswap';
import { POSITION_MANAGER_ABI, getUniswapV3FactoryAddress, getUniswapV3NftManagerAddress } from '../uniswap.contracts';
import { formatTokenAmount } from '../uniswap.utils';

// Default gas limit for CLMM close position operations
const CLMM_CLOSE_POSITION_GAS_LIMIT = 400000;

export async function closePosition(
  network: string,
  walletAddress: string,
  positionAddress: string,
): Promise<ClosePositionResponseType> {
  // Validate essential parameters
  if (!positionAddress) {
    throw httpErrors.badRequest('Missing required parameters');
  }

  // Get Uniswap and Ethereum instances
  const uniswap = await Uniswap.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  // Get the wallet
  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) {
    throw httpErrors.badRequest('Wallet not found');
  }

  // Get position manager address
  const positionManagerAddress = getUniswapV3NftManagerAddress(network);

  // Check NFT ownership
  try {
    await uniswap.checkNFTOwnership(positionAddress, walletAddress);
  } catch (error: any) {
    if (error.message.includes('is not owned by')) {
      throw httpErrors.forbidden(error.message);
    }
    throw httpErrors.badRequest(error.message);
  }

  // Create position manager contract
  const positionManager = new Contract(positionManagerAddress, POSITION_MANAGER_ABI, ethereum.provider);

  // Get position details
  let position: any;
  try {
    position = await positionManager.positions(positionAddress);
  } catch (err: any) {
    const message = String(err?.reason ?? err?.errorArgs?.[0] ?? err?.message ?? '');
    if (message.toLowerCase().includes('invalid token id')) {
      throw httpErrors.notFound('Position closed');
    }
    throw err;
  }

  // Get tokens by address
  const token0 = await uniswap.getToken(position.token0);
  const token1 = await uniswap.getToken(position.token1);

  // Determine base and quote tokens - WETH or lower address is base
  const isBaseToken0 =
    token0.symbol === 'WETH' ||
    (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

  const normalizeTick = (value: any): number => {
    if (BigNumber.isBigNumber(value)) {
      return value.fromTwos(24).toNumber();
    }
    return Number(value);
  };

  // Get current liquidity
  const currentLiquidity = position.liquidity;

  // Check if position has already been closed
  if (currentLiquidity.isZero() && position.tokensOwed0.isZero() && position.tokensOwed1.isZero()) {
    throw httpErrors.badRequest('Position has already been closed or has no liquidity/fees to collect');
  }

  // Get the actual pool address using computePoolAddress
  const poolAddress = computePoolAddress({
    factoryAddress: getUniswapV3FactoryAddress(network),
    tokenA: token0,
    tokenB: token1,
    fee: position.fee,
  });

  // Get collected + uncollected fees (tokensOwed + feeGrowthInside delta)
  const feeAmount0Raw = position.tokensOwed0;
  const feeAmount1Raw = position.tokensOwed1;
  const Q128 = BigNumber.from(2).pow(128);
  let totalFee0 = feeAmount0Raw;
  let totalFee1 = feeAmount1Raw;

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

  try {
    const poolContract = new Contract(poolAddress, IUniswapV3PoolABI, ethereum.provider);
    type Slot0Result = { tick?: number } & { [index: number]: any };
    type TickInfoResult = {
      feeGrowthOutside0X128: BigNumber;
      feeGrowthOutside1X128: BigNumber;
    };

    const tickLower = normalizeTick(position.tickLower);
    const tickUpper = normalizeTick(position.tickUpper);

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

    const lastFeeGrowthInside0X128 = position.feeGrowthInside0LastX128;
    const lastFeeGrowthInside1X128 = position.feeGrowthInside1LastX128;
    const deltaFeeGrowth0 = feeGrowthInside0X128.gte(lastFeeGrowthInside0X128)
      ? feeGrowthInside0X128.sub(lastFeeGrowthInside0X128)
      : BigNumber.from(0);
    const deltaFeeGrowth1 = feeGrowthInside1X128.gte(lastFeeGrowthInside1X128)
      ? feeGrowthInside1X128.sub(lastFeeGrowthInside1X128)
      : BigNumber.from(0);

    const uncollected0 = currentLiquidity.mul(deltaFeeGrowth0).div(Q128);
    const uncollected1 = currentLiquidity.mul(deltaFeeGrowth1).div(Q128);

    totalFee0 = feeAmount0Raw.add(uncollected0);
    totalFee1 = feeAmount1Raw.add(uncollected1);
  } catch (feeError: any) {
    const message = feeError?.message ?? String(feeError);
    logger.warn(
      `Could not calculate uncollected fees for position ${positionAddress}, using tokensOwed only: ${message}`,
    );
  }

  // Get the pool
  const pool = await uniswap.getV3Pool(token0, token1, position.fee);
  if (!pool) {
    throw httpErrors.notFound('Pool not found for position');
  }

  // Create a Position instance to calculate expected amounts (liquidity-only, fees handled separately)
  const positionSDK = new Position({
    pool,
    tickLower: normalizeTick(position.tickLower),
    tickUpper: normalizeTick(position.tickUpper),
    liquidity: currentLiquidity.toString(),
  });

  // Get the expected amounts for 100% removal
  const amount0 = positionSDK.amount0;
  const amount1 = positionSDK.amount1;

  // Apply slippage tolerance
  const slippageTolerance = new Percent(100, 10000); // 1% slippage
  const amount0Min = amount0.multiply(new Percent(1).subtract(slippageTolerance)).quotient;
  const amount1Min = amount1.multiply(new Percent(1).subtract(slippageTolerance)).quotient;

  // Collect options expect only the already-owed amounts (fees); SDK adds amount{0,1}Min internally.
  const feeCurrencyOwed0 = CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(totalFee0.toString()));
  const feeCurrencyOwed1 = CurrencyAmount.fromRawAmount(token1, JSBI.BigInt(totalFee1.toString()));

  // For reporting, compute expected total collected amounts (liquidity + fees).
  const totalAmount0 = CurrencyAmount.fromRawAmount(
    token0,
    JSBI.add(amount0.quotient, JSBI.BigInt(totalFee0.toString())),
  );
  const totalAmount1 = CurrencyAmount.fromRawAmount(
    token1,
    JSBI.add(amount1.quotient, JSBI.BigInt(totalFee1.toString())),
  );

  // Create parameters for removing all liquidity
  const removeParams = {
    tokenId: positionAddress,
    liquidityPercentage: new Percent(10000, 10000), // 100% of liquidity
    slippageTolerance,
    deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes from now
    burnToken: true, // Burn the position token since we're closing it
    collectOptions: {
      expectedCurrencyOwed0: feeCurrencyOwed0,
      expectedCurrencyOwed1: feeCurrencyOwed1,
      recipient: walletAddress,
    },
  };

  // Get the calldata using the SDK
  const { calldata, value } = NonfungiblePositionManager.removeCallParameters(positionSDK, removeParams);

  // Initialize position manager with multicall interface
  const positionManagerWithSigner = new Contract(
    positionManagerAddress,
    [
      {
        inputs: [{ internalType: 'bytes[]', name: 'data', type: 'bytes[]' }],
        name: 'multicall',
        outputs: [{ internalType: 'bytes[]', name: 'results', type: 'bytes[]' }],
        stateMutability: 'payable',
        type: 'function',
      },
    ],
    wallet,
  );

  // Execute the transaction to remove liquidity and burn the position
  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_CLOSE_POSITION_GAS_LIMIT);
  txParams.value = BigNumber.from(value.toString());

  const tx = await positionManagerWithSigner.multicall([calldata], txParams);

  // Wait for transaction confirmation
  const receipt = await ethereum.handleTransactionExecution(tx);

  // Calculate gas fee
  const gasFee = formatTokenAmount(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(), 18);

  // Calculate token amounts removed including fees
  const token0AmountRemoved = formatTokenAmount(totalAmount0.quotient.toString(), token0.decimals);
  const token1AmountRemoved = formatTokenAmount(totalAmount1.quotient.toString(), token1.decimals);

  // Calculate fee amounts collected (includes uncollected fees computed via feeGrowthInside delta)
  const token0FeeAmount = formatTokenAmount(totalFee0.toString(), token0.decimals);
  const token1FeeAmount = formatTokenAmount(totalFee1.toString(), token1.decimals);

  // Map back to base and quote amounts
  const baseTokenAmountRemoved = isBaseToken0 ? token0AmountRemoved : token1AmountRemoved;
  const quoteTokenAmountRemoved = isBaseToken0 ? token1AmountRemoved : token0AmountRemoved;

  const baseFeeAmountCollected = isBaseToken0 ? token0FeeAmount : token1FeeAmount;
  const quoteFeeAmountCollected = isBaseToken0 ? token1FeeAmount : token0FeeAmount;

  // In Ethereum there's no position rent to refund, but we include it for API compatibility
  const positionRentRefunded = 0;

  return {
    signature: receipt.transactionHash,
    status: receipt.status,
    data: {
      fee: gasFee,
      positionRentRefunded,
      baseTokenAmountRemoved,
      quoteTokenAmountRemoved,
      baseFeeAmountCollected,
      quoteFeeAmountCollected,
    },
  };
}

export const closePositionRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: ClosePositionRequestType;
    Reply: ClosePositionResponseType;
  }>(
    '/close-position',
    {
      schema: {
        description: 'Close a Uniswap V3 position by removing all liquidity and collecting fees',
        tags: ['/connector/uniswap'],
        body: ClosePositionRequest,
        response: {
          200: ClosePositionResponse,
        },
      },
    },
    async (request) => {
      try {
        const { network, walletAddress: requestedWalletAddress, positionAddress } = request.body;

        let walletAddress = requestedWalletAddress;
        if (!walletAddress) {
          const uniswap = await Uniswap.getInstance(network);
          walletAddress = await uniswap.getFirstWalletAddress();
          if (!walletAddress) {
            throw fastify.httpErrors.badRequest('No wallet address provided and no default wallet found');
          }
        }

        return await closePosition(network, walletAddress, positionAddress);
      } catch (e: any) {
        logger.error('Failed to close position:', e);
        if (e.statusCode) {
          throw e;
        }
        throw fastify.httpErrors.internalServerError('Failed to close position');
      }
    },
  );
};

export default closePositionRoute;
