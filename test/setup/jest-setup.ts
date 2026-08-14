/**
 * Runs before every test file, in every suite.
 *
 * 1. `bigint-json` installs BigInt.prototype.toJSON. Money is bigint minor units everywhere, so
 *    without it any test that stringifies a response, a job payload or a snapshot throws
 *    "Do not know how to serialize a BigInt" — a failure that looks like a bug in the code under
 *    test rather than a missing global.
 *
 * 2. `ICHANCY_FAKE=1` is a hard safety rail, not a convenience. @core/ichancy already defaults to
 *    the fake when NODE_ENV=test, but defaults are exactly what a suite overrides when it is
 *    reproducing a production-shaped bug. Setting it explicitly means the only way to point a test
 *    at the real agent API — which would move real money — is to delete this line.
 */
import '@common/helpers/bigint-json';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.ICHANCY_FAKE = '1';
process.env.FILE_STORAGE_DRIVER = process.env.FILE_STORAGE_DRIVER ?? 'local';
