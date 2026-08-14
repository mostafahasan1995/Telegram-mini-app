/**
 * The api owns its body parsing outright (`NestFactory.create(..., { bodyParser: false })`) for two
 * reasons that Nest's built-in registration cannot satisfy together.
 *
 * ---------------------------------------------------------------------------------------------
 * 1. ONE ROUTE NEEDS MEGABYTES; NOTHING ELSE SHOULD BE ALLOWED THEM.
 *
 * Deposit proofs are base64 images inside a JSON body (see SubmitProofDto for why not multipart),
 * so `POST /v1/deposits/:shortId/proof` legitimately carries ~14 MB. Express' default cap is 100 KB,
 * which would reject every real proof upload with a 413 the player cannot act on. Raising the cap
 * globally instead would let any unauthenticated request make us buffer 14 MB, which is a cheap way
 * to hurt a cashier. So the large limit is scoped to exactly that path.
 *
 * ---------------------------------------------------------------------------------------------
 * 2. A BAD BODY MUST NOT LOOK LIKE OUR BUG.
 *
 * body-parser rejects with an `http-errors` object: `PayloadTooLargeError` (413) or, far more
 * commonly, `SyntaxError` with `type: 'entity.parse.failed'` (400) when a client sends malformed
 * JSON. Neither is a Nest `HttpException`, so GlobalExceptionFilter — which correctly refuses to
 * leak details of errors it does not recognise — reported both as **500 INTERNAL_ERROR**.
 *
 * That is wrong twice over: the client is told the server is broken when the request was, and every
 * malformed request raises a fake internal error in the logs and in whatever alerts on them. The
 * filter already knows what to do with 413 and 400 (it maps them to PAYLOAD_TOO_LARGE and
 * BAD_REQUEST); it just needs to be handed something it recognises. That translation is all
 * `bodyParserErrorHandler` does.
 *
 * The handler must be registered IMMEDIATELY AFTER the parsers: Express walks the stack forward
 * from wherever the error was raised, so an error middleware placed before them would never run.
 */
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { json, urlencoded, type ErrorRequestHandler, type RequestHandler } from 'express';

import { MAX_PROOF_BASE64_LENGTH } from '@modules/deposit/dtos/submit-proof.dto';

/**
 * General JSON bodies are small. A low cap bounds how much memory an unauthenticated request can
 * make us allocate.
 */
export const DEFAULT_BODY_LIMIT = 512 * 1024;

/**
 * Derived from MAX_PROOF_BYTES via MAX_PROOF_BASE64_LENGTH rather than written as a literal, so the
 * transport limit cannot drift away from the limit the DTO and the service enforce. The headroom
 * covers the JSON envelope around the image (field names, the reference, the note).
 */
export const PROOF_BODY_LIMIT = MAX_PROOF_BASE64_LENGTH + 64 * 1024;

/** Kept in sync with the throttle rule for the same route in @core/throttler/throttle-routes. */
const PROOF_PATH = /^\/v1\/deposits\/[^/]+\/proof\/?$/;

interface RawBodyCarrier {
  rawBody?: Buffer;
}

/**
 * Replaces what Nest's `rawBody: true` would have done. Nothing reads it today — the Telegram
 * webhook authenticates with a header secret, not a body signature — but a rail that signs its
 * callbacks would need the bytes exactly as sent, and recovering them after JSON.parse is
 * impossible.
 */
const captureRawBody = (req: unknown, _res: unknown, buf: Buffer): void => {
  if (buf.length > 0) (req as RawBodyCarrier).rawBody = Buffer.from(buf);
};

function pathOf(req: { originalUrl?: string; url?: string }): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
}

/**
 * The parsers, in the order they must be used. Register them with `app.use(...)` BEFORE
 * `app.init()`, then register `bodyParserErrorHandler` right after.
 */
export function createBodyParsers(): RequestHandler[] {
  const proofJson = json({ limit: PROOF_BODY_LIMIT, verify: captureRawBody });
  const defaultJson = json({ limit: DEFAULT_BODY_LIMIT, verify: captureRawBody });
  const defaultUrlencoded = urlencoded({
    limit: DEFAULT_BODY_LIMIT,
    extended: true,
    verify: captureRawBody,
  });

  const routedJson: RequestHandler = (req, res, next) => {
    if (req.method === 'POST' && PROOF_PATH.test(pathOf(req))) {
      proofJson(req, res, next);
      return;
    }
    defaultJson(req, res, next);
  };

  return [routedJson, defaultUrlencoded];
}

interface HttpErrorLike {
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
  message?: unknown;
}

/** http-errors sets both; `status` is the older name and some middleware only sets one. */
export function httpErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as HttpErrorLike;
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  return null;
}

/**
 * Express recognises an error handler by its ARITY: it must declare four parameters. `next` is
 * unused in two of the three branches and still cannot be dropped.
 */
export const bodyParserErrorHandler: ErrorRequestHandler = (error, _req, _res, next) => {
  const status = httpErrorStatus(error);

  if (status === 413) {
    // The message is deliberately generic. Echoing body-parser's ("request entity too large") tells
    // a prober our exact limit for this route.
    next(new PayloadTooLargeException('Request body is too large.'));
    return;
  }

  if (status === 400) {
    // Almost always `entity.parse.failed` — malformed JSON. A client error, not ours.
    next(new BadRequestException('Request body is not valid JSON.'));
    return;
  }

  // Anything else is genuinely unexpected; let GlobalExceptionFilter treat it as such.
  next(error);
};
