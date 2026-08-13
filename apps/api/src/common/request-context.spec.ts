import { currentRequestId, runWithRequestId } from './request-context';

describe('request context', () => {
  /*
   * NULL IS A LEGITIMATE ANSWER, not a failure. Audit rows are also written by
   * bootstrap, the retention sweeper and background workers, which genuinely
   * belong to no request. Inventing an id for them would imply an operation a
   * reader could go and look for.
   */
  it('has no id outside a request', () => {
    expect(currentRequestId()).toBeNull();
  });

  it('exposes the same id everywhere inside one request', () => {
    runWithRequestId((requestId) => {
      expect(currentRequestId()).toBe(requestId);
      // Nested frames are the whole point: audit rows are written several
      // levels below the controller that knows which request this is.
      const deeper = () => () => currentRequestId();
      expect(deeper()()).toBe(requestId);
    });
  });

  /*
   * THE PROPERTY THAT MAKES CORRELATION MEAN ANYTHING. Two requests sharing an
   * id would merge two operations into one story; two ids within one request
   * would split one operation into two. Both are worse than no correlation at
   * all, because both look correct.
   */
  it('gives different requests different ids', () => {
    const first = runWithRequestId((id) => id);
    const second = runWithRequestId((id) => id);

    expect(first).not.toBe(second);
  });

  it('survives an await, which every real handler contains', async () => {
    await runWithRequestId(async (requestId) => {
      await Promise.resolve();
      expect(currentRequestId()).toBe(requestId);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentRequestId()).toBe(requestId);
    });
  });

  it('keeps concurrent requests apart', async () => {
    // Interleaved on purpose: a store that leaked between them would show up
    // here and nowhere else, and in production it would attribute one
    // operator's changes to another's operation.
    const run = (delay: number) =>
      runWithRequestId(async (requestId) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return { expected: requestId, actual: currentRequestId() };
      });

    const results = await Promise.all([run(5), run(1), run(3)]);

    for (const { expected, actual } of results) {
      expect(actual).toBe(expected);
    }
    expect(new Set(results.map((r) => r.expected)).size).toBe(3);
  });

  it('does not leak out of the request that set it', async () => {
    await runWithRequestId(async () => {
      await Promise.resolve();
    });

    expect(currentRequestId()).toBeNull();
  });

  it('returns what the callback returns', () => {
    expect(runWithRequestId(() => 'value')).toBe('value');
  });
});
