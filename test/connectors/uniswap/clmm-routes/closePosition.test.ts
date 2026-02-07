import '../../../mocks/app-mocks';

import { Contract } from '@ethersproject/contracts';
import { Token } from '@uniswap/sdk-core';
import { BigNumber } from 'ethers';

import { Ethereum } from '../../../../src/chains/ethereum/ethereum';
import { Uniswap } from '../../../../src/connectors/uniswap/uniswap';
import { fastifyWithTypeProvider } from '../../../utils/testUtils';

jest.mock('@ethersproject/contracts', () => ({
  Contract: jest.fn(),
}));

jest.mock('@uniswap/v3-sdk', () => {
  const actual = jest.requireActual('@uniswap/v3-sdk');
  const JSBI = require('jsbi');
  return {
    ...actual,
    Position: jest.fn().mockImplementation(() => ({
      amount0: { quotient: JSBI.BigInt(0), multiply: jest.fn(() => ({ quotient: JSBI.BigInt(0) })) },
      amount1: { quotient: JSBI.BigInt(0), multiply: jest.fn(() => ({ quotient: JSBI.BigInt(0) })) },
    })),
    NonfungiblePositionManager: {
      removeCallParameters: jest.fn(() => ({ calldata: '0xdeadbeef', value: '0' })),
    },
    computePoolAddress: jest.fn(() => '0x00000000000000000000000000000000000000aa'),
  };
});

jest.mock('../../../../src/chains/ethereum/ethereum');
jest.mock('../../../../src/connectors/uniswap/uniswap');

const buildApp = async () => {
  const server = fastifyWithTypeProvider();
  await server.register(require('@fastify/sensible'));
  const { closePositionRoute } = await import('../../../../src/connectors/uniswap/clmm-routes/closePosition');
  await server.register(closePositionRoute);
  return server;
};

describe('POST /close-position (uniswap/clmm)', () => {
  let app: any;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns non-zero fee amounts when tokensOwed is zero but uncollected fees exist', async () => {
    const mockProvider = { _isProvider: true };
    const mockWallet = { address: '0x1234567890123456789012345678901234567890' };
    const receipt = {
      transactionHash: '0xaaaaaaaa',
      status: 1,
      gasUsed: BigNumber.from(21000),
      effectiveGasPrice: BigNumber.from(1),
    };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({
      provider: mockProvider,
      getWallet: jest.fn().mockResolvedValue(mockWallet),
      prepareGasOptions: jest.fn().mockResolvedValue({}),
      handleTransactionExecution: jest.fn().mockResolvedValue(receipt),
    });

    const token0 = new Token(8453, '0x0000000000000000000000000000000000000001', 0, 'BORT', 'BORT');
    const token1 = new Token(8453, '0x0000000000000000000000000000000000000002', 0, 'USDT', 'USDT');

    (Uniswap.getInstance as jest.Mock).mockResolvedValue({
      getFirstWalletAddress: jest.fn().mockResolvedValue(mockWallet.address),
      checkNFTOwnership: jest.fn().mockResolvedValue(true),
      getToken: jest.fn().mockImplementation(async (address: string) => {
        const normalized = address.toLowerCase();
        if (normalized === token0.address.toLowerCase()) return token0;
        if (normalized === token1.address.toLowerCase()) return token1;
        throw new Error(`Unknown token address ${address}`);
      }),
      getV3Pool: jest.fn().mockResolvedValue({}),
    });

    const positionManagerMock = {
      positions: jest.fn().mockResolvedValue({
        liquidity: BigNumber.from(1000),
        token0: token0.address,
        token1: token1.address,
        tickLower: -10,
        tickUpper: 10,
        fee: 500,
        tokensOwed0: BigNumber.from(0),
        tokensOwed1: BigNumber.from(0),
        feeGrowthInside0LastX128: BigNumber.from(2).pow(128).mul(50),
        feeGrowthInside1LastX128: BigNumber.from(0),
      }),
    };

    const Q128 = BigNumber.from(2).pow(128);
    const poolContractMock = {
      feeGrowthGlobal0X128: jest.fn().mockResolvedValue(Q128.mul(100)),
      feeGrowthGlobal1X128: jest.fn().mockResolvedValue(BigNumber.from(0)),
      slot0: jest.fn().mockResolvedValue({ tick: 0 }),
      ticks: jest.fn().mockImplementation(async (tick: number) => {
        if (tick === -10) {
          return { feeGrowthOutside0X128: Q128.mul(10), feeGrowthOutside1X128: BigNumber.from(0) };
        }
        if (tick === 10) {
          return { feeGrowthOutside0X128: Q128.mul(20), feeGrowthOutside1X128: BigNumber.from(0) };
        }
        throw new Error(`Unexpected tick ${tick}`);
      }),
    };

    const positionManagerWithSignerMock = {
      multicall: jest.fn().mockResolvedValue({}),
    };

    (Contract as unknown as jest.Mock)
      .mockImplementationOnce(() => positionManagerMock)
      .mockImplementationOnce(() => poolContractMock)
      .mockImplementationOnce(() => positionManagerWithSignerMock);

    const response = await app.inject({
      method: 'POST',
      url: '/close-position',
      payload: {
        network: 'base',
        walletAddress: mockWallet.address,
        positionAddress: '42',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body?.data?.baseFeeAmountCollected).toBeGreaterThan(0);
  });
});
