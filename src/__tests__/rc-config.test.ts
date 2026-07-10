import { describe, it, expect } from 'vitest';
import { rcConfigForLine, rcAccountKey, globalRcConfig } from '../services/ringcentral';

/**
 * Each Line (company number) can live on its OWN RingCentral account. These lock
 * in the resolution + token-cache-key behavior the poller and sender rely on.
 */
describe('per-line RingCentral account resolution', () => {
  it('a line with no creds inherits the global account but sends from its own number', () => {
    const g = globalRcConfig();
    const rc = rcConfigForLine({ phoneE164: '+15550001111' });
    expect(rc.clientId).toBe(g.clientId);
    expect(rc.jwt).toBe(g.jwt);
    expect(rc.fromNumber).toBe('+15550001111');
  });

  it('a line with its own creds uses them (own account + own number + own A2P flag)', () => {
    const rc = rcConfigForLine({ phoneE164: '+15550002222', rcClientId: 'CID', rcJwt: 'JWT', rcUseA2p: true });
    expect(rc.clientId).toBe('CID');
    expect(rc.jwt).toBe('JWT');
    expect(rc.useA2p).toBe(true);
    expect(rc.fromNumber).toBe('+15550002222');
  });

  it('partial creds (id without jwt) fall back to global — never a half-configured account', () => {
    const g = globalRcConfig();
    const rc = rcConfigForLine({ phoneE164: '+15550003333', rcClientId: 'CID' }); // no jwt
    expect(rc.clientId).toBe(g.clientId);
  });

  it('different accounts get different token-cache keys; the same account shares one', () => {
    const a = rcConfigForLine({ phoneE164: '+1', rcClientId: 'A', rcClientSecret: 's', rcJwt: 'ja', rcServerUrl: 'https://x' });
    const b = rcConfigForLine({ phoneE164: '+2', rcClientId: 'B', rcClientSecret: 's', rcJwt: 'jb', rcServerUrl: 'https://x' });
    const a2 = rcConfigForLine({ phoneE164: '+3', rcClientId: 'A', rcClientSecret: 's', rcJwt: 'ja', rcServerUrl: 'https://x' });
    expect(rcAccountKey(a)).not.toBe(rcAccountKey(b));
    expect(rcAccountKey(a)).toBe(rcAccountKey(a2)); // same account, two numbers -> polled once
  });
});
