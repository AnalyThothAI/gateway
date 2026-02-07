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
  return {
    ...actual,
    Position: jest.fn().mockImplementation(() => ({
      amount0: { quotient: BigInt(0) },
      amount1: { quotient: BigInt(0) },
    })),
    tickToPrice: jest.fn(() => ({ toSignificant: () => '1' })),
    computePoolAddress: jest.fn(() => '0x00000000000000000000000000000000000000aa'),
  };
});

jest.mock('../../../../src/chains/ethereum/ethereum');
jest.mock('../../../../src/connectors/uniswap/uniswap');

const buildApp = async () => {
  const server = fastifyWithTypeProvider();
  await server.register(require('@fastify/sensible'));
  const { positionsOwnedRoute } = await import('../../../../src/connectors/uniswap/clmm-routes/positionsOwned');
  await server.register(positionsOwnedRoute);
  return server;
};

describe('GET /positions-owned (uniswap/clmm)', () => {
  let app: any;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes uncollected fees (feeGrowthInside delta) when tokensOwed is zero', async () => {
    (Ethereum.getWalletAddressExample as jest.Mock).mockResolvedValue('0x1234567890123456789012345678901234567890');

    const mockProvider = { _isProvider: true };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({ provider: mockProvider });

    const token0 = new Token(56, '0x0000000000000000000000000000000000000001', 0, 'BORT', 'BORT');
    const token1 = new Token(56, '0x0000000000000000000000000000000000000002', 0, 'USDT', 'USDT');

    const mockPool = {
      token0Price: { toSignificant: () => '0.002' },
    };
    (Uniswap.getInstance as jest.Mock).mockResolvedValue({
      getFirstWalletAddress: jest.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
      getToken: jest.fn().mockImplementation(async (address: string) => {
        const normalized = address.toLowerCase();
        if (normalized === token0.address.toLowerCase()) return token0;
        if (normalized === token1.address.toLowerCase()) return token1;
        throw new Error(`Unknown token address ${address}`);
      }),
      getV3Pool: jest.fn().mockResolvedValue(mockPool),
    });

    const positionManagerMock = {
      balanceOf: jest.fn().mockResolvedValue(BigNumber.from(1)),
      tokenOfOwnerByIndex: jest.fn().mockResolvedValue(BigNumber.from(42)),
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

    (Contract as unknown as jest.Mock)
      .mockImplementationOnce(() => positionManagerMock)
      .mockImplementation(() => poolContractMock);

    const response = await app.inject({
      method: 'GET',
      url: '/positions-owned',
      query: {
        network: 'bsc',
        walletAddress: '0x1234567890123456789012345678901234567890',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].address).toBe('42');

    // Before the fix, positions-owned only returns tokensOwed (0) and this assertion fails.
    // After the fix, it should add uncollected fees computed from feeGrowthInside delta.
    expect(body[0].baseFeeAmount).toBeGreaterThan(0);
  });
});
