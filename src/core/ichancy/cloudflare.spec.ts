/**
 * The one thing that MUST NOT regress here: a Cloudflare challenge is an HTTP 403, and 403 is also
 * how this API says "your token died". Confusing the two makes the adapter spend the agent's single
 * refresh token on a bot check it cannot pass — see isCloudflareChallenge's header.
 */
import {
  CLOUDFLARE_BLOCKED_CODE,
  CLOUDFLARE_CHALLENGE_CODE,
  cloudflareBlockedClassification,
  cloudflareClassification,
  isCloudflareBlock,
  isCloudflareChallenge,
  isUnauthorizedHttpStatus,
} from './error-map';

const CHALLENGE_PAGE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><div id="cf-wrapper"><div class="cf-browser-verification"></div>
<p>Enable JavaScript and cookies to continue</p></div></body></html>`;

/** The TERMINAL block page — a different failure, from the egress IP's reputation, with a different fix. */
const BLOCK_PAGE = `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>
<body><h1>Sorry, you have been blocked</h1><p>You are unable to access ichancy.com</p>
<p>Error code 1020</p></body></html>`;

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

describe('Cloudflare BLOCK detection — a terminal denial, NOT a solvable challenge', () => {
  it('recognises the block page on 403/503/429', () => {
    expect(isCloudflareBlock(403, BLOCK_PAGE, 'text/html; charset=UTF-8')).toBe(true);
    expect(isCloudflareBlock(503, BLOCK_PAGE, 'text/html')).toBe(true);
    expect(isCloudflareBlock(429, BLOCK_PAGE, 'text/html')).toBe(true);
  });

  it('a BLOCK is NOT a challenge — the block detector wins, so no 45s poll and no replay', () => {
    // This is the live bug the split fixes: the block page's title used to be a challenge marker,
    // so a terminal block was polled for 45s and replayed. It must now read as a block only.
    expect(isCloudflareBlock(403, BLOCK_PAGE, 'text/html')).toBe(true);
    expect(isCloudflareChallenge(403, BLOCK_PAGE, 'text/html')).toBe(false);
  });

  it('a genuine "just a moment" challenge is NOT a block', () => {
    expect(isCloudflareChallenge(403, CHALLENGE_PAGE, 'text/html')).toBe(true);
    expect(isCloudflareBlock(403, CHALLENGE_PAGE, 'text/html')).toBe(false);
  });

  it('is not fooled by a JSON body', () => {
    const body = '{"status":true,"result":false,"notification":[{"content":"Invalid access token"}]}';
    expect(isCloudflareBlock(403, body, 'application/json')).toBe(false);
  });

  it('classifies as AMBIGUOUS (never a success/credit) and names the PROXY fix, not the cookie', () => {
    // The money semantics MUST be identical to a challenge: ambiguous, so the credit worker never
    // reads an edge block as a paid deposit. Only the operator-facing message differs.
    const classification = cloudflareBlockedClassification(403);
    expect(classification.outcome).toBe('ambiguous');
    if (classification.outcome === 'ok') throw new Error('unreachable');
    expect(classification.code).toBe(CLOUDFLARE_BLOCKED_CODE);
    expect(classification.message).toContain('ICHANCY_PROXY_URL');
    // It must NOT tell the operator to refresh the cookie or allowlist the IP: useless against a
    // reputation block, and hours wasted chasing the wrong thing.
    expect(classification.message).not.toContain('ICHANCY_COOKIE');
    expect(classification.message.toLowerCase()).not.toContain('allowlist');
  });
});
