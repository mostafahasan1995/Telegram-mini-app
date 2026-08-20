/**
 * The transport seam is where the money path meets the network, so the contract it must keep is
 * narrow and worth pinning: whatever the transport hands back, the classification is decided by the
 * BODY and the STATUS — never by which transport produced them. That is what makes flipping
 * ICHANCY_TRANSPORT safe in both directions.
 */
import { cloudflareClassification, classifyEnvelope, isCloudflareChallenge } from '../error-map';
import { looksChallenged } from './browser.transport';
import { toEnvelope } from '../ichancy.wire';
import { type IchancyTransportResponse } from './ichancy-transport';

const CHALLENGE: IchancyTransportResponse = {
  status: 403,
  contentType: 'text/html; charset=UTF-8',
  text: '<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>',
};

const AGENT_JSON: IchancyTransportResponse = {
  status: 200,
  contentType: 'application/json',
  text: '{"status":true,"html":"","result":{"accessToken":"a","refreshToken":"b"},"notification":[]}',
};

const WRONG_PASSWORD: IchancyTransportResponse = {
  status: 401,
  contentType: 'application/json',
  text: '{"status":true,"result":false,"notification":[{"content":"Invalid username or password.","status":"error"}]}',
};

/** Exactly the decision IchancyHttpClient makes, in the order it makes it. */
function classify(response: IchancyTransportResponse) {
  return isCloudflareChallenge(response.status, response.text, response.contentType)
    ? cloudflareClassification(response.status)
    : classifyEnvelope(response.status, toEnvelope(safeParse(response.text)));
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

describe('transport seam', () => {
  it('reports a challenge as CLOUDFLARE_CHALLENGE whichever transport produced it', () => {
    // The browser transport returns the same shape as the fetch transport for a blocked call, so
    // the same verdict has to come out. A browser that gets challenged must not be mistaken for an
    // expired token — that is what would spend the agent's single refresh token.
    const classification = classify(CHALLENGE);
    expect(classification.outcome).toBe('ambiguous');
    if (classification.outcome === 'ok') throw new Error('unreachable');
    expect(classification.code).toBe('CLOUDFLARE_CHALLENGE');
  });

  it('passes real agent JSON straight through', () => {
    expect(classify(AGENT_JSON).outcome).toBe('ok');
  });

  it('still reads a genuine auth failure as a rejection, not as a challenge', () => {
    // 401 + JSON is Ichancy talking. Only NON-JSON on a blocking status is Cloudflare.
    const classification = classify(WRONG_PASSWORD);
    expect(classification.outcome).toBe('rejected');
  });

  it('never mistakes a JSON body for a challenge, whatever the status', () => {
    expect(isCloudflareChallenge(403, AGENT_JSON.text, 'application/json')).toBe(false);
  });

  /**
   * The browser transport has a SECOND opinion about what a challenge is, because it decides whether
   * to re-solve and REPLAY the call. That call can be `registerPlayer`, which is not idempotent and
   * whose duplicate cannot be deleted — the agent API has no deletePlayer. So the two predicates
   * disagreeing is not untidiness, it is a route to an undeletable second casino account.
   *
   * They disagreed until 2026-08-20: the transport replayed on any non-JSON 403/503/429 without
   * requiring a Cloudflare marker in the body, and `contentType?.includes(...) !== true` made a
   * NULL content-type look like a challenge too.
   */
  it('agrees with the transport about which responses may be replayed', () => {
    const cases: IchancyTransportResponse[] = [
      CHALLENGE,
      AGENT_JSON,
      WRONG_PASSWORD,
      { status: 403, contentType: null, text: 'Forbidden' },
      { status: 429, contentType: 'text/plain', text: 'slow down' },
      { status: 503, contentType: 'text/html', text: '<h1>Just a moment...</h1>' },
    ];

    for (const response of cases) {
      const classification = classify(response);
      const errorMapSaysChallenge =
        classification.outcome !== 'ok' && classification.code === 'CLOUDFLARE_CHALLENGE';
      expect(looksChallenged(response)).toBe(errorMapSaysChallenge);
    }
  });
});
