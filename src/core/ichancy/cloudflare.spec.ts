/**
 * The one thing that MUST NOT regress here: a Cloudflare challenge is an HTTP 403, and 403 is also
 * how this API says "your token died". Confusing the two makes the adapter spend the agent's single
 * refresh token on a bot check it cannot pass — see isCloudflareChallenge's header.
 */
import {
  CLOUDFLARE_CHALLENGE_CODE,
  cloudflareClassification,
  isCloudflareChallenge,
  isUnauthorizedHttpStatus,
} from './error-map';

const CHALLENGE_PAGE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><div id="cf-wrapper"><div class="cf-browser-verification"></div>
<p>Enable JavaScript and cookies to continue</p></div></body></html>`;

describe('Cloudflare challenge detection', () => {
  it('recognises the interstitial served with 403', () => {
    expect(isCloudflareChallenge(403, CHALLENGE_PAGE, 'text/html; charset=UTF-8')).toBe(true);
  });

  it('recognises it on 503 and on 429', () => {
    expect(isCloudflareChallenge(503, CHALLENGE_PAGE, 'text/html')).toBe(true);
    expect(isCloudflareChallenge(429, CHALLENGE_PAGE, 'text/html')).toBe(true);
  });

  it('is not fooled by a JSON body, whatever the status', () => {
    // Ichancy's own 403 carries JSON. Treating that as a challenge would hide a real auth failure.
    const body = '{"status":true,"result":false,"notification":[{"content":"Invalid access token"}]}';
    expect(isCloudflareChallenge(403, body, 'application/json')).toBe(false);
  });

  it('ignores a plain 200 that merely mentions cloudflare', () => {
    expect(isCloudflareChallenge(200, 'served by cloudflare', 'text/html')).toBe(false);
  });

  it('ignores an unrelated HTML error page', () => {
    expect(isCloudflareChallenge(503, '<html><body>Bad gateway</body></html>', 'text/html')).toBe(
      false,
    );
  });

  it('overlaps with the unauthorized status range — which is exactly why it is checked first', () => {
    expect(isUnauthorizedHttpStatus(403)).toBe(true);
    expect(isCloudflareChallenge(403, CHALLENGE_PAGE, 'text/html')).toBe(true);
  });

  it('classifies as AMBIGUOUS, never rejected, and names the fix', () => {
    const classification = cloudflareClassification(403);
    expect(classification.outcome).toBe('ambiguous');
    if (classification.outcome === 'ok') throw new Error('unreachable');
    expect(classification.code).toBe(CLOUDFLARE_CHALLENGE_CODE);
    expect(classification.message).toContain('ICHANCY_COOKIE');
  });
});
