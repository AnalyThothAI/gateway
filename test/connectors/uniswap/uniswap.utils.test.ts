import JSBI from 'jsbi';

import { toRawAmount } from '../../../src/connectors/uniswap/uniswap.utils';

describe('uniswap.utils toRawAmount', () => {
  test('converts small amounts to raw units', () => {
    const raw = toRawAmount(0.001, 18);
    expect(raw.toString()).toBe('1000000000000000');
  });

  test('converts large amounts without scientific notation', () => {
    const raw = toRawAmount(1234.5, 18);
    expect(raw.toString()).toBe('1234500000000000000000');
  });

  test('returns JSBI instance', () => {
    const raw = toRawAmount(1, 18);
    expect(JSBI.equal(raw, JSBI.BigInt('1000000000000000000'))).toBe(true);
  });
});
