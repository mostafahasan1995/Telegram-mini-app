import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

import {
  DEFAULT_BODY_LIMIT,
  PROOF_BODY_LIMIT,
  bodyParserErrorHandler,
  createBodyParsers,
  httpErrorStatus,
} from './body-parser.middleware';
import { MAX_PROOF_BASE64_LENGTH } from '@modules/deposit/dtos/submit-proof.dto';

/** Express calls an error handler as (err, req, res, next); only `next` is observed here. */
function runErrorHandler(error: unknown): unknown {
  let forwarded: unknown;
  bodyParserErrorHandler(
    error,
    {} as never,
    {} as never,
    ((value: unknown) => {
      forwarded = value;
    }) as never,
  );
  return forwarded;
}

describe('body parser middleware', () => {
  describe('limits', () => {
    it('gives the proof route room for the largest proof the DTO accepts', () => {
      // If the transport cap were below the DTO cap, a proof that passes validation could never
      // reach validation — a 413 the player cannot act on.
      expect(PROOF_BODY_LIMIT).toBeGreaterThan(MAX_PROOF_BASE64_LENGTH);
    });

    it('keeps every other route on a small cap', () => {
      expect(DEFAULT_BODY_LIMIT).toBeLessThan(PROOF_BODY_LIMIT / 10);
    });

    it('registers a JSON parser and a urlencoded parser, in that order', () => {
      const parsers = createBodyParsers();
      expect(parsers).toHaveLength(2);
      expect(typeof parsers[0]).toBe('function');
      expect(typeof parsers[1]).toBe('function');
    });
  });

  describe('httpErrorStatus', () => {
    it('reads either name http-errors uses', () => {
      expect(httpErrorStatus({ status: 413 })).toBe(413);
      expect(httpErrorStatus({ statusCode: 400 })).toBe(400);
      expect(httpErrorStatus({ status: 413, statusCode: 500 })).toBe(413);
    });

    it('returns null for anything that is not an http error', () => {
      expect(httpErrorStatus(new Error('boom'))).toBeNull();
      expect(httpErrorStatus(null)).toBeNull();
      expect(httpErrorStatus('nope')).toBeNull();
      expect(httpErrorStatus({ status: '413' })).toBeNull();
    });
  });

  describe('bodyParserErrorHandler', () => {
    it('translates a 413 into PayloadTooLargeException so the filter emits PAYLOAD_TOO_LARGE', () => {
      const forwarded = runErrorHandler({ status: 413, message: 'request entity too large' });
      expect(forwarded).toBeInstanceOf(PayloadTooLargeException);
      expect((forwarded as PayloadTooLargeException).getStatus()).toBe(413);
    });

    it("does not echo body-parser's message, which would leak the exact limit", () => {
      const forwarded = runErrorHandler({ status: 413, message: 'request entity too large' });
      expect(JSON.stringify((forwarded as PayloadTooLargeException).getResponse())).not.toContain(
        'entity too large',
      );
    });

    it('translates malformed JSON (400) into BadRequestException', () => {
      const parseFailure = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
        status: 400,
        type: 'entity.parse.failed',
      });
      const forwarded = runErrorHandler(parseFailure);
      expect(forwarded).toBeInstanceOf(BadRequestException);
      expect((forwarded as BadRequestException).getStatus()).toBe(400);
    });

    it('passes anything else through untouched, so a real bug stays a 500', () => {
      const bug = new Error('a genuine internal failure');
      expect(runErrorHandler(bug)).toBe(bug);
    });

    it('passes a 500-shaped http error through rather than dressing it up as a client error', () => {
      const upstream = { status: 502, message: 'bad gateway' };
      expect(runErrorHandler(upstream)).toBe(upstream);
    });
  });
});
