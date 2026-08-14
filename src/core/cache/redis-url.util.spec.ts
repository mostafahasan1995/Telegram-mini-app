import { redisUrlToOptions } from './redis-url.util';

describe('redisUrlToOptions', () => {
  it('parses host and port', () => {
    expect(redisUrlToOptions('redis://localhost:6379')).toMatchObject({
      host: 'localhost',
      port: 6379,
    });
  });

  it('defaults the port to 6379 when omitted', () => {
    expect(redisUrlToOptions('redis://redis').port).toBe(6379);
  });

  it('always sets maxRetriesPerRequest to null, which BullMQ requires', () => {
    // BullMQ refuses to start a worker otherwise, with an error that points here.
    expect(redisUrlToOptions('redis://localhost:6379').maxRetriesPerRequest).toBeNull();
  });

  it('extracts credentials', () => {
    const options = redisUrlToOptions('redis://someuser:somepass@redis.internal:6380');
    expect(options).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      username: 'someuser',
      password: 'somepass',
    });
  });

  it('decodes percent-encoded credentials', () => {
    // A generated password containing '@' or '/' arrives escaped; passing it through raw would
    // authenticate with the wrong string and fail with a confusing NOAUTH.
    const options = redisUrlToOptions('redis://:p%40ss%2Fword@redis:6379');
    expect(options.password).toBe('p@ss/word');
  });

  it('selects the database from the path', () => {
    expect(redisUrlToOptions('redis://localhost:6379/3').db).toBe(3);
  });

  it('omits db when the path is empty or not numeric', () => {
    expect(redisUrlToOptions('redis://localhost:6379').db).toBeUndefined();
    expect(redisUrlToOptions('redis://localhost:6379/').db).toBeUndefined();
  });

  it('enables TLS for rediss:// and not for redis://', () => {
    expect(redisUrlToOptions('rediss://secure.redis:6380').tls).toEqual({});
    expect(redisUrlToOptions('redis://localhost:6379').tls).toBeUndefined();
  });

  it('handles a full managed-Redis URL', () => {
    const options = redisUrlToOptions('rediss://default:AbC123%3D@eu-1.upstash.io:6379/0');
    expect(options).toMatchObject({
      host: 'eu-1.upstash.io',
      port: 6379,
      username: 'default',
      password: 'AbC123=',
      db: 0,
      maxRetriesPerRequest: null,
    });
    expect(options.tls).toEqual({});
  });
});
