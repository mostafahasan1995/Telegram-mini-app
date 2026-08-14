/**
 * WHY: money is bigint minor units everywhere, and `JSON.stringify(1n)` throws
 * "Do not know how to serialize a BigInt". Rather than sprinkling `.toString()` at every response
 * boundary (and inevitably missing one inside a pino log line or a BullMQ job payload), we teach
 * BigInt how to serialize itself, once, at process start.
 *
 * The value is emitted as a JSON *string*, never a number — a JS client that parsed
 * 9007199254740993 as a number would silently corrupt it. Clients get "9007199254740993".
 *
 * Import this for its side effect as the FIRST import of main.ts / main.worker.ts / main.cli.ts:
 *   import '@common/helpers/bigint-json';
 */

declare global {
  interface BigInt {
    /** Serializes to a decimal string so no precision is lost through JSON. */
    toJSON(): string;
  }
}

if (typeof BigInt.prototype.toJSON !== 'function') {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON(this: bigint): string {
      return this.toString();
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export {};
