/**
 * Every message documented in the Ichancy spec is pinned here. When their wording changes, ONE of
 * these fails and the fix is one line in the rules table — instead of a deposit quietly ending up in
 * the wrong state because an unrecognised sentence was treated as a definite rejection.
 */
import {
  AGENT_FLOAT_INSUFFICIENT,
  classifyEnvelope,
  classifyErrorContent,
  classifyTransportFailure,
  isUnauthorizedHttpStatus,
  TOKEN_EXPIRED_CODE,
} from './error-map';
import { IchancyRejectionCodes } from './ichancy.types';
import { toEnvelope } from './ichancy.wire';

const errorNote = (content: string) => ({ code: 0, content, title: '', status: 'error' });

describe('error-map — documented notification content', () => {
  it.each([
    ['Invalid username or password.', 'rejected', IchancyRejectionCodes.INVALID_CREDENTIALS],
    ['Invalid or expired refresh token', 'token_expired', TOKEN_EXPIRED_CODE],
    ["You don't have AMD wallet", 'rejected', IchancyRejectionCodes.NO_WALLET],
    ['Wrong arguments', 'rejected', IchancyRejectionCodes.WRONG_ARGUMENTS],
    ['Sum is not valid.', 'rejected', IchancyRejectionCodes.SUM_NOT_VALID],
    [
      'The amount is greater than you have in Total Available(FROM)',
      'rejected',
      IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT,
    ],
    [
      'The user does not have sufficient balance.',
      'rejected',
      IchancyRejectionCodes.INSUFFICIENT_PLAYER_BALANCE,
    ],
    [
      'Amount is greater than account balance',
      'rejected',
      IchancyRejectionCodes.INSUFFICIENT_PLAYER_BALANCE,
    ],
    ['Duplicate login', 'already_exists', IchancyRejectionCodes.ALREADY_EXISTS],
    ['Duplicate email', 'already_exists', IchancyRejectionCodes.ALREADY_EXISTS],
    ['ParentId property is required', 'rejected', IchancyRejectionCodes.VALIDATION_FAILED],
    ['Email property is required', 'rejected', IchancyRejectionCodes.VALIDATION_FAILED],
    ['Login property is required', 'rejected', IchancyRejectionCodes.VALIDATION_FAILED],
    [
      'Password should contain at least 3 characters.',
      'rejected',
      IchancyRejectionCodes.VALIDATION_FAILED,
    ],
  ])('classifies "%s"', (content, outcome, code) => {
    const classified = classifyErrorContent(content);
    expect(classified.outcome).toBe(outcome);
    expect(classified.code).toBe(code);
    expect(classified.message).toBe(content);
  });

  it('keeps the agent-float alias and the shared contract code in sync', () => {
    expect(AGENT_FLOAT_INSUFFICIENT).toBe(IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT);
  });

  it('is insensitive to case, spacing, trailing periods and typographic apostrophes', () => {
    expect(classifyErrorContent('  WRONG   ARGUMENTS.  ').code).toBe(
      IchancyRejectionCodes.WRONG_ARGUMENTS,
    );
    expect(classifyErrorContent('You don’t have NSP wallet').code).toBe(
      IchancyRejectionCodes.NO_WALLET,
    );
  });

  it('does not confuse the agent float message with the player balance message', () => {
    expect(
      classifyErrorContent('The amount is greater than you have in Total Available(FROM)').code,
    ).toBe(IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT);
    expect(classifyErrorContent('Amount is greater than account balance').code).toBe(
      IchancyRejectionCodes.INSUFFICIENT_PLAYER_BALANCE,
    );
  });

  it('treats an unknown sentence as AMBIGUOUS, never as a rejection', () => {
    // The whole safety argument: a wrong `rejected` can pay a player twice on retry, a wrong
    // `ambiguous` only costs a balance re-read.
    const classified = classifyErrorContent('Something entirely new went wrong');
    expect(classified.outcome).toBe('ambiguous');
    expect(classified.code).toBe(IchancyRejectionCodes.UNKNOWN);
    expect(classified.rule).toBeNull();
  });
});

describe('error-map — full envelope classification', () => {
  it('HTTP 200 + status:true + result:false + error notification is an ERROR', () => {
    const envelope = toEnvelope({
      status: true,
      html: '',
      result: false,
      notification: [errorNote("You don't have AMD wallet")],
    });
    const classified = classifyEnvelope(200, envelope);
    expect(classified.outcome).toBe('rejected');
    expect(classified).toMatchObject({ code: IchancyRejectionCodes.NO_WALLET });
  });

  it('HTTP 201 signin failure stays INVALID_CREDENTIALS instead of triggering a refresh', () => {
    const envelope = toEnvelope({
      status: true,
      result: false,
      notification: [errorNote('Invalid username or password.')],
    });
    const classified = classifyEnvelope(201, envelope);
    expect(classified.outcome).toBe('rejected');
    expect(classified).toMatchObject({ code: IchancyRejectionCodes.INVALID_CREDENTIALS });
  });

  it('HTTP 201 refresh failure is token_expired', () => {
    const envelope = toEnvelope({
      status: true,
      result: [],
      notification: [errorNote('Invalid or expired refresh token')],
    });
    expect(classifyEnvelope(201, envelope).outcome).toBe('token_expired');
  });

  it('HTTP 201 with a healthy envelope is OK — replaying it would re-send a money call', () => {
    const envelope = toEnvelope({ status: true, result: { balance: '10.00' }, notification: [] });
    expect(classifyEnvelope(201, envelope).outcome).toBe('ok');
  });

  it('HTTP 201 with a failed-looking envelope and no notification is token_expired', () => {
    const envelope = toEnvelope({ status: false, result: false });
    expect(classifyEnvelope(201, envelope).outcome).toBe('token_expired');
  });

  it('HTTP 401/403 are token_expired even with a clean body', () => {
    expect(isUnauthorizedHttpStatus(401)).toBe(true);
    expect(isUnauthorizedHttpStatus(403)).toBe(true);
    expect(classifyEnvelope(401, toEnvelope({ status: true, result: {} })).outcome).toBe(
      'token_expired',
    );
  });

  it('HTTP 422 business errors are definite rejections', () => {
    const envelope = toEnvelope({
      status: false,
      result: false,
      notification: [errorNote('The amount is greater than you have in Total Available(FROM)')],
    });
    const classified = classifyEnvelope(422, envelope);
    expect(classified.outcome).toBe('rejected');
    expect(classified).toMatchObject({ code: IchancyRejectionCodes.INSUFFICIENT_AGENT_FLOAT });
  });

  it('treats `result: []` with no error notification as success (documented deposit shape)', () => {
    expect(classifyEnvelope(200, toEnvelope({ status: true, result: [] })).outcome).toBe('ok');
  });

  it('ignores notifications that are not flagged as errors', () => {
    const envelope = toEnvelope({
      status: true,
      result: 1,
      notification: [{ content: 'Player created', status: 'success' }],
    });
    expect(classifyEnvelope(200, envelope).outcome).toBe('ok');
  });

  it('status:false without any explanation is ambiguous, not rejected', () => {
    const classified = classifyEnvelope(200, toEnvelope({ status: false, result: null }));
    expect(classified.outcome).toBe('ambiguous');
  });

  it('an error notification with no content is ambiguous', () => {
    const envelope = toEnvelope({ status: true, result: 1, notification: [{ status: 'error' }] });
    expect(classifyEnvelope(200, envelope).outcome).toBe('ambiguous');
  });

  it('5xx and unparseable bodies are ambiguous', () => {
    expect(classifyEnvelope(503, toEnvelope({ status: true, result: 1 })).outcome).toBe(
      'ambiguous',
    );
    expect(classifyEnvelope(200, null).outcome).toBe('ambiguous');
    expect(classifyEnvelope(200, toEnvelope('<html>gateway timeout</html>')).outcome).toBe(
      'ambiguous',
    );
  });
});

describe('error-map — transport failures', () => {
  it('marks a timeout as ambiguous (we never learned whether the money moved)', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const classified = classifyTransportFailure(timeout);
    expect(classified.outcome).toBe('ambiguous');
    expect(classified.rule).toBe('TIMEOUT');
  });

  it('marks a socket failure as ambiguous', () => {
    const classified = classifyTransportFailure(new TypeError('fetch failed'));
    expect(classified.outcome).toBe('ambiguous');
    expect(classified.rule).toBe('TRANSPORT_ERROR');
  });
});
