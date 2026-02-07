import '../../../mocks/app-mocks';

import { Contract } from '@ethersproject/contracts';

import { Ethereum } from '../../../../src/chains/ethereum/ethereum';
import { Uniswap } from '../../../../src/connectors/uniswap/uniswap';
import { fastifyWithTypeProvider } from '../../../utils/testUtils';

jest.mock('@ethersproject/contracts', () => ({
  Contract: jest.fn(),
}));

jest.mock('../../../../src/chains/ethereum/ethereum');
jest.mock('../../../../src/connectors/uniswap/uniswap');

const buildApp = async () => {
  const server = fastifyWithTypeProvider();
  await server.register(require('@fastify/sensible'));
  const { positionInfoRoute } = await import('../../../../src/connectors/uniswap/clmm-routes/positionInfo');
  await server.register(positionInfoRoute);
  return server;
};

describe('GET /position-info (uniswap/clmm)', () => {
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

  it('returns 404 when tokenId is invalid/burned ("Invalid token ID")', async () => {
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({ provider: {} });
    (Uniswap.getInstance as jest.Mock).mockResolvedValue({});

    const positionManagerMock = {
      positions: jest.fn().mockRejectedValue(new Error('Invalid token ID')),
    };

    (Contract as unknown as jest.Mock).mockImplementationOnce(() => positionManagerMock);

    const response = await app.inject({
      method: 'GET',
      url: '/position-info',
      query: {
        network: 'base',
        positionAddress: '1503952',
      },
    });

    // Before the fix, this returns 500 (internalServerError).
    expect(response.statusCode).toBe(404);
  });
});
