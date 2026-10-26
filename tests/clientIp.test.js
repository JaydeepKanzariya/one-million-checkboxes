import { describe, expect, it } from 'vitest';
import { extractClientIp } from '../server/utils/clientIp.js';

describe('extractClientIp (trust proxy hop counting)', () => {
  it('takes the entry trustProxy positions from the right of X-Forwarded-For', () => {
    const req = {
      headers: { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' },
      socket: { remoteAddress: '172.18.0.5' },
    };
    expect(extractClientIp(req, 1)).toBe('9.9.9.9');
    expect(extractClientIp(req, 2)).toBe('1.1.1.1');
    expect(extractClientIp(req, 5)).toBe('1.1.1.1');
  });

  it('ignores X-Forwarded-For when trustProxy is 0', () => {
    const req = {
      headers: { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' },
      socket: { remoteAddress: '10.0.0.42' },
    };
    expect(extractClientIp(req, 0)).toBe('10.0.0.42');
  });
});
